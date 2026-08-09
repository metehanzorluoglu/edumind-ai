"""Milestone 9 (Question-to-Claim Transformation & NLI Routing) — unit
tests for evaluation/claim_transformer.py, evaluation/
claim_transformation_dataset.py, scripts/eval_claim_transformer.py, and
evaluation/evidence_aggregation.py. All pure-Python, deterministic, no
torch/model dependency — runs in the ordinary production venv, same as
every other evaluation-tooling test file in this repo."""

from __future__ import annotations

from evaluation.claim_transformation_dataset import CASES, by_category
from evaluation.claim_transformer import classify_and_transform
from evaluation.evidence_aggregation import (
    ClaimRelationRow,
    SourceRelation,
    aggregate_claim_status,
    aggregate_claims,
    aggregate_evidence_state,
    should_answer,
)
from scripts.eval_claim_transformer import (
    applicability_metrics,
    build_report,
    category_confusion,
    multi_claim_count_accuracy,
    polarity_preservation,
    run,
    unsafe_transformation_rate,
)


class TestSimpleYesNoTransformation:
    def test_did_support_affirmative(self) -> None:
        r = classify_and_transform("Did X improve Y?")
        assert r.applicable and r.category == "BOOLEAN_CLAIM"
        assert r.claims == ("X improved Y.",)

    def test_does_support_singular_subject(self) -> None:
        r = classify_and_transform("Does the paper report X?")
        assert r.claims == ("The paper reports X.",)

    def test_do_support_plural_subject_no_s_ending(self) -> None:
        r = classify_and_transform(
            "Do the screening instruments predict long-term academic outcomes?"
        )
        assert r.claims == ("The screening instruments predict long-term academic outcomes.",)

    def test_be_verb_past(self) -> None:
        r = classify_and_transform("Was the sample size 42?")
        assert r.claims == ("The sample size was 42.",)

    def test_be_verb_present_participle_retensed_to_past(self) -> None:
        r = classify_and_transform("Is method X used?")
        assert r.claims == ("Method X was used.",)

    def test_be_verb_present_adjective_stays_present(self) -> None:
        r = classify_and_transform("Is the finding consistent with prior research?")
        assert r.claims == ("The finding is consistent with prior research.",)


class TestPresuppositionTransformation:
    def test_how_much_did(self) -> None:
        r = classify_and_transform("How much did the intervention improve performance?")
        assert r.applicable and r.category == "PRESUPPOSITION_CLAIM"
        assert r.claims == ("The intervention improved performance.",)

    def test_why_did(self) -> None:
        r = classify_and_transform("Why did engagement increase after the redesign?")
        assert r.claims == ("Engagement increased after the redesign.",)

    def test_what_caused_to(self) -> None:
        r = classify_and_transform("What caused test scores to improve?")
        assert r.claims == ("Test scores improved.",)

    def test_when_did(self) -> None:
        r = classify_and_transform("When did the decline begin?")
        assert r.claims == ("The decline began.",)

    def test_embedded_declarative_clause_extraction(self) -> None:
        r = classify_and_transform(
            "What evidence shows the intervention did not improve performance?"
        )
        assert r.applicable and r.category == "PRESUPPOSITION_CLAIM"
        assert r.claims == ("The intervention did not improve performance.",)

    def test_open_value_wh_question_has_no_presupposition_to_extract(self) -> None:
        r = classify_and_transform("What was the sample size?")
        assert r.applicable is False
        assert r.category == "NOT_NLI_APPLICABLE"
        assert r.claims == ()


class TestComparatives:
    def test_do_support_comparative_verb(self) -> None:
        r = classify_and_transform("Did Group A outperform Group B?")
        assert r.category == "COMPARATIVE_CLAIM"
        assert r.claims == ("Group A outperformed Group B.",)

    def test_be_verb_comparative_predicate(self) -> None:
        r = classify_and_transform("Was Group A higher than Group B?")
        assert r.category == "COMPARATIVE_CLAIM"
        assert r.claims == ("Group A was higher than Group B.",)

    def test_group_a_single_capital_letter_not_mistaken_for_article(self) -> None:
        # Regression test: an earlier version lowercased "A" before checking
        # against the determiner set, wrongly treating "Group A outperform"
        # as "A" (the article) preceding the verb and declining the whole
        # transformation.
        r = classify_and_transform("Did Group A outperform Group B?")
        assert r.applicable is True


