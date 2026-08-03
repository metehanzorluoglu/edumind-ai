"""Covers app/core/intent_detection.py — general instructional-design
intent detection, not a lookup of any specific exact prompt (see the
module docstring). Cases below intentionally include prompts this
detector was never written against, to prove that."""

import pytest

from app.core.intent_detection import is_instructional_design_request

POSITIVE_CASES = [
    "Design a lesson flow using: determine a problem with a daily-life story, "
    "determine research questions to understand the topic, and design a product.",
    "Create a learning sequence where students identify a real-world problem from daily life, "
    "formulate guiding research questions, and develop a solution prototype.",
    "Can you help me design a classroom activity about machine learning bias?",
    "Write a curriculum for teaching computational thinking to elementary students.",
    "I need a lesson plan on photosynthesis for 4th graders.",
    "Please develop a unit plan covering data privacy for high schoolers.",
    "Help me build a teaching sequence introducing neural networks.",
    "Draft an instructional unit on AI ethics for middle school.",
]

NEGATIVE_CASES = [
    "What does the literature say about lesson study in Japan?",
    "Summarize the findings on AI literacy in K-12 education.",
    "What is the accuracy reported for the model in this study?",
    "How many participants were in the Shamir 2026 study?",
    "Compare the methodologies used across these three papers.",
    "",
    "   ",
]


@pytest.mark.parametrize("query", POSITIVE_CASES)
def test_detects_instructional_design_requests(query: str) -> None:
    assert is_instructional_design_request(query) is True


@pytest.mark.parametrize("query", NEGATIVE_CASES)
def test_does_not_flag_ordinary_research_questions(query: str) -> None:
    assert is_instructional_design_request(query) is False
