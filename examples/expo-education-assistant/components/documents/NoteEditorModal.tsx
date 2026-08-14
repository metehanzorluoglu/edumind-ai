import { useMemo, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { CloseIcon } from '@/components/icons';
import { IconButton } from '@/components/ui/IconButton';
import { useTheme, type Theme } from '@/lib/Preferences';

export interface NoteEditorModalProps {
  /** The passage the note is attached to — shown for context, never editable here. */
  selectedText: string;
  initialNote: string;
  saving: boolean;
  onCancel: () => void;
  onSave: (noteText: string) => void;
}

const MAX_NOTE_CHARS = 2000;

/**
 * Frontend Milestone 3 §19 — a small, focused editor for a highlight's
 * note. Deliberately narrow: one text field, the passage it's attached
 * to shown read-only above it for context, Cancel/Save — not a rich-text
 * editor, no folders/tags (explicitly out of scope — §40).
 */
export function NoteEditorModal({
  selectedText,
  initialNote,
  saving,
  onCancel,
  onSave,
}: NoteEditorModalProps) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const [noteText, setNoteText] = useState(initialNote);

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.overlay}>
        <Pressable
          style={styles.backdrop}
          onPress={onCancel}
          accessibilityRole="button"
          accessibilityLabel="Close note editor"
        />
        <View style={styles.panel}>
          <View style={styles.header}>
            <Text style={styles.title}>Note</Text>
            <IconButton
              label="Close"
              icon={<CloseIcon size={16} color={theme.faint} />}
              size="sm"
              onPress={onCancel}
            />
          </View>
          <Text style={styles.passageLabel}>Selected passage</Text>
          <Text style={styles.passage} numberOfLines={3}>
            “{selectedText}”
          </Text>
          <TextField
            label="Your note"
            placeholder="What's worth remembering about this passage?"
            value={noteText}
            onChangeText={setNoteText}
            multiline
            maxLength={MAX_NOTE_CHARS}
            autoFocus
          />
          <View style={styles.footer}>
            <Button label="Cancel" variant="ghost" size="sm" onPress={onCancel} disabled={saving} />
            <Button
              label="Save"
              variant="primary"
              size="sm"
              onPress={() => onSave(noteText.trim())}
              loading={saving}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    overlay: {
      ...StyleSheet.absoluteFillObject,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 40,
      elevation: 40,
    },
    backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: theme.overlay },
    panel: {
      backgroundColor: theme.card,
      borderRadius: theme.radius.lg,
      padding: 18,
      gap: 10,
      width: 420,
      maxWidth: '92%',
    },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    title: { color: theme.text, fontSize: 16, fontFamily: theme.fonts.display },
    passageLabel: {
      fontSize: 10,
      fontFamily: theme.fonts.bodySemibold,
      color: theme.faint,
      textTransform: 'uppercase',
      letterSpacing: 0.3,
    },
    passage: {
      fontSize: 13,
      lineHeight: 19,
      color: theme.subtext,
      fontFamily: theme.fonts.body,
      fontStyle: 'italic',
      backgroundColor: theme.background,
      borderRadius: theme.radius.sm,
      padding: 8,
    },
    footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 4 },
  });
}
