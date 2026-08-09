"""Milestone 11 (Evidence Service & Shadow Infrastructure Implementation)
§5 — the wire contract. Kept deliberately small ("smallest clean
contract" per the milestone spec): one claim, up to
Settings.max_sources_per_claim sources, classified in one batched model
call.

A single-claim-per-request shape (rather than a list-of-claims envelope)
was chosen deliberately: it matches the milestone spec's own example
schema field-for-field, and "max claims per backend request: 2" (Milestone
10 §9) is naturally enforced by the CALLER making at most 2 such requests
per chat turn (see app/core/evidence_eligibility.py's
DEFAULT_MAX_NLI_CLAIMS on the backend side) rather than needing this
service to track any multi-claim envelope state — see app/config.py's
Settings.max_sources_per_claim docstring for the same reasoning."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator

WireLabel = Literal["ENTAILMENT", "NEUTRAL", "CONTRADICTION"]


class SourceInput(BaseModel):
    source_id: str = Field(min_length=1, max_length=32)
    text: str = Field(min_length=1)


class ClassifyBatchRequest(BaseModel):
    claim: str = Field(min_length=1)
    sources: list[SourceInput] = Field(min_length=1)

    @field_validator("sources")
    @classmethod
    def _source_ids_unique(cls, sources: list[SourceInput]) -> list[SourceInput]:
        ids = [s.source_id for s in sources]
        if len(ids) != len(set(ids)):
            raise ValueError("source_id values must be unique within one request")
        return sources


class SourceProbabilities(BaseModel):
    entailment: float
    neutral: float
    contradiction: float


class SourceResult(BaseModel):
    source_id: str
    label: WireLabel
    probabilities: SourceProbabilities


class ClassifyBatchResponse(BaseModel):
    results: list[SourceResult]
    model_id: str
    model_revision: str
    latency_ms: float


class HealthResponse(BaseModel):
    status: Literal["ready", "loading", "error"]
    ready: bool
    model_id: str
    model_revision: str
    #: Present only once loading has failed — never any prediction/claim/
    #: source content, matching Milestone 10 §39's health-endpoint
    #: privacy contract.
    error: str | None = None


class ErrorResponse(BaseModel):
    """Milestone 11 §5's "Do not return internal stack traces" contract —
    every error path (validation, overload, timeout, internal error)
    returns this shape, never a raw exception string or traceback."""

    error: str
    detail: str
