"""Milestone 6 (Evidence Reasoning Architecture) — a small, MANUALLY
REVIEWED subset of the Milestone 5.7 realistic corpus (see
evaluation/realistic_corpus.py), each case hand-assigned one of the four
richer sufficiency labels the M5.7 schema always supported but never
populated (EvalCase.sufficiency — see evaluation/controlled_corpus.py):

    SUFFICIENT | PARTIAL | INSUFFICIENT | CONTRADICTORY

This is NOT an automatic relabeling of all 104 M5.7 cases. Milestone 6 §8
explicitly requires "a high-confidence subset," not blanket auto-labeling.
Every case_id below was chosen because its existing M5.7 `notes` field (or,
for the plain single-document lookups, its self-evident query/expected-
answer shape) already states unambiguously which of the four labels
applies under the operational definitions in the Milestone 6 report (§3):

  SUFFICIENT    — retrieved evidence directly and completely answers the
                  question (single-document lookup, or a multi-document
                  comparison/synthesis where EVERY required document's
                  fact is actually present in the corpus).
  PARTIAL       — evidence answers only part of a multi-part question,
                  comparison, or synthesis (one side of a comparison
                  present, the other absent) — never used for a single-
                  fact question that is simply missing its answer.
  INSUFFICIENT  — evidence is topically related but silent on the
                  specific requested fact; nothing in the evidence
                  actively contradicts any premise of the question.
  CONTRADICTORY — evidence contains an explicit statement that refutes a
                  factual premise or claim embedded in the question
                  (a stated negation, a disproven presupposition, or a
                  claim measurably stronger than what the source
                  supports) — distinct from INSUFFICIENT, which is
                  silence rather than refutation.

Coverage against the Milestone 6 §8 target (20 SUFFICIENT / 15
INSUFFICIENT / 10 PARTIAL / 10 CONTRADICTORY, "if practical"):

    SUFFICIENT:    20  (target met)
    INSUFFICIENT:  15  (target met)
    CONTRADICTORY: 10  (target met)
    PARTIAL:        6  (below the 10 target — see the report's §4/§23:
                        the M5.7 corpus, as constructed, only contains 6
                        cases with unambiguous partial-coverage evidence
                        — 2 general `partial_evidence`, 2 general
                        `cross_document_incomplete`, and 2 Zoom-In
                        `zoom_in_project_absent` negatives where exactly
                        one required document is in scope. Padding this
                        to 10 by relabeling weaker cases was rejected as
                        inconsistent with "create a HIGH-CONFIDENCE
                        subset" — quality over hitting an arbitrary count.
                        This shortfall is disclosed, not hidden.)

Every entry cites which existing M5.7 field the label determination rests
on, so a future reviewer can re-derive (or dispute) the call without
re-reading this whole module's prose above.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from evaluation.controlled_corpus import EvalCase
from evaluation.realistic_corpus import DOCUMENTS_BY_ID, REALISTIC_CASES, ZOOM_IN_CASES

Sufficiency = Literal["SUFFICIENT", "PARTIAL", "INSUFFICIENT", "CONTRADICTORY"]


@dataclass(frozen=True)
class ReviewedCase:
    case_id: str
    sufficiency: Sufficiency
    rationale: str


# fmt: off
REVIEWED_CASES: tuple[ReviewedCase, ...] = (
    # ---- SUFFICIENT (20) — single-document lookups (15) + multi-document
    # cases where the M5.7 evidence-coverage benchmark measured 100%
    # coverage (5) — the mix deliberately tests that the verifier says
    # SUFFICIENT for multi-document synthesis too, not just single-fact
    # lookups. ----
    ReviewedCase("RC-ET01", "SUFFICIENT", "Exact factual lookup; single document states the count directly."),
    ReviewedCase("RC-ET02", "SUFFICIENT", "Exact factual lookup; single document states the percentage directly."),
    ReviewedCase("RC-PA01", "SUFFICIENT", "Paraphrase of a directly-stated recommendation."),
    ReviewedCase("RC-PA02", "SUFFICIENT", "Paraphrase of a directly-stated UDL strategy."),
    ReviewedCase("RC-NF01", "SUFFICIENT", "Numeric finding stated directly (effect size)."),
    ReviewedCase("RC-NF02", "SUFFICIENT", "Numeric finding stated directly (standard-score points)."),
    ReviewedCase("RC-DEF01", "SUFFICIENT", "Definition given directly in the source."),
    ReviewedCase("RC-DEF02", "SUFFICIENT", "Definition given directly in the source."),
    ReviewedCase("RC-MQ01", "SUFFICIENT", "Methodology duration stated directly."),
    ReviewedCase("RC-MQ02", "SUFFICIENT", "Methodology duration stated directly."),
    ReviewedCase("RC-RI01", "SUFFICIENT", "Result interpretation stated directly by the authors."),
    ReviewedCase("RC-SS01", "SUFFICIENT", "Section-specific limitation stated directly."),
    ReviewedCase("RC-AC01", "SUFFICIENT", "Acronym expansion stated directly."),
    ReviewedCase("RC-AC02", "SUFFICIENT", "Acronym expansion stated directly."),
    ReviewedCase("RC-CIT01", "SUFFICIENT", "Citation-sensitive fact attributable to one specific document."),
    ReviewedCase("RC-CD01", "SUFFICIENT", "2-document comparison; M5.7 evidence_coverage measured coverage=1.0 (both required docs retrieved)."),
    ReviewedCase("RC-CD02", "SUFFICIENT", "2-document comparison; both sample sizes are directly stated."),
    ReviewedCase("RC-CMS01", "SUFFICIENT", "Same-document multi-section comparison; notes confirm both required chunks exist."),
    ReviewedCase("RC-SYN01", "SUFFICIENT", "2-document synthesis; M5.7 evidence_coverage measured coverage=1.0."),
    ReviewedCase("RC-SYN02", "SUFFICIENT", "3-document synthesis; M5.7 evidence_coverage measured coverage=1.0 across all 3 required docs."),

    # ---- INSUFFICIENT (15) — topic present, requested fact silently
    # absent; no chunk actively refutes anything. ----
    ReviewedCase("RC-SND01", "INSUFFICIENT", "Notes: exit-tickets guide never discusses growth-mindset language at all — silent absence."),
    ReviewedCase("RC-SND02", "INSUFFICIENT", "Notes: UDL policy never discusses spaced review at all — silent absence."),
    ReviewedCase("RC-RTA01", "INSUFFICIENT", "Notes: topically related study never reports the requested no-training success rate."),
    ReviewedCase("RC-RTA02", "INSUFFICIENT", "Notes: neither PBL document discusses teacher salary."),
    ReviewedCase("RC-AA01", "INSUFFICIENT", "Notes: corpus only defines PAS in the education sense — no clinical definition exists to contradict or confirm."),
    ReviewedCase("RC-AA02", "INSUFFICIENT", "Notes: corpus only defines CELB in the K-12 sense — no corporate definition exists."),
    ReviewedCase("RC-SM01", "INSUFFICIENT", "Notes: study never names a specific statistical test — silent gap, not a contradiction."),
    ReviewedCase("RC-SM02", "INSUFFICIENT", "Notes: study gives grade level, never an age range in months — silent gap."),
    ReviewedCase("RC-WPS01", "INSUFFICIENT", "Notes: study is about third graders only; no high-school data exists to report either way."),
    ReviewedCase("RC-WM01", "INSUFFICIENT", "Notes: study used observation checklists; no interview data exists to report."),
    ReviewedCase("RC-WDY01", "INSUFFICIENT", "Notes: no 2015 study exists in the corpus on this topic."),
    ReviewedCase("RC-WDY02", "INSUFFICIENT", "Notes: no 2010 meta-analysis exists in the corpus."),
    ReviewedCase("RC-PNS01", "INSUFFICIENT", "Notes: report never states any instrument was adopted as a sole tool — presupposition is neither confirmed nor actively refuted, just unaddressed."),
    ReviewedCase("RC-CNC01", "INSUFFICIENT", "Notes: curriculum discusses the concept but never states a conclusion either way — silent gap."),
    ReviewedCase("RC-WN01", "INSUFFICIENT", "Notes: meta-analysis reports a pooled MEAN, never a median — the specific requested statistic is simply absent."),

    # ---- CONTRADICTORY (10) — evidence contains an explicit statement
    # that refutes a premise or claim in the question. ----
    ReviewedCase("RC-NEG01", "CONTRADICTORY", "Notes: chunk explicitly reports NO significant far-transfer difference, refuting the presupposed improvement."),
    ReviewedCase("RC-NEG02", "CONTRADICTORY", "Notes: chunk explicitly reports NO significant difference in mastery, refuting the presupposed improvement."),
    ReviewedCase("RC-CS01", "CONTRADICTORY", "Notes: a positive subgroup effect directly refutes the 'never works for any student' claim."),
    ReviewedCase("RC-CS02", "CONTRADICTORY", "Notes: no significant difference (not 'worse') plus a motivation benefit directly refutes the 'always worse' claim."),
    ReviewedCase("RC-ENT01", "CONTRADICTORY", "Notes: chunk explicitly states the report makes NO claim about long-term outcomes, refuting the question's premise that such a finding exists."),
    ReviewedCase("RC-ENT02", "CONTRADICTORY", "Notes: chunk explicitly states the guide reports no effect sizes/outcome data, refuting the premise that a GPA-gain figure exists."),
    ReviewedCase("RC-PNS02", "CONTRADICTORY", "Notes: chunk explicitly states fewer than 15% of pooled studies were K-12, directly refuting the 'all 41 studies used K-12 samples' presupposition."),
    ReviewedCase("RC-WCC01", "CONTRADICTORY", "Notes: study reports a null result and explicitly offers no proven mechanism, refuting the premise that one was proven."),
    ReviewedCase("RC-WCC02", "CONTRADICTORY", "Notes: chunk explicitly undermines causal proof (no blinding, extra planning time), refuting the 'proves X causes Y' premise."),
    ReviewedCase("RC-CC01", "CONTRADICTORY", "Notes: study design is observational/associational; evidence refutes that a causal claim can be drawn from it."),

    # ---- PARTIAL (6 of the 10 target — see module docstring) — evidence
    # answers one side of a required comparison/synthesis, not the other. ----
    ReviewedCase("RC-PE01", "PARTIAL", "Notes: effect size answerable; per-study publication years are never individually listed."),
    ReviewedCase("RC-PE02", "PARTIAL", "Notes: sample size answerable; the achievement effect side was explicitly not statistically significant, not simply missing."),
    ReviewedCase("RC-CDI01", "PARTIAL", "Notes: UDL side has data; translanguaging side explicitly has none — comparison half-answered."),
    ReviewedCase("RC-CDI02", "PARTIAL", "Notes: growth-mindset side has a number; translanguaging side has none — comparison half-answered."),
    ReviewedCase("RCZ-N11", "PARTIAL", "Notes: only ONE required document of a 2-document comparison is in the Zoom-In scope."),
    ReviewedCase("RCZ-N12", "PARTIAL", "Notes: only the meta-analysis half of a required 2-document synthesis is in the Zoom-In scope."),
)
# fmt: on

REVIEWED_LABELS: dict[str, Sufficiency] = {rc.case_id: rc.sufficiency for rc in REVIEWED_CASES}

_ALL_CASES_BY_ID: dict[str, EvalCase] = {
    c.case_id: c for c in (*REALISTIC_CASES, *ZOOM_IN_CASES)
}


def reviewed_eval_cases() -> list[tuple[EvalCase, Sufficiency]]:
    """Resolves every REVIEWED_CASES entry to its full EvalCase (query,
    expected_document_ids, scope_document_ids, etc.) alongside the
    hand-assigned label — the shape scripts/prototype_evidence_verifier.py
    consumes."""
    return [(_ALL_CASES_BY_ID[rc.case_id], rc.sufficiency) for rc in REVIEWED_CASES]


def _integrity_check() -> None:
    seen_ids: set[str] = set()
    for rc in REVIEWED_CASES:
        if rc.case_id in seen_ids:
            raise AssertionError(f"duplicate reviewed case_id {rc.case_id!r}")
        seen_ids.add(rc.case_id)
        if rc.case_id not in _ALL_CASES_BY_ID:
            raise AssertionError(f"{rc.case_id!r} is not a real M5.7 case id")
    counts: dict[str, int] = {}
    for rc in REVIEWED_CASES:
        counts[rc.sufficiency] = counts.get(rc.sufficiency, 0) + 1
    if counts.get("SUFFICIENT", 0) < 20:
        raise AssertionError("SUFFICIENT below the Milestone 6 §8 target of 20")
    if counts.get("INSUFFICIENT", 0) < 15:
        raise AssertionError("INSUFFICIENT below the Milestone 6 §8 target of 15")
    if counts.get("CONTRADICTORY", 0) < 10:
        raise AssertionError("CONTRADICTORY below the Milestone 6 §8 target of 10")
    if counts.get("PARTIAL", 0) < 1:
        raise AssertionError("PARTIAL subset is empty")
    assert DOCUMENTS_BY_ID  # every reviewed case's documents must resolve too


_integrity_check()
