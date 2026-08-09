"""Milestone 9 (Question-to-Claim Transformation & NLI Routing) — a
deterministic, regex/rule-based question -> declarative-claim transformer.
No LLM call, no external API, no new dependency (word-level scanning + a
small verb-conjugation lookup table only — no parser library exists in
this repo already, and Milestone 9 §11 forbids adding one merely for
this).

Promoted from evaluation/claim_transformer.py to this production-safe
location by Milestone 11 (§15) — the Docker runtime image copies only
`app/`, `cli/`, and `alembic/` (see deploy/rpi5/Dockerfile.rpi5), never
`evaluation/`, so any module a real request path needs to import at
runtime must live under app/. The implementation itself is UNCHANGED by
this move (Milestone 11 §15: "Do NOT rewrite it. Do NOT broaden grammar
coverage.") except for the one explicitly-approved regression fix in
Milestone 11 §16 — see `_IRREGULAR_PAST["flag"]` below.
evaluation/claim_transformer.py is now a thin re-export shim so every
existing evaluation script/test keeps working unmodified.

Design principle (Milestone 9 §12, "high precision over high recall"):
every transformation rule below is deliberately narrow, and subject/verb
(or subject/predicate) boundaries are found by scanning for a KNOWN word
(a verb in a curated list, or a predicate-trigger word/digit) rather than
by blind non-greedy regex capture. An early version of this module used
plain `.+?` non-greedy regex groups for subject capture and was caught,
by this module's own smoke test, silently misplacing the subject/verb
boundary on multi-word subjects (e.g. "Does the paper report X?" produced
"The papers report X." — "paper" was mistaken for the verb). That
approach was discarded entirely, not patched, in favor of the explicit
known-word scanning below, which cannot mis-split in that way: it only
ever splits at a word this module actually recognizes.

Any input that doesn't cleanly match a known-safe pattern falls through
to NOT_NLI_APPLICABLE rather than being forced through a best-effort
guess — an incorrect claim would poison every downstream NLI call, so
declining to transform is always the safe default, never a failure.

Five routing categories (Milestone 9 §1 — kept deliberately small):

- BOOLEAN_CLAIM: a yes/no question with an embedded, directly-extractable
  proposition ("Did X improve Y?", "Is method X used?", "Was the sample
  size 42?").
- COMPARATIVE_CLAIM: a BOOLEAN_CLAIM whose predicate is itself a
  comparison ("Did A outperform B?", "Was A higher than B?").
- PRESUPPOSITION_CLAIM: a wh-question that presupposes a specific claim
  independent of the specific missing value ("How much did X improve Y?"
  presupposes "X improved Y" without needing to know the amount), or
  wraps an already-declarative embedded clause ("What evidence shows X
  did not improve Y?" -> extract "X did not improve Y" verbatim, no
  re-tensing).
- MULTI_CLAIM: a BOOLEAN_CLAIM whose verb phrase conjoins two
  independently-verifiable propositions under one shared subject ("Did X
  improve A and reduce B?").
- NOT_NLI_APPLICABLE: everything else — including wh-questions asking for
  an unknown value with no independent presupposition ("What was the
  sample size?"), open-ended synthesis/summary/procedural/creative/opinion
  requests, cross-subject "while"-conjoined multi-document comparisons
  (deliberately not attempted — see the Milestone 9 report §9/§23), and
  any input a safe pattern doesn't confidently match.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Literal

RoutingCategory = Literal[
    "BOOLEAN_CLAIM",
    "COMPARATIVE_CLAIM",
    "PRESUPPOSITION_CLAIM",
    "MULTI_CLAIM",
    "NOT_NLI_APPLICABLE",
]


@dataclass(frozen=True)
class TransformationResult:
    applicable: bool
    category: RoutingCategory
    claims: tuple[str, ...] = field(default_factory=tuple)
    reason: str = ""  # machine-usable rule name — never logged content, see report §32

    @property
    def claim_count(self) -> int:
        return len(self.claims)


# ---------------------------------------------------------------------------
# Verb conjugation — a small, curated lookup table for the verbs that
# actually appear across the M5.7/M6/M7/M8 evaluation corpora, plus a
# regular-suffix fallback. A verb this table cannot confidently conjugate
# bails the whole transformation to NOT_NLI_APPLICABLE (never a guess).
# ---------------------------------------------------------------------------

_IRREGULAR_PAST: dict[str, str] = {
    "find": "found",
    "show": "showed",
    "prove": "proved",
    "begin": "began",
    "cause": "caused",
    "become": "became",
    "give": "gave",
    "make": "made",
    "take": "took",
    "have": "had",
    "do": "did",
    "go": "went",
    "come": "came",
    "see": "saw",
    "know": "knew",
    "think": "thought",
    "say": "said",
    "run": "ran",
    "grow": "grew",
    "rise": "rose",
    "fall": "fell",
    "spend": "spent",
    "meet": "met",
    "lead": "led",
    "hold": "held",
    "keep": "kept",
    "cut": "cut",
    "put": "put",
    "set": "set",
    "cost": "cost",
    "let": "let",
    # Milestone 11 §16 regression fix: the generic regular-suffix fallback
    # in _past_tense() below (`v + "ed"`) produced "flaged" for this verb —
    # "flag" is a single-syllable, single-vowel + single-final-consonant
    # (CVC) verb, a class that doubles the final consonant before "-ed"
    # ("flag" -> "flagged", cf. "stop" -> "stopped", "plan" -> "planned").
    # Fixed via one verb-specific entry here (Milestone 11's explicitly
    # preferred approach), NOT by adding a general CVC-consonant-doubling
    # rule to _past_tense(): this module's other CVC-shaped verbs already
    # in _KNOWN_VERBS (e.g. "score", "test") don't end in a single
    # consonant the same way, and a blind general rule risks silently
    # mis-conjugating a verb this table was never audited against. See the
    # Milestone 9.6 report §disclosed-bugs and Milestone 10 report §43 for
    # this bug's discovery and scoping into this milestone.
    "flag": "flagged",
}
_IRREGULAR_PRESENT_3SG: dict[str, str] = {"have": "has", "do": "does", "go": "goes"}
_DOUBLE_CONSONANT_VERBS = {"occur", "prefer", "refer", "transfer"}


def _past_tense(verb: str) -> str | None:
    v = verb.lower()
    if v in _IRREGULAR_PAST:
        return _IRREGULAR_PAST[v]
    if v in _DOUBLE_CONSONANT_VERBS:
        return v + v[-1] + "ed"
    if v.endswith("e"):
        return v + "d"
    if re.match(r"^[a-z]*[^aeiou]y$", v):
        return v[:-1] + "ied"
    if re.match(r"^[a-z]+$", v):
        return v + "ed"
    return None


def _present_3sg(verb: str) -> str | None:
    v = verb.lower()
    if v in _IRREGULAR_PRESENT_3SG:
        return _IRREGULAR_PRESENT_3SG[v]
    if re.match(r"^[a-z]*[^aeiou]y$", v):
        return v[:-1] + "ies"
    if re.match(r"^[a-z]+(s|sh|ch|x|z|o)$", v):
        return v + "es"
    if re.match(r"^[a-z]+$", v):
        return v + "s"
    return None


# The bounded set of verbs this module will recognize as a genuine verb
# when scanning a word list for a subject/verb boundary. Deliberately NOT
# exhaustive — a real verb outside this set is treated as "no known verb
# found here" and the input is declined (NOT_NLI_APPLICABLE), never guessed.
_KNOWN_VERBS = frozenset(
    {
        "improve",
        "reduce",
        "increase",
        "decrease",
        "cause",
        "outperform",
        "differ",
        "find",
        "show",
        "report",
        "begin",
        "use",
        "cover",
        "predict",
        "support",
        "contradict",
        "prove",
        "exist",
        "occur",
        "change",
        "produce",
        "help",
        "worsen",
        "narrow",
        "widen",
        "recommend",
        "require",
        "need",
        "allow",
        "indicate",
        "suggest",
        "demonstrate",
        "establish",
        "confirm",
        "reveal",
        "explain",
        "discuss",
        "address",
        "identify",
        "measure",
        "test",
        "compare",
        "flag",
        "score",
        "boost",
        "harm",
        "affect",
        "impact",
        # complement-taking verbs ("claim THAT X", "argue THAT X") — added
        # after this module's own smoke test caught "Does the report claim
        # the instruments predict X?" mis-selecting the embedded clause's
        # own verb ("predict") as the main verb, since "claim" wasn't
        # recognized. Embedded-clause complementation beyond this small
        # set remains a disclosed limitation (Milestone 9 report §23), not
        # a case this module claims to solve in general.
        "claim",
        "state",
        "argue",
        "conclude",
        "believe",
    }
)
_COMPARATIVE_VERBS = frozenset({"outperform", "exceed", "surpass", "underperform"})
_COMPARATIVE_PREDICATE_MARKERS = ("than", "compared to", "compared with", "versus", " vs ")

# Predicate-trigger words for BE-verb sentences ("Was X PREDICATE?") — the
# subject is everything BEFORE the first of these; a purely numeric token
# also always starts a predicate. Deliberately a curated, bounded list
# (comparative/evaluative adjectives and past participles common in this
# domain), same "known word, not guessed" principle as _KNOWN_VERBS.
_PREDICATE_TRIGGERS = frozenset(
    {
        # comparative/evaluative adjectives
        "significantly",
        "different",
        "similar",
        "higher",
        "lower",
        "larger",
        "smaller",
        "greater",
        "less",
        "more",
        "consistent",
        "sufficient",
        "insufficient",
        "effective",
        "present",
        "absent",
        "based",
        "associated",
        "correlated",
        "responsible",
        "required",
        "necessary",
        "true",
        "false",
        "correct",
        "accurate",
        "significant",
        "positive",
        "negative",
        "null",
        "statistically",
        # pre-participle adverbs — without these, a leading adverb (e.g.
        # "Was X fully blinded?") is swept into the SUBJECT rather than the
        # predicate; this module's own smoke test caught exactly this bug
        # ("The formative-assessment study fully was blinded..."). Adding
        # the adverb itself as a trigger keeps the whole "adverb + participle"
        # span together on the predicate side, in original word order.
        "well",
        "fully",
        "clearly",
        "explicitly",
        "already",
        "still",
        "directly",
        "consistently",
        "primarily",
        "solely",
        "exclusively",
        "generally",
        "typically",
        "actually",
        "genuinely",
        "truly",
        "completely",
        "entirely",
        "largely",
        "mostly",
        "rarely",
        "never",
        "always",
        "often",
        "sometimes",
        "randomly",
        "specifically",
    }
)
# Past participles this module will confidently treat as a predicate
# trigger for BE-verb sentences ("Was X ___ed?"). Deliberately a CURATED
# list, not a blind "-ed"/"-en" suffix match: an earlier version matched
# any word ending in -ed, which misfired on attributive adjectives inside
# the SUBJECT itself (e.g. "the STRUCTURED literacy intervention" —
# "structured" ends in -ed but is part of the subject noun phrase, not
# the predicate verb) — caught by this module's own smoke test and
# reverted in favor of this explicit, bounded list (same "known word, not
# guessed" principle as _KNOWN_VERBS).
_KNOWN_PARTICIPLES = frozenset(
    {
        "used",
        "found",
        "shown",
        "given",
        "reported",
        "measured",
        "tested",
        "studied",
        "blinded",
        "evaluated",
        "conducted",
        "administered",
        "assigned",
        "randomized",
        "identified",
        "controlled",
        "designed",
        "trained",
        "screened",
        "flagged",
        "compared",
        "assessed",
        "collected",
        "recorded",
        "observed",
        "confirmed",
        "validated",
        "replicated",
        "powered",
        "included",
        "excluded",
        "implemented",
        "delivered",
        "completed",
        "recruited",
        "judged",
    }
)
_PARTICIPLE_SUFFIX_RE = re.compile(r"^[a-z]+(ed|en)$")

# Determiners that, immediately before a _KNOWN_VERBS word, signal that
# word is being used as a NOUN in this position ("the increase", "the
# cause", "the use", "the support"), not a verb — several of this
# module's own verb-vocabulary words are noun/verb homographs (increase,
# decrease, cause, use, support, test, measure, change, help, impact,
# harm, boost, flag, score). This module's own smoke test caught "Does
# the increase in voluntary practice prove X?" being mis-split with
# "increase" treated as the verb; skipping a determiner-preceded
# candidate fixes it without needing real part-of-speech tagging.
_DETERMINERS = frozenset({"the", "a", "an", "this", "that", "these", "those", "any", "some", "no"})

# Signals that a word right after "and" starts a whole SECOND CLAUSE
# (rather than continuing a compound object) — see _try_do_support's
# and-conjunction handling.
_CLAUSE_START_AUX = frozenset(
    {
        "was",
        "were",
        "is",
        "are",
        "did",
        "does",
        "do",
        "has",
        "have",
        "had",
        "will",
        "would",
        "can",
        "could",
        "should",
    }
)
_CLAUSE_START_PRONOUNS = frozenset({"it", "he", "she", "they", "this", "that"})


def _is_determiner(word: str) -> bool:
    """Case-sensitive for the single letter 'a'/'A': a lowercase "a" is the
    indefinite article ("a study"), but an uppercase standalone "A" is a
    group/condition label ("Group A", "Study A") — collapsing case would
    make "Did Group A outperform Group B?" wrongly skip "outperform" as
    determiner-preceded (this module's own smoke test caught exactly this
    regression when the fix was first applied case-insensitively). Every
    other determiner is checked case-insensitively as normal, since "The"
    at a sentence's start is unambiguous."""
    if word == "A":
        return False
    return word.lower() in _DETERMINERS


