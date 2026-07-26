# Evaluation

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
