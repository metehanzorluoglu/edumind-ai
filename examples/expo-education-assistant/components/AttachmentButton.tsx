import { PaperclipIcon } from '@/components/icons';
import { IconButton } from '@/components/ui/IconButton';
import { useTheme } from '@/lib/Preferences';

export interface AttachmentButtonProps {
  onPress: () => void;
  disabled?: boolean;
}

/** Composer action: pick an image/PDF to attach — the single entry point
 * into useChatAttachments' pickAttachment(), which itself branches by
 * platform (web: file picker; native: Photo Library / Camera / Files).
 * Thin wrapper over the shared IconButton so hover/focus/disabled behave
 * like every other glyph button in the app (the emoji it used to render
 * was platform-dependent and couldn't take theme colors). */
export function AttachmentButton({ onPress, disabled = false }: AttachmentButtonProps) {
  const theme = useTheme();
  return (
    <IconButton
      label="Attach image or PDF"
      onPress={onPress}
      disabled={disabled}
      variant="outline"
      size="sm"
      icon={<PaperclipIcon size={17} color={theme.subtext} />}
    />
  );
}