def _find_verb_split(words: list[str]) -> tuple[list[str], str, int] | None:
    """Scans `words` left-to-right for the first token that is a
    recognized verb AND not immediately preceded by a determiner (see
    _is_determiner). Returns (subject_words, verb, index_of_verb) or None
    if no known verb appears anywhere in the list — the caller must then
    decline (NOT_NLI_APPLICABLE), never guess a split point."""
    for i, word in enumerate(words):
        bare = re.sub(r"[^A-Za-z]", "", word).lower()
        if bare not in _KNOWN_VERBS:
            continue
        if i > 0 and _is_determiner(words[i - 1]):
            continue
        return words[:i], bare, i
    return None


def _find_predicate_start(words: list[str]) -> int | None:
    """Scans `words` left-to-right for the first predicate-trigger word, a
    curated known participle (see _KNOWN_PARTICIPLES — deliberately NOT a
    blind -ed/-en suffix match; that was tried and reverted, see that
    set's own docstring), or a purely numeric token. Returns its index, or
    None if none found (the caller must then decline rather than guess a
    split point)."""
    for i, word in enumerate(words):
        bare = re.sub(r"[^A-Za-z]", "", word).lower()
        if (
            bare in _PREDICATE_TRIGGERS
            or bare in _KNOWN_PARTICIPLES
            or re.match(r"^\d+(\.\d+)?%?$", word.strip(".,"))
        ):
            return i
    return None


