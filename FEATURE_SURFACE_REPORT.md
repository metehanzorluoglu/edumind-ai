# EduM8 Feature Surface Report

**Generated:** 2026-08-06  
**Scope:** Complete API endpoint inventory, frontend client coverage, and feature gap analysis

---

## 1. API ENDPOINTS (rag-backend/app/api/*.py)

### 1.1 Health & Status

| Method | Path | Purpose | Request | Response |
|--------|------|---------|---------|----------|
| GET | `/health` | Backend process liveness | None | `{ status: "healthy" }` |
| GET | `/health/ready` | Ollama/Qdrant reachability + model availability | None | `ReadinessResponse` (status, ollama_reachable, qdrant_reachable, models_available) |
| GET | `/status` | **Protected.** Corpus stats for dev UI | Bearer token | `StatusResponse` (document_count, chunk_count, document_type_breakdown, last_ingestion_time, etc.) |

### 1.2 Authentication

| Method | Path | Purpose | Request | Response |
|--------|------|---------|---------|----------|
| GET | `/auth/providers` | List configured OAuth providers | None | `{ providers: [{provider, display_name}], dev_login_enabled, local_auth_enabled }` |
| POST | `/auth/register` | Create local email/password account | `{ email, password, display_name? }` | `RegisterResponse` (email_verification_required, tokens if verification disabled) |
| POST | `/auth/login` | Local email/password sign-in | `{ email, password }` | `TokenResponse` (access_token, refresh_token, user) |
| GET | `/auth/verify-email?token=` | Email verification link (redirects to frontend) | Query: `token` | Redirect to `/verify-email?status=success\|invalid\|expired\|already_used` |
| POST | `/auth/resend-verification` | Resend verification email | `{ email }` | `GenericMessageResponse` (always same response, never reveals account existence) |
| GET | `/auth/{provider}/authorize` | Start OAuth flow | Query: `redirect_uri` | Redirect to provider |
| GET | `/auth/{provider}/callback` | OAuth callback | Query: `code`, `state` | Redirect to frontend with `auth_code` |
| POST | `/auth/session/exchange` | Redeem auth_code for tokens | `{ auth_code }` | `TokenResponse` |
| POST | `/auth/refresh` | Refresh access token | `{ refresh_token }` (or HttpOnly cookie) | `TokenResponse` (rotated refresh token) |
| POST | `/auth/logout` | Revoke refresh token session | `{ refresh_token }` (or HttpOnly cookie) | 204 No Content |
| GET | `/auth/me` | **Protected.** Current user profile | Bearer token | `UserResponse` (id, email, display_name, avatar_url, provider) |
| POST | `/auth/dev-login` | **Dev/test only.** Sign in as any email | `{ email, display_name? }` | `TokenResponse` (404 when disabled or production) |

### 1.3 Search (Retrieval Only)

| Method | Path | Purpose | Request | Response |
|--------|------|---------|---------|----------|
| POST | `/search` | Retrieve chunks, no generation | `SearchRequest` (query, top_k?, filters?) | `SearchResponse` (results: `RetrievedChunk[]`) |

### 1.4 Chat (Stateless, Single-Turn)

| Method | Path | Purpose | Request | Response |
|--------|------|---------|---------|----------|
| POST | `/chat` | Stateless RAG chat with SSE streaming | `ChatRequest` (query, top_k?, filters?) | SSE stream: `progress` → `token` → `sources` → `done` (citations, citation_warnings, insufficient_evidence) or `error` |

### 1.5 Documents (Corpus Management)

| Method | Path | Purpose | Request | Response |
|--------|------|---------|---------|----------|
| POST | `/documents` | Upload + async ingest (multipart) | File + metadata (document_type, title?, authors?, publication_year?, source_venue?, doi?, source_url?, journal_quartile?) | `DocumentUploadAcceptedResponse` (job_id) |
| GET | `/documents/jobs/{job_id}` | Poll ingestion progress | Path: `job_id` | `DocumentJobResponse` (status: pending/processing/completed/failed, document?, error?) |
| POST | `/documents/metadata-preview` | Extract metadata without ingesting (multipart) | File | `DocumentMetadataPreviewResponse` (detected title, authors, publication_year, venue, doi, source_url) |
| GET | `/documents` | **Protected.** List user's documents | Query: `limit?`, `offset?` | `DocumentListResponse` (documents: `DocumentSummary[]`, total) |
| DELETE | `/documents/{document_id}` | **Protected.** Delete document + all chunks | Path: `document_id` | `DocumentDeleteResponse` (deleted_document_id, chunks_deleted) |

### 1.6 Conversations (Persistent Chat)

| Method | Path | Purpose | Request | Response |
|--------|------|---------|---------|----------|
| POST | `/conversations` | **Protected.** Create empty conversation | None | `ConversationDetailResponse` (id, title, messages: []) |
| GET | `/conversations` | **Protected.** List conversations (paginated, most recent first) | Query: `limit?`, `offset?` | `ConversationListResponse` (conversations: `ConversationSummaryResponse[]`, total) |
| GET | `/conversations/{conversation_id}` | **Protected.** Full detail with messages + sources | Path: `conversation_id` | `ConversationDetailResponse` (messages with sources, citations) |
| PATCH | `/conversations/{conversation_id}` | **Protected.** Rename conversation | `{ title }` | `ConversationSummaryResponse` |
| DELETE | `/conversations/{conversation_id}` | **Protected.** Hard delete (cascades to messages/sources) | Path: `conversation_id` | 204 No Content |
| GET | `/conversations/{conversation_id}/scope` | **Protected.** Get retrieval scope settings | Path: `conversation_id` | `ConversationScopeResponse` (tier toggles) |
| PATCH | `/conversations/{conversation_id}/scope` | **Protected.** Update retrieval scope | `{ ...tier_toggles }` | `ConversationScopeResponse` |
| POST | `/conversations/{conversation_id}/documents` | **Protected.** Add document to conversation scope | `{ document_id }` | `ConversationDocumentResponse` |
| DELETE | `/conversations/{conversation_id}/documents/{document_id}` | **Protected.** Remove document from conversation scope | Path params | 204 No Content |
| POST | `/conversations/{conversation_id}/messages` | **Protected.** Send message (JSON or multipart with attachments) | `PostConversationMessageRequest` or multipart (query, top_k?, filters?, client_message_id?, use_corpus?, files[], page_ranges?) | SSE stream (same as `/chat`) |
| POST | `/conversations/{conversation_id}/messages/{message_id}/cancel` | **Protected.** Cancel generating message | Path params | 204 No Content |
| GET | `/conversations/{conversation_id}/messages/{message_id}/attachments/{attachment_id}` | **Protected.** Get attachment bytes | Path params | Binary (image/PDF) |
| GET | `/conversations/{conversation_id}/messages/{message_id}/attachments/{attachment_id}/preview` | **Protected.** Get PDF page preview as PNG | Path params, Query: `page` | Binary (PNG) |

