"""Covers Milestone 5 (retrieval quality baseline / evidence-sufficiency
evaluation): evaluation/controlled_corpus.py's dataset integrity and
scripts/eval_retrieval_controlled.py's pure metric functions, plus a
full-harness run (forced synthetic embeddings — no external dependency)
proving deterministic ordering, machine-readable JSON output, and
Zoom-In leakage-freedom against the real controlled corpus.
"""

import json

import pytest

from evaluation.controlled_corpus import (
    CATEGORIES,
    CONTROLLED_CASES,
    CONTROLLED_DOCUMENTS,
    DOCUMENTS_BY_ID,
    EvalCase,
)
from scripts.eval_retrieval_controlled import (
    RawCandidate,
    ScoreDistributionSummary,
    chunk_key,
    compute_aggregate_metrics,
    compute_category_breakdown,
    compute_citation_grounding,
    compute_evidence_sufficiency,
    compute_mmr_impact,
    compute_score_distribution,
    compute_zoom_in_findings,
    find_chunk_rank,
    find_document_rank,
    latency_percentiles,
    mean_reciprocal_rank,
    recall_at_k,
    run,
)

# ---------------------------------------------------------------------------
# Dataset integrity
# ---------------------------------------------------------------------------


class TestDatasetIntegrity:
    def test_every_category_is_covered(self) -> None:
        # CATEGORIES is a shared registry (Milestone 5.7 added categories
        # for evaluation/realistic_corpus.py's own use) — this corpus only
        # needs to cover its own subset, checked as "no case uses an
        # unregistered category" (already enforced by EvalCase itself) plus
        # "every Milestone 5/5.6 category has >=1 case here."
        used = {c.category for c in CONTROLLED_CASES}
        assert used.issubset(set(CATEGORIES))
        m5_categories = {
            "exact_terminology", "paraphrase", "acronym", "numerical_fact", "cross_document",
            "section_specific", "answer_absent", "zoom_in_absent_elsewhere_present",
            "distractor_heavy", "near_duplicate", "related_topic_absent",
            "wrong_numerical_detail", "entity_confusion", "partial_evidence",
            "cross_document_incomplete", "zoom_in_project_absent",
            "semantic_neighbor_distractor", "negation_contradiction", "acronym_ambiguity",
            "section_mismatch",
        }
        assert m5_categories.issubset(used)

    def test_case_ids_are_unique(self) -> None:
        ids = [c.case_id for c in CONTROLLED_CASES]
        assert len(ids) == len(set(ids))

    def test_document_ids_are_unique(self) -> None:
        ids = [d.document_id for d in CONTROLLED_DOCUMENTS]
        assert len(ids) == len(set(ids))

    def test_every_expected_document_id_exists_in_the_corpus(self) -> None:
        for case in CONTROLLED_CASES:
            for document_id in case.expected_document_ids:
                assert document_id in DOCUMENTS_BY_ID, f"{case.case_id}: unknown doc {document_id}"

    def test_every_expected_chunk_id_resolves_to_a_real_chunk(self) -> None:
        valid_keys = {
            document.chunk_id(chunk.chunk_index)
            for document in CONTROLLED_DOCUMENTS
            for chunk in document.chunks
        }
        for case in CONTROLLED_CASES:
            for chunk_id in case.expected_chunk_ids:
                assert chunk_id in valid_keys, f"{case.case_id}: unknown chunk {chunk_id}"

    def test_every_scope_document_id_exists_in_the_corpus(self) -> None:
        for case in CONTROLLED_CASES:
            for document_id in case.scope_document_ids or []:
                assert document_id in DOCUMENTS_BY_ID, (
                    f"{case.case_id}: unknown scope doc {document_id}"
                )

    def test_answer_absent_cases_have_no_expected_documents(self) -> None:
        for case in CONTROLLED_CASES:
            if not case.answerable:
                assert case.expected_document_ids == []

    def test_cross_document_cases_expect_more_than_one_document(self) -> None:
        for case in CONTROLLED_CASES:
            if case.require_all_documents:
                assert len(case.expected_document_ids) >= 2

    def test_zoom_in_cases_all_set_scope_contains_answer(self) -> None:
        for case in CONTROLLED_CASES:
            if case.category == "zoom_in_absent_elsewhere_present":
                assert case.scope_document_ids is not None
                assert case.scope_contains_answer is not None

    # --- Milestone 5.6 (evidence-sufficiency calibration) additions ---

    def test_corpus_level_unanswerable_cases_never_have_a_zoom_in_scope(self) -> None:
        """A case is either a corpus-level negative (answerable=False, no
        scope) or a Zoom-In-scope case (scope_document_ids set,
        answerable stays True at the corpus level, scope_contains_answer
        carries the scope-level truth) — never both at once, which would
        make it ambiguous which ground truth a calibration pass should
        use (see scripts/calibrate_evidence_sufficiency.py's module
        docstring on why general/Zoom-In are scored from different
        fields)."""
        for case in CONTROLLED_CASES:
            if not case.answerable:
                assert case.scope_document_ids is None, (
                    f"{case.case_id}: answerable=False cases must not also carry a "
                    "Zoom-In scope"
                )

    def test_every_negative_type_category_has_multiple_cases(self) -> None:
        """Manual ground-truth audit (Milestone 5.6 §17): every fine-grained
        negative category introduced this milestone has enough cases to be
        a real calibration signal, not a single unverifiable data point."""
        negative_type_categories = [
            "related_topic_absent", "wrong_numerical_detail", "entity_confusion",
            "partial_evidence", "cross_document_incomplete", "zoom_in_project_absent",
            "semantic_neighbor_distractor", "negation_contradiction", "acronym_ambiguity",
            "section_mismatch",
        ]
        for category in negative_type_categories:
            count = sum(1 for c in CONTROLLED_CASES if c.category == category)
            assert count >= 3, f"{category}: only {count} case(s), expected >=3"

    def test_general_mode_pool_has_at_least_thirty_cases_per_class(self) -> None:
        """Milestone 5.6 §16's explicit minimum dataset size target."""
        general = [c for c in CONTROLLED_CASES if c.scope_document_ids is None]
        positives = [c for c in general if c.answerable]
        negatives = [c for c in general if not c.answerable]
        assert len(positives) >= 30
        assert len(negatives) >= 30

    def test_zoom_in_project_absent_cases_model_scope_negatives_not_corpus_negatives(
        self,
    ) -> None:
        """Type H (Milestone 5.6 §4) is explicitly modeled as a Zoom-In-scope
        variant (this harness has no separate project-knowledge-item store)
        — every such case must have a real expected_document_ids answer at
        the corpus level (answerable=True) and scope_contains_answer=False."""
        for case in CONTROLLED_CASES:
            if case.category == "zoom_in_project_absent":
                assert case.answerable is True
                assert case.expected_document_ids != []
                assert case.scope_contains_answer is False

    def test_eval_case_rejects_unknown_category(self) -> None:
        with pytest.raises(ValueError, match="unknown category"):
            EvalCase(case_id="X", query="q", category="not_a_real_category")

    def test_eval_case_rejects_scope_ids_without_scope_contains_answer(self) -> None:
        with pytest.raises(ValueError, match="scope_contains_answer"):
            EvalCase(
                case_id="X",
                query="q",
                category="exact_terminology",
                scope_document_ids=["doc-rct-peer-tutoring"],
            )

    def test_chunk_key_matches_document_chunk_id(self) -> None:
        document = DOCUMENTS_BY_ID["doc-rct-peer-tutoring"]
        assert chunk_key("doc-rct-peer-tutoring", 0) == document.chunk_id(0)


