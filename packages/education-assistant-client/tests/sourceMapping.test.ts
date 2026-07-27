import { describe, expect, it } from 'vitest';
import { findMappedSourceById, mapSourcesToCitations } from '../src/utils/sourceMapping';
import type { Citation } from '../src/types/citations';
import type { RetrievedChunk } from '../src/types/search';

function makeChunk(documentId: string, chunkId: string): RetrievedChunk {
  return {
    score: 0.8,
    text: 'excerpt',
    document_id: documentId,
    chunk_id: chunkId,
    document_type: 'journal_article',
    journal_quartile: null,
    title: null,
    authors: [],
    publication_year: null,
    source_venue: null,
    doi: null,
    source_url: null,
    source_filename: 'file.pdf',
    chunk_index: 0,
    page_number: 1,
    scope: 'general',
  };
}

function makeCitation(sourceId: string, documentId: string, chunkId: string): Citation {
  return {
    source_id: sourceId,
    document_id: documentId,
    chunk_id: chunkId,
    title: null,
    authors: [],
    publication_year: null,
    source_venue: null,
    document_type: 'journal_article',
    journal_quartile: null,
    page_start: 1,
    page_end: 1,
    doi: null,
    source_url: null,
    score: 0.8,
  };
}

describe('mapSourcesToCitations', () => {
  it('joins chunks and citations on (document_id, chunk_id) and orders by source_id', () => {
    const chunkA = makeChunk('doc-a', 'chunk-a');
    const chunkB = makeChunk('doc-b', 'chunk-b');
    // sources event order is B, A — mapping must re-order to citation (S-id) order, not preserve arrival order
    const citationA = makeCitation('S1', 'doc-a', 'chunk-a');
    const citationB = makeCitation('S2', 'doc-b', 'chunk-b');

    const mapped = mapSourcesToCitations([chunkB, chunkA], [citationA, citationB]);

    expect(mapped.map((m) => m.sourceId)).toEqual(['S1', 'S2']);
    expect(mapped[0]!.chunk).toBe(chunkA);
    expect(mapped[1]!.chunk).toBe(chunkB);
  });

  it('omits a chunk with no matching citation rather than inventing one', () => {
    const chunk = makeChunk('doc-a', 'chunk-a');
    const mapped = mapSourcesToCitations([chunk], []);
    expect(mapped).toEqual([]);
  });
});

describe('findMappedSourceById', () => {
  it('finds the entry with a matching source id', () => {
    const chunk = makeChunk('doc-a', 'chunk-a');
    const citation = makeCitation('S1', 'doc-a', 'chunk-a');
    const mapped = mapSourcesToCitations([chunk], [citation]);
    expect(findMappedSourceById(mapped, 'S1')?.chunk).toBe(chunk);
  });

  it('returns null for an id with no entry', () => {
    expect(findMappedSourceById([], 'S1')).toBeNull();
  });
});
