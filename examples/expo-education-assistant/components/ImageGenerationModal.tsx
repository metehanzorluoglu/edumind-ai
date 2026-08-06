import { RequestCancelledError } from 'education-assistant-client';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { AttachmentChip } from '@/components/AttachmentChip';
import { useClient } from '@/lib/ClientProvider';
import { DARK_PALETTE, useTheme, type Theme } from '@/lib/Preferences';
import {
  isReferenceMimeType,
  MAX_REFERENCE_IMAGES,
  readPickerAssetAsDataUrl,
  resolveRemoteReference,
  validateReferenceCandidate,
  type ReferenceImageMimeType,
  type ReferenceImageRef,
} from '@/lib/referenceImages';

// Always-dark, matching every other overlay dialog in the app (see
// AttachmentLightbox/AddToProjectPicker's docs on this convention).
const dark = DARK_PALETTE;

export interface AspectRatioOption {
  key: string;
  label: string;
  width: number;
  height: number;
}

/** Kept modest (largest side 768px) — good enough for chat-inline display and well under the backend's IMAGE_GENERATION_MAX_IMAGES-bounded request cost; a user who needs a specific exact size isn't this dialog's target. */
export const ASPECT_RATIO_OPTIONS: AspectRatioOption[] = [
  { key: 'square', label: 'Square (1:1)', width: 512, height: 512 },
  { key: 'portrait', label: 'Portrait (3:4)', width: 576, height: 768 },
  { key: 'landscape', label: 'Landscape (4:3)', width: 768, height: 576 },
  { key: 'widescreen', label: 'Widescreen (16:9)', width: 768, height: 432 },
];

export const MAX_NUM_IMAGES = 4;

let nextReferenceId = 0;
function makeReferenceId(): string {
  nextReferenceId += 1;
  return `reference-${nextReferenceId}`;
}

/** One reference image as handed to onGenerate (the chat screens map these to
 * the wire `reference_images`). Only fully-encoded, valid references are
 * included — the modal filters out anything still loading or errored. */
export interface ImageGenerationReferenceInput {
  dataUrl: string;
  mimeType: ReferenceImageMimeType;
}

/** A reference image as supplied to the modal via `initialValues` (Regenerate).
 * Normally carries a `remote` pointer the modal fetches + re-encodes so it can
 * both preview and resend it; an inline `dataUrl` is also accepted. */
export interface ImageGenerationInitialReference {
  name: string;
  mimeType: ReferenceImageMimeType;
  dataUrl?: string;
  previewUri?: string;
  remote?: { conversationId: string; messageId: string; attachmentId: string };
}

export interface ImageGenerationRequestParams {
  prompt: string;
  negativePrompt: string | null;
  width: number;
  height: number;
  numImages: number;
  referenceImages: ImageGenerationReferenceInput[];
}

/** The `initialValues` form shape — same as the submit params but with the
 * richer reference type (Regenerate passes remote pointers the modal resolves). */
export type ImageGenerationFormInitialValues = Partial<
  Omit<ImageGenerationRequestParams, 'referenceImages'>
> & { referenceImages?: ImageGenerationInitialReference[] };

/** Passed to `onGenerate` — lets the caller (which owns the actual network
 * call, see chat/[id].tsx's/new.tsx's handleGenerateImages) report real,
 * per-image progress back into this dialog, and lets this dialog's Cancel
 * button abort the caller's in-flight request. */
export interface ImageGenerationContext {
  signal: AbortSignal;
  onProgress: (completed: number, total: number) => void;
}

export interface ImageGenerationModalProps {
  visible: boolean;
  onClose: () => void;
  /** Performs the actual streaming POST /images/generate call (and, on success, reloading/navigating) — thrown errors are caught and shown inline; a RequestCancelledError (the user's own Cancel button) is handled silently instead. The modal only closes itself once this resolves without throwing. */
  onGenerate: (
    params: ImageGenerationRequestParams,
    context: ImageGenerationContext
  ) => Promise<void>;
  /** Prefills the form — used by GeneratedImageGallery's "Regenerate" to reopen with the same prompt/negative prompt/aspect ratio/reference images already filled in, so the user can tweak (or just resubmit for a new seed) rather than retyping everything. */
  initialValues?: ImageGenerationFormInitialValues;
}

interface GenerationProgress {
  completed: number;
  total: number;
}

