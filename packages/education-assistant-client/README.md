# education-assistant-client

A TypeScript client SDK (with React hooks) for the Education Research RAG
Assistant FastAPI backend (`rag-backend/`). It is a thin, typed transport
layer: it performs **no retrieval, generation, citation validation,
grounding, or "is this evidence sufficient" logic of its own**. Every one of
those decisions is made by the backend; this package only calls the API,
parses the responses, and gives you ergonomic types and React state around
them. Read this file before writing UI code against it, especially the
"Backend contract" and "Streaming support" sections — several backend
behaviors are easy to accidentally misrepresent in a UI if you assume more
than the API actually promises.

## Installation

Not published to a registry. Consumed via a `file:` reference from another
package in this monorepo, e.g.:

```jsonc
// examples/expo-education-assistant/package.json
{
  "dependencies": {
    "education-assistant-client": "file:../../packages/education-assistant-client",
  },
}
```

React (`>=18.0.0`) is an optional peer dependency — only needed if you use
the hooks in `education-assistant-client/hooks`; the client class itself has
no UI framework dependency.

## Quick start

```ts
import { EducationAssistantClient } from 'education-assistant-client';

const client = new EducationAssistantClient({
  baseUrl: 'http://192.168.1.20:8000', // your dev machine's LAN IP — see "Physical device networking"
  getAccessToken: async () => myStoredToken, // called fresh on every request
  timeoutMs: 30_000, // optional, defaults to 30000; see "Timeouts and cancellation"
});

const health = await client.health();
const results = await client.search({ query: 'formative assessment feedback', top_k: 5 });

for await (const event of client.streamChat({
  query: 'What does the corpus say about feedback?',
})) {
  if (event.type === 'token') process.stdout.write(event.content);
}
```

## Auth and secrets

- Every authenticated request sends `Authorization: Bearer <token>`, where
  `<token>` comes from calling `getAccessToken()` fresh each time — prefer
  this over passing a static key, so a token obtained after the client is
  constructed (e.g. typed into a dev Settings screen) is always used.
- `GET /health` and `GET /health/ready` are the only unauthenticated routes;
  every other route requires a valid bearer token.
- The SDK never logs a token, never includes one in a thrown error's
  message, and never includes the `Authorization` header value in any
  diagnostic output.
- **Never put a permanent API key in an `EXPO_PUBLIC_*` environment
  variable or hardcode one in app source.** Anything under `EXPO_PUBLIC_*`
  (or bundled into a JS app in general) ships inside the built app and is
  trivially extractable. The example app has no static-token override at
  all — `getAccessToken()` always returns the real, per-user JWT access
  token issued at sign-in (see `lib/AuthProvider.tsx`), refreshed
  automatically; there is nothing to hardcode or paste in.
- `normalizeBaseUrl()` (exported) rejects non-`http(s)` schemes and returns
  a `warning` string when a base URL uses plain `http://` against something
  that isn't a recognized localhost/private-LAN address (see
  `isLocalOrPrivateAddress`, also exported) — surface that warning in dev
  tooling rather than silently swallowing it. Prefer HTTPS for anything
  that isn't local dev.

## Type generation

`src/types/generated.ts` is produced by `openapi-typescript` against the
_live_ backend's `/openapi.json`:

```bash
EAC_BACKEND_URL=http://localhost:8000 npm run generate:api
```

The script fails loudly (non-zero exit, file left untouched) if the backend
is unreachable or doesn't return a valid schema — it never silently leaves
a stale file in place.

`generated.ts` is never imported outside `src/types/*.ts`; every other file
uses the hand-aliased, ergonomic types re-exported from `src/index.ts`
(`RetrievedChunk`, `SearchResponse`, `DocumentSummary`, etc.).

**`POST /chat` cannot be described by OpenAPI at all** — it's a
Server-Sent-Events endpoint, and FastAPI's generated schema for it is
literally `{}`. `src/types/chat.ts` (`ChatEvent`, `ChatTokenEvent`,
`ChatSourcesEvent`, `ChatDoneEvent`, `ChatErrorEvent`) and
`src/types/citations.ts` (`Citation`) are therefore hand-written to mirror
`app/schemas/chat.py` and `app/core/citation.py` field-for-field. If those
Python files change, update these two files by hand — codegen can't help.

## Backend contract (read this before building UI)

- **Chat is single-turn.** `POST /chat` has no server-side conversation
  memory — each call is entirely independent of any previous call. Do not
  build UI that implies the assistant "remembers" earlier turns (e.g. don't
  send prior Q&A pairs expecting them to be used as context beyond however
  you construct the `query` string yourself).
