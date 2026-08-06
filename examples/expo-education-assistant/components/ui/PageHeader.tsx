import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/lib/Preferences';

export interface PageHeaderProps {
  title: string;
  /** Rendered right-aligned — a Button, a link, etc. Optional. */
  action?: React.ReactNode;
}

/**
 * The serif page title for Documents/Search/Settings — replaces the
 * title React Navigation's <Tabs> header used to render for us before
 * the nav rail/drawer shell took over (tabs)/_layout.tsx's whole-app
 * chrome. Chat doesn't use this: its canvas *is* the conversation, with
 * no separate page title above it.
 */
export function PageHeader({ title, action }: PageHeaderProps) {
  const theme = useTheme();
  return (
    <View style={[styles.row, { borderBottomColor: theme.border }]}>
      <Text
        style={[
          styles.title,
          { color: theme.text, fontFamily: theme.fonts.display, fontSize: theme.scale(22) },
        ]}
      >
        {title}
      </Text>
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingTop: 20,
    paddingBottom: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { letterSpacing: -0.2 },
});
