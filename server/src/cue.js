/**
 * Cue suppression.
 *
 * The reasoning model proposes cues; this module decides whether one is actually
 * worth showing. A real-time copilot that keeps repeating itself is worse than
 * one that says nothing, so the bar is deliberately high: recent cues are kept in
 * session state and anything duplicated, near-identical, stale or weak is
 * dropped.
 *
 * Favour silence over weak advice.
 */

import { loadServerEnv } from './env.js';

loadServerEnv();

/** Minimum gap between two cues. A live conversation needs room to breathe. */
export const MIN_CUE_INTERVAL_MS = Number(process.env.PSST_MIN_CUE_INTERVAL_MS ?? 12000);
/** How many recent cues are remembered and shown back to the model. */
export const MAX_RECENT_CUES = 12;
/** Token overlap above which two cues are considered the same advice. */
const SIMILARITY_THRESHOLD = 0.5;
/** Cues shorter than this are too vague to act on. */
const MIN_CUE_WORDS = 1;

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'is', 'are', 'was', 'be',
  'they', 'them', 'their', 'you', 'your', 'it', 'that', 'this', 'we', 'as', 'at', 'with',
  'do', 'does', 'did', 'not', 'no', 'but', 'if', 'so', 'about', 'before', 'after', 'what',
  'which', 'when', 'how', 'more', 'most', 'has', 'have', 'had', 'will', 'would', 'can',
]);

export function tokenize(text) {
  return (typeof text === 'string' ? text.toLowerCase() : '')
    .replace(/[^a-z0-9\s$%]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

/** Jaccard similarity over content words: cheap and good enough for cues. */
export function similarity(a, b) {
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const token of left) {
    if (right.has(token)) shared += 1;
  }
  return shared / (left.size + right.size - shared);
}

/** True when a candidate repeats the intent of an earlier cue. */
export function isDuplicate(candidate, recentCues) {
  return recentCues.some(
    (previous) =>
      similarity(candidate.observation, previous.observation) >= SIMILARITY_THRESHOLD ||
      similarity(candidate.action, previous.action) >= SIMILARITY_THRESHOLD ||
      similarity(candidate.observation, previous.action) >= SIMILARITY_THRESHOLD ||
      similarity(candidate.action, previous.observation) >= SIMILARITY_THRESHOLD
  );
}

/**
 * @param {{ observation: string, action: string, confidence?: number }} candidate
 * @param {{ recentCues?: Array<object>, lastCueAt?: number | null, now?: number, minIntervalMs?: number }} state
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkCue(candidate, state = {}) {
  const recentCues = state.recentCues ?? [];
  const now = state.now ?? Date.now();
  const minIntervalMs = state.minIntervalMs ?? MIN_CUE_INTERVAL_MS;

  if (!candidate || typeof candidate.observation !== 'string' || typeof candidate.action !== 'string') {
    return { ok: false, reason: 'malformed' };
  }

  const observation = candidate.observation.trim();
  const action = candidate.action.trim();
  if (observation === '' || action === '') return { ok: false, reason: 'empty' };
  if (observation.split(' ').length < MIN_CUE_WORDS) return { ok: false, reason: 'too-vague' };

  if (typeof state.lastCueAt === 'number' && now - state.lastCueAt < minIntervalMs) {
    return { ok: false, reason: 'too-soon' };
  }

  if (isDuplicate({ observation, action }, recentCues)) {
    return { ok: false, reason: 'duplicate' };
  }

  return { ok: true };
}

/**
 * Records a cue in rolling session state, keeping only the most recent ones.
 * Returns the trimmed list.
 */
export function pushRecentCue(recentCues, cue) {
  const next = [...recentCues, cue];
  return next.length > MAX_RECENT_CUES ? next.slice(next.length - MAX_RECENT_CUES) : next;
}
