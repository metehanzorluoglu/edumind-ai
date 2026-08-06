import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ListRenderItemInfo,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import {
  AuthenticatedAttachmentImage,
  type AttachmentImageLoadStatus,
} from '@/components/AuthenticatedAttachmentImage';
import type { AttachmentChipInfo } from '@/lib/chatAttachments';

export interface AttachmentLightboxProps {
  visible: boolean;
  /** Every attachment in the same turn (milestone V4 "multiple image support") — lets the user swipe between them without closing and reopening. Only ever attachments with a `.remote` origin (see AttachmentChip's docs): a not-yet-sent attachment has no server-rendered preview to fetch yet. */
  attachments: AttachmentChipInfo[];
  initialIndex: number;
  onClose: () => void;
}

const DOUBLE_TAP_WINDOW_MS = 300;
const ZOOM_SCALE = 2.5;

/**
 * One page of the lightbox: the full-size image (or, for a PDF, the
 * current page rendered as an image via GET .../attachments/{id}/preview —
 * milestone V4), double-tap-to-zoom, and — for a multi-page PDF —
 * Prev/Next page controls.
 *
 * Zoom is deliberately a discrete double-tap toggle between 1x and
 * `ZOOM_SCALE`, not a continuous pinch gesture: a real pinch gesture needs
 * react-native-gesture-handler's GestureDetector mounted under a
 * GestureHandlerRootView at the app root, which nothing in this app sets
 * up today, and adding that this late without a real device/simulator to
 * verify it on would be exactly the kind of "looks right in code, unverified
 * in practice" change this project avoids — see this package's README,
 * "Known limitations".
 */