- **`insufficient_evidence` is a mechanical fact, not a semantic
  judgment.** It is `true` if and only if zero chunks survived retrieval +
  context preparation for that query — in which case the LLM is never
  called at all. It does not mean "no relevant knowledge exists anywhere",
  only "retrieval returned nothing usable for this query with the given
  filters". Even in this case the backend still sends a real, fixed
  explanatory answer as an ordinary `token` event (currently _"The corpus
  does not contain enough evidence to answer this question."_) before the
  `done` event — the SDK surfaces that text via `ChatResult.answer` /
  the `useEducationAssistant` hook's `insufficient_evidence` state exactly
  as received; it is backend-authored, not synthesized client-side.
- **`insufficient_evidence === false` does not mean "well supported".**
  There is no relevance-score threshold anywhere in this system. Retrieval
  always returns its top-`k` nearest neighbors regardless of how relevant
  they actually are; "insufficient evidence" only ever means _zero_
  results, never "results, but weak ones". Do not build UI copy that
  implies a confidence level the backend does not compute. Do not treat a
  low `RetrievedChunk.score` / `Citation.score` as "irrelevant" — the
  backend does not classify scores that way, and this SDK does not invent
  such a classification either.
- **Retrieval limits, MMR diversity, and deduplication are backend
  constants** (see `rag-backend/app/core/rag_service.py`,
  `context_preparation.py`). The SDK does not expose knobs for them beyond
  the `top_k` and `filters` the API itself accepts.
- `RetrievalFilters` values (document type, journal quartile, etc.) come
  from the backend's real enum values (`src/types/citations.ts`
  `DocumentType`/`JournalQuartile`) — never invent a filter option the
  backend schema doesn't define.

## Citations

`build_citations` (backend) assigns deterministic `S1`, `S2`, ... ids in
retrieval-rank order; `[S<n>]` markers in an answer reference those ids.
This SDK never re-derives or re-validates that assignment — it only:

- **Locates** `[S<n>]` markers in answer text (`mapCitationMarkers`,
  `splitAnswerIntoSegments` in `src/utils/citationParser.ts`), mirroring
  the backend's own `[S(\d+)]` pattern exactly so marker detection here
  never disagrees with what the backend itself recognizes as a citation
  token. A marker whose id isn't in the provided `citations` list maps to
  `citation: null` — a display fact ("no card to show"), never a fabricated
  citation.
- **Joins** the `sources` SSE event's full `RetrievedChunk[]` with the
  `done` event's `Citation[]` on `(document_id, chunk_id)`
  (`mapSourcesToCitations` in `src/utils/sourceMapping.ts`), since the two
  events carry complementary fields (chunk text/score vs. the `S#` label).
- **Surfaces** the backend's own `citation_warnings` (from the `done`
  event — currently: unknown cited ids, malformed `[...]` syntax) as-is,
  labeled distinctly from anything the SDK itself detects. A
  `citation_warnings` entry is never treated as proof the answer is wrong,
  and the SDK never issues a second, competing validity judgment against
  the backend's own citation validation.

## Streaming support

`client.streamChat()` performs true incremental delivery via
`fetch()` + `response.body.getReader()`. This requires a runtime with a
real, non-buffering `ReadableStream` response body.

**Why this matters on React Native:** Hermes has historically lacked
`ReadableStream` support on `fetch` entirely; RN 0.74+ / Expo SDK 51+
improved this, but behavior is still inconsistent across Hermes versions —
some report the API as present but still buffer the whole response before
exposing any chunk, which would silently defeat the point of "streaming".
Native `EventSource` is not available in React Native at all, which is why
this SDK implements its own spec-compliant SSE line parser
(`src/client/stream.ts`) over `fetch` rather than depending on
`EventSource` or an unmaintained polyfill.

Given that inconsistency, `streamChat()` does real capability detection —
both a synchronous `ReadableStream`/`fetch` presence check and a check that
the actual `Response` returned a usable `body` — and throws
`StreamingUnsupportedError` rather than silently falling back to fake,
non-incremental "streaming" dressed up to look real. **It never pretends
streaming works when it does not.**

`client.chat()` is the documented fallback: it reads the entire SSE
response via `response.text()` (which needs nothing beyond `fetch` itself —
no `ReadableStream` at all) and parses every event out of it at once,
returning one final `ChatResult`. It works in every runtime `fetch` works
in, at the cost of no token-by-token delivery. `useEducationAssistant`
already does this fallback automatically: if `streamChat()` throws
`StreamingUnsupportedError`, the hook transparently retries with `chat()`
and goes straight from `'connecting'` to a terminal state (no `'streaming'`
state instances occur in that case — which is honest, since no incremental
data actually existed). Check the hook's `streamingSupported` flag if your
UI wants to show a diagnostic about which mode is active.

This SDK's own live smoke test (`scripts/live-smoke-test.ts`) confirmed
real incremental delivery works against Node's native `fetch` +
`ReadableStream`; verify on your actual target device/Expo Go version too,
since this is exactly the kind of behavior that's inconsistent across
Hermes releases.

## Timeouts and cancellation

