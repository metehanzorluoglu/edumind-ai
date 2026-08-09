"""Milestone 7 (Evidence Verifier Optimization & Readiness Gate) — unit
tests for scripts/optimize_evidence_verifier.py's non-network pieces:
the structured-output parser, prompt construction, verdict-schema
constants, benchmark metric computation, and dev/holdout split
determinism. No test here calls a real Ollama endpoint (that only happens
via manual `python scripts/optimize_evidence_verifier.py` invocations,
same convention as scripts/prototype_evidence_verifier.py's own tests)."""

from __future__ import annotations

from evaluation.controlled_corpus import EvalCase
from evaluation.verifier_eval_subset import reviewed_eval_cases
from scripts.optimize_evidence_verifier import (
    PROMPT_V0,
    PROMPT_V1,
    PROMPT_V2,
    PROMPT_VARIANTS,
    SCHEMA_A_MINIMAL,
    SCHEMA_B_WITH_SOURCES,
    SCHEMAS,
    VERDICTS,
    CaseOutcome,
    RawCallStats,
    VerifierConfig,
    _binary_safety,
    _build_user_prompt,
    _confusion_matrix,
    _dangerous_errors,
    _per_class_prf,
    build_variant_report,
    parse_verdict_response,
    split_dev_holdout,
)


class TestParseVerdictResponse:
    def test_valid_minimal_json_parses(self) -> None:
        verdict, supporting, contradicting, ok = parse_verdict_response('{"verdict": "SUFFICIENT"}')
        assert ok is True
        assert verdict == "SUFFICIENT"
        assert supporting == []
        assert contradicting == []

    def test_valid_full_schema_parses(self) -> None:
        raw = (
            '{"verdict": "CONTRADICTORY", "supporting_source_ids": ["S1"], '
            '"contradicting_source_ids": ["S2", "S3"]}'
        )
        verdict, supporting, contradicting, ok = parse_verdict_response(raw)
        assert ok is True
        assert verdict == "CONTRADICTORY"
        assert supporting == ["S1"]
        assert contradicting == ["S2", "S3"]

    def test_malformed_json_fails_closed(self) -> None:
        verdict, supporting, contradicting, ok = parse_verdict_response("not json at all")
        assert ok is False
        assert verdict is None
        assert supporting == []
        assert contradicting == []

    def test_unknown_verdict_fails_closed(self) -> None:
        verdict, _supporting, _contradicting, ok = parse_verdict_response('{"verdict": "MAYBE"}')
        assert ok is False
        assert verdict is None

    def test_missing_verdict_key_fails_closed(self) -> None:
        verdict, _supporting, _contradicting, ok = parse_verdict_response('{"foo": "bar"}')
        assert ok is False
        assert verdict is None

    def test_empty_string_fails_closed(self) -> None:
        verdict, _supporting, _contradicting, ok = parse_verdict_response("")
        assert ok is False
        assert verdict is None

    def test_never_returns_a_guessed_verdict_on_partial_truncation(self) -> None:
        # A truncated response (num_predict cut it off mid-array) is not
        # valid JSON and must never be silently treated as any real verdict.
        raw = '{"verdict": "INSUFFICIENT", "supporting_source_ids": ["S1", "S2'
        verdict, _supporting, _contradicting, ok = parse_verdict_response(raw)
        assert ok is False
        assert verdict is None

    def test_non_list_source_ids_are_dropped_not_fatal(self) -> None:
        raw = (
            '{"verdict": "SUFFICIENT", "supporting_source_ids": "S1", '
            '"contradicting_source_ids": []}'
        )
        verdict, supporting, contradicting, ok = parse_verdict_response(raw)
        assert ok is True
        assert verdict == "SUFFICIENT"
        assert supporting == []  # malformed (not a list) -> dropped, not fatal
        assert contradicting == []


