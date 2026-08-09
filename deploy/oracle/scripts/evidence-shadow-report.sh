#!/usr/bin/env bash
#
# Milestone 11.4 — read-only structural report over the evidence-analysis
# shadow track's own log lines (logger "app.evidence_analysis", see
# rag-backend/app/core/evidence_observability.py). Aggregates counts and
# latency percentiles ONLY — every field these log lines ever contain is
# structural (event names, counts, durations, model id/revision, error
# codes) by construction; none of them can contain query, claim, source,
# or document text (see that module's own docstring). This script does
# not add any new capability — it only greps/aggregates log lines the
# application already emits.
#
# Never rebuilds or restarts anything — pure `docker logs` + text
# processing.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

SINCE="24h"
JSON_OUT=""

usage() {
    cat <<EOF_USAGE
Usage:
  $(basename "$0") [options]

Aggregates structural counts and latency percentiles from the backend's
own evidence-analysis log lines. Read-only — never modifies
configuration, never restarts anything.

Options:
  --since DURATION   How far back to look, in Docker's --since syntax
                      (e.g. "24h", "2026-08-10T00:00:00") — default: 24h
  --json-out PATH     Also write a machine-readable JSON report to PATH
  -h, --help          Show this help message
EOF_USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --since) SINCE="$2"; shift 2 ;;
        --json-out) JSON_OUT="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) die "Unknown argument: $1 (see --help)" ;;
    esac
done

check_oracle_environment

BACKEND_CONTAINER="$(oracle_container_id backend)"
[[ -n "$BACKEND_CONTAINER" ]] || die "backend container not found."

print_header "EduM8 Evidence Shadow — Structural Observation Report"
info "Window: --since $SINCE (docker logs), generated $(date -u +%Y-%m-%dT%H:%M:%SZ)"
info "Source: backend container's own 'app.evidence_analysis' log lines only — no user content read."

LOG_LINES="$(docker logs --since "$SINCE" "$BACKEND_CONTAINER" 2>&1 | grep 'app.evidence_analysis ' || true)"
LINE_COUNT="$(echo -n "$LOG_LINES" | grep -c 'evidence_analysis event=' || true)"

if [[ -z "$LOG_LINES" || "$LINE_COUNT" -eq 0 ]]; then
    warn "No evidence_analysis log lines found in this window — either shadow is disabled, or no eligible Zoom-In traffic occurred, or the window is too short."
fi

# --- helpers -----------------------------------------------------------

count_event() {
    local event="$1"
    echo -n "$LOG_LINES" | grep -c "event=${event}\b" 2>/dev/null || true
}

count_bypassed_reason() {
    local reason="$1"
    echo -n "$LOG_LINES" | { grep "event=bypassed " || true; } | { grep -c "reason=${reason}\b" || true; }
}

extract_field_values() {
    # extract_field_values LINE_FILTER FIELD_NAME
    local filter="$1" field="$2"
    echo -n "$LOG_LINES" | { grep "$filter" || true; } | { grep -oE "${field}=[0-9.]+" || true; } | cut -d= -f2
}

percentile() {
    # percentile P (0-100) < newline-separated numbers on stdin
    local p="$1"
    python3 -c "
import sys
vals = sorted(float(x) for x in sys.stdin.read().split() if x)
if not vals:
    print('n/a')
else:
    idx = min(len(vals) - 1, int(round($p / 100 * (len(vals) - 1))))
    print(round(vals[idx], 1))
"
}

stat_line() {
    # stat_line LABEL < newline-separated numbers on stdin
    local label="$1"
    local vals
    vals="$(cat)"
    local n
    n="$(echo -n "$vals" | grep -c . || true)"
    if [[ "$n" -eq 0 ]]; then
        info "$label: n=0"
        return
    fi
    local p50 p95 mean min max
    p50="$(echo "$vals" | percentile 50)"
    p95="$(echo "$vals" | percentile 95)"
    mean="$(echo "$vals" | python3 -c "import sys; v=[float(x) for x in sys.stdin.read().split() if x]; print(round(sum(v)/len(v),1) if v else 'n/a')")"
    min="$(echo "$vals" | python3 -c "import sys; v=[float(x) for x in sys.stdin.read().split() if x]; print(round(min(v),1) if v else 'n/a')")"
    max="$(echo "$vals" | python3 -c "import sys; v=[float(x) for x in sys.stdin.read().split() if x]; print(round(max(v),1) if v else 'n/a')")"
    info "$label: n=$n mean=$mean p50=$p50 p95=$p95 min=$min max=$max"
}

# --- bypass reasons ------------------------------------------------------

