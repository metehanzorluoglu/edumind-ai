import type { ThinkingContext } from 'education-assistant-client';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/lib/Preferences';

/** How long each in-box status stays on screen before rotating. */
const STATUS_ROTATE_MS = 2000;

/** Fade duration for the whole placeholder's appearance/disappearance.
 * ConversationTurnCard keeps this component mounted for its own
 * THINKING_FADE_OUT_MS after `visible` goes false, so the exit fade always
 * completes (or nearly so) before unmount — the streamed answer is only
 * revealed once this has faded away, so the two never render at once. */
const FADE_MS = 180;

/** The fixed title shown above the shadow box for the entire wait. */
const TITLE = 'Preparing a response...';

/**
 * The safe, truthful status texts rotated (one at a time) inside the shadow
 * box while an assistant turn waits for its first streamed token — selected
 * only from facts the request actually implies (see ThinkingContext), so the
 * UI never claims the backend is searching documents or reviewing images
 * unless this request genuinely triggers that:
 * - text-only: retrieval has always run unconditionally for these, so
 *   "Searching your documents" is truthful mid-sequence;
 * - vision-only (attachments, no corpus): retrieval is skipped entirely —
 *   no document-searching text may ever appear;
 * - vision + corpus: both the images and the corpus are genuinely consulted.
 * "Reviewing the conversation" is deliberately absent: this backend never
 * feeds prior turns back as prompt context, so claiming it would be a lie.
 * Every sequence ends (never cycles back) on "Preparing the final response".
 * Rendered with a literal trailing "..." after each text (see the box row).
 * These are short, high-level progress descriptions only — never chain of
 * thought or internal reasoning.
 */
export function thinkingStatuses(context: ThinkingContext | null): string[] {
  if (!context) return ['Organizing key information', 'Preparing the final response'];
  if (context.hasAttachments) {
    return context.retrievalEnabled
      ? [
          'Reviewing the attached images',
          'Organizing key information',
          'Searching your documents',
          'Preparing the final response',
        ]
      : [
          'Reviewing the attached images',
          'Organizing key information',
          'Preparing the final response',
        ];
  }
  return [
    'Understanding your question',
    'Organizing key information',
    'Searching your documents',
    'Preparing the final response',
  ];
}

/**
 * Three small leading dots that brighten in sequence — the shadow box's
 * "still working" motion. One Animated.loop drives all three via staggered
 * interpolations over the same 0→1 value; every dot sits at the same resting
 * opacity at value 0 and 1, so the loop's restart is seamless (no flicker).
 *
 * Runs on the JS driver (`useNativeDriver: false`) exactly as
 * ImageGenerationModal's IndeterminateProgressBar does — react-native-web's
 * `Animated.loop` treats the native-driver flag as a run-exactly-once path,
 * which would freeze the dots on web (see that component's docs).
 * `isInteraction: false` too: a looping animation must never hold an
 * InteractionManager handle, or it stalls VirtualizedList rendering — this
 * placeholder lives inside a FlatList row. `stop()` on unmount, so the loop
 * dies with the placeholder the moment the turn is finalized.
 */
const AnimatedDots = memo(function AnimatedDots() {
  const progress = useRef(new Animated.Value(0)).current;
  const dotOpacities = useMemo(
    () =>
      (
        [
          [0.25, 1, 0.25, 0.25, 0.25],
          [0.25, 0.25, 1, 0.25, 0.25],
          [0.25, 0.25, 0.25, 1, 0.25],
        ] as const
      ).map((outputRange) =>
        progress.interpolate({ inputRange: [0, 0.25, 0.5, 0.75, 1], outputRange: [...outputRange] })
      ),
    [progress]
  );

  useEffect(() => {
    const animation = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: 1400,
        easing: Easing.linear,
        isInteraction: false,
        useNativeDriver: false,
      })
    );
    animation.start();
    return () => animation.stop();
  }, [progress]);

  return (
    <View style={styles.dots} accessibilityElementsHidden>
      {dotOpacities.map((opacity, i) => (
        <Animated.View key={i} style={[styles.dot, { opacity }]} />
      ))}
    </View>
  );
});

