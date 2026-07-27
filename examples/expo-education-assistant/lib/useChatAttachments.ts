import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { useCallback, useRef, useState } from 'react';
import { Alert, Platform } from 'react-native';
import {
  ACCEPTED_ATTACHMENT_MIME_TYPES,
  createPendingAttachment,
  MAX_ATTACHMENTS_PER_MESSAGE,
  type PendingAttachment,
} from './chatAttachments';

export interface UseChatAttachmentsResult {
  attachments: PendingAttachment[];
  /** Web: opens the native file picker directly. iOS/Android: shows a choice between Photo Library, Camera (see requestCamera), and Files. */
  pickAttachment: () => void;
  /** Stages an already-built PendingAttachment directly, bypassing every picker — used by GeneratedImageGallery's "Use as attachment" (see lib/chatAttachments.ts's createPendingAttachmentFromRemote), which already has real file bytes and just needs them added to the composer's pending list like any other pick. Silently a no-op past MAX_ATTACHMENTS_PER_MESSAGE, same as every other add path. */
  addAttachment: (attachment: PendingAttachment) => void;
  removeAttachment: (localId: string) => void;
  clearAttachments: () => void;
  /** Attach to a plain host <div> wrapping the whole composer on web (see documents.tsx's dropZoneRefCallback pattern for why a raw div, not a <View>, is required) to enable both drag-and-drop and clipboard paste. A no-op ref on native. */
  dropZoneRefCallback: (node: HTMLDivElement | null) => void;
  isDragOver: boolean;
}

const canAttachMore = (current: PendingAttachment[]): boolean =>
  current.length < MAX_ATTACHMENTS_PER_MESSAGE;

/**
 * Owns the "attach files to this chat message" flow end to end — picking
 * (native gallery/camera/file picker, web file input/drag-and-drop/paste),
 * local validation, and the pending list itself — so both chat/new.tsx and
 * chat/[id].tsx share one implementation rather than two composers drifting
 * apart on what "attach a file" means. Nothing here ever calls the backend:
 * attachments are only ever uploaded as part of the actual message send
 * (see lib/chatAttachments.ts's toAttachmentUploads).
 */
