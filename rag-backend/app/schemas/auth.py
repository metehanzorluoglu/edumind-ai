from typing import Literal

from pydantic import BaseModel, Field


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
