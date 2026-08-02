from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from app.core.email_normalization import MAX_EMAIL_LENGTH, is_valid_email_format, normalize_email
from app.core.password_policy import MAX_PASSWORD_LENGTH, validate_password_policy


class ProviderInfo(BaseModel):
    provider: str
    display_name: str


class ProvidersResponse(BaseModel):
    providers: list[ProviderInfo]
    # Surfaces to the frontend whether POST /auth/dev-login is available at
    # all, without exposing a real provider's configuration state — the
    # frontend uses this (together with its own build-time
    # EXPO_PUBLIC_DEV_LOGIN_ENABLED flag) to decide whether to show the
    # dev-login button.
    dev_login_enabled: bool
    # Whether POST /auth/register and POST /auth/login are available at
    # all (app/config.py's auth_local_login_enabled) — deliberately a
    # separate signal from `providers` (which only ever lists *OAuth*
    # providers): an empty `providers` list must never be read by the
    # frontend as "no authentication available" when this is true. See
    # app/api/routes_auth.py's get_providers.
    local_auth_enabled: bool


class UserResponse(BaseModel):
    id: str
    email: str
    display_name: str | None = None
    avatar_url: str | None = None
    is_dev_test_user: bool = False
    # Which account this user signed in with: "google" / "facebook" /
    # "linkedin" for a real OAuth login, "dev" for a POST /auth/dev-login
    # test account (see upsert_dev_test_user), or None only if a user
    # somehow has no linked OAuthAccount row at all. Surfaced so the
    # Settings screen can show "Signed in with Google" instead of just an
    # email address.
    provider: str | None = None


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_in: int
    user: UserResponse


class SessionExchangeRequest(BaseModel):
    auth_code: str = Field(min_length=1)


class RefreshRequest(BaseModel):
    # Optional: web clients rely on the HttpOnly refresh cookie instead and
    # may send no body at all; native clients always send this explicitly
    # (RN's fetch has no persistent cookie jar to rely on).
    refresh_token: str | None = None


class LogoutRequest(BaseModel):
    refresh_token: str | None = None


class DevLoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    display_name: str | None = None


class RegisterRequest(BaseModel):
    email: str = Field(min_length=1, max_length=MAX_EMAIL_LENGTH)
    password: str = Field(min_length=1, max_length=MAX_PASSWORD_LENGTH)
    display_name: str | None = Field(default=None, max_length=255)

    @field_validator("email")
    @classmethod
    def _normalize_and_validate_email(cls, value: str) -> str:
        normalized = normalize_email(value)
        if not is_valid_email_format(normalized):
            raise ValueError("Enter a valid email address.")
        return normalized

    @field_validator("display_name")
    @classmethod
    def _blank_display_name_means_none(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        return stripped or None

    @model_validator(mode="after")
    def _validate_password_policy(self) -> "RegisterRequest":
        # Cross-field (needs the already-normalized email + display_name),
        # so this runs as a model validator, not a per-field one — see
        # app/core/password_policy.py for the full rule set. Joins every
        # violated rule into one message so a client that isn't running
        # the mirrored live checklist still sees the complete picture in
        # one 422, not just the first rule that happened to fail.
        errors = validate_password_policy(
            self.password, normalized_email=self.email, display_name=self.display_name
        )
        if errors:
            raise ValueError(" ".join(error.message for error in errors))
        return self


class LoginRequest(BaseModel):
    email: str = Field(min_length=1, max_length=MAX_EMAIL_LENGTH)
    password: str = Field(min_length=1, max_length=MAX_PASSWORD_LENGTH)

    @field_validator("email")
    @classmethod
    def _normalize_email(cls, value: str) -> str:
        # Deliberately does NOT validate format here (unlike
        # RegisterRequest) — a malformed email at login must fail with the
        # same generic "Invalid email or password" as any other wrong
        # credential (see POST /auth/login), never a distinguishable 422
        # that would leak "this address is at least well-formed."
        return normalize_email(value)


class RegisterResponse(BaseModel):
    """POST /auth/register's response — always this one shape (never a
    plain TokenResponse), so the frontend/SDK never has to branch on which
    shape it got. `email_verification_required` tells the caller which
    half of this model is populated:
    - True (the default — see Settings.auth_email_verification_required):
      no tokens yet; `access_token`/`refresh_token`/`user` are all None.
      The frontend sends the user to /check-email.
    - False (an operator explicitly disabled verification): behaves like
      every other login path — tokens and `user` are populated
      immediately, exactly as POST /auth/register used to before this
      feature existed.
    """

    email_verification_required: bool
    message: str
    access_token: str | None = None
    refresh_token: str | None = None
    token_type: Literal["bearer"] = "bearer"
    expires_in: int | None = None
    user: UserResponse | None = None


class ResendVerificationRequest(BaseModel):
    email: str = Field(min_length=1, max_length=MAX_EMAIL_LENGTH)

    @field_validator("email")
    @classmethod
    def _normalize_email(cls, value: str) -> str:
        # Same reasoning as LoginRequest — never format-validated, so a
        # malformed address gets the exact same generic response as any
        # other input (see POST /auth/resend-verification's "never reveal
        # whether the address is registered" requirement).
        return normalize_email(value)


class GenericMessageResponse(BaseModel):
    """A deliberately uninformative response shape — currently only
    POST /auth/resend-verification, which must never let its response
    shape/content vary with whether the account exists, is already
    verified, or is OAuth-only."""

    detail: str
