"""Covers app/core/prompt_builder.py — both prompt variants ("current",
unchanged, and "compact", added by the Oracle CPU-host prompt-prefill
investigation) and their shared source/project-context formatting.
"""

from app.core.prompt_builder import build_chat_prompt
from app.core.retrieval_schemas import RetrievedChunk


def _chunk(text: str = "Some evidence.", **overrides) -> RetrievedChunk:
    defaults = {
        "score": 0.9,
        "text": text,
        "document_id": "doc-1",
        "chunk_id": "chunk-1",
        "document_type": "journal_article",
        "source_filename": "doc.pdf",
        "chunk_index": 0,
        "page_number": 1,
    }
    defaults.update(overrides)
    return RetrievedChunk(**defaults)


class TestCurrentVariant:
    def test_is_the_default_and_unchanged_from_before_the_variant_parameter_existed(self) -> None:
        system_prompt, _ = build_chat_prompt("query", [_chunk()])
        assert system_prompt.startswith("You are a research assistant that answers questions")
        assert "Project context rule:" in system_prompt

    def test_always_includes_the_project_context_rule_paragraph_even_without_project_context(
        self,
    ) -> None:
        system_prompt, _ = build_chat_prompt("query", [_chunk()], project_context=None)
        assert "Project context rule:" in system_prompt

    def test_question_is_the_last_thing_in_the_user_prompt(self) -> None:
        _, user_prompt = build_chat_prompt("What is X?", [_chunk()])
        assert user_prompt.endswith("Question: What is X?")


class TestCompactVariant:
    def test_is_meaningfully_shorter_than_current_when_no_project_context(self) -> None:
        current_system, _ = build_chat_prompt("q", [_chunk()], prompt_variant="current")
        compact_system, _ = build_chat_prompt("q", [_chunk()], prompt_variant="compact")
        assert len(compact_system) < len(current_system) * 0.6

    def test_omits_the_project_context_rule_when_no_project_context_is_given(self) -> None:
        system_prompt, _ = build_chat_prompt(
            "q", [_chunk()], project_context=None, prompt_variant="compact"
        )
        assert "Project context" not in system_prompt

    def test_includes_a_project_context_rule_when_project_context_is_given(self) -> None:
        system_prompt, _ = build_chat_prompt(
            "q", [_chunk()], project_context="Some approved notes.", prompt_variant="compact"
        )
        assert "Project context" in system_prompt
        assert "never a citable source" in system_prompt

    def test_preserves_every_rule_category_the_current_variant_has(self) -> None:
        # Not a byte-for-byte match (that's the whole point of "compact"),
        # but every substantive rule category from the audit must still be
        # present in some form — grounded-only answers, citation format,
        # insufficient-evidence honesty, source-type weighting, disagreement
        # handling, correlation-vs-causation, concise output, and the
        # prompt-injection defense.
        system_prompt, _ = build_chat_prompt("q", [_chunk()], prompt_variant="compact")
        assert "no outside knowledge" in system_prompt
        assert "lack enough evidence" in system_prompt
        assert "[S1], [S2]" in system_prompt
        assert "Q1 journal article" in system_prompt
        assert "disagreement" in system_prompt.lower()
        assert "causation" in system_prompt
        assert "concisely" in system_prompt
        assert "not instructions" in system_prompt

    def test_user_prompt_shape_is_identical_to_current_variant(self) -> None:
        # prompt_variant only changes the system prompt — the user prompt
        # (sources + question) must be byte-for-byte the same either way.
        _, current_user = build_chat_prompt("What is X?", [_chunk()], prompt_variant="current")
        _, compact_user = build_chat_prompt("What is X?", [_chunk()], prompt_variant="compact")
        assert current_user == compact_user


class TestNoSourcesMessage:
    def test_current_variant_no_sources(self) -> None:
        _, user_prompt = build_chat_prompt("q", [])
        assert "No sources were found in the corpus for this query." in user_prompt

    def test_compact_variant_no_sources(self) -> None:
        _, user_prompt = build_chat_prompt("q", [], prompt_variant="compact")
        assert "No sources were found in the corpus for this query." in user_prompt


