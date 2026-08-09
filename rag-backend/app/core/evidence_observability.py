"""Milestone 11 (Evidence Service & Shadow Infrastructure Implementation)
§27 — evidence-analysis observability.

Reuses this repo's existing convention (see app/core/request_timing.py):
structured log lines via the standard `logging` module — no new metrics
system (Prometheus/statsd/etc.) is introduced, per Milestone 11 §1's "do
not create duplicate... metric systems" instruction. A future milestone
wiring these into a real metrics backend only needs to parse/scrape this
one logger's structured lines, the same way any other operational log
line in this app already is.

Every field is structural/categorical only — Milestone 10 §24/§38's
privacy contract: mode, applicable/sampled flags, bypass reason,
claim/source counts, evidence state, latency, model id/revision, error/
timeout codes. NEVER the query text, claim text, or source/document text
— no function in this module accepts any of those, by construction (not
merely by convention), so a future call site cannot accidentally pass
them through even by mistake."""

from __future__ import annotations

import logging

logger = logging.getLogger("app.evidence_analysis")


def record_bypassed(*, reason: str) -> None:
    """A request that was NLI-eligible-adjacent but did not qualify —
    see app/core/evidence_eligibility.py's BypassReason for the fixed
    vocabulary `reason` is drawn from."""
    logger.info("evidence_analysis event=bypassed reason=%s", reason)


def record_not_sampled() -> None:
    """An eligible request that the sample-rate coin flip skipped
    (Milestone 11 §19) — distinct from `record_bypassed`, since this
    request WAS eligible, it just wasn't chosen this time."""
    logger.info("evidence_analysis event=not_sampled")


def record_deferred_busy() -> None:
    """Milestone 11.2 §6/§24: a shadow job detected generation busy at
    least once and entered (or re-entered, after a grace-window reset —
    see app/core/evidence_shadow.py's _wait_for_idle_window) the defer
    loop. May fire more than once per job if generation becomes busy
    again during an in-progress grace window (Milestone 11.2 §19)."""
    logger.info("evidence_analysis event=deferred_busy")


def record_dropped_busy(*, defer_ms: float) -> None:
    """Milestone 11.2 §11/§21: a deferred shadow job never found a
    genuinely idle window within evidence_shadow_max_defer_seconds and
    was dropped without ever calling the evidence service."""
    logger.info("evidence_analysis event=dropped_busy defer_ms=%.1f", defer_ms)


def record_idle_start(*, defer_ms: float, idle_grace_ms: float) -> None:
    """Milestone 11.2 §6: the job confirmed a continuous idle window and
    is about to call the evidence service. `defer_ms` is 0 when the job
    never had to wait at all (host was already idle on first check)."""
    logger.info(
        "evidence_analysis event=idle_start defer_ms=%.1f idle_grace_ms=%.1f",
        defer_ms,
        idle_grace_ms,
    )


def record_shadow_result(
    *,
    evidence_state: str | None,
    claim_count: int,
    source_count: int,
    latency_ms: float,
    queue_ms: float | None,
    model_id: str | None,
    model_revision: str | None,
    error: str | None,
    timed_out: bool,
) -> None:
    """The outcome of one sampled, actually-executed shadow job.
    `evidence_state` and `model_id`/`model_revision` are None when `error`
    is set (the job failed before an aggregate state could be computed —
    see app/core/evidence_shadow.py's run_shadow_job, which never reports
    a state derived from incomplete per-claim results)."""
    logger.info(
        "evidence_analysis event=shadow_result evidence_state=%s claim_count=%d "
        "source_count=%d latency_ms=%.1f queue_ms=%s model_id=%s model_revision=%s "
        "error=%s timed_out=%s",
        evidence_state or "none",
        claim_count,
        source_count,
        latency_ms,
        f"{queue_ms:.1f}" if queue_ms is not None else "none",
        model_id or "none",
        model_revision or "none",
        error or "none",
        timed_out,
    )
