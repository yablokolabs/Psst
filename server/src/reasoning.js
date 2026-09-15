/**
 * Conversation reasoning — the Psst brain seam.
 *
 * Psst is NOT a chatbot generating replies: the engine has exactly two outcomes,
 * NO_ACTION or PSST. Most conversational moments produce NO_ACTION, and only
 * genuinely useful moments produce a short cue (one observation, one action).
 *
 * The provider is swappable: `decide()` and `buildRecap()` talk to a
 * `ReasoningProvider` (the pinned outcome/cue contract) and never to a
 * provider-specific response shape.
 *
 *   ReasoningProvider
 *     evaluate({ goal, transcript, latest, recentCues })
 *       -> { outcome: NO_ACTION } | { outcome: PSST, cue: { observation, suggestion, confidence } }
 *     summarize({ goal, transcript, cues, durationMs })
 *       -> { summary, keyPoints, commitments, missed, nextActions } | null
 *
 * Everything is failure-tolerant: a provider that is missing, slow, erroring or
 * returning nonsense degrades to NO_ACTION, and a recap is always produced from
 * what was actually captured.
 */

import { checkCue } from './cue.js';
import { OUTCOME } from './outcome.js';
import { SarvamReasoningProvider, isSarvamConfigured } from './sarvam.js';

export { OUTCOME };

/**
 * Model-written recap budget. Unlike a live cue this call is not latency
 * critical — it runs once as the session ends, while the app waits 12s for the
 * recap frame — so it gets a generous budget before falling back.
 */
const RECAP_TIMEOUT_MS = Number(process.env.PSST_RECAP_TIMEOUT_MS ?? 10000);

/**
 * Builds the configured reasoning provider, or null when none is available.
 * The rest of the server only sees the provider interface.
 */
export function createReasoningProvider() {
  if (isSarvamConfigured()) return new SarvamReasoningProvider();
  return null;
}

/**
 * Decides the next action for a committed utterance.
 *
 * @param {{ goal: object, transcript: Array<object>, latest: object, recentCues?: Array<object>, lastCueAt?: number | null }} context
 * @param {{ provider?: object | null, now?: number }} [options]
 * @returns {Promise<{ outcome: string, cue?: object, error?: string, skipped?: string, suppressed?: string }>}
 */
export async function decide(context, options = {}) {
  const provider = options.provider === undefined ? createReasoningProvider() : options.provider;
  if (!provider) return { outcome: OUTCOME.NO_ACTION, skipped: 'no-provider' };

  let result;
  try {
    result = await provider.evaluate({
      goal: context.goal,
      transcript: context.transcript ?? [],
      latest: context.latest,
      recentCues: context.recentCues ?? [],
    });
  } catch (error) {
    // A live session is never interrupted because reasoning threw.
    return {
      outcome: OUTCOME.NO_ACTION,
      error: error instanceof Error ? error.message : 'reasoning-failed',
    };
  }

  if (!result || result.outcome !== OUTCOME.PSST || !result.cue) {
    return { outcome: OUTCOME.NO_ACTION, error: result?.error, skipped: result?.skipped };
  }

  const guard = checkCue(
    { observation: result.cue.observation, action: result.cue.suggestion },
    {
      recentCues: context.recentCues ?? [],
      lastCueAt: context.lastCueAt ?? null,
      now: options.now,
    }
  );

  if (!guard.ok) return { outcome: OUTCOME.NO_ACTION, suppressed: guard.reason };

  return { outcome: OUTCOME.PSST, cue: result.cue };
}

const COMMITMENT_PATTERNS = [
  /\b(i'?ll|we'?ll|i will|we will|let me|i can|we can|i'?m going to|we'?re going to)\b/i,
  /\b(send|share|follow up|get back|introduce|schedule|book|prepare|confirm)\b/i,
];

/**
 * Derives a recap from what Psst actually captured. Used when no provider is
 * configured or the model is unavailable: it never invents content, it lists the
 * transcript and reuses the cues that were genuinely shown.
 */
function buildLocalRecap(session) {
  const spoken = session.finalEntries;

  if (spoken.length === 0) {
    return {
      summary:
        'No speech was transcribed for this session, so there is nothing to summarise. Check that microphone access was granted and the backend was reachable.',
      keyPoints: [],
      commitments: [],
      missed: [],
      nextActions: [],
    };
  }

  const commitments = spoken
    .map((entry) => entry.text)
    .filter((text) => COMMITMENT_PATTERNS.some((pattern) => pattern.test(text)))
    .slice(0, 6);

  const missed = session.cues.map((cue) => cue.observation).filter(Boolean).slice(0, 6);
  const nextActions = [...new Set(session.cues.map((cue) => cue.action).filter(Boolean))].slice(0, 6);
  const longest = [...spoken].sort((a, b) => b.text.length - a.text.length).slice(0, 5);

  return {
    summary:
      'The recap model was unavailable, so this lists what Psst captured during the session rather than an AI summary.',
    keyPoints: longest.map((entry) => entry.text),
    commitments,
    missed,
    nextActions,
  };
}

/** Runs the provider recap with a hard budget so `session.stop` always answers. */
async function buildModelRecap(session, provider) {
  if (!provider) return null;

  const work = provider.summarize({
    goal: session.goal,
    transcript: session.finalEntries,
    cues: session.cues,
    durationMs: session.durationMs,
  });

  const timeout = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), RECAP_TIMEOUT_MS);
    // Do not hold the event loop open for a recap.
    timer.unref?.();
  });

  try {
    return await Promise.race([work, timeout]);
  } catch {
    return null;
  }
}

/**
 * Builds the recap object the app renders on the RECAP screen.
 *
 * @param {import('./session.js').ConversationSession} session
 * @param {{ provider?: object | null, useModel?: boolean }} [options]
 */
export async function buildRecap(session, options = {}) {
  session.freezeClock();

  const local = buildLocalRecap(session);
  const useModel = options.useModel ?? true;
  let sections = local;

  if (useModel && session.finalEntries.length > 0) {
    const provider = options.provider === undefined ? createReasoningProvider() : options.provider;
    const modelSections = await buildModelRecap(session, provider);
    if (modelSections) sections = modelSections;
  }

  const title = session.goal?.title?.trim() ? session.goal.title : 'Realtime session';

  return {
    id: session.id,
    title,
    preset: session.goal?.preset ?? 'other',
    goal: session.goal ?? { title, objective: '', notes: '', preset: 'other' },
    startedAt: session.startedAt,
    endedAt: session.endedAt ?? new Date().toISOString(),
    durationMs: session.durationMs,
    cueCount: session.cues.length,
    ...sections,
  };
}
