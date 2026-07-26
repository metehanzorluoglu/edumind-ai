import re

from pydantic import BaseModel

from app.core.citation import Citation

_CITATION_PATTERN = re.compile(r"\[S(\d+)\]")
_BRACKET_TOKEN_PATTERN = re.compile(r"\[[^\[\]]{1,20}\]")
_MALFORMED_CANDIDATE_PATTERN = re.compile(r"^\[\s*[Ss]?\s*\d*\s*\]$")


def _citation_sort_key(source_id: str) -> int:
    return int(source_id[1:])


class CitationValidationResult(BaseModel):
    cited_source_ids: list[str]
    unknown_source_ids: list[str]
    malformed_tokens: list[str]
    warnings: list[str]

    @property
    def is_valid(self) -> bool:
        return not self.unknown_source_ids and not self.malformed_tokens


def validate_citations(answer: str, citations: list[Citation]) -> CitationValidationResult:
    """Checks an answer's [S#] citations against the sources actually offered
    to the model. Two independent problems are detected:

    - unknown_source_ids: well-formed [S#] tokens whose number was never
      retrieved (the model could not have gotten this from the given context).
    - malformed_tokens: bracketed tokens that look like a citation attempt
      (digits, optionally an S) but don't match the required [S<number>]
      shape — e.g. [1], [S], [s3]. Ordinary bracketed text unrelated to
      citations (e.g. "[Table 1]") does not match this narrow pattern and is
      correctly left alone."""
    known_ids = {citation.source_id for citation in citations}

    cited = [f"S{match.group(1)}" for match in _CITATION_PATTERN.finditer(answer)]
    unknown = sorted(
        {source_id for source_id in cited if source_id not in known_ids}, key=_citation_sort_key
    )

    malformed = [
        token
        for token in _BRACKET_TOKEN_PATTERN.findall(answer)
        if not _CITATION_PATTERN.fullmatch(token) and _MALFORMED_CANDIDATE_PATTERN.match(token)
    ]

    warnings: list[str] = []
    if unknown:
        warnings.append(
            f"Answer cites source id(s) not present in the retrieved sources: {', '.join(unknown)}"
        )
    if malformed:
        warnings.append(f"Answer contains malformed citation syntax: {', '.join(malformed)}")

    return CitationValidationResult(
        cited_source_ids=sorted(set(cited), key=_citation_sort_key),
        unknown_source_ids=unknown,
        malformed_tokens=malformed,
        warnings=warnings,
    )
