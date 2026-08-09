"""Milestone 11 (Evidence Service & Shadow Infrastructure Implementation)
§20-§23, extended by Milestone 11.2 (Contention-Aware Shadow Scheduling) —
the frozen shadow snapshot, the bounded background-execution pool, the
contention-aware defer/drop scheduler, and the orchestration function
app/api/routes_conversations.py calls once per streamed reply.

Module-level singleton state (`_shadow_executor` below), not a FastAPI
dependency — deliberately mirrors app/core/generation_manager.py's own
convention (`_states`/`_registry_lock` module globals) rather than
introducing a second background-execution pattern into this codebase
(Milestone 11 §1: "do not create duplicate... thread pools").

Nothing in this module ever affects a chat answer, a citation, or the SSE
stream (Milestone 11 §2/§23) — it is called strictly AFTER
generation_manager.poll_until_done() has already finished and the final
reply events have already been yielded (see routes_conversations.py's
event_stream()), and every failure path here is caught and reduced to an
observability record, never re-raised into the caller.

MILESTONE 11.2 — CONTENTION-AWARE SCHEDULING: Milestone 11.1 measured
evidence-service calls degrading to outright failure while qwen3:8b is
actively generating (a real, ~3.8-of-4-OCPU CPU draw on this host). A
deferred shadow job now waits for `app.core.generation_activity`'s
host-wide "is any generation active right now?" signal to go idle, and
stay idle for a short continuous grace window, before ever calling the
evidence service — see `_wait_for_idle_window` below.

THE RESIDUAL RACE (Milestone 11.2 §8/§9/§20 — documented, not "solved"):
between `_wait_for_idle_window` confirming idle and the evidence-service
HTTP call actually completing, a NEW generation can start. This is
structurally unavoidable without either (a) holding a lock that would
block that new generation from starting at all — explicitly forbidden
(Milestone 11.2 §9: "NLI must NEVER acquire a lock that prevents qwen
generation from starting... generation always has priority"), or (b)
preempting an in-flight PyTorch inference mid-computation, which has no
safe mechanism (the same limitation documented in
evidence-service/app/concurrency.py's own module docstring for the
symmetric case). The chosen tradeoff: minimize the race's probability
(the grace window), never its possibility, and accept the residual CPU
contention as a bounded, transient cost that Milestone 11.2's own
"New-Generation-During-NLI" experiment measured directly rather than
merely asserted."""

from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Literal

from app.config import Settings
from app.core.claim_transformer import classify_and_transform
from app.core.evidence_aggregation import (
    ClaimAggregationResult,
    ClaimRelationRow,
    SourceRelation,
    aggregate_claim_status,
    aggregate_evidence_state,
)
from app.core.evidence_client import EvidenceClient
from app.core.evidence_eligibility import evidence_analysis_eligible, should_sample
from app.core.evidence_observability import (
    record_bypassed,
    record_deferred_busy,
    record_dropped_busy,
    record_idle_start,
    record_not_sampled,
    record_shadow_result,
)
from app.core.generation_activity import is_generation_busy

logger = logging.getLogger("app.evidence_shadow")

#: How often the defer loop re-checks generation-busy state — fine-grained
#: enough that the measured idle-grace-window values (Milestone 11.2 §7:
#: 0s/1s/2s) are actually meaningful, coarse enough not to spin a thread
#: hot for up to evidence_shadow_max_defer_seconds.
_POLL_INTERVAL_SECONDS = 0.2

#: Milestone 10 §6's approved value — the shadow job never sends more
#: than this many sources per claim to the evidence service, using
#: whatever the retriever/MMR already ranked highest (Milestone 11 §26:
#: "Use existing prepared order. Do not rerun retrieval.").
MAX_NLI_SOURCES = 3


@dataclass(frozen=True)
class ShadowSnapshot:
    """Milestone 11 §20: the ONLY input a shadow job holds. Ephemeral —
    constructed just before being handed to the executor, never persisted
    (no DB write, no log line anywhere in this module includes `claims`
    or `sources`' text — see app/core/evidence_observability.py's own
    "never query/claim/source text" contract), and discarded once
    run_shadow_job returns. Deliberately excludes conversation_id/
    message_id/user_id: Milestone 10 §23/§24 require that even the
    ephemeral job data stay uncorrelatable back to a specific
    conversation from telemetry."""

    claims: tuple[str, ...]
    sources: tuple[tuple[str, str], ...]  # (source_id, text), already capped to MAX_NLI_SOURCES


