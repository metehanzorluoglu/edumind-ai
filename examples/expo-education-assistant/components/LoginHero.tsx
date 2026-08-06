import { Platform, StyleSheet, Text, View } from 'react-native';
import { EduM8Logo } from '@/components/EduM8Logo';
import { ChatIcon, DocumentsIcon, SparkleIcon, type IconProps } from '@/components/icons';
import { useTheme } from '@/lib/Preferences';

const BENEFITS: { Icon: (props: IconProps) => React.ReactElement; label: string }[] = [
  { Icon: ChatIcon, label: 'Chat with your resources' },
  { Icon: DocumentsIcon, label: 'Organize research in projects' },
  { Icon: SparkleIcon, label: 'Create evidence-informed lessons' },
];

const TRUST_CHIPS = ['Document-grounded', 'Project organized', 'Educator focused'];

// The hero's two background glows are a one-off, deliberately more
// saturated pastel pair than the app's own accentSoft/citationSoft
// tokens (which are tuned for subtle fills behind body text, not a
// large soft-focus decorative wash) — indigo-200/blue-200-equivalent,
// scoped to this purely-decorative marketing panel only.
const GLOW_INDIGO = '#C7D2FE';
const GLOW_BLUE = '#BFDBFE';

/**
 * The left marketing panel on wide-screen /login — purely decorative
 * (no auth state, no handlers) so it can never affect the real sign-in
 * logic that lives in app/login.tsx. Only rendered above the responsive
 * breakpoint; see that file for where/why.
 *
 * The "product preview" card below is a small, honest sketch of the
 * actual chat + citation UI (built from this app's own tokens), not a
 * generic stock AI graphic — it's meant to read as "this is what the
 * product looks like," not as decoration for its own sake.
 */
export function LoginHero() {
  const theme = useTheme();

  return (
    <View style={[styles.hero, { backgroundColor: theme.background }]}>
      <View style={[styles.glow, styles.glowOne, { backgroundColor: GLOW_INDIGO }]} />
      <View style={[styles.glow, styles.glowTwo, { backgroundColor: GLOW_BLUE }]} />

      <View style={styles.logoRow}>
        <EduM8Logo size={34} />
      </View>

      <View style={styles.copy}>
        {/* Bold sans, not the app's editorial serif — the hero headline is
            a marketing moment, matching the reference's own heavy-grotesk
            treatment rather than the product's article/heading voice. */}
        <Text
          style={[
            styles.headline,
            { color: theme.text, fontFamily: theme.fonts.bodyBold, fontSize: theme.scale(62) },
          ]}
        >
          Turn educational resources into meaningful learning.
        </Text>
        <Text
          style={[
            styles.description,
            { color: theme.subtext, fontFamily: theme.fonts.body, fontSize: theme.scale(18) },
          ]}
        >
          Explore documents, organize research, and design better learning experiences with an AI
          workspace built for educators.
        </Text>

        <View style={styles.benefits}>
          {BENEFITS.map(({ Icon, label }) => (
            <View key={label} style={styles.benefitRow}>
              <View
                style={[
                  styles.benefitIcon,
                  {
                    backgroundColor: theme.card,
                    borderColor: theme.border,
                    borderRadius: theme.radius.md,
                  },
                ]}
              >
                <Icon size={18} color={theme.accent} />
              </View>
              <Text
                style={[
                  styles.benefitLabel,
                  { color: theme.text, fontFamily: theme.fonts.bodySemibold },
                ]}
              >
                {label}
              </Text>
            </View>
          ))}
        </View>
      </View>

      <View style={styles.trust}>
        <Text
          style={[
            styles.trustLabel,
            { color: theme.faint, fontFamily: theme.fonts.bodyBold, fontSize: theme.scale(11) },
          ]}
        >
          Built for thoughtful teaching and research
        </Text>
        <View style={styles.chips}>
          {TRUST_CHIPS.map((chip) => (
            <View
              key={chip}
              style={[
                styles.chip,
                {
                  backgroundColor: theme.card,
                  borderColor: theme.border,
                  borderRadius: theme.radius.pill,
                },
              ]}
            >
              <Text
                style={[styles.chipText, { color: theme.subtext, fontFamily: theme.fonts.body }]}
              >
                {chip}
              </Text>
            </View>
          ))}
        </View>
      </View>

      {/* Absolutely positioned and rendered last (so it paints above the
          headline) — the reference overlaps this card across the top of
          the h1 text as one layered composition, not a card that lives in
          its own clear space above the copy. */}
      <View style={styles.previewWrap} pointerEvents="none">
        <ProductPreview />
      </View>
    </View>
  );
}

/** A small, static sketch of the real chat + source-card UI — not
 * generic AI clip-art. Purely illustrative; nothing here is interactive
 * or reads live data. Deliberately glassy/translucent (unlike every
 * other surface in the app) — it's floating decoration over the hero's
 * own glow, not a real content surface, so the usual "flat card" rule
 * doesn't apply here. Web-only: this component never mounts on native
 * (the hero itself is gated to wide *web* viewports — see login.tsx). */
