"""Covers Milestone 5.7 (production-representative retrieval & evidence
benchmark): evaluation/realistic_corpus.py's dataset integrity, the
document/topic-group holdout split (leakage prevention), the
evidence-coverage and candidate-vs-final-recall metrics, and a full
synthetic-embedding harness run against the realistic corpus (mechanics
only — see scripts/eval_retrieval_controlled.py's module docstring for why
synthetic mode is never used for a semantic-quality conclusion).
"""

import json

import pytest

from evaluation.controlled_corpus import CATEGORIES
from evaluation.controlled_corpus import DOCUMENTS_BY_ID as M5_DOCUMENTS_BY_ID
from evaluation.realistic_corpus import (
    ALL_REALISTIC_CASES,
    DOCUMENTS_BY_ID,
    REALISTIC_CASES,
    REALISTIC_DOCUMENTS,
    ZOOM_IN_CASES,
)
from scripts.calibrate_evidence_sufficiency import (
    ScoredCase,
    deterministic_group_split,
)
from scripts.calibrate_evidence_sufficiency import (
    run as run_calibration,
)
from scripts.eval_retrieval_controlled import (
    RawCandidate,
    chunk_key,
    compute_candidate_vs_final_recall,
    compute_evidence_coverage,
)
from scripts.eval_retrieval_controlled import (
    run as run_retrieval_eval,
)


class TestRealisticCorpusIntegrity:
    def test_document_and_chunk_counts_are_within_the_milestone_target_range(self) -> None:
        assert 15 <= len(REALISTIC_DOCUMENTS) <= 30
        total_chunks = sum(len(d.chunks) for d in REALISTIC_DOCUMENTS)
        assert total_chunks >= 100  # short of the 150 stretch target; documented in the report

    def test_general_case_count_meets_the_milestone_minimum(self) -> None:
        assert len(REALISTIC_CASES) >= 60

    def test_zoom_in_case_counts_meet_the_milestone_minimum(self) -> None:
        positive = [c for c in ZOOM_IN_CASES if c.scope_contains_answer]
        negative = [c for c in ZOOM_IN_CASES if not c.scope_contains_answer]
        assert len(positive) >= 20
        assert len(negative) >= 20

    def test_case_ids_are_globally_unique(self) -> None:
        ids = [c.case_id for c in ALL_REALISTIC_CASES]
        assert len(ids) == len(set(ids))

    def test_case_ids_never_collide_with_milestone_5_6_case_ids(self) -> None:
        from evaluation.controlled_corpus import CONTROLLED_CASES

        realistic_ids = {c.case_id for c in ALL_REALISTIC_CASES}
        m5_ids = {c.case_id for c in CONTROLLED_CASES}
        assert realistic_ids.isdisjoint(m5_ids)

    def test_document_ids_are_unique(self) -> None:
        ids = [d.document_id for d in REALISTIC_DOCUMENTS]
        assert len(ids) == len(set(ids))

    def test_every_expected_document_id_exists_in_this_corpus(self) -> None:
        for case in ALL_REALISTIC_CASES:
            for document_id in case.expected_document_ids:
                assert document_id in DOCUMENTS_BY_ID, f"{case.case_id}: unknown doc {document_id}"

    def test_every_expected_chunk_id_resolves_to_a_real_chunk(self) -> None:
        valid_keys = {
            document.chunk_id(chunk.chunk_index)
            for document in REALISTIC_DOCUMENTS
            for chunk in document.chunks
        }
        for case in ALL_REALISTIC_CASES:
            for chunk_id in case.expected_chunk_ids:
                assert chunk_id in valid_keys, f"{case.case_id}: unknown chunk {chunk_id}"

    def test_every_scope_document_id_exists_in_this_corpus(self) -> None:
        for case in ZOOM_IN_CASES:
            assert case.scope_document_ids is not None
            for document_id in case.scope_document_ids:
                assert document_id in DOCUMENTS_BY_ID, (
                    f"{case.case_id}: unknown scope doc {document_id}"
                )

    def test_every_case_category_is_registered_in_the_shared_categories_list(self) -> None:
        for case in ALL_REALISTIC_CASES:
            assert case.category in CATEGORIES

    def test_every_document_has_a_topic(self) -> None:
        for document in REALISTIC_DOCUMENTS:
            assert document.topic is not None and document.topic != ""

    def test_every_general_case_has_a_topic_for_group_splitting(self) -> None:
        for case in REALISTIC_CASES:
            assert case.topic is not None and case.topic != "", (
                f"{case.case_id}: missing topic (required for Milestone 5.7 group-level split)"
            )

    def test_answer_absent_cases_have_no_expected_documents(self) -> None:
        for case in REALISTIC_CASES:
            if not case.answerable:
                assert case.expected_document_ids == []

    def test_realistic_corpus_documents_are_disjoint_from_milestone_5_6_documents(self) -> None:
        """Confirms this is genuinely a second, separate corpus, not an
        accidental extension of the Milestone 5/5.6 one (document_id
        namespaces must never collide when both are ingested into the
        same embedded Qdrant instance in the same process)."""
        assert set(DOCUMENTS_BY_ID).isdisjoint(set(M5_DOCUMENTS_BY_ID))


