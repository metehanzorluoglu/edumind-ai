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

  // Frontend/Platform Milestone 3.2.2 Part C — an attachment-kind citation
  // (source_kind: 'attachment') has no chunk_id-addressable backing chunk
  // by design (see app/core/citation.build_attachment_citations on the
  // backend) — it must never be joined into a fabricated MappedSource
  // here. ConversationTurnCard reads attachment citations straight off
  // the `citations` list instead (see its own citedAttachmentCitations),
  // never through this chunk-join path.
  it('never fabricates a mapped source for an attachment-kind citation (no chunk to join)', () => {
    const chunk = makeChunk('doc-a', 'chunk-a');
    const documentCitation = makeCitation('S1', 'doc-a', 'chunk-a');
    const attachmentCitation: Citation = {
      source_id: 'S2',
      source_kind: 'attachment',
      document_id: null,
      chunk_id: null,
      attachment_id: 'att-1',
      display_name: 'notes.pdf',
      title: null,
      authors: [],
      publication_year: null,
      source_venue: null,
      document_type: null,
      journal_quartile: null,
      page_start: null,
      page_end: null,
      doi: null,
      source_url: null,
      score: null,
    };

    const mapped = mapSourcesToCitations([chunk], [documentCitation, attachmentCitation]);

    expect(mapped.map((m) => m.sourceId)).toEqual(['S1']);
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