class BoundedShadowExecutor:
    """Milestone 11 §22: `max_workers` threads run shadow jobs
    concurrently; up to `max_queued` additional jobs may be waiting
    (queued inside the executor) at once. `submit()` beyond that combined
    capacity DROPS the job outright (returns False, logged) rather than
    growing an unbounded queue — matching evidence-service's own
    admission-then-reject pattern (evidence-service/app/concurrency.py)
    one level up the stack. `shutdown()` is called once, from
    app/main.py's lifespan, on process shutdown (best-effort,
    non-blocking — an in-flight shadow job is diagnostic-only and never
    worth delaying process shutdown for)."""

    def __init__(self, *, max_workers: int, max_queued: int) -> None:
        self._executor = ThreadPoolExecutor(
            max_workers=max_workers, thread_name_prefix="evidence-shadow"
        )
        self._capacity = max_workers + max_queued
        self._lock = threading.Lock()
        self._in_flight = 0

    def submit(self, fn, /, *args: object, **kwargs: object) -> bool:
        with self._lock:
            if self._in_flight >= self._capacity:
                return False
            self._in_flight += 1

        def _run() -> None:
            try:
                fn(*args, **kwargs)
            except Exception:  # noqa: BLE001 — a shadow job must never propagate
                logger.exception("Unhandled error in evidence shadow job")
            finally:
                with self._lock:
                    self._in_flight -= 1

        self._executor.submit(_run)
        return True

    def shutdown(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=True)


#: Milestone 11.2 §13: reduced from Milestone 11's max_queued=8. A
#: deferred job now occupies its worker thread for its ENTIRE defer wait
#: (up to evidence_shadow_max_defer_seconds), not just its actual NLI
#: call — holding 8 queued jobs would mean up to 10 total shadow attempts
#: in flight/waiting at once, a meaningfully larger footprint than a low
#: sample rate needs. "We don't need every sample" (Milestone 11.2 §13) —
#: max_workers=2 (unchanged) + max_queued=2 = capacity 4.
_shadow_executor = BoundedShadowExecutor(max_workers=2, max_queued=2)


def shutdown_shadow_executor() -> None:
    """Called once from app/main.py's lifespan on process shutdown — see
    BoundedShadowExecutor.shutdown()'s own docstring for why this is
    best-effort/non-blocking rather than draining in-flight jobs."""
    _shadow_executor.shutdown()


def _build_relation_row(
    claim: str, sources: tuple[tuple[str, str], ...], client: EvidenceClient
) -> tuple[ClaimRelationRow | None, str | None, float, str | None, str | None]:
    """Returns (row_or_none, failure_reason_or_none, latency_ms, model_id,
    model_revision). row is None exactly when failure_reason is set."""
    start = time.perf_counter()
    outcome = client.classify_batch(claim=claim, sources=list(sources))
    latency_ms = (time.perf_counter() - start) * 1000
    if not outcome.ok:
        return None, outcome.failure, latency_ms, None, None
    row = ClaimRelationRow(
        claim=claim,
        source_relations=tuple(
            SourceRelation(source_id=r.source_id, relation=r.label) for r in outcome.results
        ),
    )
    return row, None, latency_ms, outcome.model_id, outcome.model_revision


WaitOutcome = Literal["ready", "busy_drop"]


