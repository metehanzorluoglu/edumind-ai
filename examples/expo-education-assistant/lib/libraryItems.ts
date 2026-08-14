import type { DocumentSummary, FolderResponse } from 'education-assistant-client';
import { DOCUMENT_TYPE_LABELS } from '@/lib/enums';
import { fileExtension } from '@/lib/documentUpload';
import { safeText } from '@/lib/format';

/**
 * Frontend Milestone 1 (Finder-style Document Library): a single value both
 * the grid and list views, selection, sorting, and drag-and-drop can all
 * operate on uniformly, instead of every one of those concerns re-deriving
 * "is this a folder or a document" from two differently-shaped API types.
 * Purely a presentation-layer union — `data` is always the exact
 * FolderResponse/DocumentSummary returned by useFolderLibrary, never a
 * reshaped copy, so nothing here can drift from what the backend actually
 * sent.
 */
export type LibraryItem =
  { kind: 'folder'; data: FolderResponse } | { kind: 'document'; data: DocumentSummary };

export function toFolderItems(folders: readonly FolderResponse[]): LibraryItem[] {
  return folders.map((data) => ({ kind: 'folder', data }) as const);
}

export function toDocumentItems(documents: readonly DocumentSummary[]): LibraryItem[] {
  return documents.map((data) => ({ kind: 'document', data }) as const);
}

/** Stable identity for selection/drag/React keys — folder.id and
 * document.document_id live in different namespaces (separate DB tables),
 * so no prefix is needed to keep them from colliding in a Set<string>. */
export function libraryItemId(item: LibraryItem): string {
  return item.kind === 'folder' ? item.data.id : item.data.document_id;
}

export function libraryItemName(item: LibraryItem): string {
  return item.kind === 'folder'
    ? safeText(item.data.name, 'Untitled folder')
    : safeText(item.data.title, item.data.source_filename);
}

/** ISO date this item was last meaningfully changed — folder.updated_at
 * (renamed/moved) or document.ingested_at (documents have no separate
 * "modified" timestamp from the API; upload time is the closest available
 * value and is never re-invented here). */
export function libraryItemDate(item: LibraryItem): string {
  return item.kind === 'folder' ? item.data.updated_at : item.data.ingested_at;
}

/** Short type label for the list view's Type column / a grid card's
 * secondary line. Folders show "Folder"; documents show their file
 * extension when known (PDF/DOCX/TXT/…), falling back to the backend's
 * document_type label (journal article, report, …) when the filename has
 * none — still real, never invented, data. */
export function libraryItemTypeLabel(item: LibraryItem): string {
  if (item.kind === 'folder') return 'Folder';
  const ext = fileExtension(item.data.source_filename).replace(/^\./, '').toUpperCase();
  if (ext) return ext;
  return DOCUMENT_TYPE_LABELS[item.data.document_type];
}

export type LibrarySortKey = 'name' | 'modified' | 'size' | 'type';
export type LibrarySortDirection = 'asc' | 'desc';

const SORT_LABELS: Record<LibrarySortKey, string> = {
  name: 'Name',
  modified: 'Date modified',
  size: 'Size',
  type: 'Type',
};

export const LIBRARY_SORT_KEYS: LibrarySortKey[] = ['name', 'modified', 'size', 'type'];

export function librarySortLabel(key: LibrarySortKey): string {
  return SORT_LABELS[key];
}

function compareByKey(a: LibraryItem, b: LibraryItem, key: LibrarySortKey): number {
  switch (key) {
    case 'name':
      return libraryItemName(a).localeCompare(libraryItemName(b), undefined, {
        sensitivity: 'base',
      });
    case 'modified':
      return new Date(libraryItemDate(a)).getTime() - new Date(libraryItemDate(b)).getTime();
    case 'type':
      return libraryItemTypeLabel(a).localeCompare(libraryItemTypeLabel(b), undefined, {
        sensitivity: 'base',
      });
    case 'size':
      // Frontend Milestone 1: DocumentSummary (GET /folders/contents, GET
      // /documents) never carries a file size — only the transient
      // upload-time responses do (DocumentUploadResponse /
      // DocumentMetadataPreviewResponse), and folders have no size at all.
      // Rather than invent a proxy (e.g. chunk_count), "Size" sorts fall
      // back to name so the control is still stable and usable instead of
      // silently doing nothing — see the milestone report's Limitations
      // section for why the Size column itself shows "—".
      return libraryItemName(a).localeCompare(libraryItemName(b), undefined, {
        sensitivity: 'base',
      });
    default:
      return 0;
  }
}

/**
 * Sorts folders and documents as two separate groups (folders always
 * first, matching Explorer/Finder/Drive's own convention) rather than one
 * interleaved list — keeps the "folders are containers, documents are
 * leaves" mental model intact regardless of sort key/direction, and means
 * a "Size"/"Type" sort never scatters folders unpredictably among files
 * they have nothing in common with.
 */
export function sortLibraryContents(
  folders: readonly FolderResponse[],
  documents: readonly DocumentSummary[],
  key: LibrarySortKey,
  direction: LibrarySortDirection
): { folders: FolderResponse[]; documents: DocumentSummary[] } {
  const sign = direction === 'asc' ? 1 : -1;
  const sortedFolders = toFolderItems(folders)
    .slice()
    .sort((a, b) => sign * compareByKey(a, b, key))
    .map((item) => item.data as FolderResponse);
  const sortedDocuments = toDocumentItems(documents)
    .slice()
    .sort((a, b) => sign * compareByKey(a, b, key))
    .map((item) => item.data as DocumentSummary);
  return { folders: sortedFolders, documents: sortedDocuments };
}

/** "Aug 9, 2026" — short, locale-aware, used by the list view's Date
 * modified column and the details panel. */
export function formatLibraryDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return safeText(null);
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
