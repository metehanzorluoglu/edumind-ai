# EduM8 Brand Guidelines
*Version 1.0 — August 2026*

This document is the single source of truth for the EduM8 mark: a blue magnifying glass with an orange "8" at its center, paired with the "edum8" wordmark. It refines the existing logo into production-ready assets without changing what the mark *is*. Colors and type are inherited from EduMind's existing product design system ("Marginalia") so the brand and the product feel like one thing, not two.

All production assets referenced below live in `brand/final/`.

---

## 1. Brand Philosophy

EduM8 is a magnifying glass, not a mascot. The mark says: *look closer, and you'll find the answer* — search, research, retrieval, evidence. That is the whole idea, and the entire logo system exists to protect it.

**What the mark communicates:**

| Element | Meaning |
|---|---|
| Magnifying glass | Research, search, retrieval, evidence, knowledge discovery |
| Orange "8" | EduM8 · infinite learning · continuous improvement · human + AI partnership |
| Blue | Trust, clarity, structure, the "primary" of the product |
| Orange | Warmth, curiosity, the human/discovery moment inside the search |
| Serif wordmark | Academic authority — a research tool, not a toy |

**What the mark should never become:** decorative, glossy, 3D, gradient-filled, or complex. Every design decision below optimizes for *reads instantly, survives at any size, ages well*. Think ChatGPT's sunburst, Claude's asterisk, Perplexity's compass, Linear's spiral — one shape, flat color, no ornament.

---

## 2. Logo System

### 2.1 The primary lockup

`brand/final/logo-primary.png` (also `-onwhite`, `-ondark`)

Magnifying glass (blue) + centered "8" (orange) + wordmark "edu" (blue) + "m8" (orange), set in a serif face. This is the default logo for anywhere there's room: website header, marketing pages, email signatures, decks, the app's logged-out shell.

### 2.2 The symbol (icon-only)

`brand/final/symbol.png`, `symbol-mono-ink.png`, `symbol-mono-white.png`

The magnifying glass + "8" work as a standalone mark with no wordmark attached — this is what makes them fit for favicons, app icons, avatars, and the nav rail. This is the single most important test the logo had to pass, and it does: the lens + "8" is legible and distinct on its own.

### 2.3 Construction & geometry

- The lens is a perfect circle; the handle extends from the bottom-right at roughly 45°, capped with a rounded end matching the ring's stroke weight.
- Stroke weight is constant across the ring and handle — no taper, no line-weight contrast. This is what keeps it "simple, timeless, GitHub/Linear-grade" rather than illustrative.
- The "8" is optically centered in the lens opening (not mathematically centered — its top counter is slightly smaller than its bottom counter, so true visual balance sits a hair above dead-center).
- Two colors only, ever: brand blue for the glass, brand orange for the "8." No third color, no outline, no drop shadow.

### 2.4 What NOT to do

See `brand/final/wrong_*.png` for rendered examples of each violation:

| File | Violation |
|---|---|
| `wrong_stretched.png` | Never scale non-uniformly. Lock the aspect ratio. |
| `wrong_color.png` | Never recolor the mark outside the brand palette. |
| `wrong_rotated.png` | Never rotate or tilt the lockup. |
| `wrong_contrast.png` | Never place the mark where it doesn't have ≥3:1 contrast against its background. |
| `wrong_shadow.png` | Never add drop shadows, glow, bevels, gradients, or 3D effects. |

Also prohibited, not pictured: outlining the mark, placing it inside a colored badge/chip of its own, separating the magnifying glass from the "8," or redrawing the "8" in a different typeface than the wordmark.

### 2.5 Clear space

Minimum clear space on all sides = the diameter of the lens **opening** (the inner circle where the "8" sits), referred to as **1x**. Nothing — text, UI chrome, other logos, the edge of the viewport — should enter that space.

