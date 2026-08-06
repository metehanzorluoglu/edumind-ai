import { Pressable, StyleSheet, Text } from 'react-native';
import { useTheme } from '@/lib/Preferences';

export interface ImageGenerateButtonProps {
  onPress: () => void;
  disabled?: boolean;
}

/** Sits beside AttachmentButton in the composer's input row — opens ImageGenerationModal. Mirrors AttachmentButton's exact shape/sizing so the two read as a pair. */
export function ImageGenerateButton({ onPress, disabled = false }: ImageGenerateButtonProps) {
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
      accessibilityLabel="Generate an image"
    >
      <Text style={styles.icon}>🎨</Text>
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
