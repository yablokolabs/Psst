/**
 * The Psst Debrief: what a finished recording becomes.
 *
 * This is a different job from the live cue engine. Nothing here is real-time
 * and nothing interrupts anyone: the call is over, and the value is in what
 * survives it — what was decided, who owes what by when, and what the user
 * promised without noticing.
 *
 * One structured completion against the same reasoning provider the cues used.
 * The model is instructed never to invent a fact, and every field is validated
 * and clamped afterwards, because a debrief that confidently invents a deadline
 * is worse than a debrief with an empty section.
 */

import { OUTCOME } from './outcome.js';

export { OUTCOME };

/** Caps that keep one hostile or verbose answer from bloating the response. */
const MAX_ITEMS = 20;
const MAX_TEXT_CHARS = 400;
const MAX_SUMMARY_CHARS = 1600;
/** Transcript characters handed to the model. */
const MAX_TRANSCRIPT_CHARS = 24000;
/** Characters per transcript line before it is clipped. */
const MAX_LINE_CHARS = 500;

export const DEBRIEF_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description:
        'Two or three sentences describing what this call was and how it went. Factual, no advice.',
    },
    keyDecisions: {
      type: 'array',
      description: 'Decisions actually made on the call. Empty array if none were made.',
      items: { type: 'string' },
    },
    commitments: {
      type: 'array',
      description: 'Promises made by anyone on the call. Empty array if none.',
      items: {
        type: 'object',
        properties: {
          owner: {
            type: 'string',
            enum: ['you', 'them', 'unknown'],
            description:
              'Who owes it. Use unknown when the transcript does not make it clear which voice is which.',
          },
          person: { type: 'string', description: 'Named person, or empty string.' },
          what: { type: 'string', description: 'What was promised, in their own terms.' },
          when: {
            type: 'string',
            description:
              'Deadline exactly as spoken ("Friday", "end of the month"), or empty string if none was said.',
          },
        },
        required: ['owner', 'person', 'what', 'when'],
        additionalProperties: false,
      },
    },
    tasks: {
      type: 'array',
      description: 'Concrete follow-ups the user should do next. Empty array if none.',
      items: { type: 'string' },
    },
    suggestedMessage: {
      type: 'string',
      description:
        'A short, ready-to-send follow-up message in the user\'s voice. Empty string if there is nothing to follow up.',
    },
    people: {
      type: 'array',
      description: 'People named on the call and why they matter. Empty array if none.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          context: { type: 'string', description: 'Their role, or what they own.' },
        },
        required: ['name', 'context'],
        additionalProperties: false,
      },
    },
    openQuestions: {
      type: 'array',
      description: 'Questions left unanswered. Empty array if none.',
      items: { type: 'string' },
    },
    risks: {
      type: 'array',
      description: 'Objections, red flags or things that could go wrong. Empty array if none.',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Two to four words.' },
          detail: { type: 'string', description: 'One line of detail from the call.' },
        },
        required: ['label', 'detail'],
        additionalProperties: false,
      },
    },
    tone: {
      type: 'object',
      description: 'How the conversation felt.',
      properties: {
        label: { type: 'string', description: 'Two or three words.' },
        note: { type: 'string', description: 'One short sentence.' },
      },
      required: ['label', 'note'],
      additionalProperties: false,
    },
    relationship: {
      type: 'string',
      description: 'One sentence on the state of this relationship after the call.',
    },
    reminders: {
      type: 'array',
      description:
        'Plain promises worth being reminded about, phrased to the user ("You promised to send the deck Friday"). Empty array if none.',
      items: { type: 'string' },
    },
  },
  required: [
    'summary',
    'keyDecisions',
    'commitments',
    'tasks',
    'suggestedMessage',
    'people',
    'openQuestions',
    'risks',
    'tone',
    'relationship',
    'reminders',
  ],
  additionalProperties: false,
};

const DEBRIEF_SYSTEM_PROMPT = [
  'You write the debrief of a finished conversation for the person who took part in it.',
  'The recording was made by that person or given to them, and they will read this afterwards.',
  '',
  'Rules that matter more than completeness:',
  '- Never invent a fact. If the transcript does not contain something, use an empty array or empty string.',
  '- Quote names, numbers, prices and deadlines exactly as they were said.',
  '- The transcript labels voices as Speaker 1, Speaker 2. These labels do NOT tell you which voice is',
  '  the user, so never assert who said something unless the words themselves make it unambiguous.',
  '  When a commitment\'s owner cannot be determined, use "unknown".',
  '- Write plainly and concretely. No filler, no motivational language, no advice beyond a follow-up.',
  '- The follow-up message is written in the user\'s own voice, short enough to send as-is.',
  '- Reminders are promises and nudges in the second person ("You promised…"), one line each.',
  'Reply with JSON only.',
].join('\n');

function clip(text, max) {
  if (typeof text !== 'string') return '';
  const value = text.trim().replace(/\s+/g, ' ');
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

/** The transcript, formatted for the prompt within a fixed character budget. */
export function formatTranscriptForPrompt(transcript, budget = MAX_TRANSCRIPT_CHARS) {
  if (!Array.isArray(transcript) || transcript.length === 0) return '(no speech was detected)';

  const lines = transcript.map((line) => {
    const label = line?.label ? `${line.label}: ` : '';
    return `${label}${clip(line?.text, MAX_LINE_CHARS)}`;
  });

  // Keep the most recent part when the call is longer than the budget: the end
  // of a call is where commitments and next steps are usually agreed.
  let total = 0;
  const kept = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    total += lines[index].length + 1;
    if (total > budget) break;
    kept.unshift(lines[index]);
  }

  const omitted = lines.length - kept.length;
  return omitted > 0
    ? `(${omitted} earlier line(s) omitted)\n${kept.join('\n')}`
    : kept.join('\n');
}

