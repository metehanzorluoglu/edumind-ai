"""Milestone 11 (Evidence Service & Shadow Infrastructure Implementation)
§4/§6/§8/§10/§14 — configuration for the standalone evidence-service.
Deliberately its own tiny Settings class (not shared with rag-backend's
app/config.py): this service ships in its own Docker image, with its own
dependency set, and is never imported by or importing from the backend
package — see README.md "Architecture"."""

from __future__ import annotations

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="EVIDENCE_SERVICE_", extra="ignore")

    host: str = "0.0.0.0"
    port: int = Field(default=8100, ge=1, le=65535)

    # --- Model identity (Milestone 11 §4: "Use ONLY ynie/... Pin exact
    # revision.") ---
    # The exact HF Hub commit this model was validated against across
    # Milestones 8, 9, 9.5, 9.6, and 10's source-limit experiment — see
    # README.md "Model" for how this hash was obtained and verified.
    # Deliberately never "main"/unset: a floating ref means a future
    # upstream change to this model could silently alter production
    # shadow results (and, later, enforcement decisions) with no code
    # change and no changelog entry in THIS repo — Milestone 10 §41's
    # explicit instruction.
    model_id: str = "ynie/roberta-large-snli_mnli_fever_anli_R1_R2_R3-nli"
    model_revision: str = "5b605abab9b75bc87ab66cfc049ef58d9d64b8ed"

    # HF_HOME inside the container — matches the compose volume mount
    # (see deploy/oracle/docker-compose.oracle.yml's evidence-service
    # block) so the ~1.35GB model is downloaded once, not on every
    # container restart (Milestone 10 §41 / Milestone 11 §10).
    hf_home: str = "/model-cache"

    # --- Request limits (Milestone 11 §6: "Do not trust caller.") ---
    # One HTTP request classifies exactly one claim against its sources —
    # see app/schemas.py's ClassifyBatchRequest docstring for why this
    # single-claim shape was chosen over a multi-claim-per-request
    # envelope. "max claims per backend request: 2" (Milestone 10 §9 /
    # Milestone 11 §6/§26) is therefore enforced by the BACKEND's own
    # eligibility gate (app/core/evidence_eligibility.py,
    # DEFAULT_MAX_NLI_CLAIMS) issuing at most 2 such calls per chat
    # request — not by this service, which has no way to see "how many
    # calls has this chat turn made so far" without becoming stateful.
    max_sources_per_claim: int = Field(default=3, ge=1, le=20)
    max_claim_length: int = Field(default=1000, ge=1)
    # Retrieved chunks are capped at DEFAULT_CHUNK_SIZE_CHARS=3000 in the
    # backend's own chunker (rag-backend/app/ingestion/chunker.py) — 4000
    # gives headroom for context-preparation additions (citation markers,
    # light surrounding text) without accepting arbitrarily large bodies.
    max_source_length: int = Field(default=4000, ge=1)

    # --- Concurrency / backpressure (Milestone 10 §32/§33, Milestone 11
    # §8) ---
    concurrency: int = Field(default=1, ge=1)
    queue_depth: int = Field(default=8, ge=0)
    # Internal timeout, deliberately slightly BELOW the backend caller's
    # own 2500ms budget (Milestone 10 §30) — so this service's own 429/503
    # overload response reaches the caller before the caller's client-side
    # timeout would otherwise fire first and report a less specific
    # "unavailable" outcome. See README.md "Timeout semantics" for the
    # full, honest explanation of what this timeout does and does not
    # guarantee (it cannot forcibly stop an in-flight CPU inference — see
    # app/concurrency.py's module docstring).
    request_timeout_seconds: float = Field(default=2.3, gt=0)

    @field_validator("model_revision")
    @classmethod
    def _revision_must_not_be_floating(cls, value: str) -> str:
        if value.strip().lower() in ("", "main", "latest", "head"):
            raise ValueError(
                "model_revision must be a pinned commit hash, not a floating ref "
                f"like {value!r} — see Milestone 10 §41"
            )
        return value