def _wait_for_idle_window(
    *, idle_grace_seconds: float, max_defer_seconds: float, sleep=time.sleep
) -> tuple[WaitOutcome, float]:
    """Milestone 11.2 §6/§8/§10/§11/§19 — blocks the CALLING THREAD (a
    shadow-executor worker thread, never the request thread — see
    `maybe_schedule_evidence_shadow`'s own docstring) until either:

    - generation has been CONTINUOUSLY idle (host-wide —
      app.core.generation_activity.is_generation_busy()) for
      `idle_grace_seconds`, returning ("ready", total_wait_ms); or
    - `max_defer_seconds` elapses first without ever achieving that,
      returning ("busy_drop", total_wait_ms).

    Grace-window semantics (Milestone 11.2 §19's explicit requirement):
    if generation becomes busy again at ANY point during the grace
    window — even on its last poll — the grace window resets entirely;
    it is never partially credited. `idle_grace_seconds=0` is a valid,
    meaningful value: it skips the grace wait entirely and returns
    "ready" the moment a single busy-check reports idle (Milestone 11.2
    §7's own 0s test case).

    `sleep` is injectable (defaults to time.sleep) purely so tests can
    run this function's real branching logic in milliseconds instead of
    real seconds — never mocked away in production."""
    start = time.monotonic()
    deadline = start + max_defer_seconds
    reported_busy_once = False

    while True:
        if time.monotonic() >= deadline:
            return "busy_drop", (time.monotonic() - start) * 1000

        if is_generation_busy():
            if not reported_busy_once:
                record_deferred_busy()
                reported_busy_once = True
            sleep(_POLL_INTERVAL_SECONDS)
            continue

        # Confirmed idle on this check — now hold that for the full grace
        # window, continuously, before declaring ready.
        grace_start = time.monotonic()
        idle_confirmed = True
        while time.monotonic() - grace_start < idle_grace_seconds:
            if time.monotonic() >= deadline:
                return "busy_drop", (time.monotonic() - start) * 1000
            if is_generation_busy():
                idle_confirmed = False
                if not reported_busy_once:
                    record_deferred_busy()
                    reported_busy_once = True
                break
            sleep(min(_POLL_INTERVAL_SECONDS, max(idle_grace_seconds, 0.01)))

        if idle_confirmed:
            return "ready", (time.monotonic() - start) * 1000
        # else: generation started again mid-grace — loop back to the
        # outer busy-wait, per Milestone 11.2 §19 ("grace restarts").


def run_shadow_job(snapshot: ShadowSnapshot, client: EvidenceClient) -> None:
    """Runs on a worker thread (see BoundedShadowExecutor above), once
    the contention-aware scheduler (_scheduled_shadow_job below) has
    already confirmed an idle window. Calls the evidence service once per
    claim (Milestone 10 §8: batched per claim, sequential across claims —
    at most Settings.evidence_analysis_max_claims calls, 1 in the initial
    Milestone 11.2 rollout). Any single claim's failure
    (timeout/overload/unavailable/malformed) abandons the WHOLE job's
    evidence-state computation — Milestone 11 §26's "do not partially
    verify and call it complete" applies just as much to a mid-flight
    failure as it does to the original claim-count cap: reporting
    PARTIAL/SUFFICIENT from only 1 of 2 claims' real results would be
    exactly the "silently pretend validation was complete" failure
    Milestone 10 §29 forbids for enforced mode, and there's no reason to
    hold shadow mode to a lower honesty bar even though nothing downstream
    consumes its answer yet."""
    total_latency_start = time.perf_counter()
    claim_results: list[ClaimAggregationResult] = []
    model_id: str | None = None
    model_revision: str | None = None

    for claim in snapshot.claims:
        row, failure, _latency_ms, m_id, m_rev = _build_relation_row(
            claim, snapshot.sources, client
        )
        if row is None:
            record_shadow_result(
                evidence_state=None,
                claim_count=len(snapshot.claims),
                source_count=len(snapshot.sources),
                latency_ms=(time.perf_counter() - total_latency_start) * 1000,
                queue_ms=None,
                model_id=None,
                model_revision=None,
                error=failure,
                timed_out=(failure == "timeout"),
            )
            return
        model_id, model_revision = m_id, m_rev
        claim_results.append(
            ClaimAggregationResult(
                claim=claim,
                status=aggregate_claim_status(row),
                supporting_source_ids=row.entailing_sources(),
                contradicting_source_ids=row.contradicting_sources(),
            )
        )

    evidence_state = aggregate_evidence_state(claim_results)
    record_shadow_result(
        evidence_state=evidence_state,
        claim_count=len(snapshot.claims),
        source_count=len(snapshot.sources),
        latency_ms=(time.perf_counter() - total_latency_start) * 1000,
        queue_ms=None,
        model_id=model_id,
        model_revision=model_revision,
        error=None,
        timed_out=False,
    )


