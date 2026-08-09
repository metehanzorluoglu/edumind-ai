"""Milestone 5.7 (production-representative retrieval & evidence benchmark):
a second, larger, more realistic evaluation corpus — 20 documents across 10
education-research topics (2 documents per topic: one journal-article-style
primary study, one practitioner/curriculum/policy/report-style companion
document), ~150 chunks with multi-section structure (Introduction/Literature
Review/Methods/Results/Discussion for the "A" documents; Overview/Core
Concepts/Implementation/Pitfalls/Summary for the "B" documents) — closer to
what a real ingested PDF's per-page chunks conceptually look like than
Milestone 5's shorter single-paragraph documents.

PRIVACY / LICENSING (Milestone 5.7 §2-3, read before editing this file):
every document below is 100% ORIGINAL, FICTIONAL content written for this
evaluation harness — no real paper, real dataset, real author, or real
institution is copied, paraphrased from a specific source, or represented.
"Findings" (numbers, effect sizes, sample sizes) are invented for ground-
truth-labeling purposes only and must never be treated as real research.
This file also NEVER contains real production user documents, real user
questions, or any content extracted from actual EduM8 usage — building this
benchmark from committed fictional fixtures (the same approach Milestone 5
used) was chosen specifically because it creates no privacy liability,
unlike sourcing from real user corpora or chat logs (which this milestone's
own instructions explicitly forbid).

Reuses evaluation/controlled_corpus.py's EvalCase/ControlledDocument
dataclasses directly (Milestone 5.7 §1: "do not create a fourth unrelated
evaluation framework") — this module only supplies more/larger DATA, no new
schema beyond what controlled_corpus.py already defines (sufficiency/topic/
optional_supporting_document_ids, all added in that module for exactly this
purpose).

Corpus size: 20 documents / 149 chunks / 102 cases (62 general-mode +
40 Zoom-In: 20 positive + 20 negative) — see the Milestone 5.7 report's
"Corpus" and "Questions" sections for the full breakdown and the explicit
justification for landing at the lower/quality-focused end of the
milestone's suggested ranges (60-120 questions; 150-300 chunks) rather than
the upper end.
"""

from __future__ import annotations

from evaluation.controlled_corpus import CATEGORIES, ControlledChunk, ControlledDocument, EvalCase

# ---------------------------------------------------------------------------
# Documents — 10 topics x 2 documents each
# ---------------------------------------------------------------------------