### 1.7 Attachments (Generated Images)

| Method | Path | Purpose | Request | Response |
|--------|------|---------|---------|----------|
| POST | `/attachments/{attachment_id}/scope` | **Protected.** Promote attachment to conversation/project scope | `{ scope_type, scope_id }` | `PromotedAttachmentResponse` |
| PATCH | `/attachments/{attachment_id}/project` | **Protected.** Save/unsave attachment to project gallery | `{ project_id }` (null to unsave) | `MessageAttachmentResponse` |

### 1.8 Images (Generation)

| Method | Path | Purpose | Request | Response |
|--------|------|---------|---------|----------|
| POST | `/images/generate` | **Protected.** Generate images via Ollama (SSE streaming) | `GenerateImagesRequest` (conversation_id, prompts[], negative_prompt?, steps?, cfg_scale?, seed?) | SSE stream: `progress` (completed, total) → `done` (message_id, conversation_id, images[]) or `error` |

### 1.9 Projects (Research Workspaces)

| Method | Path | Purpose | Request | Response |
|--------|------|---------|---------|----------|
| POST | `/projects` | **Protected.** Create project | `{ name, description? }` | `ProjectSummaryResponse` |
| GET | `/projects` | **Protected.** List user's projects | Query: `limit?`, `offset?` | `ProjectListResponse` (projects: `ProjectSummaryResponse[]`, total) |
| GET | `/projects/{project_id}` | **Protected.** Get project detail | Path: `project_id` | `ProjectSummaryResponse` |
| PATCH | `/projects/{project_id}` | **Protected.** Update project (partial) | `{ name?, description? }` | `ProjectSummaryResponse` |
| DELETE | `/projects/{project_id}` | **Protected.** Delete project (conversations remain) | Path: `project_id` | 204 No Content |
| GET | `/projects/{project_id}/conversations` | **Protected.** List project's conversations | Query: `limit?`, `offset?` | `ProjectConversationListResponse` |
| POST | `/projects/{project_id}/conversations` | **Protected.** Add conversation to project | `{ conversation_id }` | `ProjectConversationResponse` |
| DELETE | `/projects/{project_id}/conversations/{conversation_id}` | **Protected.** Remove conversation from project | Path params | 204 No Content |
| GET | `/projects/{project_id}/documents` | **Protected.** List project's scoped documents | Query: `limit?`, `offset?` | `ProjectDocumentListResponse` |
| POST | `/projects/{project_id}/documents` | **Protected.** Add document to project scope | `{ document_id }` | `ProjectDocumentResponse` |
| POST | `/projects/{project_id}/documents/upload` | **Protected.** Upload + ingest directly into project | Multipart (file + metadata) | `ProjectDocumentResponse` |
| DELETE | `/projects/{project_id}/documents/{document_id}` | **Protected.** Remove document from project scope | Path params | 204 No Content |
| GET | `/projects/{project_id}/attachments` | **Protected.** List project's saved attachments (images) | Query: `limit?`, `offset?` | `ProjectAttachmentListResponse` |
| DELETE | `/projects/{project_id}/attachments/{message_attachment_id}` | **Protected.** Remove attachment from project | Path params | 204 No Content |
| GET | `/projects/{project_id}/notes` | **Protected.** List project notes | Query: `limit?`, `offset?` | `ProjectNoteListResponse` |
| POST | `/projects/{project_id}/notes` | **Protected.** Add note | `{ content }` | `ProjectNoteResponse` |
| DELETE | `/projects/{project_id}/notes/{note_id}` | **Protected.** Delete note | Path params | 204 No Content |
| GET | `/projects/{project_id}/conversation-summary` | **Protected.** List conversation summaries (draft + approved) | Query: `limit?`, `offset?` | `ProjectConversationSummaryListResponse` |
| POST | `/projects/{project_id}/conversation-summary` | **Protected.** Generate conversation summary draft | `{ conversation_id }` | `ProjectConversationSummaryResponse` |
| PATCH | `/projects/{project_id}/conversation-summary/{item_id}` | **Protected.** Edit/approve conversation summary | `{ title?, summary?, key_findings?, status? }` | `ProjectConversationSummaryResponse` |
| DELETE | `/projects/{project_id}/conversation-summary/{item_id}` | **Protected.** Delete conversation summary | Path params | 204 No Content |
| GET | `/projects/{project_id}/profile` | **Protected.** Get project profile (8 fields) | Path: `project_id` | `ProjectProfileResponse` |
| PATCH | `/projects/{project_id}/profile` | **Protected.** Update project profile (partial) | `{ ...profile_fields }` | `ProjectProfileResponse` |
| GET | `/projects/{project_id}/research-preferences` | **Protected.** List pending research preference suggestions | Query: `limit?`, `offset?` | `ResearchPreferenceListResponse` |
| PATCH | `/projects/{project_id}/research-preferences/{suggestion_id}` | **Protected.** Confirm/reject/suppress suggestion | `{ status }` | `ResearchPreferenceResponse` |
| DELETE | `/projects/{project_id}/research-preferences/{suggestion_id}` | **Protected.** Delete suggestion outright | Path params | 204 No Content |

