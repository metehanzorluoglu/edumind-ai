#!/usr/bin/env bash
#
# Milestone 11.1 — non-destructive evidence-service capacity/latency
# sampler. Measures 1x1 / 1x3 / 2x3 classify_batch latency against ONLY
# fixed, synthetic, hardcoded sentences (never a real document, never a
# real chat message, never any production user content), alongside a
# point-in-time snapshot of host/container CPU, RAM, load average, and
# service health — so an operator can run this a few times across a real
# production day (morning/midday/evening — see the Milestone 11.1 report's
# "Sample Schedule Recommendation") and see how contention with real
# concurrent traffic (backend + Ollama + Qdrant) affects evidence-service
# latency, without ever needing to read chat content to do it.
#
# This script does NOT stress test, does NOT run continuously, does NOT
# modify any configuration, and does NOT restart any service — it makes a
# small, bounded number of calls and exits. Safe to run against the live
# Oracle host at any time, including while EVIDENCE_ANALYSIS_ENABLED=false
# (the evidence-service itself has no awareness of that backend-side flag
# at all — it will happily classify whatever it's sent, which is exactly
# what this script uses it for).

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

SAMPLES=5
JSON_OUT=""

usage() {
    cat <<EOF_USAGE
Usage:
  $(basename "$0") [options]

Runs a small, bounded set of synthetic-only classify_batch calls against
the running evidence-service container (1x1, 1x3, 2x3 — $SAMPLES samples
each by default) and reports latency percentiles alongside a point-in-time
CPU/RAM/load snapshot. Never touches production document/chat content.
Never modifies configuration or restarts anything.

Options:
  -n, --samples N     Samples per configuration (default: $SAMPLES)
  -j, --json-out PATH Also write a machine-readable JSON report to PATH
  -h, --help           Show this help message
EOF_USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -n|--samples) SAMPLES="$2"; shift 2 ;;
        -j|--json-out) JSON_OUT="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) die "Unknown argument: $1 (see --help)" ;;
    esac
done

check_oracle_environment

print_header "EduM8 Evidence Service — Capacity Check ($(date -u +%Y-%m-%dT%H:%M:%SZ))"

################################################################################
# 1. Health snapshot — backend, evidence-service, Ollama, Qdrant.
################################################################################

print_section "Service health"

if oracle_backend_health >/dev/null 2>&1; then
    success "backend: reachable"
else
    warn "backend: unreachable (capacity check continues — evidence-service is independent)"
fi

EVIDENCE_CONTAINER_ID="$(oracle_compose ps -q evidence-service 2>/dev/null || true)"
if [[ -z "$EVIDENCE_CONTAINER_ID" ]]; then
    die "evidence-service container not found. Is it deployed? See evidence-service/README.md."
fi

EVIDENCE_HEALTH_JSON="$(docker exec "$EVIDENCE_CONTAINER_ID" python3 -c "
import json, urllib.request
print(json.dumps(json.loads(urllib.request.urlopen('http://127.0.0.1:8100/health', timeout=5).read())))
" 2>/dev/null || echo '{}')"

EVIDENCE_READY="$(echo "$EVIDENCE_HEALTH_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ready', False))" 2>/dev/null || echo "False")"
if [[ "$EVIDENCE_READY" == "True" ]]; then
    success "evidence-service: ready ($EVIDENCE_HEALTH_JSON)"
else
    die "evidence-service is not ready — aborting capacity check ($EVIDENCE_HEALTH_JSON)"
fi

if oracle_compose exec -T ollama ollama list >/dev/null 2>&1; then
    success "ollama: reachable"
else
    warn "ollama: unreachable"
fi

if docker exec "$(oracle_container_id qdrant)" true >/dev/null 2>&1; then
    success "qdrant: container reachable"
else
    warn "qdrant: container unreachable"
fi

################################################################################
# 2. Host/container resource snapshot — taken once, right before the
#    benchmark, so it reflects the conditions the latency numbers below
#    were actually measured under.
################################################################################

print_section "Resource snapshot (point-in-time, before benchmark)"

LOAD_AVG="$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null || echo "unavailable")"
info "host load average (1m 5m 15m): $LOAD_AVG"

FREE_MEM="$(free -h 2>/dev/null | awk '/^Mem:/ {print "used="$3" free="$4" available="$7}' || echo "unavailable")"
info "host memory: $FREE_MEM"

DISK_FREE="$(df -h / 2>/dev/null | awk 'NR==2 {print $4" free ("$5" used)"}' || echo "unavailable")"
info "host disk (/): $DISK_FREE"

STATS_HEADER="CONTAINER,CPU%,MEM_USAGE"
BACKEND_STATS="$(docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' edumind-oracle-backend-1 2>/dev/null || echo "backend,unavailable,unavailable")"
EVIDENCE_STATS="$(docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' "$EVIDENCE_CONTAINER_ID" 2>/dev/null || echo "evidence-service,unavailable,unavailable")"
OLLAMA_STATS="$(docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' edumind-oracle-ollama-1 2>/dev/null || echo "ollama,unavailable,unavailable")"
info "$STATS_HEADER"
info "$BACKEND_STATS"
info "$EVIDENCE_STATS"
info "$OLLAMA_STATS"

OLLAMA_LOADED="$(oracle_compose exec -T ollama ollama ps 2>/dev/null | tail -n +2 | awk '{print $1}' | paste -sd',' - || echo "unavailable")"
info "ollama loaded models: ${OLLAMA_LOADED:-none}"

################################################################################
# 3. Benchmark — 1x1 / 1x3 / 2x3, synthetic sentences ONLY, run entirely
#    inside the evidence-service container (it has no host-published
#    port — see Milestone 11 §7/§40 — so this reaches it the same way the
#    backend itself would: from inside the internal Docker network).
################################################################################

