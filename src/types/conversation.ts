/**
 * Conversation domain types.
 *
 * These types describe the contract between the LIVE screen and whichever
 * conversation service is powering it. In Phase 1 the only implementation is
 * `MockConversationService`; in Phase 2 a `RealtimeConversationService` (Expo app
 * -> Psst backend -> ElevenLabs realtime STT) can implement the same interface
 * without any changes to the UI.
 */

export type ConversationPreset =
  | 'negotiation'
  | 'sales'
  | 'customer'
  | 'meeting'
  | 'difficult'
  | 'other';

/** Who is speaking. `you` is the Psst user, `them` is everyone else in the room. */
export type Speaker = 'you' | 'them';

export interface TranscriptEntry {
  /** Stable id. A partial and its final share the same id so partials update in place. */
  id: string;
  speaker: Speaker;
  text: string;
  isFinal: boolean;
  /** Milliseconds since the session started. */
  at: number;
}

export type CueTone = 'opportunity' | 'risk' | 'question' | 'signal';

/**
 * A Psst cue. Deliberately short: one observation plus one action, readable at
 * a glance while the real conversation continues.
 */
export interface PsstCue {
  id: string;
  observation: string;
  action: string;
  tone: CueTone;
  at: number;
}

export type ConversationStatus = 'idle' | 'connecting' | 'listening' | 'paused' | 'ended' | 'error';

/**
 * One buffer of captured microphone audio, exactly as the device produced it.
 *
 * There is no container and no encoding step: these are raw PCM16 little-endian
 * mono samples plus the format they were captured in, so the backend can pick
 * the matching provider format without transcoding anything.
 */
export interface MicrophoneFrame {
  pcm: Uint8Array;
  /** The rate the device actually delivered, which may differ from the request. */
  sampleRate: number;
  channels: number;
  encoding: 'int16';
}

export interface ConversationGoal {
  title: string;
  objective: string;
  notes: string;
  preset: ConversationPreset;
}

/**
 * The reasoning engine has exactly two outcomes: NO_ACTION (nothing emitted) or
 * a PSST cue. Nothing else is pushed to the UI while a session is live.
 */
export type ConversationEvent =
  | { type: 'STATUS'; status: ConversationStatus }
  | { type: 'TRANSCRIPT_PARTIAL'; entry: TranscriptEntry }
  | { type: 'TRANSCRIPT_FINAL'; entry: TranscriptEntry }
  | { type: 'PSST'; cue: PsstCue }
  /**
   * Non-fatal problem: the session is still running, but something degraded
   * (provider quota, a part of the pipeline being unconfigured, and so on).
   */
  | { type: 'NOTICE'; level: NoticeLevel; message: string }
  | { type: 'ERROR'; message: string };

export type NoticeLevel = 'info' | 'warning';

export interface Recap {
  id: string;
  title: string;
  preset: ConversationPreset;
  goal: ConversationGoal;
  /** ISO timestamps. */
  startedAt: string;
  endedAt: string;
  durationMs: number;
  summary: string;
  keyPoints: string[];
  commitments: string[];
  missed: string[];
  nextActions: string[];
  cueCount: number;
}

/**
 * Everything the LIVE screen needs. `stop()` resolves with the recap so a
 * future backend can generate it server-side.
 */
export interface ConversationService {
  /** `mock` in Phase 1, `realtime` once the backend + ElevenLabs pipeline lands. */
  readonly kind: 'mock' | 'realtime';
  start(goal: ConversationGoal): void;
  pause(): void;
  resume(): void;
  stop(): Promise<Recap>;
  subscribe(listener: (event: ConversationEvent) => void): () => void;
  getStatus(): ConversationStatus;
  /**
   * Feeds one captured microphone buffer to the engine.
   *
   * Only realtime engines implement this: the mock engine has no microphone at
   * all, and the LIVE screen never talks to a transport directly. Frames are
   * ignored unless a session is actively listening.
   */
  pushAudio?(frame: MicrophoneFrame): void;
  /** Releases timers or sockets. Called when the LIVE screen unmounts. */
  dispose?(): void;
}
