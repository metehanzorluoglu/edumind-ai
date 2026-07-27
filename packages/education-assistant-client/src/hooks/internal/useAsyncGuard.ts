import { useCallback, useEffect, useRef } from 'react';

/**
 * Shared plumbing for hooks that run one cancellable async operation at a
 * time. Tracks mount state and a monotonic "generation" so a stale
 * response — superseded by a newer call, or arriving after unmount — can
 * never overwrite current state, while a genuinely current, in-flight
 * request can still be told apart from a cancelled one.
 *
 * Internal only: not part of the SDK's public surface (see src/index.ts).
 */
export function useAsyncGuard(): {
  begin: () => { signal: AbortSignal; isCurrent: () => boolean };
  cancel: () => void;
} {
  const generationRef = useRef(0);
  const isMountedRef = useRef(true);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      controllerRef.current?.abort();
    };
  }, []);

  const begin = useCallback((): { signal: AbortSignal; isCurrent: () => boolean } => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const generation = ++generationRef.current;
    return {
      signal: controller.signal,
      isCurrent: () => isMountedRef.current && generationRef.current === generation,
    };
  }, []);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  return { begin, cancel };
}
