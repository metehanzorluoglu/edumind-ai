import { Pressable, StyleSheet, Text } from 'react-native';

export interface AttachmentButtonProps {
  onPress: () => void;
  disabled?: boolean;
}

/** Sits beside the Ask/Send button in the composer's input row (milestone V2's "attachment button beside Ask" requirement) — a single entry point into useChatAttachments' pickAttachment(), which itself branches by platform (web: file picker; native: Photo Library / Camera / Files choice). */
export function AttachmentButton({ onPress, disabled = false }: AttachmentButtonProps) {
  return (
    <Pressable
      style={[styles.button, disabled && styles.buttonDisabled]}
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
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
  },
  buttonDisabled: { opacity: 0.5 },
  icon: { fontSize: 18 },
});