class TestNegation:
    def test_negated_do_support_preserves_polarity(self) -> None:
        r = classify_and_transform("Did the intervention not improve performance?")
        assert r.claims == ("The intervention did not improve performance.",)

    def test_negated_be_verb_preserves_polarity(self) -> None:
        r = classify_and_transform("Was the difference not statistically significant?")
        assert r.claims == ("The difference was not statistically significant.",)

    def test_negation_never_silently_flips_to_affirmative(self) -> None:
        negated = classify_and_transform("Did the training not reduce completion time?")
        affirmative = classify_and_transform("Did the training reduce completion time?")
        assert "not" in negated.claims[0].lower()
        assert "not" not in affirmative.claims[0].lower()

    def test_embedded_negative_clause_extraction_needs_no_retensing(self) -> None:
        r = classify_and_transform(
            "What evidence shows the intervention did not improve performance?"
        )
        assert "did not improve" in r.claims[0]


class TestNumericAndAttributeBypass:
    def test_open_value_numeric_question_declines(self) -> None:
        r = classify_and_transform("How many participants completed the study?")
        assert r.applicable is False

    def test_open_value_attribute_question_declines(self) -> None:
        r = classify_and_transform("What instrument was used to measure outcomes?")
        assert r.applicable is False

    def test_never_invents_a_placeholder_claim(self) -> None:
        # Milestone 9 §3's explicit prohibition — no "[ANSWER]"-style
        # fabricated claim for an unresolvable wh-question.
        r = classify_and_transform("What was the sample size?")
        assert r.claims == ()


class TestMultiClaimExtraction:
    def test_and_conjoined_shared_subject_splits_into_two_claims(self) -> None:
        r = classify_and_transform(
            "Did the intervention improve accuracy and reduce completion time?"
        )
        assert r.applicable and r.category == "MULTI_CLAIM"
        assert r.claims == (
            "The intervention improved accuracy.",
            "The intervention reduced completion time.",
        )

    def test_compound_object_and_is_not_split(self) -> None:
        # "math" after "and" is not a recognized verb -> stays ONE claim.
        r = classify_and_transform("Did the study affect reading and math scores?")
        assert r.category == "BOOLEAN_CLAIM"
        assert r.claim_count == 1
        assert r.claims == ("The study affected reading and math scores.",)

    def test_cross_clause_type_and_conjunction_declines(self) -> None:
        # "and was it cost-effective" starts a whole second interrogative
        # clause with its own auxiliary — must decline, not produce a
        # garbled single claim embedding the leftover fragment.
        r = classify_and_transform("Did the intervention improve scores and was it cost-effective?")
        assert r.applicable is False

    def test_while_conjoined_cross_subject_comparison_declines(self) -> None:
        r = classify_and_transform(
            "Did Study A find an improvement while Study B found no difference?"
        )
        assert r.applicable is False


class TestUnsafeAmbiguousBypass:
    def test_unresolvable_pronoun_declines(self) -> None:
        r = classify_and_transform("Did it work?")
        assert r.applicable is False

    def test_bare_noun_predicate_declines(self) -> None:
        r = classify_and_transform("Was there an effect?")
        assert r.applicable is False

    def test_unrecognized_verb_declines_rather_than_guesses(self) -> None:
        r = classify_and_transform(
            "Did baseline Spanish literacy moderate the cognate-instruction effect?"
        )
        assert r.applicable is False


class TestOpenEndedBypass:
    def test_summarize_bypasses(self) -> None:
        assert classify_and_transform("Summarize this paper.").applicable is False

    def test_compare_bypasses(self) -> None:
        assert classify_and_transform("Compare these three studies.").applicable is False

    def test_design_creative_bypasses(self) -> None:
        assert classify_and_transform("Design a lesson using these findings.").applicable is False

    def test_explain_bypasses(self) -> None:
        assert classify_and_transform("Explain this concept.").applicable is False

    def test_how_should_procedural_bypasses(self) -> None:
        assert classify_and_transform("How should a teacher implement this?").applicable is False

    def test_give_me_ideas_bypasses(self) -> None:
        assert classify_and_transform("Give me ideas.").applicable is False

    def test_write_a_literature_review_bypasses(self) -> None:
        assert classify_and_transform("Write a literature review.").applicable is False

    def test_implications_open_ended_bypasses(self) -> None:
        assert classify_and_transform("What are the major implications?").applicable is False

    def test_empty_question_declines(self) -> None:
        r = classify_and_transform("")
        assert r.applicable is False and r.reason == "empty_question"

    def test_non_question_declines(self) -> None:
        r = classify_and_transform("This is a statement, not a question.")
        assert r.applicable is False and r.reason == "not_a_question"


