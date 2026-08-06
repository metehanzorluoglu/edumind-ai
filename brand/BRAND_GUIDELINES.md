# EduM8 Brand Guidelines
*Version 2.0 — August 2026*

This document is the single source of truth for the EduM8 mark: a rounded-square "E8" icon (indigo→blue gradient) paired with the "EduM8" wordmark, set in the product's own bold sans. **This supersedes v1.0's magnifying-glass mark wholesale** — that identity is retired, not just refreshed; every touchpoint listed in §7 has been repointed at the new mark, and no v1 asset should be reintroduced anywhere.

All production assets referenced below live in `examples/expo-education-assistant/assets/brand/` (the app's own vendored copy — this is a monorepo-internal brand, not a separately distributed asset package) and `examples/expo-education-assistant/public/` (web favicon/PWA family).

---

## 1. Brand Philosophy

EduM8 is "E8" — a compact, confident wordmark-as-icon, not a pictogram. The mark doesn't try to *illustrate* what the product does (research, evidence, search); it identifies the product the way Linear's spiral or Vercel's triangle do — a single, memorable geometric form that earns recognition through consistency and repetition rather than literal meaning.

**What the mark communicates:**

| Element | Meaning |
|---|---|
| Rounded-square container | Modern, app-native, friendly-but-serious — the same "squircle" language iOS/Android/most SaaS product icons converged on |
| "E8" (EduM8, compressed) | A confident, ownable initialism — reads instantly as this product's, not a generic education/AI icon |
| Indigo → blue gradient | Trust and intelligence, with enough warmth (via the indigo end) to avoid reading as cold/corporate |
| Bold grotesk wordmark | Product-forward and contemporary — the wordmark is typography-as-identity, not an editorial/academic voice |

**What the mark should never become:** stretched, recolored, rotated, outlined, given a drop shadow/glow/bevel, or reinterpreted with different proportions. It's one gradient-filled rounded square with one glyph pair inside it — the entire system optimizes for *reads instantly, stays sharp at any size, never drifts*.

---

## 2. Logo System

### 2.1 The primary lockup

`EduM8Logo` (component: `examples/expo-education-assistant/components/EduM8Logo.tsx`)

The E8 icon + "EduM8" wordmark, set side by side with an 10px gap at default scale. This is the default logo for anywhere there's room: login page, splash, check-email/verify-email headers, marketing/social surfaces (`public/og-image-v2.png`).

### 2.2 The symbol (icon-only)

`EduM8Symbol` (same file) / `assets/brand/e8-icon.svg`

The rounded square + "E8" glyph pair works as a standalone mark with no wordmark attached — this is what makes it fit for favicons, app icons, avatars, and the nav rail. Unlike the v1 mark (which needed a *separately simplified* favicon construction — see v1 §5.1, superseded), this glyph pair is bold and simple enough that the exact same master SVG scales cleanly from 16px up to 1024px with no alternate construction.

### 2.3 Construction & geometry

- Container: a square, corner radius 22% of the edge length (rx/ry = 220 on a 1000×1000 viewBox) — a continuous "squircle," not a simple rounded rect with a small radius.
- Fill: `linear-gradient(135deg, #4F46E5 0%, #2563EB 100%)` — indigo at the top-left, blue at the bottom-right. This exact gradient is the mark's fill in every context; never substitute a flat color or a different angle/stop pair.
- Glyph: "E" and "8," white fill, both set at the same cap-height, horizontally centered as a pair with a fixed gap between them (not each letter independently centered). The glyph occupies roughly 75% of the container's width and 44% of its height, leaving generous, even margin on all sides — never stretched edge-to-edge.
- **Construction technique, and why it matters:** the E/8 outlines are not live text and not hand-traced — they're vector paths extracted directly from this app's own `HankenGrotesk_700Bold.ttf` via `fontTools` (see the extraction notes in `EduM8Logo.tsx`'s header comment). This is what makes the icon glyph and the live "EduM8" wordmark text guaranteed-identical letterforms, and what makes every exported PNG/favicon pixel-consistent regardless of what fonts happen to be installed on whatever machine or browser renders it.

### 2.4 What NOT to do

| Violation | Rule |
|---|---|
| Non-uniform scaling | Never stretch the icon off its 1:1 square aspect. |
| Recoloring | Never substitute a different gradient, a flat fill, or the wordmark's ink color outside what's specified in §3. |
| Rotation/tilt | Never rotate the icon or the lockup. |
| Low contrast | Never place the mark where its background defeats the white glyph (a busy photo, a similarly-saturated blue) — see §8 for the actual measured ratios. |
| Effects | Never add a drop shadow, glow, bevel, outline, or additional gradient stops beyond the two specified. |
| Recombination | Never separate the "E" from the "8," change their relative size, or set the wordmark in a different family than the icon's own glyph source (Hanken Grotesk Bold). |
| Pre-masking | Never pre-apply a rounded-rect/circle mask to an app-icon export — iOS/Android/PWA installers apply their own; see §5.2. |

### 2.5 Clear space

Minimum clear space on all sides = 20% of the icon's own height, referred to as **1x**. Nothing — text, UI chrome, other logos, the edge of the viewport — should enter that space. `EduM8Symbol`/`EduM8Logo`'s callers are responsible for their own surrounding padding; the component itself renders edge-to-edge with no baked-in margin, by design, so callers can control clear space precisely for their context (nav rail vs. login hero need different amounts).

### 2.6 Minimum size

| Asset | Floor | Below the floor |
|---|---|---|
| Full lockup (icon + wordmark) | 80px wide on screen | Drop the wordmark — use the icon alone |
| Icon alone | 16px | Do not go smaller — confirmed legible at 16×16 (see `public/favicon-16-v2.png`); this mark does not need the "detailed vs. favicon-optimized" split the v1 mark required |

### 2.7 Monochrome, dark mode, light mode

- **Icon:** identical in every context — the gradient fill has enough self-contained contrast (white glyph on indigo/blue, §8) that it never needs a mono/inverted variant. Same PNG/SVG bytes on a light page, a dark page, or the always-dark nav rail.
- **Wordmark:** rendered as live `Text` reading `theme.text`, which already flips between the app's light-mode near-black (`#14161F`) and dark-mode near-white (`#F0F0FB`) — this happens automatically via `EduM8Logo`'s own `useTheme()` call, not a separate asset variant. This is a deliberate improvement over v1's separate `logo-mono-ink.png`/`logo-mono-white.png` raster files: one component, no variant prop, always correct.
- **Email (no live theme available):** the transactional-email wordmark is plain inline-styled HTML text, near-black (`#0F172A`) — see `rag-backend/app/core/email_templates.py`. Never an `<img>` of the mark in email: most mail clients block remote images by default, and a blocked-image icon is a worse first impression than no logo at all.

---

## 3. Color Palette

| Token | Hex | Role |
|---|---|---|
| **EduM8 Indigo** (gradient start) | `#4F46E5` | Icon fill (top-left of the 135° gradient), light-mode `theme-color` meta / PWA manifest `theme_color`. |
| **EduM8 Blue** (gradient end) | `#2563EB` | Icon fill (bottom-right of the gradient). |
| Ink (light mode) | `#14161F` | Wordmark text, dark-mode surfaces, nav rail. |
| Ink (dark mode text) | `#F0F0FB` | Wordmark text on dark surfaces. |
| Surface | `#F6F7FA` | Default app/workspace background, PWA manifest `background_color`. |
| Surface (elevated) | `#FFFFFF` | Cards, canvas, the glyph's fill color inside the icon. |

The icon is exactly two colors (the gradient's two stops) plus white for the glyph — never a third hue. This mark does not use an accent/secondary color the way v1's amber/ochre pair did; citation/warning/etc. UI colors are a *product* token concern (`lib/Preferences.tsx`'s `ThemePalette`), entirely separate from the logo now.

### 3.1 Do not

- Introduce a third color into the icon fill, or change the gradient's angle/stops.
- Recolor the wordmark to anything other than `theme.text` (or the email template's fixed `#0F172A`) — it should never be brand-blue, for instance; the reference sheet this mark is drawn from consistently uses plain ink/white for the wordmark, reserving color for the icon alone.
- Screen/tint the gradient into a pastel background wash — if a page needs a brand-colored surface accent, use the product's own `theme.accentSoft` token, not a diluted version of the logo gradient.

---

## 4. Typography

| Role | Typeface | Notes |
|---|---|---|
| Icon glyph + wordmark | **Hanken Grotesk** (Bold, 700) | The mark's *entire* typographic identity — both the baked-in E/8 icon glyph and the live "EduM8" wordmark text come from this one family/weight, guaranteeing they always match. |
| Editorial display / headlines (product UI, unrelated to the logo) | **Source Serif 4** | Still the app's own heading/display face for page titles, empty states, etc. — unchanged by this rebrand. The mark itself no longer uses it (v1's wordmark was serif; v2's is not), but the rest of the product's editorial voice is untouched. |
| UI & body copy | **Hanken Grotesk** (Regular–SemiBold) | Unchanged. |
| Meta / mono | **JetBrains Mono** | Unchanged — citation numbers, timestamps, technical metadata. |

No new font family or weight was added for this rebrand — the wordmark reuses `HankenGrotesk_700Bold.ttf`, already vendored in `assets/fonts/` for the app's own bold UI text (buttons, section headers). See that file's own docs for why weights are vendored individually rather than pulled from `@expo-google-fonts/*`.

---

## 5. Icon System

### 5.1 Favicon specification

Unlike v1 (which needed a geometrically-simplified favicon construction because the serif "8" collapsed below 48px — see the retired v1 §5.1), this mark's bold sans glyph stays legible all the way to 16×16 with **no alternate construction**. Every favicon size renders from the exact same master, `assets/brand/e8-icon.svg`.

Source: `assets/brand/e8-icon.svg` → rasterized to `public/favicon-16-v2.png`, `favicon-32-v2.png`, `favicon-48-v2.png`, `favicon-64-v2.png`, `favicon.ico` (multi-resolution), `apple-touch-icon-v2.png` (180×180), `icon-192-v2.png`, `icon-512-v2.png`.

```html
<link rel="icon" href="/favicon-v2.svg" type="image/svg+xml" />
<link rel="icon" href="/favicon-32-v2.png" sizes="32x32" type="image/png" />
<link rel="icon" href="/favicon-16-v2.png" sizes="16x16" type="image/png" />
<link rel="icon" href="/favicon.ico" sizes="48x48" type="image/x-icon" />
<link rel="apple-touch-icon" href="/apple-touch-icon-v2.png" />
```

**Cache-busting convention:** every favicon/OG filename carries a `-v2` (etc.) suffix — see `app/+html.tsx`'s `FAVICON_VERSION` constant. nginx caches everything under `public/` for a year; Expo's web export does not content-hash these filenames the way it does JS/CSS bundles, so a redeploy that changes the *bytes* at an unversioned path (like this rebrand!) would otherwise sit behind stale CDN/browser caches indefinitely. Bump `FAVICON_VERSION` (and rename the matching `public/` files) any time this art changes again.

### 5.2 App icon / adaptive icon specification

| Platform | Export | Source |
|---|---|---|
| iOS / generic app icon | 1024×1024, full-bleed rounded-square icon | `assets/images/icon.png` |
| Android adaptive icon — foreground | 512×512, glyph only, transparent bg, glyph confined to ~66% safe zone | `assets/images/android-icon-foreground.png` |
| Android adaptive icon — background | 512×512, gradient fill only, no glyph | `assets/images/android-icon-background.png` |
| Android 13+ themed (monochrome) icon | 432×432, white glyph silhouette, transparent bg (OS applies its own tint) | `assets/images/android-icon-monochrome.png` |
| PWA / web manifest | 192×192, 512×512, plus a 512×512 maskable variant (full-bleed square bg, glyph pulled further in for the OS's own circular crop) | `public/icon-192-v2.png`, `icon-512-v2.png`, `icon-512-maskable-v2.png` |
| Native splash screen | Icon + wordmark stacked, transparent bg, on the app's `#F6F7FA` splash background | `assets/images/splash-icon.png` |

Do not add a rounded-rect or circle mask yourself for iOS/PWA icons (the OS applies its own) — the Android *adaptive* icon is the one legitimate exception, where the platform expects pre-split foreground/background layers rather than one flat image.

---

## 6. Spacing Rules

- **Clear space:** 1x on all sides, where 1x = 20% of the icon's rendered height (§2.5).
- **Icon-to-wordmark gap** in the primary lockup: fixed at 10px at the component's default scale (`EduM8Logo`'s `styles.lockup` gap), scaling with the `size` prop's proportions in practice since callers generally scale both together.
- **Grid alignment:** the icon is a true square with the glyph pair optically centered inside it (see §2.3) — align its bounding-box center to surrounding UI grids; unlike v1's off-center handle, no optical-vs-bounding-box correction is needed.

---

## 7. Usage Across Touchpoints

| Touchpoint | Component / Asset | Notes |
|---|---|---|
| Favicon / browser tab | `favicon-v2.svg` + PNG/ICO family | §5.1. SVG first, PNG fallback, `.ico` last. |
| Mobile app icon (iOS/Android) | `assets/images/icon.png` + adaptive icon layers | §5.2. |
| Loading / splash screens | `EduM8Symbol`, at rest, paired with a separate `ActivityIndicator` | The mark itself never spins/pulses — see `EduM8Logo.tsx`'s own docs. Native splash (before JS loads) uses the static `assets/images/splash-icon.png` composition (icon + wordmark) instead. |
| Nav rail (desktop web) | `EduM8Symbol`, icon-only | `components/NavRail.tsx` — the rail is always-dark regardless of app theme; the icon's own colors work unchanged there. |
| Conversation drawer header | `EduM8Symbol` + plain "EduM8" text | `components/ConversationSidebar.tsx` — same always-dark rail treatment. |
| Login page | `EduM8Logo` (hero, wide layout) / `EduM8Logo` (card, narrow layout — hero's own logo covers wide layouts, so the card only shows its own copy above ~980px to avoid repeating the mark) | `app/login.tsx`, `components/LoginHero.tsx`. |
| Check-email / verify-email screens | `EduM8Logo` | `app/check-email.tsx`, `app/verify-email.tsx`. |
| Empty states | `EduM8Symbol` (default icon, overridable) | `components/ui/EmptyState.tsx`. |
| Transactional email | Plain styled text "EduM8," not an image (§2.7) | `rag-backend/app/core/email_templates.py`. |
| Open Graph / social preview | Static composed image, icon + wordmark + tagline | `public/og-image-v2.png`, referenced from `app/+html.tsx`. |

---

## 8. Accessibility Recommendations

Measured contrast ratios (WCAG 2.1, sRGB):

| Pair | Ratio | Passes |
|---|---|---|
| White glyph on `#4F46E5` (gradient start) | 6.3:1 | AA normal text ✓, AA large/UI-component AAA ✓ |
| White glyph on `#2563EB` (gradient end) | 5.2:1 | AA normal text ✓ |
| `#4F46E5` on white (e.g. `theme-color`/manifest swatches, the OG image's accent bar) | 6.3:1 | AA normal text ✓ |
| Wordmark ink `#14161F` on light surfaces (`#F6F7FA`/`#FFFFFF`) | >15:1 | AAA ✓ |
| Wordmark ink `#F0F0FB` on dark surface (`#14161F`) | >15:1 | AAA ✓ |

The icon's glyph-on-gradient contrast is comfortably better across its *entire* range than v1's mark was at its worst point (v1's amber "8" measured 2.3:1 on white, logo-exemption-only) — both ends of the new gradient clear AA normal-text thresholds even though the logo exemption means they technically don't have to.

**Rules of thumb:**
1. The logo itself is exempt from text-contrast rules (standard WCAG logo exception) — this mark clears them anyway (see above), which was a design goal, not a requirement.
2. Never rely on the mark's color alone to convey product state — it identifies the product, nothing else.
3. Maintain the 1x clear space (§2.5) so the mark is never crowded by low-contrast neighboring elements.

---

## 9. Source Files

```
examples/expo-education-assistant/
├── assets/
│   ├── brand/
│   │   └── e8-icon.svg              master vector — every other export derives from this
│   ├── images/
│   │   ├── icon.png                 1024×1024, app icon
│   │   ├── favicon.png              48×48, Expo web config fallback
│   │   ├── splash-icon.png          icon + wordmark, transparent bg
│   │   ├── android-icon-foreground.png
│   │   ├── android-icon-background.png
│   │   └── android-icon-monochrome.png
│   └── fonts/
│       └── HankenGrotesk_700Bold.ttf   source of both the icon glyph paths and the live wordmark text
├── public/
│   ├── favicon-v2.svg / favicon-{16,32,48,64}-v2.png / favicon.ico
│   ├── apple-touch-icon-v2.png
│   ├── icon-192-v2.png / icon-512-v2.png / icon-512-maskable-v2.png
│   ├── og-image-v2.png
│   └── manifest.json
└── components/
    └── EduM8Logo.tsx                 EduM8Symbol / EduM8Logo — the only place the mark's JSX lives
```

**Retired v1 assets** (magnifying-glass mark, deleted — do not resurrect): `brand/final/*.png`, `brand/source/edum8-logo-original.png`, `public/favicon-v1.svg` and its PNG family, `public/og-image.png` (unversioned). If any of these are still referenced anywhere outside this repo (marketing site CMS, app store listings, printed material), replace them with the assets listed above.
