import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/lib/Preferences';

export interface InfoDialogProps {
  visible: boolean;
  title: string;
  body: string;
  actionLabel?: string;
  onAction?: () => void;
  onClose: () => void;
}

/**
 * A small centered modal for read-only informational content — Privacy
 * policy / Terms of service / Help text wherever it's needed (Settings,
 * the login page's legal footer). Shared rather than duplicated so every
 * caller gets the same visual treatment and the same focus-trapping
 * Modal behavior for free.
 */
export function InfoDialog({
  visible,
  title,
  body,
  actionLabel,
  onAction,
  onClose,
}: InfoDialogProps) {
  const theme = useTheme();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.backdrop, { backgroundColor: theme.overlay }]}>
        <View
          style={[
            styles.dialogCard,
            {
              backgroundColor: theme.card,
              borderColor: theme.border,
              borderRadius: theme.radius.lg,
            },
          ]}
        >
          <Text
            style={[
              styles.dialogTitle,
              { color: theme.text, fontSize: theme.scale(16), fontFamily: theme.fonts.display },
            ]}
          >
            {title}
          </Text>
          <Text
            style={[
              styles.dialogBody,
              { color: theme.subtext, fontSize: theme.scale(14), fontFamily: theme.fonts.body },
            ]}
          >
            {body}
          </Text>
          <View style={styles.dialogButtons}>
            {actionLabel && onAction ? (
              <Pressable
                style={({ pressed }) => [
                  styles.dialogButton,
                  {
                    borderColor: theme.accent,
                    backgroundColor: pressed ? theme.accentSoft : theme.card,
                  },
                ]}
                onPress={onAction}
                accessibilityRole="button"
                accessibilityLabel={actionLabel}
              >
                <Text
                  style={[
                    styles.dialogActionText,
                    { color: theme.accent, fontFamily: theme.fonts.bodyBold },
                  ]}
                >
                  {actionLabel}
                </Text>
              </Pressable>
            ) : null}
            <Pressable
              style={({ pressed }) => [
                styles.dialogButton,
                {
                  backgroundColor: theme.accent,
                  opacity: pressed ? 0.85 : 1,
                },
              ]}
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Text
                style={[
                  styles.dialogCloseText,
                  { color: theme.accentContrast, fontFamily: theme.fonts.bodyBold },
                ]}
              >
                Close
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  dialogCard: {
    width: '100%',
    maxWidth: 440,
    borderWidth: 1,
    padding: 20,
    gap: 12,
  },
  dialogTitle: { fontWeight: '700' },
  dialogBody: { lineHeight: 20 },
  dialogButtons: { flexDirection: 'row', gap: 10, marginTop: 4 },
  dialogButton: {
    flex: 1,
    borderRadius: 9,
    borderWidth: 1,
    paddingVertical: 11,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 42,
  },
  dialogActionText: { fontWeight: '700', fontSize: 14 },
  dialogCloseText: { fontWeight: '700', fontSize: 14 },
});
