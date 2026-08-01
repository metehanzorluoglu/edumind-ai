import type { ThinkingContext } from 'education-assistant-client';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';

/** How long each status stays on screen — long enough to actually read,
 * short enough to keep cycling while a slow (CPU-only Ollama) backend works. */
const STATUS_ROTATE_MS = 2800;

/**
 * The safe, truthful status texts shown (in order, one at a time) while an
 * assistant turn waits for its first streamed token — selected only from
 * facts the request actually implies (see ThinkingContext), so the UI never
 * claims the backend is searching documents or reviewing images unless this
 * request genuinely triggers that:
 * - text-only: retrieval has always run unconditionally for these, so
 *   "Searching your documents" is truthful mid-sequence;
 * - vision-only (attachments, no corpus): retrieval is skipped entirely —
 *   no document-searching text may ever appear;
 * - vision + corpus: both the images and the corpus are genuinely consulted.
 * "Reviewing the conversation" is deliberately absent: this backend never
 * feeds prior turns back as prompt context, so claiming it would be a lie.
 * The sequence ends (never cycles back) on "Preparing a response" — the
 * truthful final stage before tokens begin.
 */
export function thinkingStatuses(context: ThinkingContext | null): string[] {
  if (!context) return ['Preparing a response'];
  if (context.hasAttachments) {
    return context.retrievalEnabled
      ? ['Reviewing the attached images', 'Searching your documents', 'Preparing a response']
      : ['Reviewing the attached images', 'Preparing a response'];
  }
  return ['Understanding your question', 'Searching your documents', 'Preparing a response'];
}

/**
 * Three trailing dots that brighten in sequence — the placeholder's subtle
 * "still working" motion, in place of the old centered spinner. One
 * Animated.loop drives all three via staggered interpolations over the same
 * 0→1 value; every dot sits at the same resting opacity at value 0 and 1,
 * so the loop's restart is seamless (no flicker).
 *
 * Runs on the JS driver (`useNativeDriver: false`) exactly as
 * ImageGenerationModal's IndeterminateProgressBar does — react-native-web's
 * `Animated.loop` treats the native-driver flag as a run-exactly-once path,
 * which would freeze the dots on web (see that component's docs).
 * `isInteraction: false` too: a looping animation must never hold an
 * InteractionManager handle, or it stalls VirtualizedList rendering — this
 * placeholder lives inside a FlatList row. `stop()` on unmount, so the loop
 * dies with the placeholder the moment the first token (or an error, or a
 * cancellation) replaces it.
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
    <Text accessibilityElementsHidden>
      {dotOpacities.map((opacity, i) => (
        <Animated.Text key={i} style={{ opacity }}>
          .
        </Animated.Text>
      ))}
    </Text>
  );
});

export interface ThinkingPlaceholderProps {
  /** Truthful facts about the pending request (null defensively falls back
   * to the one status that is always true). */
  context: ThinkingContext | null;
}

/**
 * The assistant bubble's pre-first-token "thinking preview": a muted shadow
 * of a real answer (same 16/24 typography as MarkdownAnswer's body text,
 * slate color, left-aligned like streamed output) that rotates through the
 * context-appropriate thinkingStatuses and stops on the last one. Rendered
 * by ConversationTurnCard only while DisplayMessage.thinking is non-null —
 * the first streamed token, an error, or a cancellation all clear that
 * state, unmounting this component and its timer/animation in one pass, so
 * the placeholder never coexists with real answer text (or outlives the
 * request). No separate floating loader — it lives inside the same message
 * bubble the answer will fill.
 */
export const ThinkingPlaceholder = memo(function ThinkingPlaceholder({
  context,
}: ThinkingPlaceholderProps) {
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

  return (
    <View style={styles.container} accessibilityRole="text" accessibilityLabel={`${status}…`}>
      <Text style={styles.status}>
        {status}
        <AnimatedDots />
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  container: {},
  // A deliberately muted shadow of MarkdownAnswer's body text (fontSize 16,
  // lineHeight 24, #0F172A there): same metrics so the real answer occupies
  // the same layout the moment it replaces this, slate color so it reads as
  // pending on light and dark backgrounds alike.
  status: { fontSize: 16, lineHeight: 24, color: '#64748B' },
});
