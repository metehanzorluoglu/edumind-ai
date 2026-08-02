import { useConversations, useEducationDocuments } from 'education-assistant-client';
import Constants from 'expo-constants';
import * as Linking from 'expo-linking';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { ConfirmDialog } from '@/components/settings/ConfirmDialog';
import { SegmentedControl } from '@/components/settings/SegmentedControl';
import { RowDivider, SettingsRow } from '@/components/settings/SettingsRow';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { SettingsToggleRow } from '@/components/settings/SettingsToggleRow';
import { useAuth } from '@/lib/AuthProvider';
import { useRefreshConversations } from '@/lib/ChatConversationsContext';
import { useClient } from '@/lib/ClientProvider';
import { saveJsonExport } from '@/lib/exportUserData';
import { useFeatureFlags } from '@/lib/FeatureFlags';
import { safeText } from '@/lib/format';
import { usePreferences, useTheme } from '@/lib/Preferences';
import { useReadiness } from '@/lib/useServiceStatus';

const REPOSITORY_URL = 'https://github.com/metehanzorluoglu/edumind-ai';

const PROVIDER_LABELS: Record<string, string> = {
  google: 'Google',
  facebook: 'Facebook',
  linkedin: 'LinkedIn',
  dev: 'Developer test account',
};

function providerLabel(provider: string | null): string {
  if (!provider) return 'Unknown';
  return PROVIDER_LABELS[provider] ?? provider;
}

function Avatar({ uri, label, size }: { uri: string | null; label: string; size: number }) {
  const theme = useTheme();
  if (uri) {
    return (
      <Image
        source={{ uri }}
        style={[styles.avatarImage, { width: size, height: size, borderRadius: size / 2 }]}
      />
    );
  }
  const initial = label.trim().charAt(0).toUpperCase() || '?';
  return (
    <View
      style={[
        styles.avatarFallback,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: theme.accent },
      ]}
    >
      <Text style={[styles.avatarFallbackText, { fontSize: size * 0.4 }]}>{initial}</Text>
    </View>
  );
}

/** Small centered modal for Privacy policy / Terms / Help content. */
function InfoDialog({
  visible,
  title,
  body,
  actionLabel,
  onAction,
  onClose,
}: {
  visible: boolean;
  title: string;
  body: string;
  actionLabel?: string;
  onAction?: () => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.backdrop, { backgroundColor: theme.overlay }]}>
        <View
          style={[styles.dialogCard, { backgroundColor: theme.card, borderColor: theme.border }]}
        >
          <Text style={[styles.dialogTitle, { color: theme.text, fontSize: theme.scale(16) }]}>
            {title}
          </Text>
          <Text style={[styles.dialogBody, { color: theme.subtext, fontSize: theme.scale(14) }]}>
            {body}
          </Text>
          <View style={styles.dialogButtons}>
            {actionLabel && onAction ? (
              <Pressable
                style={({ pressed }) => [
                  styles.dialogButton,
                  {
                    borderColor: theme.accent,
                    backgroundColor: pressed ? theme.accentSoft : theme.card,
                  },
                ]}
                onPress={onAction}
                accessibilityRole="button"
                accessibilityLabel={actionLabel}
              >
                <Text style={[styles.dialogActionText, { color: theme.accent }]}>
                  {actionLabel}
                </Text>
              </Pressable>
            ) : null}
            <Pressable
              style={({ pressed }) => [
                styles.dialogButton,
                {
                  backgroundColor: theme.accent,
                  opacity: pressed ? 0.85 : 1,
                },
              ]}
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Text style={[styles.dialogCloseText, { color: theme.accentContrast }]}>Close</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

/**
 * The user-facing Settings screen — account, appearance, chat preferences,
 * documents, privacy/data, and about. Deliberately free of infrastructure
 * detail: no backend URL, model names, latencies, or per-service status
 * (all of that lives on the flag-gated Developer settings screen). Service
 * problems surface only as one plain-language banner, and only while
 * something is actually wrong.
 */