def _capitalize_sentence(text: str) -> str:
    text = text.strip()
    if not text:
        return text
    return text[0].upper() + text[1:]


def _join(words: list[str]) -> str:
    return " ".join(words).strip()


# ---------------------------------------------------------------------------
# Bypass detection (Milestone 9 §10) — checked first, before any pattern
# match is attempted.
# ---------------------------------------------------------------------------

_BYPASS_PREFIXES = (
    "summarize",
    "compare",
    "design",
    "explain",
    "describe",
    "discuss",
    "outline",
    "brainstorm",
    "create",
    "develop",
    "propose",
    "write",
    "list",
    "give me",
    "how should",
    "how can",
    "how do i",
    "how would",
    "what are the major",
    "what are the implications",
    "what implications",
)


def _looks_like_bypass_request(question: str) -> bool:
    lowered = question.strip().lower()
    return any(lowered.startswith(prefix) for prefix in _BYPASS_PREFIXES)


# ---------------------------------------------------------------------------
# Pattern 1: DO-support boolean/comparative/multi-claim questions —
# "Did/Does/Do X [not] V Y [and V2 Y2]?"
# ---------------------------------------------------------------------------

_DO_AUX_RE = re.compile(r"^(Did|Does|Do)\s+(.*?)\s*\?$", re.IGNORECASE)


