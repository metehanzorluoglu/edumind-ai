import { Pressable, StyleSheet, Text } from 'react-native';
import { useTheme } from '@/lib/Preferences';

export interface AttachmentButtonProps {
  onPress: () => void;
  disabled?: boolean;
}

/** Sits beside the Ask/Send button in the composer's input row (milestone V2's "attachment button beside Ask" requirement) — a single entry point into useChatAttachments' pickAttachment(), which itself branches by platform (web: file picker; native: Photo Library / Camera / Files choice). */
export function AttachmentButton({ onPress, disabled = false }: AttachmentButtonProps) {
  const theme = useTheme();
  return (
    <Pressable
      style={[
        styles.button,
        {
          borderColor: theme.border,
          backgroundColor: theme.card,
          borderRadius: theme.radius.md,
        },
        disabled && styles.buttonDisabled,
      ]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel="Attach image or PDF"
    >
      <Text style={styles.icon}>📎</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 44,
    minHeight: 44,
    borderWidth: StyleSheet.hairlineWidth * 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDisabled: { opacity: 0.5 },
  icon: { fontSize: 18 },
});
