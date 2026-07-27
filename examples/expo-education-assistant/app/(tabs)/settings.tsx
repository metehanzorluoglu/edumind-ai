import type { EducationAssistantClient, StatusResponse } from 'education-assistant-client';
import { useConversations, useEducationDocuments } from 'education-assistant-client';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useAuth } from '@/lib/AuthProvider';
import { DEFAULT_BASE_URL, useClient } from '@/lib/ClientProvider';
import { safeText } from '@/lib/format';

const READINESS_POLL_MS = 30_000;

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

interface ReadinessSnapshot {
  backend: boolean;
  ollama: boolean;
  qdrant: boolean;
}

/**
 * Polls GET /health/ready every 30s and immediately again whenever the app
 * returns to the foreground, replacing the old manual "Check now" button.
 * A failed request (backend unreachable) reports every dependency as down
 * rather than leaving ollama/qdrant in a stale "last known good" state.
 */
function useReadiness(client: EducationAssistantClient): ReadinessSnapshot | null {
  const [snapshot, setSnapshot] = useState<ReadinessSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function check(): Promise<void> {
      try {
        const result = await client.ready();
        if (cancelled) return;
        setSnapshot({
          backend: true,
          ollama: result.ollama_reachable,
          qdrant: result.qdrant_reachable,
        });
      } catch {
        if (cancelled) return;
        setSnapshot({ backend: false, ollama: false, qdrant: false });
      }
    }

    check();
    const interval = setInterval(check, READINESS_POLL_MS);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') check();
    });

    return () => {
      cancelled = true;
      clearInterval(interval);
      subscription.remove();
    };
  }, [client]);

  return snapshot;
}

/** Generation/embedding model names only — never this endpoint's document/chunk counts (see "Documents indexed" below, which reads from the same GET /documents the Documents screen itself uses, not this Qdrant-derived figure, so the two can never disagree). Refetched on every focus, matching the counts below. */
function useStatusInfo(client: EducationAssistantClient): StatusResponse | null {
  const [status, setStatus] = useState<StatusResponse | null>(null);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      client
        .status()
        .then((data) => {
          if (!cancelled) setStatus(data);
        })
        .catch(() => {
          // The Status section above already surfaces backend/Qdrant/Ollama
          // reachability — this just leaves the model-name rows at "…".
        });
      return () => {
        cancelled = true;
      };
    }, [client])
  );

  return status;
}

function Avatar({ uri, label }: { uri: string | null; label: string }) {
  if (uri) {
    return <Image source={{ uri }} style={styles.avatarImage} />;
  }
  const initial = label.trim().charAt(0).toUpperCase() || '?';
  return (
    <View style={styles.avatarFallback}>
      <Text style={styles.avatarFallbackText}>{initial}</Text>
    </View>
  );
}