```
┌───────────────────────────────┐
│         ↑ 1x clear space       │
│      ┌─────────────┐           │
│  ←1x │   🔍 edum8   │  1x→     │
│      └─────────────┘           │
│         ↓ 1x clear space       │
└───────────────────────────────┘
```

### 2.6 Minimum size

| Asset | Floor | Below the floor |
|---|---|---|
| Full lockup (symbol + wordmark) | 120px wide on screen / 25mm in print | Drop the wordmark — use the symbol alone |
| Symbol, detailed construction (typographic "8") | 48px | Switch to the favicon-optimized construction (§5) |
| Symbol, favicon-optimized construction | 16px | Do not go smaller |

This floor isn't arbitrary — we rendered the mark at 16/32/48/64px and the typographic "8" visibly degrades into a smudge below 48px (see §5). That single finding is why the favicon spec uses a different construction than the app icon.

### 2.7 Monochrome, dark mode, light mode

- **Light mode / on white:** full color (`logo-primary-onwhite.png`) — default everywhere.
- **Dark mode / on `#14161F`:** full color also works here (`logo-primary-ondark.png`) — both blue and orange clear WCAG non-text contrast (3:1) against the ink background, so no re-tinting is required for the *logo itself* (see §8 for why this doesn't extend to body text).
- **Monochrome (single-color contexts — stamps, engraving, fax, watermarks):** `logo-mono-ink.png` (dark ink on light) or `logo-mono-white.png` (white on dark). Never use a monochrome gray version — it's ink or white, nothing between.

---

## 3. Color Palette

Blue and orange are the only brand colors. No third accent should be introduced for the mark, marketing, or product chrome — that instruction from the brief is treated as a hard constraint, not a suggestion.

| Token | Hex | Role |
|---|---|---|
| **EduM8 Blue** (Primary) | `#2F5FE0` | Logo ink, primary UI actions, links, focus states. One blue, used identically in the logo and the product. |
| **EduM8 Amber** (Brand-mark accent) | `#DDA14B` | The "8," decorative/marketing use only — not for text on light backgrounds (see §8). |
| **EduM8 Ochre** (UI-safe secondary) | `#B0641F` | Citation markers, "AI grounding" badges, secondary text/icons on light surfaces — anywhere the orange accent needs to carry real text contrast. |
| Ink | `#14161F` | Monochrome logo, dark-mode surfaces, nav rail. |
| Surface | `#F6F7FA` | Default app/workspace background. |
| Surface (elevated) | `#FFFFFF` | Cards, canvas, the logo's "paper." |

**Why two oranges?** The amber used in the logo (`#DDA14B`) only reaches 2.3:1 contrast on white — good enough for a large graphic mark, not for text. Rather than dull the logo down to a WCAG-safe brown, we kept the amber for the mark and use the pre-existing product ochre (`#B0641F`, ~4.5:1 on white) wherever orange needs to function as text or a UI signal. Same relationship blue already has: one saturated logo blue, reused as-is for UI since it already clears 5.5:1 on white.

This is inherited directly from EduMind's existing "Marginalia" design system — nothing new was introduced, EduM8 just adopts it as the wordmark's official palette.

### 3.1 Do not

- Introduce a third primary color (green, purple, red, etc.) anywhere in the brand system.
- Use amber (`#DDA14B`) for body text, links, or anything requiring text-contrast compliance — use ochre (`#B0641F`) instead.
- Screen/tint the blue or amber into pastel "brand colors" for backgrounds — use the neutral surfaces instead.

---

## 4. Typography

Inherited wholesale from the EduMind product type system — EduM8 does not introduce a new typeface family, matching the "no additional primaries" rule applied to type.

| Role | Typeface | Notes |
|---|---|---|
| Display / headlines / wordmark | **Source Serif 4** (Semibold/Bold) | Academic, editorial, authoritative. Used for the "edum8" wordmark itself — set the wordmark in this family rather than a bespoke display face, so logo and headline type are the same instrument. |
| UI & body copy | **Hanken Grotesk** | Humanist sans, used for everything functional — buttons, nav, AI-generated content, paragraph text. Modern and quiet so the serif headlines keep their authority. |
| Meta / mono | **JetBrains Mono** | Citation numbers, keyboard shortcuts, timestamps, technical metadata. Reinforces the "research tool" feel in small doses. |

### 4.1 Type scale (ratio 1.25, Major Third)

| Style | Font | Size | Weight | Line height |
|---|---|---|---|---|
| H1 | Source Serif 4 | 3.052rem (2rem mobile) | 600 | 1.2 |
| H2 | Source Serif 4 | 2.441rem | 600 | 1.2 |
| H3 | Source Serif 4 | 1.953rem | 500 | 1.3 |
| Body — large | Hanken Grotesk | 1.25rem | 400 | 1.6 |
| Body — default | Hanken Grotesk | 1rem | 400 | 1.5 |
| UI label | Hanken Grotesk | 0.875rem | 500 | 1.4 |
| Meta / mono | JetBrains Mono | 0.75rem | 400 | 1.5, +0.02em tracking |

Body copy is optimized for a 72-character measure (`72ch` max-width), consistent with the product's reading-canvas width.

---

## 5. Icon System

### 5.1 Favicon specification

**Problem found during production:** the primary mark's "8" is set in a serif numeral with thin strokes and tight counters. At 16×16 and 32×32 it visually collapses — we rendered it and confirmed this before shipping a spec (see the pixel comparison in the artifact version of this guide). Shipping the detailed mark as a favicon would fail the brief's own "must remain recognizable at 16×16" requirement.

**Solution:** a favicon-specific construction — same two colors, same silhouette logic, but the "8" is rebuilt from two stacked circular rings (a geometric figure-8) instead of the typographic numeral, and both the ring and the "8" strokes are thickened. This is a legitimate simplification, not a redesign: it's still "blue magnifying glass, orange 8, nothing else," and the two-circle construction happens to reinforce the "infinite learning / continuous loop" meaning of the 8 even more directly than the typographic version.

Source: `brand/final/favicon.svg` — rasterized at `favicon-16.png`, `favicon-32.png`, `favicon-48.png`, `favicon-64.png`.

Use this construction for the entire favicon/`.ico` family (16/32/48/64), not just the smallest size — one consistent shape across the multi-resolution icon rather than switching designs mid-family.

```html
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png">
```

### 5.2 App icon specification

White background (`#FFFFFF`), the **detailed** primary symbol (typographic "8" — it's fine at these sizes) centered with generous margin (the mark occupies ~68% of the canvas width, matching iOS's own safe-zone convention so it isn't cropped by the OS's rounded-square/circle mask).

| Platform | Export size | Source |
|---|---|---|
| iOS (App Store + all device sizes, scale from) | 1024×1024 | `appicon-1024.png` |
| Android (adaptive icon foreground, scale from) | 512×512 | `appicon-512.png` |
| Web (PWA manifest) | 192×192, 180×180 (Apple touch icon) | `appicon-192.png`, `appicon-180.png` |

Do not add a rounded-rect or circle mask yourself — iOS, Android, and PWA installers all apply their own mask at install time. Shipping a pre-masked icon causes double-masking artifacts.

---

## 6. Spacing Rules

- **Clear space:** 1x on all sides, where 1x = the lens opening diameter (§2.5).
- **Symbol-to-wordmark gap** in the primary lockup: fixed at 0.35x (proportional to the lens diameter), never stretched or compressed independently of the whole lockup.
- **Grid alignment:** when placing the symbol in UI chrome (nav bar, buttons), align its optical center — not its bounding-box center — to the surrounding grid. The handle's extra visual weight in the bottom-right means true bounding-box centering reads as slightly-off.

---

## 7. Usage Across Touchpoints

| Touchpoint | Asset | Notes |
|---|---|---|
| Favicon / browser tab | `favicon.svg` + PNG family | §5.1. SVG first, PNG fallback. |
| Mobile app icon (iOS/Android) | `appicon-1024.png` | §5.2. White bg, no wordmark. |
| Loading screen | Symbol only, centered, at rest (no spin/pulse on the mark itself — animate a separate progress indicator around or below it, not the logo) | Keeps the mark's meaning ("evidence, trust") intact — an endlessly spinning magnifying glass reads as "broken," not "thinking." |
| Splash screen | Symbol only, on brand surface (`#F6F7FA` light / `#14161F` dark), scaled to ~20% of screen width | No wordmark needed once the app icon has already identified the app. |
| Navigation bar | Symbol only (or symbol + wordmark if the rail is wide enough to give it proper clear space) | Never crop the handle to force a tighter fit — drop the wordmark instead. |
| Login page | Full primary lockup, centered above the form | The one place the full lockup should always appear at a generous size — it's the user's first brand impression. |
| Website footer | Full lockup, monochrome-ink or full-color at small scale (≥120px, §2.6) | Pair with a one-line tagline in Hanken Grotesk, not Source Serif — footers are UI, not editorial. |

---

## 8. Accessibility Recommendations

Measured contrast ratios (WCAG 2.1, sRGB):

| Pair | Ratio | Passes |
|---|---|---|
| Blue `#2F5FE0` on white | 5.5:1 | AA normal text ✓, AAA large text ✓ |
| Blue `#2F5FE0` on ink `#14161F` | 3.3:1 | AA large text / non-text (logos, icons) only — **do not** set small body copy in this blue on dark surfaces; use a lighter tint (e.g. the product's `inverse-primary #B5C4FF`) for actual UI text |
| Amber `#DDA14B` on white | 2.3:1 | Logo/decorative use only — fails text contrast, don't use for text or icons that carry meaning |
| Amber `#DDA14B` on ink `#14161F` | 8.0:1 | AAA — safe for text on dark surfaces if ever needed |
| Ochre `#B0641F` on white | 4.5:1 | AA normal text ✓ — this is why ochre, not amber, is the UI-facing orange (§3) |

**Rules of thumb:**
1. The logo itself is exempt from text-contrast rules (standard WCAG logo exception) — ship it in full brand color everywhere per §2.7.
2. The moment orange is carrying text or a functional UI signal (not just decorating the mark), switch from amber to ochre.
3. Never rely on color alone to convey meaning (e.g., "orange = AI-generated") — pair with an icon or label for colorblind users.
4. Maintain the 1x clear space (§2.5) so the mark is never crowded by low-contrast neighboring elements — this is as much a legibility issue as a color one.

---

## 9. Source Files

```
brand/
├── BRAND_GUIDELINES.md          this document
└── final/
    ├── logo-primary.png          full lockup, transparent bg
    ├── logo-primary-onwhite.png
    ├── logo-primary-ondark.png
    ├── logo-mono-ink.png
    ├── logo-mono-white.png
    ├── symbol.png                icon-only, transparent bg
    ├── symbol-mono-ink.png
    ├── symbol-mono-white.png
    ├── favicon.svg                favicon-optimized construction (§5.1)
    ├── favicon-16.png / -32.png / -48.png / -64.png
    ├── appicon-1024.png / -512.png / -192.png / -180.png
    └── wrong_*.png                incorrect-usage references (§2.4)
```

**Note on source fidelity:** the shipped PNG assets are traced/recolored from the original delivered artwork (`brand/source/edum8-logo-original.png`), snapped to the canonical hex values in §3. They are production-usable but were not built as true vector paths. Before large-format use (print, signage, huge hero placements), a designer should re-trace the symbol in Illustrator/Figma using these files as the exact reference — geometry and color must not change in that process, only the file format.
