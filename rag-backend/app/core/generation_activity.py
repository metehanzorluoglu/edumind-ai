"""Milestone 11.2 (Contention-Aware Shadow Scheduling & Capacity Decision)
§3/§4/§5/§7 — a host-wide (all backend workers) signal for "is a real
Ollama generation (qwen3:8b text, or vision) actively in flight right
now?", used exclusively by the evidence-analysis shadow scheduler
(app/core/evidence_shadow.py) to avoid starting NLI inference while
Ollama is already consuming most of the host's CPU (Milestone 11.1 §11's
real, measured finding: evidence-service calls degrade to outright
failure during concurrent qwen3:8b generation on this 4-OCPU host).

WHY NOT A PLAIN MODULE-LEVEL VARIABLE (Milestone 11.2 §3/§4):
`uvicorn app.main:app --workers 2` (deploy/oracle/docker-compose.oracle.yml)
spawns 2 SEPARATE OS PROCESSES via Python's multiprocessing — confirmed
directly against the live Oracle container this milestone (PIDs 9/10, each
its own `spawn_main(...--multiprocessing-fork)` process, with a shared PID
1 uvicorn master and a shared `resource_tracker`). This is NOT multiple
threads in one process — it is two independent Python interpreters with
completely separate memory. `app/core/generation_manager.py`'s `_states`
dict (also a module-level global) is therefore WORKER-LOCAL: a generation
started in worker A is entirely invisible to worker B's own
`generation_manager` module state. A host-wide signal needs something
BOTH workers can observe, which module-level Python state structurally
cannot provide.

WHY A FILESYSTEM LEASE, NOT REDIS/A NEW SERVICE (Milestone 11.2 §5): both
worker processes run inside the SAME Docker container (confirmed directly
above — same PID namespace, same filesystem), so they already share
`/tmp` for free, with no new infrastructure, no new container, no new
network hop. Redis is not deployed anywhere in this stack and Milestone
11.2 explicitly forbids adding it "solely for this." A lightweight
coordination endpoint (evidence-service itself, or a new one) would add a
network round-trip and a new failure mode for a signal that's needed on
every single request's own worker, in-process, at near-zero cost — a
plain, uncontended local filesystem check is simply the smallest correct
tool here, matching Milestone 11.1's own established preference for the
smallest robust mechanism over new infrastructure.

WHY REFERENCE-COUNTED LEASE FILES, NOT A SINGLE BOOLEAN FILE (Milestone
11.2 §6): "one file exists" cannot represent 2 simultaneous generations
correctly — if both worker A and worker B are independently generating
and worker A finishes first, a single shared boolean would incorrectly
flip to "idle" while worker B is still actively generating. One lease
file PER in-flight generation, named for its owning PID, makes
`active_generation_count()` a true count (`len(valid leases)`), not a
toggle — multiple concurrent generations naturally sum, and one finishing
only removes ITS OWN lease.

CRASH SAFETY (Milestone 11.2 §7): a worker process that crashes (OOM-kill,
segfault, `docker restart`) leaves its lease file behind with no code
running to remove it in a `finally` block. Two independent, layered
defenses against a permanently-stuck "busy" state: (1) the lease filename
encodes the owning PID; `active_generation_count()` checks
`/proc/<pid>` for liveness on every read (both workers share one PID
namespace — confirmed above — so this check is valid across workers, not
just within one), reaping (deleting) any lease whose owning process no
longer exists; (2) an age-based backstop (`STALE_LEASE_MAX_AGE_SECONDS`)
independently reaps any lease older than a real generation could
plausibly still be running, guarding against the one known residual gap
in PID-liveness checking — PID REUSE (the OS assigning a crashed worker's
old PID to an unrelated new process before this code happens to check) —
a rare but non-zero risk with PID-based liveness checks in general, kept
from ever becoming truly stuck because the age check does not depend on
PID identity at all.

NO CONTENT (Milestone 11.2 §14): a lease file's name is
`{pid}-{random-hex}.lease` and its content is a single float timestamp —
never a query, claim, message ID, conversation ID, or any other
content/identifying reference. There is nothing in this module for a
future call site to even accidentally leak.
"""

from __future__ import annotations

import os
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

#: Overridable so tests can point this at an isolated tmp_path instead of
#: the real shared location — the one piece of "configuration" this
#: module has, deliberately not a Settings field (this is infrastructure
#: plumbing internal to one container, not an operator-facing tunable).
LEASE_DIR = Path(os.environ.get("GENERATION_LEASE_DIR", "/tmp/evidence-generation-leases"))

#: A real qwen3:8b/vision generation on this host has been observed
#: (Milestones 5-11) to take well under 5 minutes even in worst-case
#: (long-context, vision-batch) scenarios; 10 minutes is a deliberately
#: generous backstop that will essentially never fire for a genuinely
#: still-running generation, while still bounding the PID-reuse risk
#: described in the module docstring to a finite window.
STALE_LEASE_MAX_AGE_SECONDS = 600


def _ensure_lease_dir() -> None:
    LEASE_DIR.mkdir(parents=True, exist_ok=True)


def _pid_alive(pid: int) -> bool:
    """Same-container, same-PID-namespace liveness check (see module
    docstring) — works across worker processes, not just within one."""
    return Path(f"/proc/{pid}").exists()


def _parse_owner_pid(lease_name: str) -> int | None:
    pid_part = lease_name.split("-", 1)[0]
    return int(pid_part) if pid_part.isdigit() else None


def _reap(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass


@contextmanager
def generation_lease() -> Iterator[None]:
    """Acquire on enter, release on exit — normal return, exception, or
    cancellation all go through the same `finally`, so every exit path
    releases the lease exactly once (Milestone 11.2 §6's "normal
    completion, client disconnect, generation error, timeout,
    cancellation" list). Callers wrap ONLY the actual Ollama-calling
    portion of a generation worker (see generation_manager.py's
    `run_text_generation`/`run_vision_generation`/
    `run_batched_vision_generation`) — never the whole request, and never
    the insufficient-evidence fast path, which makes no Ollama call and
    contends for no CPU."""
    _ensure_lease_dir()
    lease_path = LEASE_DIR / f"{os.getpid()}-{uuid.uuid4().hex}.lease"
    lease_path.write_text(str(time.time()))
    try:
        yield
    finally:
        _reap(lease_path)


def active_generation_count() -> int:
    """Host-wide (both worker processes) count of currently active
    Ollama generations, with the crash-safety reaping described in the
    module docstring applied on every call — so a stale/abandoned lease
    is corrected the next time ANY worker happens to check, not on some
    separate cleanup schedule."""
    _ensure_lease_dir()
    now = time.time()
    count = 0
    for entry in LEASE_DIR.iterdir():
        if not entry.name.endswith(".lease"):
            continue
        pid = _parse_owner_pid(entry.name)
        if pid is None:
            _reap(entry)
            continue
        if not _pid_alive(pid):
            _reap(entry)
            continue
        try:
            mtime = entry.stat().st_mtime
        except FileNotFoundError:
            continue
        if now - mtime > STALE_LEASE_MAX_AGE_SECONDS:
            _reap(entry)
            continue
        count += 1
    return count


def is_generation_busy() -> bool:
    return active_generation_count() > 0
