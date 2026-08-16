export {
  EducationAssistantClient,
  DEFAULT_IMAGE_GENERATION_TIMEOUT_MS,
  DEFAULT_COMPILE_TIMEOUT_MS,
} from './client/EducationAssistantClient';
export type {
  EducationAssistantClientOptions,
  RequestOptions,
} from './client/EducationAssistantClient';

export {
  EducationAssistantError,
  AuthenticationError,
  AuthorizationError,
  ValidationError,
  RateLimitError,
  ConflictError,
  NotFoundError,
  ProviderUnavailableError,
  BackendError,
  NetworkError,
  TimeoutError,
  RequestCancelledError,
  StreamingUnsupportedError,
  MalformedStreamError,
} from './client/errors';

export { hasStreamingCapability } from './client/stream';

export { normalizeBaseUrl, isLocalOrPrivateAddress } from './utils/url';
export type { NormalizedBaseUrl } from './utils/url';

export {
  mapCitationMarkers,
  uniqueCitedSourceIds,
  splitAnswerIntoSegments,
} from './utils/citationParser';
export type { CitationMarkerMatch, AnswerSegment } from './utils/citationParser';

export { mapSourcesToCitations, findMappedSourceById } from './utils/sourceMapping';
export type { MappedSource } from './utils/sourceMapping';

export { useEducationAssistant } from './hooks/useEducationAssistant';
export type { ChatState, UseEducationAssistantResult } from './hooks/useEducationAssistant';

export { useEducationSearch } from './hooks/useEducationSearch';
export type { SearchState, UseEducationSearchResult } from './hooks/useEducationSearch';

export { useEducationDocuments } from './hooks/useEducationDocuments';
export type {
  DocumentsListState,
  MetadataPreviewState,
  UploadState,
  UseEducationDocumentsResult,
} from './hooks/useEducationDocuments';

export { useConversations } from './hooks/useConversations';
export type {
  ConversationsListState,
  DeleteConversationState,
  UseConversationsResult,
} from './hooks/useConversations';

export { useFolderLibrary } from './hooks/useFolderLibrary';
export type { FolderContentsState, UseFolderLibraryResult } from './hooks/useFolderLibrary';

export { useConversationDocuments } from './hooks/useConversationDocuments';
export type {
  ConversationDocumentsState,
  UseConversationDocumentsResult,
} from './hooks/useConversationDocuments';

export { useConversationScope } from './hooks/useConversationScope';
export type {
  ConversationScopeState,
  UseConversationScopeResult,
} from './hooks/useConversationScope';

export { useDocumentContent } from './hooks/useDocumentContent';
export type { DocumentContentState, UseDocumentContentResult } from './hooks/useDocumentContent';

export { useDocumentHighlights } from './hooks/useDocumentHighlights';
export type {
  DocumentHighlightsState,
  UseDocumentHighlightsResult,
} from './hooks/useDocumentHighlights';

export { useNotebooks } from './hooks/useNotebooks';
export type { NotebooksState, UseNotebooksResult } from './hooks/useNotebooks';

export { useNotebookEntries } from './hooks/useNotebookEntries';
export type { NotebookEntriesState, UseNotebookEntriesResult } from './hooks/useNotebookEntries';

export { useProjects } from './hooks/useProjects';
export type {
  AddRemoveConversationState,
  DeleteProjectState,
  ProjectConversationsState,
  ProjectsListState,
  UseProjectsResult,
} from './hooks/useProjects';

export { useWritingProjects } from './hooks/useWritingProjects';
export type {
  DeleteWritingProjectState,
  ProjectActionState,
  UseWritingProjectsResult,
  WritingProjectSort,
  WritingProjectsListState,
} from './hooks/useWritingProjects';

export { useWritingProject, DEFAULT_AUTOSAVE_DELAY_MS } from './hooks/useWritingProject';
export type {
  UseWritingProjectResult,
  WritingProjectBibliographyState,
  WritingProjectCompileState,
  WritingProjectLoadState,
  WritingProjectReferencesState,
  WritingProjectSaveStatus,
} from './hooks/useWritingProject';

export { useWritingProjectFiles } from './hooks/useWritingProjectFiles';
export type {
  ActiveFileLoadState,
  ActiveFileSaveStatus,
  UseWritingProjectFilesResult,
  WritingFileTreeState,
} from './hooks/useWritingProjectFiles';

export { useWritingTemplates } from './hooks/useWritingTemplates';
export type {
  CreateFromTemplateState,
  UseWritingTemplatesResult,
  WritingTemplateDetailState,
  WritingTemplatesListState,
} from './hooks/useWritingTemplates';

export { useWritingProjectImport } from './hooks/useWritingProjectImport';
export type {
  ConfirmWritingProjectImportState,
  UseWritingProjectImportResult,
  WritingProjectImportInspectState,
} from './hooks/useWritingProjectImport';

export {
  useConversationMessages,
  thinkingContextForRequest,
} from './hooks/useConversationMessages';
export type {
  ConversationLoadState,
  DisplayMessage,
  SendState,
  ThinkingContext,
  ThinkingState,
  UseConversationMessagesResult,
} from './hooks/useConversationMessages';