# ---------------------------------------------------------------------------
# Pure metric functions
# ---------------------------------------------------------------------------


def _cand(document_id: str, chunk_index: int = 0, score: float = 0.5) -> RawCandidate:
    return RawCandidate(
        document_id=document_id,
        chunk_index=chunk_index,
        key=chunk_key(document_id, chunk_index),
        score=score,
        text="text",
    )


class TestFindDocumentRank:
    def test_any_mode_returns_rank_of_first_match(self) -> None:
        ranked = [_cand("d3"), _cand("d1"), _cand("d2")]
        assert find_document_rank(ranked, ["d1", "d2"], require_all=False) == 2

    def test_any_mode_returns_none_when_absent(self) -> None:
        ranked = [_cand("d3"), _cand("d4")]
        assert find_document_rank(ranked, ["d1"], require_all=False) is None

    def test_require_all_returns_rank_where_last_required_doc_first_appears(self) -> None:
        ranked = [_cand("d1"), _cand("d3"), _cand("d2")]
        assert find_document_rank(ranked, ["d1", "d2"], require_all=True) == 3

    def test_require_all_returns_none_when_only_one_of_two_present(self) -> None:
        ranked = [_cand("d1"), _cand("d3")]
        assert find_document_rank(ranked, ["d1", "d2"], require_all=True) is None

    def test_empty_expected_returns_none(self) -> None:
        assert find_document_rank([_cand("d1")], [], require_all=False) is None


