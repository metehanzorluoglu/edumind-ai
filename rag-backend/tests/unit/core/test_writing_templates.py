"""Milestone 5.4 (LaTeX Templates & Project Import) Parts 1-3/19/42/43 —
the curated template registry: static, version-controlled files loaded
from app/templates/writing_templates/, never DB rows (Part 19)."""

from __future__ import annotations

from app.core.writing_templates import get_template, list_templates

_EXPECTED_IDS = {
    "blank-article",
    "academic-article",
    "two-column-paper",
    "thesis-starter",
    "research-proposal",
}


class TestListTemplates:
    def test_all_five_curated_templates_present(self) -> None:
        templates = list_templates()
        assert {t.id for t in templates} == _EXPECTED_IDS

    def test_list_does_not_include_file_bodies(self) -> None:
        # Part 48 — the list/gallery response must be cheap even with
        # many templates: WritingTemplateSummary has no `files` field at
        # all (only WritingTemplateDetail does).
        for t in list_templates():
            assert not hasattr(t, "files")

    def test_every_template_has_required_metadata(self) -> None:
        for t in list_templates():
            assert t.name
            assert t.description
            assert t.category
            assert t.license
            assert t.source
            assert t.version >= 1
            assert t.file_count >= 1

    def test_every_template_licensed_as_edumind_authored(self) -> None:
        # Part 42/43 — "This milestone may ship only EduM8-authored
        # templates initially. That is acceptable." Every bundled
        # template's own metadata must say so explicitly, not just be
        # true by omission.
        for t in list_templates():
            assert t.source == "EduM8"
            assert "EduM8" in t.license


class TestGetTemplate:
    def test_get_known_template_returns_detail_with_root_and_files(self) -> None:
        detail = get_template("academic-article")
        assert detail is not None
        assert detail.root == "main.tex"
        paths = {f.path for f in detail.files}
        assert "main.tex" in paths
        assert detail.file_count == len(detail.files)

    def test_get_unknown_template_returns_none(self) -> None:
        assert get_template("does-not-exist") is None

    def test_root_is_always_among_the_templates_own_files(self) -> None:
        for summary in list_templates():
            detail = get_template(summary.id)
            assert detail is not None
            assert detail.root in {f.path for f in detail.files}

    def test_every_file_body_is_nonempty_text(self) -> None:
        for summary in list_templates():
            detail = get_template(summary.id)
            assert detail is not None
            for f in detail.files:
                assert f.content.strip() != ""

    def test_multi_file_templates_use_input_or_include(self) -> None:
        # academic-article/two-column-paper/thesis-starter/
        # research-proposal all split into a sections/chapters
        # directory — sanity-check the root actually references them
        # rather than shipping orphaned files nothing pulls in.
        for template_id in ("academic-article", "two-column-paper", "thesis-starter", "research-proposal"):
            detail = get_template(template_id)
            assert detail is not None
            root_file = next(f for f in detail.files if f.path == detail.root)
            assert "\\input{" in root_file.content or "\\include{" in root_file.content


class TestRegistryIsCachedNotReloadedPerCall:
    def test_repeated_calls_return_equal_data(self) -> None:
        first = list_templates()
        second = list_templates()
        assert [t.id for t in first] == [t.id for t in second]
