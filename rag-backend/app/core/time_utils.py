from datetime import UTC, datetime


def utcnow() -> datetime:
    return datetime.now(UTC)


def ensure_utc(value: datetime) -> datetime:
    """Normalizes a datetime read back from the DB to tz-aware UTC.

    SQLite's `DateTime(timezone=True)` column type stores an inserted UTC
    value correctly but strips `tzinfo` on read back (SQLite has no native
    timezone-aware datetime type) — PostgreSQL does not have this quirk and
    round-trips tz-aware values as-is. Every comparison against a
    DB-loaded datetime must go through this first, so token-expiry logic
    behaves identically on both dialects.
    """
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)