class TestDeterminismAndSafety:
    def test_deterministic_across_calls(self) -> None:
        q = "Did the intervention improve accuracy and reduce completion time?"
        first = classify_and_transform(q)
        second = classify_and_transform(q)
        assert first == second

    def test_never_returns_claims_when_not_applicable(self) -> None:
        for question in ("What was the sample size?", "Summarize this paper.", ""):
            r = classify_and_transform(question)
            assert r.applicable is False
            assert r.claims == ()

    def test_determiner_regression_the_increase_not_mistaken_for_verb(self) -> None:
        # Regression test: an earlier version mis-selected the noun "the
        # increase" as the main verb since "increase" is also a recognized
        # verb; fixed via the determiner-precedes-candidate skip rule.
        r = classify_and_transform(
            "Does the increase in voluntary practice prove adaptive difficulty "
            "causes higher engagement?"
        )
        assert r.applicable is True
        assert r.claims[0].startswith("The increase in voluntary practice proves")


class TestDatasetIntegrity:
    def test_dataset_meets_minimum_size(self) -> None:
        assert len(CASES) >= 80

    def test_every_required_question_category_present(self) -> None:
        required = {
            "yes_no_factual",
            "presupposition",
            "comparative",
            "negation",
            "numeric",
            "attribute",
            "multi_claim",
            "ambiguous",
            "open_ended",
            "summary",
            "procedural",
            "creative",
            "opinion",
            "multi_document_synthesis",
        }
        assert required <= set(by_category().keys())

    def test_no_duplicate_case_ids(self) -> None:
        ids = [c.case_id for c in CASES]
        assert len(ids) == len(set(ids))

    def test_applicable_cases_have_claims_and_vice_versa(self) -> None:
        for case in CASES:
            if case.gold_applicable:
                assert case.gold_claims, f"{case.case_id}: applicable but no gold claims"
            else:
                assert not case.gold_claims, f"{case.case_id}: not applicable but has gold claims"


class TestEvalHarnessIntegration:
    """Runs the actual harness (scripts/eval_claim_transformer.py) against
    the real dataset — the metric functions are exercised through their
    real call path, not just in isolation, so a regression in how `run()`
    wires case -> transformer -> outcome is caught here too."""

    def test_harness_achieves_near_ceiling_precision_on_its_own_dataset(self) -> None:
        outcomes = run()
        metrics = applicability_metrics(outcomes)
        assert metrics["accuracy"] is not None
        assert metrics["accuracy"] >= 0.95

    def test_unsafe_rate_is_at_or_below_the_milestone_target(self) -> None:
        outcomes = run()
        unsafe = unsafe_transformation_rate(outcomes)
        assert unsafe["unsafe_rate_of_applicable_predictions"] is not None
        assert unsafe["unsafe_rate_of_applicable_predictions"] <= 0.02

    def test_polarity_preservation_is_perfect_on_negation_cases(self) -> None:
        outcomes = run()
        polarity = polarity_preservation(outcomes)
        assert polarity["preservation_rate"] == 1.0

    def test_multi_claim_count_accuracy_is_perfect_on_genuine_multi_claim_cases(self) -> None:
        outcomes = run()
        multi = multi_claim_count_accuracy(outcomes)
        assert multi["accuracy"] == 1.0

    def test_category_confusion_matrix_is_diagonal_on_this_dataset(self) -> None:
        outcomes = run()
        matrix = category_confusion(outcomes)
        for gold, row in matrix.items():
            off_diagonal_sum = sum(v for pred, v in row.items() if pred != gold)
            assert off_diagonal_sum == 0, f"{gold} has off-diagonal confusion: {row}"

    def test_report_is_json_serializable(self) -> None:
        import json

        outcomes = run(CASES[:10])
        report = build_report(outcomes)
        json.dumps(report.to_dict())