REALISTIC_DOCUMENTS: list[ControlledDocument] = [
    # === Topic 1: reading_science ===
    ControlledDocument(
        document_id="rc-doc-phonics-rct",
        source_filename="systematic-phonics-outcomes.pdf",
        title="Systematic Phonics Instruction and Early Reading Outcomes: A Randomized Trial",
        document_type="journal_article", journal_quartile="Q1",
        authors=["E. Marchetti", "R. Owusu"], publication_year=2022, topic="reading_science",
        chunks=[
            ControlledChunk(0, 1, "Introduction: this study examines whether systematic, "
                "explicit phonics instruction improves decoding accuracy in kindergarten "
                "compared to an embedded/incidental phonics approach."),
            ControlledChunk(1, 2, "Literature review: prior small-sample studies have shown "
                "mixed results for explicit phonics, with effect sizes ranging from d=0.15 "
                "to d=0.55 depending on instructional intensity and teacher training."),
            ControlledChunk(2, 3, "Methods: 312 kindergarten students across 18 classrooms in "
                "four districts were randomly assigned by classroom to systematic phonics "
                "(n=158) or embedded phonics (n=154) for one academic year."),
            ControlledChunk(3, 4, "Procedure: the systematic phonics condition delivered "
                "25 minutes of explicit, sequenced letter-sound instruction daily; the "
                "embedded condition taught phonics opportunistically during shared reading."),
            ControlledChunk(4, 5, "Results (decoding): the systematic phonics group scored "
                "significantly higher on the end-of-year nonsense-word decoding measure "
                "(mean 42.3 correct) than the embedded group (mean 31.7 correct), d=0.58."),
            ControlledChunk(5, 6, "Results (comprehension): no significant between-group "
                "difference was found on a listening comprehension measure administered at "
                "the same time point (p=0.41), suggesting the effect was decoding-specific."),
            ControlledChunk(6, 7, "Discussion: the authors argue systematic phonics provides "
                "a reliable early decoding advantage but caution that comprehension gains "
                "may require separate, explicit instructional attention."),
            ControlledChunk(7, 8, "Limitations: the study did not follow students beyond one "
                "year, so it cannot speak to whether the decoding advantage persists into "
                "later grades or fades once embedded instruction catches up."),
        ],
    ),
    ControlledDocument(
        document_id="rc-doc-balanced-literacy-review",
        source_filename="balanced-literacy-critical-review.pdf",
        title="Balanced Literacy Approaches: A Critical Review",
        document_type="review_article", journal_quartile="Q2",
        authors=["H. Feldstein"], publication_year=2021, topic="reading_science",
        chunks=[
            ControlledChunk(0, 1, "Overview: balanced literacy blends phonics, whole-language "
                "reading, and writing instruction, and remains widely used despite "
                "criticism from Science-of-Reading researchers."),
            ControlledChunk(1, 2, "Core concept: three-cueing, a balanced-literacy strategy "
                "that encourages students to guess unfamiliar words from context, picture, "
                "and initial-letter cues rather than fully decoding them."),
            ControlledChunk(2, 3, "Core concept: balanced literacy classrooms typically use "
                "leveled texts matched to a student's independent reading level, adjusted "
                "roughly every four to six weeks based on running-record assessments."),
            ControlledChunk(3, 4, "Critique: this review argues that three-cueing can allow "
                "students to appear fluent while masking weak decoding skills, a concern "
                "raised independently by several Science-of-Reading advocates."),
            ControlledChunk(4, 5, "Implementation note: districts transitioning away from "
                "three-cueing toward structured literacy commonly report a multi-year "
                "retraining process for existing teaching staff."),
            ControlledChunk(5, 6, "Summary: the review concludes balanced literacy is not "
                "inherently ineffective, but that three-cueing specifically should be "
                "phased out in favor of decoding-first strategies."),
        ],
    ),

    # === Topic 2: ai_education ===
    ControlledDocument(
        document_id="rc-doc-adaptive-learning-study",
        source_filename="adaptive-learning-engagement-study.pdf",
        title="Adaptive Learning Systems and Student Engagement in Middle School Math",
        document_type="journal_article", journal_quartile="Q2",
        authors=["T. Byrne", "M. Adeyemi"], publication_year=2023, topic="ai_education",
        chunks=[
            ControlledChunk(0, 1, "Introduction: adaptive learning platforms adjust problem "
                "difficulty in real time based on a student's response accuracy; this study "
                "measures whether such adjustment sustains engagement over a semester."),
            ControlledChunk(1, 2, "Literature review: earlier work links adaptive difficulty "
                "to a 'flow'-like engagement state, but most prior studies were shorter than "
                "eight weeks and used self-report engagement measures only."),
            ControlledChunk(2, 3, "Methods: 6 middle schools (grades 6-8, n=891 students) used "
                "an adaptive math platform for one semester; engagement was measured via "
                "platform log data (time-on-task, voluntary practice sessions)."),
            ControlledChunk(3, 4, "Results: voluntary (non-assigned) practice sessions "
                "increased by 34 percent over the semester in classrooms using adaptive "
                "difficulty, compared to an 6 percent increase in fixed-difficulty classrooms."),
            ControlledChunk(4, 5, "Results (achievement): end-of-semester unit test scores "
                "were 4.1 points higher on average (out of 100) in the adaptive condition, "
                "a modest but statistically significant difference (p=0.03)."),
            ControlledChunk(5, 6, "Discussion: the authors attribute the engagement gain to "
                "reduced frustration (fewer too-hard problems) and reduced boredom (fewer "
                "too-easy problems), not to any change in teacher instruction."),
            ControlledChunk(6, 7, "Limitations: the study could not separate the adaptive "
                "algorithm's effect from novelty effects of using new software, since no "
                "school had used the platform before."),
        ],
    ),
    ControlledDocument(
        document_id="rc-doc-explainable-ai-curriculum",
        source_filename="explainable-ai-k12-concepts.pdf",
        title="Explainable AI Concepts for K-12 Classrooms",
        document_type="curriculum_document", journal_quartile=None,
        authors=["AI Literacy Curriculum Group (fictional)"],
        publication_year=2023, topic="ai_education",
        chunks=[
            ControlledChunk(0, 1, "Overview: this curriculum introduces core AI/ML concepts "
                "(training data, model, prediction, bias) to middle and high school students "
                "without requiring programming background."),
            ControlledChunk(1, 2, "Core concept: training data is defined here as the labeled "
                "examples a model learns from; the curriculum uses a simple image-sorting "
                "activity to illustrate how more/better-labeled examples improve accuracy."),
            ControlledChunk(2, 3, "Core concept: algorithmic bias is introduced through a "
                "case activity where a model trained only on one type of example performs "
                "poorly on examples that differ from its training data."),
            ControlledChunk(3, 4, "Core concept: the curriculum distinguishes a 'neural "
                "network' (a layered mathematical model) from 'artificial intelligence' "
                "generally (the broader field), a distinction students often conflate."),
            ControlledChunk(4, 5, "Implementation guidance: the full unit is designed for "
                "five 45-minute class periods and requires no additional software beyond a "
                "web browser."),
            ControlledChunk(5, 6, "Common pitfalls: the curriculum authors note that students "
                "frequently anthropomorphize AI systems ('the AI wants to...'), which the "
                "unit explicitly addresses with a vocabulary-correction activity."),
            ControlledChunk(6, 7, "Summary: the curriculum's stated goal is AI literacy, not "
                "AI fluency — it does not teach students to build models, only to reason "
                "about how AI systems make decisions and where they can fail."),
        ],
    ),

    # === Topic 3: formative_assessment ===
    ControlledDocument(
        document_id="rc-doc-formative-assessment-study",
        source_filename="formative-assessment-learning-gains.pdf",
        title="Formative Assessment Practices and Learning Gains in Secondary Science",
        document_type="journal_article", journal_quartile="Q1",
        authors=["S. Delacroix", "J. Whitmore"],
        publication_year=2022, topic="formative_assessment",
        chunks=[
            ControlledChunk(0, 1, "Introduction: this study tests whether high-frequency "
                "formative assessment (brief checks every class period) improves unit-test "
                "performance in ninth-grade physical science compared to weekly quizzes only."),
            ControlledChunk(1, 2, "Literature review: formative assessment's effect on "
                "achievement has been described as one of the largest documented in "
                "education research, though effect-size estimates vary widely by study design."),
            ControlledChunk(2, 3, "Methods: 24 ninth-grade science classes (n=612 students) "
                "were assigned to daily formative checks (exit tickets) or weekly quizzes "
                "only, over one 12-week unit on forces and motion."),
            ControlledChunk(3, 4, "Results: the daily-formative-check group scored 7.8 points "
                "higher on average (out of 100) on the end-of-unit test than the weekly-quiz "
                "group, d=0.44."),
            ControlledChunk(4, 5, "Results (subgroup): the achievement gap between "
                "historically underperforming students and their peers narrowed by "
                "approximately one third in the daily-check classrooms, but did not narrow "
                "in the weekly-quiz classrooms."),
            ControlledChunk(5, 6, "Discussion: the authors argue the mechanism is faster "
                "teacher response to misconceptions, not the assessment itself — teachers "
                "in the daily-check condition re-taught struggling concepts within 48 hours."),
            ControlledChunk(6, 7, "Limitations: teachers were not blinded to condition, and "
                "the daily-check teachers received additional planning time, which may have "
                "independently contributed to the achievement difference."),
        ],
    ),
    ControlledDocument(
        document_id="rc-doc-exit-tickets-guide",
        source_filename="exit-tickets-practitioner-guide.pdf",
        title="A Practitioner's Guide to Exit Tickets and Quick Checks",
        document_type="practitioner_article", journal_quartile=None,
        authors=["Classroom Practice Network (fictional)"],
        publication_year=2020, topic="formative_assessment",
        chunks=[
            ControlledChunk(0, 1, "Overview: exit tickets are short, ungraded prompts "
                "collected at the end of a lesson to check understanding before the next "
                "class period begins."),
            ControlledChunk(1, 2, "Core concept: an effective exit ticket targets exactly one "
                "learning objective and takes students no more than three minutes to "
                "complete, according to this guide's recommended design principles."),
            ControlledChunk(2, 3, "Core concept: the guide recommends sorting exit-ticket "
                "responses into three piles (got it / partial / not yet) rather than "
                "grading them, to keep the turnaround time under ten minutes."),
            ControlledChunk(3, 4, "Implementation guidance: teachers new to exit tickets are "
                "advised to start with one class period per week before scaling to daily "
                "use, to avoid the practice becoming a grading burden."),
            ControlledChunk(4, 5, "Common pitfalls: the most frequent mistake this guide "
                "identifies is using exit tickets as a graded quiz, which changes student "
                "response behavior (guessing to avoid a low grade) and reduces their "
                "diagnostic value."),
            ControlledChunk(5, 6, "Summary: exit tickets are positioned in this guide as a "
                "low-stakes diagnostic tool, not a summative assessment substitute."),
        ],
    ),

    # === Topic 4: spaced_repetition ===
    ControlledDocument(
        document_id="rc-doc-spaced-repetition-meta",
        source_filename="spaced-repetition-retention-metaanalysis.pdf",
        title="Spaced Repetition and Long-Term Retention: A Meta-Analysis",
        document_type="review_article", journal_quartile="Q1",
        authors=["P. Ionescu"], publication_year=2021, topic="spaced_repetition",
        chunks=[
            ControlledChunk(0, 1, "Introduction: this meta-analysis pools 41 studies "
                "comparing spaced (distributed) practice to massed (crammed) practice on "
                "long-term retention of factual and procedural content."),
            ControlledChunk(1, 2, "Literature review: the spacing effect has been "
                "demonstrated across vocabulary learning, mathematics, and medical "
                "education, though most individual studies use adult, not K-12, samples."),
            ControlledChunk(2, 3, "Methods: the pooled sample includes 41 studies (total "
                "n=6,204 participants) published between 1990 and 2019, restricted to "
                "studies measuring retention at least one week after final practice."),
            ControlledChunk(3, 4, "Results: the pooled effect size favoring spaced practice "
                "was d=0.62 for retention tests given one week or more after practice ended, "
                "with larger effects for longer retention intervals."),
            ControlledChunk(4, 5, "Results (moderators): studies using expanding-interval "
                "spacing schedules (gradually lengthening gaps between reviews) showed "
                "somewhat larger effects (d=0.71) than fixed-interval spacing (d=0.54)."),
            ControlledChunk(5, 6, "Discussion: the authors note the spacing effect is one of "
                "the most consistently replicated findings in learning science, but that "
                "K-12 classroom implementations remain understudied relative to lab studies."),
            ControlledChunk(6, 7, "Limitations: fewer than 15 percent of the pooled studies "
                "were conducted in authentic K-12 classroom settings; most used controlled "
                "laboratory conditions."),
        ],
    ),
    ControlledDocument(
        document_id="rc-doc-spaced-practice-classroom",
        source_filename="spaced-practice-secondary-classrooms.pdf",
        title="Implementing Spaced Practice in Secondary Classrooms",
        document_type="practitioner_article", journal_quartile=None,
        authors=["R. Vance"], publication_year=2022, topic="spaced_repetition",
        chunks=[
            ControlledChunk(0, 1, "Overview: this guide translates the spacing-effect "
                "research into weekly lesson-planning routines for secondary teachers "
                "without requiring specialized software."),
            ControlledChunk(1, 2, "Core concept: a 'cumulative warm-up' revisits content "
                "from two, four, and eight weeks prior in the first five minutes of class, "
                "rather than only reviewing the previous lesson."),
            ControlledChunk(2, 3, "Core concept: the guide distinguishes spaced practice "
                "(revisiting the same content over time) from interleaving (mixing "
                "different topics within one practice session) — related but separate "
                "strategies."),
            ControlledChunk(3, 4, "Implementation guidance: teachers are advised to track "
                "which content has been reviewed and when using a simple spreadsheet, since "
                "manually remembering a spacing schedule across many topics is unreliable."),
            ControlledChunk(4, 5, "Common pitfalls: students often report spaced practice "
                "feels less effective than massed cramming in the short term, which this "
                "guide identifies as a major adoption barrier requiring explicit "
                "explanation to students."),
            ControlledChunk(5, 6, "Summary: this guide frames spaced practice as a "
                "low-cost, high-value routine change rather than a curriculum overhaul."),
        ],
    ),

    # === Topic 5: project_based_learning ===
    ControlledDocument(
        document_id="rc-doc-pbl-stem-study",
        source_filename="pbl-stem-outcomes-study.pdf",
        title="Project-Based Learning Outcomes in STEM Classrooms",
        document_type="journal_article", journal_quartile="Q2",
        authors=["N. Castellano", "D. Reyes"],
        publication_year=2021, topic="project_based_learning",
        chunks=[
            ControlledChunk(0, 1, "Introduction: this study compares content-standard "
                "mastery and student-reported motivation between project-based and "
                "traditional lecture-based STEM units across one academic year."),
            ControlledChunk(1, 2, "Literature review: PBL's effect on content mastery has "
                "been inconsistent across prior studies, while its effect on motivation and "
                "engagement has been more consistently positive."),
            ControlledChunk(2, 3, "Methods: 9 high schools implemented either a PBL-based "
                "physics curriculum (n=402 students) or the standard lecture-based "
                "curriculum (n=387 students) across a full year."),
            ControlledChunk(3, 4, "Results (mastery): standardized test scores showed no "
                "statistically significant difference between PBL and traditional "
                "instruction (p=0.29) on content-standard mastery."),
            ControlledChunk(4, 5, "Results (motivation): PBL students reported "
                "significantly higher intrinsic motivation scores (mean 3.8/5) than "
                "traditional-instruction students (mean 3.1/5), d=0.51."),
            ControlledChunk(5, 6, "Discussion: the authors conclude PBL is not shown here "
                "to increase content mastery relative to traditional instruction, but does "
                "meaningfully increase student-reported motivation."),
            ControlledChunk(6, 7, "Limitations: teacher experience with PBL varied widely "
                "(one to twelve years), and the study could not isolate curriculum design "
                "from teacher implementation skill."),
        ],
    ),
    ControlledDocument(
        document_id="rc-doc-driving-questions-guide",
        source_filename="pbl-driving-questions-design.pdf",
        title="Designing Driving Questions for PBL Units",
        document_type="curriculum_document", journal_quartile=None,
        authors=["PBL Design Collective (fictional)"],
        publication_year=2020, topic="project_based_learning",
        chunks=[
            ControlledChunk(0, 1, "Overview: a driving question is the open-ended, "
                "authentic problem that anchors an entire PBL unit and should be "
                "revisited throughout, not only at the start."),
            ControlledChunk(1, 2, "Core concept: an effective driving question is "
                "'open enough to allow multiple solution paths but grounded enough to be "
                "answerable using the unit's target content standards.'"),
            ControlledChunk(2, 3, "Core concept: this guide recommends driving questions "
                "be framed from a real stakeholder's perspective (e.g. 'how might we help "
                "the city reduce flooding on Main Street') rather than an abstract textbook "
                "phrasing."),
            ControlledChunk(3, 4, "Implementation guidance: the guide recommends piloting a "
                "new driving question with a single class before rolling it out "
                "school-wide, since question clarity is difficult to judge without student "
                "feedback."),
            ControlledChunk(4, 5, "Common pitfalls: a driving question that is answerable "
                "with a single Google search, rather than sustained investigation, is "
                "identified as the most common design failure in this guide."),
            ControlledChunk(5, 6, "Summary: this guide treats the driving question as the "
                "single most important design decision in a PBL unit, more consequential "
                "than the final product format."),
        ],
    ),

    # === Topic 6: udl_accessibility ===
    ControlledDocument(
        document_id="rc-doc-udl-implementation-study",
        source_filename="udl-implementation-outcomes.pdf",
        title="Universal Design for Learning: Implementation and Outcomes",
        document_type="journal_article", journal_quartile="Q2",
        authors=["K. Sorensen"], publication_year=2022, topic="udl_accessibility",
        chunks=[
            ControlledChunk(0, 1, "Introduction: this study examines whether UDL-aligned "
                "lesson redesign (multiple means of representation, action, and "
                "engagement) improves participation for students with and without "
                "identified disabilities."),
            ControlledChunk(1, 2, "Literature review: UDL is grounded in the premise that "
                "learner variability is the norm, not the exception, and that flexible "
                "design benefits a broader range of students than accommodations targeted "
                "at individual students."),
            ControlledChunk(2, 3, "Methods: 14 inclusive middle-school classrooms "
                "(n=376 students, including 58 students with IEPs) redesigned two units "
                "using UDL principles; participation was measured via classroom "
                "observation checklists."),
            ControlledChunk(3, 4, "Results: active-participation rates increased from a "
                "baseline of 61 percent to 79 percent of observed intervals after UDL "
                "redesign, with the largest gains among students with IEPs (+31 points)."),
            ControlledChunk(4, 5, "Results (achievement): unit-test scores did not show a "
                "statistically significant change (p=0.18), though the study notes it was "
                "not powered to detect a small achievement effect."),
            ControlledChunk(5, 6, "Discussion: the authors interpret the participation gain "
                "as evidence UDL redesign lowers barriers to engagement, while cautioning "
                "that participation gains did not translate into measurable test-score "
                "gains within this study's one-semester window."),
            ControlledChunk(6, 7, "Limitations: classroom observation checklists were "
                "completed by the same teachers who redesigned the units, introducing "
                "possible observer bias toward reporting improvement."),
        ],
    ),
    ControlledDocument(
        document_id="rc-doc-udl-multilingual-policy",
        source_filename="udl-guidelines-multilingual-learners.pdf",
        title="UDL Guidelines for Multilingual Learners",
        document_type="policy_document", journal_quartile=None,
        authors=["State Office of Multilingual Education (fictional)"],
        publication_year=2023, topic="udl_accessibility",
        chunks=[
            ControlledChunk(0, 1, "Overview: this policy guidance connects UDL's three "
                "principles to specific supports for multilingual learners, distinct from "
                "supports designed for students with disabilities."),
            ControlledChunk(1, 2, "Core concept: 'multiple means of representation' for "
                "multilingual learners includes providing key vocabulary in both English "
                "and a student's home language before a lesson, not only visual aids."),
            ControlledChunk(2, 3, "Core concept: this policy distinguishes a language "
                "accommodation (e.g. extended time) from a UDL design choice (e.g. "
                "building in vocabulary pre-teaching for every student), the latter "
                "requiring no individual eligibility determination."),
            ControlledChunk(3, 4, "Implementation guidance: districts are directed to "
                "audit core curriculum materials for UDL-multilingual alignment before "
                "purchasing supplemental language-support materials."),
            ControlledChunk(4, 5, "Common pitfalls: the policy warns against treating "
                "translation alone as sufficient UDL implementation, since translated "
                "materials that keep the same complex sentence structures do not reduce "
                "cognitive load."),
            ControlledChunk(5, 6, "Summary: this document is guidance, not a mandate — it "
                "does not require districts to adopt any specific curriculum or vendor."),
        ],
    ),

    # === Topic 7: dyslexia_intervention ===
    ControlledDocument(
        document_id="rc-doc-dyslexia-structured-literacy-study",
        source_filename="structured-literacy-dyslexia-outcomes.pdf",
        title="Structured Literacy Interventions for Students with Dyslexia",
        document_type="journal_article", journal_quartile="Q1",
        authors=["A. Kessler", "L. Novak"], publication_year=2021, topic="dyslexia_intervention",
        chunks=[
            ControlledChunk(0, 1, "Introduction: this study evaluates a 20-week structured "
                "literacy intervention (Orton-Gillingham-aligned) for third-grade students "
                "identified as at risk for dyslexia via universal screening."),
            ControlledChunk(1, 2, "Literature review: structured literacy interventions "
                "combining explicit phonics, morphology, and multisensory instruction have "
                "shown consistent effects for students with dyslexia across multiple prior "
                "studies, though intervention length varies considerably."),
            ControlledChunk(2, 3, "Methods: 96 third-grade students identified as at-risk "
                "via a universal screener received either the 20-week structured-literacy "
                "intervention (n=49) or continued standard small-group reading support "
                "(n=47)."),
            ControlledChunk(3, 4, "Results: the intervention group's decoding scores "
                "improved by 18.4 standard-score points on average, compared to 6.2 points "
                "in the standard-support group, d=0.89."),
            ControlledChunk(4, 5, "Results (fluency): oral reading fluency gains were also "
                "significantly larger in the intervention group (average +22 WCPM) than the "
                "standard-support group (average +9 WCPM)."),
            ControlledChunk(5, 6, "Discussion: the authors describe the effect size as "
                "consistent with prior structured-literacy research and argue for earlier "
                "universal screening so intervention can begin before third grade."),
            ControlledChunk(6, 7, "Limitations: the study did not include a component "
                "analysis, so it cannot determine which specific intervention elements "
                "(phonics, morphology, or multisensory technique) drove the effect."),
        ],
    ),
    ControlledDocument(
        document_id="rc-doc-dyslexia-screening-tools",
        source_filename="early-dyslexia-screening-tools-report.pdf",
        title="Screening Tools for Early Dyslexia Risk",
        document_type="report", journal_quartile=None,
        authors=["District Assessment Office (fictional)"],
        publication_year=2022, topic="dyslexia_intervention",
        chunks=[
            ControlledChunk(0, 1, "Overview: this report compares three commonly used "
                "kindergarten dyslexia-risk screening instruments on administration time "
                "and predictive accuracy."),
            ControlledChunk(1, 2, "Instrument comparison: the Phonological Awareness "
                "Screener (PAS) takes approximately 8 minutes per student and flagged "
                "14 percent of the district's kindergarten cohort as at-risk."),
            ControlledChunk(2, 3, "Instrument comparison: the Rapid Letter Naming "
                "Screener (RLNS) takes approximately 4 minutes per student and flagged "
                "9 percent of the same cohort as at-risk, a notably smaller flagged group."),
            ControlledChunk(3, 4, "Instrument comparison: the Comprehensive Early Literacy "
                "Battery (CELB) takes approximately 25 minutes per student and flagged "
                "12 percent of the cohort, with the highest reported agreement with later "
                "first-grade reading outcomes among the three tools."),
            ControlledChunk(4, 5, "Implementation guidance: the report recommends CELB for "
                "students already flagged by a faster tier-one screener (PAS or RLNS), "
                "rather than administering CELB to every kindergartner given its length."),
            ControlledChunk(5, 6, "Summary: no single instrument in this comparison was "
                "judged clearly superior on every dimension — the report frames the choice "
                "as a time-versus-precision tradeoff for districts to weigh."),
        ],
    ),

    # === Topic 8: growth_mindset ===
    ControlledDocument(
        document_id="rc-doc-growth-mindset-study",
        source_filename="growth-mindset-intervention-effects.pdf",
        title="Growth Mindset Interventions: Effects on Academic Achievement",
        document_type="journal_article", journal_quartile="Q2",
        authors=["C. Bergstrom", "F. Nwosu"], publication_year=2020, topic="growth_mindset",
        chunks=[
            ControlledChunk(0, 1, "Introduction: this study tests whether a brief (two "
                "45-minute session) growth-mindset intervention affects semester GPA "
                "among ninth-grade students transitioning to high school."),
            ControlledChunk(1, 2, "Literature review: growth-mindset intervention effects "
                "in the broader literature have been inconsistent, with some large-scale "
                "replications finding small or null effects despite earlier promising "
                "smaller studies."),
            ControlledChunk(2, 3, "Methods: 1,204 incoming ninth-grade students across 11 "
                "high schools were randomly assigned to the growth-mindset intervention "
                "(n=603) or a study-skills control intervention of equal length (n=601)."),
            ControlledChunk(3, 4, "Results: the intervention group's semester GPA "
                "(mean 2.81) did not differ significantly from the control group's "
                "(mean 2.77), p=0.34 — a null result for the overall sample."),
            ControlledChunk(4, 5, "Results (subgroup): among students entering with a "
                "prior GPA below 2.0, the intervention group showed a small but "
                "statistically significant GPA advantage (+0.18) over the control group."),
            ControlledChunk(5, 6, "Discussion: the authors describe this as a "
                "'null-on-average, positive-for-a-subgroup' pattern consistent with some "
                "recent large replication studies, and caution against overgeneralizing "
                "growth-mindset effects to all students."),
            ControlledChunk(6, 7, "Limitations: GPA is an imprecise outcome measure "
                "affected by many factors unrelated to mindset; the study did not have "
                "access to standardized test scores as a secondary outcome."),
        ],
    ),
    ControlledDocument(
        document_id="rc-doc-growth-mindset-language-guide",
        source_filename="growth-mindset-classroom-language.pdf",
        title="A Classroom Guide to Growth Mindset Language",
        document_type="practitioner_article", journal_quartile=None,
        authors=["T. Okonkwo-Reyes"], publication_year=2019, topic="growth_mindset",
        chunks=[
            ControlledChunk(0, 1, "Overview: this guide focuses narrowly on the specific "
                "praise and feedback language teachers use, distinct from formal "
                "mindset-intervention curricula."),
            ControlledChunk(1, 2, "Core concept: 'process praise' (praising strategy and "
                "effort, e.g. 'you tried a new approach when the first one didn't work') "
                "is recommended over 'person praise' (e.g. 'you're so smart')."),
            ControlledChunk(2, 3, "Core concept: the guide recommends normalizing struggle "
                "explicitly — naming that confusion is a normal part of learning something "
                "new, not a sign a student lacks ability."),
            ControlledChunk(3, 4, "Implementation guidance: the guide suggests teachers "
                "audit a recorded lesson for their own praise language before attempting "
                "to change it, since most teachers underestimate how often they use "
                "person praise."),
            ControlledChunk(4, 5, "Common pitfalls: telling a struggling student 'just try "
                "harder' without naming a concrete strategy is identified as an ineffective, "
                "sometimes counterproductive, mindset message."),
            ControlledChunk(5, 6, "Summary: this guide makes no claims about GPA or "
                "test-score effects — it is scoped to classroom language practices only."),
        ],
    ),

    # === Topic 9: executive_function ===
    ControlledDocument(
        document_id="rc-doc-executive-function-training-study",
        source_filename="executive-function-training-outcomes.pdf",
        title="Executive Function Training and Academic Outcomes in Elementary Students",
        document_type="journal_article", journal_quartile="Q1",
        authors=["V. Talbot", "S. Nakagawa"], publication_year=2021, topic="executive_function",
        chunks=[
            ControlledChunk(0, 1, "Introduction: this study tests whether a computerized "
                "working-memory training program improves math achievement in second and "
                "third grade beyond its direct effect on working-memory task scores."),
            ControlledChunk(1, 2, "Literature review: working-memory training reliably "
                "improves performance on similar working-memory tasks ('near transfer') "
                "but evidence for 'far transfer' to academic achievement has been weaker "
                "and more contested."),
            ControlledChunk(2, 3, "Methods: 218 second- and third-grade students completed "
                "either 20 sessions of adaptive working-memory training (n=110) or a "
                "placebo computer game of similar duration (n=108) over eight weeks."),
            ControlledChunk(3, 4, "Results (near transfer): the training group showed large "
                "gains on the trained working-memory task (d=0.81) relative to the placebo "
                "group, confirming the training itself was effective."),
            ControlledChunk(4, 5, "Results (far transfer): math achievement scores did not "
                "differ significantly between groups eight weeks post-training (p=0.52), "
                "showing no evidence of transfer to math performance."),
            ControlledChunk(5, 6, "Discussion: the authors conclude working-memory training "
                "improves working memory itself but do not find evidence it improves "
                "academic achievement, consistent with several recent skeptical reviews."),
            ControlledChunk(6, 7, "Limitations: the eight-week follow-up may be too short "
                "to detect a delayed academic transfer effect, if one exists."),
        ],
    ),
    ControlledDocument(
        document_id="rc-doc-executive-function-screening-report",
        source_filename="executive-function-screening-comparison.pdf",
        title="Executive Function Screening Instruments: A Comparison",
        document_type="report", journal_quartile=None,
        authors=["Regional Psychoeducational Services (fictional)"],
        publication_year=2022, topic="executive_function",
        chunks=[
            ControlledChunk(0, 1, "Overview: this report compares two commonly used "
                "classroom-based executive-function screening instruments: the Behavior "
                "Rating Inventory Short Form (BRI-SF) and the Classroom Executive "
                "Function Checklist (CEFC)."),
            ControlledChunk(1, 2, "Instrument comparison: BRI-SF is a 20-item teacher-rated "
                "checklist taking approximately 10 minutes per student to complete, "
                "covering inhibition, working memory, and shifting."),
            ControlledChunk(2, 3, "Instrument comparison: CEFC is a 35-item teacher-rated "
                "checklist taking approximately 18 minutes per student, additionally "
                "covering planning and emotional control subscales not in BRI-SF."),
            ControlledChunk(3, 4, "Findings: in this district's pilot, BRI-SF and CEFC "
                "identified overlapping but not identical groups of students as at-risk — "
                "68 percent of students flagged by either tool were flagged by both."),
            ControlledChunk(4, 5, "Implementation guidance: the report recommends CEFC "
                "when planning and emotional-control concerns are part of the referral "
                "question, and BRI-SF when time efficiency is the priority."),
            ControlledChunk(5, 6, "Summary: this report makes no claim that either "
                "instrument predicts long-term academic outcomes — it is scoped to "
                "screening-instrument comparison only."),
        ],
    ),

    # === Topic 10: multilingual_learners ===
    ControlledDocument(
        document_id="rc-doc-academic-vocabulary-study",
        source_filename="academic-vocabulary-multilingual-learners.pdf",
        title="Academic Vocabulary Development in Multilingual Learners",
        document_type="journal_article", journal_quartile="Q2",
        authors=["I. Petrosyan", "M. Villareal"],
        publication_year=2022, topic="multilingual_learners",
        chunks=[
            ControlledChunk(0, 1, "Introduction: this study examines whether explicit, "
                "cross-linguistic academic vocabulary instruction (teaching cognates "
                "between English and Spanish) accelerates vocabulary growth for Spanish- "
                "speaking multilingual learners in grades 4-5."),
            ControlledChunk(1, 2, "Literature review: cognate awareness has shown promise "
                "in prior smaller studies, though effects appear to depend heavily on "
                "students' Spanish literacy level, which is inconsistently measured "
                "across the literature."),
            ControlledChunk(2, 3, "Methods: 167 Spanish-speaking multilingual learners in "
                "grades 4-5 received either 12 weeks of explicit cognate-based vocabulary "
                "instruction (n=84) or the standard English-only vocabulary curriculum "
                "(n=83)."),
            ControlledChunk(3, 4, "Results: the cognate-instruction group's academic "
                "vocabulary assessment scores increased by an average of 11.3 points "
                "(out of 50), compared to 6.1 points in the standard-curriculum group."),
            ControlledChunk(4, 5, "Results (moderator): the vocabulary gain was "
                "significantly larger for students with higher Spanish literacy at "
                "baseline, suggesting cognate instruction requires some existing "
                "Spanish print exposure to be maximally effective."),
            ControlledChunk(5, 6, "Discussion: the authors argue cognate-based instruction "
                "is a low-cost addition to existing vocabulary curricula, though its "
                "benefit may not generalize to students with limited first-language "
                "literacy."),
            ControlledChunk(6, 7, "Limitations: the study only examined Spanish-English "
                "cognates; the authors explicitly caution the findings may not generalize "
                "to language pairs with fewer cognates, such as English and Korean."),
        ],
    ),
    ControlledDocument(
        document_id="rc-doc-translanguaging-guide",
        source_filename="translanguaging-content-area-strategies.pdf",
        title="Translanguaging Strategies for Content-Area Instruction",
        document_type="practitioner_article", journal_quartile=None,
        authors=["B. Choi"], publication_year=2021, topic="multilingual_learners",
        chunks=[
            ControlledChunk(0, 1, "Overview: translanguaging treats a multilingual "
                "learner's full linguistic repertoire as a resource for content learning, "
                "rather than treating the home language as something to suppress during "
                "English content instruction."),
            ControlledChunk(1, 2, "Core concept: a 'translanguaging space' is a planned "
                "moment in a lesson (e.g. partner discussion) where students may use any "
                "language to process content before producing an English response."),
            ControlledChunk(2, 3, "Core concept: this guide distinguishes translanguaging "
                "from simple translation — translanguaging is about strategic, planned "
                "use of multiple languages for thinking, not word-for-word conversion of "
                "materials."),
            ControlledChunk(3, 4, "Implementation guidance: teachers who do not speak a "
                "student's home language are encouraged to use translanguaging strategies "
                "anyway, using peer collaboration and student home-language notes rather "
                "than requiring teacher fluency."),
            ControlledChunk(4, 5, "Common pitfalls: allowing home-language use only during "
                "informal moments (never during assessed work) is identified as sending "
                "students a message that their home language is not academically valuable."),
            ControlledChunk(5, 6, "Summary: this guide is a strategy handbook, not a "
                "research study — it reports no effect sizes or outcome data of its own."),
        ],
    ),
]

