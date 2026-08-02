"""Covers app/config.py's refuse_dev_email_backend_in_production — the
startup guard (called from app/main.py's create_app()) against deploying
with EMAIL_PROVIDER=console (the non-delivering dev backend) in
production. Imports only app.config, never app.main — importing app.main
triggers its own module-level `app = create_app()`, which would run this
exact check against this test process's real ambient environment.
"""

import pytest

from app.config import Settings, refuse_dev_email_backend_in_production

_TEST_JWT_SECRET = "test-only-secret-not-a-real-credential-32chars"


def _settings(**overrides: object) -> Settings:
    defaults: dict[str, object] = {"jwt_secret": _TEST_JWT_SECRET}
    defaults.update(overrides)
    return Settings(**defaults)  # type: ignore[arg-type]


def test_refuses_console_backend_in_production() -> None:
    settings = _settings(app_env="production", email_provider="console")
    with pytest.raises(RuntimeError, match="EMAIL_PROVIDER=console"):
        refuse_dev_email_backend_in_production(settings)


def test_allows_smtp_backend_in_production() -> None:
    settings = _settings(app_env="production", email_provider="smtp", smtp_host="smtp.example.com")
    refuse_dev_email_backend_in_production(settings)  # must not raise


def test_allows_console_backend_outside_production() -> None:
    for app_env in ("development", "test"):
        settings = _settings(app_env=app_env, email_provider="console")
        refuse_dev_email_backend_in_production(settings)  # must not raise