print_section "Bypassed (eligibility failed) — by reason"
REASON_MASTER=$(count_bypassed_reason "master_disabled")
REASON_MODE=$(count_bypassed_reason "mode_not_shadow")
REASON_ZOOMIN=$(count_bypassed_reason "not_zoom_in")
REASON_NOSRC=$(count_bypassed_reason "no_sources")
REASON_NOTAPPLICABLE=$(count_bypassed_reason "not_transform_applicable")
REASON_TOOMANY_INITIAL=$(count_bypassed_reason "too_many_claims_initial_shadow")
REASON_TOOMANY=$(count_bypassed_reason "too_many_claims")  # includes the _initial_shadow variant too (substring) — corrected below
REASON_TOOMANY_GENERIC=$((REASON_TOOMANY - REASON_TOOMANY_INITIAL))
REASON_QUEUEFULL=$(count_bypassed_reason "shadow_queue_full")
info "master_disabled=$REASON_MASTER mode_not_shadow=$REASON_MODE not_zoom_in=$REASON_ZOOMIN no_sources=$REASON_NOSRC"
info "not_transform_applicable=$REASON_NOTAPPLICABLE too_many_claims_initial_shadow=$REASON_TOOMANY_INITIAL too_many_claims(generic)=$REASON_TOOMANY_GENERIC"
info "shadow_queue_full=$REASON_QUEUEFULL"

NOT_ELIGIBLE_TOTAL=$((REASON_MASTER + REASON_MODE + REASON_ZOOMIN + REASON_NOSRC + REASON_NOTAPPLICABLE + REASON_TOOMANY))

# --- sampling ------------------------------------------------------------

print_section "Sampling"
NOT_SAMPLED=$(count_event "not_sampled")
info "sample_skips (eligible but not sampled)=$NOT_SAMPLED"

# --- scheduling / defer ---------------------------------------------------

print_section "Deferred / busy / idle-start"
DEFERRED_BUSY_EVENTS=$(count_event "deferred_busy")
DROPPED_BUSY=$(count_event "dropped_busy")
IDLE_START=$(count_event "idle_start")
info "deferred_busy EVENTS (a job can log this more than once if grace is interrupted)=$DEFERRED_BUSY_EVENTS"
info "dropped_busy (max-defer exceeded, job never ran)=$DROPPED_BUSY"
info "idle_start (job confirmed idle window, NLI call about to start)=$IDLE_START"

SHADOW_JOBS_SCHEDULED=$((DROPPED_BUSY + IDLE_START))
SAMPLED_TOTAL=$((REASON_QUEUEFULL + SHADOW_JOBS_SCHEDULED))
ELIGIBLE_TOTAL=$((NOT_SAMPLED + SAMPLED_TOTAL))

# --- shadow_result outcomes ------------------------------------------------

print_section "Shadow result outcomes"
SHADOW_RESULT_LINES="$(echo -n "$LOG_LINES" | grep 'event=shadow_result ' || true)"
SUCCESS_COUNT="$(echo -n "$SHADOW_RESULT_LINES" | grep -c 'error=none' 2>/dev/null || true)"
TIMEOUT_COUNT="$(echo -n "$SHADOW_RESULT_LINES" | grep -c 'timed_out=True' 2>/dev/null || true)"
UNAVAILABLE_COUNT="$(echo -n "$SHADOW_RESULT_LINES" | grep -c 'error=unavailable' 2>/dev/null || true)"
MALFORMED_COUNT="$(echo -n "$SHADOW_RESULT_LINES" | grep -c 'error=malformed_response' 2>/dev/null || true)"
NOTREADY_COUNT="$(echo -n "$SHADOW_RESULT_LINES" | grep -c 'error=not_ready' 2>/dev/null || true)"
INVALID_COUNT="$(echo -n "$SHADOW_RESULT_LINES" | grep -c 'error=invalid_request' 2>/dev/null || true)"
UNKNOWNERR_COUNT="$(echo -n "$SHADOW_RESULT_LINES" | grep -c 'error=unknown_error' 2>/dev/null || true)"
TOTAL_RESULT_COUNT="$(echo -n "$SHADOW_RESULT_LINES" | grep -c . 2>/dev/null || true)"
OTHER_ERR_COUNT=$((TOTAL_RESULT_COUNT - SUCCESS_COUNT - UNAVAILABLE_COUNT - MALFORMED_COUNT - NOTREADY_COUNT - INVALID_COUNT - UNKNOWNERR_COUNT))
info "successful=$SUCCESS_COUNT  timeout=$TIMEOUT_COUNT  service_unavailable=$UNAVAILABLE_COUNT  malformed_response=$MALFORMED_COUNT"
info "not_ready=$NOTREADY_COUNT  invalid_request=$INVALID_COUNT  unknown_error=$UNKNOWNERR_COUNT  other/unclassified=$OTHER_ERR_COUNT"
info "total shadow_result outcomes=$TOTAL_RESULT_COUNT"

# --- evidence state distribution ------------------------------------------

print_section "Evidence-state distribution (descriptive only — NOT a correctness judgment)"
for state in SUFFICIENT PARTIAL INSUFFICIENT CONTRADICTORY CONFLICTED; do
    c="$(echo -n "$SHADOW_RESULT_LINES" | grep -c "evidence_state=${state}\b" 2>/dev/null || true)"
    info "$state=$c"
done

# --- claim / source counts -------------------------------------------------

