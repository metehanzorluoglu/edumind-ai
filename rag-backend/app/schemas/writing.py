from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.db.models_writing import MAX_MAIN_TEX_CONTENT_CHARS
from app.db.writing_projects_repository import (
    MAX_REFERENCES_PER_PROJECT,
    AddReferenceOutcome,
)
from app.schemas.documents import BibliographicMetadataFields

_MAX_TITLE_CHARS = 200
_MAX_DESCRIPTION_CHARS = 2000

#: Milestone 5 Section 8 — a genuinely blank starting point: no fake
#: authors/affiliations/references (Section 8's explicit "do not include
#: fake authors, affiliations, references, or content"). `{title}` is
#: filled in with the project's own title at creation time.
#:
#: Milestone 5.1 Part 3/20 additions: `inputenc`/`fontenc`/`lmodern` give
#: baseline accented-Latin Unicode support (the compiler service's own
#: chosen pdflatex + utf8 combination — see latex-compiler/Dockerfile's
#: comment on why full multi-script Unicode is explicitly out of scope).
#: `\\bibliographystyle`/`\\bibliography{references}` are included from
#: project creation onward so Part 20's requirement ("the default project
#: must compile successfully... without user editing anything") and Part
#: 21 (inserting a citation and compiling it must resolve, "no fake
#: bibliography required") both hold without this service ever silently
#: rewriting a user's saved main_tex_content to inject them later — an
#: EXISTING project created before this milestone will not have these
#: two lines, and a `\\cite{}` typed into one will show the honest
#: "add \\bibliography{references} to resolve citations" diagnostic
#: (Part 22) rather than a citation silently failing to resolve for an
#: invisible reason.
DEFAULT_MAIN_TEX_TEMPLATE = """\\documentclass{{article}}
\\usepackage[utf8]{{inputenc}}
\\usepackage[T1]{{fontenc}}
\\usepackage{{lmodern}}

\\title{{{title}}}

\\begin{{document}}

\\maketitle

\\section{{Introduction}}

\\bibliographystyle{{plain}}
\\bibliography{{references}}

\\end{{document}}
"""


class WritingProjectSummaryResponse(BaseModel):
    id: str
    title: str
    description: str | None = None
    reference_count: int
    #: Milestone 5.3 Part 26 — total file/folder count in this project's
    #: tree, including the root .tex file (never references.bib, which
    #: is never a real row — see WritingProjectFile's own docstring).
    file_count: int = 0
    archived_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class WritingProjectListResponse(BaseModel):
    projects: list[WritingProjectSummaryResponse]
    total: int


class WritingProjectResponse(BaseModel):
    """The full project, including its LaTeX source — GET/POST/PATCH
    /writing-projects/{id} only (never the list response, see
    WritingProjectsRepository.list_for_user's own docstring)."""

    id: str
    title: str
    description: str | None = None
    main_tex_content: str
    #: Milestone 5.3 Part 15 — the project's current root/main `.tex`
    #: file id. Always populated for any project created or migrated
    #: under this milestone (see WritingProject.root_file_id's own
    #: docstring for the one theoretical transient exception).
    root_file_id: str | None = None
    archived_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class CreateWritingProjectRequest(BaseModel):
    title: str = Field(min_length=1, max_length=_MAX_TITLE_CHARS)
    description: str | None = Field(default=None, max_length=_MAX_DESCRIPTION_CHARS)


class DuplicateWritingProjectRequest(BaseModel):
    """Milestone 5.3 Part 29 — `title` is optional; when omitted the
    duplicate is titled "{original title} (copy)"."""

    title: str | None = Field(default=None, min_length=1, max_length=_MAX_TITLE_CHARS)


class UpdateWritingProjectRequest(BaseModel):
    """Partial update — same "only touch a field actually present"
    convention as UpdateProjectRequest/UpdateDocumentMetadataRequest.
    `title` can never be blanked; `description` can be explicitly
    cleared; `main_tex_content` is what the editor's autosave PATCHes on
    every debounced save (Section 7)."""

    title: str | None = Field(default=None, min_length=1, max_length=_MAX_TITLE_CHARS)
    description: str | None = Field(default=None, max_length=_MAX_DESCRIPTION_CHARS)
    main_tex_content: str | None = Field(default=None, max_length=MAX_MAIN_TEX_CONTENT_CHARS)


