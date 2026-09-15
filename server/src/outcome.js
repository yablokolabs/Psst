/**
 * The two outcomes of the Psst reasoning engine.
 *
 * Most conversational moments produce NO_ACTION. A PSST is reserved for moments
 * that are genuinely worth interrupting a live conversation for. There is no
 * third outcome and no chat reply: silence is a feature.
 *
 * Kept in its own module so `reasoning.js` and the provider implementations can
 * share it without importing each other.
 */

export const OUTCOME = {
  NO_ACTION: 'NO_ACTION',
  PSST: 'PSST',
};
