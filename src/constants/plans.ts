/** FREE vs PSST PRO limits and copy. Single source of truth for gating. */

/** How many debriefs the free tier keeps in the timeline. */
export const FREE_HISTORY_LIMIT = 3;

/** Recordings the free tier will analyse each month. */
export const FREE_IMPORTS_PER_MONTH = 5;

export const FREE_FEATURES = [
  `${FREE_IMPORTS_PER_MONTH} recordings analysed each month`,
  'Summary, decisions, commitments and follow-ups',
  `Last ${FREE_HISTORY_LIMIT} debriefs in your timeline`,
  'Reminders and copy-ready follow-up messages',
];

export const PRO_FEATURES = [
  'Unlimited recordings analysed',
  'Your full debrief timeline, searchable forever',
  'Deeper debriefs tuned to the kind of call',
  'Track follow-ups across every call and contact',
  'Early access to voice profiles and integrations',
];

export const PRO_TAGLINE = 'Remember every call, not just the ones you have time to think about.';
