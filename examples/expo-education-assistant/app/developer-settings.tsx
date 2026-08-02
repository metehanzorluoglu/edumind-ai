import type { EducationAssistantClient, StatusResponse } from 'education-assistant-client';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { RowDivider, SettingsRow } from '@/components/settings/SettingsRow';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { useAuth } from '@/lib/AuthProvider';
import { DEFAULT_BASE_URL, useClient } from '@/lib/ClientProvider';
import { useFeatureFlags } from '@/lib/FeatureFlags';
import { safeText } from '@/lib/format';
import { useTheme } from '@/lib/Preferences';
import { useReadiness } from '@/lib/useServiceStatus';

/** Generation/embedding/vision model names and latency only — never this
 * endpoint's document/chunk counts (the Documents screen reads those from
 * GET /documents itself, so the two figures can never disagree here). */
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
          // Readiness dots above already surface connectivity — this just
          // leaves the model rows at "…".
        });
      return () => {
        cancelled = true;
      };
    }, [client])
  );

  return status;
}

function StatusDot({ label, ok }: { label: string; ok: boolean | null }) {
  const theme = useTheme();
  const emoji = ok === null ? '⚪' : ok ? '🟢' : '🔴';
  return (
    <View style={styles.statusItem}>
      <Text style={styles.statusEmoji}>{emoji}</Text>
      <Text style={[styles.statusLabel, { color: theme.subtext }]}>{label}</Text>
    </View>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View style={styles.infoRow}>
      <Text style={[styles.infoLabel, { color: theme.subtext }]}>{label}</Text>
      <Text style={[styles.infoValue, { color: theme.text }]}>{value}</Text>
    </View>
  );
}

/** null means "not applicable" (e.g. vision disabled) rather than "unknown"
 * — rendered as an em dash, distinct from the "…" used for "not loaded". */
function formatAvailability(available: boolean | null): string {
  if (available === null) return '—';
  return available ? 'Available ✓' : 'Unavailable ✗';
}

function formatLatencyMs(ms: number | null): string {
  return ms === null ? '—' : `${Math.round(ms)} ms`;
}

/**
 * Developer-only diagnostics and configuration: per-service readiness,
 * model names/availability, latency, and the backend URL editor. This
 * entire screen (and its Settings entry point) is gated behind the
 * developerSettings feature flag — a production build never bundles the
 * flag on, so none of this infrastructure detail ever reaches end users.
 * The screen also self-guards: navigating here directly with the flag off
 * shows a dead end, not the tooling.
 */