---

## 2. FRONTEND CLIENT METHODS (EducationAssistantClient.ts)

### 2.1 Health & Status

- **`health()`** → `HealthResponse`
- **`ready()`** → `ReadinessResponse`
- **`status()`** → `StatusResponse` (protected)

### 2.2 Search

- **`search(request: SearchRequest)`** → `SearchResponse`  
  *Retrieval only, no generation, no citations*

### 2.3 Chat (Stateless)

- **`streamChat(request: ChatRequest)`** → `AsyncGenerator<ChatEvent>`  
  *SSE streaming, single-turn, no conversation memory*
- **`chat(request: ChatRequest)`** → `ChatResult`  
  *Buffered wrapper around streamChat()*

### 2.4 Documents

- **`listDocuments(params?: ListDocumentsParams)`** → `DocumentListResponse`  
  *Pagination: `limit`, `offset`*
- **`uploadDocument(file: UploadableFile, metadata: DocumentUploadMetadata)`** → `DocumentUploadResponse`  
  *Polls `/documents/jobs/{job_id}` until complete. Supports `onProgress` callback.*
- **`previewDocumentMetadata(file: UploadableFile)`** → `DocumentMetadataPreviewResponse`  
  *Extraction only, never indexes*
- **`deleteDocument(documentId: string)`** → `DocumentDeleteResponse`

### 2.5 Conversations

- **`createConversation()`** → `ConversationDetail`
- **`listConversations(params?: ListConversationsParams)`** → `ConversationListResponse`  
  *Pagination: `limit`, `offset`*
- **`getConversation(conversationId: string)`** → `ConversationDetail`
- **`renameConversation(conversationId: string, title: string)`** → `ConversationSummary`
- **`deleteConversation(conversationId: string)`** → `void`
- **`streamConversationMessage(conversationId: string, request: PostConversationMessageRequest)`** → `AsyncGenerator<ChatEvent>`  
  *SSE streaming, persists user message + assistant response*
- **`postConversationMessage(conversationId: string, request: PostConversationMessageRequest)`** → `ChatResult`  
  *Buffered wrapper*
- **`sendVisionMessage(conversationId: string, request: SendVisionMessageRequest)`** → `AsyncGenerator<ChatEvent>`  
  *Convenience wrapper for vision-routed messages (attachments required)*
- **`postVisionMessage(conversationId: string, request: SendVisionMessageRequest)`** → `ChatResult`  
  *Buffered wrapper*
- **`cancelMessage(conversationId: string, messageId: string)`** → `void`  
  *Explicit cancel of background generation*
- **`buildAttachmentUrl(conversationId, messageId, attachmentId, page?)`** → `string`  
  *URL construction only, no network I/O*
- **`fetchAttachmentBlob(conversationId, messageId, attachmentId, options?)`** → `Blob`  
  *For web `<img>` via `URL.createObjectURL()`*
- **`getAttachmentImageSource(conversationId, messageId, attachmentId, page?)`** → `{ uri, headers }`  
  *For React Native `<Image source={...}>`*

### 2.6 Projects

- **`createProject(request: CreateProjectRequest)`** → `ProjectSummary`
- **`listProjects(params?: ListProjectsParams)`** → `ProjectListResponse`  
  *Pagination: `limit`, `offset`*
- **`getProject(projectId: string)`** → `ProjectSummary`
- **`updateProject(projectId: string, request: UpdateProjectRequest)`** → `ProjectSummary`  
  *Partial update: omit field to leave unchanged, `description: null` to clear*
- **`deleteProject(projectId: string)`** → `void`
- **`listProjectConversations(projectId: string, params?: ListProjectConversationsParams)`** → `ProjectConversationListResponse`
- **`addProjectConversation(projectId: string, conversationId: string)`** → `ProjectConversation`  
  *Idempotent*
- **`removeProjectConversation(projectId: string, conversationId: string)`** → `void`
- **`saveAttachmentToProject(attachmentId: string, projectId: string | null)`** → `GeneratedImageAttachment`  
  *Save/unsave generated image to project gallery*

### 2.7 Images

- **`streamImageGeneration(request: GenerateImagesRequest)`** → `AsyncGenerator<ImageGenerationEvent>`  
  *SSE streaming, sequential per-image progress. 5-minute timeout.*
- **`generateImages(request: GenerateImagesRequest)`** → `GenerateImagesResponse`  
  *Buffered wrapper*

### 2.8 Auth

- **`getAuthProviders()`** → `AuthProviders`  
  *Normalized: `providers`, `devLoginEnabled`, `localAuthEnabled`*
- **`register(body: RegisterRequestBody)`** → `RegisterResult`  
  *Returns `email_verification_required: true` + null tokens when verification enabled*
- **`login(body: LoginRequestBody)`** → `AuthTokenResponse`
- **`resendVerification(email: string)`** → `GenericMessageResult`
- **`buildOAuthAuthorizeUrl(provider: string, redirectUri: string)`** → `string`  
  *URL construction only*
- **`exchangeAuthCode(authCode: string)`** → `AuthTokenResponse`
- **`refreshSession(refreshToken?: string)`** → `AuthTokenResponse`
- **`logout(refreshToken?: string)`** → `void`
- **`getMe()`** → `AuthUser`
- **`devLogin(email: string, displayName?: string)`** → `AuthTokenResponse`  
  *Dev/test only, 404 in production*

---

## 3. FRONTEND HOOKS (packages/education-assistant-client/src/hooks/*.ts)

### 3.1 `useEducationAssistant`

**Purpose:** Stateless single-turn chat (no conversation persistence)