/** The user context that is already known, so the model does not have to guess it. */
export function summarizeContext(draft = {}) {
  const parts = [`Title: ${draft.title || 'Untitled call'}`];
  if (draft.contact) parts.push(`With: ${draft.contact}`);
  if (draft.callType) parts.push(`Call type the user chose: ${draft.callType}`);
  if (Number.isFinite(draft.durationMs) && draft.durationMs > 0) {
    parts.push(`Recording length: ${Math.round(draft.durationMs / 1000)} seconds`);
  }
  return parts.join('\n');
}

function asStringList(value, limit = MAX_ITEMS) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const text = clip(item, MAX_TEXT_CHARS);
    if (text !== '') out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Validates the model's answer.
 *
 * Every branch degrades to an empty value rather than throwing: a partially
 * usable debrief still helps, and the caller reports `degraded` when the summary
 * is missing entirely.
 */
export function normalizeDebrief(data) {
  const source = typeof data === 'object' && data !== null ? data : {};
  const tone = typeof source.tone === 'object' && source.tone !== null ? source.tone : {};

  const commitments = Array.isArray(source.commitments)
    ? source.commitments
        .map((item) => {
          const value = typeof item === 'object' && item !== null ? item : {};
          const what = clip(value.what, MAX_TEXT_CHARS);
          if (what === '') return null;
          return {
            owner: ['you', 'them'].includes(value.owner) ? value.owner : 'unknown',
            person: clip(value.person, 120),
            what,
            when: clip(value.when, 120),
          };
        })
        .filter(Boolean)
        .slice(0, MAX_ITEMS)
    : [];

  const people = Array.isArray(source.people)
    ? source.people
        .map((item) => {
          const value = typeof item === 'object' && item !== null ? item : {};
          const name = clip(value.name, 120);
          if (name === '') return null;
          return { name, context: clip(value.context, MAX_TEXT_CHARS) };
        })
        .filter(Boolean)
        .slice(0, MAX_ITEMS)
    : [];

  const risks = Array.isArray(source.risks)
    ? source.risks
        .map((item) => {
          const value = typeof item === 'object' && item !== null ? item : {};
          const label = clip(value.label, 80) || clip(value.detail, 80);
          if (label === '') return null;
          return { label, detail: clip(value.detail, MAX_TEXT_CHARS) };
        })
        .filter(Boolean)
        .slice(0, MAX_ITEMS)
    : [];

  return {
    summary: clip(source.summary, MAX_SUMMARY_CHARS),
    keyDecisions: asStringList(source.keyDecisions),
    commitments,
    tasks: asStringList(source.tasks),
    suggestedMessage: clip(source.suggestedMessage, 800),
    people,
    openQuestions: asStringList(source.openQuestions),
    risks,
    tone: { label: clip(tone.label, 60), note: clip(tone.note, MAX_TEXT_CHARS) },
    relationship: clip(source.relationship, MAX_TEXT_CHARS),
    reminders: asStringList(source.reminders),
  };
}

/** An empty debrief, used when the summary could not be produced. */
export function emptyDebrief() {
  return {
    summary: '',
    keyDecisions: [],
    commitments: [],
    tasks: [],
    suggestedMessage: '',
    people: [],
    openQuestions: [],
    risks: [],
    tone: { label: '', note: '' },
    relationship: '',
    reminders: [],
  };
}

/**
 * Turns a transcript into a debrief.
 *
 * @returns {Promise<{ debrief: object, degraded: boolean, notice: string|null, error?: string }>}
 */
export async function buildDebrief({ draft, transcript, provider, fetchImpl }) {
  if (!provider || typeof provider.complete !== 'function') {
    return {
      debrief: emptyDebrief(),
      degraded: true,
      notice: 'Psst transcribed this recording, but no analysis model is configured on the backend, so no summary was written.',
      error: 'no-reasoning-provider',
    };
  }

  const user = [
    '# Known context',
    summarizeContext(draft),
    '',
    '# Transcript',
    formatTranscriptForPrompt(transcript),
    '',
    'Write the debrief now. Use empty values for anything the transcript does not contain.',
  ].join('\n');

  const result = await provider.complete({
    system: DEBRIEF_SYSTEM_PROMPT,
    user,
    schema: DEBRIEF_SCHEMA,
    schemaName: 'psst_debrief',
    maxTokens: 2200,
    ...(fetchImpl ? { fetchImpl } : {}),
  });

  if (!result || result.error || !result.data) {
    return {
      debrief: emptyDebrief(),
      degraded: true,
      notice: 'Psst transcribed this recording, but the analysis step did not return a summary.',
      error: result?.error ?? 'no-debrief',
    };
  }

  const debrief = normalizeDebrief(result.data);
  return {
    debrief,
    degraded: debrief.summary === '',
    notice:
      debrief.summary === ''
        ? 'Psst transcribed this recording, but the analysis step did not return a summary.'
        : null,
  };
}
