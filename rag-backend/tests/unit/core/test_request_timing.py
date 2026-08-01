"""Covers app/core/request_timing.py directly: the disabled-by-default
no-op path (PERFORMANCE_PROFILING=false), stage recording/aggregation when
enabled, the Server-Timing header format, and the ambient bind/unbind
contextvar used where a RequestTimer can't be threaded through as an
explicit parameter (see app/core/retriever.py, app/core/rag_service.py).
"""

import time

from app.core.request_timing import (
    DISABLED_TIMER,
    RequestTimer,
    bind_timer,
    get_current_timer,
    unbind_timer,
)


def test_disabled_timer_stage_is_a_true_noop() -> None:
    timer = RequestTimer(enabled=False)

    ran = False
    with timer.stage("whatever"):
        ran = True

    assert ran is True  # the wrapped code still executes
    assert timer.as_dict() == {}
    assert timer.total_ms() == 0.0
    assert timer.server_timing_header() == ""


def test_disabled_timer_record_is_a_true_noop() -> None:
    timer = RequestTimer(enabled=False)

    timer.record("whatever", 123.0)

    assert timer.as_dict() == {}


def test_enabled_timer_records_stage_duration() -> None:
    timer = RequestTimer(enabled=True)

    with timer.stage("embedding"):
        time.sleep(0.01)

    timings = timer.as_dict()
    assert "embedding" in timings
    assert timings["embedding"] >= 10.0  # at least the 10ms sleep, in ms
    assert "total_ms" in timings
    assert timings["total_ms"] >= timings["embedding"]


def test_enabled_timer_sums_repeated_stage_names() -> None:
    """A stage recorded multiple times (e.g. "embedding" once per
    retrieval scope tier) must be summed under one key, not overwritten or
    kept as separate entries — this is what makes the final timing table
    one row per stage regardless of how many scope tiers ran."""
    timer = RequestTimer(enabled=True)

    timer.record("embedding", 10.0)
    timer.record("embedding", 15.0)
    timer.record("retrieval", 5.0)

    timings = timer.as_dict()
    assert timings["embedding"] == 25.0
    assert timings["retrieval"] == 5.0


def test_stage_records_duration_even_when_body_raises() -> None:
    timer = RequestTimer(enabled=True)

    try:
        with timer.stage("llm_generation"):
            raise ValueError("boom")
    except ValueError:
        pass

    assert "llm_generation" in timer.as_dict()


def test_server_timing_header_format() -> None:
    timer = RequestTimer(enabled=True)
    timer.record("auth", 1.5)
    timer.record("retrieval", 20.25)

    header = timer.server_timing_header()

    assert "auth;dur=1.50" in header
    assert "retrieval;dur=20.25" in header
    assert "total;dur=" in header


def test_disabled_timer_record_metric_is_a_true_noop() -> None:
    timer = RequestTimer(enabled=False)

    timer.record_metric("actual_prompt_tokens", 2560)

    assert timer.as_dict() == {}


def test_enabled_timer_records_metric_value() -> None:
    """Unlike record() (a duration, summed across repeated calls),
    record_metric() is a point-in-time value — a count or rate straight
    from Ollama's own reported stats (see llm_provider.py's
    _record_ollama_metrics)."""
    timer = RequestTimer(enabled=True)

    timer.record_metric("completion_token_count", 42)

    assert timer.as_dict()["completion_token_count"] == 42


def test_enabled_timer_record_metric_last_write_wins() -> None:
    """Deliberately different from record()'s summing behavior: a metric
    re-recorded under the same name (e.g. a value refined once more data
    is available) replaces, not accumulates."""
    timer = RequestTimer(enabled=True)

    timer.record_metric("decode_tokens_per_second", 4.2)
    timer.record_metric("decode_tokens_per_second", 5.5)

    assert timer.as_dict()["decode_tokens_per_second"] == 5.5


def test_record_metric_and_record_coexist_in_as_dict() -> None:
    timer = RequestTimer(enabled=True)

    timer.record("embedding", 10.0)
    timer.record_metric("retrieved_chunk_count", 3)

    timings = timer.as_dict()
    assert timings["embedding"] == 10.0
    assert timings["retrieved_chunk_count"] == 3


def test_get_current_timer_defaults_to_disabled_singleton() -> None:
    assert get_current_timer() is DISABLED_TIMER


def test_bind_and_unbind_timer_scopes_the_ambient_accessor() -> None:
    timer = RequestTimer(enabled=True)

    assert get_current_timer() is DISABLED_TIMER
    token = bind_timer(timer)
    try:
        assert get_current_timer() is timer
    finally:
        unbind_timer(token)
    assert get_current_timer() is DISABLED_TIMER
