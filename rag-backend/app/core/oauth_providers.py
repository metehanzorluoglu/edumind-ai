"""Per-provider OAuth 2.0 / OpenID Connect configuration and identity
verification. Every provider funnels through the same shape:
`build_authorize_url()` to send the user to the provider, then
`fetch_verified_identity()` to exchange the returned code and produce a
`VerifiedIdentity` — the only thing `app/core/auth_service.py` ever sees.
No provider access/refresh token is ever persisted or returned past this
module; once identity is confirmed, this app has no further use for them.
"""

from dataclasses import dataclass
from urllib.parse import urlencode

import httpx
import jwt
from jwt import PyJWKClient

from app.config import Settings


@dataclass(frozen=True)
class VerifiedIdentity:
    """One provider's confirmed identity for a login attempt. `email` is
    None when the provider didn't return one at all (e.g. Facebook without
    the email permission granted, or no verified email on the account) —
    callers must handle that case explicitly, never fabricate a
    placeholder address. `email_verified` is only ever True when the
    provider itself asserts the address is verified.
    """

    provider: str
    provider_account_id: str
    email: str | None
    email_verified: bool
    display_name: str | None
    avatar_url: str | None


@dataclass(frozen=True)
class ProviderConfig:
    name: str
    display_name: str
    client_id: str
    client_secret: str
    redirect_uri: str
    authorize_url: str
    scopes: str


class OAuthProviderError(Exception):
    """Any failure while talking to or verifying a provider — a bad/expired
    code, an unreachable provider, or an identity that fails verification.
    Never includes the client secret, access token, or authorization code
    in its message (see app/api/routes_auth.py's logging)."""


_GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
_GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
_GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"
_GOOGLE_ISSUERS = {"https://accounts.google.com", "accounts.google.com"}

_FACEBOOK_AUTHORIZE_URL = "https://www.facebook.com/v19.0/dialog/oauth"
_FACEBOOK_TOKEN_URL = "https://graph.facebook.com/v19.0/oauth/access_token"
_FACEBOOK_ME_URL = "https://graph.facebook.com/v19.0/me"

_LINKEDIN_AUTHORIZE_URL = "https://www.linkedin.com/oauth/v2/authorization"
_LINKEDIN_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken"
_LINKEDIN_USERINFO_URL = "https://api.linkedin.com/v2/userinfo"

_HTTP_TIMEOUT_SECONDS = 10.0


def get_provider_config(provider: str, settings: Settings) -> ProviderConfig | None:
    """Returns None for an unknown provider name, or a known provider whose
    client_id is blank (not configured) — both cases the caller should
    treat identically: this provider is not offered right now."""
    if provider == "google":
        client_id, client_secret, redirect_uri = (
            settings.google_client_id,
            settings.google_client_secret,
            settings.google_redirect_uri,
        )
        authorize_url = _GOOGLE_AUTHORIZE_URL
        scopes = "openid email profile"
        display_name = "Google"
    elif provider == "facebook":
        client_id, client_secret, redirect_uri = (
            settings.facebook_client_id,
            settings.facebook_client_secret,
            settings.facebook_redirect_uri,
        )
        authorize_url = _FACEBOOK_AUTHORIZE_URL
        scopes = "email public_profile"
        display_name = "Facebook"
    elif provider == "linkedin":
        client_id, client_secret, redirect_uri = (
            settings.linkedin_client_id,
            settings.linkedin_client_secret,
            settings.linkedin_redirect_uri,
        )
        authorize_url = _LINKEDIN_AUTHORIZE_URL
        scopes = "openid profile email"
        display_name = "LinkedIn"
    else:
        return None

    if not client_id or not client_secret or not redirect_uri:
        return None

    return ProviderConfig(
        name=provider,
        display_name=display_name,
        client_id=client_id,
        client_secret=client_secret,
        redirect_uri=redirect_uri,
        authorize_url=authorize_url,
        scopes=scopes,
    )


def build_authorize_url(config: ProviderConfig, *, state: str, code_challenge: str) -> str:
    params = {
        "client_id": config.client_id,
        "redirect_uri": config.redirect_uri,
        "response_type": "code",
        "scope": config.scopes,
        "state": state,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
    }
    if config.name == "google":
        # access_type=offline/prompt=consent are deliberately NOT set — this
        # app never needs a Google refresh token (see module docstring), so
        # never asks the user to grant offline access.
        params["nonce"] = state
    return f"{config.authorize_url}?{urlencode(params)}"


def fetch_verified_identity(
    config: ProviderConfig, *, code: str, code_verifier: str, client: httpx.Client
) -> VerifiedIdentity:
    if config.name == "google":
        return _google_identity(config, code=code, code_verifier=code_verifier, client=client)
    if config.name == "facebook":
        return _facebook_identity(config, code=code, code_verifier=code_verifier, client=client)
    if config.name == "linkedin":
        return _linkedin_identity(config, code=code, code_verifier=code_verifier, client=client)
    raise OAuthProviderError(f"Unknown provider '{config.name}'")