**Returns:**
- `state: ChatState` — `idle` | `connecting` | `streaming` | `insufficient_evidence` | `done` | `cancelled` | `error`
- `streamingSupported: boolean` — runtime capability check
- `ask(request: ChatRequest)` — send request, supersede in-flight
- `cancel()` — abort in-flight
- `reset()` — return to idle

**Streaming:** Yes (SSE), with buffered fallback  
**Pagination:** N/A (single turn)

### 3.2 `useEducationSearch`

**Purpose:** Retrieval-only search (no generation, no citations)

**Returns:**
- `state: SearchState` — `idle` | `loading` | `success` | `cancelled` | `error`
- `search(request: SearchRequest)` — run search, supersede in-flight
- `cancel()` — abort in-flight
- `reset()` — return to idle

**Pagination:** Via `SearchRequest.top_k` (not offset-based)  
**Streaming:** No

### 3.3 `useEducationDocuments`

**Purpose:** Document CRUD + upload workflow

**Returns:**
- `listState: DocumentsListState` — paginated document list
- `refresh(params?: ListDocumentsParams)` — fetch/re-fetch list
- `cancelList()` — abort list fetch
- `uploadState: UploadState` — `idle` | `uploading` | `processing` (with job progress) | `success` | `cancelled` | `error`
- `upload(file, metadata)` — upload + poll until ingestion complete
- `cancelUpload()` — abort upload
- `resetUpload()` — return to idle
- `previewState: MetadataPreviewState` — metadata extraction preview
- `previewMetadata(file)` — extract metadata without indexing
- `cancelPreview()` — abort preview
- `resetPreview()` — return to idle
- `deleteStates: Record<string, DeleteDocumentState>` — per-document delete tracking
- `deleteDocument(documentId)` — delete with optimistic removal
- `resetDeleteState(documentId)` — clear delete error

**Pagination:** Yes (`limit`, `offset`)  
**Streaming:** No (polling for upload progress)

### 3.4 `useConversations`

**Purpose:** Conversation list sidebar

**Returns:**
- `listState: ConversationsListState` — paginated conversation list
- `refresh(params?: ListConversationsParams)` — fetch/re-fetch list
- `cancelList()` — abort list fetch
- `createConversation()` → `Promise<{ id: string }>` — create + return id (no list refresh)
- `renameConversation(conversationId, title)` → `Promise<ConversationSummary>` — optimistic patch
- `deleteStates: Record<string, DeleteConversationState>` — per-conversation delete tracking
- `deleteConversation(conversationId)` — delete with optimistic removal
- `resetDeleteState(conversationId)` — clear delete error

**Pagination:** Yes (`limit`, `offset`)  
**Streaming:** No

### 3.5 `useConversationMessages`

**Purpose:** Single conversation's message history + streaming new turns

**Returns:**
- `conversation: ConversationDetail | null` — full conversation detail
- `loadState: ConversationLoadState` — `loading` | `success` | `error`
- `messages: DisplayMessage[]` — unified persisted + in-flight messages
- `sendState: SendState` — `idle` | `sending` | `error`
- `sendMessage(request: PostConversationMessageRequest)` — send + stream turn
- `cancelSend()` — abort in-flight send
- `reload()` — re-fetch conversation from backend
- `isResumingGeneration: boolean` — true if any persisted message has status `'generating'`
- `cancelPersistedGeneration(messageId)` — explicit cancel of background worker

**Pagination:** No (loads full history)  
**Streaming:** Yes (SSE for new turns)  
**Special:** Silent polling recovery for dropped connections (re-fetches every 2s while `isResumingGeneration`)

### 3.6 `useProjects`

**Purpose:** Project workspace management

**Returns:**
- `listState: ProjectsListState` — paginated project list
- `refresh(params?: ListProjectsParams)` — fetch/re-fetch list
- `cancelList()` — abort list fetch
- `createProject(request)` → `Promise<ProjectSummary>` — optimistic prepend
- `updateProject(projectId, request)` → `Promise<ProjectSummary>` — optimistic patch
- `deleteStates: Record<string, DeleteProjectState>` — per-project delete tracking
- `deleteProject(projectId)` — delete with optimistic removal
- `resetDeleteState(projectId)` — clear delete error
- `projectConversationsStates: Record<string, ProjectConversationsState>` — per-project conversation list (lazy-loaded)
- `loadProjectConversations(projectId)` — fetch project's conversations
- `addRemoveStates: Record<string, AddRemoveConversationState>` — per-(project, conversation) add/remove tracking
- `addConversationToProject(projectId, conversationId)` → `Promise<void>` — bumps count + reloads if expanded
- `removeConversationFromProject(projectId, conversationId)` → `Promise<void>` — optimistic removal

**Pagination:** Yes for projects (`limit`, `offset`), yes for project conversations  
**Streaming:** No

---

## 4. DOMAIN TYPES (packages/education-assistant-client/src/types/*.ts)

### 4.1 Conversations

- **`ConversationSummary`** — `{ id, title, created_at, updated_at, message_count }`
- **`ConversationDetail`** — `ConversationSummary` + `messages: ConversationMessage[]`
- **`ConversationMessage`** — `{ id, role, content, created_at, sources?, citations?, citation_warnings?, insufficient_evidence?, status?, error_message?, attachments? }`
- **`ConversationMessageSource`** — `{ rank, chunk_id, chunk_index, page_number, score, snippet_text, title?, authors?, publication_year?, source_venue?, document_type, journal_quartile?, doi?, source_url?, source_filename, scope }`
- **`ConversationMessageAttachment`** — `{ id, filename, mime_type, size_bytes, page_count?, source, generation_prompt?, generation_seed? }`
- **`PostConversationMessageRequest`** — `{ query, top_k?, filters?, client_message_id?, attachments?, use_corpus? }`
- **`SendVisionMessageRequest`** — `{ query, images: UploadableFile[], useCorpus?, topK?, filters?, clientMessageId? }`
- **`DisplaySource`** — unified shape for streamed `RetrievedChunk` or persisted `ConversationMessageSource`

