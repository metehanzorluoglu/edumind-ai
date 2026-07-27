import type { components } from './generated';

/**
 * Ergonomic, flat aliases over the generated OpenAPI schema types, so the
 * rest of the SDK and any consuming UI code never has to reach into
 * generated.ts's `components["schemas"][...]` paths directly. Field names
 * are kept exactly as the backend returns them (snake_case) — see
 * README.md "Naming conventions" for why no camelCase transform is applied.
 */
export type RetrievalFilters = components['schemas']['RetrievalFilters'];
export type RetrievedChunk = components['schemas']['RetrievedChunk'];
export type SearchRequest = components['schemas']['SearchRequest'];
export type SearchResponse = components['schemas']['SearchResponse'];