def _post_token_request(
    url: str, *, config: ProviderConfig, code: str, code_verifier: str, client: httpx.Client
) -> dict[str, object]:
    try:
        response = client.post(
            url,
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": config.redirect_uri,
                "client_id": config.client_id,
                "client_secret": config.client_secret,
                "code_verifier": code_verifier,
            },
            headers={"Accept": "application/json"},
            timeout=_HTTP_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise OAuthProviderError(f"{config.display_name} token exchange failed") from exc
    body = response.json()
    if not isinstance(body, dict):
        raise OAuthProviderError(
            f"{config.display_name} token exchange returned an unexpected body"
        )
    return body


def _google_identity(
    config: ProviderConfig, *, code: str, code_verifier: str, client: httpx.Client
) -> VerifiedIdentity:
    token_body = _post_token_request(
        _GOOGLE_TOKEN_URL, config=config, code=code, code_verifier=code_verifier, client=client
    )
    id_token = token_body.get("id_token")
    if not isinstance(id_token, str):
        raise OAuthProviderError("Google token response is missing id_token")

    try:
        jwk_client = PyJWKClient(_GOOGLE_JWKS_URL)
        signing_key = jwk_client.get_signing_key_from_jwt(id_token)
        claims = jwt.decode(
            id_token,
            signing_key.key,
            algorithms=["RS256"],
            audience=config.client_id,
            options={"require": ["exp", "iss", "aud", "sub"]},
        )
    except jwt.PyJWTError as exc:
        raise OAuthProviderError("Google id_token failed verification") from exc

    if claims.get("iss") not in _GOOGLE_ISSUERS:
        raise OAuthProviderError("Google id_token has an unexpected issuer")

    sub = claims.get("sub")
    if not isinstance(sub, str):
        raise OAuthProviderError("Google id_token is missing sub")

    return VerifiedIdentity(
        provider="google",
        provider_account_id=sub,
        email=claims.get("email") if isinstance(claims.get("email"), str) else None,
        email_verified=bool(claims.get("email_verified", False)),
        display_name=claims.get("name") if isinstance(claims.get("name"), str) else None,
        avatar_url=claims.get("picture") if isinstance(claims.get("picture"), str) else None,
    )


def _facebook_identity(
    config: ProviderConfig, *, code: str, code_verifier: str, client: httpx.Client
) -> VerifiedIdentity:
    token_body = _post_token_request(
        _FACEBOOK_TOKEN_URL, config=config, code=code, code_verifier=code_verifier, client=client
    )
    access_token = token_body.get("access_token")
    if not isinstance(access_token, str):
        raise OAuthProviderError("Facebook token response is missing access_token")

    try:
        response = client.get(
            _FACEBOOK_ME_URL,
            params={"fields": "id,name,email,picture", "access_token": access_token},
            timeout=_HTTP_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise OAuthProviderError("Facebook profile lookup failed") from exc
    profile = response.json()
    if not isinstance(profile, dict) or not isinstance(profile.get("id"), str):
        raise OAuthProviderError("Facebook profile response is missing id")

    picture = profile.get("picture")
    avatar_url = None
    if isinstance(picture, dict):
        picture_data = picture.get("data")
        if isinstance(picture_data, dict) and isinstance(picture_data.get("url"), str):
            avatar_url = picture_data["url"]

    email = profile.get("email")
    return VerifiedIdentity(
        provider="facebook",
        provider_account_id=profile["id"],
        # Facebook only ever returns `email` for an account with a
        # confirmed address, and only when the user granted the `email`
        # permission — there is no separate "verified" flag to check, so
        # presence of the field is itself the verification signal here.
        email=email if isinstance(email, str) else None,
        email_verified=isinstance(email, str),
        display_name=profile.get("name") if isinstance(profile.get("name"), str) else None,
        avatar_url=avatar_url,
    )


def _linkedin_identity(
    config: ProviderConfig, *, code: str, code_verifier: str, client: httpx.Client
) -> VerifiedIdentity:
    token_body = _post_token_request(
        _LINKEDIN_TOKEN_URL, config=config, code=code, code_verifier=code_verifier, client=client
    )
    access_token = token_body.get("access_token")
    if not isinstance(access_token, str):
        raise OAuthProviderError("LinkedIn token response is missing access_token")

    try:
        response = client.get(
            _LINKEDIN_USERINFO_URL,
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=_HTTP_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise OAuthProviderError("LinkedIn userinfo lookup failed") from exc
    claims = response.json()
    if not isinstance(claims, dict) or not isinstance(claims.get("sub"), str):
        raise OAuthProviderError("LinkedIn userinfo response is missing sub")

    email = claims.get("email")
    return VerifiedIdentity(
        provider="linkedin",
        provider_account_id=claims["sub"],
        email=email if isinstance(email, str) else None,
        email_verified=bool(claims.get("email_verified", False))
        if isinstance(email, str)
        else False,
        display_name=claims.get("name") if isinstance(claims.get("name"), str) else None,
        avatar_url=claims.get("picture") if isinstance(claims.get("picture"), str) else None,
    )
