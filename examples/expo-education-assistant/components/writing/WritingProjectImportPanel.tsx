import { useWritingProjectImport } from 'education-assistant-client';
import * as DocumentPicker from 'expo-document-picker';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useClient } from '@/lib/ClientProvider';
import { useTheme, type Theme } from '@/lib/Preferences';
import { buildUploadableFileFromPickerAsset } from '@/lib/writingFileUpload';
import { Button } from '@/components/ui/Button';
import { CheckIcon, UploadIcon } from '@/components/icons';
import { Notice } from '@/components/ui/Notice';
import { TextField } from '@/components/ui/TextField';

export interface WritingProjectImportPanelProps {
  onCreated: (projectId: string) => void;
  onCancel: () => void;
}

/**
 * Milestone 5.4 (LaTeX Templates & Project Import) Part 5/9/14 — the
 * ZIP-import flow's UI: pick a .zip -> inspect (server-side security
 * pipeline) -> review the detected files/root/warnings -> confirm.
 * Never creates anything from an unconfirmed upload (Part 9) — the
 * "Create project" button only appears once inspection has succeeded.
 */
export function WritingProjectImportPanel({ onCreated, onCancel }: WritingProjectImportPanelProps) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const { client } = useClient();
  const { inspectState, inspect, confirmState, confirmImport, discardImport } =
    useWritingProjectImport(client);

  const [title, setTitle] = useState('');
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);

  // Part 32 — discard any staged session if the panel unmounts without
  // the user explicitly confirming or cancelling (e.g. they close the
  // whole modal, or switch to a different creation mode, mid-preview).
  // The cleanup function below runs from an unmount-time effect with an
  // EMPTY dependency array (deliberately — it must fire exactly once,
  // not on every inspectState change), so a plain closure over
  // `discardImport` would stay bound to whatever it was on the FIRST
  // render (`inspectState.status === 'idle'`) and silently never cancel
  // a session that only exists in a LATER render — routing every call
  // through a ref that's kept current on every render (mirroring
  // app/(tabs)/writing/index.tsx's own identical `refreshRef` fix for
  // the same stale-closure class of bug) sidesteps that entirely.
  //
  // `resolvedRef` closes a second, narrower race on top of that: a
  // successful confirmImport() already resets the hook's own
  // inspectState to 'idle' (so a correctly-current discardImportRef
  // would no-op), but the effect above only refreshes the ref on
  // React's NEXT render/effect pass — if unmount (navigating away after
  // onCreated()) happens before that pass runs, discardImportRef can
  // still be one render stale and fire an unnecessary (if harmless —
  // Part 32: an already-consumed session 404s and is silently treated
  // as already-gone) DELETE against a session that was just confirmed.
  // Marking resolution synchronously, in the same tick confirm/cancel
  // succeeds, closes that window without depending on render timing at
  // all.
  const resolvedRef = useRef(false);
  const discardImportRef = useRef(discardImport);
  useEffect(() => {
    discardImportRef.current = discardImport;
  });
  useEffect(() => {
    return () => {
      if (!resolvedRef.current) discardImportRef.current();
    };
  }, []);

  useEffect(() => {
    if (inspectState.status === 'success') {
      setTitle(inspectState.inspection.suggested_title);
      setRootPath(inspectState.inspection.preselected_root);
    }
  }, [inspectState]);

  async function handlePick(): Promise<void> {
    setPickError(null);
    const picked = await DocumentPicker.getDocumentAsync({
      type: ['application/zip', 'application/x-zip-compressed'],
      copyToCacheDirectory: true,
    });
    if (picked.canceled || picked.assets.length === 0) return;
    const asset = picked.assets[0]!;
    try {
      const file = await buildUploadableFileFromPickerAsset(asset);
      inspect(file);
    } catch (error) {
      setPickError(error instanceof Error ? error.message : `Could not read "${asset.name}".`);
    }
  }

  function handleCancel(): void {
    resolvedRef.current = true;
    discardImport();
    onCancel();
  }

  async function handleConfirm(): Promise<void> {
    if (!title.trim()) return;
    try {
      const project = await confirmImport({ title: title.trim(), rootPath: rootPath ?? undefined });
      resolvedRef.current = true;
      onCreated(project.id);
    } catch {
      // confirmState already carries the error — rendered below.
    }
  }

  if (inspectState.status === 'idle' || inspectState.status === 'cancelled') {
    return (
      <View style={styles.pickWrap}>
        <Text style={styles.helper}>
          Have a LaTeX project or template from Overleaf, your university, or a publisher? Upload
          its .zip here.
        </Text>
        {pickError && <Notice tone="danger" body={pickError} />}
        <Pressable
          onPress={() => void handlePick()}
          accessibilityRole="button"
          accessibilityLabel="Choose a .zip file to upload"
          style={({ pressed }) => [
            styles.dropZone,
            { borderColor: pressed ? theme.accent : theme.border },
          ]}
        >
          <UploadIcon size={22} color={theme.subtext} />
          <Text style={styles.dropZoneText}>Choose a .zip file</Text>
        </Pressable>
        <View style={styles.pickActions}>
          <Button label="Cancel" variant="ghost" size="sm" onPress={onCancel} />
        </View>
      </View>
    );
  }

  if (inspectState.status === 'inspecting') {
    return (
      <View style={styles.inspectingWrap}>
        <ActivityIndicator color={theme.accent} />
        <Text style={styles.helper}>Checking your archive…</Text>
      </View>
    );
  }

  if (inspectState.status === 'error') {
    return (
      <View style={styles.pickWrap}>
        <Notice
          tone="danger"
          title="Couldn't import this archive"
          body={inspectState.error.message}
        />
        <View style={styles.pickActions}>
          <Button
            label="Choose a different file"
            variant="secondary"
            size="sm"
            onPress={() => void handlePick()}
          />
          <Button label="Cancel" variant="ghost" size="sm" onPress={onCancel} />
        </View>
      </View>
    );
  }

  // inspectState.status === 'success'
  const inspection = inspectState.inspection;
  const needsRootChoice =
    inspection.preselected_root === null && inspection.root_candidates.length > 1;
  const canConfirm = title.trim().length > 0 && (!needsRootChoice || rootPath !== null);

  return (
    <View style={styles.previewWrap}>
      {inspection.warnings.length > 0 && (
        <View style={styles.warningsList}>
          {inspection.warnings.map((w) => (
            <Notice key={w.path} tone="warning" title={w.path} body={w.reason} />
          ))}
        </View>
      )}

      {needsRootChoice && (
        <>
          <Text style={styles.sectionLabel}>Which file is your main document?</Text>
          <View style={styles.rootList}>
            {inspection.root_candidates.map((path) => (
              <Pressable
                key={path}
                onPress={() => setRootPath(path)}
                accessibilityRole="radio"
                accessibilityState={{ checked: rootPath === path }}
                accessibilityLabel={`Set ${path} as the root document`}
                style={styles.rootRow}
              >
                <View
                  style={[
                    styles.radioOuter,
                    { borderColor: rootPath === path ? theme.accent : theme.border },
                  ]}
                >
                  {rootPath === path && (
                    <View style={[styles.radioInner, { backgroundColor: theme.accent }]} />
                  )}
                </View>
                <Text style={styles.rootRowText}>{path}</Text>
              </Pressable>
            ))}
          </View>
        </>
      )}

      <Text style={styles.sectionLabel}>
        Files ({inspection.files.length}
        {inspection.warnings.length > 0 ? `, ${inspection.warnings.length} skipped` : ''})
      </Text>
      <View style={styles.fileList}>
        {inspection.files.map((f) => (
          <View key={f.path} style={styles.fileRow}>
            {f.path === rootPath && <CheckIcon size={11} color={theme.accent} />}
            <Text style={[styles.fileRowText, f.path === rootPath && { color: theme.accent }]}>
              {f.path}
            </Text>
          </View>
        ))}
      </View>

      <TextField
        label="Project title"
        value={title}
        onChangeText={setTitle}
        placeholder="e.g. Laser Cutting in Design Education"
        onSubmitEditing={() => void handleConfirm()}
        returnKeyType="done"
      />
      {confirmState.status === 'error' && (
        <Notice tone="danger" body={confirmState.error.message} />
      )}

      <View style={styles.previewActions}>
        <Button label="Cancel" variant="ghost" size="sm" onPress={handleCancel} />
        <Button
          label="Create project"
          variant="primary"
          size="sm"
          loading={confirmState.status === 'confirming'}
          disabled={!canConfirm}
          onPress={() => void handleConfirm()}
        />
      </View>
    </View>
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    pickWrap: { gap: 12 },
    helper: { fontSize: 13, fontFamily: theme.fonts.body, color: theme.subtext, lineHeight: 19 },
    dropZone: {
      borderWidth: StyleSheet.hairlineWidth * 2,
      borderStyle: 'dashed',
      borderRadius: theme.radius.md,
      paddingVertical: 32,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
    },
    dropZoneText: { fontSize: 13, fontFamily: theme.fonts.bodySemibold, color: theme.subtext },
    pickActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
    inspectingWrap: { alignItems: 'center', gap: 10, paddingVertical: 32 },
    previewWrap: { gap: 12 },
    warningsList: { gap: 6 },
    sectionLabel: { fontSize: 12, fontFamily: theme.fonts.bodySemibold, color: theme.text },
    rootList: { gap: 4 },
    rootRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
    radioOuter: {
      width: 16,
      height: 16,
      borderRadius: 8,
      borderWidth: 1.5,
      alignItems: 'center',
      justifyContent: 'center',
    },
    radioInner: { width: 8, height: 8, borderRadius: 4 },
    rootRowText: { fontSize: 13, fontFamily: theme.fonts.mono, color: theme.text },
    fileList: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: theme.radius.sm,
      padding: 10,
      gap: 2,
      maxHeight: 160,
    },
    fileRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    fileRowText: { fontSize: 12, fontFamily: theme.fonts.mono, color: theme.subtext },
    previewActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 4 },
  });
}
