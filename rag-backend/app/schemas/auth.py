from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.core.email_normalization import MAX_EMAIL_LENGTH, is_valid_email_format, normalize_email
from app.core.password_hashing import MAX_PASSWORD_LENGTH, validate_password_policy


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

    @field_validator("password")
    @classmethod
    def _validate_password_policy(cls, value: str) -> str:
        error = validate_password_policy(value)
        if error:
            raise ValueError(error)
        return value

    @field_validator("display_name")
    @classmethod
    def _blank_display_name_means_none(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        return stripped or None


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
