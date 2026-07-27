import type { Citation } from '../types/citations';
import type { RetrievedChunk } from '../types/search';

export interface MappedSource {
  /** e.g. "S1" — as assigned by the backend, in retrieval-rank order. */
  sourceId: string;
  chunk: RetrievedChunk;
  citation: Citation;
}

function citationSortKey(sourceId: string): number {
  return Number(sourceId.slice(1));
}

/**
 * Joins the `sources` SSE event's RetrievedChunk[] (full chunk text/score,
 * arrives first) with the `done` event's Citation[] (source_id labels,
 * arrives last) on (document_id, chunk_id) — the only fields both events
 * share. This is a join over two backend-provided lists, not a
 * recomputation of the S1/S2 assignment itself, which only ever happens
 * server-side in app/core/citation.py.
 *
 * A chunk with no matching citation (possible only if the backend's two
 * events ever disagree) is silently omitted rather than assigned a
 * fabricated id.
 */
export function mapSourcesToCitations(
  sources: readonly RetrievedChunk[],
  citations: readonly Citation[]
): MappedSource[] {
  const citationByKey = new Map(
    citations.map((citation) => [`${citation.document_id}::${citation.chunk_id}`, citation])
  );

  const mapped: MappedSource[] = [];
  for (const chunk of sources) {
    const citation = citationByKey.get(`${chunk.document_id}::${chunk.chunk_id}`);
    if (citation) mapped.push({ sourceId: citation.source_id, chunk, citation });
  }

  // Sort by the citation's own source_id rather than the sources-event's
  // arrival order: source_id order IS retrieval-rank order (see
  // build_citations in citation.py), the authoritative ordering.
  return mapped.sort((a, b) => citationSortKey(a.sourceId) - citationSortKey(b.sourceId));
}

export function findMappedSourceById(
  mapped: readonly MappedSource[],
  sourceId: string
): MappedSource | null {
  return mapped.find((entry) => entry.sourceId === sourceId) ?? null;
}