### 4.2 Projects

- **`ProjectSummary`** — `{ id, name, description?, created_at, updated_at, conversation_count, document_count, attachment_count }`
- **`ProjectConversation`** — `{ conversation_id, title, added_at }`
- **`CreateProjectRequest`** — `{ name, description? }`
- **`UpdateProjectRequest`** — `{ name?, description? }` (omit to leave unchanged, `null` to clear)

### 4.3 Documents

- **`DocumentSummary`** — `{ document_id, title, authors?, publication_year?, source_venue?, document_type, journal_quartile?, doi?, source_url?, source_filename, chunk_count, created_at }`
- **`DocumentUploadMetadata`** — `{ documentType, journalQuartile?, title?, authors?, publicationYear?, sourceVenue?, doi?, sourceUrl? }`
- **`DocumentUploadResponse`** — `{ document_id, title, authors?, publication_year?, source_venue?, document_type, journal_quartile?, doi?, source_url?, source_filename, chunk_count, created_at }`
- **`DocumentJobResponse`** — `{ job_id, status, document?, error? }`
- **`DocumentMetadataPreviewResponse`** — `{ title?, authors?, publication_year?, source_venue?, doi?, source_url?, extraction_sources? }`
- **`UploadableFile`** — `File | Blob | { uri, name, type }` (React Native compatibility)

### 4.4 Chat & Search

- **`ChatRequest`** — `{ query, top_k?, filters? }`
- **`ChatResult`** — `{ answer, sources, citations, citationWarnings, insufficientEvidence, clientElapsedMs, requestId }`
- **`ChatEvent`** — `progress | token | sources | done | error`
- **`ChatStage`** — `'connected' | 'retrieving' | 'loading_model' | 'processing_context' | 'generating'`
- **`SearchRequest`** — `{ query, top_k?, filters? }`
- **`SearchResponse`** — `{ results: RetrievedChunk[] }`
- **`RetrievedChunk`** — `{ chunk_id, chunk_index, page_number, score, text, title?, authors?, publication_year?, source_venue?, document_type, journal_quartile?, doi?, source_url?, source_filename, document_id?, scope }`
- **`RetrievalFilters`** — `{ document_ids?, document_types?, journal_quartiles?, publication_year_min?, publication_year_max? }`

### 4.5 Citations

- **`Citation`** — `{ source_id, document_id, chunk_id, title?, authors?, publication_year?, source_venue?, document_type, journal_quartile?, page_start?, page_end?, doi?, source_url?, score }`
- **`DocumentType`** — `'journal_article' | 'practitioner_article' | 'policy_document' | 'report' | 'review_article' | 'curriculum_document'`
- **`JournalQuartile`** — `'Q1' | 'Q2' | null`

### 4.6 Images

- **`GenerateImagesRequest`** — `{ conversation_id, prompts[], negative_prompt?, steps?, cfg_scale?, seed? }`
- **`GenerateImagesResponse`** — `{ message_id, conversation_id, images: GeneratedImageAttachment[] }`
- **`ImageGenerationEvent`** — `progress | done | error`
- **`GeneratedImageAttachment`** — same shape as `ConversationMessageAttachment` with `source === "generated"`

### 4.7 Auth

- **`AuthUser`** — `{ id, email, display_name?, avatar_url?, is_dev_test_user, provider? }`
- **`AuthTokenResponse`** — `{ access_token, refresh_token, token_type, expires_in, user }`
- **`RegisterResult`** — `{ email_verification_required, message, access_token?, refresh_token?, token_type, expires_in?, user? }`
- **`AuthProviders`** — `{ providers: AuthProviderInfo[], devLoginEnabled, localAuthEnabled }`
- **`LoginRequestBody`** — `{ email, password }`
- **`RegisterRequestBody`** — `{ email, password, display_name? }`

---

## 5. COMPLETE FEATURE INVENTORY

### 5.1 Conversations CRUD

| Feature | API | Client | Hook | Notes |
|---------|-----|--------|------|-------|
| Create conversation | ✅ POST `/conversations` | ✅ `createConversation()` | ✅ `useConversations` | Returns `{ id }` for immediate navigation |
| List conversations | ✅ GET `/conversations` | ✅ `listConversations()` | ✅ `useConversations` | Paginated (limit/offset), most recent first |
| Get conversation detail | ✅ GET `/conversations/{id}` | ✅ `getConversation()` | ✅ `useConversationMessages` | Full message history + sources |
| Rename conversation | ✅ PATCH `/conversations/{id}` | ✅ `renameConversation()` | ✅ `useConversations` | Optimistic patch, auto-title disabled after rename |
| Delete conversation | ✅ DELETE `/conversations/{id}` | ✅ `deleteConversation()` | ✅ `useConversations` | Hard delete, cascades to messages/sources |
| **Conversation scope settings** | ✅ GET/PATCH `/conversations/{id}/scope` | ❌ | ❌ | **GAP:** Tier toggles exist in API but no client method or hook |
| **Add document to conversation scope** | ✅ POST `/conversations/{id}/documents` | ❌ | ❌ | **GAP:** Chat-scoped retrieval evidence |
| **Remove document from conversation scope** | ✅ DELETE `/conversations/{id}/documents/{doc_id}` | ❌ | ❌ | **GAP:** Remove association only |

### 5.2 Messages & Streaming