export default function DeveloperSettingsScreen() {
  const { user } = useAuth();
  const { client, baseUrl, setBaseUrl, baseUrlError, baseUrlWarning, hydrated } = useClient();
  const { developerSettings } = useFeatureFlags();
  const router = useRouter();
  const theme = useTheme();
  const [baseUrlInput, setBaseUrlInput] = useState(baseUrl);

  useEffect(() => {
    if (hydrated) setBaseUrlInput(baseUrl);
  }, [hydrated, baseUrl]);

  const readiness = useReadiness(client);
  const statusInfo = useStatusInfo(client);

  async function handleSaveBaseUrl(): Promise<void> {
    await setBaseUrl(baseUrlInput.trim() || DEFAULT_BASE_URL);
  }

  const header = (
    <View style={[styles.header, { borderColor: theme.border, backgroundColor: theme.background }]}>
      <Pressable
        onPress={() => router.back()}
        accessibilityRole="button"
        accessibilityLabel="Back to settings"
        style={styles.backButton}
      >
        <Text style={[styles.backText, { color: theme.accent }]}>‹ Settings</Text>
      </Pressable>
      <Text style={[styles.headerTitle, { color: theme.text }]}>Developer settings</Text>
      <View style={styles.backButton} />
    </View>
  );

  if (!developerSettings) {
    return (
      <View style={[styles.container, { backgroundColor: theme.background }]}>
        {header}
        <View style={styles.centered}>
          <Text style={[styles.unavailableText, { color: theme.subtext }]}>
            Developer settings are not available in this build.
          </Text>
        </View>
      </View>
    );
  }

  if (!hydrated || !user) {
    return (
      <View style={[styles.container, { backgroundColor: theme.background }]}>
        {header}
        <View style={styles.centered}>
          <ActivityIndicator />
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      {header}
      <ScrollView contentContainerStyle={styles.content}>
        <SettingsSection title="Service status">
          <View style={[styles.statusGrid, { backgroundColor: theme.card }]}>
            <StatusDot label="Backend" ok={readiness?.backend ?? null} />
            <StatusDot label="Ollama" ok={readiness?.ollama ?? null} />
            <StatusDot label="Qdrant" ok={readiness?.qdrant ?? null} />
          </View>
        </SettingsSection>

        <SettingsSection title="Models">
          <View style={{ backgroundColor: theme.card }}>
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
          </View>
        </SettingsSection>

        <SettingsSection title="Latency">
          <View style={{ backgroundColor: theme.card }}>
            <InfoRow
              label="Ollama round trip"
              value={statusInfo ? formatLatencyMs(statusInfo.ollama_latency_ms) : '…'}
            />
            <InfoRow
              label="Qdrant round trip"
              value={statusInfo ? formatLatencyMs(statusInfo.qdrant_latency_ms) : '…'}
            />
          </View>
        </SettingsSection>

        <SettingsSection title="Backend URL">
          <View style={[styles.backendUrlBlock, { backgroundColor: theme.card }]}>
            <TextInput
              style={[
                styles.input,
                {
                  color: theme.text,
                  borderColor: theme.border,
                  backgroundColor: theme.background,
                },
              ]}
              value={baseUrlInput}
              onChangeText={setBaseUrlInput}
              placeholder={DEFAULT_BASE_URL}
              placeholderTextColor={theme.faint}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Backend base URL"
            />
            <Pressable
              style={({ pressed }) => [
                styles.saveButton,
                { backgroundColor: theme.accent, opacity: pressed ? 0.85 : 1 },
              ]}
              onPress={() => void handleSaveBaseUrl()}
              accessibilityRole="button"
              accessibilityLabel="Save backend URL"
            >
              <Text style={[styles.saveButtonText, { color: theme.accentContrast }]}>Save</Text>
            </Pressable>
            {baseUrlError ? (
              <Text style={[styles.feedback, { color: theme.danger }]}>
                Invalid: {baseUrlError} (using {DEFAULT_BASE_URL} instead)
              </Text>
            ) : null}
            {baseUrlWarning ? (
              <Text style={[styles.feedback, { color: theme.warning }]}>{baseUrlWarning}</Text>
            ) : null}
            {!baseUrlError && !baseUrlWarning ? (
              <Text style={[styles.feedback, { color: theme.ok }]}>Active: {baseUrl}</Text>
            ) : null}
          </View>
        </SettingsSection>

        <SettingsSection
          title="Networking"
          footer="Use your dev machine's LAN IP (not localhost) to reach the backend from a physical device — see the physical device networking docs in the package README."
        >
          <SettingsRow label="Current backend" value={baseUrl} />
          <RowDivider />
          <SettingsRow label="Default backend" value={DEFAULT_BASE_URL} />
        </SettingsSection>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 10,
    borderBottomWidth: 1,
  },
  backButton: { minWidth: 84, paddingVertical: 4 },
  backText: { fontSize: 15, fontWeight: '600' },
  headerTitle: { fontSize: 16, fontWeight: '700' },
  content: { padding: 16, gap: 20, maxWidth: 680, width: '100%', alignSelf: 'center' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  unavailableText: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  statusGrid: { flexDirection: 'row', gap: 20, paddingHorizontal: 16, paddingVertical: 14 },
  statusItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  statusEmoji: { fontSize: 14 },
  statusLabel: { fontSize: 13 },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  infoLabel: { fontSize: 13 },
  infoValue: { fontSize: 13, fontWeight: '600' },
  backendUrlBlock: { padding: 16, gap: 10 },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14,
  },
  saveButton: {
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    minHeight: 40,
    justifyContent: 'center',
  },
  saveButtonText: { fontWeight: '700', fontSize: 14 },
  feedback: { fontSize: 12, lineHeight: 16 },
});
