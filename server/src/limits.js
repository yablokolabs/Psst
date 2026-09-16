/**
 * Server-side limits.
 *
 * A public WebSocket session API accepts frames from a device Psst does not
 * control, so every dimension a hostile or merely broken client could grow
 * without bound has an explicit ceiling: the size of a single frame, the total
 * audio accepted for one session, how much audio can wait for the provider, how
 * many sessions may exist at once, how long a session may sit idle, how long it
 * may run at all, and how many messages per second it may send.
 *
 * Everything is overridable by environment variable so a deployment can tune it
 * without a code change, and the values are reported (as numbers) by /health.
 */

import { loadServerEnv } from './env.js';

loadServerEnv();

/** Reads a positive integer override, falling back when unset or nonsense. */
function readLimit(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : fallback;
}

export const LIMITS = {
  /** Largest single WebSocket message accepted from the app (ws `maxPayload`). */
  maxPayloadBytes: readLimit('PSST_MAX_PAYLOAD_BYTES', 256 * 1024),
  /** Largest decoded PCM frame for one `audio.frame`. */
  maxAudioFrameBytes: readLimit('PSST_MAX_AUDIO_FRAME_BYTES', 64 * 1024),
  /** Total decoded audio accepted for one session. */
  maxSessionAudioBytes: readLimit('PSST_MAX_SESSION_AUDIO_BYTES', 96 * 1024 * 1024),
  /** Audio allowed to wait for the provider socket to open, measured in bytes. */
  maxProviderQueueBytes: readLimit('PSST_MAX_PROVIDER_QUEUE_BYTES', 512 * 1024),
  /** Audio allowed to wait for the provider socket to open, measured in age. */
  providerQueueMaxAgeMs: readLimit('PSST_PROVIDER_QUEUE_MAX_AGE_MS', 4000),
  /** Unsent bytes on the provider socket before live audio is dropped instead. */
  maxProviderBufferedBytes: readLimit('PSST_MAX_PROVIDER_BUFFERED_BYTES', 512 * 1024),
  /** Concurrent sessions. */
  maxSessions: readLimit('PSST_MAX_SESSIONS', 64),
  /** Close a session that has sent nothing for this long. */
  idleTimeoutMs: readLimit('PSST_IDLE_TIMEOUT_MS', 180000),
  /** Hard ceiling on one session's lifetime, after which it is ended cleanly. */
  maxSessionDurationMs: readLimit('PSST_MAX_SESSION_DURATION_MS', 3600000),
  /** Client messages accepted per second before frames are dropped. */
  maxMessagesPerSecond: readLimit('PSST_MAX_MESSAGES_PER_SEC', 300),
};

/** Numbers only: safe to log and to serve from /health. */
export function describeLimits() {
  return { ...LIMITS };
}
