import { ImageIcon } from '@/components/icons';
import { IconButton } from '@/components/ui/IconButton';
import { useTheme } from '@/lib/Preferences';

export interface ImageGenerateButtonProps {
  onPress: () => void;
  disabled?: boolean;
}

/** Composer action: open the image generation dialog. Thin wrapper over
 * the shared IconButton — identical treatment to the AttachmentButton it
 * sits beside, so the pair reads as one family. */
export function ImageGenerateButton({ onPress, disabled = false }: ImageGenerateButtonProps) {
  const theme = useTheme();
  return (
    <IconButton
      label="Generate an image"
      onPress={onPress}
      disabled={disabled}
      variant="outline"
      size="sm"
      icon={<ImageIcon size={17} color={theme.subtext} />}
    />
  );
}
