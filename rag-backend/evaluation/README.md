# Evaluation

## Milestone 5.6: evidence-sufficiency threshold calibration

**`scripts/calibrate_evidence_sufficiency.py`** — a companion to
`scripts/eval_retrieval_controlled.py` below, reusing its corpus/embedding
provider selection. Sweeps a raw-dense-score threshold against
`controlled_corpus.py`'s 31 general-mode positive / 38 general-mode
negative cases (plus 8 Zoom-In-scope cases, calibrated separately — never
pooled with general mode) and reports a full TP/FP/TN/FN/precision/
recall/F1/false-abstention-rate/false-answer-rate table, a deterministic
calibration/holdout split, and a simple-signal comparison (margin,
mean-top-3, document diversity) against raw top-score alone. Implements
NO production behavior — calibration only; see the Milestone 5.6 report
for the resulting recommendation.

```bash
python scripts/calibrate_evidence_sufficiency.py
python scripts/calibrate_evidence_sufficiency.py --force-synthetic-embeddings  # mechanics only
```

Reports land in `evaluation/reports/evidence-sufficiency-calibration-<timestamp>.json`.

## Milestone 5: controlled-corpus retrieval baseline (chunk-level ground truth)

**`controlled_corpus.py`** is a third, separate tool from the two question
sets below — deliberately Python, not JSON: `EvalCase`/`ControlledDocument`
dataclasses defining a self-contained corpus (28 documents / 34 chunks / 77
cases as of Milestone 5.6, up from Milestone 5's original 22/28/31) with
document_id AND chunk_index-level ground truth verified by construction
(every `expected_document_ids`/`expected_chunk_ids` value was checked
against the actual authored chunk text, not guessed). It needs no external
ingestion step — `scripts/eval_retrieval_controlled.py` builds its own
embedded, in-memory Qdrant and ingests the corpus itself.

Unlike `fixtures-questions.json` below (which is document-level-only,
filename-based, and requires `tests/fixtures/corpus/` — a directory that
does not exist in this checkout, see that file's own known-gaps note),
`controlled_corpus.py`'s cases carry chunk-level ground truth, cross-
document "all required documents" ground truth, and Zoom-In scope
scenarios, and can be run with either a real Ollama embedding model or a
clearly-labeled synthetic fallback (see below) with zero setup.

```bash
python scripts/eval_retrieval_controlled.py                       # real embeddings if reachable, else synthetic fallback
python scripts/eval_retrieval_controlled.py --force-synthetic-embeddings
```

Reports land in `evaluation/reports/retrieval-baseline-<timestamp>.{json,md}`
(gitignored, same convention as the reports below). Every report records
`embedding_mode` (`"real:<model>"` or `"synthetic:lexical-hash"`) — **never
treat a `synthetic:lexical-hash` run's category-level findings (e.g.
paraphrase vs. exact-term performance) as a semantic-embedding-quality
result** — the fallback measures word overlap, not meaning, and exists only
so the harness's mechanics (metrics, report shape, Zoom-In leakage check)
can be validated and CI-run without a reachable Ollama.

## Two question sets, deliberately kept separate

- **`real-corpus-questions.json`** — the milestone 8 evaluation set: at least
  30 questions written by the corpus owner (or derived from the app's actual
  intended use), run against the *real*, private document corpus. **This file
  ships empty (`[]`).** Nothing in this repository invents "real" evaluation
  questions or a stand-in corpus to fake this — see `IMPLEMENTATION_PLAN.md`
  / the milestone 8 completion report for why. Populate it once real
  documents are ingested (`python -m cli.ingest`), following the schema
  below.
- **`fixtures-questions.json`** — a small, fully fictional set written
  against `tests/fixtures/corpus/` (the same 5 documents the backend's own
  pytest suite uses). Its only purpose is to prove `scripts/eval_retrieval.py`
  and `scripts/eval_answers.py` actually work end-to-end, and to give you a
  worked example to model real questions on. **Never treat its numbers as a
  real evaluation result** — 5 short fictional documents cannot represent
  real corpus retrieval quality.

## Question schema

Each entry in either file:

| Field | Type | Meaning |
| --- | --- | --- |
| `question_id` | string | Stable identifier, referenced in eval reports. |
| `question` | string | The query text sent to the retriever. |
| `category` | string | One of the categories below. |
| `expected_relevant_filenames` | string[] | `source_filename` values (as ingested) that should appear among retrieved sources. Empty if `expect_insufficient_evidence` is true or the question is intentionally off-topic. |
| `expected_document_type` | string \| null | Set only if the question is scoped to one document type. |
| `expected_quartile` | `"Q1"` \| `"Q2"` \| null | Set only for quartile-scoped questions. |
| `expect_insufficient_evidence` | boolean | Whether the backend's mechanical `insufficient_evidence` (zero chunks survive retrieval + context prep) should be true for this question. |
| `filters` | object | `{document_type, journal_quartile, publication_year_from, publication_year_to}`, all nullable — the `RetrievalFilters` actually sent for this question. Independent of `expected_document_type`/`expected_quartile`, which describe the *expected answer*, not necessarily a filter you're applying. |
| `notes` | string | Short, original note — never a copied passage from a source document. |

Required category coverage (milestone 8 §6):
`factual_single_document`, `synthesis_multi_document`, `q1_only`, `q2_only`,
`practitioner_only`, `policy`, `curriculum`, `page_level_evidence`,
`answer_not_present`, `off_topic`, `ambiguous`, `overlapping_terminology`.

## Known gaps in the fixture set — read before trusting its numbers

`tests/fixtures/corpus/` has no `curriculum_document` and every fixture is a
single short page, so:

- **`curriculum` category**: no curriculum fixture exists. The one
  `curriculum`-tagged fixture question deliberately filters on
  `document_type=curriculum_document`, which matches nothing — it exercises
  the *filter → zero results → insufficient_evidence* path honestly, but it
  is not a real test of curriculum-document retrieval quality.
- **`page_level_evidence` category**: every fixture document is one page, so
  this category cannot be meaningfully exercised against fixtures. The one
  fixture question tagged this way only confirms `page_number` is populated
  on results, not that multi-page evidence resolution works.
- **`insufficient_evidence` is mechanical, not semantic** (see the SDK docs
  from milestone 7): because there is currently no relevance threshold, an
  off-topic question still returns the corpus's top-`k` nearest neighbors
  rather than zero results. The only reliable way to *actually* produce
  `insufficient_evidence=true` today is a filter that matches nothing. The
  off-topic fixture question is expected to have `expect_insufficient_evidence:
  false` for exactly this reason — that's the current, correct, documented
  backend behavior, not a bug in the question.

## Running

```bash
python scripts/eval_retrieval.py --questions evaluation/fixtures-questions.json
python scripts/eval_retrieval.py --questions evaluation/real-corpus-questions.json
```

Reports land in `evaluation/reports/retrieval-eval-<timestamp>.{json,md}`
(gitignored — these are run output, not source).