class TestGroupSplitLeakagePrevention:
    def _scored_from_cases(self) -> list[ScoredCase]:
        return [
            ScoredCase(
                case_id=c.case_id, category=c.category, mode="general",
                is_positive=c.should_answer, candidates=[], topic=c.topic,
            )
            for c in REALISTIC_CASES
        ]

    def test_no_topic_appears_in_both_calibration_and_holdout(self) -> None:
        split = deterministic_group_split(self._scored_from_cases())
        assert split.meaningful
        calibration_topics = {c.topic for c in split.calibration}
        holdout_topics = {c.topic for c in split.holdout}
        assert calibration_topics.isdisjoint(holdout_topics)

    def test_every_case_is_accounted_for_exactly_once(self) -> None:
        scored = self._scored_from_cases()
        split = deterministic_group_split(scored)
        cal_ids = {c.case_id for c in split.calibration}
        hold_ids = {c.case_id for c in split.holdout}
        assert cal_ids.isdisjoint(hold_ids)
        assert cal_ids | hold_ids == {c.case_id for c in scored}

    def test_same_seed_is_fully_reproducible(self) -> None:
        scored = self._scored_from_cases()
        split_a = deterministic_group_split(scored, seed=56)
        split_b = deterministic_group_split(scored, seed=56)
        assert {c.case_id for c in split_a.calibration} == {c.case_id for c in split_b.calibration}

    def test_cases_without_a_topic_become_their_own_singleton_group(self) -> None:
        scored = [
            ScoredCase(case_id="a", category="x", mode="general", is_positive=True, candidates=[]),
            ScoredCase(case_id="b", category="x", mode="general", is_positive=False, candidates=[]),
        ]
        # Too few groups (2 singleton groups) to split meaningfully — must
        # refuse rather than pretend, not crash.
        split = deterministic_group_split(scored)
        assert split.meaningful is False


class TestCandidateVsFinalRecall:
    def _result(self, candidate_pool, mmr_topk, expected_document_ids, require_all=False):
        from evaluation.controlled_corpus import EvalCase
        from scripts.eval_retrieval_controlled import CaseResult, CaseTiming

        case = EvalCase(
            case_id="T", query="q", category="exact_terminology",
            expected_document_ids=expected_document_ids, require_all_documents=require_all,
        )
        return CaseResult(
            case=case, candidate_pool=candidate_pool, raw_dense_topk=candidate_pool,
            mmr_topk=mmr_topk, timing=CaseTiming(1.0, 1.0, 1.0), insufficient_evidence=False,
            citation_count=0, expected_chunk_survived_to_citation=None,
        )

    def _cand(self, document_id: str, score: float = 0.5) -> RawCandidate:
        return RawCandidate(
            document_id=document_id, chunk_index=0, key=chunk_key(document_id, 0),
            score=score, text="t",
        )

    def test_distinguishes_recall_failure_from_ranking_failure(self) -> None:
        # d1 never in the candidate pool at all -> recall failure.
        recall_failure = self._result([self._cand("d2")], [self._cand("d2")], ["d1"])
        # d1 in the candidate pool but not in the final top_k -> ranking failure.
        ranking_failure = self._result(
            [self._cand("d1"), self._cand("d2")], [self._cand("d2")], ["d1"]
        )
        report = compute_candidate_vs_final_recall([recall_failure, ranking_failure])
        assert report["recall_failures_never_in_candidate_pool"] == 1
        assert report["ranking_failures_in_candidates_not_final_window"] == 1

    def test_full_success_counts_toward_both_hit_rates(self) -> None:
        result = self._result([self._cand("d1")], [self._cand("d1")], ["d1"])
        report = compute_candidate_vs_final_recall([result])
        assert report["candidate_hit_rate"] == 1.0
        assert report["final_window_hit_rate"] == 1.0


