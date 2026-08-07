import { useEffect, useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
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
                <TextField
                  label="Confirmation"
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
              <Button
                label="Cancel"
                variant="secondary"
                onPress={onCancel}
                disabled={busy}
                style={styles.button}
              />
              <Button
                label={confirmLabel}
                variant="danger"
                onPress={onConfirm}
                disabled={!strongSatisfied || busy}
                loading={busy}
                style={styles.button}
              />
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
  buttons: { flexDirection: 'row', gap: 10, marginTop: 6 },
  button: { flex: 1 },
});
