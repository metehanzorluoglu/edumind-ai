from collections.abc import Generator
from functools import lru_cache

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import get_settings


@lru_cache
def get_engine() -> Engine:
    settings = get_settings()
    # SQLite's default same-thread check would reject the connection created
    # in one worker thread being used from another — FastAPI's threadpool for
    # sync routes makes that the normal case here, not an edge case.
    connect_args = (
        {"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}
    )
    return create_engine(settings.database_url, connect_args=connect_args)


@lru_cache
def get_session_factory() -> sessionmaker[Session]:
    # expire_on_commit=False: route handlers commonly return an ORM object
    # (or values read off one) right after committing — expiring attributes
    # on commit would force a needless extra SELECT for data we already have.
    return sessionmaker(bind=get_engine(), autoflush=False, expire_on_commit=False)


def get_db() -> Generator[Session]:
    db = get_session_factory()()
    try:
        yield db
    finally:
        db.close()
