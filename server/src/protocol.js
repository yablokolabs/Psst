/**
 * Wire protocol for the Psst realtime API.
 *
 * Mirrors `src/types/realtime.ts` in the Psst app. Keep both sides in sync.
 *
 * Client -> backend: session.start, session.pause, session.resume, session.stop,
 *                    audio.frame (base64 PCM16 mono at the recorded sample rate)
 * Backend -> client: status, transcript.partial, transcript.final, psst, recap,
 *                    notice, error
 *
 * `notice` is a non-fatal message: the session keeps running and the user is told
 * what degraded. `error` ends the session and is only used when Psst cannot
 * continue at all.
 *
 * Parsing is total: this code runs inside the WebSocket message handler on raw
 * client input, so it must never throw. An unusable frame is either dropped
 * (null) or reported as an internal `audio.frame.rejected` result for the caller
 * to count and, when it is actionable, explain to the user.
 */

import { normalizeAudioConfig, validatePcmFrame } from './audio.js';
import { LIMITS } from './limits.js';

export const CLIENT_MESSAGE_TYPES = [
  'session.start',
  'session.pause',
  'session.resume',
  'session.stop',
  'audio.frame',
];

/** Longest goal field accepted from the client, in characters. */
const MAX_GOAL_FIELD_CHARS = 2000;
const MAX_TITLE_CHARS = 200;
const MAX_PRESET_CHARS = 40;

function clip(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function isGoal(goal) {
  return (
    typeof goal === 'object' &&
    goal !== null &&
    typeof goal.title === 'string' &&
    typeof goal.objective === 'string' &&
    typeof goal.notes === 'string' &&
    typeof goal.preset === 'string'
  );
}

function isClient(client) {
  return (
    typeof client === 'object' &&
    client !== null &&
    typeof client.platform === 'string' &&
    typeof client.appVersion === 'string'
  );
}

/** Truncated copy of the goal: the client controls these strings. */
function normalizeGoal(goal) {
  return {
    title: clip(goal.title, MAX_TITLE_CHARS),
    objective: clip(goal.objective, MAX_GOAL_FIELD_CHARS),
    notes: clip(goal.notes, MAX_GOAL_FIELD_CHARS),
    preset: clip(goal.preset, MAX_PRESET_CHARS),
  };
}

function readSampleRate(value) {
  const rate = Number(value);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

function parseAudioFrame(data) {
  // The `audio` block describes the bytes in this frame. Without it we cannot
  // know how to hand the audio to the provider, so the frame is rejected:
  // guessing a rate here is how a conversation ends up transcribed at the wrong
  // pitch.
  if (typeof data.audio !== 'object' || data.audio === null) {
    return { t: 'audio.frame.rejected', reason: 'malformed-audio-config' };
  }

  const audio = normalizeAudioConfig(data.audio);
  if (audio === null) {
    return {
      t: 'audio.frame.rejected',
      reason: 'unsupported-audio-format',
      reportedSampleRate: readSampleRate(data.audio.sampleRate),
    };
  }

  const payload = validatePcmFrame(data.pcm, data.byteLength, LIMITS.maxAudioFrameBytes);
  if (!payload.ok) {
    return { t: 'audio.frame.rejected', reason: payload.reason, byteLength: payload.byteLength ?? 0 };
  }

  return {
    t: 'audio.frame',
    seq: Number.isFinite(Number(data.seq)) ? Number(data.seq) : 0,
    pcm: data.pcm,
    /** What the device actually delivered, so nothing needs transcoding. */
    audio,
    /** Decoded size, authoritative: the declared value was verified against it. */
    byteLength: payload.byteLength,
  };
}

/** Defensive parse: unknown or malformed frames return null and are ignored. */
export function parseClientMessage(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;

  switch (data.t) {
    case 'session.start':
      if (!isGoal(data.goal)) return null;
      return {
        t: 'session.start',
        goal: normalizeGoal(data.goal),
        client: isClient(data.client)
          ? { platform: clip(data.client.platform, 40), appVersion: clip(data.client.appVersion, 40) }
          : { platform: 'unknown', appVersion: 'unknown' },
      };

    case 'session.pause':
    case 'session.resume':
    case 'session.stop':
      return { t: data.t };

    case 'audio.frame':
      return parseAudioFrame(data);

    default:
      return null;
  }
}

export function encode(message) {
  return JSON.stringify(message);
}

export function statusMessage(status) {
  return { t: 'status', status };
}

export function transcriptMessage(entry) {
  return { t: entry.isFinal ? 'transcript.final' : 'transcript.partial', entry };
}

export function psstMessage(cue) {
  return { t: 'psst', cue };
}

export function recapMessage(recap) {
  return { t: 'recap', recap };
}

export function noticeMessage(level, message) {
  return { t: 'notice', level: level === 'warning' ? 'warning' : 'info', message };
}

export function errorMessage(message) {
  return { t: 'error', message };
}
