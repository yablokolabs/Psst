/**
 * Psst realtime wire protocol (app <-> Psst backend).
 *
 * This is the contract Phase 2 implements on the Azure backend:
 *
 *   phone mic -> Psst app -> WSS -> Psst backend -> ElevenLabs realtime STT
 *            -> transcript -> conversation state -> LLM reasoning
 *            -> NO_ACTION / PSST -> cue on the phone
 *
 * The backend is the only place that ever holds ELEVENLABS_API_KEY. The app
 * sends audio frames and receives events; it never talks to ElevenLabs directly
 * and never sees an ElevenLabs credential.
 *
 * Audio frames carry raw captured PCM, base64-encoded:
 *
 *   { t: 'audio.frame', seq, pcm, audio: { sampleRate, channels, encoding }, byteLength }
 *
 * The `audio` block describes the bytes that were actually captured. Nothing is
 * resampled or re-encoded on either side: the backend maps the delivered sample
 * rate straight onto the provider's matching PCM format.
 */

import type {
  ConversationGoal,
  ConversationStatus,
  NoticeLevel,
  PsstCue,
  Recap,
  TranscriptEntry,
} from '@/types/conversation';

export interface RealtimeClientInfo {
  platform: string;
  appVersion: string;
}

/** Format block that accompanies every audio frame. */
export interface RealtimeAudioConfig {
  sampleRate: number;
  channels: number;
  encoding: 'int16';
}

export type ClientMessage =
  /** Opens the session. Sent immediately after the socket connects. */
  | { t: 'session.start'; goal: ConversationGoal; client: RealtimeClientInfo }
  | { t: 'session.pause' }
  | { t: 'session.resume' }
  /** Asks the backend to finish and return the recap. */
  | { t: 'session.stop' }
  /** One chunk of captured microphone audio. */
  | {
      t: 'audio.frame';
      seq: number;
      /** base64 PCM16 little-endian mono. */
      pcm: string;
      audio: RealtimeAudioConfig;
      /** Decoded size, so the backend can report audio duration without decoding. */
      byteLength: number;
    };

export type ServerMessage =
  | { t: 'status'; status: ConversationStatus }
  | { t: 'transcript.partial'; entry: TranscriptEntry }
  | { t: 'transcript.final'; entry: TranscriptEntry }
  | { t: 'psst'; cue: PsstCue }
  | { t: 'recap'; recap: Recap }
  /** Non-fatal: the session continues, the message explains what degraded. */
  | { t: 'notice'; level: NoticeLevel; message: string }
  | { t: 'error'; message: string };

export function encodeClientMessage(message: ClientMessage): string {
  return JSON.stringify(message);
}

function isTranscriptEntry(value: unknown): value is TranscriptEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<TranscriptEntry>;
  return (
    typeof entry.id === 'string' &&
    (entry.speaker === 'you' || entry.speaker === 'them') &&
    typeof entry.text === 'string' &&
    typeof entry.isFinal === 'boolean' &&
    typeof entry.at === 'number'
  );
}

function isCue(value: unknown): value is PsstCue {
  if (typeof value !== 'object' || value === null) return false;
  const cue = value as Partial<PsstCue>;
  return (
    typeof cue.id === 'string' &&
    typeof cue.observation === 'string' &&
    typeof cue.action === 'string' &&
    typeof cue.tone === 'string' &&
    typeof cue.at === 'number'
  );
}

function isRecap(value: unknown): value is Recap {
  if (typeof value !== 'object' || value === null) return false;
  const recap = value as Partial<Recap>;
  return (
    typeof recap.id === 'string' &&
    typeof recap.title === 'string' &&
    typeof recap.summary === 'string' &&
    Array.isArray(recap.keyPoints) &&
    Array.isArray(recap.nextActions)
  );
}

const STATUSES: ConversationStatus[] = ['idle', 'connecting', 'listening', 'paused', 'ended', 'error'];

/**
 * Defensive parse: a malformed or unknown frame is dropped rather than crashing
 * the LIVE screen mid-conversation.
 */
export function parseServerMessage(raw: string): ServerMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof data !== 'object' || data === null) return null;
  const message = data as Record<string, unknown>;

  switch (message.t) {
    case 'status':
      return STATUSES.includes(message.status as ConversationStatus)
        ? { t: 'status', status: message.status as ConversationStatus }
        : null;
    case 'transcript.partial':
      return isTranscriptEntry(message.entry)
        ? { t: 'transcript.partial', entry: { ...message.entry, isFinal: false } }
        : null;
    case 'transcript.final':
      return isTranscriptEntry(message.entry)
        ? { t: 'transcript.final', entry: { ...message.entry, isFinal: true } }
        : null;
    case 'psst':
      return isCue(message.cue) ? { t: 'psst', cue: message.cue } : null;
    case 'recap':
      return isRecap(message.recap) ? { t: 'recap', recap: message.recap } : null;
    case 'notice':
      return typeof message.message === 'string' && message.message !== ''
        ? {
            t: 'notice',
            level: message.level === 'warning' ? 'warning' : 'info',
            message: message.message,
          }
        : null;
    case 'error':
      return typeof message.message === 'string' ? { t: 'error', message: message.message } : null;
    default:
      return null;
  }
}
