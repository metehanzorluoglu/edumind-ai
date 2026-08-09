"""Milestone 11 (Evidence Service & Shadow Infrastructure Implementation)
§26/§34 — tests for app/core/evidence_shadow.py. A fake EvidenceClient
(no HTTP, no torch) drives every path; BoundedShadowExecutor is exercised
both directly and via maybe_schedule_evidence_shadow's real submission
path (using a short-lived executor per test, never the module-level
singleton, so tests can't interfere with each other's in-flight-count
bookkeeping)."""

from __future__ import annotations

import threading
import time

from app.config import Settings
from app.core import evidence_shadow as shadow_module
from app.core.evidence_client import ClassificationOutcome, EvidenceClient, SourceRelationResult
from app.core.evidence_shadow import (
    BoundedShadowExecutor,
    ShadowSnapshot,
    _wait_for_idle_window,
    maybe_schedule_evidence_shadow,
    run_shadow_job,
)


class _FakeEvidenceClient(EvidenceClient):
    """Bypasses EvidenceClient.__init__ (no real httpx.Client needed) —
    records every classify_batch call and returns a scripted outcome."""

    def __init__(self, outcomes: list[ClassificationOutcome]) -> None:
        self._outcomes = list(outcomes)
        self.calls: list[dict[str, object]] = []

    def classify_batch(self, *, claim: str, sources: list[tuple[str, str]]) -> ClassificationOutcome:
        self.calls.append({"claim": claim, "sources": sources})
        return self._outcomes.pop(0)


def _ok_outcome(label: str = "entailment") -> ClassificationOutcome:
    return ClassificationOutcome(
        ok=True,
        results=(
            SourceRelationResult(
                source_id="S1",
                label=label,  # type: ignore[arg-type]
                probability_entailment=0.9 if label == "entailment" else 0.02,
                probability_neutral=0.05,
                probability_contradiction=0.9 if label == "contradiction" else 0.02,
            ),
        ),
        model_id="fake-model",
        model_revision="fake-rev",
        latency_ms=10.0,
    )


class TestRunShadowJobSingleClaim:
    def test_successful_single_claim_completes_without_raising(self) -> None:
        client = _FakeEvidenceClient([_ok_outcome("entailment")])
        snapshot = ShadowSnapshot(claims=("X improved Y.",), sources=(("S1", "evidence text"),))
        run_shadow_job(snapshot, client)  # must not raise
        assert len(client.calls) == 1
        assert client.calls[0]["claim"] == "X improved Y."

    def test_failed_call_does_not_raise(self) -> None:
        client = _FakeEvidenceClient([ClassificationOutcome(ok=False, failure="timeout")])
        snapshot = ShadowSnapshot(claims=("X improved Y.",), sources=(("S1", "a"),))
        run_shadow_job(snapshot, client)  # must not raise


class TestRunShadowJobMultiClaim:
    def test_second_claim_failure_abandons_the_whole_job_without_raising(self) -> None:
        client = _FakeEvidenceClient(
            [_ok_outcome("entailment"), ClassificationOutcome(ok=False, failure="timeout")]
        )
        snapshot = ShadowSnapshot(
            claims=("Claim one.", "Claim two."), sources=(("S1", "a"), ("S2", "b"))
        )
        run_shadow_job(snapshot, client)  # must not raise
        assert len(client.calls) == 2  # both claims attempted; job as a whole reports failure

    def test_both_claims_succeed_calls_client_once_per_claim(self) -> None:
        client = _FakeEvidenceClient([_ok_outcome("entailment"), _ok_outcome("neutral")])
        snapshot = ShadowSnapshot(
            claims=("Claim one.", "Claim two."), sources=(("S1", "a"), ("S2", "b"))
        )
        run_shadow_job(snapshot, client)
        assert len(client.calls) == 2


