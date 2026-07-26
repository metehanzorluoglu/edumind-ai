"""Intelligent research assistance — Observe -> Suggest -> User approves ->
Save preference, and never any other way (see
app/db/models_research_preferences.py). This module is the "Observe" step
only: a small, fixed, inspectable whitelist of neutral research-methodology
terms (never a general NLP/LLM classifier, and never touching anything
about the researcher personally) matched against a Project Memory item's
own already-approved text fields — the deliberate design that keeps this
feature from ever becoming a hidden user profile.
"""

from app.db.project_knowledge_repository import ProjectKnowledgeRecord

# Canonical lowercase phrase -> (the ProjectProfile field it would
# populate, its properly-cased display form). Deliberately a closed,
# hand-picked list of research-methodology practices (coding approaches,
# analysis techniques, citation styles, output preferences) — never
# anything that could describe the researcher as a person (no
# demographic, behavioral, or identity terms of any kind). Two phrases
# intentionally share a display form ("codebook"/"codebooks",
# "tables"/"table format") so near-duplicate suggestions never appear.
_VOCABULARY: dict[str, tuple[str, str]] = {
    "thematic analysis": ("methodology", "Thematic analysis"),
    "deductive coding": ("methodology", "Deductive coding"),
    "inductive coding": ("methodology", "Inductive coding"),
    "grounded theory": ("methodology", "Grounded theory"),
    "cross-case analysis": ("methodology", "Cross-case analysis"),
    "content analysis": ("methodology", "Content analysis"),
    "codebook": ("analysis", "Codebook"),
    "codebooks": ("analysis", "Codebook"),
    "tables": ("output_format", "Tables"),
    "table format": ("output_format", "Tables"),
    "apa": ("citation_style", "APA"),
    "mla": ("citation_style", "MLA"),
    "chicago": ("citation_style", "Chicago"),
    "harvard": ("citation_style", "Harvard"),
    "grounded citations": ("citation_style", "Grounded citations"),
}


def observe_approved_item(item: ProjectKnowledgeRecord) -> list[tuple[str, str]]:
    """Every distinct (field, display_value) vocabulary match found in this
    already-approved item's own fields — a plain case-insensitive
    substring search, no fuzzy matching or inference. Only ever called on
    an item whose status is already "approved" (see
    app/api/routes_projects.py::update_conversation_summary) — this
    function itself does not check status, since by the time a
    ProjectKnowledgeRecord exists here it has already been through the
    user-approval step Project Memory requires."""
    haystack = " ".join(
        [
            item.methodology,
            " ".join(item.frameworks),
            " ".join(item.analysis_techniques),
            " ".join(item.keywords),
            " ".join(item.decisions),
        ]
    ).lower()

    matches: set[tuple[str, str]] = set()
    for phrase, (field, display_value) in _VOCABULARY.items():
        if phrase in haystack:
            matches.add((field, display_value))
    return sorted(matches)
