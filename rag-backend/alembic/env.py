from logging.config import fileConfig

from sqlalchemy import engine_from_config, pool

from alembic import context

# Import every models_* module so its tables register on Base.metadata
# before autogenerate/create_all inspects it — a module that's never
# imported never contributes tables, regardless of inheriting from Base.
from app.config import get_settings
from app.db import (
    models_auth,  # noqa: F401
    models_conversation_scope,  # noqa: F401
    models_conversations,  # noqa: F401
    models_documents,  # noqa: F401
    models_project_knowledge,  # noqa: F401
    models_projects,  # noqa: F401
    models_research_preferences,  # noqa: F401
    models_scopes,  # noqa: F401
    models_writing,  # noqa: F401
)
from app.db.base import Base

# this is the Alembic Config object, which provides
# access to the values within the .ini file in use.
config = context.config

# Interpret the config file for Python logging.
# This line sets up loggers basically.
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Overrides alembic.ini's placeholder sqlalchemy.url with the app's own
# Settings.database_url, so migrations always target whatever DB the app
# itself is configured for (env var / .env), never a value hardcoded in
# version-controlled ini file.
config.set_main_option("sqlalchemy.url", get_settings().database_url)

target_metadata = Base.metadata

# other values from the config, defined by the needs of env.py,
# can be acquired:
# my_important_option = config.get_main_option("my_important_option")
# ... etc.


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode.

    This configures the context with just a URL
    and not an Engine, though an Engine is acceptable
    here as well.  By skipping the Engine creation
    we don't even need a DBAPI to be available.

    Calls to context.execute() here emit the given string to the
    script output.

    """
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode.

    In this scenario we need to create an Engine
    and associate a connection with the context.

    """
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
