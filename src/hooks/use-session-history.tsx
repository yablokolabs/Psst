/**
 * In-memory conversation history.
 *
 * Phase 1 keeps finished recaps for the current app run plus three seeded demo
 * recaps so the Home screen is never empty. No storage dependency yet: Phase 2
 * can persist this or fetch it from the backend without touching the screens.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { createSeedHistory } from '@/services/mockHistory';
import type { Recap } from '@/types/conversation';

export interface SessionHistoryValue {
  /** Newest first. */
  sessions: Recap[];
  addSession: (recap: Recap) => void;
  getSession: (id: string) => Recap | undefined;
  clearSessions: () => void;
}

const SessionHistoryContext = createContext<SessionHistoryValue | null>(null);

export function SessionHistoryProvider({
  children,
  initialSessions,
}: {
  children: ReactNode;
  initialSessions?: Recap[];
}) {
  const [sessions, setSessions] = useState<Recap[]>(() => initialSessions ?? createSeedHistory());

  const addSession = useCallback((recap: Recap) => {
    setSessions((previous) => [recap, ...previous.filter((session) => session.id !== recap.id)]);
  }, []);

  const getSession = useCallback(
    (id: string) => sessions.find((session) => session.id === id),
    [sessions]
  );

  const clearSessions = useCallback(() => setSessions([]), []);

  const value = useMemo(
    () => ({ sessions, addSession, getSession, clearSessions }),
    [sessions, addSession, getSession, clearSessions]
  );

  return <SessionHistoryContext.Provider value={value}>{children}</SessionHistoryContext.Provider>;
}

export function useSessionHistory(): SessionHistoryValue {
  const context = useContext(SessionHistoryContext);
  if (!context) {
    throw new Error('useSessionHistory must be used inside a SessionHistoryProvider');
  }
  return context;
}
