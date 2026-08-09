"""Milestone 9.5 (Polarity-Matched Claim + NLI Validation) — a NEW,
dedicated evaluation dataset built specifically to remove the polarity
confound Milestone 9 §11 found in the M8-derived comparison: M8's
manually-authored hypotheses for several categories (most visibly
"supports_vs_does_not_support") were worded with the OPPOSITE polarity
from what the question naturally implies, so scoring an auto-transformed
(naturally-polarized) claim against a gold label calibrated for the
opposite-polarity manual claim was not a clean measurement.

This module does NOT mutate evaluation/nli_dataset.py or
evaluation/claim_transformation_dataset.py (Milestone 9.5 §1's explicit
instruction) — it is new, standing alongside them.

Construction method: every `expected_natural_claim` below is one of
Milestone 9's own already-verified, already-audited faithful
transformations (evaluation/claim_transformation_dataset.py's
`TransformationCase.gold_claims` — cases where a human, in Milestone 9,
independently determined the claim BEFORE running the transformer, then
confirmed the transformer produces it; see that module's own docstring
for why that ordering matters). Reusing these means the claim's polarity
is already independently audited, not re-derived under time pressure
here.

What is NEW in this module: for each reused claim, 1-3 fresh premises
were selected directly from evaluation/realistic_corpus.py's real M5.7
chunks, and the gold NLI relation (ENTAILMENT/NEUTRAL/CONTRADICTION) for
EACH (claim, premise) pair was determined by re-reading the actual chunk
text fresh — not inherited from any M8 label. Several of these directly
correct the exact polarity-confound Milestone 9 identified: e.g. the
UDL/IEP-inclusion and evidence-supports-X claim families were previously
paired (in M8) with an opposite-polarity hypothesis under a CONTRADICTION
gold label; here, the NATURAL claim ("Students with IEPs were included")
is correctly paired with ENTAILMENT, since the real evidence chunk
states inclusion occurred.

A "family" is a group of cases sharing one claim tested against different
premises (entailing / neutral / contradicting) — deliberately kept
distinct from Milestone 9's own dataset, which tests one question against
one gold answer; here one CLAIM is held fixed while evidence varies, the
correct experimental design for isolating "does transformation preserve
this claim's meaning" from "does NLI correctly relate varying evidence to
a fixed, correctly-polarized claim."
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from evaluation.realistic_corpus import DOCUMENTS_BY_ID

NLIRelation = Literal["entailment", "neutral", "contradiction"]

CATEGORIES: tuple[str, ...] = (
    "yes_no_factual",
    "improvement_decrease",
    "inclusion_exclusion",
    "statistical_significance",
    "method_used_not_used",
    "population_sample",
    "comparison",
    "date_year",
    "causal_claim",
    "correlation_vs_causation",
    "presupposition",
    "negation",
    "numeric_comparison",
    "supports_does_not_support",
)


@dataclass(frozen=True)
class PolarityMatchedCase:
    case_id: str
    question: str
    expected_natural_claim: str
    premise_document_id: str
    premise_chunk_indices: tuple[int, ...]
    gold_relation: NLIRelation
    auto_applicable_expected: bool
    category: str
    topic: str
    rationale: str
    claim_family: str  # groups cases sharing the same claim, tested against different evidence

    def __post_init__(self) -> None:
        if self.category not in CATEGORIES:
            raise ValueError(f"{self.case_id}: unknown category {self.category!r}")
        if self.gold_relation not in ("entailment", "neutral", "contradiction"):
            raise ValueError(f"{self.case_id}: unknown gold_relation {self.gold_relation!r}")
        document = DOCUMENTS_BY_ID.get(self.premise_document_id)
        if document is None:
            raise ValueError(f"{self.case_id}: unknown document {self.premise_document_id!r}")
        for idx in self.premise_chunk_indices:
            if idx < 0 or idx >= len(document.chunks):
                raise ValueError(f"{self.case_id}: chunk index {idx} out of range")

    def premise_text(self) -> str:
        document = DOCUMENTS_BY_ID[self.premise_document_id]
        return " ".join(document.chunks[i].text for i in self.premise_chunk_indices)


CASES: list[PolarityMatchedCase] = [
    # ---- Family: phonics decoding (rc-doc-phonics-rct) ----
    PolarityMatchedCase(
        "PM-001",
        "Did systematic phonics improve decoding compared to embedded phonics?",
        "Systematic phonics improved decoding compared to embedded phonics.",
        "rc-doc-phonics-rct",
        (4,),
        "entailment",
        True,
        "improvement_decrease",
        "reading_science",
        "Chunk 4 states the systematic group scored significantly higher (d=0.58) on decoding.",
        "phonics_decoding",
    ),
    PolarityMatchedCase(
        "PM-002",
        "Did systematic phonics improve decoding compared to embedded phonics?",
        "Systematic phonics improved decoding compared to embedded phonics.",
        "rc-doc-phonics-rct",
        (1,),
        "neutral",
        True,
        "improvement_decrease",
        "reading_science",
        "Chunk 1 is a literature review of PRIOR studies' effect-size ranges — never states "
        "THIS study's own decoding result.",
        "phonics_decoding",
    ),
    # ---- Family: phonics comprehension (same doc — a claim the corpus
    # actually refutes, giving a clean, real CONTRADICTION) ----
    PolarityMatchedCase(
        "PM-003",
        "Did systematic phonics improve listening comprehension compared to embedded phonics?",
        "Systematic phonics improved listening comprehension compared to embedded phonics.",
        "rc-doc-phonics-rct",
        (5,),
        "contradiction",
        True,
        "improvement_decrease",
        "reading_science",
        "Chunk 5 explicitly states no significant between-group difference on comprehension "
        "(p=0.41).",
        "phonics_comprehension",
    ),
    PolarityMatchedCase(
        "PM-004",
        "Did systematic phonics improve listening comprehension compared to embedded phonics?",
        "Systematic phonics improved listening comprehension compared to embedded phonics.",
        "rc-doc-phonics-rct",
        (1,),
        "neutral",
        True,
        "improvement_decrease",
        "reading_science",
        "Literature-review chunk never addresses this study's own comprehension outcome.",
        "phonics_comprehension",
    ),
    # ---- Family: structured literacy decoding ----
    PolarityMatchedCase(
        "PM-005",
        "Did the structured literacy intervention improve decoding more than standard support?",
        "The structured literacy intervention improved decoding more than standard support.",
        "rc-doc-dyslexia-structured-literacy-study",
        (3,),
        "entailment",
        True,
        "improvement_decrease",
        "dyslexia_intervention",
        "Chunk 3: 18.4 vs 6.2 points, d=0.89.",
        "structured_literacy_decoding",
    ),
    PolarityMatchedCase(
        "PM-006",
        "Did the structured literacy intervention improve decoding more than standard support?",
        "The structured literacy intervention improved decoding more than standard support.",
        "rc-doc-dyslexia-structured-literacy-study",
        (1,),
        "neutral",
        True,
        "improvement_decrease",
        "dyslexia_intervention",
        "Literature-review chunk on structured literacy generally, not this study's own numbers.",
        "structured_literacy_decoding",
    ),
    # ---- Family: working-memory math achievement (far transfer) ----
    PolarityMatchedCase(
        "PM-007",
        "Did working-memory training improve math achievement?",
        "Working-memory training improved math achievement.",
        "rc-doc-executive-function-training-study",
        (4,),
        "contradiction",
        True,
        "improvement_decrease",
        "executive_function",
        "Chunk 4: math achievement did not differ significantly (p=0.52) — far-transfer null "
        "result.",
        "wm_math_achievement",
    ),
    PolarityMatchedCase(
        "PM-008",
        "Did working-memory training improve math achievement?",
        "Working-memory training improved math achievement.",
        "rc-doc-executive-function-training-study",
        (0,),
        "neutral",
        True,
        "improvement_decrease",
        "executive_function",
        "Intro chunk frames the research question, states no result either way.",
        "wm_math_achievement",
    ),
    # ---- Family: working-memory near-transfer (trained task itself) ----
    PolarityMatchedCase(
        "PM-009",
        "Did working-memory training improve performance on the trained task?",
        "Working-memory training improved performance on the trained task.",
        "rc-doc-executive-function-training-study",
        (3,),
        "entailment",
        True,
        "improvement_decrease",
        "executive_function",
        "Chunk 3: large near-transfer gain, d=0.81, on the trained working-memory task itself.",
        "wm_near_transfer",
    ),
    PolarityMatchedCase(
        "PM-010",
        "Did working-memory training improve performance on the trained task?",
        "Working-memory training improved performance on the trained task.",
        "rc-doc-executive-function-training-study",
        (0,),
        "neutral",
        True,
        "improvement_decrease",
        "executive_function",
        "Intro chunk, no result yet.",
        "wm_near_transfer",
    ),
    # ---- Family: negation of far-transfer claim (natural negative
    # question, entailed by the SAME null-result chunk) ----
    PolarityMatchedCase(
        "PM-011",
        "Did working-memory training not improve math achievement?",
        "Working-memory training did not improve math achievement.",
        "rc-doc-executive-function-training-study",
        (4,),
        "entailment",
        True,
        "negation",
        "executive_function",
        "Chunk 4's null far-transfer result directly entails the NEGATIVE claim — this is the "
        "natural, polarity-consistent pairing (contrast with PM-007's positive claim against "
        "the same chunk, correctly CONTRADICTION there).",
        "wm_math_negation",
    ),
    PolarityMatchedCase(
        "PM-012",
        "Did working-memory training not improve math achievement?",
        "Working-memory training did not improve math achievement.",
        "rc-doc-executive-function-training-study",
        (3,),
        "neutral",
        True,
        "negation",
        "executive_function",
        "Chunk 3 reports the near-transfer (trained-task) gain, a DIFFERENT construct from "
        "math achievement — it never addresses math achievement either way, so this is "
        "genuinely silent (NEUTRAL), not a contradiction of the negative claim.",
        "wm_math_negation",
    ),
    # ---- Family: PBL content mastery ----
    PolarityMatchedCase(
        "PM-013",
        "Did PBL improve content mastery compared to traditional instruction?",
        "PBL improved content mastery compared to traditional instruction.",
        "rc-doc-pbl-stem-study",
        (3,),
        "contradiction",
        True,
        "improvement_decrease",
        "project_based_learning",
        "Chunk 3: no statistically significant difference in mastery (p=0.29).",
        "pbl_mastery",
    ),
    PolarityMatchedCase(
        "PM-014",
        "Did PBL improve content mastery compared to traditional instruction?",
        "PBL improved content mastery compared to traditional instruction.",
        "rc-doc-pbl-stem-study",
        (0,),
        "neutral",
        True,
        "improvement_decrease",
        "project_based_learning",
        "Intro chunk frames the comparison, no result yet.",
        "pbl_mastery",
    ),
    # ---- Family: PBL motivation ----
    PolarityMatchedCase(
        "PM-015",
        "Did PBL students report higher motivation than traditional-instruction students?",
        "PBL students reported higher motivation than traditional-instruction students.",
        "rc-doc-pbl-stem-study",
        (4,),
        "entailment",
        True,
        "comparison",
        "project_based_learning",
        "Chunk 4: 3.8/5 vs 3.1/5, d=0.51.",
        "pbl_motivation",
    ),
    PolarityMatchedCase(
        "PM-016",
        "Did PBL students report higher motivation than traditional-instruction students?",
        "PBL students reported higher motivation than traditional-instruction students.",
        "rc-doc-pbl-stem-study",
        (0,),
        "neutral",
        True,
        "comparison",
        "project_based_learning",
        "Intro chunk, no motivation result yet.",
        "pbl_motivation",
    ),
    # ---- Family: UDL participation ----
    PolarityMatchedCase(
        "PM-017",
        "Did UDL redesign increase active-participation rates?",
        "UDL redesign increased active-participation rates.",
        "rc-doc-udl-implementation-study",
        (3,),
        "entailment",
        True,
        "improvement_decrease",
        "udl_accessibility",
        "Chunk 3: 61 percent to 79 percent of observed intervals.",
        "udl_participation",
    ),
    PolarityMatchedCase(
        "PM-018",
        "Did UDL redesign increase active-participation rates?",
        "UDL redesign increased active-participation rates.",
        "rc-doc-udl-implementation-study",
        (1,),
        "neutral",
        True,
        "improvement_decrease",
        "udl_accessibility",
        "Literature-review chunk on UDL's premise generally, not this study's own numbers.",
        "udl_participation",
    ),
    # ---- Family: UDL test scores ----
    PolarityMatchedCase(
        "PM-019",
        "Did UDL redesign significantly improve test scores?",
        "UDL redesign significantly improved test scores.",
        "rc-doc-udl-implementation-study",
        (4,),
        "contradiction",
        True,
        "statistical_significance",
        "udl_accessibility",
        "Chunk 4: p=0.18, not statistically significant.",
        "udl_test_scores",
    ),
    PolarityMatchedCase(
        "PM-020",
        "Did UDL redesign significantly improve test scores?",
        "UDL redesign significantly improved test scores.",
        "rc-doc-udl-implementation-study",
        (1,),
        "neutral",
        True,
        "statistical_significance",
        "udl_accessibility",
        "Literature-review chunk, no test-score result yet.",
        "udl_test_scores",
    ),
    # ---- Family: UDL IEP inclusion — THE M9 §11 CONFOUND FIX ----
    PolarityMatchedCase(
        "PM-021",
        "Were students with IEPs included in the UDL study?",
        "Students with IEPs were included in the UDL study.",
        "rc-doc-udl-implementation-study",
        (2,),
        "entailment",
        True,
        "inclusion_exclusion",
        "udl_accessibility",
        "Chunk 2: '376 students, including 58 students with IEPs.' Corrects the exact M9 §11 "
        "confound: M8 had paired the OPPOSITE-polarity hypothesis ('...were excluded...') with "
        "a CONTRADICTION label; the natural, question-faithful claim here is ENTAILMENT.",
        "udl_iep_inclusion",
    ),
    PolarityMatchedCase(
        "PM-022",
        "Were students with IEPs included in the UDL study?",
        "Students with IEPs were included in the UDL study.",
        "rc-doc-udl-implementation-study",
        (0,),
        "neutral",
        True,
        "inclusion_exclusion",
        "udl_accessibility",
        "Intro chunk never mentions IEP status at all.",
        "udl_iep_inclusion",
    ),
    # ---- Family: growth mindset overall GPA ----
    PolarityMatchedCase(
        "PM-023",
        "Did the growth-mindset intervention improve overall GPA?",
        "The growth-mindset intervention improved overall GPA.",
        "rc-doc-growth-mindset-study",
        (3,),
        "contradiction",
        True,
        "improvement_decrease",
        "growth_mindset",
        "Chunk 3: mean GPA did not differ significantly (p=0.34) on average.",
        "growth_mindset_overall_gpa",
    ),
    PolarityMatchedCase(
        "PM-024",
        "Did the growth-mindset intervention improve overall GPA?",
        "The growth-mindset intervention improved overall GPA.",
        "rc-doc-growth-mindset-study",
        (0,),
        "neutral",
        True,
        "improvement_decrease",
        "growth_mindset",
        "Intro chunk, no result yet.",
        "growth_mindset_overall_gpa",
    ),
    # ---- Family: growth mindset subgroup ----
    PolarityMatchedCase(
        "PM-025",
        "Did the growth-mindset intervention improve GPA for the low-prior-GPA subgroup?",
        "The growth-mindset intervention improved GPA for the low-prior-GPA subgroup.",
        "rc-doc-growth-mindset-study",
        (4,),
        "entailment",
        True,
        "improvement_decrease",
        "growth_mindset",
        "Chunk 4: subgroup with prior GPA below 2.0 showed a significant +0.18 advantage.",
        "growth_mindset_subgroup",
    ),
    PolarityMatchedCase(
        "PM-026",
        "Did the growth-mindset intervention improve GPA for the low-prior-GPA subgroup?",
        "The growth-mindset intervention improved GPA for the low-prior-GPA subgroup.",
        "rc-doc-growth-mindset-study",
        (0,),
        "neutral",
        True,
        "improvement_decrease",
        "growth_mindset",
        "Intro chunk, no subgroup result yet.",
        "growth_mindset_subgroup",
    ),
    # ---- Family: daily formative checks ----
    PolarityMatchedCase(
        "PM-027",
        "Did daily formative checks improve unit-test scores?",
        "Daily formative checks improved unit-test scores.",
        "rc-doc-formative-assessment-study",
        (3,),
        "entailment",
        True,
        "improvement_decrease",
        "formative_assessment",
        "Chunk 3: 7.8 points higher, d=0.44.",
        "formative_checks_scores",
    ),
    PolarityMatchedCase(
        "PM-028",
        "Did daily formative checks improve unit-test scores?",
        "Daily formative checks improved unit-test scores.",
        "rc-doc-formative-assessment-study",
        (1,),
        "neutral",
        True,
        "improvement_decrease",
        "formative_assessment",
        "Literature-review chunk, not this study's own result.",
        "formative_checks_scores",
    ),
    # ---- Family: formative-assessment blinding (method/methodology) ----
    PolarityMatchedCase(
        "PM-029",
        "Was the formative-assessment study fully blinded with no confounds?",
        "The formative-assessment study was fully blinded with no confounds.",
        "rc-doc-formative-assessment-study",
        (6,),
        "contradiction",
        True,
        "method_used_not_used",
        "formative_assessment",
        "Chunk 6: teachers were not blinded, and daily-check teachers got extra planning time.",
        "formative_blinding",
    ),
    PolarityMatchedCase(
        "PM-030",
        "Was the formative-assessment study fully blinded with no confounds?",
        "The formative-assessment study was fully blinded with no confounds.",
        "rc-doc-formative-assessment-study",
        (1,),
        "neutral",
        True,
        "method_used_not_used",
        "formative_assessment",
        "Literature-review chunk never addresses this study's own blinding.",
        "formative_blinding",
    ),
    # ---- Family: UDL evaluation method (qualitative interviews) ----
    PolarityMatchedCase(
        "PM-031",
        "Was UDL redesign evaluated using qualitative interviews?",
        "UDL redesign was evaluated using qualitative interviews.",
        "rc-doc-udl-implementation-study",
        (2,),
        "contradiction",
        True,
        "method_used_not_used",
        "udl_accessibility",
        "Chunk 2: participation measured via classroom observation checklists, not interviews.",
        "udl_method_interviews",
    ),
    PolarityMatchedCase(
        "PM-032",
        "Was UDL redesign evaluated using qualitative interviews?",
        "UDL redesign was evaluated using qualitative interviews.",
        "rc-doc-udl-implementation-study",
        (0,),
        "neutral",
        True,
        "method_used_not_used",
        "udl_accessibility",
        "Intro chunk, no methodology detail yet.",
        "udl_method_interviews",
    ),
    # ---- Family: population/sample — dyslexia intervention grade level ----
    PolarityMatchedCase(
        "PM-033",
        "Was the structured literacy intervention tested on high-school students?",
        "The structured literacy intervention was tested on high-school students.",
        "rc-doc-dyslexia-structured-literacy-study",
        (2,),
        "contradiction",
        True,
        "population_sample",
        "dyslexia_intervention",
        "Chunk 2 specifies third-grade students, not high school.",
        "dyslexia_population",
    ),
    PolarityMatchedCase(
        "PM-034",
        "Was the structured literacy intervention tested on high-school students?",
        "The structured literacy intervention was tested on high-school students.",
        "rc-doc-dyslexia-structured-literacy-study",
        (1,),
        "neutral",
        True,
        "population_sample",
        "dyslexia_intervention",
        "Literature-review chunk, no population specifics for this study.",
        "dyslexia_population",
    ),
    # ---- Family: population/sample — growth mindset grade level ----
    PolarityMatchedCase(
        "PM-035",
        "Was the growth-mindset study conducted with elementary-school students?",
        "The growth-mindset study was conducted with elementary-school students.",
        "rc-doc-growth-mindset-study",
        (2,),
        "contradiction",
        True,
        "population_sample",
        "growth_mindset",
        "Chunk 2 specifies incoming ninth-grade students, not elementary.",
        "growth_mindset_population",
    ),
    PolarityMatchedCase(
        "PM-036",
        "Was the growth-mindset study conducted with elementary-school students?",
        "The growth-mindset study was conducted with elementary-school students.",
        "rc-doc-growth-mindset-study",
        (0,),
        "neutral",
        True,
        "population_sample",
        "growth_mindset",
        "Intro chunk, no population specifics beyond 'ninth grade transitioning' framing "
        "absent from this particular chunk slice.",
        "growth_mindset_population",
    ),
    # ---- Family: comparison — daily checks narrow achievement gap ----
    PolarityMatchedCase(
        "PM-037",
        "Did daily checks narrow the achievement gap more than weekly quizzes?",
        "Daily checks narrowed the achievement gap more than weekly quizzes.",
        "rc-doc-formative-assessment-study",
        (4,),
        "entailment",
        True,
        "comparison",
        "formative_assessment",
        "Chunk 4: gap narrowed ~1/3 in daily-check classrooms, did not narrow in weekly-quiz "
        "classrooms.",
        "formative_gap_comparison",
    ),
    PolarityMatchedCase(
        "PM-038",
        "Did daily checks narrow the achievement gap more than weekly quizzes?",
        "Daily checks narrowed the achievement gap more than weekly quizzes.",
        "rc-doc-formative-assessment-study",
        (1,),
        "neutral",
        True,
        "comparison",
        "formative_assessment",
        "Literature-review chunk, no gap-comparison result yet.",
        "formative_gap_comparison",
    ),
    # ---- Family: comparison — spacing schedules ----
    PolarityMatchedCase(
        "PM-039",
        "Did expanding-interval spacing outperform fixed-interval spacing?",
        "Expanding-interval spacing outperformed fixed-interval spacing.",
        "rc-doc-spaced-repetition-meta",
        (4,),
        "entailment",
        True,
        "comparison",
        "spaced_repetition",
        "Chunk 4: d=0.71 (expanding) vs d=0.54 (fixed).",
        "spacing_schedule_comparison",
    ),
    PolarityMatchedCase(
        "PM-040",
        "Did expanding-interval spacing outperform fixed-interval spacing?",
        "Expanding-interval spacing outperformed fixed-interval spacing.",
        "rc-doc-spaced-repetition-meta",
        (1,),
        "neutral",
        True,
        "comparison",
        "spaced_repetition",
        "Literature-review chunk, no schedule-comparison result yet.",
        "spacing_schedule_comparison",
    ),
    # ---- Family: date/year — meta-analysis span ----
    PolarityMatchedCase(
        "PM-041",
        "Did the pooled studies span 1990 to 2019?",
        "The pooled studies spanned 1990 to 2019.",
        "rc-doc-spaced-repetition-meta",
        (2,),
        "entailment",
        False,
        "date_year",
        "spaced_repetition",
        "Chunk 2 states this range directly. auto_applicable_expected corrected to False "
        "during the §17 ground-truth audit: 'span' is not in claim_transformer.py's "
        "_KNOWN_VERBS, so the live transformer correctly declines this question — the "
        "initial dataset draft wrongly assumed it would transform without re-checking "
        "against the live transformer. Per Milestone 9.5 §18, the transformer's vocabulary "
        "was NOT expanded to make this pass; the dataset's own expectation was corrected "
        "instead.",
        "meta_analysis_date_range",
    ),
    PolarityMatchedCase(
        "PM-042",
        "Did the pooled studies span 1950 to 1980?",
        "The pooled studies spanned 1950 to 1980.",
        "rc-doc-spaced-repetition-meta",
        (2,),
        "contradiction",
        False,
        "date_year",
        "spaced_repetition",
        "Chunk 2 states 1990-2019 explicitly — a fabricated, wrong date range. Deliberately "
        "its own claim family (not 'meta_analysis_date_range'): this is a genuinely different "
        "proposition from PM-041/043's true-range claim, not the same claim against varying "
        "evidence — conflating the two would violate this dataset's own family design. Same "
        "auto_applicable_expected correction as PM-041 ('span' not in the verb vocabulary).",
        "meta_analysis_wrong_date_range",
    ),
    PolarityMatchedCase(
        "PM-043",
        "Did the pooled studies span 1990 to 2019?",
        "The pooled studies spanned 1990 to 2019.",
        "rc-doc-spaced-repetition-meta",
        (0,),
        "neutral",
        False,
        "date_year",
        "spaced_repetition",
        "Intro chunk never states the date range. Same auto_applicable_expected correction "
        "as PM-041.",
        "meta_analysis_date_range",
    ),
    # ---- Family: causal claim — adaptive learning engagement ----
    PolarityMatchedCase(
        "PM-044",
        "Is the engagement gain in the adaptive-learning study caused by a change in teacher "
        "instruction?",
        "The engagement gain in the adaptive-learning study is caused by a change in teacher "
        "instruction.",
        "rc-doc-adaptive-learning-study",
        (5,),
        "contradiction",
        False,
        "causal_claim",
        "ai_education",
        "Chunk 5 explicitly attributes the gain to reduced frustration/boredom, NOT to any "
        "change in teacher instruction. auto_applicable_expected corrected to False during "
        "the §17 audit: 'caused' is not in claim_transformer.py's _KNOWN_PARTICIPLES, so the "
        "'Is X caused by Y?' predicate-trigger scan does not fire — a real, disclosed "
        "coverage gap, not expanded to make this case pass (Milestone 9.5 §18).",
        "adaptive_learning_causal",
    ),
    PolarityMatchedCase(
        "PM-045",
        "Is the engagement gain in the adaptive-learning study caused by a change in teacher "
        "instruction?",
        "The engagement gain in the adaptive-learning study is caused by a change in teacher "
        "instruction.",
        "rc-doc-adaptive-learning-study",
        (2,),
        "neutral",
        False,
        "causal_claim",
        "ai_education",
        "Methods chunk, no causal attribution given here. Same auto_applicable_expected "
        "correction as PM-044.",
        "adaptive_learning_causal",
    ),
    # ---- Family: correlation vs causation — adaptive difficulty ----
    PolarityMatchedCase(
        "PM-046",
        "Does the increase in voluntary practice prove adaptive difficulty causes higher "
        "engagement?",
        "The increase in voluntary practice proves adaptive difficulty causes higher engagement.",
        "rc-doc-adaptive-learning-study",
        (6,),
        "contradiction",
        True,
        "correlation_vs_causation",
        "ai_education",
        "Chunk 6: the study could not separate the adaptive algorithm's effect from novelty "
        "effects — undermines a 'proves...causes' claim.",
        "adaptive_learning_correlation",
    ),
    PolarityMatchedCase(
        "PM-047",
        "Does the increase in voluntary practice prove adaptive difficulty causes higher "
        "engagement?",
        "The increase in voluntary practice proves adaptive difficulty causes higher engagement.",
        "rc-doc-adaptive-learning-study",
        (2,),
        "neutral",
        True,
        "correlation_vs_causation",
        "ai_education",
        "Methods chunk, no causal-proof claim addressed here.",
        "adaptive_learning_correlation",
    ),
    # ---- Family: correlation vs causation — cognate instruction ----
    PolarityMatchedCase(
        "PM-048",
        "Does higher Spanish literacy prove cognate instruction causes larger vocabulary gains?",
        "Higher Spanish literacy proves cognate instruction causes larger vocabulary gains.",
        "rc-doc-academic-vocabulary-study",
        (4,),
        "contradiction",
        True,
        "correlation_vs_causation",
        "multilingual_learners",
        "Chunk 4 reports an association/moderator finding, never a proven causal claim.",
        "vocabulary_correlation",
    ),
    PolarityMatchedCase(
        "PM-049",
        "Does higher Spanish literacy prove cognate instruction causes larger vocabulary gains?",
        "Higher Spanish literacy proves cognate instruction causes larger vocabulary gains.",
        "rc-doc-academic-vocabulary-study",
        (2,),
        "neutral",
        True,
        "correlation_vs_causation",
        "multilingual_learners",
        "Methods chunk, no causal-proof claim addressed here.",
        "vocabulary_correlation",
    ),
    # ---- Family: presupposition — translanguaging test scores ----
    PolarityMatchedCase(
        "PM-050",
        "How much did translanguaging strategies increase test scores?",
        "Translanguaging strategies increased test scores.",
        "rc-doc-translanguaging-guide",
        (5,),
        "neutral",
        True,
        "presupposition",
        "multilingual_learners",
        "Ground-truth audit correction: chunk 5 states the guide is scoped as a strategy "
        "handbook that reports no effect sizes or outcome data of its own — this is a "
        "statement about the DOCUMENT's scope (silence), not an explicit finding that scores "
        "did not increase. An earlier draft of this case mislabeled it CONTRADICTION; 'no "
        "data reported' does not entail 'the claimed effect is false', only that this source "
        "cannot speak to it — corrected to NEUTRAL during the mandated ground-truth audit "
        "(Milestone 9.5 §17), exactly the kind of error that audit exists to catch.",
        "translanguaging_presupposition",
    ),
    PolarityMatchedCase(
        "PM-051",
        "How much did translanguaging strategies increase test scores?",
        "Translanguaging strategies increased test scores.",
        "rc-doc-translanguaging-guide",
        (1,),
        "neutral",
        True,
        "presupposition",
        "multilingual_learners",
        "Chunk 1 defines a translanguaging space conceptually, never addresses test scores.",
        "translanguaging_presupposition",
    ),
    # ---- Family: presupposition — UDL engagement after redesign ----
    PolarityMatchedCase(
        "PM-052",
        "Why did engagement increase after the UDL redesign?",
        "Engagement increased after the UDL redesign.",
        "rc-doc-udl-implementation-study",
        (3,),
        "entailment",
        True,
        "presupposition",
        "udl_accessibility",
        "Chunk 3's participation-rate increase directly entails the presupposed engagement rise.",
        "udl_engagement_presupposition",
    ),
    PolarityMatchedCase(
        "PM-053",
        "Why did engagement increase after the UDL redesign?",
        "Engagement increased after the UDL redesign.",
        "rc-doc-udl-implementation-study",
        (1,),
        "neutral",
        True,
        "presupposition",
        "udl_accessibility",
        "Literature-review chunk, no engagement result yet.",
        "udl_engagement_presupposition",
    ),
    # ---- Family: presupposition — spaced practice retention ----
    PolarityMatchedCase(
        "PM-054",
        "How much did spaced practice improve long-term retention?",
        "Spaced practice improved long-term retention.",
        "rc-doc-spaced-repetition-meta",
        (3,),
        "entailment",
        True,
        "presupposition",
        "spaced_repetition",
        "Chunk 3: pooled effect size d=0.62 favoring spaced practice on retention.",
        "spaced_practice_presupposition",
    ),
    PolarityMatchedCase(
        "PM-055",
        "How much did spaced practice improve long-term retention?",
        "Spaced practice improved long-term retention.",
        "rc-doc-spaced-repetition-meta",
        (0,),
        "neutral",
        True,
        "presupposition",
        "spaced_repetition",
        "Intro chunk, no retention result yet.",
        "spaced_practice_presupposition",
    ),
    # ---- Family: negation — guide does not recommend person praise ----
    PolarityMatchedCase(
        "PM-056",
        "Does the guide not recommend person praise?",
        "The guide does not recommend person praise.",
        "rc-doc-growth-mindset-language-guide",
        (1,),
        "entailment",
        True,
        "negation",
        "growth_mindset",
        "Chunk 1: 'process praise recommended OVER person praise' entails person praise is "
        "not recommended.",
        "growth_mindset_praise_negation",
    ),
    PolarityMatchedCase(
        "PM-057",
        "Does the guide not recommend person praise?",
        "The guide does not recommend person praise.",
        "rc-doc-growth-mindset-language-guide",
        (0,),
        "neutral",
        True,
        "negation",
        "growth_mindset",
        "Overview chunk, no specific praise-type recommendation yet.",
        "growth_mindset_praise_negation",
    ),
    # ---- Family: negation — was not excluded (positive framing test,
    # mirrors the PM-021 family with explicit negative-question phrasing) ----
    PolarityMatchedCase(
        "PM-058",
        "Were students with IEPs not included in the UDL study?",
        "Students with IEPs were not included in the UDL study.",
        "rc-doc-udl-implementation-study",
        (2,),
        "contradiction",
        True,
        "negation",
        "udl_accessibility",
        "Chunk 2 states 58 IEP students WERE included — directly contradicts the negative claim.",
        "udl_iep_negation",
    ),
    PolarityMatchedCase(
        "PM-059",
        "Were students with IEPs not included in the UDL study?",
        "Students with IEPs were not included in the UDL study.",
        "rc-doc-udl-implementation-study",
        (0,),
        "neutral",
        True,
        "negation",
        "udl_accessibility",
        "Intro chunk never mentions IEP status.",
        "udl_iep_negation",
    ),
    # ---- Family: supports/does-not-support — UDL participation (M9 §11
    # confound-category fix #2) ----
    PolarityMatchedCase(
        "PM-060",
        "Does the evidence support a participation improvement?",
        "The evidence supports a participation improvement.",
        "rc-doc-udl-implementation-study",
        (3,),
        "entailment",
        True,
        "supports_does_not_support",
        "udl_accessibility",
        "Chunk 3's large, stated participation increase directly supports this claim — "
        "corrects the M9 §11 confound where M8's opposite-polarity hypothesis was scored "
        "CONTRADICTION.",
        "udl_supports_participation",
    ),
    PolarityMatchedCase(
        "PM-061",
        "Does the evidence support a participation improvement?",
        "The evidence supports a participation improvement.",
        "rc-doc-udl-implementation-study",
        (1,),
        "neutral",
        True,
        "supports_does_not_support",
        "udl_accessibility",
        "Literature-review chunk, no participation result yet.",
        "udl_supports_participation",
    ),
    # ---- Family: supports/does-not-support — formative test-score benefit ----
    PolarityMatchedCase(
        "PM-062",
        "Does the evidence support a test-score benefit?",
        "The evidence supports a test-score benefit.",
        "rc-doc-formative-assessment-study",
        (3,),
        "entailment",
        True,
        "supports_does_not_support",
        "formative_assessment",
        "Chunk 3's 7.8-point, d=0.44 benefit directly supports this claim.",
        "formative_supports_benefit",
    ),
    PolarityMatchedCase(
        "PM-063",
        "Does the evidence support a test-score benefit?",
        "The evidence supports a test-score benefit.",
        "rc-doc-formative-assessment-study",
        (1,),
        "neutral",
        True,
        "supports_does_not_support",
        "formative_assessment",
        "Literature-review chunk, no test-score result yet.",
        "formative_supports_benefit",
    ),
    # ---- Family: supports/does-not-support — growth-mindset GPA (still a
    # genuine null on the OVERALL sample — natural CONTRADICTION, not a
    # confound case, kept for contrast) ----
    PolarityMatchedCase(
        "PM-064",
        "Does the evidence support a GPA benefit for the overall sample?",
        "The evidence supports a GPA benefit for the overall sample.",
        "rc-doc-growth-mindset-study",
        (3,),
        "contradiction",
        True,
        "supports_does_not_support",
        "growth_mindset",
        "Chunk 3: no significant difference on average (p=0.34) — genuinely does not support "
        "an overall-sample benefit (contrast with PM-025's subgroup-scoped claim, correctly "
        "ENTAILMENT for that narrower claim).",
        "growth_mindset_supports_overall",
    ),
    PolarityMatchedCase(
        "PM-065",
        "Does the evidence support a GPA benefit for the overall sample?",
        "The evidence supports a GPA benefit for the overall sample.",
        "rc-doc-growth-mindset-study",
        (0,),
        "neutral",
        True,
        "supports_does_not_support",
        "growth_mindset",
        "Intro chunk, no GPA result yet.",
        "growth_mindset_supports_overall",
    ),
    # ---- Family: numeric comparison — sample size ----
    PolarityMatchedCase(
        "PM-066",
        "Was the UDL study's sample size larger than 300?",
        "The UDL study's sample size was larger than 300.",
        "rc-doc-udl-implementation-study",
        (2,),
        "entailment",
        True,
        "numeric_comparison",
        "udl_accessibility",
        "Chunk 2: n=376, larger than 300.",
        "udl_sample_size",
    ),
    PolarityMatchedCase(
        "PM-067",
        "Was the UDL study's sample size smaller than 100?",
        "The UDL study's sample size was smaller than 100.",
        "rc-doc-udl-implementation-study",
        (2,),
        "contradiction",
        True,
        "numeric_comparison",
        "udl_accessibility",
        "Chunk 2: n=376, not smaller than 100 — direct numeric contradiction. Its own family "
        "(a different proposition from PM-066/068's 'larger than 300' claim).",
        "udl_sample_size_smaller_than_100",
    ),
    PolarityMatchedCase(
        "PM-068",
        "Was the UDL study's sample size larger than 300?",
        "The UDL study's sample size was larger than 300.",
        "rc-doc-udl-implementation-study",
        (0,),
        "neutral",
        True,
        "numeric_comparison",
        "udl_accessibility",
        "Intro chunk never states the sample size.",
        "udl_sample_size",
    ),
    # ---- Family: statistical significance — spaced repetition K-12 study base ----
    PolarityMatchedCase(
        "PM-069",
        "Are K-12 implementations well studied relative to lab studies?",
        "K-12 implementations are well studied relative to lab studies.",
        "rc-doc-spaced-repetition-meta",
        (6,),
        "contradiction",
        True,
        "statistical_significance",
        "spaced_repetition",
        "Chunk 6: fewer than 15 percent of pooled studies were K-12 classroom settings — "
        "explicitly understudied, not well studied.",
        "spacing_k12_coverage",
    ),
    PolarityMatchedCase(
        "PM-070",
        "Are K-12 implementations well studied relative to lab studies?",
        "K-12 implementations are well studied relative to lab studies.",
        "rc-doc-spaced-repetition-meta",
        (0,),
        "neutral",
        True,
        "statistical_significance",
        "spaced_repetition",
        "Intro chunk, no K-12-coverage statement yet.",
        "spacing_k12_coverage",
    ),
    # ---- Family: comparison — treatment vs control group size (dyslexia) ----
    PolarityMatchedCase(
        "PM-071",
        "Was the treatment group larger than the control group?",
        "The treatment group was larger than the control group.",
        "rc-doc-dyslexia-structured-literacy-study",
        (2,),
        "entailment",
        True,
        "numeric_comparison",
        "dyslexia_intervention",
        "Chunk 2: intervention n=49 vs standard-support n=47 — treatment is (narrowly) larger.",
        "dyslexia_group_sizes",
    ),
    PolarityMatchedCase(
        "PM-072",
        "Was the treatment group larger than the control group?",
        "The treatment group was larger than the control group.",
        "rc-doc-dyslexia-structured-literacy-study",
        (1,),
        "neutral",
        True,
        "numeric_comparison",
        "dyslexia_intervention",
        "Literature-review chunk, no group-size figures here.",
        "dyslexia_group_sizes",
    ),
    # ---- Family: cognate instruction vocabulary gains ----
    PolarityMatchedCase(
        "PM-073",
        "Did cognate instruction increase vocabulary scores more than the standard curriculum?",
        "Cognate instruction increased vocabulary scores more than the standard curriculum.",
        "rc-doc-academic-vocabulary-study",
        (3,),
        "entailment",
        True,
        "comparison",
        "multilingual_learners",
        "Chunk 3: 11.3 points vs 6.1 points.",
        "vocabulary_comparison",
    ),
    PolarityMatchedCase(
        "PM-074",
        "Did cognate instruction increase vocabulary scores more than the standard curriculum?",
        "Cognate instruction increased vocabulary scores more than the standard curriculum.",
        "rc-doc-academic-vocabulary-study",
        (1,),
        "neutral",
        True,
        "comparison",
        "multilingual_learners",
        "Literature-review chunk, no result yet.",
        "vocabulary_comparison",
    ),
    # ---- Family: method used — RCT design (UDL, different claim from PM-031) ----
    PolarityMatchedCase(
        "PM-075",
        "Did the UDL implementation study use a randomized controlled trial design?",
        "The UDL implementation study used a randomized controlled trial design.",
        "rc-doc-udl-implementation-study",
        (2,),
        "contradiction",
        True,
        "method_used_not_used",
        "udl_accessibility",
        "Chunk 2 describes classroom redesign measured via observation checklists — an "
        "observational design, no randomization described.",
        "udl_method_rct",
    ),
    PolarityMatchedCase(
        "PM-076",
        "Did the UDL implementation study use a randomized controlled trial design?",
        "The UDL implementation study used a randomized controlled trial design.",
        "rc-doc-udl-implementation-study",
        (0,),
        "neutral",
        True,
        "method_used_not_used",
        "udl_accessibility",
        "Intro chunk, no methodology detail yet.",
        "udl_method_rct",
    ),
    # ---- Family: statistical significance — daily formative checks d=0.44 ----
    PolarityMatchedCase(
        "PM-077",
        "Was the daily-formative-check advantage statistically significant?",
        "The daily-formative-check advantage was statistically significant.",
        "rc-doc-formative-assessment-study",
        (3,),
        "entailment",
        True,
        "statistical_significance",
        "formative_assessment",
        "Chunk 3 reports d=0.44 as a stated, reportable effect (treated as significant per "
        "the study's own framing of the 7.8-point difference).",
        "formative_significance",
    ),
    PolarityMatchedCase(
        "PM-078",
        "Was the daily-formative-check advantage statistically significant?",
        "The daily-formative-check advantage was statistically significant.",
        "rc-doc-formative-assessment-study",
        (1,),
        "neutral",
        True,
        "statistical_significance",
        "formative_assessment",
        "Literature-review chunk, no significance result yet.",
        "formative_significance",
    ),
    # ---- Family: population/sample — UDL IEP count specific number ----
    PolarityMatchedCase(
        "PM-079",
        "Did the UDL study include exactly 58 students with IEPs?",
        "The UDL study included exactly 58 students with IEPs.",
        "rc-doc-udl-implementation-study",
        (2,),
        "entailment",
        False,
        "population_sample",
        "udl_accessibility",
        "Chunk 2 states this figure directly. auto_applicable_expected corrected to False "
        "during the §17 audit: 'include' is not in claim_transformer.py's _KNOWN_VERBS, so "
        "the DO-support scan does not fire — a real, disclosed coverage gap, not expanded to "
        "make this case pass (Milestone 9.5 §18).",
        "udl_iep_count",
    ),
    PolarityMatchedCase(
        "PM-080",
        "Did the UDL study include exactly 120 students with IEPs?",
        "The UDL study included exactly 120 students with IEPs.",
        "rc-doc-udl-implementation-study",
        (2,),
        "contradiction",
        False,
        "population_sample",
        "udl_accessibility",
        "Chunk 2 states 58, not 120 — a fabricated wrong number. Its own family (a different "
        "proposition from PM-079's true-count claim). Same auto_applicable_expected "
        "correction as PM-079 ('include' not in the verb vocabulary).",
        "udl_iep_count_wrong",
    ),
    # ---- Family: correlation vs causation control (a case with NO
    # correlation claim at all, testing that unrelated evidence is
    # correctly NEUTRAL rather than falsely flagged) ----
    PolarityMatchedCase(
        "PM-081",
        "Does higher Spanish literacy prove cognate instruction causes larger vocabulary gains?",
        "Higher Spanish literacy proves cognate instruction causes larger vocabulary gains.",
        "rc-doc-translanguaging-guide",
        (1,),
        "neutral",
        True,
        "correlation_vs_causation",
        "multilingual_learners",
        "A different document's chunk, topically related (multilingual learners) but never "
        "addresses this specific causal claim — tests that NLI doesn't over-fire on topic "
        "proximity alone.",
        "vocabulary_correlation_crossdoc_neutral",
    ),
    # ---- Family: negation numeric (sample size not-42 style, echoing the
    # M6/M7 wrong-numerical-detail pattern under polarity-consistent framing) ----
    PolarityMatchedCase(
        "PM-082",
        "Was the UDL study's sample size not 376?",
        "The UDL study's sample size was not 376.",
        "rc-doc-udl-implementation-study",
        (2,),
        "contradiction",
        True,
        "negation",
        "udl_accessibility",
        "Chunk 2 states exactly 376 — directly contradicts the negative numeric claim.",
        "udl_sample_size_negation_376",
    ),
    PolarityMatchedCase(
        "PM-083",
        "Was the UDL study's sample size not 100?",
        "The UDL study's sample size was not 100.",
        "rc-doc-udl-implementation-study",
        (2,),
        "entailment",
        True,
        "negation",
        "udl_accessibility",
        "Chunk 2 states 376 (not 100) — entails the negative claim that it wasn't 100. Its own "
        "family (a different proposition from PM-082's 'not 376' claim).",
        "udl_sample_size_negation_100",
    ),
    # ---- Family: plain yes/no factual (no more specific subcategory
    # fits — a simple direct-recommendation fact) ----
    PolarityMatchedCase(
        "PM-084",
        "Does the guide recommend process praise over person praise?",
        "The guide recommends process praise over person praise.",
        "rc-doc-growth-mindset-language-guide",
        (1,),
        "entailment",
        True,
        "yes_no_factual",
        "growth_mindset",
        "Chunk 1 states this directly.",
        "growth_mindset_praise_recommendation",
    ),
    PolarityMatchedCase(
        "PM-085",
        "Does the guide recommend process praise over person praise?",
        "The guide recommends process praise over person praise.",
        "rc-doc-growth-mindset-language-guide",
        (0,),
        "neutral",
        True,
        "yes_no_factual",
        "growth_mindset",
        "Overview chunk, no specific recommendation given yet.",
        "growth_mindset_praise_recommendation",
    ),
    PolarityMatchedCase(
        "PM-086",
        "Was the systematic phonics condition delivered for 25 minutes daily?",
        "The systematic phonics condition was delivered for 25 minutes daily.",
        "rc-doc-phonics-rct",
        (3,),
        "entailment",
        True,
        "yes_no_factual",
        "reading_science",
        "Chunk 3 states this directly.",
        "phonics_daily_duration",
    ),
    PolarityMatchedCase(
        "PM-087",
        "Was the systematic phonics condition delivered for 25 minutes daily?",
        "The systematic phonics condition was delivered for 25 minutes daily.",
        "rc-doc-phonics-rct",
        (0,),
        "neutral",
        True,
        "yes_no_factual",
        "reading_science",
        "Intro chunk frames the research question, no duration figure given.",
        "phonics_daily_duration",
    ),
]


# ---------------------------------------------------------------------------
# Milestone 9.6 holdout expansion — M9.5's holdout had only 4 CONTRADICTION
# cases, too small for a stable readiness decision (Milestone 9.6 "Holdout"
# section). These 18 new cases draw on 8 previously-unused M5.7 documents
# (evaluation/realistic_corpus.py) to add real, non-trivial contradiction
# coverage without duplicating any existing claim/evidence pair. Every
# question was checked against the live transformer before being added —
# several initial phrasings were declined (unrecognized verbs like "teach",
# "consider", "have", "take", or the "Should...?" auxiliary) and were
# rephrased to use already-recognized verbs/patterns rather than expanding
# the transformer's vocabulary, per Milestone 9.6's explicit "do not expand
# transformer coverage" instruction. One genuine transformer bug was found
# in the process (a missing consonant-doubling rule: "flag" -> "flaged"
# instead of "flagged") and is disclosed here, NOT fixed, since fixing it
# would itself be prohibited "grammar pattern" work for this milestone —
# the affected verb was simply avoided in this batch's phrasing instead.
# ---------------------------------------------------------------------------

CASES += [
    PolarityMatchedCase(
        "PM-088",
        "Does the review conclude balanced literacy is completely ineffective?",
        "The review concludes balanced literacy is completely ineffective.",
        "rc-doc-balanced-literacy-review",
        (5,),
        "contradiction",
        True,
        "supports_does_not_support",
        "reading_science",
        "Chunk 5 explicitly states balanced literacy is NOT inherently ineffective, only that "
        "three-cueing specifically should be phased out.",
        "balanced_literacy_verdict",
    ),
    PolarityMatchedCase(
        "PM-089",
        "Does the review conclude balanced literacy is completely ineffective?",
        "The review concludes balanced literacy is completely ineffective.",
        "rc-doc-balanced-literacy-review",
        (1,),
        "neutral",
        True,
        "supports_does_not_support",
        "reading_science",
        "Chunk 1 only defines three-cueing conceptually, no verdict on balanced literacy overall.",
        "balanced_literacy_verdict",
    ),
    PolarityMatchedCase(
        "PM-090",
        "Do districts transitioning away from three-cueing report a quick, "
        "one-semester retraining process?",
        "Districts transitioning away from three-cueing report a quick, "
        "one-semester retraining process.",
        "rc-doc-balanced-literacy-review",
        (4,),
        "contradiction",
        True,
        "statistical_significance",
        "reading_science",
        "Chunk 4 states a multi-year retraining process, not a quick one-semester one.",
        "three_cueing_retraining",
    ),
    PolarityMatchedCase(
        "PM-091",
        "Do districts transitioning away from three-cueing report a quick, "
        "one-semester retraining process?",
        "Districts transitioning away from three-cueing report a quick, "
        "one-semester retraining process.",
        "rc-doc-balanced-literacy-review",
        (0,),
        "neutral",
        True,
        "statistical_significance",
        "reading_science",
        "Overview chunk never discusses retraining timelines.",
        "three_cueing_retraining",
    ),
    PolarityMatchedCase(
        "PM-092",
        "Does this guide recommend answering a driving question with a single Google search?",
        "This guide recommends answering a driving question with a single Google search.",
        "rc-doc-driving-questions-guide",
        (4,),
        "contradiction",
        True,
        "method_used_not_used",
        "project_based_learning",
        "Chunk 4 identifies single-search-answerable questions as the most common design "
        "failure, not a recommendation.",
        "driving_question_search",
    ),
    PolarityMatchedCase(
        "PM-093",
        "Does this guide recommend answering a driving question with a single Google search?",
        "This guide recommends answering a driving question with a single Google search.",
        "rc-doc-driving-questions-guide",
        (1,),
        "neutral",
        True,
        "method_used_not_used",
        "project_based_learning",
        "Chunk 1 only defines what makes a driving question effective in the abstract.",
        "driving_question_search",
    ),
    PolarityMatchedCase(
        "PM-094",
        "Does this guide recommend rolling out a new driving question school-wide "
        "immediately, without piloting it first?",
        "This guide recommends rolling out a new driving question school-wide "
        "immediately, without piloting it first.",
        "rc-doc-driving-questions-guide",
        (3,),
        "contradiction",
        True,
        "method_used_not_used",
        "project_based_learning",
        "Chunk 3 recommends piloting with a single class BEFORE rolling out school-wide.",
        "driving_question_pilot",
    ),
    PolarityMatchedCase(
        "PM-095",
        "Does this guide recommend rolling out a new driving question school-wide "
        "immediately, without piloting it first?",
        "This guide recommends rolling out a new driving question school-wide "
        "immediately, without piloting it first.",
        "rc-doc-driving-questions-guide",
        (0,),
        "neutral",
        True,
        "method_used_not_used",
        "project_based_learning",
        "Overview chunk never discusses rollout process.",
        "driving_question_pilot",
    ),
    PolarityMatchedCase(
        "PM-096",
        "Did the Rapid Letter Naming Screener report more at-risk students than the "
        "Phonological Awareness Screener?",
        "The Rapid Letter Naming Screener reported more at-risk students than the "
        "Phonological Awareness Screener.",
        "rc-doc-dyslexia-screening-tools",
        (2,),
        "contradiction",
        True,
        "numeric_comparison",
        "dyslexia_intervention",
        "Chunk 2: RLNS flagged 9 percent, 'a notably smaller flagged group' than PAS's 14 "
        "percent (chunk 1) — the opposite direction.",
        "screener_comparison",
    ),
    PolarityMatchedCase(
        "PM-097",
        "Did the Rapid Letter Naming Screener report more at-risk students than the "
        "Phonological Awareness Screener?",
        "The Rapid Letter Naming Screener reported more at-risk students than the "
        "Phonological Awareness Screener.",
        "rc-doc-dyslexia-screening-tools",
        (0,),
        "neutral",
        True,
        "numeric_comparison",
        "dyslexia_intervention",
        "Overview chunk states three tools are compared, no specific percentages yet.",
        "screener_comparison",
    ),
    PolarityMatchedCase(
        "PM-098",
        "Does this report conclude CELB is clearly superior on every dimension "
        "among the three tools?",
        "This report concludes CELB is clearly superior on every dimension among "
        "the three tools.",
        "rc-doc-dyslexia-screening-tools",
        (5,),
        "contradiction",
        True,
        "supports_does_not_support",
        "dyslexia_intervention",
        "Chunk 5 explicitly states no single instrument was judged clearly superior on every "
        "dimension.",
        "celb_superiority",
    ),
    PolarityMatchedCase(
        "PM-099",
        "Does CELB report the highest agreement with later first-grade reading "
        "outcomes among the three tools?",
        "CELB reports the highest agreement with later first-grade reading outcomes "
        "among the three tools.",
        "rc-doc-dyslexia-screening-tools",
        (3,),
        "entailment",
        True,
        "yes_no_factual",
        "dyslexia_intervention",
        "Chunk 3 states this directly.",
        "celb_agreement",
    ),
    PolarityMatchedCase(
        "PM-100",
        "Does BRI-SF cover planning and emotional-control subscales?",
        "BRI-SF covers planning and emotional-control subscales.",
        "rc-doc-executive-function-screening-report",
        (2,),
        "contradiction",
        True,
        "method_used_not_used",
        "executive_function",
        "Chunk 2 states CEFC additionally covers these subscales 'not in BRI-SF' — directly "
        "implying BRI-SF does not cover them.",
        "ef_screening_subscales",
    ),
    PolarityMatchedCase(
        "PM-101",
        "Does BRI-SF cover planning and emotional-control subscales?",
        "BRI-SF covers planning and emotional-control subscales.",
        "rc-doc-executive-function-screening-report",
        (0,),
        "neutral",
        True,
        "method_used_not_used",
        "executive_function",
        "Overview chunk only names the two instruments being compared.",
        "ef_screening_subscales",
    ),
    PolarityMatchedCase(
        "PM-102",
        "Does this report claim BRI-SF or CEFC predicts long-term academic outcomes?",
        "This report claims BRI-SF or CEFC predicts long-term academic outcomes.",
        "rc-doc-executive-function-screening-report",
        (5,),
        "contradiction",
        True,
        "supports_does_not_support",
        "executive_function",
        "Chunk 5 explicitly states the report makes no such claim.",
        "ef_screening_prediction_claim",
    ),
    PolarityMatchedCase(
        "PM-103",
        "Did CEFC require approximately 18 minutes per student to complete?",
        "CEFC required approximately 18 minutes per student to complete.",
        "rc-doc-executive-function-screening-report",
        (2,),
        "entailment",
        True,
        "numeric_comparison",
        "executive_function",
        "Chunk 2 states this figure directly.",
        "cefc_duration",
    ),
    PolarityMatchedCase(
        "PM-104",
        "Does this guide recommend grading exit tickets like a formal quiz?",
        "This guide recommends grading exit tickets like a formal quiz.",
        "rc-doc-exit-tickets-guide",
        (4,),
        "contradiction",
        True,
        "method_used_not_used",
        "formative_assessment",
        "Chunk 4 identifies using exit tickets as a graded quiz as the most frequent mistake, "
        "not a recommendation.",
        "exit_ticket_grading",
    ),
    PolarityMatchedCase(
        "PM-105",
        "Does this guide recommend grading exit tickets like a formal quiz?",
        "This guide recommends grading exit tickets like a formal quiz.",
        "rc-doc-exit-tickets-guide",
        (0,),
        "neutral",
        True,
        "method_used_not_used",
        "formative_assessment",
        "Overview chunk only defines what an exit ticket is.",
        "exit_ticket_grading",
    ),
    PolarityMatchedCase(
        "PM-106",
        "Does an effective exit ticket cover multiple learning objectives at once?",
        "An effective exit ticket covers multiple learning objectives at once.",
        "rc-doc-exit-tickets-guide",
        (1,),
        "contradiction",
        True,
        "yes_no_factual",
        "formative_assessment",
        "Chunk 1 states an effective exit ticket targets exactly ONE learning objective.",
        "exit_ticket_objectives",
    ),
    PolarityMatchedCase(
        "PM-107",
        "Does this curriculum require students to build their own AI models?",
        "This curriculum requires students to build their own AI models.",
        "rc-doc-explainable-ai-curriculum",
        (6,),
        "contradiction",
        True,
        "yes_no_factual",
        "ai_education",
        "Chunk 6 explicitly states the curriculum does not teach students to build models — "
        "AI literacy, not AI fluency.",
        "ai_curriculum_build_models",
    ),
    PolarityMatchedCase(
        "PM-108",
        "Does this curriculum require students to build their own AI models?",
        "This curriculum requires students to build their own AI models.",
        "rc-doc-explainable-ai-curriculum",
        (0,),
        "neutral",
        True,
        "yes_no_factual",
        "ai_education",
        "Overview chunk only lists the concepts introduced.",
        "ai_curriculum_build_models",
    ),
    PolarityMatchedCase(
        "PM-109",
        "Do students typically report that spaced practice feels more effective "
        "than massed cramming in the short term?",
        "Students typically report that spaced practice feels more effective than "
        "massed cramming in the short term.",
        "rc-doc-spaced-practice-classroom",
        (4,),
        "contradiction",
        True,
        "comparison",
        "spaced_repetition",
        "Chunk 4 explicitly states students report spaced practice feels LESS effective than "
        "massed cramming in the short term — the opposite direction.",
        "spaced_practice_short_term_feel",
    ),
    PolarityMatchedCase(
        "PM-110",
        "Do students typically report that spaced practice feels more effective "
        "than massed cramming in the short term?",
        "Students typically report that spaced practice feels more effective than "
        "massed cramming in the short term.",
        "rc-doc-spaced-practice-classroom",
        (0,),
        "neutral",
        True,
        "comparison",
        "spaced_repetition",
        "Overview chunk never addresses student perception.",
        "spaced_practice_short_term_feel",
    ),
    PolarityMatchedCase(
        "PM-111",
        "Does this guide recommend memorizing the spacing schedule mentally "
        "rather than tracking it in writing?",
        "This guide recommends memorizing the spacing schedule mentally rather "
        "than tracking it in writing.",
        "rc-doc-spaced-practice-classroom",
        (3,),
        "contradiction",
        True,
        "method_used_not_used",
        "spaced_repetition",
        "Chunk 3 recommends tracking with a spreadsheet, since manually remembering is "
        "unreliable — the opposite recommendation.",
        "spaced_practice_tracking",
    ),
    PolarityMatchedCase(
        "PM-112",
        "Does this policy require districts to adopt a specific vendor curriculum?",
        "This policy requires districts to adopt a specific vendor curriculum.",
        "rc-doc-udl-multilingual-policy",
        (5,),
        "contradiction",
        True,
        "supports_does_not_support",
        "udl_accessibility",
        "Chunk 5 explicitly states this document is guidance, not a mandate, and does not "
        "require any specific curriculum or vendor.",
        "udl_policy_vendor",
    ),
    PolarityMatchedCase(
        "PM-113",
        "Does this policy support translating materials alone as sufficient UDL "
        "implementation?",
        "This policy supports translating materials alone as sufficient UDL "
        "implementation.",
        "rc-doc-udl-multilingual-policy",
        (4,),
        "contradiction",
        True,
        "supports_does_not_support",
        "udl_accessibility",
        "Chunk 4 explicitly warns against treating translation alone as sufficient UDL "
        "implementation.",
        "udl_policy_translation",
    ),
    PolarityMatchedCase(
        "PM-114",
        "Does this policy support translating materials alone as sufficient UDL "
        "implementation?",
        "This policy supports translating materials alone as sufficient UDL "
        "implementation.",
        "rc-doc-udl-multilingual-policy",
        (1,),
        "neutral",
        True,
        "supports_does_not_support",
        "udl_accessibility",
        "Chunk 1 only describes what 'multiple means of representation' includes for "
        "multilingual learners.",
        "udl_policy_translation",
    ),
    # ---- Two more, added specifically to push the deterministic holdout
    # split's CONTRADICTION count from 9 to 11 (Milestone 9.6's "at least
    # 10, preferably 15+" target) — both drawn from topics
    # (executive_function, ai_education) already falling in holdout under
    # the fixed seed=95 split, using previously-unused chunks. This is a
    # dataset-construction/power decision made BEFORE inspecting any model
    # performance on holdout (only label COUNTS were checked, never NLI
    # accuracy) — not a case of tuning against holdout results.
    PolarityMatchedCase(
        "PM-115",
        "Did BRI-SF require approximately 18 minutes per student to complete?",
        "BRI-SF required approximately 18 minutes per student to complete.",
        "rc-doc-executive-function-screening-report",
        (1,),
        "contradiction",
        True,
        "numeric_comparison",
        "executive_function",
        "Chunk 1 states BRI-SF takes approximately 10 minutes, not 18 (18 is CEFC's figure, "
        "chunk 2) — an entity-confusion-style wrong number.",
        "bri_sf_duration",
    ),
    PolarityMatchedCase(
        "PM-116",
        "Is a neural network not different from artificial intelligence in this curriculum?",
        "A neural network is not different from artificial intelligence in this curriculum.",
        "rc-doc-explainable-ai-curriculum",
        (3,),
        "contradiction",
        True,
        "yes_no_factual",
        "ai_education",
        "Chunk 3 explicitly distinguishes a neural network from artificial intelligence "
        "generally — directly contradicts the claim that they are not different.",
        "neural_network_ai_distinction",
    ),
    PolarityMatchedCase(
        "PM-117",
        "Is a neural network not different from artificial intelligence in this curriculum?",
        "A neural network is not different from artificial intelligence in this curriculum.",
        "rc-doc-explainable-ai-curriculum",
        (0,),
        "neutral",
        True,
        "yes_no_factual",
        "ai_education",
        "Overview chunk only lists the concepts introduced, no distinction stated yet.",
        "neural_network_ai_distinction",
    ),
]


def by_relation() -> dict[str, list[PolarityMatchedCase]]:
    grouped: dict[str, list[PolarityMatchedCase]] = {}
    for case in CASES:
        grouped.setdefault(case.gold_relation, []).append(case)
    return grouped


def by_claim_family() -> dict[str, list[PolarityMatchedCase]]:
    grouped: dict[str, list[PolarityMatchedCase]] = {}
    for case in CASES:
        grouped.setdefault(case.claim_family, []).append(case)
    return grouped


def _integrity_check() -> None:
    seen: set[str] = set()
    for case in CASES:
        if case.case_id in seen:
            raise AssertionError(f"duplicate case_id {case.case_id!r}")
        seen.add(case.case_id)
    counts = {label: len(cases) for label, cases in by_relation().items()}
    for label in ("entailment", "neutral", "contradiction"):
        if counts.get(label, 0) < 20:
            raise AssertionError(
                f"{label} count {counts.get(label, 0)} below the Milestone 9.5 minimum of 20"
            )
    represented_categories = {case.category for case in CASES}
    missing = set(CATEGORIES) - represented_categories
    if missing:
        raise AssertionError(f"missing required categories: {missing}")
    # Every claim family must hold its claim TEXT fixed across all its
    # member cases (the whole point of the family design) — a family
    # whose claim text varies would silently reintroduce the polarity
    # confound this dataset exists to eliminate.
    for family, members in by_claim_family().items():
        claims = {m.expected_natural_claim for m in members}
        if len(claims) != 1:
            raise AssertionError(f"claim family {family!r} has inconsistent claim text: {claims}")


_integrity_check()
