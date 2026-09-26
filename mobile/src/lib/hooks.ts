import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { hydrateRecordings, listRecordings, subscribeRecordings, type Recording } from './recordings.ts';

export interface AsyncState<T> {
  data: T | undefined;
  error: Error | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Load on focus, optionally poll while focused. Small on purpose: the app
 * makes a handful of calls and does not need a query cache.
 *
 * `key` names what is being loaded (e.g. server + run id); a new key
 * reloads. `load` and `pollMs` may be inline closures.
 */
export function useFocusedQuery<T>(
  load: () => Promise<T>,
  key: string,
  pollMs?: (data: T | undefined) => number | null,
): AsyncState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  const pollRef = useRef(pollMs);
  useEffect(() => {
    loadRef.current = load;
    pollRef.current = pollMs;
  });

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let latest: T | undefined;
      const run = async () => {
        if (!alive) return;
        setLoading(true);
        try {
          latest = await loadRef.current();
          if (!alive) return;
          setData(latest);
          setError(null);
        } catch (err) {
          if (!alive) return;
          setError(err instanceof Error ? err : new Error(String(err)));
        } finally {
          if (alive) setLoading(false);
        }
        const next = pollRef.current?.(latest);
        if (alive && next != null) timer = setTimeout(() => void run(), next);
      };
      void run();
      return () => {
        alive = false;
        if (timer) clearTimeout(timer);
      };
      // key and tick are the triggers, not inputs: load/poll are read via refs.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, tick]),
  );

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

export function useRecordings(): Recording[] {
  useEffect(() => {
    void hydrateRecordings();
  }, []);
  return useSyncExternalStore(subscribeRecordings, listRecordings);
}