function LightboxPage({ info }: { info: AttachmentChipInfo }) {
  const isPdf = info.mimeType === 'application/pdf';
  const [page, setPage] = useState(1);
  const [loadStatus, setLoadStatus] = useState<AttachmentImageLoadStatus>('loading');
  // Bumping this key remounts AuthenticatedAttachmentImage, re-running its
  // fetch — the "Tap to retry" path after a load failure.
  const [loadAttempt, setLoadAttempt] = useState(0);
  const scale = useRef(new Animated.Value(1)).current;
  const zoomedRef = useRef(false);
  const lastTapAtRef = useRef(0);

  function handleDoubleTapCheck(): void {
    const now = Date.now();
    if (now - lastTapAtRef.current < DOUBLE_TAP_WINDOW_MS) {
      const zoomingIn = !zoomedRef.current;
      zoomedRef.current = zoomingIn;
      Animated.timing(scale, {
        toValue: zoomingIn ? ZOOM_SCALE : 1,
        duration: 150,
        useNativeDriver: true,
      }).start();
      lastTapAtRef.current = 0; // consumed — a third quick tap starts a fresh pair, not a triple-toggle
    } else {
      lastTapAtRef.current = now;
    }
  }

  function handleRetry(): void {
    setLoadAttempt((a) => a + 1);
  }

  const pageCount = info.pageCount;

  return (
    <View style={styles.page}>
      <Pressable
        onPress={handleDoubleTapCheck}
        style={styles.imageWrap}
        accessibilityHint="Double-tap to zoom"
      >
        {/* The zoom wrapper must fill the page: the Image inside sizes
            itself with width/height '100%', which resolves against THIS
            view — an unsized wrapper collapsed it to 0×0 and the image
            never became visible (the "dark overlay, no image" bug).
            resizeMode="contain" then centers it, preserves its aspect
            ratio, and keeps it inside the viewport. */}
        <Animated.View style={[styles.imageBox, { transform: [{ scale }] }]}>
          {info.remote ? (
            <AuthenticatedAttachmentImage
              key={loadAttempt}
              conversationId={info.remote.conversationId}
              messageId={info.remote.messageId}
              attachmentId={info.key}
              page={isPdf ? page : undefined}
              style={styles.image}
              resizeMode="contain"
              onStatusChange={setLoadStatus}
            />
          ) : (
            <Text style={styles.hint}>Preview is available once this message is sent.</Text>
          )}
        </Animated.View>
      </Pressable>

      {info.remote && loadStatus === 'loading' && (
        <View style={styles.statusOverlay} pointerEvents="none">
          <ActivityIndicator size="large" color="#E2E8F0" />
        </View>
      )}

      {info.remote && loadStatus === 'error' && (
        <Pressable
          style={styles.statusOverlay}
          onPress={handleRetry}
          accessibilityRole="button"
          accessibilityLabel="Retry loading image"
        >
          <Text style={styles.statusTitle}>Couldn&apos;t load this image.</Text>
          <Text style={styles.statusHint}>Tap to retry.</Text>
        </Pressable>
      )}

      {isPdf && pageCount !== null && pageCount > 1 && (
        <View style={styles.pageNav}>
          <Pressable
            disabled={page <= 1}
            onPress={() => setPage((p) => Math.max(1, p - 1))}
            style={[styles.pageNavButton, page <= 1 && styles.pageNavButtonDisabled]}
            accessibilityLabel="Previous page"
          >
            <Text style={styles.pageNavText}>‹ Prev</Text>
          </Pressable>
          <Text style={styles.pageIndicator}>
            Page {page} of {pageCount}
          </Text>
          <Pressable
            disabled={page >= pageCount}
            onPress={() => setPage((p) => Math.min(pageCount, p + 1))}
            style={[styles.pageNavButton, page >= pageCount && styles.pageNavButtonDisabled]}
            accessibilityLabel="Next page"
          >
            <Text style={styles.pageNavText}>Next ›</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

/**
 * Full-screen image/PDF-page viewer (milestone V4) opened by tapping an
 * already-sent attachment's chip in ConversationTurnCard. Horizontal paging
 * lets the user swipe between every attachment in the same turn.
 */
export function AttachmentLightbox({
  visible,
  attachments,
  initialIndex,
  onClose,
}: AttachmentLightboxProps) {
  const [index, setIndex] = useState(initialIndex);
  const listRef = useRef<FlatList<AttachmentChipInfo>>(null);
  const { width } = Dimensions.get('window');
  // The page wrapper needs an explicit height: on web, every level of the
  // horizontal list between this FlatList and the page resolves an
  // "auto/100%" height against its children while those children size by
  // percentage — a circular dependency that collapses the page to 0px
  // (native RN's Yoga layout stretches cells instead, which is why this
  // was web-only). onLayout reports the list's real height (viewport minus
  // the top bar); until the first layout, the window height is a close
  // stand-in (corrected one frame later).
  const [pageHeight, setPageHeight] = useState<number>(() => Dimensions.get('window').height);

  useEffect(() => {
    if (visible) setIndex(initialIndex);
  }, [visible, initialIndex]);

  function renderItem({ item }: ListRenderItemInfo<AttachmentChipInfo>) {
    return (
      <View style={{ width, height: pageHeight }}>
        <LightboxPage info={item} />
      </View>
    );
  }

  function handleMomentumScrollEnd(event: NativeSyntheticEvent<NativeScrollEvent>): void {
    const newIndex = Math.round(event.nativeEvent.contentOffset.x / width);
    setIndex(newIndex);
  }

  const current = attachments[index];

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.topBar}>
          <Text style={styles.filename} numberOfLines={1}>
            {current?.filename ?? ''}
          </Text>
          {attachments.length > 1 && (
            <Text style={styles.counter}>
              {index + 1} / {attachments.length}
            </Text>
          )}
          <Pressable
            style={styles.closeButton}
            onPress={onClose}
            accessibilityLabel="Close preview"
          >
            <Text style={styles.closeButtonText}>✕</Text>
          </Pressable>
        </View>

        <FlatList
          ref={listRef}
          data={attachments}
          horizontal
          pagingEnabled
          style={styles.pager}
          // height:'100%' on the content container — on web (react-native-web)
          // a horizontal scroll content container's auto height resolves to 0
          // (its height depends on its children, whose percentage/flex heights
          // depend on it — circular → 0), collapsing every page to 0px tall.
          // Native RN stretches items here anyway; the explicit height makes
          // both platforms identical. The renderItem wrapper's explicit
          // height (see pageHeight above) covers the remaining levels.
          contentContainerStyle={styles.pagerContent}
          onLayout={(event) => setPageHeight(event.nativeEvent.layout.height)}
          initialScrollIndex={initialIndex}
          getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
          keyExtractor={(item) => item.key}
          renderItem={renderItem}
          onMomentumScrollEnd={handleMomentumScrollEnd}
          showsHorizontalScrollIndicator={false}
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(15, 23, 42, 0.96)' },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: 48,
    paddingHorizontal: 16,
    paddingBottom: 12,
    gap: 12,
  },
  filename: { flex: 1, color: '#F6F7FA', fontSize: 14, fontWeight: '600' },
  counter: { color: '#94A3B8', fontSize: 12 },
  closeButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  closeButtonText: { color: '#F6F7FA', fontSize: 16, fontWeight: '700' },
  // flex:1 — without a bounded height the horizontal list collapses to 0px
  // under the top bar, and everything inside it (the page, the zoom
  // wrapper, the image) collapses with it (the dark-overlay-no-image bug).
  pager: { flex: 1 },
  pagerContent: { height: '100%' },
  page: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  imageWrap: { flex: 1, width: '100%', alignItems: 'center', justifyContent: 'center' },
  imageBox: { ...StyleSheet.absoluteFillObject },
  image: { width: '100%', height: '100%' },
  statusOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusTitle: { color: '#F6F7FA', fontSize: 14, fontWeight: '600' },
  statusHint: { color: '#94A3B8', fontSize: 12, marginTop: 4 },
  hint: { color: '#CBD5E1', fontSize: 13, textAlign: 'center', paddingHorizontal: 24 },
  pageNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    paddingVertical: 16,
  },
  pageNavButton: {
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  pageNavButtonDisabled: { opacity: 0.35 },
  pageNavText: { color: '#F6F7FA', fontSize: 13, fontWeight: '600' },
  pageIndicator: { color: '#E2E8F0', fontSize: 12 },
});