| Feature | API | Client | Hook | Notes |
|---------|-----|--------|------|-------|
| Send message (text-only) | ✅ POST `/conversations/{id}/messages` (JSON) | ✅ `streamConversationMessage()` / `postConversationMessage()` | ✅ `useConversationMessages.sendMessage()` | SSE streaming + buffered fallback |
| Send message (with attachments) | ✅ POST `/conversations/{id}/messages` (multipart) | ✅ `sendVisionMessage()` / `postVisionMessage()` | ✅ `useConversationMessages.sendMessage()` | Vision model routing, optional `use_corpus` |
| Cancel message generation | ✅ POST `/conversations/{id}/messages/{id}/cancel` | ✅ `cancelMessage()` | ✅ `useConversationMessages.cancelPersistedGeneration()` | Explicit cancel of background worker |
| Get attachment bytes | ✅ GET `.../attachments/{id}` | ✅ `fetchAttachmentBlob()` / `getAttachmentImageSource()` | ❌ (direct client usage) | For web `<img>` or RN `<Image>` |
| Get PDF page preview | ✅ GET `.../attachments/{id}/preview` | ✅ `fetchAttachmentBlob()` (with `page` param) | ❌ (direct client usage) | Renders PDF page as PNG |
| Idempotency (retry/double-click) | ✅ `client_message_id` field | ✅ Supported | ✅ `useConversationMessages` | Backend deduplicates by idempotency key |
| **Regenerate message** | ❌ | ❌ | ❌ | **NO FEATURE:** No regenerate endpoint exists |
| **Message feedback (thumbs up/down)** | ❌ | ❌ | ❌ | **NO FEATURE:** No feedback mechanism |
| **Edit user message** | ❌ | ❌ | ❌ | **NO FEATURE:** Messages are immutable |
| **Export conversation** | ❌ | ❌ | ❌ | **NO FEATURE:** No export endpoint |

### 5.3 Projects CRUD

| Feature | API | Client | Hook | Notes |
|---------|-----|--------|------|-------|
| Create project | ✅ POST `/projects` | ✅ `createProject()` | ✅ `useProjects` | Optimistic prepend to list |
| List projects | ✅ GET `/projects` | ✅ `listProjects()` | ✅ `useProjects` | Paginated, user-scoped |
| Get project detail | ✅ GET `/projects/{id}` | ✅ `getProject()` | ❌ (direct client usage) | Not in hook, but available |
| Update project | ✅ PATCH `/projects/{id}` | ✅ `updateProject()` | ✅ `useProjects` | Partial update, optimistic patch |
| Delete project | ✅ DELETE `/projects/{id}` | ✅ `deleteProject()` | ✅ `useProjects` | Conversations remain intact |
| List project conversations | ✅ GET `/projects/{id}/conversations` | ✅ `listProjectConversations()` | ✅ `useProjects` | Lazy-loaded per project |
| Add conversation to project | ✅ POST `/projects/{id}/conversations` | ✅ `addProjectConversation()` | ✅ `useProjects` | Idempotent, bumps count |
| Remove conversation from project | ✅ DELETE `/projects/{id}/conversations/{id}` | ✅ `removeProjectConversation()` | ✅ `useProjects` | Optimistic removal |
| **Project documents** | ✅ GET/POST/DELETE `/projects/{id}/documents` | ❌ | ❌ | **GAP:** Project-scoped retrieval evidence |
| **Upload to project** | ✅ POST `/projects/{id}/documents/upload` | ❌ | ❌ | **GAP:** Direct ingest into project |
| **Project attachments (saved images)** | ✅ GET/DELETE `/projects/{id}/attachments` | ❌ (only `saveAttachmentToProject`) | ❌ | **GAP:** List/remove saved images |
| Save attachment to project | ✅ PATCH `/attachments/{id}/project` | ✅ `saveAttachmentToProject()` | ❌ (direct client usage) | Gallery bookmark, not in hook |
| **Project notes** | ✅ GET/POST/DELETE `/projects/{id}/notes` | ❌ | ❌ | **GAP:** Free-form notes feature |
| **Conversation summaries** | ✅ GET/POST/PATCH/DELETE `/projects/{id}/conversation-summary` | ❌ | ❌ | **GAP:** RULES workflow (draft → approve) |
| **Project profile** | ✅ GET/PATCH `/projects/{id}/profile` | ❌ | ❌ | **GAP:** 8-field research profile |
| **Research preferences** | ✅ GET/PATCH/DELETE `/projects/{id}/research-preferences` | ❌ | ❌ | **GAP:** Suggestion confirm/reject/suppress |

### 5.4 Documents CRUD

| Feature | API | Client | Hook | Notes |
|---------|-----|--------|------|-------|
| List documents | ✅ GET `/documents` | ✅ `listDocuments()` | ✅ `useEducationDocuments` | Paginated |
| Upload document | ✅ POST `/documents` + poll `/documents/jobs/{id}` | ✅ `uploadDocument()` | ✅ `useEducationDocuments` | Async ingestion, progress callback |
| Preview metadata | ✅ POST `/documents/metadata-preview` | ✅ `previewDocumentMetadata()` | ✅ `useEducationDocuments` | Extraction only, never indexes |
| Delete document | ✅ DELETE `/documents/{id}` | ✅ `deleteDocument()` | ✅ `useEducationDocuments` | Optimistic removal |
| **Edit document metadata** | ❌ | ❌ | ❌ | **NO FEATURE:** Documents are immutable after upload |
| **Re-ingest document** | ❌ | ❌ | ❌ | **NO FEATURE:** Must delete + re-upload |

### 5.5 Search & Retrieval

| Feature | API | Client | Hook | Notes |
|---------|-----|--------|------|-------|
| Search (retrieval only) | ✅ POST `/search` | ✅ `search()` | ✅ `useEducationSearch` | No generation, no citations |
| Filters | ✅ `RetrievalFilters` (document_ids, document_types, journal_quartiles, year range) | ✅ Supported | ✅ Supported | Passed via `SearchRequest.filters` |
| **Semantic search toggle** | ❌ | ❌ | ❌ | **NO FEATURE:** Single retrieval mode |
| **Hybrid search** | ❌ | ❌ | ❌ | **NO FEATURE:** No keyword+semantic blend |

### 5.6 Chat (Stateless)

