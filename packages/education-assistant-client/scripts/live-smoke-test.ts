#!/usr/bin/env tsx
/**
 * Optional live integration check against a *running* rag-backend — not
 * part of `npm test` (which is fully offline/mocked). Exercises the SDK
 * against real HTTP/SSE traffic: health, readiness, search, streaming
 * chat, insufficient_evidence, citation-marker mapping, document listing,
 * and corpus status.
 *
 * Deliberately does NOT call uploadDocument(): the backend has no DELETE
 * /documents/{id} endpoint (see app/api/routes_documents.py — only GET and
 * POST exist), so anything this script uploaded would be permanent. The
 * milestone's live-smoke checklist asks for "document listing", not
 * "document upload" — listDocuments() is read-only and leaves no trace,
 * which is what makes this script safe to run repeatedly against a real
 * corpus. uploadDocument()'s correctness is already covered by the offline
 * suite (tests/EducationAssistantClient.test.ts).
 *
 * Usage:
 *   EAC_BACKEND_URL=http://localhost:8000 EAC_API_KEY=... npm run smoke:live
 */
import { EducationAssistantClient, mapCitationMarkers, uniqueCitedSourceIds } from '../src/index';
import type { ChatEvent } from '../src/index';

const backendUrl = (process.env.EAC_BACKEND_URL ?? 'http://localhost:8000').replace(/\/+$/, '');
const apiKey = process.env.EAC_API_KEY;

if (!apiKey) {
  console.error(
    '\n✗ smoke:live failed — EAC_API_KEY is not set.\n' +
      "Set it to a real key from the backend's own .env (see rag-backend/.env / app/config.py).\n" +
      'Copy .env.example to .env in this package to configure it locally.\n'
  );
  process.exit(1);
}

interface StepResult {
  name: string;
  outcome: 'pass' | 'fail' | 'skip';
  detail: string;
}

const results: StepResult[] = [];

function describeError(cause: unknown): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
}

async function step(name: string, fn: () => Promise<string | { skip: string }>): Promise<void> {
  process.stdout.write(`→ ${name} ... `);
  try {
    const outcome = await fn();
    if (typeof outcome === 'object') {
      console.log(`SKIP (${outcome.skip})`);
      results.push({ name, outcome: 'skip', detail: outcome.skip });
      return;
    }
    console.log(`PASS — ${outcome}`);
    results.push({ name, outcome: 'pass', detail: outcome });
  } catch (cause) {
    const detail = describeError(cause);
    console.log(`FAIL — ${detail}`);
    results.push({ name, outcome: 'fail', detail });
  }
}

async function main(): Promise<void> {
  const client = new EducationAssistantClient({
    baseUrl: backendUrl,
    getAccessToken: async () => apiKey ?? null,
    timeoutMs: 30_000,
  });

  console.log(`Running live smoke test against ${backendUrl}\n`);

  await step('health() — GET /health (unauthenticated)', async () => {
    const health = await client.health();
    return `status=${health.status} app_env=${health.app_env} version=${health.version}`;
  });

  let ready = false;
  await step('ready() — GET /health/ready (unauthenticated)', async () => {
    const readiness = await client.ready();
    ready = readiness.status === 'ready';
    return (
      `status=${readiness.status} ollama_reachable=${readiness.ollama_reachable} ` +
      `qdrant_reachable=${readiness.qdrant_reachable} models=${JSON.stringify(readiness.models_available)}`
    );
  });
  if (!ready) {
    console.log(
      '  (backend reports not fully ready — later steps that need Ollama/Qdrant may fail; this is informational, not a smoke-test bug)'
    );
  }

  await step('search() — POST /search', async () => {
    const response = await client.search({ query: 'formative assessment feedback', top_k: 5 });
    return `${response.results.length} result(s)`;
  });

  const chatEvents: ChatEvent[] = [];
  let chatAnswer = '';
  let chatCitations: { source_id: string }[] = [];
  await step('streamChat() — POST /chat (incremental SSE)', async () => {
    let tokenCount = 0;
    for await (const event of client.streamChat({
      query: 'What does the corpus say about formative feedback?',
      top_k: 5,
    })) {
      chatEvents.push(event);
      if (event.type === 'token') {
        tokenCount += 1;
        chatAnswer += event.content;
      }
      if (event.type === 'done') chatCitations = event.citations;
    }
    if (!chatEvents.some((e) => e.type === 'done')) {
      throw new Error('stream ended without a "done" event');
    }
    return `${tokenCount} token event(s), ${chatEvents.length} total event(s)`;
  });

  await step('insufficient_evidence field is present and self-consistent', async () => {
    const doneEvent = chatEvents.find((e) => e.type === 'done');
    if (!doneEvent || doneEvent.type !== 'done')
      return { skip: 'no done event from the previous step' };
    if (doneEvent.insufficient_evidence && doneEvent.citations.length > 0) {
      throw new Error('backend reported insufficient_evidence=true but still returned citations');
    }
    return (
      `insufficient_evidence=${doneEvent.insufficient_evidence} ` +
      `(this reports whatever the live corpus actually produced — it is not forced either way)`
    );
  });

  await step('citation marker mapping against the real answer', async () => {
    if (!chatAnswer) return { skip: 'no answer text from the previous step' };
    const matches = mapCitationMarkers(chatAnswer, chatCitations as never);
    const unresolved = matches.filter((m) => m.citation === null);
    if (unresolved.length > 0) {
      throw new Error(
        `${unresolved.length} citation marker(s) in the answer had no matching backend citation: ` +
          unresolved.map((m) => m.sourceId).join(', ')
      );
    }
    return `${matches.length} marker(s), ${uniqueCitedSourceIds(matches).length} unique source(s), all resolved`;
  });

  await step('listDocuments() — GET /documents (read-only, no cleanup needed)', async () => {
    const response = await client.listDocuments({ limit: 5 });
    const sample = response.documents.map((d) => d.source_filename).join(', ');
    return `total=${response.total}, showing ${response.documents.length}${sample ? ` [${sample}]` : ''}`;
  });

  await step('status() — GET /status (read-only, protected)', async () => {
    const status = await client.status();
    return (
      `document_count=${status.document_count} chunk_count=${status.chunk_count} ` +
      `ollama_reachable=${status.ollama_reachable} qdrant_reachable=${status.qdrant_reachable} ` +
      `relevance_threshold_enabled=${status.relevance_threshold_enabled}`
    );
  });

  console.log('\nSummary:');
  for (const result of results) {
    const marker = result.outcome === 'pass' ? '✓' : result.outcome === 'skip' ? '○' : '✗';
    console.log(`  ${marker} ${result.name}`);
  }

  const failed = results.filter((r) => r.outcome === 'fail');
  if (failed.length > 0) {
    console.log(`\n${failed.length} step(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll steps passed (or were skipped with a stated reason).');
}

main().catch((cause) => {
  console.error(`\n✗ smoke:live crashed unexpectedly: ${describeError(cause)}\n`);
  process.exit(1);
});