class TestPromptConstruction:
    def test_prompt_variants_registry_has_v0_v1_v2(self) -> None:
        assert set(PROMPT_VARIANTS) == {"v0", "v1", "v2"}
        assert PROMPT_VARIANTS["v0"] == PROMPT_V0
        assert PROMPT_VARIANTS["v1"] == PROMPT_V1
        assert PROMPT_VARIANTS["v2"] == PROMPT_V2

    def test_v2_is_a_strict_extension_of_v1(self) -> None:
        # Milestone 7 §9: V2 = V1 + multi-document completeness examples —
        # never a from-scratch rewrite, so V1's contradiction examples are
        # never accidentally dropped when adding V2's multi-doc examples.
        assert PROMPT_V2.startswith(PROMPT_V1)
        assert len(PROMPT_V2) > len(PROMPT_V1)

    def test_v1_and_v2_contain_the_contradiction_distinction(self) -> None:
        for prompt in (PROMPT_V1, PROMPT_V2):
            assert "CONTRADICTORY" in prompt
            assert "INSUFFICIENT" in prompt
            assert "far-transfer" in prompt  # the spec's own worked example

    def test_v2_contains_multi_document_completeness_examples(self) -> None:
        assert "Compare A and B" in PROMPT_V2
        assert "Compare A and B" not in PROMPT_V1

    def _make_chunk(self, text: str):
        from app.core.retrieval_schemas import RetrievedChunk

        return RetrievedChunk(
            score=0.8, text=text, document_id="doc-1", chunk_id="doc-1::chunk0",
            document_type="journal_article", journal_quartile="Q1", title="T",
            authors=[], publication_year=2020, source_filename="t.pdf",
            chunk_index=0, page_number=1,
        )

    def _make_citations(self, n: int):
        from app.core.citation import Citation

        return [
            Citation(
                source_id=f"S{i + 1}", document_id="doc-1", chunk_id=f"doc-1::chunk{i}",
                document_type="journal_article", journal_quartile="Q1", score=0.8,
            )
            for i in range(n)
        ]

    def test_build_user_prompt_includes_all_sources_by_default(self) -> None:
        sources = [self._make_chunk("alpha"), self._make_chunk("beta"), self._make_chunk("gamma")]
        citations = self._make_citations(3)
        prompt = _build_user_prompt("What is X?", sources, citations, top_n=None)
        assert "What is X?" in prompt
        assert "alpha" in prompt and "beta" in prompt and "gamma" in prompt
        assert 'id="S1"' in prompt and 'id="S3"' in prompt

    def test_build_user_prompt_respects_top_n_truncation(self) -> None:
        sources = [self._make_chunk(f"text{i}") for i in range(6)]
        citations = self._make_citations(6)
        prompt = _build_user_prompt("Q?", sources, citations, top_n=3)
        assert "text0" in prompt and "text2" in prompt
        assert "text3" not in prompt and "text5" not in prompt
        assert 'id="S4"' not in prompt


class TestSchemaVariants:
    def test_schema_registry_has_both_variants(self) -> None:
        assert set(SCHEMAS) == {"A_minimal", "B_with_sources"}

    def test_schema_a_only_requires_verdict(self) -> None:
        assert SCHEMA_A_MINIMAL["required"] == ["verdict"]
        assert set(SCHEMA_A_MINIMAL["properties"]) == {"verdict"}

    def test_schema_b_requires_source_mapping_fields(self) -> None:
        assert set(SCHEMA_B_WITH_SOURCES["required"]) == {
            "verdict", "supporting_source_ids", "contradicting_source_ids",
        }

    def test_both_schemas_constrain_verdict_to_the_four_labels(self) -> None:
        for schema in SCHEMAS.values():
            assert set(schema["properties"]["verdict"]["enum"]) == set(VERDICTS)


class TestDevHoldoutSplit:
    def test_split_is_deterministic_across_calls(self) -> None:
        cases = reviewed_eval_cases()
        first = split_dev_holdout(cases)
        second = split_dev_holdout(cases)
        assert first.dev_case_ids == second.dev_case_ids
        assert first.holdout_case_ids == second.holdout_case_ids

    def test_split_accounts_for_every_case_exactly_once(self) -> None:
        cases = reviewed_eval_cases()
        split = split_dev_holdout(cases)
        all_ids = set(split.dev_case_ids) | set(split.holdout_case_ids)
        assert all_ids == {c.case_id for c, _label in cases}
        assert len(split.dev_case_ids) + len(split.holdout_case_ids) == len(cases)

    def test_no_case_appears_in_both_halves(self) -> None:
        cases = reviewed_eval_cases()
        split = split_dev_holdout(cases)
        assert set(split.dev_case_ids).isdisjoint(split.holdout_case_ids)

    def test_no_topic_group_appears_in_both_halves(self) -> None:
        cases = reviewed_eval_cases()
        split = split_dev_holdout(cases)
        assert set(split.dev_group_keys).isdisjoint(split.holdout_group_keys)

    def test_split_is_roughly_70_30(self) -> None:
        cases = reviewed_eval_cases()
        split = split_dev_holdout(cases)
        dev_fraction = len(split.dev_case_ids) / len(cases)
        assert 0.55 <= dev_fraction <= 0.85  # loose bound — whole-group assignment is lumpy

    def test_every_verdict_class_present_in_both_halves_on_the_real_subset(self) -> None:
        # Documents this run's actual split is usable, not merely that the
        # algorithm ran — a future corpus edit that breaks this should fail
        # loudly here, not silently produce a class-imbalanced holdout.
        cases = reviewed_eval_cases()
        split = split_dev_holdout(cases)
        assert split.meaningful, split.reason

    def test_refuses_a_meaningful_split_with_too_few_groups(self) -> None:
        case = EvalCase(
            case_id="X1", category="exact_terminology", query="q", answerable=True,
            expected_document_ids=["d1"], topic="only-topic",
        )
        split = split_dev_holdout([(case, "SUFFICIENT")])
        assert split.meaningful is False
        assert "too few" in split.reason