print_section "Benchmark ($SAMPLES samples per configuration, synthetic sentences only)"

BENCHMARK_JSON="$(docker exec "$EVIDENCE_CONTAINER_ID" python3 -c "
import json, time, urllib.request

SAMPLES = $SAMPLES

# Fixed, synthetic, realistic-LENGTH sentences (~150-250 chars each,
# matching typical retrieved-chunk length) — never derived from any real
# document or chat message.
CLAIM_A = 'The standardized intervention protocol improved measured outcomes relative to the control condition across the evaluation period.'
CLAIM_B = 'The alternative training approach reduced completion time without a corresponding loss in accuracy on the assessment battery.'
SOURCE_1 = ('Results indicated a statistically significant improvement in the treatment group compared to '
            'the control group across the full evaluation period, with consistent effect sizes observed '
            'across each measured subgroup and site.')
SOURCE_2 = ('The study sample included multiple cohorts drawn from geographically distinct sites, with '
            'baseline characteristics balanced between the treatment and control arms prior to the start '
            'of the intervention period.')
SOURCE_3 = ('No statistically significant adverse effects were reported during the monitoring period, and '
            'attrition rates were comparable between groups, suggesting the intervention was well tolerated '
            'by participants throughout the study.')

def call(claim, sources):
    payload = json.dumps({'claim': claim, 'sources': sources}).encode()
    req = urllib.request.Request(
        'http://127.0.0.1:8100/classify_batch', data=payload,
        headers={'content-type': 'application/json'}, method='POST',
    )
    t0 = time.perf_counter()
    try:
        resp = urllib.request.urlopen(req, timeout=10)
        resp.read()
        return (time.perf_counter() - t0) * 1000, None
    except Exception as exc:  # noqa: BLE001 — this is a bounded diagnostic script
        return (time.perf_counter() - t0) * 1000, type(exc).__name__

def percentile(values, pct):
    ordered = sorted(values)
    idx = min(len(ordered) - 1, int(round(pct / 100 * (len(ordered) - 1))))
    return ordered[idx]

def run(label, claim_sources_pairs):
    latencies = []
    timeouts = 0
    for _ in range(SAMPLES):
        total = 0.0
        failed = False
        for claim, sources in claim_sources_pairs:
            ms, err = call(claim, sources)
            total += ms
            if err is not None:
                failed = True
                if err in ('HTTPError', 'URLError', 'TimeoutError'):
                    timeouts += 1
        if not failed:
            latencies.append(total)
    return {
        'label': label,
        'samples_ok': len(latencies),
        'samples_requested': SAMPLES,
        'timeout_or_error_count': timeouts,
        'p50_ms': round(percentile(latencies, 50), 1) if latencies else None,
        'p95_ms': round(percentile(latencies, 95), 1) if latencies else None,
        'min_ms': round(min(latencies), 1) if latencies else None,
        'max_ms': round(max(latencies), 1) if latencies else None,
    }

one_source = [{'source_id': 'S1', 'text': SOURCE_1}]
three_sources = [
    {'source_id': 'S1', 'text': SOURCE_1},
    {'source_id': 'S2', 'text': SOURCE_2},
    {'source_id': 'S3', 'text': SOURCE_3},
]

results = [
    run('1x1', [(CLAIM_A, one_source)]),
    run('1x3', [(CLAIM_A, three_sources)]),
    run('2x3', [(CLAIM_A, three_sources), (CLAIM_B, three_sources)]),
]
print(json.dumps(results))
" 2>/dev/null)"

if [[ -z "$BENCHMARK_JSON" ]]; then
    die "Benchmark failed to produce output — check evidence-service logs."
fi

echo "$BENCHMARK_JSON" | python3 -c "
import sys, json
results = json.load(sys.stdin)
for r in results:
    print(f\"{r['label']:>4}  p50={r['p50_ms']}ms  p95={r['p95_ms']}ms  min={r['min_ms']}ms  max={r['max_ms']}ms  \" +
          f\"ok={r['samples_ok']}/{r['samples_requested']}  timeouts_or_errors={r['timeout_or_error_count']}\")
"

################################################################################
# 4. Optional JSON report
################################################################################

if [[ -n "$JSON_OUT" ]]; then
    # Both $EVIDENCE_HEALTH_JSON and $BENCHMARK_JSON are JSON TEXT (from
    # urllib/json.dumps inside the container), not Python source — passed
    # in via environment variables and re-parsed with json.loads here,
    # never spliced directly into the script body (splicing would treat
    # JSON's true/false/null as undefined Python names).
    EVIDENCE_HEALTH_JSON="$EVIDENCE_HEALTH_JSON" \
    BENCHMARK_JSON="$BENCHMARK_JSON" \
    LOAD_AVG="$LOAD_AVG" \
    TIMESTAMP_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    python3 -c "
import json, os
with open('$JSON_OUT', 'w') as f:
    json.dump({
        'timestamp_utc': os.environ['TIMESTAMP_UTC'],
        'load_average': os.environ['LOAD_AVG'],
        'evidence_health': json.loads(os.environ['EVIDENCE_HEALTH_JSON']),
        'benchmark': json.loads(os.environ['BENCHMARK_JSON']),
    }, f, indent=2)
"
    success "JSON report written to $JSON_OUT"
fi

print_section "Done"
info "This script never modifies configuration and never restarts any service."
info "Recommended: run this at a few different points across a real production day"
info "(e.g. morning / midday / evening) to sample natural traffic contention —"
info "see the Milestone 11.1 report's Sample Schedule Recommendation."
