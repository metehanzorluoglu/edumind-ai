import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ChatIcon, DocumentsIcon, PanelIcon, SearchIcon, SettingsIcon } from '@/components/icons';
import { EduM8Symbol } from '@/components/EduM8Logo';
import { useAuth } from '@/lib/AuthProvider';
import { DARK_PALETTE, useTheme } from '@/lib/Preferences';
import { safeText } from '@/lib/format';

const dark = DARK_PALETTE;

export type NavSection = 'chat' | 'search' | 'documents' | 'settings';

const SECTIONS: { key: NavSection; label: string; Icon: typeof ChatIcon }[] = [
  { key: 'chat', label: 'Chat', Icon: ChatIcon },
  { key: 'search', label: 'Search', Icon: SearchIcon },
  { key: 'documents', label: 'Documents', Icon: DocumentsIcon },
  { key: 'settings', label: 'Settings', Icon: SettingsIcon },
];

export interface NavRailProps {
  active: NavSection | null;
  onNavigate: (section: NavSection) => void;
  drawerCollapsed: boolean;
  onToggleDrawer: () => void;
}

/**
 * Persistent, always-dark, icon-only navigation rail — the left-most
 * strip on wide web (see (tabs)/_layout.tsx for the width breakpoint).
 * Deliberately always-dark like ConversationSidebar/AppDrawer (same
 * `dark` token source, same ChatGPT-style rationale) so the rail and
 * drawer read as one continuous dark panel rather than two different
 * surfaces glued together.
 *
 * Icon-only by design (brief: "thin dark navigation rail... icon-only")
 * — every button still carries a real accessibilityLabel so it's never
 * icon-only for a screen reader, just visually.
 */
export function NavRail({ active, onNavigate, drawerCollapsed, onToggleDrawer }: NavRailProps) {
  const theme = useTheme();
  const { user } = useAuth();
  const initial =
    safeText(user?.display_name ?? user?.email ?? null, '?')
      .trim()
      .charAt(0)
      .toUpperCase() || '?';

  return (
    <View
      style={[styles.rail, { backgroundColor: dark.background, borderRightColor: dark.divider }]}
      testID="nav-rail"
    >
      <View style={styles.brandMark}>
        <EduM8Symbol size={22} />
      </View>

      <View style={styles.nav}>
        {SECTIONS.map(({ key, label, Icon }) => (
          <RailButton
            key={key}
            label={label}
            active={active === key}
            onPress={() => onNavigate(key)}
          >
            <Icon size={20} color={active === key ? dark.accent : dark.faint} />
          </RailButton>
        ))}
      </View>

      <View style={styles.bottom}>
        <RailButton
          label={drawerCollapsed ? 'Show conversation list' : 'Hide conversation list'}
          active={false}
          onPress={onToggleDrawer}
        >
          <PanelIcon size={20} color={dark.faint} open={!drawerCollapsed} />
        </RailButton>
        <Pressable
          onPress={() => onNavigate('settings')}
          accessibilityRole="button"
          accessibilityLabel="Account"
          style={styles.avatarButton}
        >
          <View style={[styles.avatar, { backgroundColor: dark.accentSoft }]}>
            <Text
              style={[styles.avatarText, { color: dark.accent, fontFamily: theme.fonts.display }]}
            >
              {initial}
            </Text>
          </View>
        </Pressable>
      </View>
    </View>
  );
}

function RailButton({
  label,
  active,
  onPress,
  children,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  children: React.ReactNode;
}) {
  const theme = useTheme();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      style={[
        styles.railButton,
        { borderRadius: theme.radius.md },
        active && { backgroundColor: dark.accentSoft },
        !active && hovered && { backgroundColor: dark.cardPressed },
        focused && { borderColor: dark.focusRing, borderWidth: 2 },
      ]}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  rail: {
    width: 60,
    alignItems: 'center',
    paddingVertical: 14,
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  brandMark: { marginBottom: 18 },
  nav: { gap: 6, flex: 1 },
  railButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bottom: { gap: 10, alignItems: 'center' },
  avatarButton: { padding: 2 },
  avatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: 13, fontWeight: '600' },
});
