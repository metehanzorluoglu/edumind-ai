#!/usr/bin/env tsx
/**
 * Regenerates src/types/generated.ts from the *live* backend's OpenAPI
 * schema. Fails loudly (non-zero exit, no file written) if the backend
 * isn't reachable or the schema can't be fetched — this script must never
 * silently leave a stale generated.ts in place without saying so.
 *
 * Usage:
 *   EAC_BACKEND_URL=http://localhost:8000 npm run generate:api
 *   (defaults to http://localhost:8000 if EAC_BACKEND_URL is unset)
 *
 * Known limitation (documented, not a bug): the backend's POST /chat
 * endpoint streams Server-Sent Events and has no OpenAPI response schema
 * at all (FastAPI/OpenAPI cannot describe a text/event-stream body) — its
 * "200" schema in the live spec is literally `{}`. The SSE event shapes
 * (ChatTokenEvent / ChatSourcesEvent / ChatDoneEvent / ChatErrorEvent) and
 * Citation are therefore hand-written in src/types/chat.ts and
 * src/types/citations.ts, kept in sync with app/schemas/chat.py and
 * app/core/citation.py by hand — codegen cannot help there.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const backendUrl = (process.env.EAC_BACKEND_URL ?? 'http://localhost:8000').replace(/\/+$/, '');
const outputPath = join(__dirname, '..', 'src', 'types', 'generated.ts');

async function main(): Promise<void> {
  const schemaUrl = `${backendUrl}/openapi.json`;
  console.log(`Fetching OpenAPI schema from ${schemaUrl} ...`);

  let response: Response;
  try {
    response = await fetch(schemaUrl, { signal: AbortSignal.timeout(5000) });
  } catch (cause) {
    fail(
      `Could not reach the backend at ${backendUrl}.\n` +
        `Start it first, e.g.:\n` +
        `  cd rag-backend && uvicorn app.main:app --host 127.0.0.1 --port 8000\n` +
        `Underlying error: ${describeError(cause)}`
    );
  }

  if (!response.ok) {
    fail(
      `Backend responded with HTTP ${response.status} ${response.statusText} for ${schemaUrl}. ` +
        `Expected a 200 with the OpenAPI schema.`
    );
  }

  const schemaText = await response.text();
  let schema: unknown;
  try {
    schema = JSON.parse(schemaText);
  } catch (cause) {
    fail(`Backend response was not valid JSON: ${describeError(cause)}`);
  }
  if (typeof schema !== 'object' || schema === null || !('paths' in schema)) {
    fail('Backend response did not look like an OpenAPI schema (no "paths" key found).');
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'eac-openapi-'));
  const tmpSchemaPath = join(tmpDir, 'openapi.json');
  writeFileSync(tmpSchemaPath, schemaText, 'utf-8');

  try {
    console.log(`Generating ${outputPath} ...`);
    execFileSync('npx', ['openapi-typescript', tmpSchemaPath, '-o', outputPath], {
      stdio: 'inherit',
    });
  } catch (cause) {
    fail(`openapi-typescript failed: ${describeError(cause)}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  if (!existsSync(outputPath)) {
    fail('openapi-typescript reported success but generated.ts was not written.');
  }

  console.log(`Done. ${outputPath} regenerated from the live backend schema.`);
  console.log(
    'Reminder: /chat has no OpenAPI response schema (SSE). Update src/types/chat.ts and ' +
      'src/types/citations.ts by hand if app/schemas/chat.py or app/core/citation.py changed.'
  );
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function fail(message: string): never {
  console.error(
    `\n✗ generate:api failed — src/types/generated.ts was NOT modified.\n\n${message}\n`
  );
  process.exit(1);
}

main().catch((cause) => fail(describeError(cause)));