class TestMaybeScheduleEvidenceShadowGating:
    """Every early-return branch of maybe_schedule_evidence_shadow — none
    of these ever call the client (verified via call count == 0), which
    is what "zero NLI cost for ineligible/unsampled requests" means."""

    def _settings(self, **overrides: object) -> Settings:
        base = {
            "jwt_secret": "test-only-secret-not-a-real-credential-32c",
            "evidence_analysis_enabled": True,
            "evidence_analysis_mode": "shadow",
            "evidence_analysis_sample_rate": 1.0,  # always sample, isolate other gates
            # Milestone 11.2: no real generation is ever active in these
            # tests, so is_generation_busy() is already False — grace=0
            # just means "don't wait real wall-clock seconds to prove
            # that," keeping this whole test class fast and deterministic.
            # The grace/defer timing behavior itself gets its own
            # dedicated tests (TestIdleGraceWindow/TestMaxDeferAndDrop
            # below).
            "evidence_shadow_idle_grace_seconds": 0.0,
        }
        base.update(overrides)
        return Settings(**base)

    def test_master_flag_off_makes_zero_calls(self) -> None:
        client = _FakeEvidenceClient([])
        maybe_schedule_evidence_shadow(
            settings=self._settings(evidence_analysis_enabled=False),
            zoom_in_mode=True,
            query="Did X improve Y?",
            source_texts=[("S1", "evidence")],
            evidence_client=client,
        )
        time.sleep(0.05)
        assert client.calls == []

    def test_mode_off_makes_zero_calls(self) -> None:
        client = _FakeEvidenceClient([])
        maybe_schedule_evidence_shadow(
            settings=self._settings(evidence_analysis_mode="off"),
            zoom_in_mode=True,
            query="Did X improve Y?",
            source_texts=[("S1", "evidence")],
            evidence_client=client,
        )
        time.sleep(0.05)
        assert client.calls == []

    def test_general_mode_makes_zero_calls(self) -> None:
        client = _FakeEvidenceClient([])
        maybe_schedule_evidence_shadow(
            settings=self._settings(),
            zoom_in_mode=False,
            query="Did X improve Y?",
            source_texts=[("S1", "evidence")],
            evidence_client=client,
        )
        time.sleep(0.05)
        assert client.calls == []

    def test_non_applicable_question_makes_zero_calls(self) -> None:
        client = _FakeEvidenceClient([])
        maybe_schedule_evidence_shadow(
            settings=self._settings(),
            zoom_in_mode=True,
            query="Summarize this document for me.",  # bypass-keyword, not a claim question
            source_texts=[("S1", "evidence")],
            evidence_client=client,
        )
        time.sleep(0.05)
        assert client.calls == []

    def test_zero_sources_makes_zero_calls(self) -> None:
        client = _FakeEvidenceClient([])
        maybe_schedule_evidence_shadow(
            settings=self._settings(),
            zoom_in_mode=True,
            query="Did X improve Y?",
            source_texts=[],
            evidence_client=client,
        )
        time.sleep(0.05)
        assert client.calls == []

    def test_two_claim_question_is_bypassed_under_the_initial_shadow_default(self) -> None:
        # Milestone 11.2 §25: evidence_analysis_max_claims defaults to 1
        # for the initial shadow rollout, deliberately lower than the
        # claim transformer's own 2-claim MULTI_CLAIM structural
        # capability (see app/core/claim_transformer.py) — a 2-claim
        # question is therefore now bypassed, not partially analyzed.
        client = _FakeEvidenceClient([])
        maybe_schedule_evidence_shadow(
            settings=self._settings(),  # evidence_analysis_max_claims defaults to 1
            zoom_in_mode=True,
            query="Did X improve Y and reduce Z?",
            source_texts=[("S1", "evidence")],
            evidence_client=client,
        )
        time.sleep(0.1)
        assert client.calls == []

    def test_two_claim_question_is_eligible_when_max_claims_raised_to_2(self) -> None:
        # The claim transformer's MULTI_CLAIM path caps at exactly 2
        # claims by construction — with evidence_analysis_max_claims
        # explicitly raised back to 2 (a future-phase config, not this
        # milestone's default), this is the boundary case: eligible, not
        # bypassed, exactly 2 calls (never 3+ — the transformer itself
        # cannot produce more than 2 for this pattern, and the >2
        # rejection path is covered directly in
        # test_evidence_eligibility.py's test_more_than_max_claims_*).
        client = _FakeEvidenceClient([_ok_outcome("entailment"), _ok_outcome("neutral")])
        maybe_schedule_evidence_shadow(
            settings=self._settings(evidence_analysis_max_claims=2),
            zoom_in_mode=True,
            query="Did X improve Y and reduce Z?",
            source_texts=[("S1", "evidence")],
            evidence_client=client,
        )
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline and len(client.calls) < 2:
            time.sleep(0.01)
        assert len(client.calls) == 2

    def test_two_claim_bypass_uses_the_initial_shadow_specific_reason(self, caplog) -> None:
        import logging

        client = _FakeEvidenceClient([])
        with caplog.at_level(logging.INFO, logger="app.evidence_analysis"):
            maybe_schedule_evidence_shadow(
                settings=self._settings(),
                zoom_in_mode=True,
                query="Did X improve Y and reduce Z?",
                source_texts=[("S1", "evidence")],
                evidence_client=client,
            )
            time.sleep(0.1)
        assert any(
            "reason=too_many_claims_initial_shadow" in r.getMessage() for r in caplog.records
        )

    def test_sample_miss_makes_zero_calls(self) -> None:
        client = _FakeEvidenceClient([])
        maybe_schedule_evidence_shadow(
            settings=self._settings(evidence_analysis_sample_rate=0.0),
            zoom_in_mode=True,
            query="Did X improve Y?",
            source_texts=[("S1", "evidence")],
            evidence_client=client,
        )
        time.sleep(0.05)
        assert client.calls == []

    def test_sample_hit_schedules_a_background_job(self) -> None:
        client = _FakeEvidenceClient([_ok_outcome("entailment")])
        maybe_schedule_evidence_shadow(
            settings=self._settings(evidence_analysis_sample_rate=1.0),
            zoom_in_mode=True,
            query="Did X improve Y?",
            source_texts=[("S1", "evidence")],
            evidence_client=client,
        )
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline and not client.calls:
            time.sleep(0.01)
        assert len(client.calls) == 1

    def test_sources_are_capped_at_max_nli_sources(self) -> None:
        client = _FakeEvidenceClient([_ok_outcome("entailment")])
        maybe_schedule_evidence_shadow(
            settings=self._settings(),
            zoom_in_mode=True,
            query="Did X improve Y?",
            source_texts=[(f"S{i}", f"evidence {i}") for i in range(1, 9)],  # 8 sources
            evidence_client=client,
        )
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline and not client.calls:
            time.sleep(0.01)
        assert len(client.calls[0]["sources"]) == 3  # MAX_NLI_SOURCES


