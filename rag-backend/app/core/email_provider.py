"""Outbound email delivery abstraction for account-verification (and any
future password-reset) mail. Routes and services never talk to SMTP or a
vendor API directly — only to the `EmailProvider` protocol below — so
adding or swapping a provider later never touches a route. See
app/deps.py's get_email_provider for the settings-driven factory, and
app/config.py's Settings for why `EMAIL_PROVIDER=console` is refused
outright at startup whenever `APP_ENV=production`.
"""

import logging
import smtplib
import ssl
from email.message import EmailMessage
from typing import Protocol

logger = logging.getLogger(__name__)


class EmailDeliveryError(Exception):
    """Raised by any EmailProvider.send() on transient delivery failure.
    Callers (see app/core/verification_service.py) must handle this
    without ever leaving an account permanently unable to receive a fresh
    verification email — registration still succeeds even if the send
    itself fails, and resend remains available."""


class EmailProvider(Protocol):
    def send(self, *, to: str, subject: str, html_body: str, text_body: str) -> None: ...


class ConsoleEmailProvider:
    """Development-only backend — never actually delivers anything. Logs
    only the subject and recipient at INFO level; the message body (which
    may carry a verification link/token-bearing URL) is never logged by
    this class — see verification_service.py, which separately logs just
    the verification URL itself under its own explicit, intentional log
    line, never routed through here. Hard-refused whenever
    `APP_ENV=production` (see app/config.py's Settings validator, which
    fails application startup outright) so this can never become
    "verification emails are silently never delivered" in production.
    """

    def send(self, *, to: str, subject: str, html_body: str, text_body: str) -> None:
        logger.info("[dev email backend] would send %r to %s (not actually sent)", subject, to)


class SmtpEmailProvider:
    """Sends real mail via SMTP (stdlib `smtplib` — no extra dependency).
    Synchronous/blocking by design, matching every other route in
    app/api/routes_auth.py (plain `def`, not `async def`) — FastAPI runs a
    sync route in its threadpool, so a blocking SMTP call here behaves
    exactly like this app's other blocking I/O (SQLite, Ollama's sync
    client) already does."""

    def __init__(
        self,
        *,
        host: str,
        port: int,
        username: str,
        password: str,
        use_tls: bool,
        from_name: str,
        from_address: str,
    ) -> None:
        self._host = host
        self._port = port
        self._username = username
        self._password = password
        self._use_tls = use_tls
        self._from_name = from_name
        self._from_address = from_address

    def send(self, *, to: str, subject: str, html_body: str, text_body: str) -> None:
        message = EmailMessage()
        message["Subject"] = subject
        message["From"] = f"{self._from_name} <{self._from_address}>"
        message["To"] = to
        message.set_content(text_body)
        message.add_alternative(html_body, subtype="html")

        try:
            with smtplib.SMTP(self._host, self._port, timeout=10) as client:
                if self._use_tls:
                    client.starttls(context=ssl.create_default_context())
                if self._username:
                    client.login(self._username, self._password)
                client.send_message(message)
        except (smtplib.SMTPException, OSError) as exc:
            # Never logs the message body (a verification link) or any
            # SMTP credential — only that delivery failed and why, at a
            # level an operator will actually see.
            logger.error("SMTP send to %s failed: %s", to, exc)
            raise EmailDeliveryError(str(exc)) from exc
