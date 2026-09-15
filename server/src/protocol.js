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
 */

import { normalizeAudioConfig } from './audio.js';

export const CLIENT_MESSAGE_TYPES = [
  'session.start',
  'session.pause',
  'session.resume',
  'session.stop',
  'audio.frame',
];

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

/** Defensive parse: unknown or malformed frames return null and are ignored. */
export function parseClientMessage(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof data !== 'object' || data === null) return null;

  switch (data.t) {
    case 'session.start':
      if (!isGoal(data.goal)) return null;
      return {
        t: 'session.start',
        goal: data.goal,
        client: isClient(data.client)
          ? data.client
          : { platform: 'unknown', appVersion: 'unknown' },
      };

    case 'session.pause':
    case 'session.resume':
    case 'session.stop':
      return { t: data.t };

    case 'audio.frame': {
      if (typeof data.pcm !== 'string' || data.pcm === '') return null;
      return {
        t: 'audio.frame',
        seq: Number.isFinite(Number(data.seq)) ? Number(data.seq) : 0,
        pcm: data.pcm,
        /** What the device actually delivered, so nothing needs transcoding. */
        audio: normalizeAudioConfig(data.audio),
        byteLength: Number.isFinite(Number(data.byteLength)) ? Number(data.byteLength) : 0,
      };
    }

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