| Feature | API | Client | Hook | Notes |
|---------|-----|--------|------|-------|
| Single-turn chat | ✅ POST `/chat` (SSE) | ✅ `streamChat()` / `chat()` | ✅ `useEducationAssistant` | No conversation memory |
| Citations | ✅ `citations` in `done` event | ✅ Supported | ✅ Supported | `[S1]`, `[S2]` markers |
| Citation warnings | ✅ `citation_warnings` in `done` event | ✅ Supported | ✅ Supported | E.g., "low score", "single source" |
| Insufficient evidence | ✅ `insufficient_evidence` flag | ✅ Supported | ✅ Supported | Backend returns fixed message |
| Progress stages | ✅ `progress` events (connected, retrieving, loading_model, etc.) | ✅ Supported | ✅ Supported | Advisory, not literal "what's happening now" |
| **Conversation memory** | ❌ | ❌ | ❌ | **NO FEATURE:** `/chat` is stateless by design |

### 5.7 Image Generation

| Feature | API | Client | Hook | Notes |
|---------|-----|--------|------|-------|
| Generate images | ✅ POST `/images/generate` (SSE) | ✅ `streamImageGeneration()` / `generateImages()` | ❌ (direct client usage) | Sequential per-image progress, 5-min timeout |
| Save to project | ✅ PATCH `/attachments/{id}/project` | ✅ `saveAttachmentToProject()` | ❌ (direct client usage) | Gallery bookmark |
| **Promote to scope** | ✅ POST `/attachments/{id}/scope` | ❌ | ❌ | **GAP:** Make attachment part of conversation/project scope |

### 5.8 Auth

| Feature | API | Client | Hook | Notes |
|---------|-----|--------|------|-------|
| Get auth providers | ✅ GET `/auth/providers` | ✅ `getAuthProviders()` | ❌ (likely in app-level AuthProvider) | Normalized response |
| Register (local) | ✅ POST `/auth/register` | ✅ `register()` | ❌ | Email verification flow |
| Login (local) | ✅ POST `/auth/login` | ✅ `login()` | ❌ | Generic 401 for all failures |
| Resend verification | ✅ POST `/auth/resend-verification` | ✅ `resendVerification()` | ❌ | Never reveals account existence |
| OAuth authorize | ✅ GET `/auth/{provider}/authorize` | ✅ `buildOAuthAuthorizeUrl()` | ❌ | URL construction only |
| OAuth callback | ✅ GET `/auth/{provider}/callback` | ❌ (browser redirect) | ❌ | Redirects to frontend with `auth_code` |
| Exchange auth code | ✅ POST `/auth/session/exchange` | ✅ `exchangeAuthCode()` | ❌ | Redeems code for tokens |
| Refresh token | ✅ POST `/auth/refresh` | ✅ `refreshSession()` | ❌ | Rotates refresh token |
| Logout | ✅ POST `/auth/logout` | ✅ `logout()` | ❌ | Idempotent, revokes session |
| Get current user | ✅ GET `/auth/me` | ✅ `getMe()` | ❌ | Re-validate profile |
| Dev login | ✅ POST `/auth/dev-login` | ✅ `devLogin()` | ❌ | Dev/test only, 404 in production |
| **Magic link / passwordless** | ❌ | ❌ | ❌ | **NO FEATURE:** Email/password or OAuth only |
| **User profile update** | ❌ | ❌ | ❌ | **NO FEATURE:** No PATCH `/auth/me` endpoint |

---

## 6. FEATURE GAPS & UNUSED CAPABILITIES

### 6.1 Backend Features with No Frontend Client Coverage

These API endpoints exist but have no corresponding client method or hook:

1. **Conversation Scope Management**
   - `GET/PATCH /conversations/{id}/scope` — retrieval tier toggles
   - `POST/DELETE /conversations/{id}/documents` — chat-scoped evidence

2. **Project-Scoped Documents**
   - `GET/POST/DELETE /projects/{id}/documents` — project retrieval evidence
   - `POST /projects/{id}/documents/upload` — direct ingest into project

3. **Project Attachments Gallery**
   - `GET /projects/{id}/attachments` — list saved images
   - `DELETE /projects/{id}/attachments/{id}` — remove from gallery
   - `POST /attachments/{id}/scope` — promote attachment to scope

4. **Project Notes**
   - `GET/POST/DELETE /projects/{id}/notes` — free-form research notes

5. **Conversation Summaries (RULES Workflow)**
   - `GET /projects/{id}/conversation-summary` — list drafts + approved
   - `POST /projects/{id}/conversation-summary` — generate draft
   - `PATCH /projects/{id}/conversation-summary/{id}` — edit/approve
   - `DELETE /projects/{id}/conversation-summary/{id}` — delete

6. **Project Profile**
   - `GET/PATCH /projects/{id}/profile` — 8-field research profile

7. **Research Preferences (Intelligent Assistance)**
   - `GET /projects/{id}/research-preferences` — pending suggestions
   - `PATCH /projects/{id}/research-preferences/{id}` — confirm/reject/suppress
   - `DELETE /projects/{id}/research-preferences/{id}` — delete outright

### 6.2 Client Methods with No Obvious Hook Usage

These client methods exist but are not wrapped in a hook (may be used directly in app code):

1. **`getProject(projectId)`** — available in client, not in `useProjects` hook
2. **`saveAttachmentToProject(attachmentId, projectId)`** — available in client, not in `useProjects` hook
3. **`fetchAttachmentBlob()` / `getAttachmentImageSource()`** — attachment fetching, no hook (likely used directly in components)
4. **`status()`** — corpus stats, no hook (likely dev-only UI)
5. **Auth methods** — all auth client methods have no hooks (likely wrapped in app-level `AuthProvider`)

### 6.3 Missing Features (Not in Backend or Frontend)

These features do not exist anywhere in the system:

