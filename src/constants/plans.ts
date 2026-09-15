/** FREE vs PSST PRO limits and copy. Single source of truth for gating. */

export const FREE_LIVE_MINUTES = 10;
export const FREE_LIVE_LIMIT_MS = FREE_LIVE_MINUTES * 60 * 1000;
/** How many conversations the free tier keeps in history. */
export const FREE_HISTORY_LIMIT = 3;

export const FREE_FEATURES = [
  'Unlimited prep sessions',
  `Live Psst cues for the first ${FREE_LIVE_MINUTES} minutes`,
  'Basic recap after every session',
  `Last ${FREE_HISTORY_LIMIT} conversations in your history`,
];

export const PRO_FEATURES = [
  'Extended live sessions with no time limit',
  'Advanced Psst cues tuned to your goal',
  'Full conversation history',
  'Advanced recap: commitments, missed moments and next actions',
  'Early access to personalisation and voice profiles',
];

export const PRO_TAGLINE = 'Know what to say next — for the whole conversation.';
