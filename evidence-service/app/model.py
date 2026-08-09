"""Milestone 11 (Evidence Service & Shadow Infrastructure Implementation)
§4/§9 — the NLI model wrapper, load, and startup sanity check.

Deliberately reuses the exact loading/inference shape already validated
across Milestones 8-10 (rag-backend/scripts/nli_feasibility_eval.py's
`NLIModel` class) rather than writing new model-handling code: same
`AutoModelForSequenceClassification`/`AutoTokenizer` calls, same
`.float()` cast (Milestone 8 §1/§17's ~175x CPU-inference-speed finding
for a model shipped in fp16), same "read label order from the model's OWN
config.id2label, never hardcode it" rule (Milestone 8 §6/§14's
cross-model label-ordering mismatch finding — this exact model uses
{0: entailment, 1: neutral, 2: contradiction}, but that is READ, not
assumed, below). Milestone 11 §11 explicitly forbids introducing quantized
ONNX in this milestone — this is the plain, quality-validated
torch/transformers configuration."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Literal

NLILabel = Literal["entailment", "neutral", "contradiction"]

logger = logging.getLogger("evidence_service.model")

#: Milestone 11 §9's exact startup sanity pair — a premise entailing
#: itself must classify as ENTAILMENT under any correctly-configured NLI
#: model. If it doesn't, the label mapping (or the model itself) is
#: broken, and the service must never report itself ready (see
#: app/main.py's lifespan).
SANITY_PREMISE = "The intervention improved performance."
SANITY_HYPOTHESIS = "The intervention improved performance."
SANITY_EXPECTED_LABEL: NLILabel = "entailment"


class ModelSanityCheckFailed(Exception):
    """Raised when the startup sanity pair does not classify as expected
    — see SANITY_PREMISE/SANITY_HYPOTHESIS/SANITY_EXPECTED_LABEL above."""


def _normalize_label(raw: str) -> NLILabel:
    lowered = raw.lower()
    if lowered not in ("entailment", "neutral", "contradiction"):
        raise ValueError(f"unrecognized NLI label from model config: {raw!r}")
    return lowered  # type: ignore[return-value]


@dataclass
class NLIModel:
    model_id: str
    model_revision: str
    tokenizer: object
    model: object
    label_from_index: dict[int, NLILabel]
    #: Inverse of label_from_index, computed once at load time (not
    #: memoized on the fly per-request) — used by app/main.py to map a
    #: predicted probability row's raw class-index order back onto the
    #: named entailment/neutral/contradiction fields the wire schema
    #: requires (app/schemas.py's SourceProbabilities), without assuming
    #: any fixed index order (Milestone 8 §6/§14's cross-model
    #: label-ordering finding — see this module's own docstring).
    label_to_index: dict[NLILabel, int] = field(default_factory=dict)

    @classmethod
    def load(cls, *, model_id: str, revision: str) -> "NLIModel":
        """Blocking, CPU/IO-heavy — call this from a thread (see
        app/main.py's lifespan, which runs it via
        `asyncio.to_thread`), never directly on the event loop."""
        from transformers import AutoModelForSequenceClassification, AutoTokenizer

        logger.info("Loading model %s@%s", model_id, revision)
        tokenizer = AutoTokenizer.from_pretrained(model_id, revision=revision)
        model = AutoModelForSequenceClassification.from_pretrained(model_id, revision=revision)
        # See module docstring — always cast to fp32 for CPU inference.
        model = model.float()
        model.eval()
        label_from_index = {
            idx: _normalize_label(label) for idx, label in model.config.id2label.items()
        }
        if set(label_from_index.values()) != {"entailment", "neutral", "contradiction"}:
            raise ValueError(
                f"model {model_id}@{revision} config.id2label did not yield exactly "
                f"{{entailment, neutral, contradiction}}: {label_from_index!r}"
            )
        logger.info("Loaded %s@%s — label_from_index=%s", model_id, revision, label_from_index)
        return cls(
            model_id=model_id,
            model_revision=revision,
            tokenizer=tokenizer,
            model=model,
            label_from_index=label_from_index,
            label_to_index={label: idx for idx, label in label_from_index.items()},
        )

    def predict_batch(
        self, pairs: list[tuple[str, str]]
    ) -> tuple[list[NLILabel], list[list[float]]]:
        """pairs: list of (premise, hypothesis). Returns (predicted_labels,
        softmax_probs) — probs in THIS call's own pair order, each inner
        list ordered by this model's raw class index (0, 1, 2 — mapped
        back to names via label_from_index by the caller, e.g.
        app/main.py's response-building code — never assumed to be in
        (entailment, neutral, contradiction) order by position alone).

        Blocking, CPU-heavy — call via `asyncio.to_thread` /
        `run_in_executor` (see app/concurrency.py), never directly on the
        event loop: a synchronous call here would freeze /health and
        every other in-flight request for the full inference duration."""
        import torch

        with torch.no_grad():
            premises = [p for p, _h in pairs]
            hypotheses = [h for _p, h in pairs]
            encoded = self.tokenizer(
                premises, hypotheses, return_tensors="pt", truncation=True, padding=True
            )
            logits = self.model(**encoded).logits
            probs = torch.softmax(logits, dim=-1)
            predicted_indices = torch.argmax(probs, dim=-1).tolist()
        predicted_labels = [self.label_from_index[i] for i in predicted_indices]
        return predicted_labels, probs.tolist()

    def run_sanity_check(self) -> None:
        """Milestone 11 §9: called once, synchronously, right after load()
        inside app/main.py's lifespan (before the service is marked
        ready). Raises ModelSanityCheckFailed rather than returning a
        bool, so a caller cannot accidentally ignore the result."""
        labels, _probs = self.predict_batch([(SANITY_PREMISE, SANITY_HYPOTHESIS)])
        if labels[0] != SANITY_EXPECTED_LABEL:
            raise ModelSanityCheckFailed(
                f"startup sanity check failed: self-entailing premise/hypothesis "
                f"classified as {labels[0]!r}, expected {SANITY_EXPECTED_LABEL!r} — "
                "label mapping or model weights are likely wrong; refusing to "
                "become ready (Milestone 11 §9)"
            )
        logger.info("Startup sanity check passed (%s -> %s)", self.model_id, labels[0])