function findAspectRatio(width?: number, height?: number): AspectRatioOption {
  return (
    ASPECT_RATIO_OPTIONS.find((o) => o.width === width && o.height === height) ??
    ASPECT_RATIO_OPTIONS[0]!
  );
}

/**
 * Ollama gives no real completion percentage for a single image in
 * progress — this animates a short segment sliding continuously
 * left-to-right across the track (a standard "still working, no known
 * duration" indicator) rather than faking a fraction like "1/4" for one
 * image (see this dialog's own "no fake progress" requirement).
 *
 * The loop MUST run on the JS driver (`useNativeDriver: false`) — this is
 * the fix for "the bar moves once, then freezes at the end" on Expo Web:
 * react-native-web has no native driver, and its `Animated.loop` treats
 * `useNativeDriver: true` as the "native loop" path (`_startNativeLoop`),
 * which runs the animation exactly once and never restarts it — the
 * recursive JS `restart()` loop is only taken for non-native-driver
 * animations (see node_modules/react-native-web/dist/vendor/react-native/
 * Animated/AnimatedImplementation.js's `loop`). The JS driver loops
 * correctly on web and native alike; for a 6px bar it is indistinguishable
 * from the native driver in smoothness. `isInteraction: false` too — a
 * looping animation must never hold an InteractionManager handle (RN docs:
 * it blocks UI updates, e.g. stalling VirtualizedList rendering — this
 * dialog's host screen sits next to the sidebar's FlatList).
 *
 * Memoized, with the interpolation node hoisted to a stable ref, so the
 * modal's per-second elapsed-time re-renders can't rebuild the animated
 * node graph (or restart the view attachment) mid-cycle.
 */
const IndeterminateProgressBar = memo(function IndeterminateProgressBar() {
  const position = useRef(new Animated.Value(0)).current;
  const translateX = useMemo(
    () => position.interpolate({ inputRange: [0, 1], outputRange: [-90, 300] }),
    [position]
  );

  useEffect(() => {
    const animation = Animated.loop(
      Animated.timing(position, {
        toValue: 1,
        duration: 1100,
        easing: Easing.inOut(Easing.ease),
        isInteraction: false,
        useNativeDriver: false,
      })
    );
    animation.start();
    return () => animation.stop();
  }, [position]);

  return (
    <View style={indeterminateBarStyles.progressTrack}>
      <Animated.View
        style={[
          indeterminateBarStyles.progressIndeterminateSegment,
          { transform: [{ translateX }] },
        ]}
      />
    </View>
  );
});

// Isolated from buildStyles(theme) below on purpose: this is a memoized,
// module-scope component (see its own docs on why re-renders must never
// rebuild its animated node graph) — it can't reach into
// ImageGenerationModal's per-instance, theme-derived `styles`. Colors
// still come from the shared always-dark palette; there's no text/font
// here to theme.
const indeterminateBarStyles = StyleSheet.create({
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: dark.border,
    overflow: 'hidden',
  },
  progressIndeterminateSegment: {
    position: 'absolute',
    width: 90,
    height: '100%',
    borderRadius: 3,
    backgroundColor: dark.accent,
  },
});

/**
 * "Image" composer action's dialog — prompt, optional negative prompt, an
 * aspect-ratio chip picker (mapped to width/height on submit; the backend
 * itself only knows width/height, see rag-backend's
 * app/schemas/images.py), a number-of-images stepper, and — while
 * generating — real progress: "Generating image N of total" plus a
 * determinate bar for a multi-image batch (rag-backend streams one
 * `progress` SSE event per *completed* image — see
 * app/api/routes_images.py's stream_generate_images), or an indeterminate
 * bar plus an elapsed-seconds counter for a single image, since Ollama
 * gives no way to know how far through one generation actually is.
 *
 * Deliberately a plain react-native Modal (matches AttachmentLightbox.tsx's
 * convention for a full overlay dialog), not the Portal-based context-menu
 * system built for the sidebar's three-dot menus — that system solves a
 * FlatList-row stacking-context problem this dialog doesn't have.
 */