DOCUMENTS_BY_ID: dict[str, ControlledDocument] = {d.document_id: d for d in REALISTIC_DOCUMENTS}


def _cid(document_id: str, chunk_index: int) -> str:
    return DOCUMENTS_BY_ID[document_id].chunk_id(chunk_index)


# document_id shorthands
_PHONICS = "rc-doc-phonics-rct"
_BALANCED_LIT = "rc-doc-balanced-literacy-review"
_ADAPTIVE = "rc-doc-adaptive-learning-study"
_XAI_CURRICULUM = "rc-doc-explainable-ai-curriculum"
_FORMATIVE = "rc-doc-formative-assessment-study"
_EXIT_TICKETS = "rc-doc-exit-tickets-guide"
_SPACED_META = "rc-doc-spaced-repetition-meta"
_SPACED_CLASSROOM = "rc-doc-spaced-practice-classroom"
_PBL_STUDY = "rc-doc-pbl-stem-study"
_DRIVING_Q = "rc-doc-driving-questions-guide"
_UDL_STUDY = "rc-doc-udl-implementation-study"
_UDL_POLICY = "rc-doc-udl-multilingual-policy"
_DYSLEXIA_STUDY = "rc-doc-dyslexia-structured-literacy-study"
_DYSLEXIA_SCREEN = "rc-doc-dyslexia-screening-tools"
_GROWTH_STUDY = "rc-doc-growth-mindset-study"
_GROWTH_GUIDE = "rc-doc-growth-mindset-language-guide"
_EF_STUDY = "rc-doc-executive-function-training-study"
_EF_SCREEN = "rc-doc-executive-function-screening-report"
_VOCAB_STUDY = "rc-doc-academic-vocabulary-study"
_TRANSLANG = "rc-doc-translanguaging-guide"