function StatusDot({ label, ok }: { label: string; ok: boolean | null }) {
  const emoji = ok === null ? '⚪' : ok ? '🟢' : '🔴';
  return (
    <View style={styles.statusItem}>
      <Text style={styles.statusEmoji}>{emoji}</Text>
      <Text style={styles.statusLabel}>{label}</Text>
    </View>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

/** null means "not applicable" (e.g. vision disabled) rather than "unknown" — rendered as an em dash, distinct from the "…" used elsewhere for "not loaded yet". */
function formatAvailability(available: boolean | null): string {
  if (available === null) return '—';
  return available ? 'Available ✓' : 'Unavailable ✗';
}

function formatLatencyMs(ms: number | null): string {
  return ms === null ? '—' : `${Math.round(ms)} ms`;
}

export default function SettingsScreen() {
  const { user, logout } = useAuth();
  const { client, baseUrl, setBaseUrl, baseUrlError, baseUrlWarning, hydrated } = useClient();
  const [baseUrlInput, setBaseUrlInput] = useState(baseUrl);
  const [devOptionsOpen, setDevOptionsOpen] = useState(false);

  useEffect(() => {
    if (hydrated) setBaseUrlInput(baseUrl);
  }, [hydrated, baseUrl]);

  const readiness = useReadiness(client);
  const statusInfo = useStatusInfo(client);
  const { listState: documentsState, refresh: refreshDocuments } = useEducationDocuments(client);
  const { listState: conversationsState, refresh: refreshConversations } = useConversations(client);

  // Covers "refresh after document upload/deletion, login, and app
  // startup" (item 3): a document uploaded or deleted on the Documents tab
  // doesn't change this screen's own, separate useEducationDocuments()
  // instance at all until it's told to look again — which happens exactly
  // when this tab regains focus (including the very first time, right
  // after login or a cold start).
  //
  // Deliberately depends on `hydrated` only, not on refreshDocuments/
  // refreshConversations themselves — those close over useAsyncGuard's
  // per-render `{ begin, cancel }` object (see that hook's own docs), so
  // their identity changes on every render. expo-router's useFocusEffect
  // re-subscribes whenever its effect callback's identity changes, so
  // including them here would re-run this on every render it itself
  // triggers: refresh -> new listState -> re-render -> new refresh
  // identity -> effect re-fires -> refresh again, forever.
  useFocusEffect(
    useCallback(() => {
      if (!hydrated) return;
      refreshDocuments({ limit: 1 });
      refreshConversations({ limit: 1 });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [hydrated])
  );

  async function handleSaveBaseUrl(): Promise<void> {
    await setBaseUrl(baseUrlInput.trim() || DEFAULT_BASE_URL);
  }

  if (!hydrated || !user) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
      </View>
    );
  }

  const documentsIndexed = documentsState.status === 'success' ? String(documentsState.total) : '…';
  const conversationCount =
    conversationsState.status === 'success' ? String(conversationsState.total) : '…';
  const profileName = safeText(user.display_name, user.email);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.profileCard}>
        <Avatar uri={user.avatar_url} label={profileName} />
        <View style={styles.profileInfo}>
          <Text style={styles.profileName}>{profileName}</Text>
          <Text style={styles.profileEmail}>{user.email}</Text>
          <Text style={styles.profileProvider}>Signed in with {providerLabel(user.provider)}</Text>
        </View>
      </View>
      <Pressable style={styles.logoutButton} onPress={() => logout()}>
        <Text style={styles.logoutButtonText}>Log out</Text>
      </Pressable>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Status</Text>
        <View style={styles.statusRow}>
          <StatusDot label="Backend" ok={readiness?.backend ?? null} />
          <StatusDot label="Ollama" ok={readiness?.ollama ?? null} />
          <StatusDot label="Qdrant" ok={readiness?.qdrant ?? null} />
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Application</Text>
        <InfoRow label="Documents indexed" value={documentsIndexed} />
        <InfoRow label="Conversations" value={conversationCount} />
        <InfoRow label="Generation model" value={safeText(statusInfo?.generation_model, '…')} />
        <InfoRow label="Embedding model" value={safeText(statusInfo?.embedding_model, '…')} />
        <InfoRow
          label="Image generation"
          value={
            statusInfo
              ? statusInfo.image_generation_enabled
                ? 'Enabled ✓'
                : 'Disabled ✗'
              : '…'
          }
        />
      </View>

      <View style={styles.section}>
        <Pressable
          style={styles.devToggle}
          onPress={() => setDevOptionsOpen((open) => !open)}
          accessibilityRole="button"
          accessibilityState={{ expanded: devOptionsOpen }}
        >
          <Text style={styles.sectionTitle}>Developer options</Text>
          <Text style={styles.devToggleIcon}>{devOptionsOpen ? '▾' : '▸'}</Text>
        </Pressable>
        {devOptionsOpen && (
          <View style={styles.devOptionsBody}>
            <Text style={styles.hint}>
              Use your dev machine&apos;s LAN IP (not localhost) to reach the backend from a
              physical device — see the physical device networking docs in the package README.
            </Text>

            <Text style={styles.devSubheading}>Models</Text>
            <InfoRow label="Text model" value={safeText(statusInfo?.generation_model, '…')} />
            <InfoRow
              label="Text model availability"
              value={statusInfo ? formatAvailability(statusInfo.text_model_available) : '…'}
            />
            <InfoRow label="Vision model" value={safeText(statusInfo?.vision_model, '—')} />
            <InfoRow
              label="Vision model availability"
              value={statusInfo ? formatAvailability(statusInfo.vision_model_available) : '…'}
            />
            <InfoRow label="Embedding model" value={safeText(statusInfo?.embedding_model, '…')} />
            <InfoRow
              label="Embedding model availability"
              value={statusInfo ? formatAvailability(statusInfo.embedding_model_available) : '…'}
            />

            <Text style={styles.devSubheading}>Latency</Text>
            <InfoRow
              label="Ollama round trip"
              value={statusInfo ? formatLatencyMs(statusInfo.ollama_latency_ms) : '…'}
            />
            <InfoRow
              label="Qdrant round trip"
              value={statusInfo ? formatLatencyMs(statusInfo.qdrant_latency_ms) : '…'}
            />

            <Text style={styles.devSubheading}>Backend URL</Text>
            <TextInput
              style={styles.input}
              value={baseUrlInput}
              onChangeText={setBaseUrlInput}
              placeholder={DEFAULT_BASE_URL}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Pressable style={styles.button} onPress={handleSaveBaseUrl}>
              <Text style={styles.buttonText}>Save</Text>
            </Pressable>
            {baseUrlError && (
              <Text style={styles.error}>
                Invalid: {baseUrlError} (using {DEFAULT_BASE_URL} instead)
              </Text>
            )}
            {baseUrlWarning && <Text style={styles.warning}>{baseUrlWarning}</Text>}
            {!baseUrlError && !baseUrlWarning && <Text style={styles.ok}>Active: {baseUrl}</Text>}
          </View>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC' },
  content: { padding: 16, gap: 20 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  profileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  avatarImage: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#E2E8F0' },
  avatarFallback: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#208AEF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarFallbackText: { color: '#FFFFFF', fontSize: 22, fontWeight: '700' },
  profileInfo: { flex: 1, minWidth: 0 },
  profileName: { fontSize: 16, fontWeight: '700', color: '#0F172A' },
  profileEmail: { fontSize: 13, color: '#64748B', marginTop: 2 },
  profileProvider: { fontSize: 12, color: '#94A3B8', marginTop: 4 },
  logoutButton: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: '#FCA5A5',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  logoutButtonText: { color: '#B91C1C', fontWeight: '600', fontSize: 13 },
  section: {
    gap: 8,
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  sectionTitle: { fontWeight: '700', fontSize: 15, color: '#0F172A' },
  hint: { fontSize: 12, color: '#64748B' },
  statusRow: { flexDirection: 'row', gap: 20, marginTop: 4 },
  statusItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  statusEmoji: { fontSize: 14 },
  statusLabel: { fontSize: 13, color: '#334155' },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  infoLabel: { fontSize: 13, color: '#64748B' },
  infoValue: { fontSize: 13, color: '#0F172A', fontWeight: '600' },
  devToggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  devToggleIcon: { fontSize: 14, color: '#64748B' },
  devOptionsBody: { gap: 4, marginTop: 8 },
  devSubheading: {
    fontSize: 12,
    fontWeight: '700',
    color: '#94A3B8',
    textTransform: 'uppercase',
    marginTop: 12,
    marginBottom: 2,
  },
  input: {
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#FFFFFF',
  },
  button: {
    backgroundColor: '#208AEF',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  buttonText: { color: '#FFFFFF', fontWeight: '600' },
  ok: { fontSize: 12, color: '#166534' },
  warning: { fontSize: 12, color: '#B45309' },
  error: { fontSize: 12, color: '#B91C1C' },
});
