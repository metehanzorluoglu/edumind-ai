import type { EducationAssistantClient } from 'education-assistant-client';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

const READINESS_POLL_MS = 30_000;

export interface ReadinessSnapshot {
  backend: boolean;
  ollama: boolean;
  qdrant: boolean;
}

/**
 * Polls GET /health/ready every 30s and immediately again whenever the app
 * returns to the foreground. A failed request (backend unreachable) reports
 * every dependency as down rather than leaving ollama/qdrant in a stale
 * "last known good" state. null means "no result yet".
 *
 * Shared by the consumer Settings page (which collapses this into a single
 * plain-language banner, shown only when something is wrong) and the
 * developer-only settings screen (which shows the per-service detail).
 */
export function useReadiness(client: EducationAssistantClient): ReadinessSnapshot | null {
  const [snapshot, setSnapshot] = useState<ReadinessSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function check(): Promise<void> {
      try {
        const result = await client.ready();
        if (cancelled) return;
        setSnapshot({
          backend: true,
          ollama: result.ollama_reachable,
          qdrant: result.qdrant_reachable,
        });
      } catch {
        if (cancelled) return;
        setSnapshot({ backend: false, ollama: false, qdrant: false });
      }
    }

    check();
    const interval = setInterval(check, READINESS_POLL_MS);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') check();
    });

    return () => {
      cancelled = true;
      clearInterval(interval);
      subscription.remove();
    };
  }, [client]);

  return snapshot;
}