class TestFindChunkRank:
    def test_returns_rank_of_first_matching_chunk_key(self) -> None:
        ranked = [_cand("d1", 0), _cand("d1", 1), _cand("d2", 0)]
        assert find_chunk_rank(ranked, [chunk_key("d2", 0)]) == 3

    def test_returns_none_when_absent(self) -> None:
        ranked = [_cand("d1", 0)]
        assert find_chunk_rank(ranked, [chunk_key("d9", 0)]) is None


class TestRecallAtK:
    def test_counts_hits_within_k(self) -> None:
        assert recall_at_k([1, 3, None, 5], 3) == 0.5

    def test_empty_ranks_returns_zero(self) -> None:
        assert recall_at_k([], 5) == 0.0

    def test_all_hits(self) -> None:
        assert recall_at_k([1, 1, 2], 3) == 1.0


class TestMeanReciprocalRank:
    def test_basic(self) -> None:
        assert mean_reciprocal_rank([1, 2, None]) == pytest.approx((1.0 + 0.5 + 0.0) / 3)

    def test_empty_returns_zero(self) -> None:
        assert mean_reciprocal_rank([]) == 0.0


class TestScoreDistributionSummary:
    def test_empty_scores(self) -> None:
        summary = ScoreDistributionSummary.from_scores([])
        assert summary == ScoreDistributionSummary(
            count=0, min=None, max=None, mean=None, median=None
        )

    def test_non_empty_scores(self) -> None:
        summary = ScoreDistributionSummary.from_scores([0.1, 0.5, 0.9])
        assert summary.count == 3
        assert summary.min == 0.1
        assert summary.max == 0.9
        assert summary.mean == pytest.approx(0.5)
        assert summary.median == 0.5


class TestLatencyPercentiles:
    def test_empty_returns_zeros(self) -> None:
        assert latency_percentiles([]) == {"mean": 0.0, "p50": 0.0, "p95": 0.0}

    def test_p95_of_twenty_values_is_the_nineteenth(self) -> None:
        values = list(range(1, 21))  # 1..20
        result = latency_percentiles([float(v) for v in values])
        assert result["p95"] == 19.0
        assert result["mean"] == pytest.approx(10.5)
        assert result["p50"] == pytest.approx(10.5)


# ---------------------------------------------------------------------------
# Aggregate/category/MMR/score-distribution/zoom-in/evidence-sufficiency/
# citation-grounding computations, against a small synthetic CaseResult set
# (isolates metric logic from the retrieval pipeline itself).
# ---------------------------------------------------------------------------


def _make_case(**overrides: object) -> EvalCase:
    defaults: dict[str, object] = {
        "case_id": "T1",
        "query": "q",
        "category": "exact_terminology",
        "expected_document_ids": ["d1"],
    }
    defaults.update(overrides)
    return EvalCase(**defaults)  # type: ignore[arg-type]


def _make_result(case: EvalCase, mmr_topk: list[RawCandidate], **overrides: object):
    from scripts.eval_retrieval_controlled import CaseResult, CaseTiming

    defaults: dict[str, object] = {
        "case": case,
        "candidate_pool": mmr_topk,
        "raw_dense_topk": mmr_topk,
        "mmr_topk": mmr_topk,
        "timing": CaseTiming(1.0, 1.0, 1.0),
        "insufficient_evidence": not mmr_topk,
        "citation_count": len(mmr_topk),
        "expected_chunk_survived_to_citation": None,
    }
    defaults.update(overrides)
    return CaseResult(**defaults)  # type: ignore[arg-type]


