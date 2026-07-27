import { Pressable, StyleSheet, Text } from 'react-native';

export interface ImageGenerateButtonProps {
  onPress: () => void;
  disabled?: boolean;
}

/** Sits beside AttachmentButton in the composer's input row — opens ImageGenerationModal. Mirrors AttachmentButton's exact shape/sizing so the two read as a pair. */
export function ImageGenerateButton({ onPress, disabled = false }: ImageGenerateButtonProps) {
  return (
    <Pressable
      style={[styles.button, disabled && styles.buttonDisabled]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel="Generate an image"
    >
      <Text style={styles.icon}>🎨</Text>
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
