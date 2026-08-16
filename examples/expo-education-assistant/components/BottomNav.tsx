import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ChatIcon, DocumentsIcon, NotesIcon, SettingsIcon, WritingIcon } from '@/components/icons';
import type { NavSection } from '@/components/NavRail';
import { useTheme } from '@/lib/Preferences';

// Frontend/Platform Milestone 3.2.1 Part E — 'search' dropped from this
// list (mobile bottom nav was becoming crowded, and Documents' own
// in-library search — Part D — already covers the "find my paper" need
// this used to serve). See NavRail.tsx's matching comment.
const ITEMS: { key: NavSection; label: string; Icon: typeof ChatIcon }[] = [
  { key: 'chat', label: 'Chat', Icon: ChatIcon },
  { key: 'documents', label: 'Documents', Icon: DocumentsIcon },
  { key: 'notes', label: 'Notes', Icon: NotesIcon },
  { key: 'writing', label: 'Writing', Icon: WritingIcon },
  { key: 'settings', label: 'Settings', Icon: SettingsIcon },
];

export interface BottomNavProps {
  active: NavSection | null;
  onNavigate: (section: NavSection) => void;
}

/** Narrow/native replacement for the old React Navigation `<Tabs>` bottom
 * bar — same four destinations, now with real icons instead of the
 * suppressed fallback glyph (see (tabs)/_layout.tsx's previous
 * tabBarIcon: () => null). Only rendered below the wide-panel breakpoint;
 * wide web uses NavRail instead. */
export function BottomNav({ active, onNavigate }: BottomNavProps) {
  const theme = useTheme();
  return (
    <View style={[styles.bar, { backgroundColor: theme.card, borderTopColor: theme.border }]}>
      {ITEMS.map(({ key, label, Icon }) => {
        const isActive = active === key;
        return (
          <Pressable
            key={key}
            onPress={() => onNavigate(key)}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ selected: isActive }}
            style={styles.item}
          >
            <Icon size={20} color={isActive ? theme.accent : theme.faint} />
            <Text
              style={[
                styles.label,
                {
                  color: isActive ? theme.accent : theme.faint,
                  fontFamily: isActive ? theme.fonts.bodySemibold : theme.fonts.body,
                },
              ]}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
    paddingBottom: 10,
  },
  item: { flex: 1, alignItems: 'center', gap: 3 },
  label: { fontSize: 11 },
});
