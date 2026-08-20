"""Milestone 6.1 (Writing Context Engine) Parts 2/14/29 — deterministic
intent classification. Directly exercises the spec's own Scenarios A-F /
Part 14's five worked examples, since the classifier is what decides
which layers the engine attempts to build for each."""

from __future__ import annotations

from app.core.writing_context_policy import POLICY_LAYERS, classify_intent


class TestClassifyIntent:
    def test_scenario_a_local_grammar_edit(self) -> None:
        assert classify_intent("Improve the grammar.", has_selection=True) == "local_edit"

    def test_local_edit_make_clearer(self) -> None:
        assert classify_intent("Make this clearer.", has_selection=True) == "local_edit"

    def test_local_edit_make_concise(self) -> None:
        assert classify_intent("Make this concise.", has_selection=True) == "local_edit"

    def test_explanation_what_does_this_mean(self) -> None:
        assert (
            classify_intent("What does this paragraph mean?", has_selection=True) == "explanation"
        )

    def test_scenario_b_manuscript_question_methodology(self) -> None:
        assert (
            classify_intent("Summarize my methodology.", has_selection=False)
            == "manuscript_question"
        )

    def test_scenario_c_reference_question_evidence(self) -> None:
        assert (
            classify_intent("Do I have evidence supporting this?", has_selection=True)
            == "reference_question"
        )

    def test_reference_question_which_reference(self) -> None:
        assert (
            classify_intent("Which of my references supports this statement?", has_selection=True)
            == "reference_question"
        )

    def test_cross_source_synthesis_contradiction(self) -> None:
        assert (
            classify_intent("Do my findings contradict previous research?", has_selection=False)
            == "cross_source_synthesis"
        )

    def test_cross_source_synthesis_compare_literature(self) -> None:
        assert (
            classify_intent("How do my findings compare with the literature?", has_selection=False)
            == "cross_source_synthesis"
        )

    def test_unrecognized_request_with_selection_defaults_local(self) -> None:
        assert classify_intent("asdkfjalksdjf", has_selection=True) == "local_edit"

    def test_unrecognized_request_without_selection_defaults_manuscript_question(self) -> None:
        assert classify_intent("asdkfjalksdjf", has_selection=False) == "manuscript_question"

    def test_case_insensitive(self) -> None:
        assert classify_intent("MAKE THIS CLEARER", has_selection=True) == "local_edit"

    def test_reference_keyword_wins_over_explanation_phrasing(self) -> None:
        # "what evidence" contains both explanation ("what") and
        # reference ("evidence") signals — reference must win, matching
        # this module's own documented check order.
        assert (
            classify_intent("What evidence do I have for this claim?", has_selection=True)
            == "reference_question"
        )


class TestPolicyLayers:
    def test_local_edit_never_pulls_evidence_or_notes(self) -> None:
        layers = POLICY_LAYERS["local_edit"]
        assert layers["evidence"] is False
        assert layers["notes"] is False
        assert layers["highlights"] is False
        assert layers["selection"] is True

    def test_explanation_never_rags(self) -> None:
        assert POLICY_LAYERS["explanation"]["evidence"] is False

    def test_reference_question_pulls_evidence_and_metadata(self) -> None:
        layers = POLICY_LAYERS["reference_question"]
        assert layers["evidence"] is True
        assert layers["reference_metadata"] is True
        assert layers["notes"] is True
        assert layers["highlights"] is True

    def test_cross_source_synthesis_pulls_everything(self) -> None:
        layers = POLICY_LAYERS["cross_source_synthesis"]
        assert all(layers.values())

    def test_manuscript_question_pulls_structure_not_evidence(self) -> None:
        layers = POLICY_LAYERS["manuscript_question"]
        assert layers["project_structure"] is True
        assert layers["evidence"] is False

    def test_every_policy_has_every_layer_key(self) -> None:
        expected_keys = {
            "selection",
            "nearby_text",
            "section",
            "project_structure",
            "notes",
            "highlights",
            "reference_metadata",
            "evidence",
        }
        for policy_layers in POLICY_LAYERS.values():
            assert set(policy_layers.keys()) == expected_keys
