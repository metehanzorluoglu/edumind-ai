from app.core.latex_source_hash import compute_source_hash


def test_same_inputs_produce_same_hash():
    h1 = compute_source_hash("\\section{A}", "@article{X, title={T}}")
    h2 = compute_source_hash("\\section{A}", "@article{X, title={T}}")
    assert h1 == h2


def test_different_main_tex_produces_different_hash():
    h1 = compute_source_hash("\\section{A}", "bib")
    h2 = compute_source_hash("\\section{B}", "bib")
    assert h1 != h2


def test_different_bibliography_produces_different_hash():
    h1 = compute_source_hash("tex", "@article{A}")
    h2 = compute_source_hash("tex", "@article{B}")
    assert h1 != h2


def test_no_concatenation_collision():
    # "ab" + "c" must not hash the same as "a" + "bc".
    h1 = compute_source_hash("ab", "c")
    h2 = compute_source_hash("a", "bc")
    assert h1 != h2


def test_returns_hex_digest():
    h = compute_source_hash("x", "y")
    assert len(h) == 64
    int(h, 16)  # raises ValueError if not valid hex
