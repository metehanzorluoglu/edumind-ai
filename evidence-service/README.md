# EduM8 Evidence Service

Milestone 11 (Evidence Service & Shadow Infrastructure Implementation).
A stateless, internal-only NLI/entailment classification microservice —
the runtime half of the evidence-analysis architecture designed in
Milestone 10 (`rag-backend`'s Milestone 10 report).

## Purpose

Classifies a (claim, source-text) pair as ENTAILMENT / NEUTRAL /
CONTRADICTION using a pinned RoBERTa-large NLI model. It is the only
thing in this repository that imports `torch`/`transformers` — the main
`rag-backend` image deliberately never does (Milestone 10 §28).

Currently used for **shadow diagnostics only**: `rag-backend`'s
`app/core/evidence_shadow.py` calls it, on a sampled fraction of Zoom-In
chat requests, strictly *after* the user's answer has already streamed
back — never before, never blocking, never able to change what the user
sees. See `EVIDENCE_ANALYSIS_ENABLED` below; as of Milestone 11 this is
**off** in production.

**`zoom_in_enforced` mode is NOT implemented and NOT ready for use.**
Milestone 11 built shadow infrastructure only — pre-generation
enforcement (where an evidence verdict could actually gate or shape an
answer) is explicitly out of scope and was not built. Do not treat the
`zoom_in_enforced` config value as functional; it currently behaves
identically to `off`.

## Architecture

```
rag-backend (backend container)
  -> app/core/evidence_shadow.py (bounded background thread pool)
    -> app/core/evidence_client.py (httpx, fail-safe, no retry)
      -> evidence-service (THIS service, internal Docker network only)
        -> pinned NLI model (torch/transformers, CPU)
```

- No database, no Qdrant, no Ollama connection. Stateless — every
  request is independent.
- One process, one loaded model copy, `--workers 1` (see Dockerfile —
  a second worker would load a second full model copy).
- Bounded concurrency (default: 1 concurrent inference, queue depth 8) —
  see `app/concurrency.py`.
- Never reachable outside the internal Docker network. No host port is
  ever published (see `deploy/oracle/docker-compose.oracle.yml`).

## Model

`ynie/roberta-large-snli_mnli_fever_anli_R1_R2_R3-nli`, pinned at commit
`5b605abab9b75bc87ab66cfc049ef58d9d64b8ed` (see `app/config.py`). MIT
license (verified against the model card and its base model,
`FacebookAI/roberta-large`, also MIT — no additional upstream artifact
restriction found; see the Milestone 10 report §42).

RoBERTa-large, 355M parameters, ~1.35GB on disk / ~1.6GB RSS once loaded
(measured across Milestones 8-10). `id2label` for this specific revision
is `{0: entailment, 1: neutral, 2: contradiction}` — read from the
model's own config at load time, never hardcoded (a different NLI model
can use a different order; see `app/model.py`'s docstring).

## Resource use

- **Memory**: ~1.6GB RSS once loaded (model + tokenizer + runtime). The
  Oracle compose deployment gives it a `mem_limit: 2g` ceiling.
- **CPU**: `cpus: "1.0"` in Oracle compose — matches the service's own
  concurrency=1 design; a single serialized CPU inference doesn't benefit
  from more than about one core.
- **Startup**: model load + tokenizer init + startup sanity check. See
  the Milestone 11 report's "Real-Service Performance" section for the
  measured figure on the actual Oracle host.
- **Steady-state inference**: 1 claim x <=3 sources batched in one model
  call, measured ~0.9s on this hardware class at that batch size
  (Milestone 10's source-limit experiment; see the Milestone 11 report
  for a real-service repeat of that measurement).

## How to enable shadow mode later

Shadow mode is **not enabled by default** after Milestone 11. To turn it
on:

1. Deploy `evidence-service` (see below) and confirm `GET /health`
   reports `"ready": true`.
2. In `deploy/oracle/.env.oracle`, set:
   ```
   EVIDENCE_ANALYSIS_ENABLED=true
   EVIDENCE_ANALYSIS_MODE=shadow
   EVIDENCE_ANALYSIS_SAMPLE_RATE=0.05
   ```
3. Restart the `backend` service (`evidence-service` itself does not
   need restarting — it is already running and was never the thing that
   was off).
4. Observe the `app.evidence_analysis` / `app.evidence_shadow` logger
   output (see `rag-backend/app/core/evidence_observability.py`) for
   `evidence_analysis event=shadow_result ...` lines.

This is a deliberate, reviewed operational decision — not something to
flip as part of a routine deploy. See the Milestone 11 report's
"Recommendation for Shadow Activation" section for whether this is
currently advised.

## How to disable

Set `EVIDENCE_ANALYSIS_ENABLED=false` (or `EVIDENCE_ANALYSIS_MODE=off`)
in `.env.oracle` and restart `backend`. `evidence-service` itself can
keep running — an idle, unsampled service costs nothing beyond its
resident memory. To stop it entirely: `docker compose stop
evidence-service` (backend continues normally — see "Rollback" below).

## Health check

```
GET /health
{"status": "ready", "ready": true, "model_id": "...", "model_revision": "..."}
```

Never includes predictions, claims, or source text — only service/model
identity and readiness. Returns HTTP 200 even when `ready: false` (still
loading) or `status: "error"` (load/sanity-check failed) — readiness is
communicated via the JSON body, not the HTTP status code, so a Docker
healthcheck can distinguish "container up but not ready" from
"container unreachable."

## Model cache

Mount a persistent volume at `/model-cache` (see
`EVIDENCE_SERVICE_HF_HOME`, default `/model-cache`) — without it, the
~1.35GB model re-downloads from Hugging Face on every container restart.
`deploy/oracle/docker-compose.oracle.yml`'s `evidence-model-cache` named
volume does this for the Oracle deployment.

## Reproduction / smoke-test command

Local, without Docker (needs `pip install -e ".[dev]"` inside this
directory first — pulls torch/transformers, ~1.5GB total, CPU-only):

```bash
cd evidence-service
uvicorn app.main:app --host 0.0.0.0 --port 8100
# in another shell:
curl -s http://127.0.0.1:8100/health | python3 -m json.tool
curl -s -X POST http://127.0.0.1:8100/classify_batch \
  -H 'content-type: application/json' \
  -d '{"claim": "The intervention improved performance.", "sources": [{"source_id": "S1", "text": "Results showed a significant improvement in the intervention group."}]}' \
  | python3 -m json.tool
```

Fast, torch-free test suite (mocked model — no download, no real
inference):

```bash
cd evidence-service
python3 -m venv .venv-test && source .venv-test/bin/activate
pip install -q fastapi "uvicorn[standard]" pydantic pydantic-settings pytest pytest-asyncio httpx
python -m pytest tests/ -q
```

## Security

- No host-published port (never `ports:` in compose — only `expose:`).
- No public nginx/gateway route anywhere.
- No authentication on `/classify_batch` — safe only because it is
  never reachable except from the `backend` container on the internal
  Docker network; do not publish this service's port under any
  circumstance without adding authentication first.
- Request bodies are never logged (see `app/main.py` — every log line is
  structural only: status codes, error codes, latency; never claim or
  source text).