# ---------------------------------------------------------------------------
# General-mode (non-Zoom-In) cases: 30 answerable + 34 hard-negative = 64
# ---------------------------------------------------------------------------

REALISTIC_CASES: list[EvalCase] = [
    # === Answerable (§6 types, 2 each + 2 extra = 30) ===
    EvalCase(case_id="RC-ET01", category="exact_terminology", topic="reading_science",
        query="How many kindergarten students participated in the systematic phonics randomized "
            "trial?",
        expected_document_ids=[_PHONICS], expected_chunk_ids=[_cid(_PHONICS, 2)]),
    EvalCase(case_id="RC-ET02", category="exact_terminology", topic="dyslexia_intervention",
        query="What percentage of the district's kindergarten cohort did the Phonological "
            "Awareness Screener flag as at-risk?",
        expected_document_ids=[_DYSLEXIA_SCREEN], expected_chunk_ids=[_cid(_DYSLEXIA_SCREEN, 1)]),
    EvalCase(case_id="RC-PA01", category="paraphrase", topic="growth_mindset",
        query="Did the guide recommend praising a student's approach over praising how smart "
            "they are?",
        expected_document_ids=[_GROWTH_GUIDE], expected_chunk_ids=[_cid(_GROWTH_GUIDE, 1)],
        notes="Paraphrases 'process praise... over person praise.'"),
    EvalCase(case_id="RC-PA02", category="paraphrase", topic="udl_accessibility",
        query="Does giving students key words in their native tongue ahead of a lesson count as "
            "a UDL strategy for English learners?",
        expected_document_ids=[_UDL_POLICY], expected_chunk_ids=[_cid(_UDL_POLICY, 1)],
        notes="Paraphrases 'vocabulary in both English and home language before a lesson.'"),
    EvalCase(case_id="RC-NF01", category="numerical_fact", topic="dyslexia_intervention",
        query="What was the effect size (Cohen's d) for the structured literacy dyslexia "
            "intervention's decoding gains?",
        expected_document_ids=[_DYSLEXIA_STUDY], expected_chunk_ids=[_cid(_DYSLEXIA_STUDY, 3)]),
    EvalCase(case_id="RC-NF02", category="numerical_fact", topic="dyslexia_intervention",
        query="By how many standard-score points did the structured literacy intervention "
            "group's decoding improve on average?",
        expected_document_ids=[_DYSLEXIA_STUDY], expected_chunk_ids=[_cid(_DYSLEXIA_STUDY, 3)]),
    EvalCase(case_id="RC-NF03", category="numerical_fact", topic="ai_education",
        query="How much did unit-test scores increase in the adaptive learning study's math "
            "achievement results?",
        expected_document_ids=[_ADAPTIVE], expected_chunk_ids=[_cid(_ADAPTIVE, 4)]),
    EvalCase(case_id="RC-DEF01", category="definition", topic="project_based_learning",
        query="What is a 'driving question' in project-based learning?",
        expected_document_ids=[_DRIVING_Q], expected_chunk_ids=[_cid(_DRIVING_Q, 0)]),
    EvalCase(case_id="RC-DEF02", category="definition", topic="ai_education",
        query="What is 'training data' according to the explainable AI curriculum?",
        expected_document_ids=[_XAI_CURRICULUM], expected_chunk_ids=[_cid(_XAI_CURRICULUM, 1)]),
    EvalCase(case_id="RC-MQ01", category="methodology_question", topic="growth_mindset",
        query="How long was the growth-mindset intervention tested in the ninth-grade GPA study?",
        expected_document_ids=[_GROWTH_STUDY], expected_chunk_ids=[_cid(_GROWTH_STUDY, 0)]),
    EvalCase(case_id="RC-MQ02", category="methodology_question", topic="dyslexia_intervention",
        query="How many weeks did the structured literacy intervention for at-risk third "
            "graders last?",
        expected_document_ids=[_DYSLEXIA_STUDY], expected_chunk_ids=[_cid(_DYSLEXIA_STUDY, 0)]),
    EvalCase(case_id="RC-RI01", category="result_interpretation", topic="ai_education",
        query="What did the adaptive learning study conclude was responsible for the engagement "
            "gain?",
        expected_document_ids=[_ADAPTIVE], expected_chunk_ids=[_cid(_ADAPTIVE, 5)]),
    EvalCase(case_id="RC-RI02", category="result_interpretation", topic="formative_assessment",
        query="How did the formative-assessment study's authors explain why daily checks "
            "improved outcomes?",
        expected_document_ids=[_FORMATIVE], expected_chunk_ids=[_cid(_FORMATIVE, 5)]),
    EvalCase(case_id="RC-SS01", category="section_specific", topic="executive_function",
        query="What limitation did the authors note about the working-memory training study's "
            "follow-up period?",
        expected_document_ids=[_EF_STUDY], expected_chunk_ids=[_cid(_EF_STUDY, 6)]),
    EvalCase(case_id="RC-SS02", category="section_specific", topic="project_based_learning",
        query="What limitation did the PBL STEM study report regarding teacher experience?",
        expected_document_ids=[_PBL_STUDY], expected_chunk_ids=[_cid(_PBL_STUDY, 6)]),
    EvalCase(case_id="RC-SS03", category="section_specific", topic="udl_accessibility",
        query="What did the UDL implementation study's discussion section say about the "
            "relationship between participation gains and test-score gains?",
        expected_document_ids=[_UDL_STUDY], expected_chunk_ids=[_cid(_UDL_STUDY, 5)]),
    EvalCase(case_id="RC-AC01", category="acronym", topic="dyslexia_intervention",
        query="What does PAS stand for in the district's screening report?",
        expected_document_ids=[_DYSLEXIA_SCREEN], expected_chunk_ids=[_cid(_DYSLEXIA_SCREEN, 1)]),
    EvalCase(case_id="RC-AC02", category="acronym", topic="dyslexia_intervention",
        query="What does CELB stand for in the district's screening report?",
        expected_document_ids=[_DYSLEXIA_SCREEN], expected_chunk_ids=[_cid(_DYSLEXIA_SCREEN, 3)]),
    EvalCase(case_id="RC-CD01", category="cross_document", topic="multi",
        query="Compare the effect on student engagement/motivation between adaptive learning "
            "platforms and project-based learning, according to their respective studies.",
        expected_document_ids=[_ADAPTIVE, _PBL_STUDY], require_all_documents=True),
    EvalCase(case_id="RC-CD02", category="cross_document", topic="multi",
        query="Compare the sample sizes of the growth-mindset GPA study and the working-memory "
            "training study.",
        expected_document_ids=[_GROWTH_STUDY, _EF_STUDY], require_all_documents=True),
    EvalCase(case_id="RC-CMS01", category="comparison_multi_section", topic="executive_function",
        query="How do the near-transfer and far-transfer results differ in the executive "
            "function training study?",
        expected_document_ids=[_EF_STUDY],
        expected_chunk_ids=[_cid(_EF_STUDY, 3), _cid(_EF_STUDY, 4)],
        notes="Requires both the near-transfer (chunk3) and far-transfer (chunk4) results chunks."),
    EvalCase(case_id="RC-CMS02", category="comparison_multi_section", topic="reading_science",
        query="Compare the decoding results and comprehension results in the phonics randomized "
            "trial.",
        expected_document_ids=[_PHONICS],
        expected_chunk_ids=[_cid(_PHONICS, 4), _cid(_PHONICS, 5)]),
    EvalCase(case_id="RC-SYN01", category="synthesis_multi_document", topic="multi",
        query="Synthesize what the spaced-repetition meta-analysis and the classroom "
            "spaced-practice guide together suggest about implementing spacing in real "
            "classrooms.",
        expected_document_ids=[_SPACED_META, _SPACED_CLASSROOM], require_all_documents=True),
    EvalCase(case_id="RC-SYN02", category="synthesis_multi_document", topic="multi",
        query="Synthesize the phonics randomized trial, the dyslexia structured-literacy study, "
            "and the balanced-literacy review regarding explicit, systematic instruction.",
        expected_document_ids=[_PHONICS, _DYSLEXIA_STUDY, _BALANCED_LIT],
        require_all_documents=True,
        notes="Requires evidence from all three documents (2-document synthesis is RC-SYN01; "
            "this is the 3+-document variant)."),
    EvalCase(case_id="RC-ND01", category="near_duplicate", topic="spaced_repetition",
        query="According to the classroom implementation guide (not the meta-analysis), what "
            "should teachers track to manage a spacing schedule?",
        expected_document_ids=[_SPACED_CLASSROOM], expected_chunk_ids=[_cid(_SPACED_CLASSROOM, 3)],
        notes="Discriminates between the two same-topic documents (study vs. guide)."),
    EvalCase(case_id="RC-ND02", category="near_duplicate", topic="growth_mindset",
        query="According to the classroom language guide (not the GPA study), what specific "
            "praise language is recommended?",
        expected_document_ids=[_GROWTH_GUIDE], expected_chunk_ids=[_cid(_GROWTH_GUIDE, 1)]),
    EvalCase(case_id="RC-DH01", category="distractor_heavy", topic="reading_science",
        query="What score gain did the systematic phonics group show on the end-of-year "
            "nonsense-word decoding measure?",
        expected_document_ids=[_PHONICS], expected_chunk_ids=[_cid(_PHONICS, 4)],
        notes="Distractor: the dyslexia study also reports decoding gains, on a different "
            "measure/study."),
    EvalCase(case_id="RC-DH02", category="distractor_heavy", topic="executive_function",
        query="What executive-function subscales does CEFC cover that BRI-SF does not?",
        expected_document_ids=[_EF_SCREEN], expected_chunk_ids=[_cid(_EF_SCREEN, 2)],
        notes="Distractor: easy to confuse which of the two same-report instruments covers "
            "which subscales."),
    EvalCase(case_id="RC-CIT01", category="citation_sensitive", topic="ai_education",
        query="Which specific study reported that voluntary practice sessions increased by 34 "
            "percent?",
        expected_document_ids=[_ADAPTIVE], expected_chunk_ids=[_cid(_ADAPTIVE, 3)]),
    EvalCase(case_id="RC-CIT02", category="citation_sensitive", topic="spaced_repetition",
        query="According to the meta-analysis (not the classroom guide), what was the pooled "
            "effect size for spaced practice on retention?",
        expected_document_ids=[_SPACED_META], expected_chunk_ids=[_cid(_SPACED_META, 3)],
        notes="Requires citing the correct one of two same-topic documents."),

    # === Hard negatives (§7 types, 2 each = 34) ===
    EvalCase(case_id="RC-WN01", category="wrong_numerical_detail", topic="spaced_repetition",
        answerable=False,
        query="What was the median (not mean pooled) effect size reported in the "
            "spaced-repetition meta-analysis?",
        notes="The meta-analysis reports a pooled MEAN effect size (d=0.62), never a median."),
    EvalCase(case_id="RC-WN02", category="wrong_numerical_detail", topic="growth_mindset",
        answerable=False,
        query="What was the median (not mean) GPA improvement in the growth-mindset subgroup "
            "analysis?",
        notes="The study reports a MEAN subgroup improvement (+0.18), never a median."),
    EvalCase(case_id="RC-NEG01", category="negation_contradiction", topic="executive_function",
        answerable=False,
        query="How much did math achievement improve as a result of working-memory training?",
        notes="chunk4 explicitly reports NO significant far-transfer difference — presupposes "
            "an improvement that was not found."),
    EvalCase(case_id="RC-NEG02", category="negation_contradiction", topic="project_based_learning",
        answerable=False,
        query="How much did content-standard mastery improve under project-based learning "
            "compared to traditional instruction?",
        notes="chunk3 explicitly reports NO significant difference in mastery."),
    EvalCase(case_id="RC-ENT01", category="entity_confusion", topic="executive_function",
        answerable=False,
        query="What did the CEFC screening report find about long-term academic outcome "
            "prediction?",
        notes="chunk5 explicitly states the report makes no claim about long-term academic "
            "outcomes; easily confused with the unrelated dyslexia-screening report's own "
            "instrument comparison."),
    EvalCase(case_id="RC-ENT02", category="entity_confusion", topic="multilingual_learners",
        answerable=False,
        query="What GPA gain did the translanguaging guide report for multilingual learners?",
        notes="chunk5 explicitly states the guide reports no effect sizes/outcome data; "
            "confusable with the actual vocabulary study on the same broader topic."),
    EvalCase(case_id="RC-SND01", category="semantic_neighbor_distractor",
        topic="formative_assessment",
        answerable=False,
        query="What coaching technique did the exit-tickets guide recommend for teachers "
            "learning growth-mindset language?",
        notes="Semantically close (both practitioner guides about classroom practice) but "
            "exit-tickets guide never discusses growth-mindset language."),
    EvalCase(case_id="RC-SND02", category="semantic_neighbor_distractor", topic="udl_accessibility",
        answerable=False,
        query="What spacing schedule does the UDL multilingual policy recommend for reviewing "
            "vocabulary?",
        notes="Semantically adjacent ('guide', 'schedule') but the UDL policy never discusses "
            "spaced review at all."),
    EvalCase(case_id="RC-RTA01", category="related_topic_absent", topic="udl_accessibility",
        answerable=False,
        query="What percentage of teachers successfully implemented UDL redesign without any "
            "additional training?",
        notes="UDL implementation study is topically related but never reports a "
            "no-training-needed success percentage."),
    EvalCase(case_id="RC-RTA02", category="related_topic_absent", topic="project_based_learning",
        answerable=False,
        query="How much did teacher salaries increase after adopting project-based-learning "
            "curricula?",
        notes="Both PBL documents are topically related but neither discusses teacher salary."),
    EvalCase(case_id="RC-PE01", category="partial_evidence", topic="spaced_repetition",
        answerable=False,
        query="What was the pooled effect size of spaced practice, and what were the exact "
            "publication years of every included study?",
        notes="Effect size is answerable (d=0.62); per-study publication years are never "
            "individually listed (only the 1990-2019 range)."),
    EvalCase(case_id="RC-PE02", category="partial_evidence", topic="udl_accessibility",
        answerable=False,
        query="What was the sample size of the UDL implementation study, and what was its "
            "statistically significant achievement effect?",
        notes="Sample size is answerable (n=376); the achievement effect was explicitly NOT "
            "statistically significant (p=0.18)."),
    EvalCase(case_id="RC-CDI01", category="cross_document_incomplete", topic="multi",
        answerable=False,
        query="Compare the achievement effect of UDL redesign to the achievement effect of "
            "translanguaging strategies.",
        notes="UDL side has data (p=0.18, ns); translanguaging guide explicitly reports no "
            "effect sizes/outcome data at all."),
    EvalCase(case_id="RC-CDI02", category="cross_document_incomplete", topic="multi",
        answerable=False,
        query="Compare the exact GPA improvement from growth-mindset intervention to the exact "
            "GPA improvement from translanguaging strategies.",
        notes="Growth mindset has a subgroup number (+0.18); translanguaging has no outcome "
            "numbers at all."),
    EvalCase(case_id="RC-AA01", category="acronym_ambiguity", topic="dyslexia_intervention",
        answerable=False,
        query="What does PAS mean in a medical/clinical context, not education screening?",
        notes="The corpus only defines PAS as 'Phonological Awareness Screener' — no "
            "clinical-context definition exists."),
    EvalCase(case_id="RC-AA02", category="acronym_ambiguity", topic="dyslexia_intervention",
        answerable=False,
        query="What does CELB stand for in a corporate training context, not K-12 screening?",
        notes="CELB is only defined as 'Comprehensive Early Literacy Battery' — no "
            "corporate-context definition exists."),
    EvalCase(case_id="RC-SM01", category="section_mismatch", topic="dyslexia_intervention",
        answerable=False,
        query="What statistical test did the dyslexia structured-literacy study use to compute "
            "significance?",
        notes="The study has Methods/Results/Discussion/Limitations chunks but never names a "
            "specific statistical test."),
    EvalCase(case_id="RC-SM02", category="section_mismatch", topic="reading_science",
        answerable=False,
        query="What was the exact age range, in months, of participants in the phonics "
            "randomized trial?",
        notes="The study specifies 'kindergarten students' (a grade level) but never gives an "
            "age range in months."),
    EvalCase(case_id="RC-WPS01", category="wrong_population_sample", topic="dyslexia_intervention",
        answerable=False,
        query="What were the results of the structured literacy intervention when tested on "
            "high-school students?",
        notes="The study is specifically about third-grade students; no high-school population "
            "was studied."),
    EvalCase(case_id="RC-WPS02", category="wrong_population_sample", topic="growth_mindset",
        answerable=False,
        query="What did the growth-mindset study find for elementary-school students' GPA?",
        notes="The study is specifically about incoming ninth-grade students; no elementary "
            "population was studied."),
    EvalCase(case_id="RC-WM01", category="wrong_methodology", topic="udl_accessibility",
        answerable=False,
        query="What did the qualitative interview data reveal about teacher experiences "
            "implementing UDL?",
        notes="The UDL study used classroom observation checklists, not qualitative interviews "
            "— no interview data exists."),
    EvalCase(case_id="RC-WM02", category="wrong_methodology", topic="executive_function",
        answerable=False,
        query="What did the randomized controlled trial design reveal about executive-function "
            "screening instrument agreement?",
        notes="The EF screening report is a district pilot comparison (observational), not an "
            "RCT."),
    EvalCase(case_id="RC-WDY01", category="wrong_date_year", topic="reading_science",
        answerable=False,
        query="What did the 2015 study find about systematic phonics instruction effect sizes?",
        notes="The phonics RCT in this corpus was published in 2022; no 2015 study exists on "
            "this exact topic."),
    EvalCase(case_id="RC-WDY02", category="wrong_date_year", topic="spaced_repetition",
        answerable=False,
        query="What did the 2010 meta-analysis conclude about spaced repetition?",
        notes="The actual meta-analysis was published in 2021; no 2010 meta-analysis exists in "
            "the corpus."),
    EvalCase(case_id="RC-WCC01", category="wrong_causal_claim", topic="executive_function",
        answerable=False,
        query="What causal mechanism did the working-memory training study prove explains why "
            "far transfer failed?",
        notes="The study reports a null far-transfer result and offers no proven causal "
            "mechanism for why it failed."),
    EvalCase(case_id="RC-WCC02", category="wrong_causal_claim", topic="formative_assessment",
        answerable=False,
        query="What did the formative-assessment study prove causes the achievement gap to "
            "narrow, beyond correlation?",
        notes="chunk5 offers an interpretation (faster teacher response); chunk6 notes teachers "
            "weren't blinded and got extra planning time, undermining a strict causal proof "
            "claim."),
    EvalCase(case_id="RC-CC01", category="correlation_causation_confusion", topic="ai_education",
        answerable=False,
        query="Does higher engagement in the adaptive learning study prove that adaptive "
            "difficulty causes higher math achievement?",
        notes="The study reports both outcomes but never establishes engagement causes "
            "achievement — an association, not a proven causal chain."),
    EvalCase(case_id="RC-CC02", category="correlation_causation_confusion",
        topic="multilingual_learners",
        answerable=False,
        query="Does the correlation between Spanish literacy level and vocabulary gains prove "
            "that improving Spanish literacy causes larger English vocabulary gains?",
        notes="chunk4 reports an association (moderator finding), never a causal claim."),
    EvalCase(case_id="RC-CS01", category="claim_stronger_than_source", topic="growth_mindset",
        answerable=False,
        query="Does the growth-mindset study prove that mindset interventions never work for "
            "any student?",
        notes="The study found a null AVERAGE effect but a positive effect for a low-GPA "
            "subgroup — 'never works for any student' overstates the finding."),
    EvalCase(case_id="RC-CS02", category="claim_stronger_than_source",
        topic="project_based_learning",
        answerable=False,
        query="Does the PBL STEM study prove that project-based learning is always worse than "
            "traditional instruction?",
        notes="The study found no significant difference in mastery (not 'worse') and found PBL "
            "better for motivation."),
    EvalCase(case_id="RC-PNS01", category="presupposition_not_stated", topic="executive_function",
        answerable=False,
        query="Given that the district adopted BRI-SF as their sole screening tool, what were "
            "the results?",
        notes="The EF screening report never states any single instrument was adopted as a sole "
            "tool — it is a comparison report only."),
    EvalCase(case_id="RC-PNS02", category="presupposition_not_stated", topic="spaced_repetition",
        answerable=False,
        query="Given that all 41 studies in the spaced-repetition meta-analysis used K-12 "
            "samples, what grade levels benefited most?",
        notes="chunk6 explicitly states fewer than 15 percent of the pooled studies were K-12 "
            "classroom settings — the presupposition is false."),
    EvalCase(case_id="RC-CNC01", category="concept_not_conclusion", topic="ai_education",
        answerable=False,
        query="What conclusion did the explainable-AI curriculum draw about whether AI bias can "
            "be fully eliminated from classroom AI tools?",
        notes="The curriculum discusses the CONCEPT of algorithmic bias but never draws a "
            "conclusion about eliminating it."),
    EvalCase(case_id="RC-CNC02", category="concept_not_conclusion", topic="multilingual_learners",
        answerable=False,
        query="What conclusion did the translanguaging guide draw about standardized test-score "
            "improvements?",
        notes="The guide discusses the CONCEPT of translanguaging spaces but explicitly reports "
            "no effect sizes or outcome data."),
]

