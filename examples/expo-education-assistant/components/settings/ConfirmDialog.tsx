import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useTheme } from '@/lib/Preferences';

/**
 * Centered confirmation dialog for destructive settings actions.
 *
 * Two strengths:
 * - default: a single Confirm press (e.g. clearing conversation history);
 * - strong: the user must type a confirmation word (e.g. DELETE) before
 *   the button enables — for irreversible actions like removing every
 *   document or deleting the account's data.
 *
 * The dialog never performs the action itself — `onConfirm` belongs to the
 * caller; `busy` swaps the confirm label for a spinner while the caller's
 * async work runs, and the dialog stays open (and unclosable) until the
 * caller closes it.
 */
export function ConfirmDialog({
  visible,
  title,
  body,
  confirmLabel,
  strongWord,
  busy = false,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  /** When set, the confirm button stays disabled until this exact word
   * (case-insensitive, trimmed) is typed into the field. */
  strongWord?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const theme = useTheme();
  const [typed, setTyped] = useState('');

  // Reset the typed word every time the dialog opens, so a previous
  // confirmation can never leak into a different destructive action.
  useEffect(() => {
    if (visible) setTyped('');
  }, [visible]);

  const strongSatisfied = !strongWord || typed.trim().toLowerCase() === strongWord.toLowerCase();

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={[styles.backdrop, { backgroundColor: theme.overlay }]}>
        <View
          style={[
            styles.card,
            {
              backgroundColor: theme.card,
              borderColor: theme.border,
              borderRadius: theme.radius.lg,
            },
          ]}
          accessibilityRole="alert"
        >
          <ScrollView contentContainerStyle={styles.cardContent}>
            <Text
              style={[
                styles.title,
                { color: theme.danger, fontSize: theme.scale(16), fontFamily: theme.fonts.display },
              ]}
            >
              {title}
            </Text>
            <Text
              style={[
                styles.body,
                { color: theme.subtext, fontSize: theme.scale(14), fontFamily: theme.fonts.body },
              ]}
            >
              {body}
            </Text>

            {strongWord ? (
              <View style={styles.strongBlock}>
                <Text
                  style={[
                    styles.strongHint,
                    { color: theme.text, fontSize: theme.scale(13), fontFamily: theme.fonts.body },
                  ]}
                >
                  Type{' '}
                  <Text style={[styles.strongWord, { fontFamily: theme.fonts.mono }]}>
                    {strongWord}
                  </Text>{' '}
                  to confirm.
                </Text>
                <TextInput
                  style={[
                    styles.strongInput,
                    {
                      color: theme.text,
                      borderColor: theme.border,
                      backgroundColor: theme.background,
                      borderRadius: theme.radius.sm,
                      fontFamily: theme.fonts.mono,
                    },
                  ]}
                  value={typed}
                  onChangeText={setTyped}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  editable={!busy}
                  accessibilityLabel={`Type ${strongWord} to confirm`}
                />
              </View>
            ) : null}

            <View style={styles.buttons}>
              <Pressable
                style={({ pressed }) => [
                  styles.button,
                  styles.cancelButton,
                  {
                    borderColor: theme.border,
                    backgroundColor: pressed ? theme.cardPressed : theme.card,
                  },
                ]}
                onPress={onCancel}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
              >
                <Text
                  style={[
                    styles.cancelText,
                    { color: theme.text, fontFamily: theme.fonts.bodySemibold },
                  ]}
                >
                  Cancel
                </Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.button,
                  styles.confirmButton,
                  {
                    backgroundColor: theme.danger,
                    borderRadius: theme.radius.md,
                    opacity: !strongSatisfied || busy ? 0.45 : pressed ? 0.85 : 1,
                  },
                ]}
                onPress={onConfirm}
                disabled={!strongSatisfied || busy}
                accessibilityRole="button"
                accessibilityLabel={confirmLabel}
              >
                {busy ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={[styles.confirmText, { fontFamily: theme.fonts.bodyBold }]}>
                    {confirmLabel}
                  </Text>
                )}
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 440,
    borderRadius: 14,
    borderWidth: 1,
  },
  cardContent: { padding: 20, gap: 12 },
  title: { fontWeight: '700' },
  body: { lineHeight: 20 },
  strongBlock: { gap: 6, marginTop: 2 },
  strongHint: { lineHeight: 18 },
  strongWord: { fontWeight: '800' },
  strongInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
  },
  buttons: { flexDirection: 'row', gap: 10, marginTop: 6 },
  button: {
    flex: 1,
    borderRadius: 9,
    paddingVertical: 11,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 42,
  },
  cancelButton: { borderWidth: 1 },
  cancelText: { fontWeight: '600', fontSize: 14 },
  confirmButton: {},
  confirmText: { color: '#FFFFFF', fontWeight: '700', fontSize: 14 },
});
