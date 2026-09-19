/**
 * The offline debrief generator.
 *
 * Two jobs, one implementation:
 *
 *  1. the demo path — if no backend is configured (or the backend is
 *     unreachable) the import still completes, so the app can be reviewed end to
 *     end on a phone without provider credentials;
 *  2. the first-run timeline, so a new install is not an empty screen.
 *
 * Everything it produces is marked `origin: 'demo'` and `degraded: true`, and
 * the UI says so. It never claims to have understood the user's actual
 * recording, and it never invents a transcript: `transcript` stays null.
 */

import type { CallType, Debrief, DebriefDraft } from '@/types/debrief';
import { createId } from '@/utils/ids';

interface DemoTemplate {
  summary: (contact: string) => string;
  keyDecisions: string[];
  commitments: (contact: string) => Debrief['commitments'];
  tasks: string[];
  suggestedMessage: (contact: string) => string;
  people: (contact: string) => Debrief['people'];
  openQuestions: string[];
  risks: Debrief['risks'];
  tone: Debrief['tone'];
  relationship: string;
  reminders: string[];
}

/** A person to name when the file name gave us nobody. */
function contactOr(contact: string, fallback: string): string {
  return contact.trim() === '' ? fallback : contact.trim();
}

const TEMPLATES: Record<CallType, DemoTemplate> = {
  sales: {
    summary: (contact) =>
      `A demo call with ${contactOr(contact, 'the prospect')}. They liked the product and asked ` +
      `for pricing, but held back on budget and timing. The next step is a written proposal with ` +
      `a clear pilot price.`,
    keyDecisions: [
      'They agreed to a two-week pilot before any annual commitment.',
      'Pricing discussion was deferred until the pilot scope is agreed.',
    ],
    commitments: (contact) => [
      {
        id: createId('commitment'),
        owner: 'you',
        person: '',
        what: 'Send the pilot proposal with pricing options',
        when: 'Friday',
      },
      {
        id: createId('commitment'),
        owner: 'them',
        person: contactOr(contact, ''),
        what: 'Share the security questionnaire with their IT lead',
        when: 'early next week',
      },
    ],
    tasks: ['Send the pilot proposal', 'Confirm the pilot start date', 'Log the security questions'],
    suggestedMessage: (contact) =>
      `Hi ${contactOr(contact, 'there')}, thanks for the call today. I am sending the pilot ` +
      `proposal on Friday with the two pricing options we discussed. If the scope looks right, ` +
      `we can start the two-week pilot next week.`,
    people: (contact) => [
      { id: createId('person'), name: contactOr(contact, 'Unknown'), context: 'Main contact on the call' },
      { id: createId('person'), name: 'IT lead', context: 'Owns the security review' },
    ],
    openQuestions: [
      'Is the budget already approved for this quarter?',
      'Who signs off on a pilot of this size?',
    ],
    risks: [
      { id: createId('risk'), label: 'Budget timing', detail: 'Budget was mentioned but never confirmed.' },
      { id: createId('risk'), label: 'Security review', detail: 'An unanswered questionnaire can delay the start.' },
    ],
    tone: { label: 'Positive, cautious', note: 'Interested but non-committal on money and dates.' },
    relationship: 'Early and warm. They are evaluating at least one other option.',
    reminders: ['You promised the pilot proposal by Friday.', 'Ask who signs off before discounting.'],
  },
  customer: {
    summary: (contact) =>
      `A renewal conversation with ${contactOr(contact, 'the account')}. Usage is healthy, but they ` +
      `raised two support issues that are still open. Renewal is likely if those are closed first.`,
    keyDecisions: ['Renewal will be discussed again after the open tickets are closed.'],
    commitments: (contact) => [
      {
        id: createId('commitment'),
        owner: 'you',
        person: '',
        what: 'Get both open tickets closed and confirm in writing',
        when: 'before the end of the quarter',
      },
    ],
    tasks: ['Chase the two open support tickets', 'Send the renewal summary'],
    suggestedMessage: (contact) =>
      `Hi ${contactOr(contact, 'there')}, thanks for the honest feedback on the call. I am chasing ` +
      `both open tickets and will confirm in writing once they are closed. I will come back to you ` +
      `about the renewal straight after that.`,
    people: (contact) => [
      { id: createId('person'), name: contactOr(contact, 'Unknown'), context: 'Account owner on the call' },
    ],
    openQuestions: ['What would make them feel the issues are properly closed?'],
    risks: [{ id: createId('risk'), label: 'Unresolved tickets', detail: 'Renewal is blocked on the support issues.' }],
    tone: { label: 'Candid, slightly frustrated', note: 'Direct about the problems; still engaged.' },
    relationship: 'Established and worth protecting. They told you the bad news directly.',
    reminders: ['You promised to confirm the ticket fixes in writing.', 'Renewal is on hold until then.'],
  },
  negotiation: {
    summary: (contact) =>
      `A negotiation call with ${contactOr(contact, 'the other side')}. Both sides want to close, but ` +
      `the number moved less than expected and one term is still unresolved.`,
    keyDecisions: ['They will not go above the figure they named today.'],
    commitments: () => [
      {
        id: createId('commitment'),
        owner: 'you',
        person: '',
        what: 'Come back with a final position',
        when: 'Monday',
      },
    ],
    tasks: ['Decide the walk-away number', 'Reply with the final position'],
    suggestedMessage: (contact) =>
      `Thanks for the conversation today. I have thought about the number we discussed and I will ` +
      `come back to you on Monday with a final position.`,
    people: (contact) => [{ id: createId('person'), name: contactOr(contact, 'Unknown'), context: 'Decision maker' }],
    openQuestions: ['Is the unresolved term actually negotiable, or a line for them?'],
    risks: [{ id: createId('risk'), label: 'Fixed position', detail: 'They stated a ceiling and did not move.' }],
    tone: { label: 'Businesslike, firm', note: 'Polite but positional on the number.' },
    relationship: 'Transactional. Both sides are protecting their position.',
    reminders: ['You promised a final position by Monday.', 'Do not move below your walk-away number.'],
  },
  meeting: {
    summary: (contact) =>
      `A working meeting with ${contactOr(contact, 'the team')}. The group agreed the plan but left ` +
      `two items without an owner, which is the main thing to close.`,
    keyDecisions: ['The plan was agreed as presented; no changes to scope.'],
    commitments: () => [
      {
        id: createId('commitment'),
        owner: 'you',
        person: '',
        what: 'Circulate the notes with owners against every open item',
        when: 'today',
      },
    ],
    tasks: ['Assign owners to the two open items', 'Share the meeting notes'],
    suggestedMessage: () =>
      `Thanks everyone. Notes are going out today with an owner against each item — please shout if ` +
      `I have anyone wrong.`,
    people: () => [],
    openQuestions: ['Who owns the two items that were left open?'],
    risks: [{ id: createId('risk'), label: 'No owners', detail: 'Two items were agreed without anyone named.' }],
    tone: { label: 'Constructive', note: 'Collaborative and quick; low friction.' },
    relationship: 'Internal and easy. Agreement came quickly.',
    reminders: ['Send the notes with owners today.'],
  },
  difficult: {
    summary: (contact) =>
      `A difficult conversation with ${contactOr(contact, 'the other person')}. The issue was raised ` +
      `and heard, but it was not fully resolved, and one point was left to follow up.`,
    keyDecisions: ['A follow-up conversation was agreed, rather than resolving it on this call.'],
    commitments: () => [
      {
        id: createId('commitment'),
        owner: 'you',
        person: '',
        what: 'Follow up on the one point left open',
        when: 'this week',
      },
    ],
    tasks: ['Follow up on the open point', 'Write down what you will do differently'],
    suggestedMessage: (contact) =>
      `Thank you for talking it through with me. I want to come back to the point we left open, ` +
      `and I will do that this week.`,
    people: (contact) => [{ id: createId('person'), name: contactOr(contact, 'Unknown'), context: 'On the call' }],
    openQuestions: ['What does a good outcome look like for them?'],
    risks: [{ id: createId('risk'), label: 'Unresolved', detail: 'One point was deferred, not settled.' }],
    tone: { label: 'Tense, then calmer', note: 'It defused, but the middle of the call was hard.' },
    relationship: 'Needs repair. Honesty helped; leaving it here would not.',
    reminders: ['You promised to follow up this week.'],
  },
  other: {
    summary: (contact) =>
      `A conversation with ${contactOr(contact, 'the other person')}. A few concrete points were ` +
      `agreed, and one follow-up was promised.`,
    keyDecisions: ['Both sides agreed to pick this up again after the follow-up.'],
    commitments: () => [
      {
        id: createId('commitment'),
        owner: 'you',
        person: '',
        what: 'Follow up on what was discussed',
        when: '',
      },
    ],
    tasks: ['Follow up on the next step'],
    suggestedMessage: () => `Thanks for the conversation. I will follow up as we discussed.`,
    people: (contact) => [{ id: createId('person'), name: contactOr(contact, 'Unknown'), context: 'On the call' }],
    openQuestions: ['What is the next step they expect from you?'],
    risks: [{ id: createId('risk'), label: 'Nothing written down', detail: 'No owner was named for the follow-up.' }],
    tone: { label: 'Neutral', note: 'Even and low-key throughout.' },
    relationship: 'Unclear from this call alone.',
    reminders: ['You promised a follow-up.'],
  },
};

