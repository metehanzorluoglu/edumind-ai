"""Milestone 11 (Evidence Service & Shadow Infrastructure Implementation)
§17/§19 — pure, deterministic gating logic deciding whether a given chat
request may run evidence analysis at all, and (independently) whether a
shadow-eligible request is actually sampled this time.

Design principle carried over from Milestone 10 §2/§3 ("claim transformer
as first gate; NLI never runs on every request"): this module never calls
the NLI model, never makes a network call, and never runs the claim
transformer itself — it only *consumes* booleans/counts the caller already
has (from Settings, from `scope_settings.zoom_in_mode`, from
`prepared.retrieved_sources`, and from an already-computed
`TransformationResult` — see app/core/claim_transformer.py). Keeping this
a pure function of already-known values is what makes it trivially unit
testable without any FastAPI/DB/model fixture, and keeps every gate
(flags, mode, scope, sources, transformer applicability, claim count)
auditable as one ordered, named sequence rather than scattered `if`
branches at the call site.

Milestone 11 §26's "if >2 claims, bypass rather than partially verify"
instruction is enforced HERE, not downstream: a question producing 3+
transformed claims is INELIGIBLE outright (reason="too_many_claims"), not
truncated to the first MAX_NLI_CLAIMS and silently reported as a complete
evidence-state verdict.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

#: Mirrors Settings.evidence_analysis_mode (app/config.py) — kept as a
#: plain Literal here (not imported from app.config) so this module has no
#: dependency on Settings at all, matching every other pure-logic module
#: promoted in this milestone (app/core/evidence_aggregation.py,
#: app/core/nli_safety_policy.py).
EvidenceAnalysisMode = Literal["off", "shadow", "zoom_in_enforced"]

#: The fixed, named set of bypass reasons this module can report — also
#: the exact vocabulary for the `evidence_analysis_bypassed_reason`
#: observability field (Milestone 11 §27). A caller-side bypass that
#: happens for a reason THIS module can't see (e.g. the evidence service
#: being unreachable) uses its own separate reason strings — see
#: app/core/evidence_client.py — never one of these.
BypassReason = Literal[
    "master_disabled",
    "mode_not_shadow",
    "not_zoom_in",
    "no_sources",
    "not_transform_applicable",
    "too_many_claims",
]

#: Milestone 10 §9 / Milestone 11 §26's approved default: a question whose
#: claim transformer produces more claims than this is ineligible outright
#: (see the module docstring) rather than partially analyzed.
DEFAULT_MAX_NLI_CLAIMS = 2


@dataclass(frozen=True)
class EligibilityResult:
    eligible: bool
    #: None when eligible=True — a bypassed request always has exactly one
    #: named reason (see BypassReason); an eligible one has none, since
    #: "eligible" is not itself a bypass.
    reason: BypassReason | None


def evidence_analysis_eligible(
    *,
    master_enabled: bool,
    mode: EvidenceAnalysisMode,
    zoom_in_mode: bool,
    source_count: int,
    transform_applicable: bool,
    claim_count: int,
    max_claims: int = DEFAULT_MAX_NLI_CLAIMS,
) -> EligibilityResult:
    """Milestone 11 §17's exact rule set, checked in the order given
    there — cheapest/most-decisive checks first, so a request that fails
    early never needs the caller to have computed the more expensive
    inputs (in practice the caller still computes `transform_applicable`/
    `claim_count` via the claim transformer, which is deterministic
    regex/lookup-table work costing well under 1ms — see
    app/core/claim_transformer.py — so there is no real cost being saved
    by ordering here beyond readability and auditability).

    `mode == "zoom_in_enforced"` is deliberately NOT eligible in this
    milestone: Milestone 11 §24 explicitly forbids implementing the
    pre-generation enforcement behavior that mode name refers to, so even
    though the enum value exists (for future use), no request is ever
    treated as eligible under it yet — only "shadow" is."""
    if not master_enabled:
        return EligibilityResult(False, "master_disabled")
    if mode != "shadow":
        return EligibilityResult(False, "mode_not_shadow")
    if not zoom_in_mode:
        return EligibilityResult(False, "not_zoom_in")
    if source_count <= 0:
        return EligibilityResult(False, "no_sources")
    if not transform_applicable:
        return EligibilityResult(False, "not_transform_applicable")
    if claim_count > max_claims:
        return EligibilityResult(False, "too_many_claims")
    return EligibilityResult(True, None)


def validate_sample_rate(sample_rate: float) -> None:
    """Raises ValueError for a sample rate outside [0.0, 1.0] — Milestone
    11 §19's explicit validation requirement. Called from Settings'
    validator (app/config.py) at startup, not per-request: an invalid
    configured rate should fail fast at process start, not on the first
    eligible request."""
    if not 0.0 <= sample_rate <= 1.0:
        raise ValueError(f"evidence_analysis_sample_rate must be within [0.0, 1.0], got {sample_rate!r}")


def should_sample(sample_rate: float, *, rng: object = None) -> bool:
    """Milestone 11 §19: sampling is checked ONLY after eligibility, never
    before — the caller must call this after
    evidence_analysis_eligible(...).eligible is True, not as a
    replacement for it, so an ineligible request never even reaches a
    random draw (no NLI cost for unsampled OR ineligible requests).

    `rng`, when given, must be a `random.Random`-shaped object exposing
    `.random() -> float` — accepted so a test can pass a seeded or
    fixed-output stub instead of the process-global `random` module
    (avoids flaky tests around a probabilistic default). Uses
    `random.random()` (Mersenne Twister), not `secrets`, deliberately:
    this is a traffic-sampling decision with no security property to
    uphold (unlike, say, a token), so the stdlib's faster, unseeded-by-
    default PRNG is the right tool — matching this repo's existing
    convention of reserving `secrets`-module randomness for genuine
    security contexts only (see app/core/security.py)."""
    import random as _random

    generator = rng if rng is not None else _random
    return generator.random() < sample_rate  # type: ignore[union-attr]