export function ImageGenerationModal({
  visible,
  onClose,
  onGenerate,
  initialValues,
}: ImageGenerationModalProps) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const [prompt, setPrompt] = useState(initialValues?.prompt ?? '');
  const [negativePrompt, setNegativePrompt] = useState(initialValues?.negativePrompt ?? '');
  const [aspectRatioKey, setAspectRatioKey] = useState(
    findAspectRatio(initialValues?.width, initialValues?.height).key
  );
  const [numImages, setNumImages] = useState(initialValues?.numImages ?? 1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<GenerationProgress | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  // Synchronous re-entrancy guard — `busy` state alone can't stop a second
  // onPress fired before React has re-rendered with the Generate button's
  // disabled=true (a fast double-click, or two calls issued back to back
  // in the same tick) — same reasoning as useConversationMessages'
  // isSendingRef / chat/new.tsx's isSubmittingRef.
  const isGeneratingRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  // Reference images (object/character-style inputs sent alongside the prompt).
  // Initialized from initialValues so Regenerate can prefill them; a refilled
  // reference carries a `remote` pointer the effect below resolves.
  const [referenceImages, setReferenceImages] = useState<ReferenceImageRef[]>(() =>
    (initialValues?.referenceImages ?? []).map((init) => ({
      id: makeReferenceId(),
      name: init.name,
      mimeType: init.mimeType,
      previewUri: init.previewUri ?? null,
      dataUrl: init.dataUrl ?? null,
      remote: init.remote,
      loading: !!init.remote && !init.dataUrl,
      error: null,
    }))
  );
  // Object URLs we mint when resolving a Regenerate reference on web — revoked
  // on remove/unmount so blob URLs don't leak.
  const createdObjectUrlsRef = useRef<Set<string>>(new Set());
  const { client } = useClient();

  const aspectRatio =
    ASPECT_RATIO_OPTIONS.find((o) => o.key === aspectRatioKey) ?? ASPECT_RATIO_OPTIONS[0]!;

  useEffect(() => {
    if (!busy) return undefined;
    setElapsedSeconds(0);
    const startedAt = Date.now();
    const interval = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [busy]);

  // Aborts any in-flight generation if this dialog unmounts out from under
  // it (e.g. the screen navigates away) — never leaves a dangling request
  // running with no UI left to reflect it.
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  // Closing the dialog while generating (Android back button →
  // onRequestClose, or the parent setting visible=false for any reason)
  // behaves exactly like pressing the Cancel button: abort the in-flight
  // request. The resulting RequestCancelledError is swallowed silently by
  // handleGenerate's catch, and its finally block then stops the timer and
  // unmounts the progress bar (which stops the indeterminate animation) —
  // so a closed dialog can never leave a request, timer, or animation
  // running invisibly behind it.
  useEffect(() => {
    if (!visible) {
      abortControllerRef.current?.abort();
    }
  }, [visible]);

  // Resolve any Regenerate-prefilled references (a `remote` pointer with no
  // inline dataUrl) into a thumbnail + sendable data URL when the dialog opens.
  // The modal is remounted per open (key), so the initialValues-derived state is
  // fresh each time and this runs once per open.
  useEffect(() => {
    if (!visible) return undefined;
    // Snapshot the Set object (never reassigned, only mutated) so the cleanup
    // closes over a stable reference rather than re-reading the ref later.
    const objectUrls = createdObjectUrlsRef.current;
    referenceImages.forEach((ref) => {
      // Skip refs that are already resolved or failed, and non-remote (freshly
      // picked) refs — those are encoded by handleAddReference, not here. A
      // remote ref starts with loading=true (set in the state initializer so
      // the spinner shows + Generate is blocked immediately), so loading is
      // intentionally NOT a skip condition here.
      if (!ref.remote || ref.dataUrl || ref.error) return;
      setReferenceImages((prev) =>
        prev.map((r) => (r.id === ref.id ? { ...r, loading: true } : r))
      );
      resolveRemoteReference(client, ref.remote, ref.mimeType, ref.name)
        .then(({ previewUri, dataUrl }) => {
          if (previewUri.startsWith('blob:')) objectUrls.add(previewUri);
          setReferenceImages((prev) =>
            prev.map((r) => (r.id === ref.id ? { ...r, previewUri, dataUrl, loading: false } : r))
          );
        })
        .catch(() => {
          setReferenceImages((prev) =>
            prev.map((r) =>
              r.id === ref.id
                ? { ...r, loading: false, error: 'Could not load this reference image.' }
                : r
            )
          );
        });
    });
    return () => {
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
      objectUrls.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const referencesLoading = referenceImages.some((r) => r.loading);
  const referencesInvalid = referenceImages.some((r) => r.error !== null);
  const generateDisabled = busy || !prompt.trim() || referencesLoading || referencesInvalid;

  async function handleGenerate(): Promise<void> {
    const trimmed = prompt.trim();
    if (!trimmed || isGeneratingRef.current || referencesLoading || referencesInvalid) return;
    isGeneratingRef.current = true;
    setBusy(true);
    setError(null);
    setProgress({ completed: 0, total: numImages });
    const controller = new AbortController();
    abortControllerRef.current = controller;
    try {
      await onGenerate(
        {
          prompt: trimmed,
          negativePrompt: negativePrompt.trim() || null,
          width: aspectRatio.width,
          height: aspectRatio.height,
          numImages,
          referenceImages: referenceImages
            .filter((r) => r.dataUrl !== null && r.error === null)
            .map((r) => ({ dataUrl: r.dataUrl as string, mimeType: r.mimeType })),
        },
        {
          signal: controller.signal,
          onProgress: (completed, total) => setProgress({ completed, total }),
        }
      );
      onClose();
    } catch (err) {
      // A user-initiated Cancel already reflects itself in the UI the
      // moment the button is pressed (see handleCancelGeneration) — no
      // separate error banner for the same action the user just took.
      if (!(err instanceof RequestCancelledError)) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      isGeneratingRef.current = false;
      abortControllerRef.current = null;
      setBusy(false);
      setProgress(null);
    }
  }

  function handleCancelGeneration(): void {
    abortControllerRef.current?.abort();
  }

  async function handleAddReference(): Promise<void> {
    if (busy) return;
    const slots = MAX_REFERENCE_IMAGES - referenceImages.length;
    if (slots <= 0) return;
    setError(null);
    let result: ImagePicker.ImagePickerResult;
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        setError('Photo library access is required to add reference images.');
        return;
      }
      result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        selectionLimit: slots,
        quality: 0.9,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the image picker.');
      return;
    }
    if (result.canceled) return;

    // Validate synchronously so a bad pick shows its error immediately (and
    // blocks Generate) rather than after an async read; valid picks start
    // encoding to a data URL in the background (loading state).
    const staged = result.assets.slice(0, slots).map((asset) => {
      const mimeType = (asset.mimeType ?? '').toLowerCase();
      const validation = validateReferenceCandidate(
        asset.fileName ?? 'reference image',
        asset.fileSize ?? null,
        asset.mimeType ?? null
      );
      const ref: ReferenceImageRef = {
        id: makeReferenceId(),
        name: asset.fileName ?? 'reference image',
        mimeType: isReferenceMimeType(mimeType)
          ? mimeType
          : (asset.mimeType as ReferenceImageMimeType),
        previewUri: asset.uri,
        dataUrl: null,
        loading: validation === null,
        error: validation,
      };
      return { ref, asset };
    });
    setReferenceImages((prev) => [...prev, ...staged.map((s) => s.ref)]);
    for (const { ref, asset } of staged) {
      if (ref.error) continue;
      readPickerAssetAsDataUrl(
        { uri: asset.uri, file: asset.file ?? null, mimeType: ref.mimeType },
        ref.mimeType
      )
        .then((dataUrl) =>
          setReferenceImages((prev) =>
            prev.map((r) => (r.id === ref.id ? { ...r, dataUrl, loading: false } : r))
          )
        )
        .catch(() =>
          setReferenceImages((prev) =>
            prev.map((r) =>
              r.id === ref.id ? { ...r, loading: false, error: 'Could not read this image.' } : r
            )
          )
        );
    }
  }

  function removeReference(id: string): void {
    setReferenceImages((prev) => {
      const target = prev.find((r) => r.id === id);
      if (target?.previewUri && createdObjectUrlsRef.current.has(target.previewUri)) {
        URL.revokeObjectURL(target.previewUri);
        createdObjectUrlsRef.current.delete(target.previewUri);
      }
      return prev.filter((r) => r.id !== id);
    });
  }

  const currentImageNumber = progress ? Math.min(progress.completed + 1, progress.total) : 1;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable
          style={styles.backdrop}
          onPress={busy ? undefined : onClose}
          accessibilityRole="button"
          accessibilityLabel="Close image generation dialog"
        />
        <View style={styles.panel}>
          <ScrollView keyboardShouldPersistTaps="handled">
            <Text style={styles.title}>Generate an image</Text>

            <Text style={styles.label}>Prompt</Text>
            <TextInput
              style={styles.textArea}
              value={prompt}
              onChangeText={setPrompt}
              placeholder="Describe the image you want…"
              placeholderTextColor={dark.faint}
              multiline
              editable={!busy}
              accessibilityLabel="Image prompt"
            />

            <Text style={styles.label}>Negative prompt (optional)</Text>
            <TextInput
              style={styles.textArea}
              value={negativePrompt}
              onChangeText={setNegativePrompt}
              placeholder="Things to avoid…"
              placeholderTextColor={dark.faint}
              multiline
              editable={!busy}
              accessibilityLabel="Negative prompt"
            />

            <Text style={styles.label}>Reference images (optional)</Text>
            <Text style={styles.referenceHint}>
              Add photos the model should reference — an object to include, or a character/style to
              follow. Visible use depends on the configured model.
            </Text>
            {referenceImages.length > 0 && (
              <View style={styles.referenceList}>
                {referenceImages.map((ref) => (
                  <View key={ref.id} style={styles.referenceItem}>
                    <AttachmentChip
                      info={{
                        key: ref.id,
                        filename: ref.name,
                        mimeType: ref.mimeType,
                        sizeBytes: null,
                        pageCount: null,
                        pageRangeStart: null,
                        pageRangeEnd: null,
                        remote: null,
                      }}
                      thumbnailUri={ref.previewUri}
                      error={ref.error}
                      onRemove={busy ? undefined : () => removeReference(ref.id)}
                    />
                    {ref.loading && (
                      <View style={styles.referenceLoading} pointerEvents="none">
                        <ActivityIndicator size="small" color={dark.accent} />
                      </View>
                    )}
                  </View>
                ))}
              </View>
            )}
            {referenceImages.length < MAX_REFERENCE_IMAGES && (
              <Pressable
                style={[styles.addReferenceButton, busy && styles.generateButtonDisabled]}
                onPress={handleAddReference}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="Add reference image"
              >
                <Text style={styles.addReferenceText}>+ Add reference image</Text>
              </Pressable>
            )}

            <Text style={styles.label}>Aspect ratio</Text>
            <View style={styles.chipRow}>
              {ASPECT_RATIO_OPTIONS.map((option) => (
                <Pressable
                  key={option.key}
                  style={[styles.chip, aspectRatioKey === option.key && styles.chipSelected]}
                  onPress={() => setAspectRatioKey(option.key)}
                  disabled={busy}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: aspectRatioKey === option.key }}
                  accessibilityLabel={option.label}
                >
                  <Text
                    style={[
                      styles.chipText,
                      aspectRatioKey === option.key && styles.chipTextSelected,
                    ]}
                  >
                    {option.label}
                  </Text>
                </Pressable>
              ))}
            </View>

            <Text style={styles.label}>Number of images</Text>
            <View style={styles.stepperRow}>
              <Pressable
                style={styles.stepperButton}
                onPress={() => setNumImages((n) => Math.max(1, n - 1))}
                disabled={busy || numImages <= 1}
                accessibilityRole="button"
                accessibilityLabel="Fewer images"
              >
                <Text style={styles.stepperButtonText}>−</Text>
              </Pressable>
              <Text style={styles.stepperValue}>{numImages}</Text>
              <Pressable
                style={styles.stepperButton}
                onPress={() => setNumImages((n) => Math.min(MAX_NUM_IMAGES, n + 1))}
                disabled={busy || numImages >= MAX_NUM_IMAGES}
                accessibilityRole="button"
                accessibilityLabel="More images"
              >
                <Text style={styles.stepperButtonText}>+</Text>
              </Pressable>
            </View>

            {busy && (
              <View style={styles.progressSection}>
                {progress && progress.total > 1 ? (
                  <>
                    <Text style={styles.progressLabel}>
                      {`Generating image ${currentImageNumber} of ${progress.total}`}
                    </Text>
                    <View style={styles.progressTrack}>
                      <View
                        style={[
                          styles.progressFill,
                          { width: `${(progress.completed / progress.total) * 100}%` },
                        ]}
                      />
                    </View>
                  </>
                ) : (
                  <>
                    <Text
                      style={styles.progressLabel}
                    >{`Generating image… ${elapsedSeconds}s`}</Text>
                    <IndeterminateProgressBar />
                  </>
                )}
              </View>
            )}

            {error && (
              <View style={styles.errorBox} accessibilityRole="alert">
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}

            <View style={styles.actionsRow}>
              <Pressable
                onPress={busy ? handleCancelGeneration : onClose}
                accessibilityRole="button"
                accessibilityLabel={busy ? 'Cancel image generation' : 'Cancel'}
              >
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.generateButton, generateDisabled && styles.generateButtonDisabled]}
                onPress={handleGenerate}
                disabled={generateDisabled}
                accessibilityRole="button"
                accessibilityLabel="Generate"
              >
                {busy ? (
                  <ActivityIndicator color={dark.accentContrast} size="small" />
                ) : (
                  <Text style={styles.generateButtonText}>Generate</Text>
                )}
              </Pressable>
            </View>
          </ScrollView>
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
      zIndex: 30,
      elevation: 30,
    },
    backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(20, 22, 31, 0.6)' },
    panel: {
      width: 360,
      maxHeight: '85%',
      backgroundColor: dark.card,
      borderRadius: theme.radius.lg,
      padding: 16,
    },
    title: { color: dark.text, fontSize: 16, marginBottom: 12, fontFamily: theme.fonts.display },
    label: {
      color: dark.faint,
      fontSize: 12,
      marginBottom: 6,
      marginTop: 12,
      fontFamily: theme.fonts.bodySemibold,
    },
    textArea: {
      color: dark.text,
      fontSize: 14,
      minHeight: 60,
      backgroundColor: dark.background,
      borderRadius: theme.radius.md,
      paddingHorizontal: 12,
      paddingVertical: 10,
      textAlignVertical: 'top',
      fontFamily: theme.fonts.body,
    },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    chip: {
      borderWidth: StyleSheet.hairlineWidth * 2,
      borderColor: dark.border,
      borderRadius: theme.radius.pill,
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    chipSelected: { backgroundColor: dark.accent, borderColor: dark.accent },
    chipText: { color: dark.subtext, fontSize: 12, fontFamily: theme.fonts.body },
    chipTextSelected: { color: dark.accentContrast, fontFamily: theme.fonts.bodySemibold },
    stepperRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
    stepperButton: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: dark.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    stepperButtonText: { color: dark.text, fontSize: 18, fontFamily: theme.fonts.bodyBold },
    stepperValue: {
      color: dark.text,
      fontSize: 14,
      minWidth: 20,
      textAlign: 'center',
      fontFamily: theme.fonts.bodySemibold,
    },
    progressSection: { marginTop: 16, gap: 8 },
    progressLabel: {
      color: dark.subtext,
      fontSize: 13,
      textAlign: 'center',
      fontFamily: theme.fonts.body,
    },
    progressTrack: {
      height: 6,
      borderRadius: 3,
      backgroundColor: dark.border,
      overflow: 'hidden',
    },
    progressFill: { height: '100%', backgroundColor: dark.accent, borderRadius: 3 },
    progressIndeterminateSegment: {
      position: 'absolute',
      width: 90,
      height: '100%',
      borderRadius: 3,
      backgroundColor: dark.accent,
    },
    errorBox: {
      backgroundColor: dark.dangerSoft,
      borderRadius: theme.radius.md,
      padding: 10,
      marginTop: 12,
    },
    errorText: { color: dark.danger, fontSize: 12, fontFamily: theme.fonts.body },
    actionsRow: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      alignItems: 'center',
      gap: 16,
      marginTop: 16,
    },
    cancelText: {
      color: dark.faint,
      fontSize: 13,
      paddingVertical: 8,
      paddingHorizontal: 4,
      fontFamily: theme.fonts.body,
    },
    generateButton: {
      backgroundColor: dark.accent,
      borderRadius: theme.radius.md,
      paddingVertical: 10,
      paddingHorizontal: 16,
      minWidth: 100,
      alignItems: 'center',
    },
    generateButtonDisabled: { opacity: 0.5 },
    generateButtonText: {
      color: dark.accentContrast,
      fontFamily: theme.fonts.bodySemibold,
      fontSize: 13,
    },
    referenceHint: {
      color: dark.faint,
      fontSize: 11,
      lineHeight: 15,
      fontFamily: theme.fonts.body,
    },
    referenceList: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
    referenceItem: { position: 'relative' },
    referenceLoading: {
      ...StyleSheet.absoluteFillObject,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(255, 255, 255, 0.7)',
      borderRadius: theme.radius.md,
    },
    addReferenceButton: {
      alignSelf: 'flex-start',
      borderWidth: StyleSheet.hairlineWidth * 2,
      borderColor: dark.border,
      borderRadius: theme.radius.md,
      paddingHorizontal: 12,
      paddingVertical: 8,
      marginTop: 8,
    },
    addReferenceText: { color: dark.subtext, fontSize: 12, fontFamily: theme.fonts.bodySemibold },
  });
}