/**
 * Builds a debrief for a confirmed draft, offline and deterministically.
 *
 * `origin: 'demo'` and `degraded: true` are not decoration: the debrief screen
 * uses them to tell the user this analysis did not come from their audio.
 */
export function createDemoDebrief(draft: DebriefDraft, reason?: string): Debrief {
  const template = TEMPLATES[draft.callType] ?? TEMPLATES.other;

  return {
    id: createId('debrief'),
    title: draft.title,
    contact: draft.contact,
    callType: draft.callType,
    recordedAt: draft.recordedAt,
    importedAt: new Date().toISOString(),
    durationMs: draft.durationMs,
    audio: draft.audio,
    transcript: null,
    summary: template.summary(draft.contact),
    keyDecisions: [...template.keyDecisions],
    commitments: template.commitments(draft.contact),
    tasks: template.tasks.map((title) => ({
      id: createId('task'),
      title,
      done: false,
      dueAt: null,
      calendarEventId: null,
    })),
    suggestedMessage: template.suggestedMessage(draft.contact),
    people: template.people(draft.contact),
    openQuestions: [...template.openQuestions],
    risks: template.risks,
    tone: { ...template.tone },
    relationship: template.relationship,
    reminders: [...template.reminders],
    origin: 'demo',
    degraded: true,
    consentAt: draft.consentAt,
  };
}