export interface ThinkingPlaceholderProps {
  /** Truthful facts about the pending request (null defensively falls back
   * to always-true statuses). */
  context: ThinkingContext | null;
  /**
   * false once the turn has left the thinking state (first token, error,
   * cancel, completion) — the placeholder fades out over FADE_MS instead of
   * vanishing. The parent (ConversationTurnCard) keeps this component
   * mounted for the duration of that fade and only then swaps in the real
   * answer, so placeholder and streamed text never coexist.
   */
  visible: boolean;
}

/**
 * The assistant bubble's pre-first-token "thinking preview": a fixed
 * "Preparing a response..." title with a subtle shadow box underneath it —
 * light translucent panel, thin border, soft shadow, muted italic status
 * text with animated leading dots — rotating through the context-appropriate
 * thinkingStatuses and parking on the last one. Rendered by
 * ConversationTurnCard only while DisplayMessage.thinking is non-null (plus
 * a brief fade-out linger after it clears), so it never coexists with real
 * answer text (or outlives the request). No separate floating loader — it
 * lives inside the same message bubble the answer will fill. Fades in/out
 * over FADE_MS; the dots and rotation timer die on unmount.
 */
export const ThinkingPlaceholder = memo(function ThinkingPlaceholder({
  context,
  visible,
}: ThinkingPlaceholderProps) {
  const theme = useTheme();
  // Keyed on primitives (not the context object's identity, which changes
  // on every DisplayMessage patch while streaming) so this can never
  // re-derive a different sequence mid-rotation from an unrelated
  // re-render; the null branch preserves thinkingStatuses' defensive
  // fallback for a turn that somehow has no context at all.
  const hasContext = context !== null;
  const hasAttachments = context?.hasAttachments ?? false;
  const retrievalEnabled = context?.retrievalEnabled ?? false;
  const statuses = useMemo(
    () => thinkingStatuses(hasContext ? { hasAttachments, retrievalEnabled } : null),
    [hasContext, hasAttachments, retrievalEnabled]
  );
  const [index, setIndex] = useState(0);
  const lastIndex = statuses.length - 1;

  useEffect(() => {
    // Parked on the final status: no timer at all until the turn ends.
    if (index >= lastIndex) return;
    const timer = setInterval(
      () => setIndex((prev) => (prev < lastIndex ? prev + 1 : prev)),
      STATUS_ROTATE_MS
    );
    return () => clearInterval(timer);
  }, [index, lastIndex]);

  const displayIndex = Math.min(index, lastIndex);
  const status = statuses[displayIndex]!;

  // Enter/exit fade. Starts at 0 so the first mount always fades in; when
  // `visible` flips to false the parent holds us mounted long enough for
  // this to finish fading out before the answer replaces us.
  const fade = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const animation = Animated.timing(fade, {
      toValue: visible ? 1 : 0,
      duration: FADE_MS,
      easing: Easing.inOut(Easing.ease),
      isInteraction: false,
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [visible, fade]);

  return (
    <Animated.View
      style={{ opacity: fade }}
      accessibilityRole="text"
      accessibilityLabel={`${TITLE} ${status}...`}
    >
      <Text style={[styles.title, { fontFamily: theme.fonts.body }]}>{TITLE}</Text>
      <View style={[styles.box, { borderRadius: theme.radius.md }]} testID="thinking-shadow-box">
        <View style={styles.boxRow}>
          <AnimatedDots />
          <Text style={[styles.boxText, { fontFamily: theme.fonts.body }]}>{`${status}...`}</Text>
        </View>
      </View>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  // Same 16/24 metrics as MarkdownAnswer's body text so the real answer
  // occupies the same layout the moment it replaces this; slate color reads
  // as pending on light and dark backgrounds alike (the app currently ships
  // a light palette — these translucent slate values were chosen to hold up
  // on a dark surface too).
  title: { fontSize: 16, lineHeight: 24, color: '#64748B', marginBottom: 8 },
  // The "thinking shadow box": full bubble width (Views stretch by
  // default), light translucent background, thin border, soft shadow —
  // rgba-based so it sits correctly on either theme.
  box: {
    backgroundColor: 'rgba(100, 116, 139, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(100, 116, 139, 0.22)',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    shadowColor: '#14161F',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  boxRow: { flexDirection: 'row', alignItems: 'center' },
  dots: { flexDirection: 'row', gap: 4, marginRight: 10 },
  dot: { width: 5, height: 5, borderRadius: 2.5, backgroundColor: '#94A3B8' },
  boxText: { flexShrink: 1, fontSize: 14, lineHeight: 20, fontStyle: 'italic', color: '#64748B' },
});
