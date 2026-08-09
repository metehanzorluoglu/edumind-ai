"""Milestone 5 (retrieval quality baseline / evidence-sufficiency
evaluation): a deterministic, hand-authored corpus with KNOWN ground truth
— every expected_document_ids/expected_chunk_ids value below was written
by checking which chunk actually contains the fact, not guessed.

Deliberately Python (not JSON): this repo's existing pytest fixtures
already favor plain Python dataclasses/builder functions over external
fixture files (see e.g. tests/unit/core/test_scoped_retrieval.py's
`_chunk()` helper) — colocating each document's authored text with its own
ground-truth claims makes "does this chunk actually support this
question" reviewable in one place, and needs no external ingestion step
(unlike evaluation/fixtures-questions.json, which references a
`tests/fixtures/corpus/` directory that does not exist in this checkout —
see the Milestone 5 report's "known gaps" section). Both this module and
scripts/eval_retrieval_controlled.py import it directly; nothing needs to
be ingested via the CLI first.

Corpus size (28 documents / 34 chunks, 77 evaluation cases as of Milestone
5.6): the Milestone 5 baseline started at 22 documents / 28 chunks / 31
cases (31 - 3 = 28 answerable). Milestone 5.6 (evidence-sufficiency
calibration) added 6 new documents and 46 new cases spanning 10
additional fine-grained failure categories (see NEGATIVE_TYPE_LABELS
below) — 6 new "hard positive" cases plus mostly negative (unanswerable /
evidence-insufficient) cases — to give the calibration sweep a large
enough, ground-truth-verified sample on both sides: 31 general-mode
answerable (positive) cases, 38 general-mode-unanswerable (negative)
cases, plus 8 Zoom-In-scope cases (7 scope-negative, 1 scope-positive)
evaluated separately (see the Milestone 5.6 report's §10 for why general
and Zoom-In calibration are never pooled into one sample). Every new
case's ground truth was hand-verified against the actual authored chunk
text below, same discipline as Milestone 5's original set; see the
Milestone 5.6 report's "Manual ground-truth audit" section for the
explicit per-category verification notes.

Domain: fictional education-research literature (reading/literacy
intervention studies), matching evaluation/fixtures-questions.json's own
domain — familiar to anyone reviewing this file, and plausible enough that
a real embedding model's behavior on it (see the "real embeddings" section
of the Milestone 5 report) is a fair proxy for the app's actual use case,
without being any REAL person's or institution's actual research.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from app.ingestion.metadata_schema import DocumentType, JournalQuartile

CATEGORIES = (
    "exact_terminology",
    "paraphrase",
    "acronym",
    "numerical_fact",
    "cross_document",
    "section_specific",
    "answer_absent",
    "zoom_in_absent_elsewhere_present",
    "distractor_heavy",
    "near_duplicate",
    # --- Milestone 5.6 additions: fine-grained negative-case categories
    # (the evidence-sufficiency calibration milestone's "negative case
    # types A-L"). "answer_absent" above already covers type A (completely
    # unrelated) and "zoom_in_absent_elsewhere_present" already covers
    # type G (Zoom-In scope lacks the answer, corpus has it elsewhere) —
    # both were simply expanded with more cases rather than renamed, to
    # keep every Milestone 5/5.5 case's category stable (never tune
    # against the test set by relabeling it).
    "related_topic_absent",  # B
    "wrong_numerical_detail",  # C
    "entity_confusion",  # D
    "partial_evidence",  # E
    "cross_document_incomplete",  # F
    "zoom_in_project_absent",  # H (see that constant's own docstring for
    # why this is modeled as a Zoom-In-scope variant, not a separate
    # project-knowledge subsystem)
    "semantic_neighbor_distractor",  # I
    "negation_contradiction",  # J
    "acronym_ambiguity",  # K
    "section_mismatch",  # L
    # --- Milestone 5.7 additions: the remaining answerable-question types
    # (§6) and hard-negative types (§7) not already covered by an M5/5.6
    # category above (those are reused as-is, never renamed). ---
    "definition",
    "methodology_question",
    "result_interpretation",
    "citation_sensitive",
    "synthesis_multi_document",
    "comparison_multi_section",
    "wrong_population_sample",
    "wrong_methodology",
    "wrong_date_year",
    "wrong_causal_claim",
    "correlation_causation_confusion",
    "claim_stronger_than_source",
    "presupposition_not_stated",
    "concept_not_conclusion",
)

# The Milestone 5.6 "negative case type" letters, for cross-referencing the
# milestone spec directly in reports/tests — not used for any control flow.
NEGATIVE_TYPE_LABELS: dict[str, str] = {
    "answer_absent": "A: completely unrelated question",
    "related_topic_absent": "B: related topic, answer absent",
    "wrong_numerical_detail": "C: wrong numerical detail (near-miss number exists)",
    "entity_confusion": "D: entity confusion (similar name/program)",
    "partial_evidence": "E: partial evidence (multi-part question, only one part answerable)",
    "cross_document_incomplete": "F: cross-document, only one required side exists",
    "zoom_in_absent_elsewhere_present": "G: Zoom-In scope lacks answer, corpus has it elsewhere",
    "zoom_in_project_absent": "H: Zoom-In scope lacks answer, answer exists in unselected library",
    "semantic_neighbor_distractor": "I: semantically related text that doesn't support the claim",
    "negation_contradiction": "J: document negates/contradicts the question's presupposition",
    "acronym_ambiguity": "K: acronym used, but not in the sense the question needs",
    "section_mismatch": "L: correct document topic, wrong/absent section",
}


@dataclass(frozen=True)
class ControlledChunk:
    chunk_index: int
    page_number: int
    text: str


@dataclass(frozen=True)
class ControlledDocument:
    document_id: str
    source_filename: str
    title: str
    document_type: DocumentType
    journal_quartile: JournalQuartile
    authors: list[str]
    publication_year: int
    chunks: list[ControlledChunk]
    # Milestone 5.7: topic/subject-area tag, used as the default
    # document-group key for group-level (not row-level) calibration/
    # holdout splitting — see EvalCase.topic. None for every Milestone 5/
    # 5.6 controlled-corpus document (they predate topic grouping).
    topic: str | None = None

    def chunk_id(self, chunk_index: int) -> str:
        """Mirrors app/vectorstore/qdrant_client.py's `_point_id` shape
        closely enough for eval purposes (deterministic per document_id +
        chunk_index) — not required to be byte-identical to the real
        Qdrant point id scheme, only to be a stable, unique key this
        module and the eval script agree on."""
        return f"{self.document_id}::chunk{chunk_index}"


@dataclass(frozen=True)
class EvalCase:
    case_id: str
    query: str
    category: str
    expected_document_ids: list[str] = field(default_factory=list)
    expected_chunk_ids: list[str] = field(default_factory=list)
    # Cross-document comparison cases: recall counts as a hit only if ALL
    # of expected_document_ids appear in the top-K, not merely one of
    # them — see the Milestone 5 report §11 ("must not score a comparison
    # question as successful if only one side was retrieved").
    require_all_documents: bool = False
    # False for "answer_absent" cases (nothing in the whole corpus answers
    # this) — expected_document_ids/expected_chunk_ids are empty for these.
    answerable: bool = True
    # Zoom-In cases only: the document_ids treated as this case's selected
    # chat-scope ("scope_document_ids" per the milestone's own field
    # naming). None means "not a Zoom-In case" — the ordinary corpus-wide
    # evaluation runs for it instead.
    scope_document_ids: list[str] | None = None
    # For Zoom-In cases: whether the answer is actually contained within
    # scope_document_ids (True) or only exists elsewhere in the corpus
    # (False — the "answer absent from selected Zoom-In documents but
    # present elsewhere" category).
    scope_contains_answer: bool | None = None
    notes: str = ""
    # --- Milestone 5.7 additions (all optional, default preserves every
    # Milestone 5/5.6 case's behavior byte-for-byte) ---
    # Documents that provide useful context but are not themselves required
    # to answer the question — distinct from expected_document_ids (which
    # this module's docstrings already treat as "required"); tracked
    # separately so a future evidence-coverage calculation never conflates
    # "helpful" with "necessary" (Milestone 5.7 §9).
    optional_supporting_document_ids: list[str] = field(default_factory=list)
    # Richer evidence-sufficiency ground truth (Milestone 5.7 §10) — a
    # SUFFICIENT case has a genuine, complete answer; PARTIAL has some but
    # not all required evidence (see require_all_documents); INSUFFICIENT
    # has none; CONTRADICTORY means retrieved-looking text exists but
    # actually negates/contradicts what the question presupposes (see
    # category="negation_contradiction"). None (the default) means "not
    # labeled this way" — every Milestone 5/5.6 case falls back to the
    # binary `answerable` flag via the `should_answer` property below,
    # preserving their exact original semantics.
    sufficiency: Literal["SUFFICIENT", "PARTIAL", "INSUFFICIENT", "CONTRADICTORY"] | None = None
    # Document/topic-group key for group-level (not row-level) calibration/
    # holdout splitting (Milestone 5.7 §17) — cases sharing a topic must
    # land in the same split, or a query about one document could leak
    # structural information into the holdout evaluation of a near-
    # duplicate/related query about the same topic. None for every
    # Milestone 5/5.6 case (those predate topic grouping; row-level
    # splitting, as Milestone 5.6 used, remains valid for them).
    topic: str | None = None

    def __post_init__(self) -> None:
        if self.category not in CATEGORIES:
            raise ValueError(f"{self.case_id}: unknown category {self.category!r}")
        if self.scope_document_ids is not None and self.scope_contains_answer is None:
            raise ValueError(
                f"{self.case_id}: scope_document_ids set without scope_contains_answer"
            )
        if self.sufficiency is not None and self.sufficiency not in (
            "SUFFICIENT", "PARTIAL", "INSUFFICIENT", "CONTRADICTORY",
        ):
            raise ValueError(f"{self.case_id}: unknown sufficiency {self.sufficiency!r}")

    @property
    def should_answer(self) -> bool:
        """Backward-compatible binary derivation (Milestone 5.7 §10): a
        SUFFICIENT-labeled case should answer; PARTIAL/INSUFFICIENT/
        CONTRADICTORY should abstain. Falls back to `answerable` for any
        case that never set `sufficiency` (every Milestone 5/5.6 case),
        so existing calibration code needs no change to keep working."""
        if self.sufficiency is not None:
            return self.sufficiency == "SUFFICIENT"
        return self.answerable


# ---------------------------------------------------------------------------
# Documents
# ---------------------------------------------------------------------------

CONTROLLED_DOCUMENTS: list[ControlledDocument] = [
    # --- Core peer-tutoring cluster: numerical_fact, exact_terminology,
    # cross_document, distractor_heavy ---
    ControlledDocument(
        document_id="doc-rct-peer-tutoring",
        source_filename="rct-peer-tutoring.pdf",
        title="A Randomized Controlled Trial of Structured Peer Tutoring",
        document_type="journal_article",
        journal_quartile="Q1",
        authors=["A. Rivera", "K. Chen"],
        publication_year=2023,
        chunks=[
            ControlledChunk(
                0, 1,
                "Methods: the study included 24 participants in grades 3-4, randomly "
                "assigned to a structured peer tutoring condition or a business-as-usual "
                "control condition over sixteen weeks.",
            ),
            ControlledChunk(
                1, 2,
                "Results: the peer tutoring group gained an average of 12 words correct "
                "per minute (WCPM), compared to a 3 WCPM gain in the control group "
                "(Cohen's d = 0.61).",
            ),
        ],
    ),
    ControlledDocument(
        document_id="doc-pilot-peer-tutoring",
        source_filename="pilot-peer-tutoring.pdf",
        title="Pilot Evaluation of a Peer Tutoring Program",
        document_type="report",
        journal_quartile=None,
        authors=["M. Okafor"],
        publication_year=2021,
        chunks=[
            ControlledChunk(
                0, 1,
                "This pilot report describes a peer tutoring program serving 80 "
                "participants across three district elementary schools during the "
                "2020-2021 school year.",
            ),
        ],
    ),
    ControlledDocument(
        document_id="doc-fidelity-quasi",
        source_filename="fidelity-quasi-experimental.pdf",
        title="Implementation Fidelity in a Rural Quasi-Experimental Tutoring Study",
        document_type="journal_article",
        journal_quartile="Q2",
        authors=["J. Whitfield"],
        publication_year=2022,
        chunks=[
            ControlledChunk(
                0, 1,
                "Only 54 percent of scheduled tutoring sessions were confirmed delivered "
                "with fidelity in this rural quasi-experimental study, compared to a "
                "planned schedule of three sessions per week.",
            ),
            ControlledChunk(
                1, 2,
                "Low implementation fidelity was associated with a non-significant "
                "effect on oral reading fluency, in contrast to high-fidelity structured "
                "programs reported elsewhere in the literature.",
            ),
        ],
    ),
    ControlledDocument(
        document_id="doc-classroom-tech-survey",
        source_filename="classroom-tech-survey.pdf",
        title="A Survey of Classroom Technology Adoption",
        document_type="report",
        journal_quartile=None,
        authors=["D. Park"],
        publication_year=2020,
        chunks=[
            ControlledChunk(
                0, 1,
                "This survey of 300 teachers examines classroom technology adoption "
                "rates, including interactive whiteboards, tablets, and learning "
                "management systems, but does not address tutoring interventions.",
            ),
        ],
    ),

    # --- Acronym cluster: acronym, paraphrase ---
    ControlledDocument(
        document_id="doc-structured-literacy-framework",
        source_filename="structured-literacy-framework.pdf",
        title="A Structured Literacy Framework for Elementary Classrooms",
        document_type="curriculum_document",
        journal_quartile=None,
        authors=["Structured Literacy Consortium"],
        publication_year=2022,
        chunks=[
            ControlledChunk(
                0, 1,
                "The Science of Reading (SOR) is a body of interdisciplinary research "
                "on how children learn to read, encompassing phonemic awareness, "
                "phonics, fluency, vocabulary, and comprehension.",
            ),
            ControlledChunk(
                1, 2,
                "This framework recommends explicit, systematic phonics instruction as "
                "the foundation of a Science of Reading-aligned literacy block.",
            ),
        ],
    ),
    ControlledDocument(
        document_id="doc-sor-classroom-guide",
        source_filename="sor-classroom-guide.pdf",
        title="Bringing SOR Principles Into Daily Practice",
        document_type="practitioner_article",
        journal_quartile=None,
        authors=["R. Alvarez"],
        publication_year=2023,
        chunks=[
            ControlledChunk(
                0, 1,
                "Teachers report that adopting SOR principles required retraining time "
                "but improved consistency of phonics instruction across grade levels. "
                "This article assumes readers already know what SOR stands for.",
            ),
        ],
    ),
    ControlledDocument(
        document_id="doc-udl-guide",
        source_filename="udl-guide.pdf",
        title="Universal Design for Learning: A Practitioner's Guide",
        document_type="practitioner_article",
        journal_quartile=None,
        authors=["T. Nakamura"],
        publication_year=2021,
        chunks=[
            ControlledChunk(
                0, 1,
                "Universal Design for Learning (UDL) is a framework for designing "
                "instruction that offers multiple means of engagement, representation, "
                "and action/expression to accommodate learner variability.",
            ),
        ],
    ),
    ControlledDocument(
        document_id="doc-iep-policy",
        source_filename="iep-policy-overview.pdf",
        title="Individualized Education Program Policy Overview",
        document_type="policy_document",
        journal_quartile=None,
        authors=["State Department of Education"],
        publication_year=2019,
        chunks=[
            ControlledChunk(
                0, 1,
                "An Individualized Education Program (IEP) is a legally binding "
                "document developed for a student who qualifies for special education "
                "services under federal law.",
            ),
        ],
    ),

    # --- Numeric distractor + paraphrase cluster ---
    ControlledDocument(
        document_id="doc-vocab-intervention",
        source_filename="vocab-intervention-study.pdf",
        title="A Vocabulary Intervention for Multilingual Learners",
        document_type="journal_article",
        journal_quartile="Q2",
        authors=["S. Idowu", "L. Martins"],
        publication_year=2022,
        chunks=[
            ControlledChunk(
                0, 1,
                "One-on-one tutoring sessions were provided to multilingual learners "
                "twice weekly for ten weeks, focusing on academic vocabulary "
                "acquisition rather than oral reading fluency.",
            ),
            ControlledChunk(
                1, 2,
                "Participants showed a statistically significant gain in receptive "
                "vocabulary scores, with individualized instruction cited as the "
                "primary driver of the effect.",
            ),
        ],
    ),
    ControlledDocument(
        document_id="doc-small-group-reading",
        source_filename="small-group-reading.pdf",
        title="Small-Group Reading Instruction in Grade 2",
        document_type="journal_article",
        journal_quartile="Q2",
        authors=["H. Larsen"],
        publication_year=2021,
        chunks=[
            ControlledChunk(
                0, 1,
                "This study examined small-group (three to four students) reading "
                "instruction, distinct from the one-on-one peer tutoring model "
                "evaluated in other studies in this corpus.",
            ),
        ],
    ),

    # --- Near-duplicate cluster ---
    ControlledDocument(
        document_id="doc-tutoring-brief-draft",
        source_filename="tutoring-outcomes-brief-draft.pdf",
        title="Tutoring Outcomes Brief (Draft)",
        document_type="report",
        journal_quartile=None,
        authors=["Program Evaluation Team"],
        publication_year=2023,
        chunks=[
            ControlledChunk(
                0, 1,
                "Draft summary: structured tutoring programs across the district "
                "showed an average reading fluency gain of roughly 10-12 words "
                "correct per minute over a semester-length program.",
            ),
        ],
    ),
    ControlledDocument(
        document_id="doc-tutoring-brief-final",
        source_filename="tutoring-outcomes-brief-final.pdf",
        title="Tutoring Outcomes Brief (Final)",
        document_type="report",
        journal_quartile=None,
        authors=["Program Evaluation Team"],
        publication_year=2023,
        chunks=[
            ControlledChunk(
                0, 1,
                "Final summary: structured tutoring programs across the district "
                "showed an average reading fluency gain of roughly 10-12 words "
                "correct per minute over a semester-length program, confirmed after "
                "data cleaning.",
            ),
        ],
    ),

    # --- Section-specific: one long multi-section document ---
    ControlledDocument(
        document_id="doc-comprehensive-report",
        source_filename="comprehensive-reading-report.pdf",
        title="Comprehensive Reading Intervention Report",
        document_type="report",
        journal_quartile=None,
        authors=["District Research Office"],
        publication_year=2023,
        chunks=[
            ControlledChunk(
                0, 1,
                "Methods section: this district-wide report combines data from four "
                "elementary schools using a structured intervention model implemented "
                "by trained reading specialists.",
            ),
            ControlledChunk(
                1, 2,
                "Results section: overall reading proficiency rose from 58 percent to "
                "67 percent of students meeting grade-level benchmarks over one "
                "academic year.",
            ),
            ControlledChunk(
                2, 3,
                "Limitations section: the report notes that staffing shortages in two "
                "of the four schools may have reduced intervention dosage for some "
                "students, limiting generalizability of the results.",
            ),
        ],
    ),

    # --- Zoom-In cluster: same fact appears in two different documents ---
    ControlledDocument(
        document_id="doc-selected-summary",
        source_filename="selected-summary.pdf",
        title="Selected Conversation Summary Document",
        document_type="report",
        journal_quartile=None,
        authors=["User Notes"],
        publication_year=2024,
        chunks=[
            ControlledChunk(
                0, 1,
                "This working summary covers general classroom scheduling logistics "
                "and does not include any information about program cost.",
            ),
        ],
    ),
    ControlledDocument(
        document_id="doc-budget-report",
        source_filename="tutoring-budget-report.pdf",
        title="Tutoring Program Budget Report",
        document_type="report",
        journal_quartile=None,
        authors=["Finance Office"],
        publication_year=2023,
        chunks=[
            ControlledChunk(
                0, 1,
                "The structured peer tutoring program cost approximately $420 per "
                "participating student for the full sixteen-week program, including "
                "materials and tutor training.",
            ),
        ],
    ),

    # --- Pure distractors (unrelated education topics, related vocabulary) ---
    ControlledDocument(
        document_id="doc-classroom-management",
        source_filename="classroom-management-strategies.pdf",
        title="Classroom Management Strategies for New Teachers",
        document_type="practitioner_article",
        journal_quartile=None,
        authors=["P. Boateng"],
        publication_year=2020,
        chunks=[
            ControlledChunk(
                0, 1,
                "This article discusses proactive classroom management strategies, "
                "including seating arrangements and transition routines, for "
                "first-year teachers.",
            ),
        ],
    ),
    ControlledDocument(
        document_id="doc-assessment-design",
        source_filename="formative-assessment-design.pdf",
        title="Designing Formative Assessments",
        document_type="practitioner_article",
        journal_quartile=None,
        authors=["E. Kowalski"],
        publication_year=2021,
        chunks=[
            ControlledChunk(
                0, 1,
                "This guide covers designing formative assessments, including exit "
                "tickets and low-stakes quizzes, to check for understanding during a "
                "lesson.",
            ),
        ],
    ),
    ControlledDocument(
        document_id="doc-edtech-review",
        source_filename="edtech-adaptive-review.pdf",
        title="A Review of Adaptive Learning Software",
        document_type="review_article",
        journal_quartile="Q2",
        authors=["N. Osei"],
        publication_year=2022,
        chunks=[
            ControlledChunk(
                0, 1,
                "This review surveys adaptive learning software platforms used for "
                "math practice, none of which are tutoring programs in the sense "
                "evaluated elsewhere in this corpus.",
            ),
        ],
    ),
    ControlledDocument(
        document_id="doc-teacher-pd",
        source_filename="teacher-professional-development.pdf",
        title="Effective Teacher Professional Development Models",
        document_type="review_article",
        journal_quartile="Q1",
        authors=["V. Torres"],
        publication_year=2021,
        chunks=[
            ControlledChunk(
                0, 1,
                "This review examines coaching-based professional development models "
                "for in-service teachers, distinct from student-facing tutoring "
                "interventions.",
            ),
        ],
    ),
    ControlledDocument(
        document_id="doc-school-nutrition",
        source_filename="school-nutrition-policy.pdf",
        title="School Nutrition Policy Update",
        document_type="policy_document",
        journal_quartile=None,
        authors=["State Department of Education"],
        publication_year=2020,
        chunks=[
            ControlledChunk(
                0, 1,
                "This policy update covers school breakfast and lunch nutrition "
                "standards and has no connection to reading instruction or tutoring.",
            ),
        ],
    ),
    ControlledDocument(
        document_id="doc-attendance-policy",
        source_filename="attendance-policy.pdf",
        title="District Attendance Policy",
        document_type="policy_document",
        journal_quartile=None,
        authors=["District Office"],
        publication_year=2019,
        chunks=[
            ControlledChunk(
                0, 1,
                "This policy document sets out excused and unexcused absence "
                "definitions and truancy escalation procedures for the district.",
            ),
        ],
    ),
    ControlledDocument(
        document_id="doc-math-curriculum",
        source_filename="elementary-math-curriculum.pdf",
        title="Elementary Math Curriculum Guide",
        document_type="curriculum_document",
        journal_quartile=None,
        authors=["Curriculum Office"],
        publication_year=2022,
        chunks=[
            ControlledChunk(
                0, 1,
                "This curriculum guide sequences elementary math standards by grade "
                "level, covering number sense, operations, and early geometry.",
            ),
        ],
    ),

    # --- Milestone 5.6: six new documents supporting the fine-grained
    # negative-case categories (entity confusion, negation, acronym
    # ambiguity, partial evidence, related-topic-absent). Each is designed
    # to be a REALISTIC distractor (so dense retrieval has something
    # plausible to retrieve, producing a genuine non-trivial top score —
    # the whole point of a calibration negative) while keeping its own
    # ground truth unambiguous.
    ControlledDocument(
        document_id="doc-peer-mentoring-program",
        source_filename="peer-mentoring-program.pdf",
        title="The Peer Mentoring Program: Social-Emotional Support",
        document_type="report",
        journal_quartile=None,
        authors=["Student Support Office"],
        publication_year=2022,
        chunks=[
            ControlledChunk(
                0, 1,
                "The Peer Mentoring Program pairs older students with younger students "
                "for social-emotional support once weekly. Unlike peer TUTORING "
                "programs, it does not target academic skills, reading fluency, or "
                "words correct per minute, and this report contains no fluency data.",
            ),
        ],
    ),
    ControlledDocument(
        document_id="doc-tutoring-null-effect",
        source_filename="neighboring-district-tutoring-null-result.pdf",
        title="A Null Result: After-School Tutoring in a Neighboring District",
        document_type="report",
        journal_quartile=None,
        authors=["Regional Research Office"],
        publication_year=2023,
        chunks=[
            ControlledChunk(
                0, 1,
                "A well-implemented after-school tutoring initiative in a neighboring "
                "district found NO statistically significant improvement in reading "
                "fluency after twelve weeks, contradicting the general assumption that "
                "any structured tutoring program produces fluency gains.",
            ),
        ],
    ),
    ControlledDocument(
        document_id="doc-sor-procurement-glossary",
        source_filename="procurement-glossary.pdf",
        title="Vendor Procurement Glossary",
        document_type="policy_document",
        journal_quartile=None,
        authors=["Procurement Office"],
        publication_year=2021,
        chunks=[
            ControlledChunk(
                0, 1,
                "In this procurement glossary, SOR refers to a Statement of "
                "Requirements submitted by a vendor before contract award — a term "
                "used in purchasing and contracting, unrelated to instructional "
                "methodology or reading research.",
            ),
        ],
    ),
    ControlledDocument(
        document_id="doc-multipart-scheduling",
        source_filename="rct-session-scheduling.pdf",
        title="Session Scheduling Details for the Peer Tutoring RCT",
        document_type="report",
        journal_quartile=None,
        authors=["Program Evaluation Team"],
        publication_year=2023,
        chunks=[
            ControlledChunk(
                0, 1,
                "Tutoring sessions in the randomized controlled trial were scheduled "
                "twice weekly for thirty minutes each, occurring during the regular "
                "school day rather than after school. This scheduling note does not "
                "report any per-session or total program cost figures.",
            ),
        ],
    ),
    ControlledDocument(
        document_id="doc-related-topic-no-specific-number",
        source_filename="after-school-program-best-practices.pdf",
        title="Best Practices for Structuring After-School Academic Support",
        document_type="practitioner_article",
        journal_quartile=None,
        authors=["National Afterschool Alliance (fictional)"],
        publication_year=2020,
        chunks=[
            ControlledChunk(
                0, 1,
                "This overview describes general best practices for structuring "
                "after-school academic support programs, including staffing ratios "
                "and session length, without reporting outcome data, effect sizes, or "
                "participant counts from any specific study.",
            ),
        ],
    ),
    ControlledDocument(
        document_id="doc-similar-name-collision",
        source_filename="rivera-santos-teacher-retention.pdf",
        title="Teacher Retention Trends: An Independent Analysis",
        document_type="report",
        journal_quartile=None,
        authors=["A. Rivera-Santos"],
        publication_year=2022,
        chunks=[
            ControlledChunk(
                0, 1,
                "A. Rivera-Santos's analysis of teacher retention trends found no "
                "relationship between tutoring-program involvement and teacher "
                "turnover rates. This analysis is unrelated to A. Rivera (no relation), "
                "co-author of the peer tutoring randomized controlled trial, and does "
                "not discuss parent involvement, effect sizes, or fluency outcomes.",
            ),
        ],
    ),
]

DOCUMENTS_BY_ID: dict[str, ControlledDocument] = {d.document_id: d for d in CONTROLLED_DOCUMENTS}


# ---------------------------------------------------------------------------
# Evaluation cases
# ---------------------------------------------------------------------------

_RCT = "doc-rct-peer-tutoring"
_PILOT = "doc-pilot-peer-tutoring"
_FIDELITY = "doc-fidelity-quasi"
_TECH_SURVEY = "doc-classroom-tech-survey"
_SOR_FRAMEWORK = "doc-structured-literacy-framework"
_SOR_GUIDE = "doc-sor-classroom-guide"
_UDL = "doc-udl-guide"
_IEP = "doc-iep-policy"
_VOCAB = "doc-vocab-intervention"
_SMALL_GROUP = "doc-small-group-reading"
_BRIEF_DRAFT = "doc-tutoring-brief-draft"
_BRIEF_FINAL = "doc-tutoring-brief-final"
_COMPREHENSIVE = "doc-comprehensive-report"
_SELECTED_SUMMARY = "doc-selected-summary"
_BUDGET = "doc-budget-report"
_MENTORING = "doc-peer-mentoring-program"
_NULL_EFFECT = "doc-tutoring-null-effect"
_SOR_PROCUREMENT = "doc-sor-procurement-glossary"
_SCHEDULING = "doc-multipart-scheduling"
_RELATED_NO_NUMBER = "doc-related-topic-no-specific-number"
_RIVERA_SANTOS = "doc-similar-name-collision"

CONTROLLED_CASES: list[EvalCase] = [
    # --- exact_terminology (3) ---
    EvalCase(
        case_id="ET01",
        query="How many participants were included in the randomized controlled trial "
        "of structured peer tutoring?",
        category="exact_terminology",
        expected_document_ids=[_RCT],
        expected_chunk_ids=[_RCT + "::chunk0"],
        notes="Uses the document's own phrase 'randomized controlled trial' and "
        "'structured peer tutoring' verbatim.",
    ),
    EvalCase(
        case_id="ET02",
        query="What percentage of scheduled tutoring sessions were confirmed delivered "
        "with fidelity in the rural quasi-experimental study?",
        category="exact_terminology",
        expected_document_ids=[_FIDELITY],
        expected_chunk_ids=[_FIDELITY + "::chunk0"],
    ),
    EvalCase(
        case_id="ET03",
        query="What effect size did the peer tutoring condition produce on reading "
        "fluency in the randomized controlled trial?",
        category="exact_terminology",
        expected_document_ids=[_RCT],
        expected_chunk_ids=[_RCT + "::chunk1"],
    ),

    # --- paraphrase (3) ---
    EvalCase(
        case_id="PA01",
        query="Which study found that individualized, one-on-one instruction helped "
        "multilingual students learn new academic words?",
        category="paraphrase",
        expected_document_ids=[_VOCAB],
        expected_chunk_ids=[_VOCAB + "::chunk1"],
        notes="Query paraphrases 'individualized instruction'/'vocabulary acquisition' "
        "rather than quoting the document verbatim.",
    ),
    EvalCase(
        case_id="PA02",
        query="Did closer adherence to the planned tutoring schedule relate to better "
        "reading outcomes?",
        category="paraphrase",
        expected_document_ids=[_FIDELITY],
        expected_chunk_ids=[_FIDELITY + "::chunk1"],
        notes="Paraphrases 'implementation fidelity' as 'adherence to the planned "
        "schedule.'",
    ),
    EvalCase(
        case_id="PA03",
        query="What framework helps teachers plan lessons that work for students who "
        "learn in different ways?",
        category="paraphrase",
        expected_document_ids=[_UDL],
        expected_chunk_ids=[_UDL + "::chunk0"],
        notes="Paraphrases 'Universal Design for Learning' / 'learner variability.'",
    ),

    # --- acronym (3) ---
    EvalCase(
        case_id="AC01",
        query="What does SOR stand for?",
        category="acronym",
        expected_document_ids=[_SOR_FRAMEWORK],
        expected_chunk_ids=[_SOR_FRAMEWORK + "::chunk0"],
        notes="doc-sor-classroom-guide uses 'SOR' without ever expanding it — only "
        "doc-structured-literacy-framework actually defines the acronym.",
    ),
    EvalCase(
        case_id="AC02",
        query="What is an IEP?",
        category="acronym",
        expected_document_ids=[_IEP],
        expected_chunk_ids=[_IEP + "::chunk0"],
    ),
    EvalCase(
        case_id="AC03",
        query="What does UDL stand for and what does it offer?",
        category="acronym",
        expected_document_ids=[_UDL],
        expected_chunk_ids=[_UDL + "::chunk0"],
    ),

    # --- numerical_fact (3) ---
    EvalCase(
        case_id="NF01",
        query="How many words correct per minute did the peer tutoring group gain in "
        "the sixteen-week randomized trial?",
        category="numerical_fact",
        expected_document_ids=[_RCT],
        expected_chunk_ids=[_RCT + "::chunk1"],
        notes="Distractor: doc-pilot-peer-tutoring's 80-participant figure is a "
        "different number for a superficially similar topic (participant count, not "
        "WCPM) — must not be confused with this answer.",
    ),
    EvalCase(
        case_id="NF02",
        query="How many participants were in the pilot peer tutoring program?",
        category="numerical_fact",
        expected_document_ids=[_PILOT],
        expected_chunk_ids=[_PILOT + "::chunk0"],
        notes="The 'other' number (80) relative to NF01's 24 — tests whether dense "
        "retrieval distinguishes the RCT from the pilot report on a numeric query.",
    ),
    EvalCase(
        case_id="NF03",
        query="What percentage of students met grade-level reading benchmarks after "
        "the district-wide intervention?",
        category="numerical_fact",
        expected_document_ids=[_COMPREHENSIVE],
        expected_chunk_ids=[_COMPREHENSIVE + "::chunk1"],
    ),

    # --- cross_document (3, require_all_documents=True) ---
    EvalCase(
        case_id="CD01",
        query="Compare the reading fluency outcomes of the high-fidelity randomized "
        "trial and the low-fidelity rural quasi-experimental study.",
        category="cross_document",
        expected_document_ids=[_RCT, _FIDELITY],
        require_all_documents=True,
        notes="Both the RCT (d=0.61) and the fidelity study (non-significant effect) "
        "must be present in top-K for this comparison to be answerable — one side "
        "alone is not a success.",
    ),
    EvalCase(
        case_id="CD02",
        query="How do the peer tutoring RCT's participant count compare to the pilot "
        "program's participant count?",
        category="cross_document",
        expected_document_ids=[_RCT, _PILOT],
        require_all_documents=True,
    ),
    EvalCase(
        case_id="CD03",
        query="Contrast one-on-one peer tutoring with small-group reading instruction "
        "as approaches to improving reading outcomes.",
        category="cross_document",
        expected_document_ids=[_RCT, _SMALL_GROUP],
        require_all_documents=True,
    ),

    # --- section_specific (3, all target doc-comprehensive-report's sections) ---
    EvalCase(
        case_id="SS01",
        query="What were the limitations of the district-wide comprehensive reading "
        "intervention report?",
        category="section_specific",
        expected_document_ids=[_COMPREHENSIVE],
        expected_chunk_ids=[_COMPREHENSIVE + "::chunk2"],
        notes="Must rank the Limitations chunk, not the Methods or Results chunk of "
        "the same document, first.",
    ),
    EvalCase(
        case_id="SS02",
        query="What methodology did the comprehensive district reading report use?",
        category="section_specific",
        expected_document_ids=[_COMPREHENSIVE],
        expected_chunk_ids=[_COMPREHENSIVE + "::chunk0"],
    ),
    EvalCase(
        case_id="SS03",
        query="What were the results of the comprehensive district reading "
        "intervention report?",
        category="section_specific",
        expected_document_ids=[_COMPREHENSIVE],
        expected_chunk_ids=[_COMPREHENSIVE + "::chunk1"],
    ),

    # --- answer_absent (3) ---
    EvalCase(
        case_id="AA01",
        query="What was the effect of virtual reality headsets on reading fluency?",
        category="answer_absent",
        answerable=False,
        notes="Nothing in this corpus discusses virtual reality at all.",
    ),
    EvalCase(
        case_id="AA02",
        query="How did the tutoring program affect students' standardized math test "
        "scores?",
        category="answer_absent",
        answerable=False,
        notes="Corpus covers reading/literacy tutoring outcomes only, never math test "
        "scores.",
    ),
    EvalCase(
        case_id="AA03",
        query="What was the average teacher salary increase associated with the "
        "tutoring program?",
        category="answer_absent",
        answerable=False,
    ),

    # --- zoom_in_absent_elsewhere_present (3) ---
    EvalCase(
        case_id="ZI01",
        query="How much did the structured peer tutoring program cost per student?",
        category="zoom_in_absent_elsewhere_present",
        expected_document_ids=[_BUDGET],
        expected_chunk_ids=[_BUDGET + "::chunk0"],
        scope_document_ids=[_SELECTED_SUMMARY],
        scope_contains_answer=False,
        notes="The cost figure lives in doc-budget-report, but this case's simulated "
        "Zoom-In scope is doc-selected-summary only — the answer exists in the "
        "corpus but not within scope.",
    ),
    EvalCase(
        case_id="ZI02",
        query="How much did the structured peer tutoring program cost per student?",
        category="zoom_in_absent_elsewhere_present",
        expected_document_ids=[_BUDGET],
        expected_chunk_ids=[_BUDGET + "::chunk0"],
        scope_document_ids=[_BUDGET],
        scope_contains_answer=True,
        notes="Same question as ZI01, but scoped to doc-budget-report itself — answer "
        "IS in scope. Paired with ZI01 to isolate 'is it in scope' from 'can dense "
        "retrieval find it.'",
    ),
    EvalCase(
        case_id="ZI03",
        query="How many participants were in the peer tutoring randomized trial?",
        category="zoom_in_absent_elsewhere_present",
        expected_document_ids=[_RCT],
        expected_chunk_ids=[_RCT + "::chunk0"],
        scope_document_ids=[_PILOT],
        scope_contains_answer=False,
        notes="The RCT's participant count exists in the corpus (doc-rct-peer-"
        "tutoring) but this case's scope is doc-pilot-peer-tutoring only, which "
        "answers a superficially similar but different question.",
    ),

    # --- distractor_heavy (3) ---
    EvalCase(
        case_id="DH01",
        query="How many participants were in the study on tutoring and reading "
        "fluency?",
        category="distractor_heavy",
        expected_document_ids=[_RCT],
        expected_chunk_ids=[_RCT + "::chunk0"],
        notes="Deliberately vague enough that doc-pilot-peer-tutoring (80 "
        "participants) and doc-fidelity-quasi are plausible distractors sharing "
        "vocabulary ('tutoring', 'participants').",
    ),
    EvalCase(
        case_id="DH02",
        query="What does research say about improving classroom reading outcomes?",
        category="distractor_heavy",
        expected_document_ids=[_RCT, _FIDELITY, _COMPREHENSIVE],
        notes="Broad query with many plausible related-vocabulary distractors "
        "(doc-classroom-tech-survey, doc-classroom-management, doc-assessment-"
        "design) that share 'classroom'/'reading' vocabulary without answering it.",
    ),
    EvalCase(
        case_id="DH03",
        query="What programs did this survey of teachers examine?",
        category="distractor_heavy",
        expected_document_ids=[_TECH_SURVEY],
        expected_chunk_ids=[_TECH_SURVEY + "::chunk0"],
        notes="doc-teacher-pd is a lexically similar distractor ('teacher', "
        "'professional development' vs 'survey', 'technology').",
    ),

    # --- near_duplicate (3) ---
    EvalCase(
        case_id="ND01",
        query="What was the average reading fluency gain reported in the tutoring "
        "outcomes brief?",
        category="near_duplicate",
        expected_document_ids=[_BRIEF_DRAFT, _BRIEF_FINAL],
        expected_chunk_ids=[_BRIEF_DRAFT + "::chunk0", _BRIEF_FINAL + "::chunk0"],
        notes="doc-tutoring-brief-draft and -final are near-identical revisions of "
        "the same finding — either (or both) should be considered a correct answer; "
        "not require_all_documents since they're redundant, not complementary.",
    ),
    EvalCase(
        case_id="ND02",
        query="Was the tutoring outcomes brief finding confirmed after data cleaning?",
        category="near_duplicate",
        expected_document_ids=[_BRIEF_FINAL],
        expected_chunk_ids=[_BRIEF_FINAL + "::chunk0"],
        notes="Only the FINAL brief mentions 'confirmed after data cleaning' — tests "
        "whether near-duplicate chunks can still be told apart on a distinguishing "
        "detail.",
    ),
    EvalCase(
        case_id="ND03",
        query="What was the reading fluency gain in the draft version of the tutoring "
        "outcomes brief, before final confirmation?",
        category="near_duplicate",
        expected_document_ids=[_BRIEF_DRAFT],
        expected_chunk_ids=[_BRIEF_DRAFT + "::chunk0"],
    ),

    # --- an extra section_specific + numerical_fact pair on doc-fidelity-quasi's
    # two distinct chunks, since that document exercises both categories well ---
    EvalCase(
        case_id="SS04",
        query="What was the planned weekly tutoring session schedule in the rural "
        "quasi-experimental study?",
        category="section_specific",
        expected_document_ids=[_FIDELITY],
        expected_chunk_ids=[_FIDELITY + "::chunk0"],
    ),

    # =========================================================================
    # Milestone 5.6 (evidence-sufficiency calibration): additional cases.
    # =========================================================================

    # --- 3 additional, harder positive cases (§5: "pay special attention to
    # the lowest-scoring legitimate positive cases" — heavier paraphrasing/
    # more oblique phrasing than the original Milestone 5 positives, so the
    # calibration sweep sees genuinely hard-but-valid low-score positives,
    # not only easy ones). ---
    EvalCase(
        case_id="PA04",
        query="What was the reading speed improvement, measured in words read "
        "correctly each minute, for the group that received structured peer "
        "support?",
        category="paraphrase",
        expected_document_ids=[_RCT],
        expected_chunk_ids=[_RCT + "::chunk1"],
        notes="Heavy paraphrase of 'words correct per minute (WCPM)'/'peer tutoring "
        "group' — deliberately more oblique than PA01-03.",
    ),
    EvalCase(
        case_id="AC04",
        query="In special education, what does the acronym IEP typically refer to?",
        category="acronym",
        expected_document_ids=[_IEP],
        expected_chunk_ids=[_IEP + "::chunk0"],
        notes="Same fact as AC02, reworded to be less directly aligned with the "
        "document's own phrasing.",
    ),
    EvalCase(
        case_id="NF04",
        query="By what amount, in words correct per minute, did the group that did "
        "NOT receive tutoring increase over the sixteen-week trial, if any?",
        category="numerical_fact",
        expected_document_ids=[_RCT],
        expected_chunk_ids=[_RCT + "::chunk1"],
        notes="Targets the RCT's CONTROL-group figure (3 WCPM) specifically, not the "
        "treatment group's 12 WCPM (NF01) — same chunk, a different, easy-to-miss "
        "sub-fact within it.",
    ),
    EvalCase(
        case_id="ET04",
        query="How many teachers were surveyed in the classroom technology "
        "adoption study?",
        category="exact_terminology",
        expected_document_ids=[_TECH_SURVEY],
        expected_chunk_ids=[_TECH_SURVEY + "::chunk0"],
    ),
    EvalCase(
        case_id="NF05",
        query="How many elementary schools were combined for the district-wide "
        "comprehensive reading report?",
        category="numerical_fact",
        expected_document_ids=[_COMPREHENSIVE],
        expected_chunk_ids=[_COMPREHENSIVE + "::chunk0"],
    ),
    EvalCase(
        case_id="DH04",
        query="Out of a planned three sessions per week, what percentage of "
        "scheduled tutoring sessions were actually confirmed delivered with "
        "fidelity?",
        category="distractor_heavy",
        expected_document_ids=[_FIDELITY],
        expected_chunk_ids=[_FIDELITY + "::chunk0"],
        notes="Combines two facts from the same chunk (planned frequency + actual "
        "delivery rate) — distractor risk from other fidelity/schedule-adjacent "
        "documents (doc-multipart-scheduling, doc-fidelity-quasi's own chunk1).",
    ),

    # --- B: related_topic_absent (4) — corpus discusses the general topic but
    # never answers the specific question asked. ---
    EvalCase(
        case_id="RB01",
        query="What specific staffing ratio was used in the peer tutoring "
        "randomized controlled trial?",
        category="related_topic_absent",
        answerable=False,
        notes="doc-related-topic-no-specific-number discusses staffing ratios in "
        "general (a related topic) but never for the RCT specifically; the RCT's "
        "own chunks never mention a staffing ratio at all.",
    ),
    EvalCase(
        case_id="RB02",
        query="How many students nationally participated in after-school academic "
        "support programs?",
        category="related_topic_absent",
        answerable=False,
        notes="doc-related-topic-no-specific-number is explicitly a generic "
        "best-practices overview with no outcome/participant data at all.",
    ),
    EvalCase(
        case_id="RB03",
        query="What was the average teacher-to-student ratio reported in the "
        "comprehensive district reading report?",
        category="related_topic_absent",
        answerable=False,
        notes="doc-comprehensive-report covers methods/results/limitations of a "
        "real, related reading intervention but never reports a teacher-student "
        "ratio anywhere in it.",
    ),
    EvalCase(
        case_id="RB04",
        query="Which classroom management strategy most improved tutoring "
        "outcomes?",
        category="related_topic_absent",
        answerable=False,
        notes="doc-classroom-management discusses management strategies (a related "
        "topic) but never connects any of them to tutoring outcomes.",
    ),

    # --- C: wrong_numerical_detail (4) — a nearby-but-different number exists
    # in a plausible, similar-topic document. ---
    EvalCase(
        case_id="RC01",
        query="Which tutoring study reported a Cohen's d effect size of "
        "approximately 0.75 on reading fluency?",
        category="wrong_numerical_detail",
        answerable=False,
        notes="The RCT reports d=0.61 (a nearby but different value) — no study in "
        "this corpus reports 0.75.",
    ),
    EvalCase(
        case_id="RC02",
        query="What was the words-correct-per-minute gain reported in the pilot "
        "peer tutoring program?",
        category="wrong_numerical_detail",
        answerable=False,
        notes="doc-pilot-peer-tutoring reports only a participant count (80); it "
        "never reports a WCPM figure — that number only exists for the RCT (12 "
        "WCPM, a different study).",
    ),
    EvalCase(
        case_id="RC03",
        query="How many sessions per week did the pilot peer tutoring program "
        "schedule?",
        category="wrong_numerical_detail",
        answerable=False,
        notes="The 'twice weekly' schedule (doc-multipart-scheduling) belongs to "
        "the RCT, not the pilot program — the pilot's own document never states a "
        "session frequency.",
    ),
    EvalCase(
        case_id="RC04",
        query="What Cohen's d effect size did the comprehensive district "
        "intervention report find?",
        category="wrong_numerical_detail",
        answerable=False,
        notes="doc-comprehensive-report reports percentage benchmarks (58% -> 67%), "
        "never a Cohen's d — a different numeric metric type entirely, easily "
        "confused with the RCT's d=0.61.",
    ),

    # --- D: entity_confusion (4) — similarly-named/labeled entities that are
    # NOT the one the question is actually about. ---
    EvalCase(
        case_id="RD01",
        query="How many words correct per minute did students in the Peer "
        "Mentoring Program gain?",
        category="entity_confusion",
        answerable=False,
        notes="Peer MENTORING (social-emotional, doc-peer-mentoring-program) is a "
        "different program from peer TUTORING (academic, doc-rct-peer-tutoring) — "
        "the mentoring document explicitly has no fluency/WCPM data.",
    ),
    EvalCase(
        case_id="RD02",
        query="What did Rivera-Santos find about the peer tutoring RCT's effect "
        "size?",
        category="entity_confusion",
        answerable=False,
        notes="A. Rivera-Santos (doc-similar-name-collision, teacher retention) is "
        "a different, unrelated person from A. Rivera (RCT co-author) — "
        "Rivera-Santos never discusses the RCT or any effect size.",
    ),
    EvalCase(
        case_id="RD03",
        query="What did Rivera-Santos conclude about parent involvement in "
        "tutoring?",
        category="entity_confusion",
        answerable=False,
        notes="Rivera-Santos's document discusses teacher retention only — parent "
        "involvement is not discussed by Rivera-Santos or anywhere else in the "
        "corpus.",
    ),
    EvalCase(
        case_id="RD04",
        query="How many participants were enrolled in the Peer Mentoring Program?",
        category="entity_confusion",
        answerable=False,
        notes="doc-peer-mentoring-program never states a participant count — easily "
        "confused with the peer TUTORING RCT's 24-participant figure (a different "
        "program).",
    ),

    # --- E: partial_evidence (3) — multi-part questions where only one part
    # is actually answerable. ---
    EvalCase(
        case_id="RE01",
        query="How much did each individual tutoring session cost, and how often "
        "did sessions occur in the RCT?",
        category="partial_evidence",
        answerable=False,
        notes="Frequency IS answerable (doc-multipart-scheduling: twice weekly) but "
        "per-SESSION cost is not — doc-budget-report only gives a total per-student "
        "program cost ($420 for the whole 16-week program), never a per-session "
        "figure. The question as a whole has no complete answer.",
    ),
    EvalCase(
        case_id="RE02",
        query="What was the RCT's session frequency, and on what exact calendar "
        "date did the program start?",
        category="partial_evidence",
        answerable=False,
        notes="Frequency is answerable (twice weekly); no document anywhere in the "
        "corpus gives a specific start date for any program.",
    ),
    EvalCase(
        case_id="RE03",
        query="What was the rural quasi-experimental study's planned session "
        "frequency, and what exact Cohen's d effect size did it report?",
        category="partial_evidence",
        answerable=False,
        notes="Frequency is answerable (doc-fidelity-quasi chunk0: three sessions "
        "per week); the study only reports a qualitative 'non-significant effect' "
        "(chunk1), never a numeric Cohen's d.",
    ),

    # --- F: cross_document_incomplete (3) — a comparison question where only
    # one required side actually exists in the corpus. ---
    EvalCase(
        case_id="RF01",
        query="Compare the Peer Mentoring Program's reading-fluency WCPM gains to "
        "the RCT's WCPM gains.",
        category="cross_document_incomplete",
        answerable=False,
        notes="The RCT side exists (12 WCPM); the Peer Mentoring Program side does "
        "not (it has no fluency data at all — a different, non-academic program) — "
        "the comparison as asked is impossible, not merely hard.",
    ),
    EvalCase(
        case_id="RF02",
        query="Compare the neighboring district's null-result tutoring program's "
        "WCPM gain to the RCT's WCPM gain.",
        category="cross_document_incomplete",
        answerable=False,
        notes="The RCT gives an exact number (12 WCPM); the null-result document "
        "only states qualitatively that there was no significant improvement, "
        "never an actual WCPM figure to compare against.",
    ),
    EvalCase(
        case_id="RF03",
        query="Compare the Cohen's d effect sizes reported by the comprehensive "
        "district report and the RCT.",
        category="cross_document_incomplete",
        answerable=False,
        notes="The RCT reports d=0.61; the comprehensive report never reports a "
        "Cohen's d at all (only percentage benchmarks) — one side of the "
        "comparison's metric type doesn't exist in the corpus.",
    ),

    # --- H: zoom_in_project_absent (3) — modeled as a Zoom-In-scope variant:
    # this harness has no separate "project knowledge item" store distinct
    # from documents (see app/core/project_context.py in the real backend for
    # that actual, separate subsystem), so "the answer is in the project but
    # not the Zoom-In selection" is simulated the same way as category G
    # (answer exists elsewhere in the user's own document library, outside
    # the Zoom-In-selected document(s)) — see NEGATIVE_TYPE_LABELS above for
    # this explicit, documented simplification. ---
    EvalCase(
        case_id="RH01",
        query="What percentage of scheduled tutoring sessions were confirmed "
        "delivered with fidelity?",
        category="zoom_in_project_absent",
        expected_document_ids=[_FIDELITY],
        expected_chunk_ids=[_FIDELITY + "::chunk0"],
        scope_document_ids=[_RCT],
        scope_contains_answer=False,
        notes="The fidelity figure lives in doc-fidelity-quasi; this case's "
        "simulated scope is doc-rct-peer-tutoring only (a plausible but wrong "
        "single-document selection).",
    ),
    EvalCase(
        case_id="RH02",
        query="How many participants were in the pilot peer tutoring program?",
        category="zoom_in_project_absent",
        expected_document_ids=[_PILOT],
        expected_chunk_ids=[_PILOT + "::chunk0"],
        scope_document_ids=[_COMPREHENSIVE],
        scope_contains_answer=False,
    ),
    EvalCase(
        case_id="RH03",
        query="What does UDL stand for?",
        category="zoom_in_project_absent",
        expected_document_ids=[_UDL],
        expected_chunk_ids=[_UDL + "::chunk0"],
        scope_document_ids=[_IEP],
        scope_contains_answer=False,
    ),

    # --- I: semantic_neighbor_distractor (4) — text highly semantically
    # related to the query but that does not actually support the claim
    # asked. ---
    EvalCase(
        case_id="RI01",
        query="What edtech software was used to deliver the peer tutoring "
        "program?",
        category="semantic_neighbor_distractor",
        answerable=False,
        notes="doc-edtech-review discusses adaptive learning software for math "
        "practice — semantically close ('tutoring', 'technology') but explicitly "
        "not the peer tutoring program's delivery mechanism; the review even notes "
        "none of its software is a tutoring program 'in the sense evaluated "
        "elsewhere in this corpus.'",
    ),
    EvalCase(
        case_id="RI02",
        query="What coaching model did the peer tutoring program use to train its "
        "tutors?",
        category="semantic_neighbor_distractor",
        answerable=False,
        notes="doc-teacher-pd discusses coaching-based PD for in-service teachers — "
        "semantically close ('coaching', 'training') but explicitly 'distinct from "
        "student-facing tutoring interventions'; tutor training itself is never "
        "described anywhere in the corpus.",
    ),
    EvalCase(
        case_id="RI03",
        query="How did the small-group reading instruction study's numeric results "
        "compare to the RCT's?",
        category="semantic_neighbor_distractor",
        answerable=False,
        notes="doc-small-group-reading only defines/distinguishes the model from "
        "one-on-one peer tutoring — it reports no outcome numbers at all, so no "
        "numeric comparison is possible despite being topically adjacent.",
    ),
    EvalCase(
        case_id="RI04",
        query="What formative assessment technique did the peer tutoring program "
        "use to monitor student progress?",
        category="semantic_neighbor_distractor",
        answerable=False,
        notes="doc-assessment-design discusses formative assessment generally "
        "(exit tickets, quizzes) — semantically close to 'monitor progress' but "
        "never connected to the tutoring program specifically.",
    ),

    # --- J: negation_contradiction (3) — a document explicitly negates what
    # the question presupposes. ---
    EvalCase(
        case_id="RJ01",
        query="How much did reading fluency improve in the neighboring district's "
        "after-school tutoring program?",
        category="negation_contradiction",
        answerable=False,
        notes="doc-tutoring-null-effect explicitly reports NO statistically "
        "significant improvement — the question presupposes an improvement amount "
        "that does not exist to report.",
    ),
    EvalCase(
        case_id="RJ02",
        query="What was the effect size of the neighboring district's tutoring "
        "program on reading fluency?",
        category="negation_contradiction",
        answerable=False,
        notes="Same null-result document — it gives no numeric effect size, only a "
        "qualitative non-significant-result statement.",
    ),
    EvalCase(
        case_id="RJ03",
        query="What was the average fluency gain across all tutoring programs in "
        "this corpus, given that all of them produced significant improvements?",
        category="negation_contradiction",
        answerable=False,
        notes="The presupposition ('all of them produced significant "
        "improvements') is directly contradicted by doc-tutoring-null-effect and "
        "doc-fidelity-quasi (non-significant effect); no document anywhere "
        "computes a corpus-wide average across programs either way.",
    ),

    # --- K: acronym_ambiguity (3) — the same acronym exists in the corpus,
    # but not in the sense/context the question needs. ---
    EvalCase(
        case_id="RK01",
        query="What does SOR stand for in special education law?",
        category="acronym_ambiguity",
        answerable=False,
        notes="The corpus defines SOR twice — 'Science of Reading' (reading "
        "instruction) and 'Statement of Requirements' (procurement) — neither in "
        "the context of special education law, which is never discussed.",
    ),
    EvalCase(
        case_id="RK02",
        query="What does SOR mean in the context of vendor contract submissions in "
        "New York State specifically?",
        category="acronym_ambiguity",
        answerable=False,
        notes="doc-sor-procurement-glossary defines SOR generically for vendor "
        "procurement but never mentions any specific state's rules.",
    ),
    EvalCase(
        case_id="RK03",
        query="What does UDL mean in the context of universal design for "
        "buildings, not education?",
        category="acronym_ambiguity",
        answerable=False,
        notes="doc-udl-guide only defines UDL in the Universal-Design-for-Learning "
        "(education) sense — a building/architecture meaning is never discussed.",
    ),

    # --- L: section_mismatch (4) — the correct document/topic, but the
    # specific section/fact-type asked for isn't actually in it. ---
    EvalCase(
        case_id="RL01",
        query="What was the exact number of participants in the comprehensive "
        "district reading report?",
        category="section_mismatch",
        answerable=False,
        notes="doc-comprehensive-report reports percentages and a school count, "
        "never an exact participant headcount, despite being exactly the right "
        "document on the right topic.",
    ),
    EvalCase(
        case_id="RL02",
        query="What statistical test did the comprehensive district reading "
        "report use to determine significance?",
        category="section_mismatch",
        answerable=False,
        notes="The report has Methods/Results/Limitations chunks but never names a "
        "specific statistical test.",
    ),
    EvalCase(
        case_id="RL03",
        query="What Cohen's d or numeric effect size did the rural "
        "quasi-experimental fidelity study report?",
        category="section_mismatch",
        answerable=False,
        notes="doc-fidelity-quasi's results-equivalent chunk only says "
        "'non-significant effect' qualitatively — no numeric d value is ever given "
        "for this study, unlike the RCT.",
    ),
    EvalCase(
        case_id="RL04",
        query="What limitations did the peer tutoring RCT report about its own "
        "study design?",
        category="section_mismatch",
        answerable=False,
        notes="The RCT document has Methods and Results chunks only — no "
        "Limitations section/content exists for it anywhere (unlike "
        "doc-comprehensive-report, which does have one).",
    ),

    # --- G padding (2 more) — strengthens the true-negative sample for
    # Zoom-In-scope calibration (§10), same "answer exists elsewhere in the
    # corpus, not in the simulated Zoom-In selection" pattern as ZI01/ZI03. ---
    EvalCase(
        case_id="ZI04",
        query="What percentage of students met grade-level reading benchmarks "
        "after the district-wide intervention?",
        category="zoom_in_absent_elsewhere_present",
        expected_document_ids=[_COMPREHENSIVE],
        expected_chunk_ids=[_COMPREHENSIVE + "::chunk1"],
        scope_document_ids=[_RCT],
        scope_contains_answer=False,
    ),
    EvalCase(
        case_id="ZI05",
        query="How many participants were in the peer tutoring randomized "
        "controlled trial?",
        category="zoom_in_absent_elsewhere_present",
        expected_document_ids=[_RCT],
        expected_chunk_ids=[_RCT + "::chunk0"],
        scope_document_ids=[_UDL],
        scope_contains_answer=False,
    ),

    # --- A padding (3 more) — strengthens the plain "completely unrelated
    # question" negative sample. ---
    EvalCase(
        case_id="AA04",
        query="What was the impact of the tutoring program on students' sleep "
        "schedules?",
        category="answer_absent",
        answerable=False,
    ),
    EvalCase(
        case_id="AA05",
        query="How many tutors were certified in a foreign language immersion "
        "methodology?",
        category="answer_absent",
        answerable=False,
    ),
    EvalCase(
        case_id="AA06",
        query="What was the school district's total annual transportation budget?",
        category="answer_absent",
        answerable=False,
    ),
]

_M5_M5_6_CATEGORIES = frozenset(CATEGORIES) - {
    # Milestone 5.7 added these categories to the shared CATEGORIES
    # registry for evaluation/realistic_corpus.py's use — CONTROLLED_CASES
    # (Milestone 5/5.6's own corpus) was never meant to use them, so they
    # are excluded from this module's own "every category has >=1 case"
    # check below. See evaluation/realistic_corpus.py's own equivalent
    # assert for its categories.
    "definition", "methodology_question", "result_interpretation", "citation_sensitive",
    "synthesis_multi_document", "comparison_multi_section", "wrong_population_sample",
    "wrong_methodology", "wrong_date_year", "wrong_causal_claim",
    "correlation_causation_confusion", "claim_stronger_than_source",
    "presupposition_not_stated", "concept_not_conclusion",
}
assert {c.category for c in CONTROLLED_CASES} == _M5_M5_6_CATEGORIES, (
    "every Milestone 5/5.6 category must have >=1 case in CONTROLLED_CASES"
)