1. **Message regeneration** — no "regenerate response" endpoint
2. **Message feedback** — no thumbs up/down or rating system
3. **Message editing** — messages are immutable after send
4. **Conversation export** — no export/download endpoint
5. **Document metadata editing** — documents are immutable after upload
6. **Document re-ingestion** — must delete and re-upload
7. **Semantic/hybrid search toggle** — single retrieval mode only
8. **Magic link / passwordless auth** — email/password or OAuth only
9. **User profile updates** — no PATCH `/auth/me` endpoint
10. **Multi-turn conversation memory in `/chat`** — stateless by design (use `/conversations` instead)

---

## 7. AUTHENTICATION FLOW

### 7.1 Local (Email/Password)

1. **Register:** `POST /auth/register` → email sent with verification link
2. **Verify:** User clicks link → `GET /auth/verify-email?token=...` → redirects to frontend `/verify-email?status=success`
3. **Login:** `POST /auth/login` → returns `AuthTokenResponse` (access_token, refresh_token, user)
4. **Refresh:** `POST /auth/refresh` → rotated refresh token
5. **Logout:** `POST /auth/logout` → revokes session

**Edge Cases:**
- If verification disabled by operator: `POST /auth/register` returns tokens immediately
- Unverified account login attempt: 403 with `detail: "email_verification_required"`
- Wrong password / unknown email / OAuth-only account: generic 401 (never reveals which)

### 7.2 OAuth (Google/Facebook/LinkedIn)

1. **Start flow:** `GET /auth/{provider}/authorize?redirect_uri=...` → redirects to provider
2. **Provider callback:** `GET /auth/{provider}/callback?code=...&state=...` → redirects to frontend with `auth_code`
3. **Exchange:** `POST /auth/session/exchange` → `AuthTokenResponse`
4. **Refresh/Logout:** Same as local

### 7.3 Dev/Test Login

- **Dev login:** `POST /auth/dev-login` → sign in as any email without real OAuth
- **Availability:** Only when `AUTH_DEV_LOGIN_ENABLED=true` AND `APP_ENV != "production"`
- **Returns 404** (not 403) when disabled — looks like endpoint doesn't exist

---

## 8. STREAMING & PAGINATION SUPPORT

### 8.1 Streaming

| Feature | Protocol | Client Support | Hook Support |
|---------|----------|----------------|--------------|
| Chat (stateless) | SSE | ✅ `streamChat()` | ✅ `useEducationAssistant` |
| Conversation messages | SSE | ✅ `streamConversationMessage()` | ✅ `useConversationMessages` |
| Image generation | SSE | ✅ `streamImageGeneration()` | ❌ (direct client usage) |
| Document upload | Polling | ✅ `uploadDocument()` (polls job status) | ✅ `useEducationDocuments` |

**Buffered Fallback:** All SSE streams have buffered wrappers (`chat()`, `postConversationMessage()`, `generateImages()`) for runtimes without `ReadableStream` support.

### 8.2 Pagination

| Resource | Method | Params | Notes |
|----------|--------|--------|-------|
| Conversations | GET `/conversations` | `limit`, `offset` | Most recent first |
| Documents | GET `/documents` | `limit`, `offset` | — |
| Projects | GET `/projects` | `limit`, `offset` | — |
| Project conversations | GET `/projects/{id}/conversations` | `limit`, `offset` | — |
| Search results | POST `/search` | `top_k` (in body) | Not offset-based |

**Not Paginated:**
- Conversation messages (full history loaded)
- Project documents (no client method yet)
- Project notes (no client method yet)
- Conversation summaries (no client method yet)

---

## 9. SUMMARY

### 9.1 What the UI Can Legitimately Offer

**Fully Supported (API + Client + Hook):**
- ✅ Conversation CRUD (create, list, get, rename, delete)
- ✅ Message sending with streaming (text + vision/attachments)
- ✅ Message cancellation (explicit + background recovery)
- ✅ Project CRUD (create, list, get, update, delete)
- ✅ Project conversation management (add/remove)
- ✅ Document CRUD (list, upload with progress, preview metadata, delete)
- ✅ Stateless chat with citations + insufficient evidence handling
- ✅ Retrieval-only search with filters
- ✅ Image generation with streaming progress
- ✅ Auth flows (local + OAuth + dev login)

**Partially Supported (API + Client, No Hook):**
- ⚠️ Save/unsave generated images to project gallery
- ⚠️ Attachment fetching (web blob or RN image source)
- ⚠️ Project detail retrieval (getProject)
- ⚠️ Corpus status display (dev-only)

**Not Exposed to Frontend (API Only):**
- ❌ Conversation scope settings (tier toggles)
- ❌ Conversation-scoped documents (chat evidence)
- ❌ Project-scoped documents (project evidence)
- ❌ Project attachments gallery (list/remove)
- ❌ Project notes (free-form)
- ❌ Conversation summaries (RULES workflow)
- ❌ Project profile (8-field research profile)
- ❌ Research preferences (suggestion confirm/reject/suppress)
- ❌ Attachment scope promotion

**Not Implemented Anywhere:**
- ❌ Message regeneration
- ❌ Message feedback (thumbs up/down)
- ❌ Message editing
- ❌ Conversation export
- ❌ Document metadata editing
- ❌ Semantic/hybrid search toggle
- ❌ Magic link / passwordless auth
- ❌ User profile updates

### 9.2 Recommended Next Steps

1. **High Priority (UI-Ready Features):**
   - Add hooks for `saveAttachmentToProject`, `getProject`
   - Expose conversation scope UI (tier toggles)
   - Expose project-scoped documents (add/remove/upload)

2. **Medium Priority (Advanced Features):**
   - Build project notes UI
   - Implement conversation summary workflow (draft → preview → approve)
   - Add project profile editor

3. **Low Priority (Intelligent Assistance):**
   - Research preference suggestion UI (confirm/reject/suppress)

4. **Feature Requests (Requires Backend Work):**
   - Message regeneration
   - Message feedback system
   - Conversation export
   - Document metadata editing
   - User profile updates

---

**End of Report**