def _try_do_support(question: str) -> TransformationResult | None:
    match = _DO_AUX_RE.match(question.strip())
    if match is None:
        return None
    aux = match.group(1).lower()
    body = match.group(2).strip()
    if not body:
        return None
    words = body.split(" ")

    negated = False
    # Negation marker: a standalone "not" appearing anywhere before the
    # verb is detected during the verb scan itself (below), since "not"
    # never collides with a _KNOWN_VERBS entry.
    split = _find_verb_split(words)
    if split is None:
        return None
    subject_words, verb, verb_idx = split
    if subject_words and subject_words[-1].lower() == "not":
        negated = True
        subject_words = subject_words[:-1]
    if not subject_words:
        return None
    rest_words = words[verb_idx + 1 :]

    # Cross-subject "while"-conjoined multi-document comparisons are
    # deliberately declined (Milestone 9 §9/§23), not attempted — a
    # disclosed coverage gap, not a silent mis-transformation.
    if any(w.lower() == "while" for w in rest_words):
        return None

    # Same-subject "and"-conjoined multi-claim split (§8): only if the
    # word right after " and " is ALSO a recognized verb — never split on
    # a plain compound object ("reading and math scores").
    and_index = next((i for i, w in enumerate(rest_words) if w.lower() == "and"), None)
    if and_index is not None and not negated:
        after_and = rest_words[and_index + 1 :]
        split2 = _find_verb_split(after_and)
        if split2 is not None and split2[2] == 0:  # verb2 must be the FIRST word after "and"
            obj1_words = rest_words[:and_index]
            verb2 = split2[1]
            obj2_words = after_and[1:]
            claim1 = _build_claim(subject_words, aux, False, verb, obj1_words)
            claim2 = _build_claim(subject_words, aux, False, verb2, obj2_words)
            if claim1 and claim2:
                return TransformationResult(
                    True, "MULTI_CLAIM", (claim1, claim2), "do_support_and_split"
                )

        # The multi-claim split didn't fire. If what follows "and" looks
        # like the start of a WHOLE SECOND CLAUSE (its own auxiliary or
        # pronoun subject — "...and was it cost-effective?") rather than a
        # plain compound object ("...and math scores"), this module has no
        # safe way to combine the two into one well-formed declarative —
        # falling through to the single-claim path below would silently
        # embed the leftover interrogative fragment verbatim (caught live
        # by this module's own smoke test: "Did the intervention improve
        # scores and was it cost-effective?" produced the garbled
        # "The intervention improved scores and was it cost-effective." —
        # not a valid declarative sentence). Decline instead.
        if after_and:
            first_after_and = after_and[0].lower()
            if first_after_and in _CLAUSE_START_AUX or first_after_and in _CLAUSE_START_PRONOUNS:
                return None

    claim = _build_claim(subject_words, aux, negated, verb, rest_words)
    if claim is None:
        return None
    rest_text = _join(rest_words).lower()
    category: RoutingCategory = (
        "COMPARATIVE_CLAIM"
        if verb in _COMPARATIVE_VERBS or any(m in rest_text for m in _COMPARATIVE_PREDICATE_MARKERS)
        else "BOOLEAN_CLAIM"
    )
    reason = "do_support_negated" if negated else "do_support_affirmative"
    return TransformationResult(True, category, (claim,), reason)