print_section "Claim / source counts"
CLAIM_COUNTS="$(extract_field_values 'event=shadow_result' 'claim_count')"
SOURCE_COUNTS="$(extract_field_values 'event=shadow_result' 'source_count')"
MULTI_CLAIM_RESULTS="$(echo -n "$CLAIM_COUNTS" | awk '$1>1' | grep -c . 2>/dev/null || true)"
info "claim_count values: $(echo -n "$CLAIM_COUNTS" | tr '\n' ' ')"
info "source_count values: $(echo -n "$SOURCE_COUNTS" | tr '\n' ' ')"
if [[ "$MULTI_CLAIM_RESULTS" -gt 0 ]]; then
    error "Found $MULTI_CLAIM_RESULTS shadow_result(s) with claim_count>1 — should be impossible under evidence_analysis_max_claims=1; investigate."
else
    success "No multi-claim shadow_result observed — consistent with evidence_analysis_max_claims=1 (multi-claim requests are bypassed, never partially analyzed)."
fi

# --- latency ---------------------------------------------------------------

print_section "NLI latency (successful shadow_result only, ms)"
NLI_LATENCIES="$(echo -n "$SHADOW_RESULT_LINES" | { grep 'error=none' || true; } | { grep -oE 'latency_ms=[0-9.]+' || true; } | cut -d= -f2)"
echo "$NLI_LATENCIES" | stat_line "NLI latency ms"

print_section "Defer time (idle_start events, ms — time waited before NLI started)"
DEFER_MS_VALUES="$(extract_field_values 'event=idle_start' 'defer_ms')"
echo "$DEFER_MS_VALUES" | stat_line "defer_ms (idle_start)"

print_section "Busy-drop wait time (ms — time waited before giving up)"
DROP_MS_VALUES="$(extract_field_values 'event=dropped_busy' 'defer_ms')"
echo "$DROP_MS_VALUES" | stat_line "defer_ms (dropped_busy)"

# --- rates -------------------------------------------------------------

print_section "Rates"
if [[ "$SHADOW_JOBS_SCHEDULED" -gt 0 ]]; then
    TIMEOUT_RATE="$(python3 -c "print(round(100*$TIMEOUT_COUNT/$SHADOW_JOBS_SCHEDULED, 2))")"
    BUSY_DROP_RATE="$(python3 -c "print(round(100*$DROPPED_BUSY/$SHADOW_JOBS_SCHEDULED, 2))")"
else
    TIMEOUT_RATE="n/a"
    BUSY_DROP_RATE="n/a"
fi
info "timeout rate (timeouts / shadow jobs scheduled) = $TIMEOUT_RATE%"
info "busy-drop rate (busy_drop / shadow jobs scheduled) = $BUSY_DROP_RATE%"

# --- summary -------------------------------------------------------------

print_section "Summary counts"
info "eligible (within Zoom-In+enabled+has-sources scope) = $ELIGIBLE_TOTAL"
info "not_eligible (same scope)                            = $NOT_ELIGIBLE_TOTAL"
info "sampled                                               = $SAMPLED_TOTAL"
info "sample_skips                                          = $NOT_SAMPLED"
info "shadow jobs scheduled (entered defer-wait)            = $SHADOW_JOBS_SCHEDULED"
info "shadow successful                                     = $SUCCESS_COUNT"
info "shadow busy_drop                                      = $DROPPED_BUSY"
info "shadow queue_full (never even scheduled)              = $REASON_QUEUEFULL"
info "shadow timeout                                        = $TIMEOUT_COUNT"
info "shadow service_unavailable                            = $UNAVAILABLE_COUNT"
info "shadow malformed_response                             = $MALFORMED_COUNT"

if [[ -n "$JSON_OUT" ]]; then
    python3 -c "
import json
data = {
    'generated_at_utc': '$(date -u +%Y-%m-%dT%H:%M:%SZ)',
    'since': '$SINCE',
    'eligible_total': $ELIGIBLE_TOTAL,
    'not_eligible_total': $NOT_ELIGIBLE_TOTAL,
    'sampled_total': $SAMPLED_TOTAL,
    'sample_skips': $NOT_SAMPLED,
    'shadow_jobs_scheduled': $SHADOW_JOBS_SCHEDULED,
    'deferred_busy_events': $DEFERRED_BUSY_EVENTS,
    'busy_drop': $DROPPED_BUSY,
    'queue_full': $REASON_QUEUEFULL,
    'successful': $SUCCESS_COUNT,
    'timeout': $TIMEOUT_COUNT,
    'service_unavailable': $UNAVAILABLE_COUNT,
    'malformed_response': $MALFORMED_COUNT,
    'not_ready': $NOTREADY_COUNT,
    'invalid_request': $INVALID_COUNT,
    'unknown_error': $UNKNOWNERR_COUNT,
    'timeout_rate_pct': '$TIMEOUT_RATE',
    'busy_drop_rate_pct': '$BUSY_DROP_RATE',
}
with open('$JSON_OUT', 'w') as f:
    json.dump(data, f, indent=2)
"
    success "JSON report written to $JSON_OUT"
fi

print_section "Done"
info "This script is read-only — no configuration was changed, no service was restarted."
