import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

/**
 * True once the given element has come within `rootMargin` of the
 * viewport at least once — then stays true (a PDF page, once rendered,
 * is never torn back down on scroll-away, which would be wasteful and
 * would destroy any in-progress selection on that page). This is the
 * Reader's page-level virtualization (M3.1 §25/§32: no full-resolution
 * render of every page on mount for a large PDF) — a page far from the
 * viewport renders only a lightweight placeholder until it's about to be
 * scrolled into view.
 *
 * Web-only; always true elsewhere (native platforms don't render
 * PdfReader at all — see PdfReader's own Platform.OS gate).
 */
export function useNearViewport(
  ref: { current: HTMLElement | null },
  rootMargin = '1200px 0px'
): boolean {
  const [near, setNear] = useState(Platform.OS !== 'web');

  useEffect(() => {
    if (Platform.OS !== 'web' || near) return undefined;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin }
    );
    observer.observe(el);
    return () => observer.disconnect();
    // Only re-run if the element identity changes; `near` is intentionally
    // excluded (this effect returns undefined once near, above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref.current]);

  return near;
}