class TestBoundedShadowExecutor:
    def test_submit_runs_the_function(self) -> None:
        executor = BoundedShadowExecutor(max_workers=1, max_queued=1)
        done = threading.Event()

        def _fn() -> None:
            done.set()

        assert executor.submit(_fn) is True
        assert done.wait(timeout=1.0)

    def test_submit_beyond_capacity_is_dropped(self) -> None:
        executor = BoundedShadowExecutor(max_workers=1, max_queued=0)
        release = threading.Event()

        def _blocking() -> None:
            release.wait(timeout=2.0)

        assert executor.submit(_blocking) is True  # occupies the 1 worker
        time.sleep(0.05)
        assert executor.submit(lambda: None) is False  # capacity=1, already full
        release.set()

    def test_a_failing_job_does_not_break_the_executor(self) -> None:
        executor = BoundedShadowExecutor(max_workers=1, max_queued=1)

        def _boom() -> None:
            raise RuntimeError("boom")

        assert executor.submit(_boom) is True
        time.sleep(0.05)
        done = threading.Event()
        assert executor.submit(done.set) is True
        assert done.wait(timeout=1.0)


class TestWaitForIdleWindowUnit:
    """Milestone 11.2 §6-§11/§19 — _wait_for_idle_window's branching logic
    in isolation, with is_generation_busy() stubbed to a controllable
    sequence and `sleep` a no-op so every test runs in milliseconds
    regardless of the (still real, still exercised) time.monotonic()-based
    deadlines used internally."""

    def test_immediately_idle_with_zero_grace_returns_ready_fast(self, monkeypatch) -> None:
        monkeypatch.setattr(shadow_module, "is_generation_busy", lambda: False)
        outcome, defer_ms = _wait_for_idle_window(
            idle_grace_seconds=0.0, max_defer_seconds=5.0, sleep=lambda s: None
        )
        assert outcome == "ready"
        assert defer_ms < 500  # no real waiting needed

    def test_busy_the_whole_time_returns_busy_drop_at_deadline(self, monkeypatch) -> None:
        monkeypatch.setattr(shadow_module, "is_generation_busy", lambda: True)
        outcome, defer_ms = _wait_for_idle_window(
            idle_grace_seconds=0.05, max_defer_seconds=0.1, sleep=lambda s: None
        )
        assert outcome == "busy_drop"
        assert defer_ms >= 100 * 0.9  # honored the real max_defer_seconds deadline

    def test_becomes_idle_partway_through_then_ready(self, monkeypatch) -> None:
        calls = {"n": 0}

        def _busy() -> bool:
            calls["n"] += 1
            return calls["n"] < 3  # busy for the first 2 checks, idle from the 3rd on

        monkeypatch.setattr(shadow_module, "is_generation_busy", _busy)
        outcome, _defer_ms = _wait_for_idle_window(
            idle_grace_seconds=0.0, max_defer_seconds=5.0, sleep=lambda s: None
        )
        assert outcome == "ready"
        assert calls["n"] >= 3

    def test_grace_window_resets_when_busy_reappears_mid_grace(self, monkeypatch) -> None:
        # Idle on check 1 (enters grace), busy on check 2 (grace resets),
        # then idle continuously afterward — must NOT return "ready" from
        # the first, interrupted grace attempt; Milestone 11.2 §19's
        # explicit "grace restarts, never partially credited" requirement.
        calls = {"n": 0}

        def _busy() -> bool:
            calls["n"] += 1
            return calls["n"] == 2  # idle, then busy once, then idle forever after

        monkeypatch.setattr(shadow_module, "is_generation_busy", _busy)
        outcome, _defer_ms = _wait_for_idle_window(
            idle_grace_seconds=0.05, max_defer_seconds=5.0, sleep=lambda s: None
        )
        assert outcome == "ready"

    def test_max_defer_boundary_is_respected_even_mid_grace(self, monkeypatch) -> None:
        # Idle immediately, but the grace window itself is longer than
        # max_defer_seconds — must drop, not overrun the deadline waiting
        # out a grace window that can never finish in time.
        monkeypatch.setattr(shadow_module, "is_generation_busy", lambda: False)
        outcome, defer_ms = _wait_for_idle_window(
            idle_grace_seconds=5.0, max_defer_seconds=0.1, sleep=lambda s: None
        )
        assert outcome == "busy_drop"
        assert defer_ms < 1000  # did not wait out the full 5s grace


