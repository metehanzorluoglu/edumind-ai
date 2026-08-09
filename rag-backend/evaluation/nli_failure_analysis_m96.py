"""Milestone 9.6 (NLI Contradiction & Negation Recovery) Phase A — the
manually-categorized failure analysis of every CONTRADICTION-gold error
`cross-encoder/nli-deberta-v3-small` made on the clean Milestone 9.5
polarity-matched dataset (evaluation/polarity_matched_dataset.py, all 80
auto-applicable cases, manual/auto claim — identical text, see M9.5 §9).

Recorded as data (not just printed) so the categorization is a durable,
reviewable artifact and the two DANGEROUS errors (CONTRADICTION predicted
as ENTAILMENT — a false SUPPORTED verdict) are explicitly, permanently
flagged as the ones motivating Phase E/F/G's abstention-policy work and
Phase I's alternative-model search.

Every record's probabilities were read directly from a real
`cross-encoder/nli-deberta-v3-small` inference run (see the Milestone 9.6
report §2 for the reproduction command) — not estimated or invented.
No dataset gold label was changed as a result of this analysis; all 8
errors were confirmed, on review, to be genuine model errors, not
annotation mistakes (Milestone 9.6 Phase A's own instruction: "Do not
change the dataset labels unless a genuine annotation error is
discovered").
"""

from __future__ import annotations

from evaluation.nli_safety_policy import FailureRecord

# All 8 CONTRADICTION-gold false negatives from cross-encoder/nli-deberta-v3-small
# on the 80-case clean M9.5 applicable subset (contradiction support = 17 total,
# so this is 8/17 — the model got 9/17 right, matching the 52.9% recall figure
# reported throughout M9.5/M9.6).
FAILURES: list[FailureRecord] = [
    FailureRecord(
        "PM-003",
        "Did systematic phonics improve listening comprehension compared to embedded phonics?",
        "Systematic phonics improved listening comprehension compared to embedded phonics.",
        "Results (comprehension): no significant between-group difference was found on a "
        "listening comprehension measure administered at the same time point (p=0.41), "
        "suggesting the effect was decoding-specific.",
        "contradiction",
        "neutral",
        0.0008,
        0.9911,
        0.0081,
        "NULL_RESULT",
    ),
    FailureRecord(
        "PM-007",
        "Did working-memory training improve math achievement?",
        "Working-memory training improved math achievement.",
        "Results (far transfer): math achievement scores did not differ significantly between "
        "groups eight weeks post-training (p=0.52), showing no evidence of transfer to math "
        "performance.",
        "contradiction",
        "neutral",
        0.0001,
        0.9955,
        0.0044,
        "NULL_RESULT",
    ),
    FailureRecord(
        "PM-023",
        "Did the growth-mindset intervention improve overall GPA?",
        "The growth-mindset intervention improved overall GPA.",
        "Results: the intervention group's semester GPA (mean 2.81) did not differ "
        "significantly from the control group's (mean 2.77), p=0.34 — a null result for the "
        "overall sample.",
        "contradiction",
        "neutral",
        0.0001,
        0.9986,
        0.0013,
        "NULL_RESULT",
    ),
    FailureRecord(
        "PM-046",
        "Does the increase in voluntary practice prove adaptive difficulty causes "
        "higher engagement?",
        "The increase in voluntary practice proves adaptive difficulty causes higher engagement.",
        "Limitations: the study could not separate the adaptive algorithm's effect from novelty "
        "effects of using new software, since no school had used the platform before.",
        "contradiction",
        "neutral",
        0.0001,
        0.9962,
        0.0037,
        "CORRELATION_VS_CAUSATION",
    ),
    FailureRecord(
        "PM-048",
        "Does higher Spanish literacy prove cognate instruction causes larger vocabulary gains?",
        "Higher Spanish literacy proves cognate instruction causes larger vocabulary gains.",
        "Results (moderator): the vocabulary gain was significantly larger for students with "
        "higher Spanish literacy at baseline, suggesting cognate instruction requires some "
        "existing Spanish print exposure to be maximally effective.",
        "contradiction",
        # DANGEROUS: false SUPPORTED, 95.9% confident, persists across all 3 models tested
        "entailment",
        0.9587,
        0.0186,
        0.0227,
        "CORRELATION_VS_CAUSATION",
    ),
    FailureRecord(
        "PM-064",
        "Does the evidence support a GPA benefit for the overall sample?",
        "The evidence supports a GPA benefit for the overall sample.",
        "Results: the intervention group's semester GPA (mean 2.81) did not differ "
        "significantly from the control group's (mean 2.77), p=0.34 — a null result for the "
        "overall sample.",
        "contradiction",
        "neutral",
        0.0234,
        0.8528,
        0.1238,
        "NULL_RESULT",
    ),
    FailureRecord(
        "PM-067",
        "Was the UDL study's sample size smaller than 100?",
        "The UDL study's sample size was smaller than 100.",
        "Methods: 14 inclusive middle-school classrooms (n=376 students, including 58 students "
        "with IEPs) redesigned two units using UDL principles; participation was measured via "
        "classroom observation checklists.",
        "contradiction",
        # DANGEROUS: false SUPPORTED, 94.5% confident — model does not do numeric comparison
        "entailment",
        0.9449,
        0.0409,
        0.0142,
        "NUMERIC_CONTRADICTION",
    ),
    FailureRecord(
        "PM-069",
        "Are K-12 implementations well studied relative to lab studies?",
        "K-12 implementations are well studied relative to lab studies.",
        "Limitations: fewer than 15 percent of the pooled studies were conducted in authentic "
        "K-12 classroom settings; most used controlled laboratory conditions.",
        "contradiction",
        "neutral",
        0.0037,
        0.8945,
        0.1018,
        "SCOPE_MISMATCH",
    ),
]


def category_counts() -> dict[str, int]:
    counts: dict[str, int] = {}
    for f in FAILURES:
        counts[f.category] = counts.get(f.category, 0) + 1
    return counts


def dangerous_failures() -> list[FailureRecord]:
    """The subset where the model's error was CONTRADICTION -> ENTAILMENT
    (a false SUPPORTED verdict) rather than CONTRADICTION -> NEUTRAL (a
    safe, merely-uninformative miss) — the error class Phase E/F/G and
    Phase I both specifically target."""
    return [f for f in FAILURES if f.prediction == "entailment"]