/** Why the demo path was used, phrased for the user. */
export function describeDemoReason(reason: 'unconfigured' | 'failed'): string {
  return reason === 'unconfigured'
    ? 'This is a demo debrief: no analysis backend is configured, so Psst used its offline example. Your recording was not uploaded anywhere.'
    : 'This is a demo debrief: the analysis backend could not be reached, so Psst used its offline example. Your recording stayed on this device.';
}

interface SeedDefinition {
  callType: CallType;
  daysAgo: number;
  hour: number;
  minute: number;
  durationMinutes: number;
  title: string;
  contact: string;
}

const SEEDS: SeedDefinition[] = [
  { callType: 'sales', daysAgo: 0, hour: 14, minute: 20, durationMinutes: 31, title: 'Example: Acme pilot call', contact: 'Priya Raman' },
  { callType: 'negotiation', daysAgo: 1, hour: 9, minute: 45, durationMinutes: 22, title: 'Example: Salary negotiation', contact: 'Dana Whitfield' },
  { callType: 'customer', daysAgo: 3, hour: 16, minute: 5, durationMinutes: 47, title: 'Example: Northwind renewal', contact: 'Sam Okafor' },
];

/**
 * Three worked examples for a first run, so the timeline and search are
 * demonstrable before the user imports anything. No audio: these are examples,
 * not recordings.
 */
export function createSeedDebriefs(now: Date = new Date()): Debrief[] {
  return SEEDS.map((seed) => {
    const recordedAt = new Date(now);
    recordedAt.setDate(recordedAt.getDate() - seed.daysAgo);
    recordedAt.setHours(seed.hour, seed.minute, 0, 0);

    const draft: DebriefDraft = {
      title: seed.title,
      contact: seed.contact,
      callType: seed.callType,
      recordedAt: recordedAt.toISOString(),
      durationMs: seed.durationMinutes * 60_000,
      // Example content has no source audio to keep or delete.
      audio: { uri: '', fileName: '', bytes: 0, mimeType: '' },
      consentAt: recordedAt.toISOString(),
    };

    const debrief = createDemoDebrief(draft);
    return { ...debrief, id: `seed-${seed.callType}`, audio: null };
  }).sort((a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime());
}
