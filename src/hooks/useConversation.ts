/**
 * Drives a conversation session for the LIVE screen.
 *
 * The hook knows nothing about mocks or sockets: it receives events from a
 * `ConversationService`, keeps the transcript and cue list, tracks the session
 * clock and enforces the free-tier listening limit.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createConversationService, type ConversationMode } from '@/services/conversation';
import type {
  ConversationEvent,
  ConversationGoal,
  ConversationService,
  ConversationStatus,
  MicrophoneFrame,
  NoticeLevel,
  PsstCue,
  Recap,
  TranscriptEntry,
} from '@/types/conversation';

export interface ConversationNotice {
  level: NoticeLevel;
  message: string;
}

export interface UseConversationOptions {
  mode?: ConversationMode;
  /** Auto-pauses the session once this many milliseconds have been listened to. */
  limitMs?: number;
}

export interface UseConversationResult {
  /** Which engine is running: scripted mock or the realtime backend. */
  mode: ConversationMode;
  status: ConversationStatus;
  entries: TranscriptEntry[];
  cues: PsstCue[];
  elapsedMs: number;
  error: string | null;
  /** Non-fatal problem reported by the backend. The session keeps running. */
  notice: ConversationNotice | null;
  /** True when the free-tier listening limit stopped the session. */
  limitReached: boolean;
  start: (goal: ConversationGoal) => void;
  /** Starts a fresh session with the same goal. Used to retry after a failure. */
  restart: () => void;
  pause: () => void;
  resume: () => void;
  /**
   * Forwards captured microphone audio to the engine.
   * A no-op for engines that have no microphone (the mock engine).
   */
  pushAudio: (frame: MicrophoneFrame) => void;
  /** Stops the session and resolves with the recap. */
  end: () => Promise<Recap | null>;
}

function upsertEntry(entries: TranscriptEntry[], entry: TranscriptEntry): TranscriptEntry[] {
  const index = entries.findIndex((candidate) => candidate.id === entry.id);
  if (index === -1) return [...entries, entry];
  const next = [...entries];
  next[index] = entry;
  return next;
}

export function useConversation(options: UseConversationOptions = {}): UseConversationResult {
  const { mode = 'mock', limitMs } = options;

  const [status, setStatus] = useState<ConversationStatus>('idle');
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [cues, setCues] = useState<PsstCue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<ConversationNotice | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [limitReached, setLimitReached] = useState(false);

  const serviceRef = useRef<ConversationService | null>(null);
  const lastGoalRef = useRef<ConversationGoal | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const accumulatedRef = useRef(0);
  const runStartRef = useRef<number | null>(null);
  const limitRef = useRef(limitMs);
  const limitReachedRef = useRef(false);

  useEffect(() => {
    limitRef.current = limitMs;
  }, [limitMs]);

  const handleEvent = useCallback((event: ConversationEvent) => {
    switch (event.type) {
      case 'STATUS':
        setStatus(event.status);
        break;
      case 'TRANSCRIPT_PARTIAL':
      case 'TRANSCRIPT_FINAL':
        setEntries((previous) => upsertEntry(previous, event.entry));
        break;
      case 'PSST':
        setCues((previous) => [...previous, event.cue]);
        break;
      case 'NOTICE':
        setNotice({ level: event.level, message: event.message });
        break;
      case 'ERROR':
        setError(event.message);
        setStatus('error');
        break;
    }
  }, []);

  const getService = useCallback(() => {
    if (!serviceRef.current) {
      const service = createConversationService(mode);
      serviceRef.current = service;
      unsubscribeRef.current = service.subscribe(handleEvent);
    }
    return serviceRef.current;
  }, [mode, handleEvent]);

  // Session clock: accumulate listening time so a pause freezes the timer.
  useEffect(() => {
    if (status !== 'listening') return;

    runStartRef.current = Date.now();
    return () => {
      if (runStartRef.current !== null) {
        accumulatedRef.current += Date.now() - runStartRef.current;
        runStartRef.current = null;
      }
    };
  }, [status]);

  useEffect(() => {
    if (status !== 'listening') return;

    const interval = setInterval(() => {
      const runStart = runStartRef.current;
      const value = accumulatedRef.current + (runStart === null ? 0 : Date.now() - runStart);
      setElapsedMs(value);

      const limit = limitRef.current;
      if (limit && value >= limit && !limitReachedRef.current) {
        limitReachedRef.current = true;
        setLimitReached(true);
        serviceRef.current?.pause();
      }
    }, 200);

    return () => clearInterval(interval);
  }, [status]);

  useEffect(
    () => () => {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      serviceRef.current?.dispose?.();
      serviceRef.current = null;
    },
    []
  );

  const start = useCallback(
    (goal: ConversationGoal) => {
      const service = getService();
      lastGoalRef.current = goal;
      accumulatedRef.current = 0;
      runStartRef.current = null;
      limitReachedRef.current = false;
      setEntries([]);
      setCues([]);
      setError(null);
      setNotice(null);
      setElapsedMs(0);
      setLimitReached(false);
      service.start(goal);
    },
    [getService]
  );

  const restart = useCallback(() => {
    const goal = lastGoalRef.current;
    if (goal) start(goal);
  }, [start]);

  const pause = useCallback(() => {
    serviceRef.current?.pause();
  }, []);

  const pushAudio = useCallback((frame: MicrophoneFrame) => {
    serviceRef.current?.pushAudio?.(frame);
  }, []);

  const resume = useCallback(() => {
    serviceRef.current?.resume();
  }, []);

  const end = useCallback(async () => {
    const service = serviceRef.current;
    if (!service) return null;
    return service.stop();
  }, []);

  return useMemo(
    () => ({
      mode,
      status,
      entries,
      cues,
      elapsedMs,
      error,
      notice,
      limitReached,
      start,
      restart,
      pause,
      resume,
      pushAudio,
      end,
    }),
    [
      mode,
      status,
      entries,
      cues,
      elapsedMs,
      error,
      notice,
      limitReached,
      start,
      restart,
      pause,
      resume,
      pushAudio,
      end,
    ]
  );
}
