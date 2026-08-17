import type { CreateWritingProjectRequest, WritingProject } from 'education-assistant-client';
import { useMemo, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme, type Theme } from '@/lib/Preferences';
import { Button } from '@/components/ui/Button';
import { CloseIcon, DocumentsIcon, UploadIcon, WritingIcon } from '@/components/icons';
import { Notice } from '@/components/ui/Notice';
import { TextField } from '@/components/ui/TextField';
import { WritingProjectImportPanel } from './WritingProjectImportPanel';
import { WritingTemplateGallery } from './WritingTemplateGallery';

type Mode = 'choice' | 'blank' | 'templates' | 'upload';

export interface CreateWritingProjectModalProps {
  visible: boolean;
  onClose: () => void;
  /** Milestone 5 (Academic Writing) — Blank Project uses the existing
   * plain WritingProject creation; this modal doesn't own that request
   * itself so a single "createProject" implementation (and its
   * optimistic-list-update behavior) stays owned by the caller's
   * useWritingProjects() hook, exactly like before this milestone. */
  createBlankProject: (
    request: CreateWritingProjectRequest
  ) => Promise<WritingProject | { id: string }>;
  onCreated: (projectId: string) => void;
}

/**
 * Milestone 5.4 (LaTeX Templates & Project Import) Part 24 — "+ New
 * writing project" now offers Blank Project / Curated Template /
 * Upload .zip from one modal, never three disconnected pages. Every
 * path funnels to the SAME onCreated(projectId) callback since every
 * path produces an ordinary WritingProject (Part 16) — the caller
 * doesn't need to know which one was used.
 */
export function CreateWritingProjectModal({
  visible,
  onClose,
  createBlankProject,
  onCreated,
}: CreateWritingProjectModalProps) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const [mode, setMode] = useState<Mode>('choice');
  const [blankTitle, setBlankTitle] = useState('');
  const [blankCreating, setBlankCreating] = useState(false);
  const [blankError, setBlankError] = useState<string | null>(null);

  function reset(): void {
    setMode('choice');
    setBlankTitle('');
    setBlankError(null);
    setBlankCreating(false);
  }

  function handleClose(): void {
    reset();
    onClose();
  }

  function handleCreated(projectId: string): void {
    reset();
    onCreated(projectId);
  }

  async function handleCreateBlank(): Promise<void> {
    const trimmed = blankTitle.trim();
    if (!trimmed || blankCreating) return;
    setBlankCreating(true);
    setBlankError(null);
    try {
      const project = await createBlankProject({ title: trimmed });
      handleCreated(project.id);
    } catch (error) {
      setBlankError(error instanceof Error ? error.message : 'Could not create project.');
    } finally {
      setBlankCreating(false);
    }
  }

  const titleForMode: Record<Mode, string> = {
    choice: 'New writing project',
    blank: 'Blank project',
    templates: 'Choose a template',
    upload: 'Upload a LaTeX project',
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleClose}>
      <View style={[styles.backdrop, { backgroundColor: theme.overlay }]}>
        <View
          style={[
            styles.card,
            {
              backgroundColor: theme.card,
              borderColor: theme.border,
              borderRadius: theme.radius.lg,
            },
          ]}
        >
          <View style={styles.header}>
            {mode !== 'choice' && (
              <Pressable
                onPress={() => setMode('choice')}
                accessibilityRole="button"
                accessibilityLabel="Back to creation options"
              >
                <Text style={[styles.backLink, { color: theme.accent }]}>← Back</Text>
              </Pressable>
            )}
            <Text style={[styles.title, { color: theme.text, fontFamily: theme.fonts.display }]}>
              {titleForMode[mode]}
            </Text>
            <Pressable
              onPress={handleClose}
              accessibilityRole="button"
              accessibilityLabel="Close"
              style={styles.closeButton}
            >
              <CloseIcon size={16} color={theme.subtext} />
            </Pressable>
          </View>

          <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
            {mode === 'choice' && (
              <View style={styles.choiceGrid}>
                <ChoiceCard
                  theme={theme}
                  icon={<WritingIcon size={22} color={theme.accent} />}
                  title="Blank project"
                  description="Start from a minimal, honest LaTeX template."
                  onPress={() => setMode('blank')}
                />
                <ChoiceCard
                  theme={theme}
                  icon={<DocumentsIcon size={22} color={theme.accent} />}
                  title="EduM8 template"
                  description="Article, conference paper, thesis, and more — ready to write."
                  onPress={() => setMode('templates')}
                />
                <ChoiceCard
                  theme={theme}
                  icon={<UploadIcon size={22} color={theme.accent} />}
                  title="Upload .zip"
                  description="Import a .zip from your university, publisher, Overleaf, or another LaTeX editor."
                  onPress={() => setMode('upload')}
                />
              </View>
            )}

            {mode === 'blank' && (
              <View style={styles.blankForm}>
                <TextField
                  label="Project title"
                  value={blankTitle}
                  onChangeText={setBlankTitle}
                  placeholder="e.g. Laser Cutting in Design Education"
                  autoFocus
                  editable={!blankCreating}
                  onSubmitEditing={() => void handleCreateBlank()}
                  returnKeyType="done"
                />
                {blankError && <Notice tone="danger" body={blankError} />}
                <View style={styles.blankActions}>
                  <Button label="Cancel" variant="ghost" size="sm" onPress={handleClose} />
                  <Button
                    label="Create"
                    variant="primary"
                    size="sm"
                    loading={blankCreating}
                    disabled={!blankTitle.trim()}
                    onPress={() => void handleCreateBlank()}
                  />
                </View>
              </View>
            )}

            {mode === 'templates' && (
              <WritingTemplateGallery onCreated={handleCreated} onCancel={handleClose} />
            )}

            {mode === 'upload' && (
              <WritingProjectImportPanel onCreated={handleCreated} onCancel={handleClose} />
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function ChoiceCard({
  theme,
  icon,
  title,
  description,
  onPress,
}: {
  theme: Theme;
  icon: React.ReactNode;
  title: string;
  description: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={title}
      style={({ pressed }) => [
        choiceStyles.card,
        {
          borderColor: theme.border,
          borderRadius: theme.radius.md,
          backgroundColor: pressed ? theme.cardPressed : theme.card,
        },
      ]}
    >
      {icon}
      <Text
        style={[
          choiceStyles.cardTitle,
          { color: theme.text, fontFamily: theme.fonts.bodySemibold },
        ]}
      >
        {title}
      </Text>
      <Text
        style={[
          choiceStyles.cardDescription,
          { color: theme.subtext, fontFamily: theme.fonts.body },
        ]}
      >
        {description}
      </Text>
    </Pressable>
  );
}

const choiceStyles = StyleSheet.create({
  card: {
    flexGrow: 1,
    flexBasis: 160,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    gap: 6,
    minHeight: 120,
  },
  cardTitle: { fontSize: 14 },
  cardDescription: { fontSize: 12, lineHeight: 17 },
});

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
    card: {
      width: '100%',
      maxWidth: 640,
      maxHeight: '90%',
      borderWidth: 1,
      overflow: 'hidden',
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingHorizontal: 18,
      paddingTop: 16,
      paddingBottom: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    backLink: { fontSize: 13, fontFamily: theme.fonts.bodySemibold },
    title: { fontSize: 16, flex: 1 },
    closeButton: { padding: 4 },
    body: Platform.OS === 'web' ? ({ maxHeight: '70vh' } as object) : {},
    bodyContent: { padding: 18, gap: 14 },
    choiceGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
    blankForm: { gap: 12, maxWidth: 420 },
    blankActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  });
}