- `timeoutMs` (constructor option, default `30000`) bounds **connection
  establishment only** — the time until the backend's response headers
  arrive. It does **not** bound how long an already-started chat generation
  takes to finish streaming or how long a buffered `chat()` call takes to
  read the full body: an LLM response can legitimately take far longer to
  complete than a reasonable "is the backend even responding" deadline.
  Once headers arrive, the deadline is cleared and only explicit
  cancellation can still abort the request.
- Every client method accepts `{ signal?: AbortSignal }` for cancellation.
  An aborted signal produces `RequestCancelledError`; an expired connection
  deadline produces `TimeoutError` — these are distinct error classes so
  callers can tell "the user cancelled" apart from "the backend never
  responded".
- No method in this SDK ever automatically reconnects a dropped or
  cancelled stream.

## Errors

Every thrown error extends `EducationAssistantError` (so
`catch (e) { if (e instanceof EducationAssistantError) ... }` works as a
catch-all), with these subclasses for branching on specifics:

| Class                       | When                                                                      |
| --------------------------- | ------------------------------------------------------------------------- |
| `AuthenticationError`       | HTTP 401 — missing/invalid API key                                        |
| `AuthorizationError`        | HTTP 403                                                                  |
| `ValidationError`           | HTTP 422 — carries the backend's raw validation `details`                 |
| `RateLimitError`            | HTTP 429                                                                  |
| `ConflictError`             | HTTP 409 — e.g. duplicate document upload                                 |
| `NotFoundError`             | HTTP 404                                                                  |
| `ProviderUnavailableError`  | HTTP 502 — Ollama/embedding/LLM provider down                             |
| `BackendError`              | HTTP 500, any other backend error status, or an `error` SSE event         |
| `NetworkError`              | `fetch()` itself threw (DNS, offline, connection refused, ...)            |
| `TimeoutError`              | Connection-establishment deadline elapsed                                 |
| `RequestCancelledError`     | An `AbortSignal` fired (explicit cancel, or unmount)                      |
| `StreamingUnsupportedError` | This runtime can't deliver `/chat` incrementally                          |
| `MalformedStreamError`      | An SSE event's data payload was invalid JSON or missing an expected field |

Every error carries `requestId` (from an `x-request-id`/`x-correlation-id`
response header, when the backend sends one) and `statusCode` where
applicable. Error messages only ever surface the backend's own `detail`
string (truncated defensively), never a raw response body, traceback, or
HTML error page.

## React hooks

All three hooks are UI-library-independent (plain React state) and
race/cancellation/unmount-safe: a stale response from a superseded call, or
one that resolves after unmount, is discarded rather than corrupting
current state; an in-flight request is aborted automatically on unmount.

- **`useEducationAssistant(client)`** — one chat turn at a time, no
  implied conversation memory. `state.status` is one of seven distinct
  values (`idle`, `connecting`, `streaming`, `insufficient_evidence`,
  `done`, `cancelled`, `error`) — deliberately not collapsed into a generic
  "error" bucket, since a network failure, a backend `error` event, an
  unsupported runtime, and "no evidence found" all warrant different UI.
- **`useEducationSearch(client)`** — `idle` / `loading` / `success` /
  `cancelled` / `error`. Retrieval only — no generation, no citations, no
  "insufficient evidence" concept (that's `/chat`-only).
- **`useEducationDocuments(client)`** — independent list (`listState`) and
  upload (`uploadState`) state machines. `upload()`'s `uploading` state
  covers the whole synchronous ingestion pipeline (parse → chunk → embed →
  index) — `POST /documents` has no background job queue, so there is no
  separate queued/processing state to fake. `upload()` does not
  automatically refresh the list; call `refresh()` afterward if the UI
  should reflect the new document.

## Testing

```bash
npm test          # offline, fully mocked — no live backend/Ollama/Qdrant required
npm run smoke:live  # optional: exercises a real running backend
```

`smoke:live` needs `EAC_BACKEND_URL` and `EAC_API_KEY` (see
`.env.example`). It deliberately never calls `uploadDocument()` — the
backend has no `DELETE /documents/{id}` endpoint, so anything it uploaded
would be permanent. It only exercises `listDocuments()` (read-only) for
the "document listing" part of its checklist; `uploadDocument()`'s
correctness is covered by the offline suite instead.

## Physical device networking

See [`docs/PHYSICAL_DEVICE_NETWORKING.md`](./docs/PHYSICAL_DEVICE_NETWORKING.md)
for running the backend so a phone on the same Wi-Fi as your dev machine
can reach it.

## Local development

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint .
npm run format:check
npm test
npm run build        # tsc -p tsconfig.build.json -> dist/
```

## Non-goals (this package / this milestone)

No cloud deployment, no app-store submission, no user accounts, no
conversation memory, no fine-tuning, no relevance-threshold tuning, no
citation rewriting, no background ingestion queue. These are explicitly out
of scope; see the Milestone 7 completion report for the full list.