def _build_claim(
    subject_words: list[str], aux: str, negated: bool, verb: str, rest_words: list[str]
) -> str | None:
    subject = _join(subject_words)
    rest = _join(rest_words)
    if negated:
        # "did not V" / "does not V" — main verb stays in base form, no
        # conjugation attempted, no polarity risk (Milestone 9 §6).
        aux_word = aux if aux in ("did", "does") else "do"
        pieces = [p for p in (subject, aux_word, "not", verb, rest) if p]
        return _capitalize_sentence(" ".join(pieces)) + "."
    if aux == "did":
        conjugated = _past_tense(verb)
    elif aux == "does":
        # "Does" signals a singular subject -> 3rd-person-singular present
        # ("Does the paper report X?" -> "The paper reports X.").
        conjugated = _present_3sg(verb)
    else:
        # "Do" signals a plural (or "you"/"I") subject -> base form, no
        # -s ending ("Do the instruments predict X?" -> "The instruments
        # predict X.", not "predicts" — a real subject-verb-agreement bug
        # this module's own smoke test caught before this fix).
        conjugated = verb
    if conjugated is None:
        return None
    pieces = [p for p in (subject, conjugated, rest) if p]
    return _capitalize_sentence(" ".join(pieces)) + "."


# ---------------------------------------------------------------------------
# Pattern 2: BE-verb boolean questions — "Was/Were X [not] PREDICATE?" and
# "Is/Are X [not] PREDICATE?"
# ---------------------------------------------------------------------------