class TestEvidenceCoverage:
    def _result_multi(self, mmr_topk_docs, expected_document_ids):
        from evaluation.controlled_corpus import EvalCase
        from scripts.eval_retrieval_controlled import CaseResult, CaseTiming

        case = EvalCase(
            case_id="M", query="q", category="cross_document",
            expected_document_ids=expected_document_ids,
        )
        candidates = [
            RawCandidate(document_id=d, chunk_index=0, key=chunk_key(d, 0), score=0.8, text="t")
            for d in mmr_topk_docs
        ]
        return CaseResult(
            case=case, candidate_pool=candidates, raw_dense_topk=candidates, mmr_topk=candidates,
            timing=CaseTiming(1.0, 1.0, 1.0), insufficient_evidence=False, citation_count=0,
            expected_chunk_survived_to_citation=None,
        )

    def test_full_coverage_when_both_required_documents_are_present(self) -> None:
        result = self._result_multi(["d1", "d2"], ["d1", "d2"])
        report = compute_evidence_coverage([result])
        assert report["fully_covered_count"] == 1
        assert report["mean_coverage"] == 1.0

    def test_partial_coverage_when_only_one_required_document_is_present(self) -> None:
        result = self._result_multi(["d1", "d3"], ["d1", "d2"])
        report = compute_evidence_coverage([result])
        assert report["fully_covered_count"] == 0
        assert report["mean_coverage"] == pytest.approx(0.5)

    def test_single_document_cases_are_excluded_from_the_multi_document_pool(self) -> None:
        result = self._result_multi(["d1"], ["d1"])
        report = compute_evidence_coverage([result])
        assert report == {"multi_document_case_count": 0}

    def test_high_score_incomplete_coverage_is_flagged(self) -> None:
        result = self._result_multi(["d1", "d3"], ["d1", "d2"])
        report = compute_evidence_coverage([result])
        assert report["high_score_but_incomplete_coverage_count"] == 1
        assert "M" in report["high_score_but_incomplete_coverage_case_ids"]


class TestFullHarnessAgainstRealisticCorpus:
    def test_retrieval_eval_runs_and_reports_dataset_counts(self, tmp_path) -> None:
        report = run_retrieval_eval(
            force_synthetic=True, top_k=None, reports_dir=tmp_path,
            documents=REALISTIC_DOCUMENTS, cases=ALL_REALISTIC_CASES,
            collection_name="test-m57-retrieval", dataset_version="realistic-corpus-v1",
        )
        assert report.embedding_mode == "synthetic:lexical-hash"
        assert report.document_count == len(REALISTIC_DOCUMENTS)
        assert report.case_count == len(ALL_REALISTIC_CASES)
        serialized = json.dumps(report.to_dict())
        reloaded = json.loads(serialized)
        assert reloaded["candidate_vs_final"]["eligible_case_count"] > 0
        assert reloaded["evidence_coverage"]["multi_document_case_count"] > 0

    def test_calibration_runs_with_group_split_and_reports_both_modes(self, tmp_path) -> None:
        report = run_calibration(
            force_synthetic=True, reports_dir=tmp_path,
            documents=REALISTIC_DOCUMENTS, cases=ALL_REALISTIC_CASES,
            collection_name="test-m57-calib", dataset_version="realistic-corpus-v1",
            use_group_split=True,
        )
        assert report["dataset"]["total_cases"] == len(ALL_REALISTIC_CASES)
        assert "GROUP-level" in report["general_calibration"]["split_reason"]
        assert "GROUP-level" in report["zoom_in_calibration"]["split_reason"]
        json.dumps(report)  # must be machine-readable

    def test_two_runs_produce_identical_metrics(self, tmp_path) -> None:
        kwargs = {
            "force_synthetic": True, "reports_dir": tmp_path,
            "documents": REALISTIC_DOCUMENTS, "cases": ALL_REALISTIC_CASES,
            "collection_name": "test-m57-determinism", "dataset_version": "realistic-corpus-v1",
            "use_group_split": True,
        }
        report_a = run_calibration(**kwargs)
        report_b = run_calibration(**kwargs)
        report_a.pop("generated_at")
        report_b.pop("generated_at")
        assert report_a == report_b
