import type { components } from './generated';

export type FolderResponse = components['schemas']['FolderResponse'];
export type FolderBreadcrumb = components['schemas']['FolderBreadcrumb'];
export type FolderContentsResponse = components['schemas']['FolderContentsResponse'];
export type DeleteFolderResponse = components['schemas']['DeleteFolderResponse'];

export interface CreateFolderRequest {
  name: string;
  parentId?: string | null;
}

/**
 * Partial update — omit a field entirely to leave it unchanged (matches the
 * backend's PATCH /folders/{id}, which only touches a field actually
 * present in the JSON body — see UpdateFolderRequest's docstring). Pass
 * `parentId: null` to explicitly move the folder to root; omitting
 * `parentId` altogether leaves it where it is. Same convention for `name`.
 */
export interface UpdateFolderRequest {
  name?: string;
  parentId?: string | null;
}

export interface GetFolderContentsParams {
  /** Omit (or null) for root. */
  folderId?: string | null;
  limit?: number;
  offset?: number;
}

export interface DeleteFolderParams {
  /** See DeleteFolderResponse — required to be explicit rather than
   * defaulted true, since it changes whether a non-empty folder's direct
   * contents are moved to root or the delete is refused with 409. */
  moveContentsToRoot?: boolean;
}