// Ergonomic, hand-aliased or hand-written types. generated.ts (raw OpenAPI
// output) is intentionally never re-exported here — see types/*.ts headers
// and README "Type generation" for why.
export type { DocumentType, JournalQuartile, Citation } from './types/citations';
export type {
  RetrievalFilters,
  RetrievedChunk,
  SearchRequest,
  SearchResponse,
} from './types/search';
export type {
  BibtexExportRequest,
  BibtexExportResponse,
  CitationStyle,
  CreateHighlightRequest,
  DocumentBibtexResponse,
  DocumentCitationResponse,
  DocumentContentChunk,
  DocumentContentResponse,
  DocumentDeleteResponse,
  DocumentEnrichmentResponse,
  DocumentFileRequestInit,
  DocumentHighlight,
  DocumentHighlightListResponse,
  DocumentHighlightVisualAnchor,
  DocumentJobResponse,
  DocumentListResponse,
  DocumentMetadataPreviewResponse,
  DocumentSummary,
  DocumentUploadAcceptedResponse,
  DocumentUploadMetadata,
  DocumentUploadResponse,
  DuplicateDocumentCandidate,
  EnrichmentRunStatus,
  ExtractionSource,
  ListDocumentsParams,
  MoveDocumentRequest,
  UpdateDocumentMetadataRequest,
  UpdateHighlightRequest,
  UploadableFile,
} from './types/documents';
export {
  MAX_NOTEBOOK_AI_ENTRIES,
  type AddHighlightEntryRequest,
  type AddManualEntryRequest,
  type AddNotebookEntryRequest,
  type CreateNotebookRequest,
  type ListNotebookEntriesParams,
  type ListNotebooksParams,
  type Notebook,
  type NotebookEntry,
  type NotebookEntryListResponse,
  type NotebookListResponse,
  type NotebookMembershipResponse,
  type RenameNotebookRequest,
  type UpdateNotebookEntryRequest,
} from './types/notebooks';
export type {
  CreateFolderRequest,
  DeleteFolderParams,
  DeleteFolderResponse,
  FolderBreadcrumb,
  FolderContentsResponse,
  FolderResponse,
  GetFolderContentsParams,
  UpdateFolderRequest,
} from './types/folders';
export type {
  ChatRequest,
  ChatEvent,
  ChatStage,
  ChatProgressEvent,
  ChatTokenEvent,
  ChatSourcesEvent,
  ChatDoneEvent,
  ChatErrorEvent,
  ChatResult,
} from './types/chat';
export type { HealthResponse, ReadinessResponse } from './types/health';
export type { StatusResponse } from './types/status';
export type {
  AuthProviderInfo,
  AuthProviders,
  AuthProvidersResponse,
  AuthTokenResponse,
  AuthUser,
  GenericMessageResult,
  LoginRequestBody,
  RegisterRequestBody,
  RegisterResult,
  ResendVerificationRequestBody,
} from './types/auth';
export {
  displaySourceFromMessageSource,
  displaySourceFromRetrievedChunk,
} from './types/conversations';
export type {
  ConversationDetail,
  ConversationDocument,
  ConversationDocumentListResponse,
  ConversationListResponse,
  ConversationMessage,
  ConversationMessageAttachment,
  ConversationMessageSource,
  ConversationProjectRef,
  ConversationScope,
  ConversationSummary,
  DisplaySource,
  ListConversationsParams,
  MessageAttachmentUpload,
  PostConversationMessageRequest,
  SendVisionMessageRequest,
  UpdateConversationScopeRequest,
} from './types/conversations';
export type {
  CreateProjectRequest,
  ListProjectConversationsParams,
  ListProjectsParams,
  ProjectConversation,
  ProjectConversationListResponse,
  ProjectListResponse,
  ProjectSummary,
  UpdateProjectRequest,
} from './types/projects';
export type {
  AddWritingProjectReferenceOutcome,
  AddWritingProjectReferenceResult,
  AddWritingProjectReferencesResponse,
  CompileDiagnostic,
  CompileStatus,
  CompileWritingProjectResponse,
  CreateWritingProjectFolderRequest,
  CreateWritingProjectRequest,
  CreateWritingProjectTextFileRequest,
  GeneratedFileNode,
  MoveWritingProjectFileRequest,
  RenameWritingProjectFileRequest,
  UpdateWritingProjectFileContentRequest,
  UpdateWritingProjectRequest,
  WritingProject,
  WritingProjectBibliography,
  WritingProjectFileContent,
  WritingProjectFileKind,
  WritingProjectFileMutationResponse,
  WritingProjectFileNode,
  WritingProjectFileTree,
  WritingProjectListResponse,
  WritingProjectReference,
  WritingProjectReferencesResponse,
  WritingProjectSummary,
} from './types/writing';
export type {
  CreateWritingProjectFromTemplateRequest,
  WritingTemplateDetail,
  WritingTemplateFile,
  WritingTemplateListResponse,
  WritingTemplateSummary,
} from './types/writingTemplates';
export type {
  ConfirmWritingProjectImportRequest,
  ImportFilePreview,
  ImportWarning,
  WritingProjectImportInspection,
} from './types/writingImport';
export type {
  GenerateImagesRequest,
  GenerateImagesResponse,
  GeneratedImageAttachment,
  ImageGenerationDoneEvent,
  ImageGenerationErrorEvent,
  ImageGenerationEvent,
  ImageGenerationProgressEvent,
  SaveAttachmentToProjectRequest,
} from './types/images';