_BE_AUX_RE = re.compile(r"^(Was|Were|Is|Are)\s+(.*?)\s*\?$", re.IGNORECASE)


def _try_be_verb(question: str) -> TransformationResult | None:
    match = _BE_AUX_RE.match(question.strip())
    if match is None:
        return None
    aux = match.group(1).lower()
    body = match.group(2).strip()
    if not body:
        return None
    words = body.split(" ")

    idx = _find_predicate_start(words)
    if idx is None or idx == 0:
        return None  # no recognized predicate trigger, or nothing before it to be the subject
    subject_words = words[:idx]
    negated = subject_words[-1].lower() == "not" if subject_words else False
    if negated:
        subject_words = subject_words[:-1]
    if not subject_words:
        return None
    predicate_words = words[idx:]
    subject = _join(subject_words)
    predicate = _join(predicate_words)

    tense = "past" if aux in ("was", "were") else "present"
    if tense == "present":
        first_word = re.sub(r"[^A-Za-z]", "", predicate_words[0]).lower()
        is_participle = first_word in _KNOWN_PARTICIPLES or bool(
            _PARTICIPLE_SUFFIX_RE.match(first_word)
        )
        be_word = ("was" if aux == "is" else "were") if is_participle else aux
    else:
        be_word = aux

    if negated:
        claim = _capitalize_sentence(f"{subject} {be_word} not {predicate}") + "."
        reason = "be_verb_negated"
    else:
        claim = _capitalize_sentence(f"{subject} {be_word} {predicate}") + "."
        reason = "be_verb_affirmative"

    category: RoutingCategory = (
        "COMPARATIVE_CLAIM"
        if any(m in predicate.lower() for m in _COMPARATIVE_PREDICATE_MARKERS)
        else "BOOLEAN_CLAIM"
    )
    return TransformationResult(True, category, (claim,), reason)


# ---------------------------------------------------------------------------
# Pattern 3: presupposition extraction (Milestone 9 §5)
# ---------------------------------------------------------------------------

