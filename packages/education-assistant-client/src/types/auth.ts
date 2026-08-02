/**
 * Hand-written to mirror app/schemas/auth.py exactly — like types/chat.ts,
 * these endpoints aren't OpenAPI-generated (the auth flow involves
 * redirects and cookies that don't reduce cleanly to a request/response
 * schema pair). Keep in sync by hand if app/schemas/auth.py changes.
 */

export interface AuthProviderInfo {
  provider: string;
  display_name: string;
}

/** The raw GET /auth/providers wire shape — snake_case, exactly as
 * app/schemas/auth.py serializes it. Never consumed directly outside
 * EducationAssistantClient.getAuthProviders(): that method normalizes this
 * into AuthProviders (below) once, at the API boundary, so no other layer
 * of the app has to know the wire response is snake_case or re-derive its
 * own "is dev login actually enabled" check. */
export interface AuthProvidersResponse {
  providers: AuthProviderInfo[] | null | undefined;
  dev_login_enabled: unknown;
  /** Whether POST /auth/register and POST /auth/login are available at
   * all — see app/config.py's auth_local_login_enabled. Deliberately a
   * separate signal from `providers` (which only ever lists *OAuth*
   * providers): an empty `providers` array must never be read as "no
   * authentication available" when this is true. */
  local_auth_enabled: unknown;
}

/**
 * The normalized, camelCase shape EducationAssistantClient.getAuthProviders()
 * actually returns. `providers` defaults to `[]` (never null/undefined),
 * `devLoginEnabled`/`localAuthEnabled` are only ever `true` for a strict
 * boolean `true` in the wire response — anything else (missing field, `1`,
 * `"true"`, etc.) is treated as disabled, never silently coerced truthy.
 */
export interface AuthProviders {
  providers: AuthProviderInfo[];
  devLoginEnabled: boolean;
  localAuthEnabled: boolean;
}

export interface AuthUser {
  id: string;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  is_dev_test_user: boolean;
  /** "google" / "facebook" / "linkedin" for a real OAuth login, "dev" for a POST /auth/dev-login test account, or null if this user somehow has no linked account at all. */
  provider: string | null;
}

export interface AuthTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: 'bearer';
  expires_in: number;
  user: AuthUser;
}

/** POST /auth/register's request body — see app/schemas/auth.py's
 * RegisterRequest. `password` is never logged or echoed back by this SDK
 * (see EducationAssistantClient.register). */
export interface RegisterRequestBody {
  email: string;
  password: string;
  display_name?: string | null;
}

/** POST /auth/login's request body — see app/schemas/auth.py's
 * LoginRequest. */
export interface LoginRequestBody {
  email: string;
  password: string;
}
