import math


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return dot / (norm_a * norm_b)


def select_mmr[T](
    candidates: list[tuple[T, list[float], float]],
    *,
    top_k: int,
    relevance_weight: float = 0.7,
) -> list[T]:
    """Select up to top_k items from (item, vector, relevance_score) candidates
    using Maximal Marginal Relevance, trading off query relevance against
    similarity to already-selected items so results aren't near-duplicates."""
    remaining = list(candidates)
    selected: list[tuple[T, list[float], float]] = []

    while remaining and len(selected) < top_k:
        if not selected:
            best = max(remaining, key=lambda c: c[2])
        else:
            best = max(
                remaining,
                key=lambda c: (
                    relevance_weight * c[2]
                    - (1 - relevance_weight) * max(_cosine_similarity(c[1], s[1]) for s in selected)
                ),
            )
        selected.append(best)
        remaining.remove(best)

    return [item for item, _vector, _score in selected]
