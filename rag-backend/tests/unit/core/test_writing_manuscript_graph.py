"""Milestone 6.1 (Writing Context Engine) Parts 5/22 — multi-file
\\input/\\include graph resolution. Letters G (\\input relationship), H
(\\include relationship), I (missing included file), J (multi-file
manuscript), K (root document relationship)."""

from __future__ import annotations

from app.core.writing_manuscript_graph import build_manuscript_graph


class TestInputRelationship:
    def test_letter_G_input_relationship_resolved(self) -> None:
        files = {
            "main.tex": "\\documentclass{article}\\input{intro}\\begin{document}\\end{document}",
            "intro.tex": "Intro content.",
        }
        graph = build_manuscript_graph(files, root_path="main.tex")
        edges = graph.edges["main.tex"]
        assert len(edges) == 1
        resolved_path, target = edges[0]
        assert resolved_path == "intro.tex"
        assert target.kind == "input"
        assert graph.unresolved == []


class TestIncludeRelationship:
    def test_letter_H_include_relationship_resolved(self) -> None:
        files = {
            "main.tex": "\\include{Discussion}",
            "Discussion.tex": "Discussion content.",
        }
        graph = build_manuscript_graph(files, root_path="main.tex")
        resolved_path, target = graph.edges["main.tex"][0]
        assert resolved_path == "Discussion.tex"
        assert target.kind == "include"


class TestMissingIncludedFile:
    def test_letter_I_missing_target_reported_not_invented(self) -> None:
        files = {"main.tex": "\\include{DoesNotExist}"}
        graph = build_manuscript_graph(files, root_path="main.tex")
        resolved_path, _target = graph.edges["main.tex"][0]
        assert resolved_path is None
        assert len(graph.unresolved) == 1
        assert graph.unresolved[0].target.target == "DoesNotExist"
        # Never invented as a real file — files dict is untouched.
        assert "DoesNotExist.tex" not in graph.files
        assert "DoesNotExist" not in graph.files


class TestMultiFileManuscript:
    def test_letter_J_multi_file_thesis_structure(self) -> None:
        """Spec's own worked example (Part 5 / Scenario E): main.tex
        \\include's Introduction/Methods/Results/Discussion; editing
        Discussion.tex, the engine must know it belongs to main.tex
        WITHOUT concatenating every included file's content."""
        files = {
            "main.tex": (
                "\\documentclass{article}\n"
                "\\include{Introduction}\n"
                "\\include{Methods}\n"
                "\\include{Results}\n"
                "\\include{Discussion}\n"
            ),
            "Introduction.tex": "Intro.",
            "Methods.tex": "Methods.",
            "Results.tex": "Results.",
            "Discussion.tex": "Discussion body.",
        }
        graph = build_manuscript_graph(files, root_path="main.tex")
        assert graph.ancestors_of("Discussion.tex") == ["main.tex"]
        # The graph itself never concatenates file text anywhere — each
        # ManuscriptFile keeps only its OWN parsed structure.
        assert graph.files["Discussion.tex"].structure is not None
        assert set(graph.files.keys()) == {
            "main.tex",
            "Introduction.tex",
            "Methods.tex",
            "Results.tex",
            "Discussion.tex",
        }

    def test_extensionless_and_explicit_extension_both_resolve(self) -> None:
        files = {
            "main.tex": "\\include{Chapter1}\\input{Chapter2.tex}",
            "Chapter1.tex": "One.",
            "Chapter2.tex": "Two.",
        }
        graph = build_manuscript_graph(files, root_path="main.tex")
        resolved = [r for r, _t in graph.edges["main.tex"]]
        assert resolved == ["Chapter1.tex", "Chapter2.tex"]

    def test_nested_directory_input_resolves_relative_to_referencing_file(self) -> None:
        files = {
            "main.tex": "\\input{sections/methods}",
            "sections/methods.tex": "Methods in a subfolder.",
        }
        graph = build_manuscript_graph(files, root_path="main.tex")
        resolved, _target = graph.edges["main.tex"][0]
        assert resolved == "sections/methods.tex"


class TestRootDocumentRelationship:
    def test_letter_K_root_path_carried_through(self) -> None:
        files = {"thesis.tex": "\\include{Chapter1}", "Chapter1.tex": "One."}
        graph = build_manuscript_graph(files, root_path="thesis.tex")
        assert graph.root_path == "thesis.tex"

    def test_no_root_set_never_guessed(self) -> None:
        files = {"a.tex": "content", "b.tex": "content"}
        graph = build_manuscript_graph(files, root_path=None)
        assert graph.root_path is None

    def test_ancestors_of_root_itself_is_empty(self) -> None:
        files = {"main.tex": "\\include{Chapter1}", "Chapter1.tex": "One."}
        graph = build_manuscript_graph(files, root_path="main.tex")
        assert graph.ancestors_of("main.tex") == []