export default function SettingsScreen() {
  const { user, logout } = useAuth();
  const { client, hydrated } = useClient();
  const router = useRouter();
  const theme = useTheme();
  const { preferences, update } = usePreferences();
  const { developerSettings } = useFeatureFlags();
  const refreshSidebarConversations = useRefreshConversations();

  const { listState: documentsState, refresh: refreshDocuments } = useEducationDocuments(client);
  const { listState: conversationsState, refresh: refreshConversations } = useConversations(client);
  const readiness = useReadiness(client);

  const [clearHistoryOpen, setClearHistoryOpen] = useState(false);
  const [removeDocsOpen, setRemoveDocsOpen] = useState(false);
  const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<
    'clearHistory' | 'removeDocs' | 'deleteAccount' | 'export' | null
  >(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [infoDialog, setInfoDialog] = useState<'privacy' | 'terms' | 'help' | null>(null);

  // Re-check the two counts whenever this tab regains focus (uploads or
  // deletions elsewhere don't touch this screen's own hook instances
  // until it looks again). Depends on `hydrated` only — see the old
  // version's comment: the refresh identities change every render, so
  // listing them here would loop.
  useFocusEffect(
    useCallback(() => {
      if (!hydrated) return;
      refreshDocuments({ limit: 1 });
      refreshConversations({ limit: 1 });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [hydrated])
  );

  async function deleteAllConversations(): Promise<number> {
    const page = await client.listConversations({ limit: 200, offset: 0 });
    for (const conversation of page.conversations) {
      await client.deleteConversation(conversation.id);
    }
    return page.conversations.length;
  }

  async function deleteAllDocuments(): Promise<number> {
    const page = await client.listDocuments({ limit: 200, offset: 0 });
    for (const document of page.documents) {
      await client.deleteDocument(document.document_id);
    }
    return page.documents.length;
  }

  async function handleClearHistory(): Promise<void> {
    setBusyAction('clearHistory');
    setActionError(null);
    setNotice(null);
    try {
      await deleteAllConversations();
      refreshConversations({ limit: 1 });
      refreshSidebarConversations();
      setNotice('Your conversation history has been cleared.');
      setClearHistoryOpen(false);
    } catch {
      setActionError('Clearing history failed. Please try again.');
      setClearHistoryOpen(false);
    } finally {
      setBusyAction(null);
    }
  }

  async function handleRemoveDocuments(): Promise<void> {
    setBusyAction('removeDocs');
    setActionError(null);
    setNotice(null);
    try {
      const count = await deleteAllDocuments();
      refreshDocuments({ limit: 1 });
      setNotice(
        count === 0 ? 'There were no documents to remove.' : 'All documents have been removed.'
      );
      setRemoveDocsOpen(false);
    } catch {
      setActionError('Removing documents failed. Please try again.');
      setRemoveDocsOpen(false);
    } finally {
      setBusyAction(null);
    }
  }

  // No account-deletion endpoint exists on the backend (verified: the only
  // deletion in routes_auth.py is the logout cookie clear, and the SDK
  // client has no user-delete method), so the strongest honest action
  // available is: erase everything the user owns on it (conversations +
  // documents) and end the session. The UI labels this "Delete all my
  // data" — never "Delete account" — and the dialog says the account
  // itself remains, because claiming otherwise would be a lie.
  async function handleDeleteAccount(): Promise<void> {
    setBusyAction('deleteAccount');
    setActionError(null);
    setNotice(null);
    try {
      await deleteAllConversations();
      await deleteAllDocuments();
      setDeleteAccountOpen(false);
      await logout();
    } catch {
      setActionError('Deleting your data failed. Please try again.');
      setDeleteAccountOpen(false);
      setBusyAction(null);
    }
  }

  async function handleExportData(): Promise<void> {
    setBusyAction('export');
    setActionError(null);
    setNotice(null);
    try {
      const [conversations, documents] = await Promise.all([
        client.listConversations({ limit: 200, offset: 0 }),
        client.listDocuments({ limit: 200, offset: 0 }),
      ]);
      // Full message bodies, one conversation at a time (capped so a huge
      // history can't stall the export) — a user who can open a
      // conversation can export it.
      const conversationDetails: unknown[] = [];
      for (const summary of conversations.conversations.slice(0, 100)) {
        try {
          conversationDetails.push(await client.getConversation(summary.id));
        } catch {
          // Skip a conversation that fails to load rather than losing the
          // whole export over one bad row.
        }
      }
      await saveJsonExport('edumind-data-export.json', {
        exported_at: new Date().toISOString(),
        profile: {
          name: user?.display_name ?? null,
          email: user?.email ?? null,
          provider: user?.provider ?? null,
        },
        conversations: conversationDetails,
        documents: documents.documents,
      });
      setNotice('Your data export is ready — check your downloads.');
    } catch {
      setActionError('The export failed. Please try again.');
    } finally {
      setBusyAction(null);
    }
  }

  if (!hydrated || !user) {
    return (
      <View style={[styles.centered, { backgroundColor: theme.background }]}>
        <ActivityIndicator />
      </View>
    );
  }

  const documentsCount = documentsState.status === 'success' ? documentsState.total : null;
  const conversationsCount =
    conversationsState.status === 'success' ? conversationsState.total : null;
  const profileName = safeText(user.display_name, user.email);
  const appVersion = Constants.expoConfig?.version ?? '1.0.0';

  // One plain-language status banner, shown ONLY while something is wrong
  // — a healthy deployment shows nothing at all.
  const serviceProblem =
    readiness !== null && (!readiness.backend || !readiness.ollama || !readiness.qdrant)
      ? !readiness.backend
        ? 'EduMind services are currently unreachable. Your data is safe — please try again in a moment.'
        : 'Some EduMind features may be slower or briefly unavailable while we restore full service.'
      : null;

  return (
    <ScrollView style={[styles.container, { backgroundColor: theme.background }]}>
      <View style={styles.content}>
        {serviceProblem ? (
          <View
            style={[
              styles.banner,
              { backgroundColor: theme.warningSoft, borderColor: theme.border },
            ]}
          >
            <Text style={[styles.bannerText, { color: theme.warning, fontSize: theme.scale(13) }]}>
              {serviceProblem}
            </Text>
          </View>
        ) : null}

        {notice ? (
          <Text style={[styles.feedbackOk, { color: theme.ok, fontSize: theme.scale(13) }]}>
            {notice}
          </Text>
        ) : null}
        {actionError ? (
          <Text style={[styles.feedbackError, { color: theme.danger, fontSize: theme.scale(13) }]}>
            {actionError}
          </Text>
        ) : null}

        <SettingsSection title="Account">
          <View style={[styles.profileRow, { backgroundColor: theme.card }]}>
            <Avatar uri={user.avatar_url} label={profileName} size={56} />
            <View style={styles.profileInfo}>
              <Text style={[styles.profileName, { color: theme.text, fontSize: theme.scale(17) }]}>
                {profileName}
              </Text>
              <Text
                style={[styles.profileEmail, { color: theme.subtext, fontSize: theme.scale(13) }]}
              >
                {user.email}
              </Text>
              <Text
                style={[styles.profileProvider, { color: theme.faint, fontSize: theme.scale(12) }]}
              >
                Signed in with {providerLabel(user.provider)}
              </Text>
            </View>
          </View>
          <RowDivider />
          <SettingsRow label="Log out" tone="danger" onPress={() => void logout()} />
        </SettingsSection>

        <SettingsSection title="Appearance">
          <SegmentedControl
            label="Theme"
            options={[
              { value: 'system', label: 'System' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
            value={preferences.themeMode}
            onChange={(next) => update('themeMode', next)}
            testID="theme-control"
          />
          <RowDivider />
          <SegmentedControl
            label="Text size"
            options={[
              { value: 'small', label: 'Small' },
              { value: 'default', label: 'Default' },
              { value: 'large', label: 'Large' },
            ]}
            value={preferences.textSize}
            onChange={(next) => update('textSize', next)}
            testID="text-size-control"
          />
          <RowDivider />
          <SettingsToggleRow
            label="Reduce motion"
            description="Minimize animations across the app"
            value={preferences.reduceMotion}
            onValueChange={(next) => update('reduceMotion', next)}
          />
        </SettingsSection>

        <SettingsSection title="Chat preferences">
          <SegmentedControl
            label="Response style"
            options={[
              { value: 'concise', label: 'Concise' },
              { value: 'balanced', label: 'Balanced' },
              { value: 'detailed', label: 'Detailed' },
            ]}
            value={preferences.responseStyle}
            onChange={(next) => update('responseStyle', next)}
            testID="response-style-control"
          />
          <RowDivider />
          <SettingsToggleRow
            label="Show citations"
            description="Display [S#] links and source cards under answers"
            value={preferences.citationDisplay === 'shown'}
            onValueChange={(next) => update('citationDisplay', next ? 'shown' : 'hidden')}
          />
          <RowDivider />
          <SettingsToggleRow
            label="Auto-scroll while streaming"
            description="Follow the answer as it is generated"
            value={preferences.autoScrollDuringStreaming}
            onValueChange={(next) => update('autoScrollDuringStreaming', next)}
          />
          <RowDivider />
          <SettingsRow
            label="Clear conversation history"
            tone="danger"
            value={conversationsCount === null ? undefined : String(conversationsCount)}
            description={
              conversationsCount === null
                ? undefined
                : conversationsCount === 1
                  ? '1 conversation'
                  : `${conversationsCount} conversations`
            }
            onPress={() => setClearHistoryOpen(true)}
          />
        </SettingsSection>

        <SettingsSection title="Documents">
          <SettingsRow
            label="Uploaded documents"
            value={documentsCount === null ? '…' : String(documentsCount)}
            onPress={() => router.push('/documents')}
          />
          <RowDivider />
          <SettingsRow
            label="Manage documents"
            description="Upload, preview, and remove individual files"
            chevron
            onPress={() => router.push('/documents')}
          />
          <RowDivider />
          <SettingsRow
            label="Remove all documents"
            tone="danger"
            description="Deletes every uploaded file and its index"
            onPress={() => setRemoveDocsOpen(true)}
          />
        </SettingsSection>

        <SettingsSection
          title="Privacy and data"
          footer="Documents you upload are split into small passages and indexed so answers can be grounded in them. They are only used to answer your questions — never to train models, and never shared with other users. You can export or erase everything here at any time."
        >
          <SettingsRow
            label="Export my data"
            description="Download your profile, conversations, and document list as JSON"
            value={busyAction === 'export' ? 'Preparing…' : undefined}
            disabled={busyAction === 'export'}
            onPress={() => void handleExportData()}
          />
          <RowDivider />
          <SettingsRow
            label="Delete all my data"
            tone="danger"
            description="Erases your conversations and documents, then signs you out"
            onPress={() => setDeleteAccountOpen(true)}
          />
        </SettingsSection>

        <SettingsSection title="About">
          <SettingsRow label="Version" value={appVersion} />
          <RowDivider />
          <SettingsRow label="Privacy policy" chevron onPress={() => setInfoDialog('privacy')} />
          <RowDivider />
          <SettingsRow label="Terms of service" chevron onPress={() => setInfoDialog('terms')} />
          <RowDivider />
          <SettingsRow label="Help and support" chevron onPress={() => setInfoDialog('help')} />
        </SettingsSection>

        {developerSettings ? (
          <SettingsSection title="Developer">
            <SettingsRow
              label="Developer settings"
              description="Backend URL, models, latency, service checks"
              chevron
              onPress={() => router.push('/developer-settings')}
              testID="developer-settings-row"
            />
          </SettingsSection>
        ) : null}
      </View>

      <ConfirmDialog
        visible={clearHistoryOpen}
        title="Clear conversation history?"
        body={
          conversationsCount === null || conversationsCount === 0
            ? 'This permanently deletes all of your conversations. Uploaded documents are kept. This cannot be undone.'
            : `This permanently deletes all ${conversationsCount} of your conversations. Uploaded documents are kept. This cannot be undone.`
        }
        confirmLabel="Clear history"
        busy={busyAction === 'clearHistory'}
        onConfirm={() => void handleClearHistory()}
        onCancel={() => setClearHistoryOpen(false)}
      />

      <ConfirmDialog
        visible={removeDocsOpen}
        title="Remove all documents?"
        body="This permanently deletes every document you have uploaded and its searchable index. Your conversations are kept. This cannot be undone."
        confirmLabel="Remove all"
        strongWord="DELETE"
        busy={busyAction === 'removeDocs'}
        onConfirm={() => void handleRemoveDocuments()}
        onCancel={() => setRemoveDocsOpen(false)}
      />

      <ConfirmDialog
        visible={deleteAccountOpen}
        title="Delete your EduMind data?"
        body="This permanently deletes all of your conversations and uploaded documents, then signs you out. Your EduMind account itself is not deleted — you can sign in again later. This cannot be undone."
        confirmLabel="Delete everything"
        strongWord="DELETE"
        busy={busyAction === 'deleteAccount'}
        onConfirm={() => void handleDeleteAccount()}
        onCancel={() => setDeleteAccountOpen(false)}
      />

      <InfoDialog
        visible={infoDialog === 'privacy'}
        title="Privacy policy"
        body="EduMind stores the documents you upload and the conversations you start so it can answer questions grounded in your material. Your documents are chunked and indexed for retrieval only — they are never used to train models and are never shared with other users. You can export a copy of your data or delete it entirely from this screen at any time."
        onClose={() => setInfoDialog(null)}
      />
      <InfoDialog
        visible={infoDialog === 'terms'}
        title="Terms of service"
        body="EduMind is provided as-is as a research reading assistant. Answers are generated by a language model grounded in the documents you upload — they can be incomplete or wrong, so always verify important claims against the cited sources before relying on them."
        onClose={() => setInfoDialog(null)}
      />
      <InfoDialog
        visible={infoDialog === 'help'}
        title="Help and support"
        body="If something isn't working, check your connection and try again — most issues resolve on their own within a minute. For anything else, report it on the project repository and include what you were doing when it happened."
        actionLabel="Open project repository"
        onAction={() => void Linking.openURL(REPOSITORY_URL)}
        onClose={() => setInfoDialog(null)}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: {
    padding: 16,
    gap: 20,
    width: '100%',
    maxWidth: 680,
    alignSelf: 'center',
    paddingBottom: 40,
  },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  banner: {
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  bannerText: { lineHeight: 18, fontWeight: '600' },
  feedbackOk: { fontWeight: '600', paddingHorizontal: 4 },
  feedbackError: { fontWeight: '600', paddingHorizontal: 4 },
  profileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  avatarImage: { backgroundColor: '#E2E8F0' },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  avatarFallbackText: { color: '#FFFFFF', fontWeight: '700' },
  profileInfo: { flex: 1, minWidth: 0, gap: 2 },
  profileName: { fontWeight: '700' },
  profileEmail: {},
  profileProvider: { marginTop: 2 },
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  dialogCard: {
    width: '100%',
    maxWidth: 440,
    borderRadius: 14,
    borderWidth: 1,
    padding: 20,
    gap: 12,
  },
  dialogTitle: { fontWeight: '700' },
  dialogBody: { lineHeight: 20 },
  dialogButtons: { flexDirection: 'row', gap: 10, marginTop: 4 },
  dialogButton: {
    flex: 1,
    borderRadius: 9,
    borderWidth: 1,
    paddingVertical: 11,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 42,
  },
  dialogActionText: { fontWeight: '700', fontSize: 14 },
  dialogCloseText: { fontWeight: '700', fontSize: 14 },
});