function ProductPreview() {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.previewCard,
        {
          borderColor: 'rgba(255,255,255,0.9)',
          shadowColor: theme.accent,
        },
      ]}
    >
      <View
        style={[styles.previewBar, styles.previewBarShort, { backgroundColor: theme.border }]}
      />
      <View style={[styles.previewBar, { backgroundColor: theme.border }]} />
      <View style={[styles.previewBar, styles.previewBarLong, { backgroundColor: theme.border }]} />
      <View
        style={[
          styles.previewChat,
          { backgroundColor: theme.accentSoft, borderRadius: theme.radius.lg },
        ]}
      >
        <Text
          style={[styles.previewChatText, { color: theme.accent, fontFamily: theme.fonts.body }]}
        >
          Summarize the key ideas and turn them into a classroom activity.
        </Text>
      </View>
      <View style={styles.previewDocRow}>
        <View
          style={[
            styles.previewDocIcon,
            { backgroundColor: theme.citationSoft, borderRadius: theme.radius.sm },
          ]}
        >
          <Text style={[styles.previewDocIconText, { color: theme.citation }]}>[1]</Text>
        </View>
        <View style={styles.previewDocLines}>
          <View
            style={[styles.previewBar, styles.previewBarShort, { backgroundColor: theme.border }]}
          />
          <View style={[styles.previewBar, { backgroundColor: theme.border }]} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: {
    flex: 1,
    paddingHorizontal: 64,
    paddingVertical: 54,
    justifyContent: 'space-between',
    overflow: 'hidden',
  },
  glow: {
    position: 'absolute',
    borderRadius: 999,
    opacity: 0.6,
    // Blur is web-only CSS (RN has no cross-platform filter prop) — on
    // native these still render as soft, low-opacity tinted circles,
    // just without the feathered edge. Degrading gracefully beats
    // pulling in a blur library for a purely decorative flourish.
    ...(Platform.OS === 'web' ? ({ filter: 'blur(70px)' } as object) : null),
  },
  glowOne: { width: 360, height: 360, top: '12%', left: '8%' },
  glowTwo: { width: 320, height: 320, bottom: '8%', right: '4%' },
  logoRow: { marginBottom: 4 },
  previewWrap: { position: 'absolute', top: '19%', right: '7%' },
  previewCard: {
    width: 280,
    padding: 18,
    borderRadius: 22,
    borderWidth: 1,
    transform: [{ rotate: '2deg' }],
    // A soft, colored (indigo-tinted) shadow rather than a neutral one —
    // matches the reference's own rgba(79,70,229,.12) glow, spread very
    // wide (shadowRadius 60) so it reads as ambient light, not a hard
    // drop shadow. The translucent/blur background below is what gives
    // this card its "glass" quality; the shadow just needs to feel like
    // it's floating above the hero's own glow rather than sitting flush
    // on the page.
    shadowOffset: { width: 0, height: 24 },
    shadowOpacity: 0.22,
    shadowRadius: 60,
    elevation: 10,
    ...(Platform.OS === 'web'
      ? ({
          backgroundColor: 'rgba(255,255,255,0.72)',
          backdropFilter: 'blur(16px)',
        } as object)
      : // Native never renders this component (hero is web-only, wide
        // breakpoint) — this branch exists only so the type checker/any
        // stray native preview render degrades to a plain translucent
        // card instead of crashing on an unsupported style.
        { backgroundColor: 'rgba(255,255,255,0.92)' }),
  },
  previewBar: { height: 7, borderRadius: 99, marginBottom: 8 },
  previewBarShort: { width: '58%' },
  previewBarLong: { width: '82%' },
  previewChat: { marginTop: 8, padding: 13 },
  previewChatText: { fontSize: 12.5, lineHeight: 18 },
  previewDocRow: { flexDirection: 'row', gap: 10, marginTop: 14, alignItems: 'center' },
  previewDocIcon: {
    width: 34,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewDocIconText: { fontSize: 9, fontWeight: '700' },
  previewDocLines: { flex: 1 },
  copy: { maxWidth: 640, gap: 12 },
  headline: { letterSpacing: -2.4, lineHeight: 64 },
  description: { lineHeight: 29, maxWidth: 540, marginBottom: 8 },
  benefits: { gap: 14, marginTop: 6 },
  benefitRow: { flexDirection: 'row', alignItems: 'center', gap: 13 },
  benefitIcon: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: '#1C1917',
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.05,
    shadowRadius: 16,
    elevation: 1,
  },
  benefitLabel: { fontSize: 15 },
  trust: { gap: 12 },
  trustLabel: { textTransform: 'uppercase', letterSpacing: 1.6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  chip: {
    paddingHorizontal: 13,
    height: 27,
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipText: { fontSize: 11 },
});
