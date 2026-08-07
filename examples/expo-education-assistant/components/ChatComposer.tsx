import { useState } from 'react';
import { Platform, StyleSheet, TextInput, View } from 'react-native';
import { Button } from '@/components/ui/Button';
import { useTheme, type Theme } from '@/lib/Preferences';

export interface ChatComposerProps {
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  inputAccessibilityLabel: string;
  /** Input is read-only while a send is in flight. */
  editable: boolean;
  /** Ask-button availability (non-empty input, no attachment errors). */
  canSubmit: boolean;
  onSubmit: () => void;
  /** A send is in flight — swaps Ask for Cancel. */
  busy: boolean;
  onCancel: () => void;
  /** Rows above the input — AttachmentPreviewRow / CorpusToggle. */
  children?: React.ReactNode;
  /** Icon buttons on the composer's bottom-left (attach, generate). */
  leadingActions?: React.ReactNode;
}

/**
 * The floating message composer shared by /chat/new and /chat/[id] —
 * one card, one input, one send control, instead of two screens each
 * re-deriving the treatment. The input itself is borderless inside the
 * card (the card is the field); on web the whole card gets the same
 * focus halo as TextField, so "where am I typing" reads at a glance.
 * Action glyphs sit on the card's bottom-left, the send/cancel control
 * on the bottom-right — the layout every serious chat product has
 * converged on, and the one the reference mock sketches.
 */
export function ChatComposer({
  value,
  onChangeText,
  placeholder,
  inputAccessibilityLabel,
  editable,
  canSubmit,
  onSubmit,
  busy,
  onCancel,
  children,
  leadingActions,
}: ChatComposerProps) {
  const theme = useTheme();
  const styles = buildStyles(theme);
  const [focused, setFocused] = useState(false);

  return (
    <View style={styles.outer} testID="chat-composer-outer">
      <View style={styles.inner} testID="chat-composer-inner">
        <View
          style={[
            styles.card,
            {
              backgroundColor: theme.card,
              borderColor: focused ? theme.focusRing : theme.border,
              borderWidth: focused ? 2 : StyleSheet.hairlineWidth * 2,
              borderRadius: theme.radius.lg,
            },
            Platform.OS === 'web' && focused
              ? ({ boxShadow: `0 0 0 4px ${hexToRgba(theme.focusRing, 0.15)}` } as object)
              : null,
          ]}
        >
          {children}
          <TextInput
            style={[
              styles.input,
              { color: theme.text, fontFamily: theme.fonts.body, fontSize: theme.scale(15) },
            ]}
            value={value}
            onChangeText={onChangeText}
            placeholder={placeholder}
            placeholderTextColor={theme.faint}
            editable={editable}
            onSubmitEditing={onSubmit}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            returnKeyType="send"
            accessibilityLabel={inputAccessibilityLabel}
          />
          <View style={styles.actionsRow}>
            <View style={styles.leadingActions}>{leadingActions}</View>
            {busy ? (
              <Button label="Cancel" variant="danger" size="sm" onPress={onCancel} />
            ) : (
              <Button
                label="Ask"
                variant="primary"
                size="sm"
                onPress={onSubmit}
                disabled={!canSubmit}
              />
            )}
          </View>
        </View>
      </View>
    </View>
  );
}

/** '#RRGGBB' -> 'rgba(r,g,b,alpha)' — same one-line helper TextField uses
 * for its focus halo; kept local rather than exported because it's two
 * call sites of three lines, not a utility worth a module. */
function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    outer: { backgroundColor: theme.background, paddingHorizontal: 16, paddingBottom: 12 },
    inner: { width: '100%', maxWidth: 720, alignSelf: 'center' },
    card: {
      padding: 10,
      gap: 4,
      ...(Platform.OS === 'web'
        ? ({
            transitionProperty: 'border-color, box-shadow',
            transitionDuration: '180ms',
          } as object)
        : null),
    },
    input: {
      paddingHorizontal: 6,
      paddingVertical: 4,
      minHeight: 36,
    },
    actionsRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingTop: 4,
      gap: 8,
    },
    leadingActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  });
}
