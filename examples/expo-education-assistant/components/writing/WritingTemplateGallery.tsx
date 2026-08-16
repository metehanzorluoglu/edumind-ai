import { useWritingTemplates } from 'education-assistant-client';
import type { WritingTemplateSummary } from 'education-assistant-client';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useClient } from '@/lib/ClientProvider';
import { useTheme, type Theme } from '@/lib/Preferences';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { FilterChip } from '@/components/ui/FilterChip';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { TextField } from '@/components/ui/TextField';

export interface WritingTemplateGalleryProps {
  /** Called once "Create project" succeeds — the caller navigates. */
  onCreated: (projectId: string) => void;
  onCancel: () => void;
}

/**
 * Milestone 5.4 (LaTeX Templates & Project Import) Part 21/22 — the
 * curated template gallery: search + category filter, cards with
 * Preview/Use template. Deliberately NOT a visual clone of Overleaf's
 * gallery (Part 21) — plain cards using this app's own design system,
 * no thumbnails (Part 22: templates aren't compiled just to render a
 * gallery card). Selecting "Preview" shows the file list + root
 * document + license/source inline, never a second navigation stack
 * (Part 24: no disconnected creation pages).
 */
export function WritingTemplateGallery({ onCreated, onCancel }: WritingTemplateGalleryProps) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const { client } = useClient();
  const {
    listState,
    refresh,
    search,
    setSearch,
    category,
    setCategory,
    visibleTemplates,
    categories,
    detailState,
    loadDetail,
    clearDetail,
    createFromTemplate,
    createState,
  } = useWritingTemplates(client);

  const [previewId, setPreviewId] = useState<string | null>(null);
  const [title, setTitle] = useState('');

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openPreview(template: WritingTemplateSummary): void {
    setPreviewId(template.id);
    setTitle(template.name);
    loadDetail(template.id);
  }

  function backToGrid(): void {
    setPreviewId(null);
    clearDetail();
  }

  async function handleCreate(): Promise<void> {
    if (!previewId || !title.trim()) return;
    try {
      const project = await createFromTemplate(previewId, { title: title.trim() });
      onCreated(project.id);
    } catch {
      // createState already carries the error — rendered below.
    }
  }

  if (previewId) {
    const detail = detailState.status === 'success' ? detailState.template : null;
    return (
      <View style={styles.previewWrap}>
        <Button label="← Back to templates" variant="ghost" size="sm" onPress={backToGrid} />
        {detailState.status === 'loading' && (
          <View style={styles.previewSkeletons}>
            <Skeleton width="60%" height={18} />
            <Skeleton width="100%" height={14} />
            <Skeleton width="100%" height={14} />
          </View>
        )}
        {detailState.status === 'error' && (
          <Notice tone="danger" body="Couldn't load this template's preview. Try again." />
        )}
        {detail && (
          <>
            <Text style={styles.previewTitle}>{detail.name}</Text>
            <Text style={styles.previewDescription}>{detail.description}</Text>
            <Text style={styles.previewMeta}>
              {detail.category} · {detail.source} · v{detail.version}
            </Text>
            <Text style={styles.previewLicense}>{detail.license}</Text>

            <Text style={styles.sectionLabel}>Files</Text>
            <View style={styles.fileList}>
              {detail.files.map((f) => (
                <Text key={f.path} style={styles.fileRow}>
                  {f.path === detail.root ? '★ ' : '  '}
                  {f.path}
                </Text>
              ))}
            </View>

            <TextField
              label="Project title"
              value={title}
              onChangeText={setTitle}
              placeholder="e.g. Laser Cutting in Design Education"
              autoFocus
              onSubmitEditing={() => void handleCreate()}
              returnKeyType="done"
            />
            {createState.status === 'error' && (
              <Notice tone="danger" body={createState.error.message} />
            )}
            <View style={styles.previewActions}>
              <Button label="Cancel" variant="ghost" size="sm" onPress={onCancel} />
              <Button
                label="Create project"
                variant="primary"
                size="sm"
                loading={createState.status === 'creating'}
                disabled={!title.trim()}
                onPress={() => void handleCreate()}
              />
            </View>
          </>
        )}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <TextField
        label="Search templates"
        placeholder="Search by name or description…"
        value={search}
        onChangeText={setSearch}
        accessibilityLabel="Search templates"
      />
      {categories.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipsRow}>
          <FilterChip label="All" selected={category === null} onPress={() => setCategory(null)} />
          {categories.map((c) => (
            <FilterChip
              key={c}
              label={c}
              selected={category === c}
              onPress={() => setCategory(c)}
            />
          ))}
        </ScrollView>
      )}

      {listState.status === 'loading' && (
        <ActivityIndicator style={styles.spinner} color={theme.accent} />
      )}
      {listState.status === 'error' && (
        <EmptyState
          title="Couldn't load templates."
          description={listState.error.message}
          actionLabel="Try again"
          onAction={() => refresh()}
        />
      )}
      {listState.status === 'success' && visibleTemplates.length === 0 && (
        <EmptyState
          title="No templates match your filters."
          description="Try a different search or category."
        />
      )}
      {visibleTemplates.length > 0 && (
        <View style={styles.grid}>
          {visibleTemplates.map((t) => (
            <View key={t.id} style={styles.card}>
              <Text style={styles.cardTitle} numberOfLines={1}>
                {t.name}
              </Text>
              <Text style={styles.cardDescription} numberOfLines={3}>
                {t.description}
              </Text>
              <Text style={styles.cardMeta}>
                {t.category} · {t.file_count} {t.file_count === 1 ? 'file' : 'files'}
              </Text>
              <View style={styles.cardActions}>
                <Button
                  label="Preview"
                  variant="ghost"
                  size="sm"
                  accessibilityLabel={`Preview ${t.name}`}
                  onPress={() => openPreview(t)}
                />
                <Button
                  label="Use template"
                  variant="primary"
                  size="sm"
                  accessibilityLabel={`Use template ${t.name}`}
                  onPress={() => openPreview(t)}
                />
              </View>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    container: { gap: 14 },
    chipsRow: { flexDirection: 'row' },
    spinner: { marginTop: 24 },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
    card: {
      flexGrow: 1,
      flexBasis: 220,
      maxWidth: 280,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: theme.radius.md,
      backgroundColor: theme.card,
      padding: 14,
      gap: 6,
    },
    cardTitle: { fontSize: 14.5, fontFamily: theme.fonts.bodySemibold, color: theme.text },
    cardDescription: {
      fontSize: 12.5,
      fontFamily: theme.fonts.body,
      color: theme.subtext,
      minHeight: 48,
    },
    cardMeta: { fontSize: 11.5, fontFamily: theme.fonts.body, color: theme.faint },
    cardActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 4 },
    previewWrap: { gap: 10 },
    previewSkeletons: { gap: 8, paddingVertical: 8 },
    previewTitle: { fontSize: 17, fontFamily: theme.fonts.display, color: theme.text },
    previewDescription: { fontSize: 13.5, fontFamily: theme.fonts.body, color: theme.subtext },
    previewMeta: { fontSize: 12, fontFamily: theme.fonts.body, color: theme.faint },
    previewLicense: { fontSize: 11.5, fontFamily: theme.fonts.body, color: theme.faint },
    sectionLabel: {
      fontSize: 12,
      fontFamily: theme.fonts.bodySemibold,
      color: theme.text,
      marginTop: 6,
    },
    fileList: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: theme.radius.sm,
      padding: 10,
      gap: 2,
      maxHeight: 160,
    },
    fileRow: { fontSize: 12, fontFamily: theme.fonts.mono, color: theme.subtext },
    previewActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 4 },
  });
}