class TestSourceFormatting:
    def test_sources_are_numbered_starting_at_one_regardless_of_variant(self) -> None:
        chunks = [_chunk(text="first"), _chunk(text="second", chunk_id="chunk-2")]
        _, user_prompt = build_chat_prompt("q", chunks, prompt_variant="compact")
        assert '<source id="S1">' in user_prompt
        assert '<source id="S2">' in user_prompt


class TestCrossSourceCorroborationRules:
    """Covers the fix for a live-validation finding: given three chunks
    all drawn from the same document, the model claimed "the other
    sources also support this" — treating multiple chunks of one
    document, and a reference cited inside one chunk's own text, as
    independent corroborating sources. Reproduced identically under both
    top_k=3 and the original top_k=8, so this was never a compact-prompt
    regression — a pre-existing gap fixed the same way in both system
    prompt variants, reinforced by a per-request <source_coverage> note
    in the user prompt (see app/core/prompt_builder.py's
    _source_coverage_note)."""

    def test_three_chunks_from_one_document_are_reported_as_one_source(self) -> None:
        chunks = [
            _chunk(text="a", document_id="doc-1", chunk_id="c1"),
            _chunk(text="b", document_id="doc-1", chunk_id="c2"),
            _chunk(text="c", document_id="doc-1", chunk_id="c3"),
        ]
        _, user_prompt = build_chat_prompt("q", chunks)
        assert "<source_coverage>" in user_prompt
        assert "S1->Doc-A, S2->Doc-A, S3->Doc-A" in user_prompt
        assert "SAME single document" in user_prompt
        assert "2 distinct documents" not in user_prompt

    def test_prohibits_other_sources_phrasing_when_only_one_document(self) -> None:
        chunks = [_chunk(document_id="doc-1", chunk_id=f"c{i}") for i in range(3)]
        _, user_prompt = build_chat_prompt("q", chunks)
        assert 'must NOT say or imply that "other sources"' in user_prompt

    def test_allows_multiple_passages_phrasing_when_only_one_document(self) -> None:
        chunks = [_chunk(document_id="doc-1", chunk_id=f"c{i}") for i in range(3)]
        _, user_prompt = build_chat_prompt("q", chunks)
        assert '"multiple passages from this source indicate..."' in user_prompt

    def test_two_chunks_one_document_plus_one_chunk_second_document(self) -> None:
        chunks = [
            _chunk(text="a", document_id="doc-1", chunk_id="c1"),
            _chunk(text="b", document_id="doc-1", chunk_id="c2"),
            _chunk(text="c", document_id="doc-2", chunk_id="c3"),
        ]
        _, user_prompt = build_chat_prompt("q", chunks)
        assert "S1->Doc-A, S2->Doc-A, S3->Doc-B" in user_prompt
        assert "2 distinct documents" in user_prompt

    def test_correct_cross_source_synthesis_allowed_with_two_distinct_documents(self) -> None:
        chunks = [
            _chunk(document_id="doc-1", chunk_id="c1"),
            _chunk(document_id="doc-2", chunk_id="c2"),
        ]
        _, user_prompt = build_chat_prompt("q", chunks)
        assert "Only claim cross-source corroboration" in user_prompt
        assert "at least two different documents" in user_prompt
        # The one-document prohibition text must not leak into the
        # two-document case.
        assert "must NOT say or imply" not in user_prompt

    def test_insufficient_evidence_for_comparison_noted_when_one_document(self) -> None:
        chunks = [_chunk(document_id="doc-1", chunk_id=f"c{i}") for i in range(2)]
        _, user_prompt = build_chat_prompt("Compare source A and source B", chunks)
        assert "cross-source comparison, say the evidence is insufficient" in user_prompt

    def test_coverage_note_never_exposes_the_raw_document_id(self) -> None:
        chunks = [
            _chunk(document_id="doc-super-secret-uuid-1234", chunk_id="c1"),
            _chunk(document_id="doc-super-secret-uuid-5678", chunk_id="c2"),
        ]
        _, user_prompt = build_chat_prompt("q", chunks)
        assert "doc-super-secret-uuid-1234" not in user_prompt
        assert "doc-super-secret-uuid-5678" not in user_prompt
        assert "Doc-A" in user_prompt
        assert "Doc-B" in user_prompt

    def test_coverage_note_omitted_when_no_sources(self) -> None:
        _, user_prompt = build_chat_prompt("q", [])
        assert "<source_coverage>" not in user_prompt

    def test_coverage_note_appears_before_the_question(self) -> None:
        chunks = [_chunk(document_id="doc-1")]
        _, user_prompt = build_chat_prompt("What is X?", chunks)
        coverage_index = user_prompt.index("<source_coverage>")
        question_index = user_prompt.index("Question: What is X?")
        assert coverage_index < question_index

    def test_coverage_note_identical_across_prompt_variants(self) -> None:
        chunks = [
            _chunk(document_id="doc-1", chunk_id="c1"),
            _chunk(document_id="doc-2", chunk_id="c2"),
        ]
        _, current_user = build_chat_prompt("q", chunks, prompt_variant="current")
        _, compact_user = build_chat_prompt("q", chunks, prompt_variant="compact")
        assert current_user == compact_user

    def test_system_prompt_current_variant_has_source_identity_rules(self) -> None:
        system_prompt, _ = build_chat_prompt("q", [_chunk()], prompt_variant="current")
        assert "still only ONE source" in system_prompt
        assert "not something you have independently retrieved or verified" in system_prompt
        assert "insufficient for a cross-source comparison" in system_prompt

    def test_system_prompt_compact_variant_has_source_identity_rules(self) -> None:
        system_prompt, _ = build_chat_prompt("q", [_chunk()], prompt_variant="compact")
        assert "still ONE source" in system_prompt
        assert "not something you independently retrieved" in system_prompt
        assert "insufficient for a cross-source comparison" in system_prompt

    def test_in_text_reference_inside_a_chunk_is_not_a_separate_source(self) -> None:
        # The exact failure mode observed: a passage's own text cites
        # "Druga et al. (2021)" and the model treated that in-text
        # reference as an independently retrieved corroborating source.
        chunks = [
            _chunk(
                text="As Druga et al. (2021) found, families engage actively with AI agents.",
                document_id="doc-1",
            )
        ]
        system_prompt, user_prompt = build_chat_prompt("q", chunks)
        assert "reference or citation mentioned inside a retrieved passage" in system_prompt
        assert "SAME single document" in user_prompt  # only one real source here


