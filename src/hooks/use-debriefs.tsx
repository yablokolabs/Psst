/**
 * The debrief timeline.
 *
 * One provider owns the persisted list, so the Home screen, the debrief screen
 * and Settings all read the same data and any edit is written through to SQLite
 * immediately. Nothing is held only in React state: a memory app that forgets on
 * restart is not a memory app.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import {
  deleteAllDebriefs,
  deleteDebrief,
  deleteRecording,
  getDebrief,
  listDebriefs,
  saveDebrief,
  seedDebriefsIfEmpty,
} from '@/services/debriefDb';
import { matchesSearch } from '@/services/debriefRows';
import type { Debrief, DebriefEdits } from '@/types/debrief';

export interface DebriefsValue {
  /** Newest call first. */
  debriefs: Debrief[];
  loading: boolean;
  /** A storage problem, phrased for the user. */
  error: string | null;
  reload: () => Promise<void>;
  find: (id: string) => Debrief | undefined;
  add: (debrief: Debrief) => Promise<void>;
  /** Applies edits and returns the saved debrief. */
  update: (id: string, edits: DebriefEdits) => Promise<Debrief | null>;
  /** Deletes the debrief and its recording. */
  remove: (id: string) => Promise<void>;
  /** Deletes only the source audio, keeping the debrief. */
  forgetRecording: (id: string) => Promise<void>;
  clearAll: () => Promise<void>;
  /** Filters the loaded list, so search never has to wait on the database. */
  search: (term: string) => Debrief[];
}

const DebriefsContext = createContext<DebriefsValue | null>(null);

function describe(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'Psst could not open its storage on this device.';
}

export function DebriefsProvider({ children }: { children: ReactNode }) {
  const [debriefs, setDebriefs] = useState<Debrief[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const reload = useCallback(async () => {
    try {
      const stored = await listDebriefs();
      if (mounted.current) {
        setDebriefs(stored);
        setError(null);
      }
    } catch (loadError) {
      if (mounted.current) setError(describe(loadError));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void (async () => {
      try {
        // First run only: worked examples, so the timeline is never an empty
        // screen and search is demonstrable before any import.
        await seedDebriefsIfEmpty();
      } catch {
        // A seed failure must not stop the app from opening.
      }
      await reload();
    })();

    return () => {
      mounted.current = false;
    };
  }, [reload]);

  const add = useCallback(async (debrief: Debrief) => {
    await saveDebrief(debrief);
    setDebriefs((previous) => [debrief, ...previous.filter((item) => item.id !== debrief.id)]);
  }, []);

  const update = useCallback(async (id: string, edits: DebriefEdits) => {
    const existing = await getDebrief(id);
    if (!existing) return null;

    const next: Debrief = { ...existing, ...edits };
    await saveDebrief(next);
    setDebriefs((previous) => previous.map((item) => (item.id === id ? next : item)));
    return next;
  }, []);

  const remove = useCallback(async (id: string) => {
    const existing = await getDebrief(id);
    if (existing?.audio) deleteRecording(existing.audio.uri);
    await deleteDebrief(id);
    setDebriefs((previous) => previous.filter((item) => item.id !== id));
  }, []);

  const forgetRecording = useCallback(async (id: string) => {
    const existing = await getDebrief(id);
    if (!existing?.audio) return;
    deleteRecording(existing.audio.uri);
    const next: Debrief = { ...existing, audio: null };
    await saveDebrief(next);
    setDebriefs((previous) => previous.map((item) => (item.id === id ? next : item)));
  }, []);

  const clearAll = useCallback(async () => {
    for (const debrief of debriefs) {
      if (debrief.audio) deleteRecording(debrief.audio.uri);
    }
    await deleteAllDebriefs();
    setDebriefs([]);
  }, [debriefs]);

  const search = useCallback(
    (term: string) => debriefs.filter((debrief) => matchesSearch(debrief, term)),
    [debriefs]
  );

  const find = useCallback((id: string) => debriefs.find((item) => item.id === id), [debriefs]);

  const value = useMemo(
    () => ({
      debriefs,
      loading,
      error,
      reload,
      find,
      add,
      update,
      remove,
      forgetRecording,
      clearAll,
      search,
    }),
    [debriefs, loading, error, reload, find, add, update, remove, forgetRecording, clearAll, search]
  );

  return <DebriefsContext.Provider value={value}>{children}</DebriefsContext.Provider>;
}

export function useDebriefs(): DebriefsValue {
  const context = useContext(DebriefsContext);
  if (!context) {
    throw new Error('useDebriefs must be used inside a DebriefsProvider');
  }
  return context;
}
