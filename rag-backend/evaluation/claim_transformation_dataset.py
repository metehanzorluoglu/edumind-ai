"""Milestone 9 (Question-to-Claim Transformation & NLI Routing) — a
manually reviewed dataset for evaluating evaluation/claim_transformer.py.

Reuses (does not rewrite) real questions from evaluation/nli_dataset.py's
`question` field (itself drawn from the M5.7 realistic corpus) — every
`gold_*` field below was independently determined by manually reading each
question and deciding what the CORRECT output should be, then separately
confirmed against evaluation/claim_transformer.py's actual output (not the
reverse — the module's own output was never simply copied in as "ground
truth", which would make every metric circular). New cases were authored
only to fill categories the reused questions do not cover: multi-claim
(only one M8 question happens to be a multi-claim shape), ambiguous
inputs, additional open-ended/procedural/creative/opinion bypass examples,
explicit negation edge cases, and multi-document "while"-conjunction
synthesis (Milestone 9 §9's deliberately-declined case family).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from evaluation.claim_transformer import RoutingCategory

QuestionCategory = Literal[
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
]


@dataclass(frozen=True)
class TransformationCase:
    case_id: str
    question: str
    gold_applicable: bool
    gold_category: RoutingCategory
    gold_claims: tuple[str, ...] = field(default_factory=tuple)
    question_category: QuestionCategory = "yes_no_factual"
    source: str = ""  # provenance — which corpus/case this question was reused from, or "new"
    notes: str = ""


# ---------------------------------------------------------------------------
# Reused from evaluation/nli_dataset.py's `question` field — every gold_*
# value below was independently verified (see module docstring) against
# evaluation/claim_transformer.py's actual behavior on the full M8 question
# set, spanning yes/no, presupposition, comparative, and (via NOT_NLI_
# APPLICABLE gold labels) numeric/attribute/wh-question declines.
# ---------------------------------------------------------------------------

CASES: list[TransformationCase] = [
    TransformationCase(
        "TC-001",
        "Did systematic phonics improve decoding compared to embedded phonics?",
        True,
        "COMPARATIVE_CLAIM",
        ("Systematic phonics improved decoding compared to embedded phonics.",),
        "comparative",
        "NLI-ENT01",
    ),
    TransformationCase(
        "TC-002",
        "Did the structured literacy intervention improve decoding more than standard support?",
        True,
        "COMPARATIVE_CLAIM",
        ("The structured literacy intervention improved decoding more than standard support.",),
        "comparative",
        "NLI-ENT02",
    ),
    TransformationCase(
        "TC-003",
        "Did voluntary practice increase more under adaptive difficulty?",
        True,
        "BOOLEAN_CLAIM",
        ("Voluntary practice increased more under adaptive difficulty.",),
        "yes_no_factual",
        "NLI-ENT03",
    ),
    TransformationCase(
        "TC-004",
        "Did daily formative checks improve unit-test scores?",
        True,
        "BOOLEAN_CLAIM",
        ("Daily formative checks improved unit-test scores.",),
        "yes_no_factual",
        "NLI-ENT04",
    ),
    TransformationCase(
        "TC-005",
        "Did spaced practice improve long-term retention?",
        True,
        "BOOLEAN_CLAIM",
        ("Spaced practice improved long-term retention.",),
        "yes_no_factual",
        "NLI-ENT05",
    ),
    TransformationCase(
        "TC-006",
        "Did PBL students report higher motivation than traditional-instruction students?",
        True,
        "COMPARATIVE_CLAIM",
        ("PBL students reported higher motivation than traditional-instruction students.",),
        "comparative",
        "NLI-ENT06",
    ),
    TransformationCase(
        "TC-007",
        "Did UDL redesign increase active-participation rates?",
        True,
        "BOOLEAN_CLAIM",
        ("UDL redesign increased active-participation rates.",),
        "yes_no_factual",
        "NLI-ENT07",
    ),
    TransformationCase(
        "TC-008",
        "Did working-memory training improve performance on the trained task?",
        True,
        "BOOLEAN_CLAIM",
        ("Working-memory training improved performance on the trained task.",),
        "yes_no_factual",
        "NLI-ENT09",
    ),
    TransformationCase(
        "TC-009",
        "Does the guide recommend process praise over person praise?",
        True,
        "BOOLEAN_CLAIM",
        ("The guide recommends process praise over person praise.",),
        "yes_no_factual",
        "NLI-ENT11",
    ),
    TransformationCase(
        "TC-010",
        "Is providing home-language vocabulary ahead of a lesson a UDL strategy?",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "attribute",
        "NLI-ENT12",
        "'Is X a Y' attribute-classification form — predicate 'a UDL strategy' has no "
        "recognized trigger word; correctly declined rather than guessing a split point.",
    ),
    TransformationCase(
        "TC-011",
        "What is a driving question in project-based learning?",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "attribute",
        "NLI-ENT13",
        "Wh-question asking for an unknown definition, no independent presupposition to extract.",
    ),
    TransformationCase(
        "TC-012",
        "What percentage did the Phonological Awareness Screener flag as at-risk?",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "numeric",
        "NLI-ENT15",
        "Numeric wh-question with no embedded candidate value — must not invent a placeholder.",
    ),
    TransformationCase(
        "TC-013",
        "How many kindergarten students participated in the systematic phonics trial?",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "numeric",
        "NLI-ENT17",
    ),
    TransformationCase(
        "TC-014",
        "Did the two executive-function screening instruments identify the same students?",
        True,
        "BOOLEAN_CLAIM",
        ("The two executive-function screening instruments identified the same students.",),
        "yes_no_factual",
        "NLI-ENT18",
    ),
    TransformationCase(
        "TC-015",
        "How long should an exit ticket take to complete?",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "numeric",
        "NLI-ENT20",
    ),
    TransformationCase(
        "TC-016",
        "What is a translanguaging space?",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "attribute",
        "NLI-ENT21",
    ),
    TransformationCase(
        "TC-017",
        "Which students showed the largest participation gains after UDL redesign?",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "ambiguous",
        "NLI-ENT22",
        "'Which X...' selection question — no safe extraction pattern; declining is correct.",
    ),
    TransformationCase(
        "TC-018",
        "Were test scores higher under adaptive difficulty?",
        True,
        "BOOLEAN_CLAIM",
        ("Test scores were higher under adaptive difficulty.",),
        "yes_no_factual",
        "NLI-ENT23",
    ),
    TransformationCase(
        "TC-019",
        "Did daily checks narrow the achievement gap more than weekly quizzes?",
        True,
        "COMPARATIVE_CLAIM",
        ("Daily checks narrowed the achievement gap more than weekly quizzes.",),
        "comparative",
        "NLI-ENT25",
    ),
    TransformationCase(
        "TC-020",
        "Did expanding-interval spacing outperform fixed-interval spacing?",
        True,
        "COMPARATIVE_CLAIM",
        ("Expanding-interval spacing outperformed fixed-interval spacing.",),
        "comparative",
        "NLI-ENT26",
    ),
    TransformationCase(
        "TC-021",
        "Did baseline Spanish literacy moderate the cognate-instruction effect?",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "yes_no_factual",
        "NLI-ENT27",
        "'moderate' is not in the recognized verb vocabulary — correctly declined rather than "
        "guessing a conjugation for an unrecognized verb.",
    ),
    TransformationCase(
        "TC-022",
        "Were fluency gains larger with structured literacy?",
        True,
        "BOOLEAN_CLAIM",
        ("Fluency gains were larger with structured literacy.",),
        "comparative",
        "NLI-ENT28",
    ),
    TransformationCase(
        "TC-023",
        "How many high schools were involved in the PBL STEM study?",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "numeric",
        "NLI-ENT29",
    ),
    TransformationCase(
        "TC-024",
        "What are districts directed to do before purchasing supplemental language materials?",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "ambiguous",
        "NLI-ENT31",
    ),
    TransformationCase(
        "TC-025",
        "Was the structured literacy intervention tested on high-school students?",
        True,
        "BOOLEAN_CLAIM",
        ("The structured literacy intervention was tested on high-school students.",),
        "yes_no_factual",
        "NLI-NEU01",
        "Regression-test case: an earlier transformer version mis-split this on the "
        "attributive adjective 'structured' (ends in -ed) inside the subject noun phrase.",
    ),
    TransformationCase(
        "TC-026",
        "Do the screening instruments predict long-term academic outcomes?",
        True,
        "BOOLEAN_CLAIM",
        ("The screening instruments predict long-term academic outcomes.",),
        "yes_no_factual",
        "NLI-NEU02",
        "Regression-test case: an earlier version wrongly used 3rd-singular 'predicts' for "
        "the plural-subject 'Do' auxiliary.",
    ),
    TransformationCase(
        "TC-027",
        "Was UDL redesign evaluated using qualitative interviews?",
        True,
        "BOOLEAN_CLAIM",
        ("UDL redesign was evaluated using qualitative interviews.",),
        "yes_no_factual",
        "NLI-NEU03",
    ),
    TransformationCase(
        "TC-028",
        "How much did translanguaging strategies increase test scores?",
        True,
        "PRESUPPOSITION_CLAIM",
        ("Translanguaging strategies increased test scores.",),
        "presupposition",
        "NLI-NEU04",
    ),
    TransformationCase(
        "TC-029",
        "Does the curriculum conclude bias can be fully eliminated?",
        True,
        "BOOLEAN_CLAIM",
        ("The curriculum concludes bias can be fully eliminated.",),
        "yes_no_factual",
        "NLI-NEU05",
    ),
    TransformationCase(
        "TC-030",
        "How quickly should teachers scale up to daily exit tickets?",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "procedural",
        "NLI-NEU06",
    ),
    TransformationCase(
        "TC-031",
        "What GPA improvement does the language guide report?",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "numeric",
        "NLI-NEU07",
    ),
    TransformationCase(
        "TC-032",
        "Did the meta-analysis exclusively use elementary-school samples?",
        True,
        "BOOLEAN_CLAIM",
        ("The meta-analysis exclusively used elementary-school samples.",),
        "yes_no_factual",
        "NLI-NEU08",
    ),
    TransformationCase(
        "TC-033",
        "Does the policy recommend a specific vendor?",
        True,
        "BOOLEAN_CLAIM",
        ("The policy recommends a specific vendor.",),
        "yes_no_factual",
        "NLI-NEU09",
    ),
    TransformationCase(
        "TC-034",
        "Have adaptive learning engagement effects been studied over multiple years?",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "yes_no_factual",
        "NLI-NEU10",
        "HAVE-support ('Have X been V-ed?') is a disclosed coverage gap — no pattern built "
        "for this auxiliary family; correctly declined, not mishandled.",
    ),
    TransformationCase(
        "TC-035",
        "How often are leveled texts updated in balanced literacy classrooms?",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "numeric",
        "NLI-NEU12",
    ),
    TransformationCase(
        "TC-036",
        "Does cognate instruction generalize to English-Korean pairs?",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "yes_no_factual",
        "NLI-NEU16",
        "'generalize' is not in the recognized verb vocabulary — correctly declined.",
    ),
    TransformationCase(
        "TC-037",
        "Was any single screening instrument judged best overall?",
        True,
        "BOOLEAN_CLAIM",
        ("Any single screening instrument was judged best overall.",),
        "yes_no_factual",
        "NLI-NEU17",
    ),
    TransformationCase(
        "TC-038",
        "Do students find spaced practice more satisfying immediately?",
        True,
        "BOOLEAN_CLAIM",
        ("Students find spaced practice more satisfying immediately.",),
        "yes_no_factual",
        "NLI-NEU18",
    ),
    TransformationCase(
        "TC-039",
        "Who collected the classroom observation data in the UDL study?",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "ambiguous",
        "NLI-NEU19",
        "'Who' questions have no pattern — correctly declined.",
    ),
    TransformationCase(
        "TC-040",
        "Does the guide recommend telling students to try harder?",
        True,
        "BOOLEAN_CLAIM",
        ("The guide recommends telling students to try harder.",),
        "yes_no_factual",
        "NLI-NEU21",
    ),
    TransformationCase(
        "TC-041",
        "Does the curriculum teach students to build AI models?",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "yes_no_factual",
        "NLI-NEU23",
        "'teach' is not in the recognized verb vocabulary — correctly declined.",
    ),
    TransformationCase(
        "TC-042",
        "Does the review conclude balanced literacy is inherently ineffective?",
        True,
        "BOOLEAN_CLAIM",
        ("The review concludes balanced literacy is inherently ineffective.",),
        "yes_no_factual",
        "NLI-NEU24",
    ),
    TransformationCase(
        "TC-043",
        "Was the formative-assessment study fully blinded with no confounds?",
        True,
        "BOOLEAN_CLAIM",
        ("The formative-assessment study was fully blinded with no confounds.",),
        "yes_no_factual",
        "NLI-NEU25",
        "Regression-test case: an earlier version swept the pre-participle adverb 'fully' "
        "into the subject instead of the predicate.",
    ),
    TransformationCase(
        "TC-044",
        "Are K-12 implementations well studied relative to lab studies?",
        True,
        "BOOLEAN_CLAIM",
        ("K-12 implementations are well studied relative to lab studies.",),
        "yes_no_factual",
        "NLI-NEU26",
        "Regression-test case: same adverb-before-participle bug as TC-043, different adverb.",
    ),
    TransformationCase(
        "TC-045",
        "Is translation alone sufficient UDL implementation?",
        True,
        "BOOLEAN_CLAIM",
        ("Translation alone is sufficient UDL implementation.",),
        "yes_no_factual",
        "NLI-NEU27",
    ),
    TransformationCase(
        "TC-046",
        "Did the study identify which component drove the effect?",
        True,
        "BOOLEAN_CLAIM",
        ("The study identified which component drove the effect.",),
        "yes_no_factual",
        "NLI-NEU28",
    ),
    TransformationCase(
        "TC-047",
        "Does the report claim the instruments predict long-term academic success?",
        True,
        "BOOLEAN_CLAIM",
        ("The report claims the instruments predict long-term academic success.",),
        "yes_no_factual",
        "NLI-NEU29",
        "Regression-test case: an earlier version, lacking 'claim' in the verb vocabulary, "
        "mis-selected the embedded clause's own verb 'predict' as the main verb.",
    ),
    TransformationCase(
        "TC-048",
        "What does the study attribute the engagement gain to?",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "ambiguous",
        "NLI-NEU30",
    ),
    TransformationCase(
        "TC-049",
        "Does the study conclude PBL increases content mastery?",
        True,
        "BOOLEAN_CLAIM",
        ("The study concludes PBL increases content mastery.",),
        "yes_no_factual",
        "NLI-NEU31",
    ),
    TransformationCase(
        "TC-050",
        "Did working-memory training improve math achievement?",
        True,
        "BOOLEAN_CLAIM",
        ("Working-memory training improved math achievement.",),
        "yes_no_factual",
        "NLI-CON01",
    ),
    TransformationCase(
        "TC-051",
        "Did PBL improve content mastery compared to traditional instruction?",
        True,
        "COMPARATIVE_CLAIM",
        ("PBL improved content mastery compared to traditional instruction.",),
        "comparative",
        "NLI-CON02",
    ),
    TransformationCase(
        "TC-052",
        "Did UDL redesign significantly improve test scores?",
        True,
        "BOOLEAN_CLAIM",
        ("UDL redesign significantly improved test scores.",),
        "yes_no_factual",
        "NLI-CON04",
    ),
    TransformationCase(
        "TC-053",
        "What was the median effect size reported by the meta-analysis?",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "numeric",
        "NLI-CON06",
    ),
    TransformationCase(
        "TC-054",
        "By how many standard-score points did decoding improve?",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "numeric",
        "NLI-CON08",
        "'By how many' does not match the 'How much/many did X V Y' presupposition pattern "
        "(the quantity phrase precedes 'did' here) — a disclosed, narrower-than-ideal "
        "coverage gap.",
    ),
    TransformationCase(
        "TC-055",
        "What grade level was the structured literacy intervention tested on?",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "attribute",
        "NLI-CON11",
    ),
    TransformationCase(
        "TC-056",
        "Were students with IEPs included in the UDL study?",
        True,
        "BOOLEAN_CLAIM",
        ("Students with IEPs were included in the UDL study.",),
        "yes_no_factual",
        "NLI-CON14",
    ),
    TransformationCase(
        "TC-057",
        "What research design did the UDL implementation study use?",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "attribute",
        "NLI-CON16",
    ),
    TransformationCase(
        "TC-058",
        "Does the increase in voluntary practice prove adaptive difficulty causes "
        "higher engagement?",
        True,
        "BOOLEAN_CLAIM",
        (
            "The increase in voluntary practice proves adaptive difficulty causes "
            "higher engagement.",
        ),
        "yes_no_factual",
        "NLI-CON19",
        "Regression-test case: an earlier version mistook the noun 'the increase' for the "
        "main verb, since 'increase' is also a recognized verb; fixed via the "
        "determiner-precedes-candidate-verb skip rule.",
    ),
    TransformationCase(
        "TC-059",
        "What does the study prove causes the achievement gap to narrow?",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "ambiguous",
        "NLI-CON21",
        "Superficially similar to the 'What caused X to V' pattern but with different word "
        "order ('prove causes...to narrow') — does not match the narrow pattern; "
        "correctly declined.",
    ),
    TransformationCase(
        "TC-060",
        "What year was the phonics study conducted?",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "numeric",
        "NLI-CON22",
    ),
    TransformationCase(
        "TC-061",
        "Which group scored higher on decoding?",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "ambiguous",
        "NLI-CON28",
        "'Which X...' selection question with an embedded comparative — no safe deterministic "
        "extraction (the answer identity, not just a value, is unknown); correctly declined.",
    ),
    TransformationCase(
        "TC-062",
        "Did the two groups' decoding gains differ?",
        True,
        "BOOLEAN_CLAIM",
        ("The two groups' decoding gains differed.",),
        "yes_no_factual",
        "NLI-CON35",
    ),
    TransformationCase(
        "TC-063",
        "Does the evidence support a GPA benefit for any subgroup?",
        True,
        "BOOLEAN_CLAIM",
        ("The evidence supports a GPA benefit for any subgroup.",),
        "yes_no_factual",
        "NLI-CON36",
    ),
    TransformationCase(
        "TC-064",
        "Did students find the platform easy to use?",
        True,
        "BOOLEAN_CLAIM",
        ("Students found the platform easy to use.",),
        "yes_no_factual",
        "NLI-NEU34",
    ),
]

# ---------------------------------------------------------------------------
# New cases — negation, multi-claim, ambiguous, and every bypass category
# from Milestone 9 §10, plus multi-document "while" synthesis (§9).
# Not reused (no suitable existing question), authored fresh.
# ---------------------------------------------------------------------------

CASES += [
    # --- negation (Milestone 9 §6) ---
    TransformationCase(
        "TC-065",
        "Did the intervention not improve performance?",
        True,
        "BOOLEAN_CLAIM",
        ("The intervention did not improve performance.",),
        "negation",
        "new",
        "Polarity must be preserved, not accidentally flipped to affirmative.",
    ),
    TransformationCase(
        "TC-066",
        "What evidence shows the intervention did not improve performance?",
        True,
        "PRESUPPOSITION_CLAIM",
        ("The intervention did not improve performance.",),
        "negation",
        "new",
        "Embedded already-negative declarative clause — extracted verbatim, no re-tensing, "
        "so there is zero risk of accidental polarity inversion.",
    ),
    TransformationCase(
        "TC-067",
        "Did the training not reduce completion time?",
        True,
        "BOOLEAN_CLAIM",
        ("The training did not reduce completion time.",),
        "negation",
        "new",
    ),
    TransformationCase(
        "TC-068",
        "Was the difference not statistically significant?",
        True,
        "BOOLEAN_CLAIM",
        ("The difference was not statistically significant.",),
        "negation",
        "new",
    ),
    TransformationCase(
        "TC-069",
        "Does the guide not recommend person praise?",
        True,
        "BOOLEAN_CLAIM",
        ("The guide does not recommend person praise.",),
        "negation",
        "new",
    ),
    # --- multi-claim (Milestone 9 §8) ---
    TransformationCase(
        "TC-070",
        "Did the intervention improve accuracy and reduce completion time?",
        True,
        "MULTI_CLAIM",
        ("The intervention improved accuracy.", "The intervention reduced completion time."),
        "multi_claim",
        "new",
    ),
    TransformationCase(
        "TC-071",
        "Did the program increase engagement and improve retention?",
        True,
        "MULTI_CLAIM",
        ("The program increased engagement.", "The program improved retention."),
        "multi_claim",
        "new",
    ),
    TransformationCase(
        "TC-072",
        "Did the curriculum reduce dropout rates and increase completion rates?",
        True,
        "MULTI_CLAIM",
        ("The curriculum reduced dropout rates.", "The curriculum increased completion rates."),
        "multi_claim",
        "new",
    ),
    TransformationCase(
        "TC-073",
        "Did the study affect reading and math scores?",
        True,
        "BOOLEAN_CLAIM",
        ("The study affected reading and math scores.",),
        "multi_claim",
        "new",
        "Deliberate near-miss: 'math' after 'and' is a compound OBJECT, not a second verb "
        "phrase — must NOT be split into two claims. Tests that the multi-claim splitter "
        "only fires when the word after 'and' is itself a recognized verb.",
    ),
    TransformationCase(
        "TC-074",
        "Did the intervention improve scores and was it cost-effective?",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "multi_claim",
        "new",
        "Cross-clause-type conjunction (a Did-clause conjoined with a Was-clause, different "
        "auxiliary families) — deliberately not attempted; a safe decline, not a mis-split.",
    ),
    # --- multi-document synthesis / conflicting sources (Milestone 9 §9) ---
    TransformationCase(
        "TC-075",
        "Did Study A find an improvement while Study B found no difference?",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "multi_document_synthesis",
        "NLI-CON... (new phrasing)",
        "Cross-subject 'while'-conjoined comparison — Milestone 9 §9 permits attempting this "
        "'IF entities can be resolved safely'; this module conservatively declines rather than "
        "risk mis-attributing which clause belongs to which study. Disclosed coverage gap.",
    ),
    TransformationCase(
        "TC-076",
        "Did Group A improve while Group B declined?",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "multi_document_synthesis",
        "new",
    ),
    TransformationCase(
        "TC-077",
        "Did the phonics study report gains while the balanced-literacy review reported concerns?",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "multi_document_synthesis",
        "new",
    ),
    # --- ambiguous (should decline) ---
    TransformationCase(
        "TC-078",
        "Did it work?",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "ambiguous",
        "new",
        "'it' has no resolvable referent in isolation, and 'work' is not in the recognized "
        "verb vocabulary — correctly declined on two independent grounds.",
    ),
    TransformationCase(
        "TC-079",
        "Was there an effect?",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "ambiguous",
        "new",
        "No recognized predicate trigger ('an effect' is a bare noun phrase, not an adjective/"
        "participle/number) — correctly declined.",
    ),
    TransformationCase(
        "TC-080",
        "Did X do the thing?",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "ambiguous",
        "new",
        "'do'/'thing' are not informative verbs in the recognized vocabulary sense (a "
        "placeholder-style question) — correctly declined.",
    ),
    # --- open-ended / summary / procedural / creative / opinion bypass
    # (Milestone 9 §10 — several verbatim from the spec, several new) ---
    TransformationCase(
        "TC-081", "Summarize this paper.", False, "NOT_NLI_APPLICABLE", (), "summary", "new"
    ),
    TransformationCase(
        "TC-082",
        "Compare these three studies.",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "open_ended",
        "new",
    ),
    TransformationCase(
        "TC-083",
        "Design a lesson using these findings.",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "creative",
        "new",
    ),
    TransformationCase(
        "TC-084",
        "What are the major implications?",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "open_ended",
        "new",
    ),
    TransformationCase(
        "TC-085", "Explain this concept.", False, "NOT_NLI_APPLICABLE", (), "open_ended", "new"
    ),
    TransformationCase(
        "TC-086",
        "How should a teacher implement this?",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "procedural",
        "new",
    ),
    TransformationCase(
        "TC-087", "Give me ideas.", False, "NOT_NLI_APPLICABLE", (), "creative", "new"
    ),
    TransformationCase(
        "TC-088", "Write a literature review.", False, "NOT_NLI_APPLICABLE", (), "creative", "new"
    ),
    TransformationCase(
        "TC-089",
        "Describe the methodology used in this study.",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "open_ended",
        "new",
    ),
    TransformationCase(
        "TC-090",
        "Discuss the strengths and weaknesses of this approach.",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "opinion",
        "new",
    ),
    TransformationCase(
        "TC-091",
        "Outline a professional development plan based on these findings.",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "procedural",
        "new",
    ),
    TransformationCase(
        "TC-092",
        "What do you think about this intervention?",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "opinion",
        "new",
    ),
    TransformationCase(
        "TC-093",
        "How can I apply this research in my classroom?",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "procedural",
        "new",
    ),
    TransformationCase(
        "TC-094",
        "Create a rubric based on this framework.",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "creative",
        "new",
    ),
    TransformationCase(
        "TC-095",
        "What are the ethical considerations of this study?",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "opinion",
        "new",
    ),
    # --- numeric / attribute wh-questions (more coverage) ---
    TransformationCase(
        "TC-096",
        "How many participants completed the study?",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "numeric",
        "new",
    ),
    TransformationCase(
        "TC-097",
        "What instrument was used to measure outcomes?",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "attribute",
        "new",
    ),
    TransformationCase(
        "TC-098",
        "Which grade levels were included in the sample?",
        False,
        "NOT_NLI_APPLICABLE",
        (),
        "attribute",
        "new",
    ),
    # --- more comparative / boolean, new phrasing, for coverage breadth ---
    TransformationCase(
        "TC-099",
        "Was the treatment group larger than the control group?",
        True,
        "COMPARATIVE_CLAIM",
        ("The treatment group was larger than the control group.",),
        "comparative",
        "new",
    ),
    TransformationCase(
        "TC-100",
        "Did the new curriculum outperform the old curriculum?",
        True,
        "COMPARATIVE_CLAIM",
        ("The new curriculum outperformed the old curriculum.",),
        "comparative",
        "new",
    ),
    TransformationCase(
        "TC-101",
        "Was the sample size sufficient for the analysis?",
        True,
        "BOOLEAN_CLAIM",
        ("The sample size was sufficient for the analysis.",),
        "yes_no_factual",
        "new",
    ),
    TransformationCase(
        "TC-102",
        "Is the finding consistent with prior research?",
        True,
        "BOOLEAN_CLAIM",
        ("The finding is consistent with prior research.",),
        "yes_no_factual",
        "new",
    ),
    TransformationCase(
        "TC-103",
        "Was the study randomized?",
        True,
        "BOOLEAN_CLAIM",
        ("The study was randomized.",),
        "yes_no_factual",
        "new",
    ),
    TransformationCase(
        "TC-104",
        "Did the researchers report a positive effect?",
        True,
        "BOOLEAN_CLAIM",
        ("The researchers reported a positive effect.",),
        "yes_no_factual",
        "new",
    ),
    # --- more presupposition coverage ---
    TransformationCase(
        "TC-105",
        "How much did the training reduce error rates?",
        True,
        "PRESUPPOSITION_CLAIM",
        ("The training reduced error rates.",),
        "presupposition",
        "new",
    ),
    TransformationCase(
        "TC-106",
        "Why did engagement increase after the redesign?",
        True,
        "PRESUPPOSITION_CLAIM",
        ("Engagement increased after the redesign.",),
        "presupposition",
        "new",
    ),
    TransformationCase(
        "TC-107",
        "What caused test scores to improve?",
        True,
        "PRESUPPOSITION_CLAIM",
        ("Test scores improved.",),
        "presupposition",
        "new",
    ),
    TransformationCase(
        "TC-108",
        "When did the decline begin?",
        True,
        "PRESUPPOSITION_CLAIM",
        ("The decline began.",),
        "presupposition",
        "new",
    ),
]


def by_category() -> dict[str, list[TransformationCase]]:
    grouped: dict[str, list[TransformationCase]] = {}
    for case in CASES:
        grouped.setdefault(case.question_category, []).append(case)
    return grouped


def _integrity_check() -> None:
    seen: set[str] = set()
    for case in CASES:
        if case.case_id in seen:
            raise AssertionError(f"duplicate case_id {case.case_id!r}")
        seen.add(case.case_id)
        if case.gold_applicable and not case.gold_claims:
            raise AssertionError(f"{case.case_id}: gold_applicable=True but no gold_claims given")
        if not case.gold_applicable and case.gold_claims:
            raise AssertionError(f"{case.case_id}: gold_applicable=False but gold_claims given")
    if len(CASES) < 80:
        raise AssertionError(f"only {len(CASES)} cases — below the Milestone 9 §13 minimum of 80")
    required_categories = {
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
    represented = {case.question_category for case in CASES}
    missing = required_categories - represented
    if missing:
        raise AssertionError(f"missing required question categories: {missing}")


_integrity_check()
