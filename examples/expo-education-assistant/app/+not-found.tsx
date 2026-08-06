import { Link, Stack } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { EduM8Symbol } from '@/components/EduM8Logo';
import { useTheme } from '@/lib/Preferences';

export default function NotFoundScreen() {
  const theme = useTheme();
  return (
    <>
      <Stack.Screen options={{ title: 'Not found' }} />
      <View style={[styles.container, { backgroundColor: theme.background }]}>
        <EduM8Symbol size={32} style={styles.mark} />
        <Text
          style={[
            styles.text,
            { color: theme.text, fontFamily: theme.fonts.body, fontSize: theme.scale(16) },
          ]}
        >
          This screen doesn&apos;t exist.
        </Text>
        <Link href="/chat" style={styles.link}>
          <Text style={{ color: theme.accent, fontFamily: theme.fonts.bodySemibold }}>
            Go to Chat
          </Text>
        </Link>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20, gap: 12 },
  mark: { opacity: 0.6, marginBottom: 4 },
  text: {},
  link: { paddingVertical: 8 },
});