class TestComputeAggregateMetrics:
    def test_recall_and_hit_rate_over_two_answerable_cases(self) -> None:
        case_hit = _make_case(case_id="H", expected_document_ids=["d1"])
        case_miss = _make_case(case_id="M", expected_document_ids=["d9"])
        results = [
            _make_result(case_hit, [_cand("d1")]),
            _make_result(case_miss, [_cand("d2")]),
        ]
        metrics = compute_aggregate_metrics(results)
        assert metrics.document_recall_at[1] == 0.5
        assert metrics.document_hit_rate == 0.5

    def test_no_answer_false_positive_rate(self) -> None:
        absent = _make_case(case_id="A", category="answer_absent", answerable=False)
        results = [_make_result(absent, [_cand("d1")], insufficient_evidence=False)]
        metrics = compute_aggregate_metrics(results)
        assert metrics.no_answer_false_positive_rate == 1.0

    def test_no_answer_false_positive_rate_none_when_no_such_cases(self) -> None:
        results = [_make_result(_make_case(), [_cand("d1")])]
        assert compute_aggregate_metrics(results).no_answer_false_positive_rate is None

    def test_chunk_recall_only_counts_chunk_eligible_cases(self) -> None:
        with_chunk = _make_case(
            case_id="C", expected_document_ids=["d1"], expected_chunk_ids=[chunk_key("d1", 0)]
        )
        without_chunk = _make_case(case_id="NC", expected_document_ids=["d2"])
        results = [
            _make_result(with_chunk, [_cand("d1", 0)]),
            _make_result(without_chunk, [_cand("d2", 0)]),
        ]
        metrics = compute_aggregate_metrics(results)
        # Only the chunk-eligible case counts toward chunk recall.
        assert metrics.chunk_recall_at[1] == 1.0


class TestComputeMultiDocumentRecall:
    def test_cross_document_case_requires_all_documents_present(self) -> None:
        case = _make_case(
            case_id="CD",
            category="cross_document",
            expected_document_ids=["d1", "d2"],
            require_all_documents=True,
        )
        only_one_side = [_make_result(case, [_cand("d1")])]
        assert compute_aggregate_metrics(only_one_side).document_hit_rate == 0.0

        both_sides = [_make_result(case, [_cand("d1"), _cand("d2")])]
        assert compute_aggregate_metrics(both_sides).document_hit_rate == 1.0


class TestComputeCategoryBreakdown:
    def test_breaks_down_by_category_and_leaves_others_empty(self) -> None:
        case = _make_case(case_id="ET1", category="exact_terminology", expected_document_ids=["d1"])
        results = [_make_result(case, [_cand("d1")])]
        breakdown = compute_category_breakdown(results)
        assert breakdown["exact_terminology"]["case_count"] == 1
        assert breakdown["exact_terminology"]["document_recall_at_5"] == 1.0
        assert breakdown["paraphrase"]["case_count"] == 0
        assert breakdown["paraphrase"]["document_hit_rate"] is None


class TestComputeMMRImpact:
    def test_detects_improved_and_hurt_cases(self) -> None:
        case = _make_case(case_id="M", expected_document_ids=["d2"])
        # raw-dense: d2 ranks 2nd; mmr: d2 ranks 1st -> improved.
        improved_result = _make_result(
            case,
            mmr_topk=[_cand("d2"), _cand("d1")],
            raw_dense_topk=[_cand("d1"), _cand("d2")],
        )
        impact = compute_mmr_impact([improved_result])
        assert impact.improved_count == 1
        assert impact.hurt_count == 0


class TestComputeScoreDistribution:
    def test_splits_relevant_vs_irrelevant_top_result(self) -> None:
        relevant_case = _make_case(case_id="R", expected_document_ids=["d1"])
        irrelevant_case = _make_case(case_id="I", expected_document_ids=["d9"])
        results = [
            _make_result(relevant_case, [_cand("d1", score=0.9)]),
            _make_result(irrelevant_case, [_cand("d2", score=0.2)]),
        ]
        dist = compute_score_distribution(results)
        assert dist["relevant_top_result"]["max"] == 0.9
        assert dist["irrelevant_top_result"]["max"] == 0.2