assert {c.category for c in REALISTIC_CASES} <= set(CATEGORIES), (
    "every case's category must be registered in controlled_corpus.CATEGORIES"
)


# ---------------------------------------------------------------------------
# Zoom-In cases: 20 positive (selected scope contains the answer) + 20
# negative (selected scope lacks it) — Milestone 5.7 §8, a materially larger
# sample than Milestone 5.6's 1-positive/7-negative set. Positives mostly
# reuse REALISTIC_CASES' own queries/expected_document_ids as their scope
# (legitimate reuse: the same fact, now evaluated under a Zoom-In lens);
# negatives pair a real, answerable-elsewhere query with a deliberately
# wrong/incomplete scope selection.
# ---------------------------------------------------------------------------

ZOOM_IN_CASES: list[EvalCase] = [
    # --- 20 positive (scope_contains_answer=True) ---
    EvalCase(case_id="RCZ-P01", category="zoom_in_absent_elsewhere_present",
        topic="reading_science",
        query="How many kindergarten students participated in the systematic phonics randomized "
            "trial?",
        expected_document_ids=[_PHONICS], expected_chunk_ids=[_cid(_PHONICS, 2)],
        scope_document_ids=[_PHONICS], scope_contains_answer=True),
    EvalCase(case_id="RCZ-P02", category="zoom_in_absent_elsewhere_present",
        topic="dyslexia_intervention",
        query="What percentage of the district's kindergarten cohort did the Phonological "
            "Awareness Screener flag as at-risk?",
        expected_document_ids=[_DYSLEXIA_SCREEN], expected_chunk_ids=[_cid(_DYSLEXIA_SCREEN, 1)],
        scope_document_ids=[_DYSLEXIA_SCREEN], scope_contains_answer=True),
    EvalCase(case_id="RCZ-P03", category="zoom_in_absent_elsewhere_present", topic="growth_mindset",
        query="Did the guide recommend praising a student's approach over praising how smart "
            "they are?",
        expected_document_ids=[_GROWTH_GUIDE], expected_chunk_ids=[_cid(_GROWTH_GUIDE, 1)],
        scope_document_ids=[_GROWTH_GUIDE], scope_contains_answer=True),
    EvalCase(case_id="RCZ-P04", category="zoom_in_absent_elsewhere_present",
        topic="dyslexia_intervention",
        query="What was the effect size (Cohen's d) for the structured literacy dyslexia "
            "intervention's decoding gains?",
        expected_document_ids=[_DYSLEXIA_STUDY], expected_chunk_ids=[_cid(_DYSLEXIA_STUDY, 3)],
        scope_document_ids=[_DYSLEXIA_STUDY], scope_contains_answer=True),
    EvalCase(case_id="RCZ-P05", category="zoom_in_absent_elsewhere_present",
        topic="project_based_learning",
        query="What is a 'driving question' in project-based learning?",
        expected_document_ids=[_DRIVING_Q], expected_chunk_ids=[_cid(_DRIVING_Q, 0)],
        scope_document_ids=[_DRIVING_Q], scope_contains_answer=True),
    EvalCase(case_id="RCZ-P06", category="zoom_in_absent_elsewhere_present", topic="ai_education",
        query="What is 'training data' according to the explainable AI curriculum?",
        expected_document_ids=[_XAI_CURRICULUM], expected_chunk_ids=[_cid(_XAI_CURRICULUM, 1)],
        scope_document_ids=[_XAI_CURRICULUM], scope_contains_answer=True),
    EvalCase(case_id="RCZ-P07", category="zoom_in_absent_elsewhere_present", topic="growth_mindset",
        query="How long was the growth-mindset intervention tested in the ninth-grade GPA study?",
        expected_document_ids=[_GROWTH_STUDY], expected_chunk_ids=[_cid(_GROWTH_STUDY, 0)],
        scope_document_ids=[_GROWTH_STUDY], scope_contains_answer=True),
    EvalCase(case_id="RCZ-P08", category="zoom_in_absent_elsewhere_present", topic="ai_education",
        query="What did the adaptive learning study conclude was responsible for the engagement "
            "gain?",
        expected_document_ids=[_ADAPTIVE], expected_chunk_ids=[_cid(_ADAPTIVE, 5)],
        scope_document_ids=[_ADAPTIVE], scope_contains_answer=True),
    EvalCase(case_id="RCZ-P09", category="zoom_in_absent_elsewhere_present",
        topic="executive_function",
        query="What limitation did the authors note about the working-memory training study's "
            "follow-up period?",
        expected_document_ids=[_EF_STUDY], expected_chunk_ids=[_cid(_EF_STUDY, 6)],
        scope_document_ids=[_EF_STUDY], scope_contains_answer=True),
    EvalCase(case_id="RCZ-P10", category="zoom_in_absent_elsewhere_present",
        topic="dyslexia_intervention",
        query="What does CELB stand for in the district's screening report?",
        expected_document_ids=[_DYSLEXIA_SCREEN], expected_chunk_ids=[_cid(_DYSLEXIA_SCREEN, 3)],
        scope_document_ids=[_DYSLEXIA_SCREEN], scope_contains_answer=True),
    EvalCase(case_id="RCZ-P11", category="zoom_in_project_absent", topic="multi",
        query="Compare the sample sizes of the growth-mindset GPA study and the working-memory "
            "training study.",
        expected_document_ids=[_GROWTH_STUDY, _EF_STUDY],
        scope_document_ids=[_GROWTH_STUDY, _EF_STUDY], scope_contains_answer=True,
        notes="Both required documents are selected — a positive multi-document Zoom-In case."),
    EvalCase(case_id="RCZ-P12", category="zoom_in_project_absent", topic="multi",
        query="Synthesize what the spaced-repetition meta-analysis and the classroom "
            "spaced-practice guide together suggest about implementing spacing in real "
            "classrooms.",
        expected_document_ids=[_SPACED_META, _SPACED_CLASSROOM],
        scope_document_ids=[_SPACED_META, _SPACED_CLASSROOM], scope_contains_answer=True),
    EvalCase(case_id="RCZ-P13", category="zoom_in_absent_elsewhere_present",
        topic="spaced_repetition",
        query="According to the classroom implementation guide, what should teachers track to "
            "manage a spacing schedule?",
        expected_document_ids=[_SPACED_CLASSROOM], expected_chunk_ids=[_cid(_SPACED_CLASSROOM, 3)],
        scope_document_ids=[_SPACED_CLASSROOM], scope_contains_answer=True),
    EvalCase(case_id="RCZ-P14", category="zoom_in_absent_elsewhere_present",
        topic="executive_function",
        query="What executive-function subscales does CEFC cover that BRI-SF does not?",
        expected_document_ids=[_EF_SCREEN], expected_chunk_ids=[_cid(_EF_SCREEN, 2)],
        scope_document_ids=[_EF_SCREEN], scope_contains_answer=True),
    EvalCase(case_id="RCZ-P15", category="zoom_in_absent_elsewhere_present",
        topic="spaced_repetition",
        query="According to the meta-analysis, what was the pooled effect size for spaced "
            "practice on retention?",
        expected_document_ids=[_SPACED_META], expected_chunk_ids=[_cid(_SPACED_META, 3)],
        scope_document_ids=[_SPACED_META], scope_contains_answer=True),
    EvalCase(case_id="RCZ-P16", category="zoom_in_absent_elsewhere_present",
        topic="udl_accessibility",
        query="What did the UDL implementation study's discussion section say about the "
            "relationship between participation gains and test-score gains?",
        expected_document_ids=[_UDL_STUDY], expected_chunk_ids=[_cid(_UDL_STUDY, 5)],
        scope_document_ids=[_UDL_STUDY], scope_contains_answer=True),
    EvalCase(case_id="RCZ-P17", category="zoom_in_absent_elsewhere_present",
        topic="formative_assessment",
        query="How did the formative-assessment study's authors explain why daily checks "
            "improved outcomes?",
        expected_document_ids=[_FORMATIVE], expected_chunk_ids=[_cid(_FORMATIVE, 5)],
        scope_document_ids=[_FORMATIVE], scope_contains_answer=True),
    EvalCase(case_id="RCZ-P18", category="zoom_in_absent_elsewhere_present",
        topic="multilingual_learners",
        query="What is a 'translanguaging space'?",
        expected_document_ids=[_TRANSLANG], expected_chunk_ids=[_cid(_TRANSLANG, 1)],
        scope_document_ids=[_TRANSLANG], scope_contains_answer=True),
    EvalCase(case_id="RCZ-P19", category="zoom_in_absent_elsewhere_present",
        topic="multilingual_learners",
        query="How much did academic vocabulary assessment scores increase in the "
            "cognate-instruction group?",
        expected_document_ids=[_VOCAB_STUDY], expected_chunk_ids=[_cid(_VOCAB_STUDY, 3)],
        scope_document_ids=[_VOCAB_STUDY], scope_contains_answer=True),
    EvalCase(case_id="RCZ-P20", category="zoom_in_absent_elsewhere_present",
        topic="project_based_learning",
        query="What was the most common driving-question design failure identified by the guide?",
        expected_document_ids=[_DRIVING_Q], expected_chunk_ids=[_cid(_DRIVING_Q, 4)],
        scope_document_ids=[_DRIVING_Q], scope_contains_answer=True),

    # --- 20 negative (scope_contains_answer=False) ---
    EvalCase(case_id="RCZ-N01", category="zoom_in_absent_elsewhere_present",
        topic="reading_science",
        query="How many kindergarten students participated in the systematic phonics randomized "
            "trial?",
        expected_document_ids=[_PHONICS], expected_chunk_ids=[_cid(_PHONICS, 2)],
        scope_document_ids=[_BALANCED_LIT], scope_contains_answer=False,
        notes="Selected A (balanced-literacy review) does not contain the answer; the phonics "
            "RCT does."),
    EvalCase(case_id="RCZ-N02", category="zoom_in_absent_elsewhere_present",
        topic="dyslexia_intervention",
        query="What percentage of the district's kindergarten cohort did the Phonological "
            "Awareness Screener flag as at-risk?",
        expected_document_ids=[_DYSLEXIA_SCREEN], expected_chunk_ids=[_cid(_DYSLEXIA_SCREEN, 1)],
        scope_document_ids=[_DYSLEXIA_STUDY], scope_contains_answer=False,
        notes="Selected A (the intervention study) contains a related concept (dyslexia) but "
            "not the requested screening-percentage fact, which lives in a different document."),
    EvalCase(case_id="RCZ-N03", category="zoom_in_absent_elsewhere_present", topic="growth_mindset",
        query="What specific praise language does the guide recommend over praising intelligence?",
        expected_document_ids=[_GROWTH_GUIDE], expected_chunk_ids=[_cid(_GROWTH_GUIDE, 1)],
        scope_document_ids=[_GROWTH_STUDY], scope_contains_answer=False,
        notes="Selected A (the GPA study) is the wrong document of the topic's two — it never "
            "discusses praise language."),
    EvalCase(case_id="RCZ-N04", category="zoom_in_absent_elsewhere_present",
        topic="dyslexia_intervention",
        query="What was the effect size (Cohen's d) for the structured literacy dyslexia "
            "intervention's decoding gains?",
        expected_document_ids=[_DYSLEXIA_STUDY], expected_chunk_ids=[_cid(_DYSLEXIA_STUDY, 3)],
        scope_document_ids=[_DYSLEXIA_SCREEN], scope_contains_answer=False,
        notes="Selected A (the screening-tools report) is related but never reports an "
            "intervention effect size."),
    EvalCase(case_id="RCZ-N05", category="zoom_in_absent_elsewhere_present",
        topic="project_based_learning",
        query="What is a 'driving question' in project-based learning?",
        expected_document_ids=[_DRIVING_Q], expected_chunk_ids=[_cid(_DRIVING_Q, 0)],
        scope_document_ids=[_PBL_STUDY], scope_contains_answer=False,
        notes="Selected A (the outcomes study) never defines the term; only the design guide "
            "does."),
    EvalCase(case_id="RCZ-N06", category="zoom_in_absent_elsewhere_present", topic="ai_education",
        query="What is 'training data' according to the explainable AI curriculum?",
        expected_document_ids=[_XAI_CURRICULUM], expected_chunk_ids=[_cid(_XAI_CURRICULUM, 1)],
        scope_document_ids=[_ADAPTIVE], scope_contains_answer=False,
        notes="Selected A (the adaptive-learning study) contains a related concept (AI in "
            "education) but never defines training data."),
    EvalCase(case_id="RCZ-N07", category="zoom_in_absent_elsewhere_present", topic="growth_mindset",
        query="How long was the growth-mindset intervention tested in the ninth-grade GPA study?",
        expected_document_ids=[_GROWTH_STUDY], expected_chunk_ids=[_cid(_GROWTH_STUDY, 0)],
        scope_document_ids=[_GROWTH_GUIDE], scope_contains_answer=False,
        notes="Selected A (the language guide) explicitly reports no outcome data — the "
            "intervention length lives in the study, not the guide."),
    EvalCase(case_id="RCZ-N08", category="zoom_in_absent_elsewhere_present", topic="ai_education",
        query="What did the adaptive learning study conclude was responsible for the engagement "
            "gain?",
        expected_document_ids=[_ADAPTIVE], expected_chunk_ids=[_cid(_ADAPTIVE, 5)],
        scope_document_ids=[_XAI_CURRICULUM], scope_contains_answer=False,
        notes="Selected A (the AI curriculum) is a related-topic distractor with no "
            "engagement-study data."),
    EvalCase(case_id="RCZ-N09", category="zoom_in_absent_elsewhere_present",
        topic="executive_function",
        query="What limitation did the authors note about the working-memory training study's "
            "follow-up period?",
        expected_document_ids=[_EF_STUDY], expected_chunk_ids=[_cid(_EF_STUDY, 6)],
        scope_document_ids=[_EF_SCREEN], scope_contains_answer=False,
        notes="Selected A (the screening-instrument report) is a related-but-different document "
            "within the same topic."),
    EvalCase(case_id="RCZ-N10", category="zoom_in_absent_elsewhere_present",
        topic="dyslexia_intervention",
        query="What does CELB stand for?",
        expected_document_ids=[_DYSLEXIA_SCREEN], expected_chunk_ids=[_cid(_DYSLEXIA_SCREEN, 3)],
        scope_document_ids=[_DYSLEXIA_STUDY], scope_contains_answer=False,
        notes="Selected A (the intervention study) never mentions the CELB acronym at all."),
    EvalCase(case_id="RCZ-N11", category="zoom_in_project_absent", topic="multi",
        query="Compare the sample sizes of the growth-mindset GPA study and the working-memory "
            "training study.",
        expected_document_ids=[_GROWTH_STUDY, _EF_STUDY],
        scope_document_ids=[_GROWTH_STUDY], scope_contains_answer=False,
        notes="Only ONE required side (growth-mindset study) is selected — the comparison's "
            "other half (EF study) is outside scope, so the full comparison is not answerable "
            "from scope."),
    EvalCase(case_id="RCZ-N12", category="zoom_in_project_absent", topic="multi",
        query="Synthesize what the spaced-repetition meta-analysis and the classroom "
            "spaced-practice guide together suggest about implementing spacing in real "
            "classrooms.",
        expected_document_ids=[_SPACED_META, _SPACED_CLASSROOM],
        scope_document_ids=[_SPACED_META], scope_contains_answer=False,
        notes="Only the meta-analysis is selected; the classroom-implementation half of the "
            "synthesis is outside scope."),
    EvalCase(case_id="RCZ-N13", category="zoom_in_absent_elsewhere_present",
        topic="spaced_repetition",
        query="What should teachers track to manage a spacing schedule?",
        expected_document_ids=[_SPACED_CLASSROOM], expected_chunk_ids=[_cid(_SPACED_CLASSROOM, 3)],
        scope_document_ids=[_SPACED_META], scope_contains_answer=False,
        notes="Selected A (the meta-analysis) is the wrong document of the topic's two — it "
            "never gives classroom tracking guidance."),
    EvalCase(case_id="RCZ-N14", category="zoom_in_absent_elsewhere_present",
        topic="executive_function",
        query="What executive-function subscales does CEFC cover that BRI-SF does not?",
        expected_document_ids=[_EF_SCREEN], expected_chunk_ids=[_cid(_EF_SCREEN, 2)],
        scope_document_ids=[_EF_STUDY], scope_contains_answer=False,
        notes="Selected A (the training study) never discusses screening-instrument subscales."),
    EvalCase(case_id="RCZ-N15", category="zoom_in_absent_elsewhere_present",
        topic="spaced_repetition",
        query="What was the pooled effect size for spaced practice on retention?",
        expected_document_ids=[_SPACED_META], expected_chunk_ids=[_cid(_SPACED_META, 3)],
        scope_document_ids=[_SPACED_CLASSROOM], scope_contains_answer=False,
        notes="Selected A (the classroom guide) never reports a pooled effect size — that's the "
            "meta-analysis's own finding."),
    EvalCase(case_id="RCZ-N16", category="zoom_in_absent_elsewhere_present",
        topic="udl_accessibility",
        query="What did the UDL implementation study's discussion section say about "
            "participation vs. test-score gains?",
        expected_document_ids=[_UDL_STUDY], expected_chunk_ids=[_cid(_UDL_STUDY, 5)],
        scope_document_ids=[_UDL_POLICY], scope_contains_answer=False,
        notes="Selected A (the multilingual UDL policy) is a related-topic distractor with no "
            "achievement-study findings."),
    EvalCase(case_id="RCZ-N17", category="zoom_in_absent_elsewhere_present",
        topic="formative_assessment",
        query="How did the formative-assessment study's authors explain why daily checks "
            "improved outcomes?",
        expected_document_ids=[_FORMATIVE], expected_chunk_ids=[_cid(_FORMATIVE, 5)],
        scope_document_ids=[_EXIT_TICKETS], scope_contains_answer=False,
        notes="Selected A (the exit-tickets guide) never explains the study's own causal "
            "interpretation."),
    EvalCase(case_id="RCZ-N18", category="zoom_in_absent_elsewhere_present",
        topic="multilingual_learners",
        query="What is a 'translanguaging space'?",
        expected_document_ids=[_TRANSLANG], expected_chunk_ids=[_cid(_TRANSLANG, 1)],
        scope_document_ids=[_VOCAB_STUDY], scope_contains_answer=False,
        notes="Selected A (the vocabulary study) is the wrong document of the topic's two — it "
            "never defines this term."),
    EvalCase(case_id="RCZ-N19", category="zoom_in_absent_elsewhere_present",
        topic="multilingual_learners",
        query="How much did academic vocabulary assessment scores increase in the "
            "cognate-instruction group?",
        expected_document_ids=[_VOCAB_STUDY], expected_chunk_ids=[_cid(_VOCAB_STUDY, 3)],
        scope_document_ids=[_TRANSLANG], scope_contains_answer=False,
        notes="Selected A (the translanguaging guide) explicitly reports no outcome data at all."),
    EvalCase(case_id="RCZ-N20", category="zoom_in_absent_elsewhere_present",
        topic="project_based_learning",
        query="What was the most common driving-question design failure identified by the guide?",
        expected_document_ids=[_DRIVING_Q], expected_chunk_ids=[_cid(_DRIVING_Q, 4)],
        scope_document_ids=[_PBL_STUDY], scope_contains_answer=False,
        notes="Selected A (the outcomes study) never discusses driving-question design pitfalls."),
]

assert {c.category for c in ZOOM_IN_CASES} <= set(CATEGORIES), (
    "every Zoom-In case's category must be registered in controlled_corpus.CATEGORIES"
)

ALL_REALISTIC_CASES: list[EvalCase] = REALISTIC_CASES + ZOOM_IN_CASES
