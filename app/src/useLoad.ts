/**
 * Fetch-on-focus, with pull-to-refresh. A hundred lines instead of a data-fetching library.
 *
 * Two behaviours it has to get right, both of which are why this exists rather than a bare
 * `useEffect`:
 *
 * **Refetch when the screen is focused.** Every value this app shows is derived — the 5/24 count, the
 * reminders, the plan — so adding a card on one tab changes the numbers on all the others. A cache
 * that survives navigation would show a stale 5/24 count immediately after the action that changed
 * it, which is the one moment the user is looking for the change.
 *
 * **Never write state after unmount, and never let a slow response overwrite a fast one.** A
 * generation counter rather than an AbortController: the request is cheap and finishing it is
 * harmless, what matters is that only the newest one is allowed to land.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { ApiError } from './api.ts';

export interface Loaded<T> {
  data: T | null;
  /** The first load only. A refresh keeps the previous data on screen. */
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  reload: () => void;
  refresh: () => void;
}

export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[] = []): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generation = useRef(0);
  const mounted = useRef(true);
  // Held in a ref so the callback identity does not change every render, which would otherwise make
  // `useFocusEffect` re-run on each one.
  const loader = useRef(load);
  loader.current = load;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async (mode: 'initial' | 'refresh') => {
    const mine = ++generation.current;
    if (mode === 'refresh') setRefreshing(true);
    else setLoading(true);

    try {
      const next = await loader.current();
      if (!mounted.current || mine !== generation.current) return;
      setData(next);
      setError(null);
    } catch (problem) {
      if (!mounted.current || mine !== generation.current) return;
      setError(problem instanceof ApiError ? problem.message : 'Could not load this. Pull down to try again.');
    } finally {
      if (mounted.current && mine === generation.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  // Refocus is a refresh rather than a load, so returning to a tab does not blank it.
  useFocusEffect(
    useCallback(() => {
      void run(data === null ? 'initial' : 'refresh');
      // `data` is deliberately not a dependency: including it would refetch on every successful
      // load, forever.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps),
  );

  return {
    data,
    loading: loading && data === null,
    refreshing,
    error,
    reload: () => void run('initial'),
    refresh: () => void run('refresh'),
  };
}