_HOW_MUCH_MANY_AUX_RE = re.compile(r"^How\s+(?:much|many)\s+did\s+(.*?)\s*\?$", re.IGNORECASE)
_WHY_DID_AUX_RE = re.compile(r"^Why\s+did\s+(.*?)\s*\?$", re.IGNORECASE)
_WHEN_DID_AUX_RE = re.compile(r"^When\s+did\s+(.*?)\s*\?$", re.IGNORECASE)
_WHAT_CAUSED_TO_RE = re.compile(
    r"^What\s+caused\s+(.+?)\s+to\s+([A-Za-z]+)\s*(.*?)\s*\?$", re.IGNORECASE
)
_EMBEDDED_CLAUSE_RE = re.compile(
    r"^What (?:evidence|data|results?) (?:shows?|demonstrates?|indicates?|suggests?)\s+"
    r"(?:that\s+)?(?P<clause>.+?)\s*\?$",
    re.IGNORECASE,
)


def _try_presupposition_did_family(question: str) -> TransformationResult | None:
    for pattern, reason in (
        (_HOW_MUCH_MANY_AUX_RE, "presupposition_how_much_many"),
        (_WHY_DID_AUX_RE, "presupposition_why_did"),
        (_WHEN_DID_AUX_RE, "presupposition_when_did"),
    ):
        match = pattern.match(question)
        if match is None:
            continue
        body = match.group(1).strip()
        if not body:
            return None
        words = body.split(" ")
        split = _find_verb_split(words)
        if split is None:
            return None
        subject_words, verb, verb_idx = split
        if not subject_words:
            return None
        rest_words = words[verb_idx + 1 :]
        past = _past_tense(verb)
        if past is None:
            return None
        pieces = [p for p in (_join(subject_words), past, _join(rest_words)) if p]
        claim = _capitalize_sentence(" ".join(pieces)) + "."
        return TransformationResult(True, "PRESUPPOSITION_CLAIM", (claim,), reason)
    return None


def _try_presupposition(question: str) -> TransformationResult | None:
    stripped = question.strip()

    match = _EMBEDDED_CLAUSE_RE.match(stripped)
    if match is not None:
        clause = match.group("clause").strip()
        if clause:
            return TransformationResult(
                True,
                "PRESUPPOSITION_CLAIM",
                (f"{_capitalize_sentence(clause)}.",),
                "embedded_clause_extraction",
            )

    result = _try_presupposition_did_family(stripped)
    if result is not None:
        return result

    match = _WHAT_CAUSED_TO_RE.match(stripped)
    if match is not None:
        subject = match.group(1).strip()
        verb = match.group(2).strip().lower()
        rest = match.group(3).strip()
        if verb not in _KNOWN_VERBS:
            return None
        past = _past_tense(verb)
        if past is None:
            return None
        pieces = [p for p in (subject, past, rest) if p]
        claim = _capitalize_sentence(" ".join(pieces)) + "."
        return TransformationResult(
            True, "PRESUPPOSITION_CLAIM", (claim,), "presupposition_what_caused"
        )

    return None


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

_PATTERN_FUNCS = (_try_do_support, _try_be_verb, _try_presupposition)


def classify_and_transform(question: str) -> TransformationResult:
    """The single entry point. Tries bypass detection first, then each
    pattern matcher in a fixed priority order, and falls through to
    NOT_NLI_APPLICABLE if nothing matches confidently — never a guess."""
    stripped = question.strip()
    if not stripped:
        return TransformationResult(False, "NOT_NLI_APPLICABLE", (), "empty_question")
    if _looks_like_bypass_request(stripped):
        return TransformationResult(False, "NOT_NLI_APPLICABLE", (), "bypass_keyword_match")
    if not stripped.endswith("?"):
        return TransformationResult(False, "NOT_NLI_APPLICABLE", (), "not_a_question")

    for pattern_func in _PATTERN_FUNCS:
        result = pattern_func(stripped)
        if result is not None:
            return result

    return TransformationResult(False, "NOT_NLI_APPLICABLE", (), "no_pattern_matched")
