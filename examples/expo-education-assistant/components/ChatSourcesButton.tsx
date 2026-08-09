import { Button } from '@/components/ui/Button';
import { DocumentsIcon } from '@/components/icons';
import { useTheme } from '@/lib/Preferences';
import type { SourceMode } from '@/components/ChatSourcesPicker';

export interface ChatSourcesButtonProps {
  /** null = not yet loaded (server-side selection still loading for an
   * existing conversation) — shows a neutral "Sources" label rather than
   * flashing "Add sources" and then immediately relabeling once the real
   * count arrives. */
  count: number | null;
  /** 'prioritize' (default, non-exclusive) or 'zoom-in' (Milestone 4:
   * strict selected-source mode) — changes the label/badge so the two
   * modes are never visually confusable at a glance. */
  mode?: SourceMode;
  /**
   * Milestone 4 §15 (Milestone 3 bug fix): true when the conversation's
   * current selection/mode failed to load — a stale/empty local selection
   * must never be silently offered as if it reflected real server state.
   * When true, the button shows a distinct error/retry affordance
   * instead of its normal label, and `onPress` is expected to retry the
   * failed load rather than open the picker (the caller decides which —
   * this component only renders the state).
   */
  hasError?: boolean;
  onPress: () => void;
  disabled?: boolean;
}

/**
 * Milestone 3 (Chat Scope / Add Sources): the composer's compact Scope
 * control — sits in ChatComposer's `leadingActions` row alongside
 * AttachmentButton/ImageGenerateButton. Deliberately a labeled Button (not
 * a bare IconButton like its neighbors): the whole point of this control
 * is to make the current selection COUNT visible at a glance without
 * opening anything (Milestone 3 §9 — "always be able to tell"), which an
 * icon alone can't convey. Milestone 4 extends the label to also convey
 * Zoom-In mode (distinct "Zoom-In · N" wording, never just a count) and an
 * error/retry state (see `hasError`).
 */
export function ChatSourcesButton({
  count,
  mode = 'prioritize',
  hasError = false,
  onPress,
  disabled = false,
}: ChatSourcesButtonProps) {
  const theme = useTheme();
  const isZoomIn = mode === 'zoom-in';

  let label: string;
  let accessibilityLabel: string;
  if (hasError) {
    label = 'Sources unavailable';
    accessibilityLabel = 'Sources could not be loaded — tap to retry';
  } else if (count === null) {
    label = isZoomIn ? 'Zoom-In' : 'Add sources';
    accessibilityLabel = isZoomIn
      ? 'Zoom-In sources — loading current selection'
      : 'Add sources — choose documents to prioritize for this conversation';
  } else if (isZoomIn) {
    label = `Zoom-In · ${count}`;
    accessibilityLabel = `Zoom-In mode — ${count} source${count === 1 ? '' : 's'} selected, chat answers ONLY from ${count === 1 ? 'it' : 'them'}. Open to change`;
  } else if (count === 0) {
    label = 'Add sources';
    accessibilityLabel = 'Add sources — choose documents to prioritize for this conversation';
  } else {
    label = `${count} source${count === 1 ? '' : 's'}`;
    accessibilityLabel = `${count} source${count === 1 ? '' : 's'} selected — open to change`;
  }

  return (
    <Button
      label={label}
      onPress={onPress}
      disabled={disabled}
      variant="ghost"
      size="sm"
      icon={<DocumentsIcon size={15} color={hasError ? theme.danger : theme.subtext} />}
      accessibilityLabel={accessibilityLabel}
    />
  );
}
