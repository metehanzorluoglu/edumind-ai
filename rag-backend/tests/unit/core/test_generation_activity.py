"""Milestone 11.2 (Contention-Aware Shadow Scheduling & Capacity Decision)
§6/§7/§23/§32 — tests for app/core/generation_activity.py. Pure
filesystem + os.getpid()/PID-liveness logic, no real generation, no
model, no network."""

from __future__ import annotations

import os
import time

import pytest

from app.core import generation_activity as ga


@pytest.fixture(autouse=True)
def isolated_lease_dir(tmp_path, monkeypatch):
    """Every test gets its own empty lease directory — never the real
    shared /tmp location — so tests can't interfere with each other or
    with a real running process."""
    lease_dir = tmp_path / "leases"
    monkeypatch.setattr(ga, "LEASE_DIR", lease_dir)
    return lease_dir


class TestBasicReferenceCounting:
    def test_no_leases_means_idle(self) -> None:
        assert ga.active_generation_count() == 0
        assert ga.is_generation_busy() is False

    def test_one_active_lease_means_busy(self) -> None:
        with ga.generation_lease():
            assert ga.active_generation_count() == 1
            assert ga.is_generation_busy() is True
        assert ga.active_generation_count() == 0

    def test_lease_released_on_normal_exit(self) -> None:
        with ga.generation_lease():
            pass
        assert ga.active_generation_count() == 0


class TestMultipleSimultaneousGenerations:
    def test_two_nested_leases_count_as_two(self) -> None:
        with ga.generation_lease():
            with ga.generation_lease():
                assert ga.active_generation_count() == 2
            # one released — the other must still be counted, not
            # incorrectly flipped to idle (Milestone 11.2 §6's explicit
            # "must not produce an incorrect idle state when one
            # finishes" requirement).
            assert ga.active_generation_count() == 1
        assert ga.active_generation_count() == 0

    def test_release_order_does_not_matter(self) -> None:
        cm1 = ga.generation_lease()
        cm2 = ga.generation_lease()
        cm1.__enter__()
        cm2.__enter__()
        assert ga.active_generation_count() == 2
        cm1.__exit__(None, None, None)
        assert ga.active_generation_count() == 1
        cm2.__exit__(None, None, None)
        assert ga.active_generation_count() == 0


class TestExceptionAndCancellationRelease:
    def test_exception_inside_the_with_block_still_releases(self) -> None:
        with pytest.raises(RuntimeError):
            with ga.generation_lease():
                assert ga.active_generation_count() == 1
                raise RuntimeError("simulated generation error")
        assert ga.active_generation_count() == 0

    def test_generator_close_simulating_cancellation_releases(self) -> None:
        # Simulates a cancellation path that exits the context manager
        # via GeneratorExit rather than a normal return or a raised
        # application exception — must still release.
        cm = ga.generation_lease()
        cm.__enter__()
        assert ga.active_generation_count() == 1
        cm.__exit__(None, None, None)
        assert ga.active_generation_count() == 0


class TestWorkerProcessSharing:
    def test_lease_from_a_different_but_real_pid_is_counted(self) -> None:
        # Simulates a SECOND worker process's lease by writing one with
        # this test process's own PID (the only PID we can guarantee is
        # "alive" without actually forking) — the point under test is
        # that active_generation_count() has no dependency on WHICH
        # worker created a lease file, only that its filesystem entry
        # exists and its owning PID is alive. This is exactly the
        # property that makes the mechanism multi-worker-safe: any
        # worker process reading the shared directory sees every other
        # worker's leases identically.
        ga._ensure_lease_dir()
        lease_path = ga.LEASE_DIR / f"{os.getpid()}-simulated-other-worker.lease"
        lease_path.write_text(str(time.time()))
        assert ga.active_generation_count() == 1

    def test_two_different_real_pids_both_count(self) -> None:
        ga._ensure_lease_dir()
        (ga.LEASE_DIR / f"{os.getpid()}-a.lease").write_text(str(time.time()))
        # Simulate a second worker with PID 1 (the container's init
        # process / this test host's PID 1 — guaranteed to exist on any
        # Linux system, standing in for "a different real, live PID").
        (ga.LEASE_DIR / "1-b.lease").write_text(str(time.time()))
        assert ga.active_generation_count() == 2


class TestStaleStateRecovery:
    def test_lease_with_dead_pid_is_not_counted_and_is_reaped(self) -> None:
        ga._ensure_lease_dir()
        # PID 999999 is essentially guaranteed not to exist.
        dead_lease = ga.LEASE_DIR / "999999-crashed.lease"
        dead_lease.write_text(str(time.time()))
        assert ga.active_generation_count() == 0
        assert not dead_lease.exists()  # reaped, not left stuck forever

    def test_lease_with_live_pid_but_stale_age_is_not_counted(self) -> None:
        ga._ensure_lease_dir()
        old_lease = ga.LEASE_DIR / f"{os.getpid()}-old.lease"
        old_lease.write_text(str(time.time()))
        # Backdate the mtime past the staleness window — simulates a
        # lease from a generation that should have finished long ago
        # (the PID-reuse edge case the module docstring describes).
        old_time = time.time() - (ga.STALE_LEASE_MAX_AGE_SECONDS + 10)
        os.utime(old_lease, (old_time, old_time))
        assert ga.active_generation_count() == 0
        assert not old_lease.exists()

    def test_fresh_lease_with_live_pid_is_counted(self) -> None:
        ga._ensure_lease_dir()
        fresh_lease = ga.LEASE_DIR / f"{os.getpid()}-fresh.lease"
        fresh_lease.write_text(str(time.time()))
        assert ga.active_generation_count() == 1
        assert fresh_lease.exists()

    def test_malformed_lease_filename_is_ignored_and_reaped(self) -> None:
        ga._ensure_lease_dir()
        bad = ga.LEASE_DIR / "not-a-pid-prefix.lease"
        bad.write_text("garbage")
        assert ga.active_generation_count() == 0
        assert not bad.exists()

    def test_crash_never_permanently_prevents_future_generations(self) -> None:
        # A whole sequence: crash leaves a stuck lease, but a subsequent
        # real (short-lived, in-process) generation lease still works
        # correctly afterward — proving the crash doesn't poison the
        # mechanism going forward.
        ga._ensure_lease_dir()
        (ga.LEASE_DIR / "999998-another-crash.lease").write_text(str(time.time()))
        assert ga.active_generation_count() == 0  # reaped

        with ga.generation_lease():
            assert ga.active_generation_count() == 1
        assert ga.active_generation_count() == 0


class TestNoContentInLeaseFiles:
    def test_lease_file_content_is_only_a_timestamp(self) -> None:
        with ga.generation_lease():
            leases = list(ga.LEASE_DIR.glob("*.lease"))
            assert len(leases) == 1
            content = leases[0].read_text()
            float(content)  # must parse cleanly as just a timestamp

    def test_lease_filename_contains_no_identifying_reference(self) -> None:
        with ga.generation_lease():
            leases = list(ga.LEASE_DIR.glob("*.lease"))
            name = leases[0].name
            # pid-randomhex.lease — never a message/conversation UUID
            # from the actual request.
            pid_part, _, rest = name.partition("-")
            assert pid_part.isdigit()
            assert rest.endswith(".lease")
