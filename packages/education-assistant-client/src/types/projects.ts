import type { components } from './generated';

export type ProjectSummary = components['schemas']['ProjectSummaryResponse'];
export type ProjectListResponse = components['schemas']['ProjectListResponse'];
export type ProjectConversation = components['schemas']['ProjectConversationResponse'];
export type ProjectConversationListResponse =
  components['schemas']['ProjectConversationListResponse'];

export interface ListProjectsParams {
  limit?: number;
  offset?: number;
}

export interface CreateProjectRequest {
  name: string;
  description?: string | null;
}

/**
 * Partial update — omit a field entirely to leave it unchanged (matches
 * the backend's PATCH /projects/{id}, which only touches a field actually
 * present in the JSON body). Pass `description: null` to explicitly clear
 * it; omitting `description` altogether leaves the existing value alone.
 */
export interface UpdateProjectRequest {
  name?: string;
  description?: string | null;
}

export interface ListProjectConversationsParams {
  limit?: number;
  offset?: number;
}
