import { Platform } from 'react-native';

/** `aria-haspopup` has no React Native cross-platform equivalent (it's a
 * web-only ARIA attribute — RN's own accessibility props stop at
 * `accessibilityState.expanded`/`aria-expanded`, both already applied by
 * the menu triggers on every platform). Shared by every three-dot menu
 * trigger (ConversationRow, ProjectRow) so the web-only spread stays one
 * definition. */
export const WEB_MENU_TRIGGER_ARIA_PROPS =
  Platform.OS === 'web' ? ({ 'aria-haspopup': 'menu' } as Record<string, string>) : {};
