import type { ReactElement } from 'react';
import Svg, { Path } from 'react-native-svg';

/**
 * Recognizable, official-brand-colored icons for the OAuth provider
 * buttons on the login screen (see app/login.tsx) — one component per
 * provider this backend supports (see rag-backend's
 * app/core/oauth_providers.py's _PROVIDER_NAMES), plus a generic fallback
 * for any future provider this app doesn't have a dedicated mark for yet.
 * Built with react-native-svg (already a transitive dependency of this
 * Expo project — no new package added) rather than an icon font, so
 * these render identically on web, iOS, and Android.
 */

const ICON_SIZE = 18;

export function GoogleIcon() {
  return (
    <Svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 48 48">
      <Path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 8 3l5.7-5.7C33.9 6.1 29.2 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.7-.4-3.5z"
      />
      <Path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8C14.6 15.9 18.9 13 24 13c3.1 0 5.8 1.1 8 3l5.7-5.7C33.9 6.1 29.2 4 24 4c-7.4 0-13.8 4.1-17.1 10.1z"
      />
      <Path
        fill="#4CAF50"
        d="M24 44c5.1 0 9.8-2 13.2-5.2l-6.1-5.2C29.2 35.5 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.1 39.9 15.9 44 24 44z"
      />
      <Path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.2 4.2-4.1 5.6l6.1 5.2C40.9 36.6 44 30.9 44 24c0-1.3-.1-2.7-.4-3.5z"
      />
    </Svg>
  );
}

export function FacebookIcon() {
  return (
    <Svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24">
      <Path
        fill="#1877F2"
        d="M24 12.07C24 5.41 18.63 0 12 0S0 5.41 0 12.07C0 18.1 4.39 23.09 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.96.93-1.96 1.89v2.25h3.33l-.53 3.49h-2.8V24C19.61 23.09 24 18.1 24 12.07z"
      />
    </Svg>
  );
}

export function LinkedInIcon() {
  return (
    <Svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24">
      <Path
        fill="#0A66C2"
        d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.34V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.07 2.07 0 1 1 0-4.13 2.07 2.07 0 0 1 0 4.13zM7.12 20.45H3.56V9h3.56v11.45z"
      />
    </Svg>
  );
}

export function GenericProviderIcon() {
  return (
    <Svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24">
      <Path
        fill="#64748B"
        d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 3a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zm0 14.2a7.2 7.2 0 0 1-6-3.22c.03-2 4-3.1 6-3.1s5.97 1.1 6 3.1a7.2 7.2 0 0 1-6 3.22z"
      />
    </Svg>
  );
}

/** Maps a backend provider slug (see GET /auth/providers) to its icon —
 * unknown providers fall back to GenericProviderIcon rather than
 * rendering nothing, so a future provider this app hasn't been updated
 * for yet still gets a recognizable (if generic) mark. */
export function providerIcon(provider: string): ReactElement {
  switch (provider) {
    case 'google':
      return <GoogleIcon />;
    case 'facebook':
      return <FacebookIcon />;
    case 'linkedin':
      return <LinkedInIcon />;
    default:
      return <GenericProviderIcon />;
  }
}