def _outcome(
    case_id: str, gold: str, predicted: str | None, latency_ms: float = 1000.0
) -> CaseOutcome:
    stats = RawCallStats(
        verdict=predicted, supporting_source_ids=[], contradicting_source_ids=[],
        parse_ok=predicted is not None, latency_ms=latency_ms, load_duration_ms=0.0,
        prompt_eval_count=100, prompt_eval_duration_ms=500.0, eval_count=10,
        eval_duration_ms=200.0, thinking_char_count=0,
    )
    return CaseOutcome(case_id=case_id, gold=gold, predicted=predicted, stats=stats)


class TestBenchmarkMetrics:
    def test_per_class_prf_perfect_classifier(self) -> None:
        outcomes = [
            _outcome("c1", "SUFFICIENT", "SUFFICIENT"),
            _outcome("c2", "INSUFFICIENT", "INSUFFICIENT"),
        ]
        per_class = _per_class_prf(outcomes)
        assert per_class["SUFFICIENT"]["precision"] == 1.0
        assert per_class["SUFFICIENT"]["recall"] == 1.0
        assert per_class["SUFFICIENT"]["f1"] == 1.0

    def test_confusion_matrix_counts_parse_failures_separately(self) -> None:
        outcomes = [_outcome("c1", "CONTRADICTORY", None)]
        matrix = _confusion_matrix(outcomes)
        assert matrix["CONTRADICTORY"]["PARSE_FAILURE"] == 1
        assert matrix["CONTRADICTORY"]["SUFFICIENT"] == 0

    def test_dangerous_errors_flags_contradictory_to_sufficient(self) -> None:
        outcomes = [
            _outcome("c1", "CONTRADICTORY", "SUFFICIENT"),
            _outcome("c2", "CONTRADICTORY", "INSUFFICIENT"),
        ]
        errors = _dangerous_errors(outcomes)
        assert errors["contradictory_to_sufficient_case_ids"] == ["c1"]
        assert errors["contradictory_recall"] == 0.0  # neither case predicted CONTRADICTORY

    def test_dangerous_errors_contradictory_recall_when_correct(self) -> None:
        outcomes = [
            _outcome("c1", "CONTRADICTORY", "CONTRADICTORY"),
            _outcome("c2", "CONTRADICTORY", "INSUFFICIENT"),
        ]
        errors = _dangerous_errors(outcomes)
        assert errors["contradictory_recall"] == 0.5

    def test_sufficient_false_block_counts_any_non_sufficient_prediction(self) -> None:
        outcomes = [
            _outcome("c1", "SUFFICIENT", "PARTIAL"),
            _outcome("c2", "SUFFICIENT", "INSUFFICIENT"),
            _outcome("c3", "SUFFICIENT", "SUFFICIENT"),
        ]
        errors = _dangerous_errors(outcomes)
        assert errors["sufficient_false_block_count"] == 2
        assert set(errors["sufficient_false_block_case_ids"]) == {"c1", "c2"}

    def test_binary_safety_dangerous_false_approval(self) -> None:
        outcomes = [
            _outcome("c1", "CONTRADICTORY", "SUFFICIENT"),  # dangerous FP
            _outcome("c2", "INSUFFICIENT", "INSUFFICIENT"),  # correct TN
        ]
        safety = _binary_safety(outcomes)
        assert safety["dangerous_false_approval_fp"] == 1
        assert safety["not_fully_supported_tn"] == 1
        assert safety["dangerous_false_approval_rate"] == 0.5

    def test_binary_safety_excludes_parse_failures_from_rates(self) -> None:
        outcomes = [_outcome("c1", "SUFFICIENT", None)]
        safety = _binary_safety(outcomes)
        assert safety["parse_failures_excluded"] == 1
        assert safety["dangerous_false_approval_rate"] is None
        assert safety["sufficient_false_block_rate"] is None

    def test_build_variant_report_is_json_serializable(self) -> None:
        import json

        config = VerifierConfig(
            label="test", prompt_variant="v1", schema_variant="A_minimal",
            thinking=False, num_predict=64, evidence_top_n=None,
        )
        outcomes = [
            _outcome("c1", "SUFFICIENT", "SUFFICIENT", latency_ms=2000.0),
            _outcome("c2", "CONTRADICTORY", "INSUFFICIENT", latency_ms=3000.0),
        ]
        report = build_variant_report(config, "dev", outcomes)
        json.dumps(report.to_dict())  # raises if not serializable
        assert report.case_count == 2
        assert report.latency_ms["mean_ms"] == 2500.0