class TestComputeZoomInFindings:
    def test_flags_leakage_when_out_of_scope_document_appears(self) -> None:
        case = _make_case(
            case_id="Z",
            category="zoom_in_absent_elsewhere_present",
            expected_document_ids=["d2"],
            scope_document_ids=["d1"],
            scope_contains_answer=False,
        )
        result = _make_result(
            case,
            [_cand("d1")],
            zoom_in_topk=[_cand("d2")],  # d2 is NOT in scope_document_ids=["d1"]
            zoom_in_insufficient_evidence=False,
            zoom_in_leaked_out_of_scope_document=True,
        )
        findings = compute_zoom_in_findings([result])
        assert findings["leakage_count"] == 1
        assert findings["leaked_case_ids"] == ["Z"]

    def test_reports_zero_cases_when_no_zoom_in_cases_present(self) -> None:
        results = [_make_result(_make_case(), [_cand("d1")])]
        assert compute_zoom_in_findings(results) == {"case_count": 0}


class TestComputeEvidenceSufficiency:
    def test_reports_top_score_and_shortcut_status_per_no_answer_case(self) -> None:
        case = _make_case(case_id="NA", category="answer_absent", answerable=False)
        result = _make_result(case, [_cand("d1", score=0.42)], insufficient_evidence=False)
        report = compute_evidence_sufficiency([result])
        assert report["no_answer_case_count"] == 1
        assert report["cases"][0]["top_score"] == 0.42
        assert report["cases"][0]["would_call_llm"] is True


class TestComputeCitationGrounding:
    def test_reports_survival_rate(self) -> None:
        case = _make_case(expected_chunk_ids=[chunk_key("d1", 0)])
        survived = _make_result(case, [_cand("d1")], expected_chunk_survived_to_citation=True)
        failed = _make_result(case, [_cand("d1")], expected_chunk_survived_to_citation=False)
        report = compute_citation_grounding([survived, failed])
        assert report["eligible_case_count"] == 2
        assert report["expected_chunk_survived_to_citation_rate"] == 0.5


# ---------------------------------------------------------------------------
# Full-harness integration: deterministic ordering, machine-readable output,
# Zoom-In leakage-freedom — real controlled corpus, forced synthetic
# embeddings (no external dependency, runs anywhere).
# ---------------------------------------------------------------------------


class TestFullHarnessRun:
    def test_run_produces_a_report_json_serializable_without_error(self, tmp_path) -> None:
        report = run(force_synthetic=True, top_k=None, reports_dir=tmp_path)
        # Must round-trip cleanly — this IS the machine-readable artifact.
        serialized = json.dumps(report.to_dict())
        reloaded = json.loads(serialized)
        assert reloaded["dataset"]["case_count"] == len(CONTROLLED_CASES)
        assert report.embedding_mode == "synthetic:lexical-hash"

    def test_two_runs_produce_identical_metrics_content(self, tmp_path) -> None:
        """Deterministic ordering (Milestone 5 §14/§19): only wall-clock
        latency figures may differ between runs — every ranking/metric
        value must be byte-identical given the same corpus and cases."""
        report_a = run(force_synthetic=True, top_k=None, reports_dir=tmp_path)
        report_b = run(force_synthetic=True, top_k=None, reports_dir=tmp_path)
        dict_a = report_a.to_dict()
        dict_b = report_b.to_dict()
        for key in ("generated_at", "latency"):
            dict_a.pop(key)
            dict_b.pop(key)
        assert dict_a == dict_b

    def test_zoom_in_cases_never_leak_an_out_of_scope_document(self, tmp_path) -> None:
        report = run(force_synthetic=True, top_k=None, reports_dir=tmp_path)
        assert report.zoom_in_findings["case_count"] > 0
        assert report.zoom_in_findings["leakage_count"] == 0

    def test_frozen_production_config_is_read_from_settings_unmodified(self, tmp_path) -> None:
        from app.config import get_settings

        settings = get_settings()
        report = run(force_synthetic=True, top_k=None, reports_dir=tmp_path)
        assert report.mmr_relevance_weight == settings.retrieval_mmr_relevance_weight
        assert report.fetch_k == settings.retrieval_fetch_k
