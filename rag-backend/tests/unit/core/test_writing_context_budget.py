"""Milestone 6.1 (Writing Context Engine) Parts 11-13/22 — token
estimation, budget enforcement, deduplication. Letters U (context budget
overflow), V (deterministic truncation), W (duplicate text removal)."""

from __future__ import annotations

from app.core.writing_context_budget import (
    ContextBudgetEnforcer,
    deduplicate_evidence,
    estimate_tokens,
)
from app.core.writing_context_schemas import EvidenceItem


def _item(text: str, kind: str = "manuscript_text") -> EvidenceItem:
    return EvidenceItem(kind=kind, text=text, estimated_tokens=estimate_tokens(text))  # type: ignore[arg-type]


class TestEstimateTokens:
    def test_chars_over_four_rounded(self) -> None:
        assert estimate_tokens("abcd") == 1
        assert estimate_tokens("abcdefgh") == 2

    def test_empty_string_is_zero(self) -> None:
        assert estimate_tokens("") == 0


class TestDeduplicateEvidence:
    def test_letter_W_exact_duplicate_removed(self) -> None:
        items = [
            _item("Teacher agency is influenced by contextual conditions."),
            _item("Teacher agency is influenced by contextual conditions."),
        ]
        result = deduplicate_evidence(items)
        assert len(result) == 1

    def test_near_duplicate_with_whitespace_differences_removed(self) -> None:
        items = [
            _item("Teacher agency is influenced by contextual conditions."),
            _item("Teacher  agency is influenced by contextual conditions.  "),
        ]
        result = deduplicate_evidence(items)
        assert len(result) == 1

    def test_distinct_text_both_kept(self) -> None:
        items = [
            _item("First distinct sentence about pedagogy."),
            _item("Second, unrelated sentence about statistics."),
        ]
        result = deduplicate_evidence(items)
        assert len(result) == 2

    def test_empty_text_dropped(self) -> None:
        items = [_item(""), _item("   "), _item("Real content here.")]
        result = deduplicate_evidence(items)
        assert len(result) == 1
        assert result[0].text == "Real content here."

    def test_first_occurrence_wins_order_preserved(self) -> None:
        first = _item("Repeated text here for the test.")
        second = _item("Repeated text here for the test.")
        result = deduplicate_evidence([first, second])
        assert result[0] is first


class TestContextBudgetEnforcer:
    def test_letter_V_deterministic_truncation_same_input_same_output(self) -> None:
        items = [_item("word " * 50) for _ in range(5)]
        enforcer1 = ContextBudgetEnforcer(category_limits={"notes": 30}, total_budget=1000)
        kept1 = enforcer1.add("notes", items)
        enforcer2 = ContextBudgetEnforcer(category_limits={"notes": 30}, total_budget=1000)
        kept2 = enforcer2.add("notes", items)
        assert [i.text for i in kept1] == [i.text for i in kept2]

    def test_letter_U_category_overflow_excludes_later_items(self) -> None:
        big = _item("x" * 400)  # ~100 tokens
        enforcer = ContextBudgetEnforcer(category_limits={"evidence": 150}, total_budget=10000)
        kept = enforcer.add("evidence", [big, big])
        assert len(kept) == 1  # second one would exceed the 150-token category limit
        report = enforcer.report()
        assert report.category_tokens_included["evidence"] == 100
        assert report.category_tokens_omitted["evidence"] == 100

    def test_total_budget_caps_across_categories(self) -> None:
        item = _item("x" * 400)  # ~100 tokens each
        small_item = _item("x" * 160)  # ~40 tokens
        enforcer = ContextBudgetEnforcer(category_limits={"a": 1000, "b": 1000}, total_budget=150)
        kept_a = enforcer.add("a", [item])  # uses 100 of the 150 total
        kept_b = enforcer.add("b", [item, small_item])  # 100 exceeds remaining 50; 40 fits
        assert len(kept_a) == 1
        assert len(kept_b) == 1
        assert kept_b[0] is small_item
        report = enforcer.report()
        assert (
            report.total_tokens_included == 140
        )  # 100 (a) + 40 (b) — never exceeds the 150 budget

    def test_report_reflects_configured_limits(self) -> None:
        enforcer = ContextBudgetEnforcer(category_limits={"notes": 42}, total_budget=999)
        report = enforcer.report()
        assert report.category_limits["notes"] == 42
        assert report.total_token_budget == 999

    def test_zero_limit_category_excludes_everything(self) -> None:
        enforcer = ContextBudgetEnforcer(category_limits={"evidence": 0}, total_budget=10000)
        kept = enforcer.add("evidence", [_item("any text")])
        assert kept == []