class WritingProjectReferenceResponse(BibliographicMetadataFields):
    """One project reference — the document's own CURRENT canonical
    metadata (Section 3), never a copied/frozen snapshot. `cited` reflects
    whether this document's citation_key currently appears anywhere in
    the project's main_tex_content (Section 27), computed fresh on every
    request from app/core/latex_citations.parse_cite_keys — never stored,
    so it can never drift out of sync with the actual manuscript text."""

    document_id: str
    source_filename: str
    added_at: datetime
    cited: bool


class WritingProjectReferencesResponse(BaseModel):
    references: list[WritingProjectReferenceResponse]
    total: int
    #: Citation keys parsed out of main_tex_content that do NOT match any
    #: current reference's citation_key (Section 26) — surfaced here so
    #: the frontend never needs a second parse of the same source text.
    missing_citation_keys: list[str] = Field(default_factory=list)
    #: Milestone 5.1 Part 34/35 — sha256(main_tex_content + references.bib),
    #: computed fresh on every call (app/core/latex_source_hash.py). The
    #: frontend compares this against the `source_hash` returned by its
    #: last successful compile to show "Preview is current" vs "Source
    #: changed since last compile" — piggybacked on this endpoint's
    #: existing "always fresh, refetched after every save" behavior (see
    #: [id].tsx's saveStatus-triggered reload) rather than a new polling
    #: endpoint.
    source_hash: str = ""


class AddWritingProjectReferenceRequest(BaseModel):
    document_ids: list[str] = Field(min_length=1, max_length=MAX_REFERENCES_PER_PROJECT)


class AddWritingProjectReferenceResult(BaseModel):
    document_id: str
    outcome: AddReferenceOutcome


class AddWritingProjectReferencesResponse(BaseModel):
    results: list[AddWritingProjectReferenceResult]


class WritingProjectBibliographyResponse(BaseModel):
    """GET /writing-projects/{id}/bibliography — generated fresh, on
    demand, from the project's current references via the exact same
    Milestone 4.2 BibTeX engine every other BibTeX surface uses (Section
    12: "Do NOT create manually duplicated BibTeX rows in another
    database")."""

    bibtex: str
    reference_count: int


class CompileDiagnosticResponse(BaseModel):
    severity: str
    message: str
    line: int | None = None
    # Milestone 5.5 Part 14 — the erroring file's project-relative path
    # (e.g. "sections/introduction.tex"), passed through verbatim from
    # the compiler service's own Diagnostic.file — see that field's
    # docstring for why it's only ever populated from the reliable
    # -file-line-error log form, never guessed.
    file: str | None = None


class CompileWritingProjectResponse(BaseModel):
    """Milestone 5.1 Part 15 — POST /writing-projects/{id}/compile's
    response. Deliberately never includes container paths, environment
    variables, or a raw stack trace (Part 15) — `log_excerpt` is already
    sanitized by the compiler service (latex-compiler/app/log_sanitizer.py)
    before it ever reaches this backend."""

    status: Literal["success", "error", "timeout", "busy", "unavailable"]
    diagnostics: list[CompileDiagnosticResponse] = Field(default_factory=list)
    log_excerpt: str = ""
    duration_ms: float = 0.0
    page_count: int | None = None
    #: Present only when status == "success" — the frontend fetches the
    #: actual PDF bytes via a SEPARATE
    #: GET /writing-projects/{id}/compile/{compile_id}/pdf call (Part 16:
    #: never base64-embed a PDF in this JSON response).
    compile_id: str | None = None
    pdf_size_bytes: int | None = None
    #: Milestone 5.1 Part 34/35 — the exact source_hash this compile was
    #: run against (app/core/latex_source_hash.py) — lets the frontend
    #: detect staleness without a version-history subsystem.
    source_hash: str = ""