export function useChatAttachments(): UseChatAttachmentsResult {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const dropZoneCleanupRef = useRef<(() => void) | null>(null);

  const addPending = useCallback((next: PendingAttachment) => {
    setAttachments((prev) => (canAttachMore(prev) ? [...prev, next] : prev));
  }, []);

  const addWebFiles = useCallback(
    async (files: File[]) => {
      for (const file of files) {
        const pending = await createPendingAttachment({
          uri: URL.createObjectURL(file),
          name: file.name,
          size: file.size,
          mimeType: file.type || null,
          webFile: file,
        });
        addPending(pending);
      }
    },
    [addPending]
  );

  const removeAttachment = useCallback((localId: string) => {
    setAttachments((prev) => prev.filter((a) => a.localId !== localId));
  }, []);

  const clearAttachments = useCallback(() => {
    setAttachments([]);
  }, []);

  async function pickFromImageLibrary(): Promise<void> {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Photo library access needed', 'Allow photo library access to attach an image.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: MAX_ATTACHMENTS_PER_MESSAGE,
      quality: 1,
    });
    if (result.canceled) return;
    for (const asset of result.assets) {
      const pending = await createPendingAttachment({
        uri: asset.uri,
        name: asset.fileName ?? 'photo.jpg',
        size: asset.fileSize ?? null,
        mimeType: asset.mimeType ?? null,
        webFile: asset.file ?? null,
      });
      addPending(pending);
    }
  }

  async function pickFromCamera(): Promise<void> {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Camera access needed', 'Allow camera access to take a photo to attach.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 });
    if (result.canceled || result.assets.length === 0) return;
    const asset = result.assets[0]!;
    const pending = await createPendingAttachment({
      uri: asset.uri,
      name: asset.fileName ?? 'photo.jpg',
      size: asset.fileSize ?? null,
      mimeType: asset.mimeType ?? null,
      webFile: asset.file ?? null,
    });
    addPending(pending);
  }

  async function pickFromFiles(): Promise<void> {
    const result = await DocumentPicker.getDocumentAsync({
      type: [...ACCEPTED_ATTACHMENT_MIME_TYPES],
      multiple: true,
      copyToCacheDirectory: true,
    });
    if (result.canceled) return;
    for (const asset of result.assets) {
      const pending = await createPendingAttachment({
        uri: asset.uri,
        name: asset.name,
        size: asset.size ?? null,
        mimeType: asset.mimeType ?? null,
        webFile: asset.file ?? null,
      });
      addPending(pending);
    }
  }

  const pickAttachment = useCallback(() => {
    if (Platform.OS === 'web') {
      void pickFromFiles();
      return;
    }
    Alert.alert('Attach', undefined, [
      { text: 'Photo Library', onPress: () => void pickFromImageLibrary() },
      { text: 'Camera', onPress: () => void pickFromCamera() },
      { text: 'Files', onPress: () => void pickFromFiles() },
      { text: 'Cancel', style: 'cancel' },
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Web-only: drag-and-drop AND clipboard paste, both wired onto the same
  // container node. Identical drag-and-drop wiring to documents.tsx's
  // dropZoneRefCallback (see that function's extensive docs for why a
  // dragCounter is needed and why this must be a callback ref, imperatively
  // attached to a raw DOM node, rather than onDrag*/onPaste props on a
  // react-native-web element — neither TextInput nor View forward those
  // event props to the underlying DOM node; see
  // node_modules/react-native-web/dist/modules/forwardedProps). A paste
  // event fired while focus is inside the composer's TextInput (a real
  // <input> under react-native-web) still bubbles up to this container, so
  // listening here — rather than needing a ref into TextInput's internal
  // DOM node — is sufficient to catch "paste a screenshot while typing".
  // Only image clipboard items are ever attached this way; a plain text
  // paste (the overwhelmingly common case) is completely unaffected and
  // continues to paste into the text field as normal.
  const dropZoneRefCallback = useCallback((node: HTMLDivElement | null) => {
    dropZoneCleanupRef.current?.();
    dropZoneCleanupRef.current = null;
    if (!node || Platform.OS !== 'web') return;

    function isFileDrag(event: DragEvent): boolean {
      return Array.from(event.dataTransfer?.types ?? []).includes('Files');
    }

    function onDragEnter(event: DragEvent): void {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      dragCounterRef.current += 1;
      setIsDragOver(true);
    }

    function onDragOver(event: DragEvent): void {
      if (!isFileDrag(event)) return;
      event.preventDefault();
    }

    function onDragLeave(event: DragEvent): void {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
      if (dragCounterRef.current === 0) setIsDragOver(false);
    }

    function onDrop(event: DragEvent): void {
      event.preventDefault();
      dragCounterRef.current = 0;
      setIsDragOver(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) void addWebFiles(files);
    }

    function onPaste(event: ClipboardEvent): void {
      const items = event.clipboardData?.items;
      if (!items) return;
      const imageFiles: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) void addWebFiles(imageFiles);
    }

    node.addEventListener('dragenter', onDragEnter);
    node.addEventListener('dragover', onDragOver);
    node.addEventListener('dragleave', onDragLeave);
    node.addEventListener('drop', onDrop);
    node.addEventListener('paste', onPaste);
    dropZoneCleanupRef.current = () => {
      node.removeEventListener('dragenter', onDragEnter);
      node.removeEventListener('dragover', onDragOver);
      node.removeEventListener('dragleave', onDragLeave);
      node.removeEventListener('drop', onDrop);
      node.removeEventListener('paste', onPaste);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    attachments,
    pickAttachment,
    addAttachment: addPending,
    removeAttachment,
    clearAttachments,
    dropZoneRefCallback,
    isDragOver,
  };
}