class TestInstructionalDesignAddendum:
    """Covers the lesson-design mode addendum (QA follow-up: the previous
    compact research-summary prompt produced an incomplete lesson outline
    for an instructional-design request). General intent detection (see
    app/core/intent_detection.py), not a lookup of any specific exact
    prompt — these tests deliberately use several different phrasings."""

    def test_addendum_appears_for_an_instructional_design_request_compact_variant(self) -> None:
        system_prompt, _ = build_chat_prompt(
            "Design a lesson flow about machine learning for 6th graders.",
            [_chunk()],
            prompt_variant="compact",
        )
        assert "Instructional-design mode:" in system_prompt
        assert "engineering-design cycle" in system_prompt

    def test_addendum_appears_for_an_instructional_design_request_current_variant(self) -> None:
        system_prompt, _ = build_chat_prompt(
            "Create a learning sequence where students investigate a real-world problem.",
            [_chunk()],
            prompt_variant="current",
        )
        assert "Instructional-design mode:" in system_prompt

    def test_addendum_absent_for_an_ordinary_research_question(self) -> None:
        system_prompt, _ = build_chat_prompt(
            "What does the literature say about lesson study in Japan?",
            [_chunk()],
            prompt_variant="compact",
        )
        assert "Instructional-design mode:" not in system_prompt

    def test_addendum_still_requires_citations_for_source_backed_claims(self) -> None:
        """The addendum must never relax the base grounding/citation
        rules — only add structure for the design-shaped parts of the
        answer."""
        system_prompt, _ = build_chat_prompt(
            "Design a curriculum unit on AI ethics.", [_chunk()], prompt_variant="compact"
        )
        addendum_start = system_prompt.index("Instructional-design mode:")
        addendum = system_prompt[addendum_start:]
        assert "must never carry a citation" in addendum  # design choices: no citation
        assert "still needs its [S#] citation" in addendum  # source claims: citation required
        assert "Cite inline" in system_prompt[:addendum_start]  # base citation rule untouched