class TestRelationAggregation:
    def test_entailment_only_is_supported(self) -> None:
        row = ClaimRelationRow(
            "C1", (SourceRelation("S1", "entailment"), SourceRelation("S2", "neutral"))
        )
        assert aggregate_claim_status(row) == "SUPPORTED"

    def test_contradiction_only_is_contradicted(self) -> None:
        row = ClaimRelationRow("C1", (SourceRelation("S1", "contradiction"),))
        assert aggregate_claim_status(row) == "CONTRADICTED"

    def test_all_neutral_is_unsupported(self) -> None:
        row = ClaimRelationRow(
            "C1", (SourceRelation("S1", "neutral"), SourceRelation("S2", "neutral"))
        )
        assert aggregate_claim_status(row) == "UNSUPPORTED"

    def test_no_sources_is_unsupported(self) -> None:
        row = ClaimRelationRow("C1", ())
        assert aggregate_claim_status(row) == "UNSUPPORTED"

    def test_both_entailment_and_contradiction_is_conflicted(self) -> None:
        row = ClaimRelationRow(
            "C1", (SourceRelation("S1", "entailment"), SourceRelation("S2", "contradiction"))
        )
        assert aggregate_claim_status(row) == "CONFLICTED"

    def test_supporting_and_contradicting_source_ids_are_reported(self) -> None:
        row = ClaimRelationRow(
            "C1",
            (
                SourceRelation("S1", "entailment"),
                SourceRelation("S2", "contradiction"),
                SourceRelation("S3", "neutral"),
            ),
        )
        results = aggregate_claims([row])
        assert results[0].supporting_source_ids == ("S1",)
        assert results[0].contradicting_source_ids == ("S2",)


class TestConflictingSources:
    def test_conflicting_evidence_is_never_silently_collapsed_to_sufficient(self) -> None:
        row = ClaimRelationRow(
            "C1", (SourceRelation("S1", "entailment"), SourceRelation("S2", "contradiction"))
        )
        state = aggregate_evidence_state(aggregate_claims([row]))
        assert state == "CONFLICTED"
        assert state != "SUFFICIENT"

    def test_conflicted_takes_priority_over_contradictory_when_both_present(self) -> None:
        conflicted_claim = ClaimRelationRow(
            "C1", (SourceRelation("S1", "entailment"), SourceRelation("S2", "contradiction"))
        )
        contradicted_claim = ClaimRelationRow("C2", (SourceRelation("S1", "contradiction"),))
        state = aggregate_evidence_state(aggregate_claims([conflicted_claim, contradicted_claim]))
        assert state == "CONFLICTED"


class TestOverallEvidenceStateMapping:
    def test_all_supported_is_sufficient(self) -> None:
        rows = [ClaimRelationRow("C1", (SourceRelation("S1", "entailment"),))]
        assert aggregate_evidence_state(aggregate_claims(rows)) == "SUFFICIENT"

    def test_mixed_supported_and_unsupported_is_partial(self) -> None:
        rows = [
            ClaimRelationRow("C1", (SourceRelation("S1", "entailment"),)),
            ClaimRelationRow("C2", (SourceRelation("S1", "neutral"),)),
        ]
        assert aggregate_evidence_state(aggregate_claims(rows)) == "PARTIAL"

    def test_all_unsupported_is_insufficient(self) -> None:
        rows = [ClaimRelationRow("C1", (SourceRelation("S1", "neutral"),))]
        assert aggregate_evidence_state(aggregate_claims(rows)) == "INSUFFICIENT"

    def test_any_contradicted_claim_is_contradictory(self) -> None:
        rows = [
            ClaimRelationRow("C1", (SourceRelation("S1", "entailment"),)),
            ClaimRelationRow("C2", (SourceRelation("S1", "contradiction"),)),
        ]
        assert aggregate_evidence_state(aggregate_claims(rows)) == "CONTRADICTORY"

    def test_no_claims_is_insufficient(self) -> None:
        assert aggregate_evidence_state([]) == "INSUFFICIENT"

    def test_should_answer_true_only_for_sufficient(self) -> None:
        assert should_answer("SUFFICIENT") is True
        for state in ("PARTIAL", "INSUFFICIENT", "CONTRADICTORY", "CONFLICTED"):
            assert should_answer(state) is False  # type: ignore[arg-type]