def _scheduled_shadow_job(
    snapshot: ShadowSnapshot,
    client: EvidenceClient,
    *,
    idle_grace_seconds: float,
    max_defer_seconds: float,
) -> None:
    """Milestone 11.2's contention-aware wrapper around run_shadow_job:
    runs entirely on a shadow-executor worker thread (never the request
    thread), waits for a confirmed idle window (or the max-defer
    deadline), then either runs the real NLI job or drops it — see
    _wait_for_idle_window's own docstring for the exact semantics."""
    outcome, defer_ms = _wait_for_idle_window(
        idle_grace_seconds=idle_grace_seconds, max_defer_seconds=max_defer_seconds
    )
    if outcome == "busy_drop":
        record_dropped_busy(defer_ms=defer_ms)
        return
    record_idle_start(defer_ms=defer_ms, idle_grace_ms=idle_grace_seconds * 1000)
    run_shadow_job(snapshot, client)


def maybe_schedule_evidence_shadow(
    *,
    settings: Settings,
    zoom_in_mode: bool,
    query: str,
    source_texts: list[tuple[str, str]],
    evidence_client: EvidenceClient,
) -> None:
    """Called once per streamed reply, strictly AFTER generation has
    completed and every SSE event has already been yielded (see
    app/api/routes_conversations.py's event_stream()) — Milestone 11 §21:
    "shadow job must NOT delay TTFT, token streaming, generation
    completion, SSE final response." Submitting to the bounded executor
    below is a fast, non-blocking, in-memory operation; the actual HTTP
    call(s) to the evidence service — and the Milestone 11.2 idle-wait
    that now precedes them — happen later, entirely on a worker thread,
    long after this function (and the request that triggered it) has
    already returned. This function itself never checks generation-busy
    state and never waits for anything — see _scheduled_shadow_job for
    where that happens, off this thread.

    `source_texts`: (source_id, text) pairs in `prepared.retrieved_sources`
    order — i.e. THE EXISTING PREPARED ORDER (Milestone 11 §26: "Do not
    rerun retrieval. Do not select arbitrary sources."), truncated to
    MAX_NLI_SOURCES here.

    Cheap checks (flags/mode/scope/source-count) run BEFORE the claim
    transformer, which itself runs before the full eligibility/sampling
    decision — Milestone 10 §2's "claim transformer is the first gate,
    but is itself gated by cheaper checks first" principle."""
    if not settings.evidence_analysis_enabled or settings.evidence_analysis_mode != "shadow":
        return
    if not zoom_in_mode:
        return
    if not source_texts:
        return

    transform_result = classify_and_transform(query)
    eligibility = evidence_analysis_eligible(
        master_enabled=settings.evidence_analysis_enabled,
        mode=settings.evidence_analysis_mode,
        zoom_in_mode=zoom_in_mode,
        source_count=len(source_texts),
        transform_applicable=transform_result.applicable,
        claim_count=transform_result.claim_count,
        max_claims=settings.evidence_analysis_max_claims,
    )
    if not eligibility.eligible:
        # Milestone 11.2 §25: the initial shadow rollout's claims cap
        # (evidence_analysis_max_claims=1) gets its own, more specific
        # bypass reason than the generic "too_many_claims" — distinguishes
        # "this question genuinely has too many claims for ANY phase" from
        # "this question would be fine once the cap is later raised to 2".
        reason = eligibility.reason or "unknown"
        if reason == "too_many_claims" and settings.evidence_analysis_max_claims == 1:
            reason = "too_many_claims_initial_shadow"
        record_bypassed(reason=reason)
        return

    if not should_sample(settings.evidence_analysis_sample_rate):
        record_not_sampled()
        return

    snapshot = ShadowSnapshot(
        claims=transform_result.claims,
        sources=tuple(source_texts[:MAX_NLI_SOURCES]),
    )
    submitted = _shadow_executor.submit(
        _scheduled_shadow_job,
        snapshot,
        evidence_client,
        idle_grace_seconds=settings.evidence_shadow_idle_grace_seconds,
        max_defer_seconds=settings.evidence_shadow_max_defer_seconds,
    )
    if not submitted:
        record_bypassed(reason="shadow_queue_full")
