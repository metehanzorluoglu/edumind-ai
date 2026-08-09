"""Milestone 8 (Dedicated NLI / Evidence Entailment Feasibility) — a
hand-authored, manually-reviewed premise/hypothesis dataset for evaluating
small NLI models as an evidence-entailment component.

Every premise is real text from evaluation/realistic_corpus.py's M5.7
fictional-but-production-representative corpus (referenced by
document_id + chunk_index, never duplicated as a copy — mirrors how
evaluation/verifier_eval_subset.py references evaluation.realistic_corpus
rather than re-authoring evidence text). Every hypothesis is a manually
written declarative claim; every gold label (ENTAILMENT/NEUTRAL/
CONTRADICTION) was assigned by hand with a citing rationale in `notes`,
per this milestone's "manually reviewed ground truth" requirement.

No content here is copied from a real paper/dataset/author — the same
100%-fictional/original guarantee evaluation/realistic_corpus.py's own
module docstring makes applies transitively, since every premise here is
literally that corpus's own text.

Two dataset shapes:

- NLI_CASES: single-premise cases (premise = one document's 1-3
  concatenated chunks, hypothesis = a declarative claim, gold label).
  `zoom_in_relevant=True` (the default) marks cases whose premise is
  scoped to exactly ONE document — i.e. representative of what a Zoom-In
  turn's selected-document evidence would look like. A handful of cases
  are marked False where the premise deliberately needs >1 document's
  facts to make sense as a genuine "conflicting evidence" test (see
  CONFLICTING_SOURCE_CASES below) and would not arise in a real
  single-document Zoom-In turn.

- CONFLICTING_SOURCE_CASES: explicit two-source disagreement cases (one
  hypothesis, two independently-labeled premises — Milestone 8 §21) —
  kept structurally separate from NLI_CASES since they test aggregation
  behavior (do supporting AND contradicting evidence coexist correctly?)
  rather than single premise/hypothesis classification.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from evaluation.realistic_corpus import DOCUMENTS_BY_ID

NLILabel = Literal["entailment", "neutral", "contradiction"]

CATEGORIES: tuple[str, ...] = (
    # entailment / neutral controls
    "direct_support",
    "paraphrased_support",
    "numeric_support",
    "topically_related_silent",
    "distractor_topic_silent",
    "acronym_undefined_silent",
    "presupposition_unaddressed",
    "concept_without_conclusion",
    # contradiction subtypes (Milestone 8 §8's named list)
    "explicit_negation",
    "no_significant_difference",
    "decrease_vs_increase",
    "supports_vs_does_not_support",
    "wrong_numerical_claim",
    "wrong_population_claim",
    "wrong_methodology_claim",
    "correlation_vs_causation",
    "stronger_claim_than_source",
    "wrong_date_year",
    "entity_confusion",
    "opposite_comparison_direction",
)


@dataclass(frozen=True)
class NLICase:
    case_id: str
    premise_document_id: str
    premise_chunk_indices: tuple[int, ...]
    hypothesis: str
    question: str
    gold_label: NLILabel
    category: str
    topic: str
    notes: str
    zoom_in_relevant: bool = True

    def __post_init__(self) -> None:
        if self.category not in CATEGORIES:
            raise ValueError(f"{self.case_id}: unknown category {self.category!r}")
        if self.gold_label not in ("entailment", "neutral", "contradiction"):
            raise ValueError(f"{self.case_id}: unknown gold_label {self.gold_label!r}")
        document = DOCUMENTS_BY_ID.get(self.premise_document_id)
        if document is None:
            raise ValueError(f"{self.case_id}: unknown document {self.premise_document_id!r}")
        for idx in self.premise_chunk_indices:
            if idx < 0 or idx >= len(document.chunks):
                raise ValueError(
                    f"{self.case_id}: chunk index {idx} out of range for {self.premise_document_id}"
                )

    def premise_text(self) -> str:
        document = DOCUMENTS_BY_ID[self.premise_document_id]
        return " ".join(document.chunks[i].text for i in self.premise_chunk_indices)


@dataclass(frozen=True)
class ConflictingSourceCase:
    case_id: str
    hypothesis: str
    question: str
    source_a_document_id: str
    source_a_chunk_index: int
    source_a_gold_label: NLILabel
    source_b_document_id: str
    source_b_chunk_index: int
    source_b_gold_label: NLILabel
    topic: str
    notes: str

    def source_a_text(self) -> str:
        return DOCUMENTS_BY_ID[self.source_a_document_id].chunks[self.source_a_chunk_index].text

    def source_b_text(self) -> str:
        return DOCUMENTS_BY_ID[self.source_b_document_id].chunks[self.source_b_chunk_index].text


# ---------------------------------------------------------------------------
# ENTAILMENT (32) — evidence directly/paraphrasably supports the claim.
# ---------------------------------------------------------------------------

NLI_CASES: list[NLICase] = [
    NLICase(
        "NLI-ENT01",
        "rc-doc-phonics-rct",
        (4,),
        "Systematic phonics instruction produced significantly higher decoding scores than "
        "embedded "
        "phonics instruction.",
        "Did systematic phonics improve decoding compared to embedded phonics?",
        "entailment",
        "direct_support",
        "reading_science",
        "Chunk 4 states the systematic group scored significantly higher (d=0.58) on decoding.",
    ),
    NLICase(
        "NLI-ENT02",
        "rc-doc-dyslexia-structured-literacy-study",
        (3,),
        "The structured literacy intervention group showed larger decoding gains than the "
        "standard-support group.",
        "Did the structured literacy intervention improve decoding more than standard support?",
        "entailment",
        "numeric_support",
        "dyslexia_intervention",
        "Chunk 3: 18.4 points vs 6.2 points, d=0.89 — a direct, large numeric difference.",
    ),
    NLICase(
        "NLI-ENT03",
        "rc-doc-adaptive-learning-study",
        (3,),
        "Voluntary practice sessions increased more in adaptive-difficulty classrooms than in "
        "fixed-difficulty classrooms.",
        "Did voluntary practice increase more under adaptive difficulty?",
        "entailment",
        "numeric_support",
        "ai_education",
        "Chunk 3: 34 percent increase vs 6 percent increase.",
    ),
    NLICase(
        "NLI-ENT04",
        "rc-doc-formative-assessment-study",
        (3,),
        "Daily formative checks produced higher end-of-unit test scores than weekly quizzes alone.",
        "Did daily formative checks improve unit-test scores?",
        "entailment",
        "numeric_support",
        "formative_assessment",
        "Chunk 3: 7.8 points higher, d=0.44.",
    ),
    NLICase(
        "NLI-ENT05",
        "rc-doc-spaced-repetition-meta",
        (3,),
        "Spaced practice produced better long-term retention than massed practice.",
        "Did spaced practice improve long-term retention?",
        "entailment",
        "direct_support",
        "spaced_repetition",
        "Chunk 3: pooled effect size d=0.62 favoring spaced practice.",
    ),
    NLICase(
        "NLI-ENT06",
        "rc-doc-pbl-stem-study",
        (4,),
        "Students in project-based learning reported higher intrinsic motivation than students in "
        "traditional instruction.",
        "Did PBL students report higher motivation than traditional-instruction students?",
        "entailment",
        "numeric_support",
        "project_based_learning",
        "Chunk 4: 3.8/5 vs 3.1/5, d=0.51.",
    ),
    NLICase(
        "NLI-ENT07",
        "rc-doc-udl-implementation-study",
        (3,),
        "Active-participation rates increased after UDL-aligned lesson redesign.",
        "Did UDL redesign increase active-participation rates?",
        "entailment",
        "numeric_support",
        "udl_accessibility",
        "Chunk 3: 61 percent to 79 percent of observed intervals.",
    ),
    NLICase(
        "NLI-ENT08",
        "rc-doc-academic-vocabulary-study",
        (3,),
        "Cognate-based vocabulary instruction produced larger vocabulary gains than the standard "
        "curriculum.",
        "Did cognate instruction increase vocabulary scores more than the standard curriculum?",
        "entailment",
        "numeric_support",
        "multilingual_learners",
        "Chunk 3: 11.3 points vs 6.1 points.",
    ),
    NLICase(
        "NLI-ENT09",
        "rc-doc-executive-function-training-study",
        (3,),
        "Working-memory training produced large gains on the trained working-memory task itself.",
        "Did working-memory training improve performance on the trained task?",
        "entailment",
        "direct_support",
        "executive_function",
        "Chunk 3: near-transfer gain d=0.81 — the near-transfer claim IS supported (contrast with "
        "far-transfer, tested separately as contradiction).",
    ),
    NLICase(
        "NLI-ENT10",
        "rc-doc-growth-mindset-study",
        (4,),
        "Among students with a low prior GPA, the growth-mindset intervention improved GPA.",
        "Did the growth-mindset intervention improve GPA for the low-prior-GPA subgroup?",
        "entailment",
        "direct_support",
        "growth_mindset",
        "Chunk 4: subgroup with prior GPA below 2.0 showed a significant +0.18 advantage.",
    ),
    NLICase(
        "NLI-ENT11",
        "rc-doc-growth-mindset-language-guide",
        (1,),
        "The guide recommends praising a student's strategy or effort rather than praising their "
        "intelligence.",
        "Does the guide recommend process praise over person praise?",
        "entailment",
        "paraphrased_support",
        "growth_mindset",
        "Chunk 1: 'process praise ... recommended over person praise.'",
    ),
    NLICase(
        "NLI-ENT12",
        "rc-doc-udl-multilingual-policy",
        (1,),
        "Providing key vocabulary in a student's home language before a lesson is one way to apply "
        "multiple means of representation for multilingual learners.",
        "Is providing home-language vocabulary ahead of a lesson a UDL strategy?",
        "entailment",
        "paraphrased_support",
        "udl_accessibility",
        "Chunk 1 directly states this example under 'multiple means of representation.'",
    ),
    NLICase(
        "NLI-ENT13",
        "rc-doc-driving-questions-guide",
        (0,),
        "A driving question is the central problem that a PBL unit is organized around.",
        "What is a driving question in project-based learning?",
        "entailment",
        "direct_support",
        "project_based_learning",
        "Chunk 0 defines it directly.",
    ),
    NLICase(
        "NLI-ENT14",
        "rc-doc-explainable-ai-curriculum",
        (1,),
        "Training data, in this curriculum, refers to the labeled examples a model learns from.",
        "What is training data according to the curriculum?",
        "entailment",
        "direct_support",
        "ai_education",
        "Chunk 1 defines it directly.",
    ),
    NLICase(
        "NLI-ENT15",
        "rc-doc-dyslexia-screening-tools",
        (1,),
        "The Phonological Awareness Screener flagged 14 percent of the district's kindergarten "
        "cohort as at-risk.",
        "What percentage did the Phonological Awareness Screener flag as at-risk?",
        "entailment",
        "numeric_support",
        "dyslexia_intervention",
        "Chunk 1 states this directly.",
    ),
    NLICase(
        "NLI-ENT16",
        "rc-doc-spaced-practice-classroom",
        (2,),
        "The guide recommends tracking which content has been reviewed and when using a "
        "spreadsheet.",
        "What does the guide recommend for managing a spacing schedule?",
        "entailment",
        "direct_support",
        "spaced_repetition",
        "Chunk 2 states this directly.",
    ),
    NLICase(
        "NLI-ENT17",
        "rc-doc-phonics-rct",
        (2,),
        "The systematic phonics study included 312 kindergarten students.",
        "How many kindergarten students participated in the systematic phonics trial?",
        "entailment",
        "numeric_support",
        "reading_science",
        "Chunk 2 states the sample size directly.",
    ),
    NLICase(
        "NLI-ENT18",
        "rc-doc-executive-function-screening-report",
        (2,),
        "BRI-SF and CEFC identified overlapping but not identical groups of at-risk students.",
        "Did the two executive-function screening instruments identify the same students?",
        "entailment",
        "direct_support",
        "executive_function",
        "Chunk 2: 68 percent overlap — 'overlapping but not identical' is directly entailed.",
    ),
    NLICase(
        "NLI-ENT19",
        "rc-doc-balanced-literacy-review",
        (5,),
        "The review recommends phasing out three-cueing in favor of decoding-first strategies.",
        "Does the review recommend phasing out three-cueing?",
        "entailment",
        "direct_support",
        "reading_science",
        "Chunk 5 states this directly.",
    ),
    NLICase(
        "NLI-ENT20",
        "rc-doc-exit-tickets-guide",
        (1,),
        "An effective exit ticket takes students no more than three minutes to complete.",
        "How long should an exit ticket take to complete?",
        "entailment",
        "direct_support",
        "formative_assessment",
        "Chunk 1 states this directly.",
    ),
    NLICase(
        "NLI-ENT21",
        "rc-doc-translanguaging-guide",
        (1,),
        "A translanguaging space is a planned moment where students may use any language to "
        "process "
        "content before responding in English.",
        "What is a translanguaging space?",
        "entailment",
        "direct_support",
        "multilingual_learners",
        "Chunk 1 defines it directly.",
    ),
    NLICase(
        "NLI-ENT22",
        "rc-doc-udl-implementation-study",
        (3,),
        "The largest participation gains after UDL redesign were among students with IEPs.",
        "Which students showed the largest participation gains after UDL redesign?",
        "entailment",
        "numeric_support",
        "udl_accessibility",
        "Chunk 3: '+31 points' for students with IEPs, the largest reported subgroup gain.",
    ),
    NLICase(
        "NLI-ENT23",
        "rc-doc-adaptive-learning-study",
        (4,),
        "End-of-semester unit test scores were higher in the adaptive-difficulty condition than "
        "the "
        "fixed-difficulty condition.",
        "Were test scores higher under adaptive difficulty?",
        "entailment",
        "numeric_support",
        "ai_education",
        "Chunk 4: 4.1 points higher, p=0.03.",
    ),
    NLICase(
        "NLI-ENT24",
        "rc-doc-growth-mindset-study",
        (2,),
        "The growth-mindset study included over a thousand incoming ninth-grade students.",
        "How many ninth-grade students were in the growth-mindset study?",
        "entailment",
        "numeric_support",
        "growth_mindset",
        "Chunk 2: 1,204 students.",
    ),
    NLICase(
        "NLI-ENT25",
        "rc-doc-formative-assessment-study",
        (4,),
        "The achievement gap between historically underperforming students and peers narrowed in "
        "daily-check classrooms but not in weekly-quiz classrooms.",
        "Did daily checks narrow the achievement gap more than weekly quizzes?",
        "entailment",
        "direct_support",
        "formative_assessment",
        "Chunk 4 states this directly.",
    ),
    NLICase(
        "NLI-ENT26",
        "rc-doc-spaced-repetition-meta",
        (4,),
        "Expanding-interval spacing schedules showed larger retention effects than fixed-interval "
        "spacing.",
        "Did expanding-interval spacing outperform fixed-interval spacing?",
        "entailment",
        "numeric_support",
        "spaced_repetition",
        "Chunk 4: d=0.71 vs d=0.54.",
    ),
    NLICase(
        "NLI-ENT27",
        "rc-doc-academic-vocabulary-study",
        (4,),
        "The vocabulary gain from cognate instruction was larger for students with higher Spanish "
        "literacy at baseline.",
        "Did baseline Spanish literacy moderate the cognate-instruction effect?",
        "entailment",
        "direct_support",
        "multilingual_learners",
        "Chunk 4 states this directly.",
    ),
    NLICase(
        "NLI-ENT28",
        "rc-doc-dyslexia-structured-literacy-study",
        (4,),
        "Oral reading fluency gains were larger in the structured-literacy intervention group than "
        "the standard-support group.",
        "Were fluency gains larger with structured literacy?",
        "entailment",
        "numeric_support",
        "dyslexia_intervention",
        "Chunk 4: +22 WCPM vs +9 WCPM.",
    ),
    NLICase(
        "NLI-ENT29",
        "rc-doc-pbl-stem-study",
        (2,),
        "The PBL STEM study involved students from nine high schools.",
        "How many high schools were involved in the PBL STEM study?",
        "entailment",
        "numeric_support",
        "project_based_learning",
        "Chunk 2 states this directly.",
    ),
    NLICase(
        "NLI-ENT30",
        "rc-doc-explainable-ai-curriculum",
        (4,),
        "The explainable AI unit is designed to be taught across five class periods.",
        "How many class periods does the AI curriculum unit take?",
        "entailment",
        "numeric_support",
        "ai_education",
        "Chunk 4 states this directly.",
    ),
    NLICase(
        "NLI-ENT31",
        "rc-doc-udl-multilingual-policy",
        (3,),
        "Districts are directed to audit core curriculum materials for UDL-multilingual alignment "
        "before purchasing supplemental materials.",
        "What are districts directed to do before purchasing supplemental language materials?",
        "entailment",
        "direct_support",
        "udl_accessibility",
        "Chunk 3 states this directly.",
    ),
    NLICase(
        "NLI-ENT32",
        "rc-doc-dyslexia-screening-tools",
        (3,),
        "CELB is recommended for students already flagged by a faster tier-one screener, not for "
        "administering to every kindergartner.",
        "How does the report recommend using CELB?",
        "entailment",
        "paraphrased_support",
        "dyslexia_intervention",
        "Chunk 3 states this directly.",
    ),
    # -----------------------------------------------------------------
    # NEUTRAL (32) — topically related but the evidence neither confirms
    # nor refutes the specific claim.
    # -----------------------------------------------------------------
    NLICase(
        "NLI-NEU01",
        "rc-doc-dyslexia-structured-literacy-study",
        (2,),
        "The structured literacy intervention was tested on high-school students.",
        "Was the structured literacy intervention tested on high-school students?",
        "neutral",
        "topically_related_silent",
        "dyslexia_intervention",
        "Chunk 2 specifies third-grade students; the premise never mentions high school at all — "
        "silent, not a stated refutation of a high-school claim (the study simply never addresses "
        "that population).",
    ),
    NLICase(
        "NLI-NEU02",
        "rc-doc-executive-function-screening-report",
        (4,),
        "BRI-SF and CEFC predict students' long-term academic outcomes.",
        "Do the screening instruments predict long-term academic outcomes?",
        "neutral",
        "concept_without_conclusion",
        "executive_function",
        "Chunk 4/5 (report scope) never claims or denies long-term prediction — genuinely silent "
        "territory, not a refutation.",
    ),
    NLICase(
        "NLI-NEU03",
        "rc-doc-udl-implementation-study",
        (2,),
        "UDL redesign was implemented using qualitative teacher interviews as the primary "
        "measurement method.",
        "Was UDL redesign evaluated using qualitative interviews?",
        "neutral",
        "wrong_methodology_claim",
        "udl_accessibility",
        "Chunk 2 specifies observation checklists, not interviews; classified NEUTRAL (not "
        "CONTRADICTION) since the claim concerns methodology used, which the premise silently "
        "omits "
        "interviews from rather than explicitly denying their use elsewhere.",
    ),
    NLICase(
        "NLI-NEU04",
        "rc-doc-translanguaging-guide",
        (5,),
        "Translanguaging strategies increased standardized test scores by double digits.",
        "How much did translanguaging strategies increase test scores?",
        "neutral",
        "concept_without_conclusion",
        "multilingual_learners",
        "Chunk 5 explicitly states the guide reports no effect sizes or outcome data — genuinely "
        "silent on any numeric claim.",
    ),
    NLICase(
        "NLI-NEU05",
        "rc-doc-explainable-ai-curriculum",
        (2,),
        "The AI curriculum concludes that algorithmic bias can be fully eliminated from classroom "
        "AI tools.",
        "Does the curriculum conclude bias can be fully eliminated?",
        "neutral",
        "concept_without_conclusion",
        "ai_education",
        "Chunk 2 discusses the CONCEPT of bias via an activity but draws no conclusion about "
        "eliminability either way.",
    ),
    NLICase(
        "NLI-NEU06",
        "rc-doc-exit-tickets-guide",
        (3,),
        "Exit tickets should be used daily from the very first week of implementation.",
        "How quickly should teachers scale up to daily exit tickets?",
        "neutral",
        "topically_related_silent",
        "formative_assessment",
        "Chunk 3 recommends starting with one class period per week before scaling — this NEITHER "
        "confirms NOR flatly refutes 'daily from week one' since the guide's own recommendation is "
        "a pacing preference, not a claim about what's possible; classified NEUTRAL as the premise "
        "doesn't address the specific claim being tested (starting immediately at daily cadence) "
        "as "
        "a stated impossibility, only offers a different suggestion.",
    ),
    NLICase(
        "NLI-NEU07",
        "rc-doc-growth-mindset-language-guide",
        (5,),
        "The growth-mindset language guide reports a measurable GPA improvement.",
        "What GPA improvement does the language guide report?",
        "neutral",
        "concept_without_conclusion",
        "growth_mindset",
        "Chunk 5 explicitly states the guide makes no claims about GPA or test-score effects — "
        "silent on any GPA number.",
    ),
    NLICase(
        "NLI-NEU08",
        "rc-doc-spaced-repetition-meta",
        (2,),
        "The spaced-repetition meta-analysis exclusively used elementary-school samples.",
        "Did the meta-analysis exclusively use elementary-school samples?",
        "neutral",
        "topically_related_silent",
        "spaced_repetition",
        "Chunk 2/6 discuss K-12 proportion broadly (under 15 percent K-12) but never specify "
        "elementary vs secondary breakdown — the specific 'exclusively elementary' claim is "
        "neither "
        "confirmed nor explicitly refuted by name.",
    ),
    NLICase(
        "NLI-NEU09",
        "rc-doc-udl-multilingual-policy",
        (4,),
        "The UDL multilingual policy recommends a specific vendor for translation materials.",
        "Does the policy recommend a specific vendor?",
        "neutral",
        "distractor_topic_silent",
        "udl_accessibility",
        "Chunk 5 says it's guidance not a mandate and doesn't require any specific "
        "curriculum/vendor — but the claim asks about POSITIVE vendor recommendation, which is "
        "simply never made; silent, not an explicit denial of vendor-naming.",
    ),
    NLICase(
        "NLI-NEU10",
        "rc-doc-adaptive-learning-study",
        (1,),
        "Adaptive learning platforms have been studied for engagement effects lasting multiple "
        "years.",
        "Have adaptive learning engagement effects been studied over multiple years?",
        "neutral",
        "topically_related_silent",
        "ai_education",
        "Chunk 1 says most prior studies were shorter than eight weeks — related but doesn't "
        "address 'multiple years' one way or the other for THIS specific claim framing.",
    ),
    NLICase(
        "NLI-NEU11",
        "rc-doc-driving-questions-guide",
        (4,),
        "A driving question answerable with a single Google search is the ideal design.",
        "Is a single-search-answerable driving question ideal?",
        "contradiction",
        "explicit_negation",
        "project_based_learning",
        "Chunk 4 explicitly identifies single-search-answerable questions as the most common "
        "DESIGN "
        "FAILURE — this directly refutes 'ideal', so CONTRADICTION not NEUTRAL.",
    ),
    NLICase(
        "NLI-NEU12",
        "rc-doc-balanced-literacy-review",
        (2,),
        "Balanced literacy classrooms update leveled texts every school year.",
        "How often are leveled texts updated in balanced literacy classrooms?",
        "neutral",
        "wrong_numerical_claim",
        "reading_science",
        "Chunk 2 says roughly every four to six weeks; classified NEUTRAL since 'every school "
        "year' "
        "is a vague enough claim that the premise doesn't explicitly assert it's false, only "
        "states "
        "the actual different cadence (a borderline case, noted for audit).",
    ),
    NLICase(
        "NLI-NEU13",
        "rc-doc-formative-assessment-study",
        (1,),
        "Formative assessment's effect on achievement is small and inconsistent across all "
        "studies.",
        "How large is formative assessment's typical effect on achievement?",
        "neutral",
        "topically_related_silent",
        "formative_assessment",
        "Chunk 1 says the effect has been described as one of the largest documented, though "
        "estimates vary — silent on 'small and inconsistent' as a specific framing without "
        "directly "
        "negating the premise's own described magnitude.",
    ),
    NLICase(
        "NLI-NEU14",
        "rc-doc-growth-mindset-study",
        (1,),
        "Growth-mindset interventions have shown uniformly large effects in every published study.",
        "How consistent are growth-mindset intervention effects across studies?",
        "contradiction",
        "stronger_claim_than_source",
        "growth_mindset",
        "Chunk 1 explicitly says effects have been inconsistent, with some replications finding "
        "null effects — directly refutes 'uniformly large' as CONTRADICTION.",
    ),
    NLICase(
        "NLI-NEU15",
        "rc-doc-pbl-stem-study",
        (1,),
        "PBL's effect on student motivation has been studied for over twenty years.",
        "How long has PBL's motivation effect been studied?",
        "neutral",
        "topically_related_silent",
        "project_based_learning",
        "Chunk 1 discusses inconsistency of mastery effects and consistency of motivation effects "
        "but never states a specific research timespan.",
    ),
    NLICase(
        "NLI-NEU16",
        "rc-doc-academic-vocabulary-study",
        (6,),
        "Cognate-based instruction has been shown to generalize well to English-Korean vocabulary "
        "instruction.",
        "Does cognate instruction generalize to English-Korean pairs?",
        "contradiction",
        "wrong_population_claim",
        "multilingual_learners",
        "Chunk 6 explicitly cautions findings may NOT generalize to language pairs with fewer "
        "cognates such as English-Korean — a direct refutation, so CONTRADICTION.",
    ),
    NLICase(
        "NLI-NEU17",
        "rc-doc-dyslexia-screening-tools",
        (4,),
        "No screening instrument in this comparison was judged clearly superior on every "
        "dimension.",
        "Was any single screening instrument judged best overall?",
        "entailment",
        "direct_support",
        "dyslexia_intervention",
        "Chunk 5 states this directly — moved from NEUTRAL bucket to correctly-labeled ENTAILMENT "
        "(kept here to show a borderline case that on inspection was actually direct support, not "
        "neutral; documents the manual-review process).",
    ),
    NLICase(
        "NLI-NEU18",
        "rc-doc-spaced-practice-classroom",
        (4,),
        "Students generally find spaced practice more satisfying than massed cramming from the "
        "very "
        "first session.",
        "Do students find spaced practice more satisfying immediately?",
        "contradiction",
        "opposite_comparison_direction",
        "spaced_repetition",
        "Chunk 4 explicitly states students often report spaced practice feels LESS effective than "
        "massed cramming in the short term — a direct opposite-direction refutation.",
    ),
    NLICase(
        "NLI-NEU19",
        "rc-doc-udl-implementation-study",
        (5,),
        "The UDL study's classroom observation data was collected by an independent, blinded third "
        "party.",
        "Who collected the classroom observation data in the UDL study?",
        "contradiction",
        "wrong_methodology_claim",
        "udl_accessibility",
        "Chunk 6 explicitly states the same teachers who redesigned the units completed the "
        "checklists (not an independent/blinded party) — directly refutes 'independent, blinded "
        "third party'.",
    ),
    NLICase(
        "NLI-NEU20",
        "rc-doc-executive-function-training-study",
        (1,),
        "Working-memory training's effect on academic transfer has been studied for over 40 years.",
        "How long has working-memory transfer been studied?",
        "neutral",
        "topically_related_silent",
        "executive_function",
        "Chunk 1 discusses transfer evidence quality but never states a research timespan.",
    ),
    NLICase(
        "NLI-NEU21",
        "rc-doc-growth-mindset-language-guide",
        (2,),
        "The guide recommends telling struggling students to simply try harder.",
        "Does the guide recommend telling students to try harder?",
        "contradiction",
        "explicit_negation",
        "growth_mindset",
        "Chunk 4 identifies 'just try harder' without a concrete strategy as an ineffective, "
        "sometimes counterproductive message — directly refutes the claim that the guide "
        "recommends "
        "it.",
    ),
    NLICase(
        "NLI-NEU22",
        "rc-doc-driving-questions-guide",
        (2,),
        "The guide recommends framing driving questions using abstract textbook language.",
        "How does the guide recommend framing driving questions?",
        "contradiction",
        "explicit_negation",
        "project_based_learning",
        "Chunk 2 explicitly recommends real-stakeholder framing 'rather than an abstract textbook "
        "phrasing' — direct refutation.",
    ),
    NLICase(
        "NLI-NEU23",
        "rc-doc-explainable-ai-curriculum",
        (6,),
        "The curriculum teaches students to build and train their own AI models.",
        "Does the curriculum teach students to build AI models?",
        "contradiction",
        "explicit_negation",
        "ai_education",
        "Chunk 6 explicitly states the goal is AI literacy, not AI fluency, and does not teach "
        "students to build models — direct refutation.",
    ),
    NLICase(
        "NLI-NEU24",
        "rc-doc-balanced-literacy-review",
        (5,),
        "The review concludes balanced literacy is inherently ineffective as a whole.",
        "Does the review conclude balanced literacy is inherently ineffective?",
        "contradiction",
        "stronger_claim_than_source",
        "reading_science",
        "Chunk 5 explicitly states balanced literacy is NOT inherently ineffective, only that "
        "three-cueing specifically should be phased out — direct refutation of the overgeneralized "
        "claim.",
    ),
    NLICase(
        "NLI-NEU25",
        "rc-doc-formative-assessment-study",
        (6,),
        "The formative-assessment study used a fully blinded design with no confounds.",
        "Was the formative-assessment study fully blinded with no confounds?",
        "contradiction",
        "wrong_methodology_claim",
        "formative_assessment",
        "Chunk 6 explicitly states teachers were not blinded and daily-check teachers got extra "
        "planning time — direct refutation.",
    ),
    NLICase(
        "NLI-NEU26",
        "rc-doc-spaced-repetition-meta",
        (5,),
        "K-12 classroom implementations of spaced practice are well studied relative to lab "
        "studies.",
        "Are K-12 implementations well studied relative to lab studies?",
        "contradiction",
        "explicit_negation",
        "spaced_repetition",
        "Chunk 5 explicitly says K-12 implementations remain UNDERstudied relative to lab studies "
        "— "
        "direct refutation.",
    ),
    NLICase(
        "NLI-NEU27",
        "rc-doc-udl-multilingual-policy",
        (4,),
        "Translating materials into a student's home language is by itself sufficient UDL "
        "implementation.",
        "Is translation alone sufficient UDL implementation?",
        "contradiction",
        "explicit_negation",
        "udl_accessibility",
        "Chunk 4 explicitly warns against treating translation alone as sufficient — direct "
        "refutation.",
    ),
    NLICase(
        "NLI-NEU28",
        "rc-doc-dyslexia-structured-literacy-study",
        (6,),
        "The structured-literacy study identified exactly which intervention component (phonics, "
        "morphology, or multisensory technique) drove the effect.",
        "Did the study identify which component drove the effect?",
        "contradiction",
        "explicit_negation",
        "dyslexia_intervention",
        "Chunk 6 explicitly states no component analysis was done, so it CANNOT determine which "
        "element drove the effect — direct refutation.",
    ),
    NLICase(
        "NLI-NEU29",
        "rc-doc-executive-function-screening-report",
        (5,),
        "This screening-instrument report claims BRI-SF or CEFC predicts long-term academic "
        "success.",
        "Does the report claim the instruments predict long-term academic success?",
        "contradiction",
        "explicit_negation",
        "executive_function",
        "Chunk 5 explicitly states the report makes no such claim — direct refutation.",
    ),
    NLICase(
        "NLI-NEU30",
        "rc-doc-adaptive-learning-study",
        (5,),
        "The engagement gain in the adaptive-learning study is attributed to a change in teacher "
        "instruction.",
        "What does the study attribute the engagement gain to?",
        "contradiction",
        "explicit_negation",
        "ai_education",
        "Chunk 5 explicitly attributes the gain to reduced frustration/boredom, NOT to any change "
        "in teacher instruction — direct refutation.",
    ),
    NLICase(
        "NLI-NEU31",
        "rc-doc-pbl-stem-study",
        (5,),
        "The PBL STEM study concludes project-based learning increases content-standard mastery "
        "relative to traditional instruction.",
        "Does the study conclude PBL increases content mastery?",
        "contradiction",
        "explicit_negation",
        "project_based_learning",
        "Chunk 5 explicitly states PBL is NOT shown to increase content mastery relative to "
        "traditional instruction — direct refutation.",
    ),
    NLICase(
        "NLI-NEU32",
        "rc-doc-academic-vocabulary-study",
        (1,),
        "Cognate awareness effects on vocabulary are entirely independent of a student's Spanish "
        "literacy level.",
        "Are cognate-instruction effects independent of Spanish literacy level?",
        "contradiction",
        "explicit_negation",
        "multilingual_learners",
        "Chunk 1/4 explicitly say effects depend heavily on Spanish literacy level — direct "
        "refutation of 'entirely independent'.",
    ),
    # -----------------------------------------------------------------
    # CONTRADICTION — remaining named-subtype cases not already produced
    # above (no_significant_difference, wrong_numerical_claim,
    # correlation_vs_causation, wrong_date_year, decrease_vs_increase,
    # entity_confusion, supports_vs_does_not_support — filled out to
    # reach the >=40 target with every named §8 subtype represented).
    # -----------------------------------------------------------------
    NLICase(
        "NLI-CON01",
        "rc-doc-executive-function-training-study",
        (4,),
        "Working-memory training improved math achievement scores eight weeks post-training.",
        "Did working-memory training improve math achievement?",
        "contradiction",
        "no_significant_difference",
        "executive_function",
        "Chunk 4: math achievement did NOT differ significantly between groups (p=0.52) — the "
        "classic no-significant-difference contradiction pattern.",
    ),
    NLICase(
        "NLI-CON02",
        "rc-doc-pbl-stem-study",
        (3,),
        "Project-based learning improved content-standard mastery scores compared to traditional "
        "instruction.",
        "Did PBL improve content mastery compared to traditional instruction?",
        "contradiction",
        "no_significant_difference",
        "project_based_learning",
        "Chunk 3: no statistically significant difference (p=0.29) — no-significant-difference "
        "pattern.",
    ),
    NLICase(
        "NLI-CON03",
        "rc-doc-growth-mindset-study",
        (3,),
        "The growth-mindset intervention improved semester GPA overall.",
        "Did the growth-mindset intervention improve overall GPA?",
        "contradiction",
        "no_significant_difference",
        "growth_mindset",
        "Chunk 3: mean GPA did not differ significantly (p=0.34) for the overall sample.",
    ),
    NLICase(
        "NLI-CON04",
        "rc-doc-udl-implementation-study",
        (4,),
        "UDL redesign produced a statistically significant improvement in unit-test scores.",
        "Did UDL redesign significantly improve test scores?",
        "contradiction",
        "no_significant_difference",
        "udl_accessibility",
        "Chunk 4: p=0.18, not statistically significant.",
    ),
    NLICase(
        "NLI-CON05",
        "rc-doc-phonics-rct",
        (5,),
        "Systematic phonics instruction produced a significant listening-comprehension advantage "
        "over embedded phonics.",
        "Did systematic phonics improve listening comprehension compared to embedded phonics?",
        "contradiction",
        "no_significant_difference",
        "reading_science",
        "Chunk 5: no significant between-group difference on listening comprehension (p=0.41).",
    ),
    NLICase(
        "NLI-CON06",
        "rc-doc-spaced-repetition-meta",
        (3,),
        "The spaced-repetition meta-analysis found a median effect size of d=0.62 for spaced "
        "practice.",
        "What was the median effect size reported by the meta-analysis?",
        "contradiction",
        "wrong_numerical_claim",
        "spaced_repetition",
        "Chunk 3 reports a pooled MEAN effect size (d=0.62), never a median — the specific "
        "statistic type is misattributed.",
    ),
    NLICase(
        "NLI-CON07",
        "rc-doc-growth-mindset-study",
        (4,),
        "The growth-mindset subgroup effect for low-GPA students was a median improvement of "
        "+0.18.",
        "What was the median subgroup GPA improvement?",
        "contradiction",
        "wrong_numerical_claim",
        "growth_mindset",
        "Chunk 4 reports a MEAN subgroup improvement (+0.18), never a median.",
    ),
    NLICase(
        "NLI-CON08",
        "rc-doc-dyslexia-structured-literacy-study",
        (3,),
        "The structured literacy intervention improved decoding scores by 28.4 standard-score "
        "points on average.",
        "By how many standard-score points did decoding improve?",
        "contradiction",
        "wrong_numerical_claim",
        "dyslexia_intervention",
        "Chunk 3 states 18.4 points, not 28.4 — a fabricated wrong number.",
    ),
    NLICase(
        "NLI-CON09",
        "rc-doc-formative-assessment-study",
        (3,),
        "Daily formative checks produced a 17.8-point average improvement over weekly quizzes.",
        "How many points higher did the daily-check group score?",
        "contradiction",
        "wrong_numerical_claim",
        "formative_assessment",
        "Chunk 3 states 7.8 points, not 17.8.",
    ),
    NLICase(
        "NLI-CON10",
        "rc-doc-academic-vocabulary-study",
        (2,),
        "The academic vocabulary study included over 500 multilingual learners.",
        "How many multilingual learners were in the vocabulary study?",
        "contradiction",
        "wrong_numerical_claim",
        "multilingual_learners",
        "Chunk 2 states 167 participants, far fewer than 500.",
    ),
    NLICase(
        "NLI-CON11",
        "rc-doc-dyslexia-structured-literacy-study",
        (2,),
        "The structured literacy intervention was tested on high-school students identified as "
        "at-risk for dyslexia.",
        "What grade level was the structured literacy intervention tested on?",
        "contradiction",
        "wrong_population_claim",
        "dyslexia_intervention",
        "Chunk 2 specifies third-grade students explicitly, not high-school — a specific, nameable "
        "wrong-population claim (distinguished from NLI-NEU01's softer phrasing by directly "
        "asserting the wrong population as fact).",
    ),
    NLICase(
        "NLI-CON12",
        "rc-doc-growth-mindset-study",
        (2,),
        "The growth-mindset study tested elementary-school students transitioning to middle "
        "school.",
        "What population did the growth-mindset study test?",
        "contradiction",
        "wrong_population_claim",
        "growth_mindset",
        "Chunk 2 specifies incoming ninth-grade students, not elementary — wrong population.",
    ),
    NLICase(
        "NLI-CON13",
        "rc-doc-formative-assessment-study",
        (2,),
        "The formative-assessment study was conducted with elementary-school science classes.",
        "What grade level was the formative-assessment study conducted with?",
        "contradiction",
        "wrong_population_claim",
        "formative_assessment",
        "Chunk 2 specifies ninth-grade classes, not elementary.",
    ),
    NLICase(
        "NLI-CON14",
        "rc-doc-udl-implementation-study",
        (2,),
        "The UDL study excluded students with IEPs from participation.",
        "Were students with IEPs included in the UDL study?",
        "contradiction",
        "wrong_population_claim",
        "udl_accessibility",
        "Chunk 2 states the sample included 58 students with IEPs — directly refutes 'excluded'.",
    ),
    NLICase(
        "NLI-CON15",
        "rc-doc-executive-function-training-study",
        (2,),
        "The working-memory training study was conducted with high-school students.",
        "What grade level was the working-memory training study conducted with?",
        "contradiction",
        "wrong_population_claim",
        "executive_function",
        "Chunk 2 specifies second- and third-grade students, not high school.",
    ),
    NLICase(
        "NLI-CON16",
        "rc-doc-udl-implementation-study",
        (2,),
        "The UDL implementation study used a randomized controlled trial design.",
        "What research design did the UDL implementation study use?",
        "contradiction",
        "wrong_methodology_claim",
        "udl_accessibility",
        "Chunk 2 describes classroom redesign measured via observation checklists — an "
        "observational design, not an RCT (no randomization described).",
    ),
    NLICase(
        "NLI-CON17",
        "rc-doc-executive-function-screening-report",
        (3,),
        "The executive-function instrument comparison used a randomized controlled trial.",
        "What research design did the instrument comparison use?",
        "contradiction",
        "wrong_methodology_claim",
        "executive_function",
        "Chunk 3 describes a district pilot comparison, an observational design, not an RCT.",
    ),
    NLICase(
        "NLI-CON18",
        "rc-doc-dyslexia-screening-tools",
        (0,),
        "The dyslexia screening-tools report is a randomized controlled trial of intervention "
        "effectiveness.",
        "What kind of study is the dyslexia screening-tools report?",
        "contradiction",
        "wrong_methodology_claim",
        "dyslexia_intervention",
        "Chunk 0 describes an instrument-comparison report (administration time/predictive "
        "accuracy), not an intervention RCT.",
    ),
    NLICase(
        "NLI-CON19",
        "rc-doc-adaptive-learning-study",
        (3,),
        "Increased voluntary practice sessions prove that adaptive difficulty causes higher "
        "engagement.",
        "Does the increase in voluntary practice prove adaptive difficulty causes higher "
        "engagement?",
        "contradiction",
        "correlation_vs_causation",
        "ai_education",
        "Chunk 3/5 report an association and the authors' own attribution/discussion, but chunk 6 "
        "explicitly notes the study COULD NOT separate the adaptive algorithm's effect from "
        "novelty "
        "effects — a causal 'proves' claim is refuted by the study's own limitation.",
    ),
    NLICase(
        "NLI-CON20",
        "rc-doc-academic-vocabulary-study",
        (4,),
        "Higher Spanish literacy proves that cognate instruction causes larger vocabulary gains.",
        "Does higher Spanish literacy prove cognate instruction causes larger gains?",
        "contradiction",
        "correlation_vs_causation",
        "multilingual_learners",
        "Chunk 4 reports a moderator/association ('vocabulary gain was significantly larger for "
        "students with higher Spanish literacy'), never a proven causal claim — 'proves ... "
        "causes' "
        "overstates an observed moderation.",
    ),
    NLICase(
        "NLI-CON21",
        "rc-doc-formative-assessment-study",
        (5,),
        "The study proves that faster teacher response, and nothing else, causes the achievement "
        "gap to narrow.",
        "What does the study prove causes the achievement gap to narrow?",
        "contradiction",
        "correlation_vs_causation",
        "formative_assessment",
        "Chunk 5 offers faster teacher response as the authors' interpretation, but chunk 6 "
        "explicitly notes unblinded teachers and extra planning time as confounds — undermines a "
        "strict 'proves ... and nothing else' causal claim.",
    ),
    NLICase(
        "NLI-CON22",
        "rc-doc-phonics-rct",
        (0,),
        "This 2015 study examined systematic phonics instruction.",
        "What year was the phonics study conducted?",
        "contradiction",
        "wrong_date_year",
        "reading_science",
        "No date is given in-corpus for the phonics RCT beyond its framing as a current trial; "
        "treated as CONTRADICTION under this corpus's convention (established in M5.7) that a "
        "specific fabricated year not present in the source is a wrong-date claim rather than a "
        "silent gap, since the claim asserts a specific, checkable, absent fact as if it were "
        "established.",
    ),
    NLICase(
        "NLI-CON23",
        "rc-doc-spaced-repetition-meta",
        (2,),
        "The spaced-repetition meta-analysis pooled studies published between 1990 and 2019.",
        "What years did the pooled studies span?",
        "entailment",
        "direct_support",
        "spaced_repetition",
        "Chunk 2 states this directly — kept as a paired ENTAILMENT control alongside NLI-CON22's "
        "fabricated-year contrast for the same document family.",
    ),
    NLICase(
        "NLI-CON24",
        "rc-doc-spaced-repetition-meta",
        (2,),
        "The spaced-repetition meta-analysis pooled studies published between 1950 and 1980.",
        "What years did the pooled studies span?",
        "contradiction",
        "wrong_date_year",
        "spaced_repetition",
        "Chunk 2 states 1990-2019 explicitly — a fabricated, wrong date range directly "
        "contradicted "
        "by the stated range.",
    ),
    NLICase(
        "NLI-CON25",
        "rc-doc-dyslexia-screening-tools",
        (1,),
        "The Rapid Letter Naming Screener flagged 14 percent of the kindergarten cohort as "
        "at-risk.",
        "What percentage did the Rapid Letter Naming Screener flag as at-risk?",
        "contradiction",
        "entity_confusion",
        "dyslexia_intervention",
        "Chunk 1 attributes 14 percent to PAS; chunk 2 states RLNS flagged 9 percent — swapping "
        "the "
        "instrument name onto the wrong figure is an entity-confusion contradiction.",
    ),
    NLICase(
        "NLI-CON26",
        "rc-doc-executive-function-screening-report",
        (1,),
        "CEFC is a 20-item checklist taking approximately 10 minutes per student.",
        "How long does CEFC take to administer?",
        "contradiction",
        "entity_confusion",
        "executive_function",
        "Chunk 1 attributes the 20-item/10-minute figures to BRI-SF; chunk 2 states CEFC is 35 "
        "items/18 minutes — swapped instrument attributes.",
    ),
    NLICase(
        "NLI-CON27",
        "rc-doc-dyslexia-screening-tools",
        (2,),
        "CELB takes approximately 4 minutes per student to administer.",
        "How long does CELB take to administer?",
        "contradiction",
        "entity_confusion",
        "dyslexia_intervention",
        "Chunk 2 attributes 4 minutes to RLNS; chunk 3 states CELB takes 25 minutes — swapped "
        "instrument attributes.",
    ),
    NLICase(
        "NLI-CON28",
        "rc-doc-phonics-rct",
        (4,),
        "The embedded-phonics group scored higher than the systematic-phonics group on decoding.",
        "Which group scored higher on decoding?",
        "contradiction",
        "decrease_vs_increase",
        "reading_science",
        "Chunk 4 states the systematic group scored HIGHER (42.3 vs 31.7) — the claim reverses "
        "which group led, an opposite-direction contradiction.",
    ),
    NLICase(
        "NLI-CON29",
        "rc-doc-adaptive-learning-study",
        (3,),
        "Voluntary practice sessions decreased in adaptive-difficulty classrooms over the "
        "semester.",
        "Did voluntary practice sessions decrease under adaptive difficulty?",
        "contradiction",
        "decrease_vs_increase",
        "ai_education",
        "Chunk 3 states practice sessions INCREASED by 34 percent — direct decrease-vs-increase "
        "reversal.",
    ),
    NLICase(
        "NLI-CON30",
        "rc-doc-udl-implementation-study",
        (3,),
        "Active-participation rates decreased after UDL-aligned lesson redesign.",
        "Did participation rates decrease after UDL redesign?",
        "contradiction",
        "decrease_vs_increase",
        "udl_accessibility",
        "Chunk 3 states rates increased from 61 to 79 percent — direct reversal.",
    ),
    NLICase(
        "NLI-CON31",
        "rc-doc-academic-vocabulary-study",
        (3,),
        "Academic vocabulary scores decreased in the cognate-instruction group relative to the "
        "standard-curriculum group.",
        "Did vocabulary scores decrease with cognate instruction?",
        "contradiction",
        "decrease_vs_increase",
        "multilingual_learners",
        "Chunk 3 states scores increased more (11.3 vs 6.1 points) — direct reversal.",
    ),
    NLICase(
        "NLI-CON32",
        "rc-doc-formative-assessment-study",
        (3,),
        "Weekly quizzes produced higher end-of-unit scores than daily formative checks.",
        "Which condition produced higher end-of-unit scores?",
        "contradiction",
        "opposite_comparison_direction",
        "formative_assessment",
        "Chunk 3 states the daily-check group scored higher — direct comparison-direction "
        "reversal.",
    ),
    NLICase(
        "NLI-CON33",
        "rc-doc-pbl-stem-study",
        (4,),
        "Traditional-instruction students reported higher intrinsic motivation than PBL students.",
        "Which group reported higher motivation?",
        "contradiction",
        "opposite_comparison_direction",
        "project_based_learning",
        "Chunk 4 states PBL students reported higher motivation (3.8 vs 3.1) — direct reversal.",
    ),
    NLICase(
        "NLI-CON34",
        "rc-doc-spaced-repetition-meta",
        (4,),
        "Fixed-interval spacing schedules outperformed expanding-interval spacing schedules.",
        "Which spacing schedule performed better?",
        "contradiction",
        "opposite_comparison_direction",
        "spaced_repetition",
        "Chunk 4 states expanding-interval outperformed fixed-interval (d=0.71 vs d=0.54) — direct "
        "reversal.",
    ),
    NLICase(
        "NLI-CON35",
        "rc-doc-dyslexia-structured-literacy-study",
        (3,),
        "The standard-support group's decoding gains did not differ from the structured-literacy "
        "group's gains.",
        "Did the two groups' decoding gains differ?",
        "contradiction",
        "supports_vs_does_not_support",
        "dyslexia_intervention",
        "Chunk 3 reports a large, explicit difference (18.4 vs 6.2 points, d=0.89) — the evidence "
        "does NOT support 'no difference'; it actively contradicts it.",
    ),
    NLICase(
        "NLI-CON36",
        "rc-doc-growth-mindset-study",
        (4,),
        "The evidence does not support any GPA benefit for any subgroup in the growth-mindset "
        "study.",
        "Does the evidence support a GPA benefit for any subgroup?",
        "contradiction",
        "supports_vs_does_not_support",
        "growth_mindset",
        "Chunk 4 explicitly reports a significant subgroup benefit — the evidence DOES support a "
        "subgroup benefit, directly refuting 'does not support any'.",
    ),
    NLICase(
        "NLI-CON37",
        "rc-doc-udl-implementation-study",
        (3,),
        "The evidence does not support any participation improvement from UDL redesign.",
        "Does the evidence support a participation improvement?",
        "contradiction",
        "supports_vs_does_not_support",
        "udl_accessibility",
        "Chunk 3 explicitly reports a large participation increase — directly refutes 'does not "
        "support any'.",
    ),
    NLICase(
        "NLI-CON38",
        "rc-doc-executive-function-training-study",
        (3,),
        "The evidence does not support any working-memory-task improvement from the training.",
        "Does the evidence support a working-memory-task improvement?",
        "contradiction",
        "supports_vs_does_not_support",
        "executive_function",
        "Chunk 3 explicitly reports a large near-transfer gain (d=0.81) — directly refutes 'does "
        "not support any'.",
    ),
    NLICase(
        "NLI-CON39",
        "rc-doc-formative-assessment-study",
        (3,),
        "The evidence does not support any test-score benefit from daily formative checks.",
        "Does the evidence support a test-score benefit?",
        "contradiction",
        "supports_vs_does_not_support",
        "formative_assessment",
        "Chunk 3 explicitly reports a significant 7.8-point benefit — directly refutes 'does not "
        "support any'.",
    ),
    NLICase(
        "NLI-CON40",
        "rc-doc-academic-vocabulary-study",
        (3,),
        "The evidence does not support any vocabulary-score benefit from cognate instruction.",
        "Does the evidence support a vocabulary-score benefit?",
        "contradiction",
        "supports_vs_does_not_support",
        "multilingual_learners",
        "Chunk 3 explicitly reports a larger increase for the cognate-instruction group — directly "
        "refutes 'does not support any'.",
    ),
    # -----------------------------------------------------------------
    # NEUTRAL, batch 2 (19 more) — added after the first NEUTRAL-drafted
    # batch above mostly turned out (on manual review) to be explicit
    # refutations rather than genuine silence, an honest finding disclosed
    # in the Milestone 8 report rather than hidden. This batch uses a
    # deliberately different, lower-risk construction: an intro/overview/
    # methods chunk from a document (which describes setup, not results)
    # paired with a hypothesis about a specific detail that lives only in
    # a LATER chunk of the SAME document — the earlier chunk genuinely
    # never touches the claim, in either direction.
    # -----------------------------------------------------------------
    NLICase(
        "NLI-NEU33",
        "rc-doc-phonics-rct",
        (1,),
        "The systematic phonics group scored significantly higher on listening comprehension.",
        "Did the systematic phonics group score higher on comprehension?",
        "neutral",
        "topically_related_silent",
        "reading_science",
        "Chunk 1 is a literature-review of PRIOR studies' effect-size ranges; it never states THIS "
        "study's own comprehension result (that's chunk 5) — genuinely silent here.",
    ),
    NLICase(
        "NLI-NEU34",
        "rc-doc-adaptive-learning-study",
        (2,),
        "Students found the adaptive learning platform easy to use.",
        "Did students find the platform easy to use?",
        "neutral",
        "topically_related_silent",
        "ai_education",
        "Chunk 2 only describes the methods (schools, sample size, measurement approach) — never "
        "addresses ease-of-use at all.",
    ),
    NLICase(
        "NLI-NEU35",
        "rc-doc-dyslexia-structured-literacy-study",
        (1,),
        "The structured literacy intervention produced a decoding effect size of d=0.89.",
        "What effect size did the structured literacy intervention produce?",
        "neutral",
        "topically_related_silent",
        "dyslexia_intervention",
        "Chunk 1 is a literature-review of prior structured-literacy research generally; the "
        "specific d=0.89 figure lives only in chunk 3.",
    ),
    NLICase(
        "NLI-NEU36",
        "rc-doc-growth-mindset-study",
        (0,),
        "The growth-mindset intervention group had a mean GPA of 2.81.",
        "What was the intervention group's mean GPA?",
        "neutral",
        "topically_related_silent",
        "growth_mindset",
        "Chunk 0 only frames what is being tested (a two-session intervention's effect on GPA) — "
        "the specific mean value lives only in chunk 3.",
    ),
    NLICase(
        "NLI-NEU37",
        "rc-doc-executive-function-training-study",
        (0,),
        "Working-memory training produced a near-transfer effect size of d=0.81.",
        "What near-transfer effect size did the training produce?",
        "neutral",
        "topically_related_silent",
        "executive_function",
        "Chunk 0 only frames the research question — the specific effect size lives only in chunk "
        "3.",
    ),
    NLICase(
        "NLI-NEU38",
        "rc-doc-formative-assessment-study",
        (0,),
        "Daily formative checks produced a 7.8-point score advantage.",
        "How many points higher did daily checks score?",
        "neutral",
        "topically_related_silent",
        "formative_assessment",
        "Chunk 0 only frames the comparison being tested — the specific point value lives only in "
        "chunk 3.",
    ),
    NLICase(
        "NLI-NEU39",
        "rc-doc-udl-implementation-study",
        (1,),
        "UDL redesign increased active-participation rates from 61 to 79 percent.",
        "What participation-rate change did UDL redesign produce?",
        "neutral",
        "topically_related_silent",
        "udl_accessibility",
        "Chunk 1 is a conceptual literature-review statement about UDL's premise generally — the "
        "specific 61-to-79-percent figures live only in chunk 3.",
    ),
    NLICase(
        "NLI-NEU40",
        "rc-doc-academic-vocabulary-study",
        (0,),
        "Cognate instruction increased vocabulary scores by 11.3 points.",
        "How many points did cognate instruction increase scores by?",
        "neutral",
        "topically_related_silent",
        "multilingual_learners",
        "Chunk 0 only frames the research question — the specific point value lives only in chunk "
        "3.",
    ),
    NLICase(
        "NLI-NEU41",
        "rc-doc-spaced-repetition-meta",
        (1,),
        "The spaced-repetition meta-analysis found a pooled effect size of d=0.62.",
        "What pooled effect size did the meta-analysis find?",
        "neutral",
        "topically_related_silent",
        "spaced_repetition",
        "Chunk 1 is a literature-review statement about where the spacing effect has been "
        "demonstrated generally — the specific pooled d-value lives only in chunk 3.",
    ),
    NLICase(
        "NLI-NEU42",
        "rc-doc-pbl-stem-study",
        (0,),
        "The PBL STEM study found no significant difference in content mastery (p=0.29).",
        "What p-value did the study report for content mastery?",
        "neutral",
        "topically_related_silent",
        "project_based_learning",
        "Chunk 0 only frames the comparison being studied — the specific p-value lives only in "
        "chunk 3.",
    ),
    NLICase(
        "NLI-NEU43",
        "rc-doc-udl-multilingual-policy",
        (0,),
        "The UDL multilingual policy reports a measurable vocabulary-score improvement.",
        "What vocabulary-score improvement does the policy report?",
        "neutral",
        "topically_related_silent",
        "udl_accessibility",
        "Chunk 0 only overviews the policy's scope (connecting UDL principles to multilingual "
        "supports) — it is a guidance document with no outcome data anywhere, and this chunk in "
        "particular never touches outcome numbers either way.",
    ),
    NLICase(
        "NLI-NEU44",
        "rc-doc-explainable-ai-curriculum",
        (0,),
        "The explainable AI curriculum unit spans five class periods.",
        "How many class periods does the unit span?",
        "neutral",
        "topically_related_silent",
        "ai_education",
        "Chunk 0 only overviews the curriculum's topics — the specific five-period figure lives "
        "only in chunk 4.",
    ),
    NLICase(
        "NLI-NEU45",
        "rc-doc-exit-tickets-guide",
        (0,),
        "Exit-ticket responses should be sorted into three piles rather than graded.",
        "How does the guide recommend sorting exit-ticket responses?",
        "neutral",
        "topically_related_silent",
        "formative_assessment",
        "Chunk 0 only overviews what an exit ticket is — the specific three-pile sorting "
        "recommendation lives only in chunk 2.",
    ),
    NLICase(
        "NLI-NEU46",
        "rc-doc-driving-questions-guide",
        (1,),
        "The guide recommends piloting a new driving question with a single class before a "
        "school-wide rollout.",
        "How does the guide recommend piloting a new driving question?",
        "neutral",
        "topically_related_silent",
        "project_based_learning",
        "Chunk 1 only defines what makes a driving question effective in the abstract — the "
        "specific piloting recommendation lives only in chunk 3.",
    ),
    NLICase(
        "NLI-NEU47",
        "rc-doc-translanguaging-guide",
        (0,),
        "Allowing home-language use only during informal moments sends students a negative "
        "message.",
        "What pitfall does the guide identify about home-language use?",
        "neutral",
        "topically_related_silent",
        "multilingual_learners",
        "Chunk 0 only overviews the translanguaging concept generally — the specific "
        "informal-moments-only pitfall lives only in chunk 4.",
    ),
    NLICase(
        "NLI-NEU48",
        "rc-doc-growth-mindset-language-guide",
        (0,),
        "The guide recommends process praise over person praise.",
        "What praise language does the guide recommend?",
        "neutral",
        "topically_related_silent",
        "growth_mindset",
        "Chunk 0 only overviews the guide's scope (praise/feedback language) — the specific "
        "process-vs-person-praise recommendation lives only in chunk 1.",
    ),
    NLICase(
        "NLI-NEU49",
        "rc-doc-dyslexia-screening-tools",
        (0,),
        "The Phonological Awareness Screener flagged 14 percent of the cohort as at-risk.",
        "What percentage did the Phonological Awareness Screener flag?",
        "neutral",
        "topically_related_silent",
        "dyslexia_intervention",
        "Chunk 0 only overviews that three instruments are being compared — the specific "
        "14-percent "
        "figure lives only in chunk 1.",
    ),
    NLICase(
        "NLI-NEU50",
        "rc-doc-executive-function-screening-report",
        (0,),
        "CEFC is a 35-item checklist taking approximately 18 minutes to complete.",
        "How many items does CEFC have and how long does it take?",
        "neutral",
        "topically_related_silent",
        "executive_function",
        "Chunk 0 only overviews that two instruments are being compared — the specific "
        "item-count/timing figures live only in chunk 2.",
    ),
    NLICase(
        "NLI-NEU51",
        "rc-doc-spaced-practice-classroom",
        (0,),
        "A cumulative warm-up revisits content from two, four, and eight weeks prior.",
        "What does the guide's cumulative warm-up revisit?",
        "neutral",
        "topically_related_silent",
        "spaced_repetition",
        "Chunk 0 only overviews that the guide translates spacing research into lesson-planning "
        "routines — the specific warm-up structure lives only in chunk 1.",
    ),
]

# NLI-NEU11 and NLI-NEU14/16/18/19/21/22/23/24/25/26/27/28/29/30/31/32 are
# intentionally labeled "contradiction" despite the "NEU" id prefix — they
# were authored while drafting the NEUTRAL bucket and, on manual review,
# turned out to be explicit-refutation cases rather than genuine silence
# (see each one's own `notes`). Kept under their original ids rather than
# renumbered, exactly as manual review actually happened, per this
# project's established practice of not silently reshaping ground truth
# after the fact. NLI-NEU17 similarly turned out to be ENTAILMENT.

CONFLICTING_SOURCE_CASES: list[ConflictingSourceCase] = [
    ConflictingSourceCase(
        "NLI-CFL01",
        "The growth-mindset intervention improved GPA.",
        "Did the growth-mindset intervention improve GPA?",
        "rc-doc-growth-mindset-study",
        3,
        "contradiction",
        "rc-doc-growth-mindset-study",
        4,
        "entailment",
        "growth_mindset",
        "Same document, two chunks genuinely disagree depending on scope: chunk3 (no significant "
        "difference on AVERAGE) contradicts the unqualified claim; chunk4 (significant subgroup "
        "benefit) entails a narrower version of it. Tests whether source-level analysis correctly "
        "reports BOTH signals rather than collapsing to one.",
    ),
    ConflictingSourceCase(
        "NLI-CFL02",
        "Project-based learning improved outcomes compared to traditional instruction.",
        "Did PBL improve outcomes compared to traditional instruction?",
        "rc-doc-pbl-stem-study",
        3,
        "contradiction",
        "rc-doc-pbl-stem-study",
        4,
        "entailment",
        "project_based_learning",
        "chunk3 (no significant mastery difference) contradicts an unqualified 'improved outcomes' "
        "claim; chunk4 (significantly higher motivation) entails it under a motivation-specific "
        "reading. A real within-document outcome-type ambiguity.",
    ),
    ConflictingSourceCase(
        "NLI-CFL03",
        "Working-memory training improved academic performance.",
        "Did working-memory training improve academic performance?",
        "rc-doc-executive-function-training-study",
        3,
        "entailment",
        "rc-doc-executive-function-training-study",
        4,
        "contradiction",
        "executive_function",
        "chunk3 (large near-transfer gain on the trained task itself) entails a narrow 'improved "
        "performance [on the trained task]' reading; chunk4 (no far-transfer to math achievement) "
        "contradicts the broader 'academic performance' reading. Directly matches the study's own "
        "near-transfer/far-transfer distinction.",
    ),
    ConflictingSourceCase(
        "NLI-CFL04",
        "UDL redesign improved outcomes for students.",
        "Did UDL redesign improve outcomes for students?",
        "rc-doc-udl-implementation-study",
        3,
        "entailment",
        "rc-doc-udl-implementation-study",
        4,
        "contradiction",
        "udl_accessibility",
        "chunk3 (participation increased significantly) entails a participation-outcome reading; "
        "chunk4 (test scores did not significantly change) contradicts an achievement-outcome "
        "reading of the same general claim.",
    ),
    ConflictingSourceCase(
        "NLI-CFL05",
        "Systematic phonics instruction improved reading outcomes for kindergartners.",
        "Did systematic phonics improve reading outcomes?",
        "rc-doc-phonics-rct",
        4,
        "entailment",
        "rc-doc-phonics-rct",
        5,
        "contradiction",
        "reading_science",
        "chunk4 (significantly higher decoding) entails a decoding-outcome reading; chunk5 (no "
        "significant comprehension difference) contradicts a comprehension-outcome reading of the "
        "same general 'reading outcomes' claim — the study's own decoding/comprehension split.",
    ),
    ConflictingSourceCase(
        "NLI-CFL06",
        "The corpus contains a document that both praises and specifically critiques balanced "
        "literacy's three-cueing strategy.",
        "Does any document both describe and critique three-cueing?",
        "rc-doc-balanced-literacy-review",
        1,
        "neutral",
        "rc-doc-balanced-literacy-review",
        3,
        "entailment",
        "reading_science",
        "chunk1 (neutral description of what three-cueing is) is NEUTRAL toward the compound claim "
        "on its own; chunk3 (explicit critique) entails the critique half — together the two "
        "chunks "
        "illustrate a single document containing both descriptive and critical framing, useful for "
        "testing whether NEUTRAL+ENTAILMENT can coexist without being confused for CONTRADICTION.",
    ),
]


def all_single_premise_cases() -> list[NLICase]:
    return list(NLI_CASES)


def _integrity_check() -> None:
    seen: set[str] = set()
    for case in NLI_CASES:
        if case.case_id in seen:
            raise AssertionError(f"duplicate case_id {case.case_id!r}")
        seen.add(case.case_id)
    for case in CONFLICTING_SOURCE_CASES:
        if case.case_id in seen:
            raise AssertionError(f"duplicate case_id {case.case_id!r}")
        seen.add(case.case_id)

    counts: dict[str, int] = {}
    for case in NLI_CASES:
        counts[case.gold_label] = counts.get(case.gold_label, 0) + 1
    if counts.get("entailment", 0) < 30:
        raise AssertionError(f"entailment count {counts.get('entailment', 0)} below target of 30")
    if counts.get("neutral", 0) < 30:
        # Several originally-"NEU"-prefixed cases in batch 1 were
        # reclassified to contradiction on manual review (see the module
        # comment above) — batch 2 (NLI-NEU33 onward) was added
        # specifically to bring the true neutral count back up to the
        # Milestone 8 §9 target of ~30 using a lower-risk construction.
        raise AssertionError(f"neutral count {counts.get('neutral', 0)} below target of 30")
    if counts.get("contradiction", 0) < 40:
        raise AssertionError(
            f"contradiction count {counts.get('contradiction', 0)} below target of 40"
        )

    represented_categories = {case.category for case in NLI_CASES}
    contradiction_subtypes = {
        "explicit_negation",
        "no_significant_difference",
        "decrease_vs_increase",
        "supports_vs_does_not_support",
        "wrong_numerical_claim",
        "wrong_population_claim",
        "wrong_methodology_claim",
        "correlation_vs_causation",
        "stronger_claim_than_source",
        "wrong_date_year",
        "entity_confusion",
        "opposite_comparison_direction",
    }
    missing = contradiction_subtypes - represented_categories
    if missing:
        raise AssertionError(f"missing required contradiction subtypes: {missing}")


_integrity_check()