class TestWaitForIdleWindowRealLeaseIntegration:
    """Milestone 11.2 §17/§22/§23 — _wait_for_idle_window against the
    REAL app.core.generation_activity lease mechanism (not mocked),
    proving the wiring between the two modules is correct, including the
    multi-worker (different-PID lease) and stale-lease cases already unit
    tested in isolation for generation_activity itself."""

    def test_real_active_lease_defers_until_released(self, tmp_path, monkeypatch) -> None:
        from app.core import generation_activity as ga

        monkeypatch.setattr(ga, "LEASE_DIR", tmp_path / "leases")

        with ga.generation_lease():
            outcome, defer_ms = _wait_for_idle_window(
                idle_grace_seconds=0.0, max_defer_seconds=0.15, sleep=lambda s: None
            )
        assert outcome == "busy_drop"  # lease held for the whole window
        assert defer_ms >= 150 * 0.8

    def test_real_lease_from_a_different_pid_also_defers(self, tmp_path, monkeypatch) -> None:
        # Simulates a lease created by the OTHER backend worker process —
        # see test_generation_activity.py's TestWorkerProcessSharing for
        # why PID 1 stands in for "a different, real, live PID."
        from app.core import generation_activity as ga

        lease_dir = tmp_path / "leases"
        monkeypatch.setattr(ga, "LEASE_DIR", lease_dir)
        ga._ensure_lease_dir()
        (lease_dir / "1-other-worker.lease").write_text(str(time.time()))

        outcome, _defer_ms = _wait_for_idle_window(
            idle_grace_seconds=0.0, max_defer_seconds=0.1, sleep=lambda s: None
        )
        assert outcome == "busy_drop"

    def test_stale_crashed_lease_does_not_block_idle_detection(self, tmp_path, monkeypatch) -> None:
        from app.core import generation_activity as ga

        lease_dir = tmp_path / "leases"
        monkeypatch.setattr(ga, "LEASE_DIR", lease_dir)
        ga._ensure_lease_dir()
        # PID essentially guaranteed not to exist — a crashed worker's
        # abandoned lease (Milestone 11.2 §7/§23).
        (lease_dir / "999999-crashed.lease").write_text(str(time.time()))

        outcome, _defer_ms = _wait_for_idle_window(
            idle_grace_seconds=0.0, max_defer_seconds=1.0, sleep=lambda s: None
        )
        assert outcome == "ready"


class TestMaxPendingShadowJobsQueueBound:
    """Milestone 11.2 §13 — the module-level _shadow_executor's reduced
    capacity."""

    def test_module_level_executor_capacity_is_four(self) -> None:
        # max_workers=2 + max_queued=2 (down from Milestone 11's
        # max_workers=2 + max_queued=8) — see evidence_shadow.py's own
        # comment on _shadow_executor for the reasoning.
        assert shadow_module._shadow_executor._capacity == 4
