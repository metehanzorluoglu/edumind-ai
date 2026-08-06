import { ScrollViewStyleReset } from 'expo-router/html';
import { type PropsWithChildren } from 'react';

/**
 * Root HTML document for the web static export. Runs once in Node during
 * static rendering (see expo-router's static-rendering docs) — no browser
 * APIs here. This is the one place that owns tab title, favicon, PWA
 * manifest, and Open Graph tags; nothing else in the app can set these for
 * a statically-rendered page.
 *
 * Favicon: the "E8" mark — brand/BRAND_GUIDELINES.md's single source of
 * truth (assets/brand/e8-icon.svg). Unlike the previous magnifying-glass
 * symbol, this glyph is bold and simple enough to stay legible all the
 * way down to 16px on its own, so every favicon size below is rendered
 * directly from the same master SVG rather than a separately simplified
 * construction.
 *
 * FAVICON_VERSION: bump this (and rename the matching files in public/)
 * any time the favicon art changes. nginx serves everything under
 * public/ with a 1-year immutable cache (deploy/frontend/nginx.conf) —
 * intentional for content-hashed JS/CSS bundles, but favicon-*.png/svg
 * are NOT content-hashed by Expo, so without a version bump a redeploy
 * ships new bytes at the same old URL and browsers/CDNs that already
 * cached the old ones under that URL have no reason to ever refetch.
 * This is exactly what caused the "old icon after redeploy" bug this
 * fixed — see brand/BRAND_GUIDELINES.md's favicon section / the fix
 * writeup for the full root-cause trace. og-image.png is now versioned
 * the same way (previously wasn't — this rebrand is exactly the
 * scenario that gap would have broken: a stale cached OG image forever
 * showing the old mark).
 *
 * Also note the plain `/favicon.ico` link below is NOT auto-injected by
 * Expo's static export the way it would be if public/favicon.ico didn't
 * exist (see @expo/cli's export/favicon.js — it only self-generates one
 * from `expo.web.favicon` in app.json when no user-defined
 * public/favicon.ico is present, appending it as the literal last tag
 * in <head>, after everything below). Shipping our own
 * public/favicon.ico keeps that generator a no-op, so there's exactly
 * one favicon declaration in the page, not two competing ones.
 */
const FAVICON_VERSION = 'v2';
export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />

        <title>EduM8 — Education Research Assistant</title>
        <meta
          name="description"
          content="Your private AI workspace for learning and research, grounded in the documents you upload."
        />

        {/* Favicon — SVG first (scales cleanly at any tab/bookmark size), PNG
            fallback family, .ico last for anything that still wants it (see
            FAVICON_VERSION doc above for why /favicon.ico has no ?v= — it's
            a fixed conventional path, kept fresh via nginx cache rules
            instead). Every OTHER href below is version-tagged specifically
            so a redeploy is guaranteed to be a new URL, not just new bytes
            at an old, possibly still-cached one. */}
        <link rel="icon" href={`/favicon-${FAVICON_VERSION}.svg`} type="image/svg+xml" />
        <link
          rel="icon"
          href={`/favicon-32-${FAVICON_VERSION}.png`}
          sizes="32x32"
          type="image/png"
        />
        <link
          rel="icon"
          href={`/favicon-16-${FAVICON_VERSION}.png`}
          sizes="16x16"
          type="image/png"
        />
        <link
          rel="alternate icon"
          href={`/favicon-48-${FAVICON_VERSION}.png`}
          sizes="48x48"
          type="image/png"
        />
        <link rel="icon" href="/favicon.ico" sizes="48x48" type="image/x-icon" />
        <link rel="apple-touch-icon" href={`/apple-touch-icon-${FAVICON_VERSION}.png`} />

        {/* PWA */}
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#4F46E5" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#14161F" media="(prefers-color-scheme: dark)" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="EduM8" />

        {/* Open Graph / social preview */}
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="EduM8" />
        <meta property="og:title" content="EduM8 — Education Research Assistant" />
        <meta
          property="og:description"
          content="Your private AI workspace for learning and research, grounded in the documents you upload."
        />
        <meta property="og:image" content={`/og-image-${FAVICON_VERSION}.png`} />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="EduM8 — Education Research Assistant" />
        <meta
          name="twitter:description"
          content="Your private AI workspace for learning and research, grounded in the documents you upload."
        />
        <meta name="twitter:image" content={`/og-image-${FAVICON_VERSION}.png`} />

        <ScrollViewStyleReset />
      </head>
      <body>{children}</body>
    </html>
  );
}
