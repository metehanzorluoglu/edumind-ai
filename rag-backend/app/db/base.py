from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    """Shared declarative base — every ORM model in app/db/models_*.py inherits
    from this so Alembic's autogenerate and a single `Base.metadata.create_all`
    (used by tests) both see the full schema regardless of which models_*
    module happens to get imported first."""
