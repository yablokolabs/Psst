/**
 * Sarvam reasoning provider — the Psst "brain".
 *
 * Psst is NOT a chatbot answering the conversation for the user. The engine has
 * exactly two outcomes, NO_ACTION or PSST, and most conversational moments must
 * produce NO_ACTION. This provider only decides whether there is a genuinely
 * useful moment to intervene, and if so, returns one very short cue.
 *
 * SARVAM_API_KEY is a server-side secret. It is read here, sent to Sarvam as the
 * `api-subscription-key` header, and never reaches the app or any log.
 *
 * Transport (verified against the published API reference):
 *   POST https://api.sarvam.ai/v1/chat/completions
 *   header: api-subscription-key
 *   body:   { model, messages, temperature, max_tokens, response_format }
 *   structured output: response_format.json_schema (strict)
 *
 * Anything malformed, slow or low-confidence degrades to NO_ACTION. A live
 * conversation is never interrupted because reasoning failed.
 */

import { loadServerEnv } from './env.js';
import { OUTCOME } from './outcome.js';

loadServerEnv();

const DEFAULT_ENDPOINT = 'https://api.sarvam.ai/v1/chat/completions';
/** Conversational workhorse model (32K context, built for realtime voice agents). */
const DEFAULT_MODEL = 'sarvam-105b-conversations';
const DEFAULT_TIMEOUT_MS = 8000;
/** Cues below this confidence are treated as noise. */
const MIN_CONFIDENCE = 0.55;
/** A cue must be readable at a glance mid-sentence. */
const MAX_CUE_CHARS = 110;

export { OUTCOME };

export function getSarvamApiKey() {
  return process.env.SARVAM_API_KEY ?? '';
}

export function isSarvamConfigured() {
  // Boolean only: never the key, never its length.
  return getSarvamApiKey().length > 0;
}

export function getSarvamConfig() {
  return {
    endpoint: process.env.SARVAM_ENDPOINT ?? DEFAULT_ENDPOINT,
    model: process.env.SARVAM_MODEL ?? DEFAULT_MODEL,
    // Low effort by default: a cue that arrives late is useless in a live
    // conversation. Raise it via SARVAM_REASONING_EFFORT if quality matters more.
    reasoningEffort: process.env.SARVAM_REASONING_EFFORT ?? 'low',
    timeoutMs: Number(process.env.SARVAM_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
  };
}

const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: [OUTCOME.NO_ACTION, OUTCOME.PSST],
      description: 'PSST only when interrupting is genuinely worth it; otherwise NO_ACTION.',
    },
    observation: {
      type: 'string',
      description:
        'Max 10 words, a plain statement of what was noticed. Empty string when action is NO_ACTION.',
    },
    suggestion: {
      type: 'string',
      description:
        'Max 10 words, an imperative for what to say or ask next. Empty string when action is NO_ACTION.',
    },
    confidence: {
      type: 'number',
      description: '0 to 1. Below 0.55 the cue is ignored.',
    },
  },
  required: ['action', 'observation', 'suggestion', 'confidence'],
  additionalProperties: false,
};

const RECAP_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Two or three sentences, plain and factual.' },
    keyPoints: { type: 'array', items: { type: 'string' } },
    commitments: { type: 'array', items: { type: 'string' } },
    missed: { type: 'array', items: { type: 'string' } },
    nextActions: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'keyPoints', 'commitments', 'missed', 'nextActions'],
  additionalProperties: false,
};

const DECISION_SYSTEM_PROMPT = [
  "You are the reasoning engine inside Psst, a private real-time conversation copilot.",
  'You are NOT a chatbot and you never answer the conversation for the user.',
  'You silently watch a live conversation and decide whether there is a genuinely useful moment to intervene.',
  '',
  'You have exactly two possible outcomes:',
  'NO_ACTION - the default. Most utterances deserve this. Silence is a feature.',
  'PSST - only when the user would clearly benefit from a short prompt right now.',
  '',
  'Choose PSST only for moments like: a missed opportunity, an important question left unanswered,',
  'an objection, a contradiction, a commitment made, a deadline, an important price or number,',
  'a negotiation opening, the user forgetting their own stated goal, or a clarification that unlocks progress.',
  'If the line is small talk, filler, or simply restates what is already known, answer NO_ACTION.',
  '',
  'When you do choose PSST:',
  '- observation: at most 10 words. A flat statement of the situation. Not advice, not a question.',
  '- suggestion: at most 10 words. An imperative the user can act on instantly.',
  '- Never repeat or paraphrase a cue that was already given. If your best idea is already on the list, answer NO_ACTION.',
  '- Never write paragraphs, explanations or pleasantries.',
  '',
  'Reply with JSON only.',
].join('\n');

function clamp(text, max) {
  const value = typeof text === 'string' ? text.trim().replace(/\s+/g, ' ') : '';
  if (value.length <= max) return value;
  // Cut on a word boundary so a long cue degrades into a shorter readable one.
  const clipped = value.slice(0, max);
  const lastSpace = clipped.lastIndexOf(' ');
  return `${(lastSpace > max * 0.5 ? clipped.slice(0, lastSpace) : clipped).replace(/[,;:.]$/, '')}…`;
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Formats the final transcript as a compact, recent-first-friendly dialogue. */
function formatDialogue(transcript, limit = 14) {
  const lines = transcript.slice(-limit);
  const offset = transcript.length - lines.length;
  return lines
    .map((entry, index) => `${offset + index + 1}. ${entry.speaker === 'you' ? 'User' : 'Them'}: ${entry.text}`)
    .join('\n');
}

function summarizeGoal(goal) {
  if (!goal) return 'No goal was set.';
  const parts = [`Title: ${goal.title || 'Untitled'}`];
  if (goal.objective) parts.push(`Objective: ${goal.objective}`);
  if (goal.notes) parts.push(`Do not forget: ${goal.notes}`);
  if (goal.preset) parts.push(`Conversation type: ${goal.preset}`);
  return parts.join('\n');
}

export class SarvamReasoningProvider {
  /** Identifies the provider in logs and diagnostics. */
  kind = 'sarvam';

  /** @param {{ apiKey?: string, fetchImpl?: typeof fetch }} [options] */
  constructor(options = {}) {
    this.apiKey = options.apiKey ?? getSarvamApiKey();
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.config = getSarvamConfig();
  }

  isConfigured() {
    return typeof this.apiKey === 'string' && this.apiKey.length > 0;
  }

  /**
   * One structured completion. Returns the parsed JSON object, or null when the
   * provider is unavailable, slow, or returned something unusable.
   */
  async complete({ system, user, schema, schemaName, maxTokens }) {
    if (!this.isConfigured()) return null;
    if (typeof this.fetchImpl !== 'function') return null;

    let response;
    try {
      response = await this.fetchImpl(this.config.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'api-subscription-key': this.apiKey,
        },
        signal: AbortSignal.timeout(this.config.timeoutMs),
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0.2,
          max_tokens: maxTokens,
          reasoning_effort: this.config.reasoningEffort,
          response_format: {
            type: 'json_schema',
            json_schema: { name: schemaName, schema, strict: true },
          },
        }),
      });
    } catch (error) {
      // Timeouts and network loss are expected failure modes, not exceptions.
      return { error: describe(error) };
    }

    if (!response.ok) {
      return { error: `Sarvam returned HTTP ${response.status}` };
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      return { error: 'Sarvam returned a non-JSON response' };
    }

    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      return { error: 'Sarvam returned an empty completion' };
    }

    try {
      return { data: JSON.parse(content) };
    } catch {
      return { error: 'Sarvam returned invalid JSON' };
    }
  }

  /**
   * Decides NO_ACTION or PSST for the latest committed utterance.
   *
   * @param {{ goal: object, transcript: Array<object>, latest: object, recentCues: Array<object> }} context
   * @returns {Promise<{ outcome: string, cue?: { observation: string, suggestion: string, confidence: number }, error?: string, skipped?: string }>}
   */
  async evaluate({ goal, transcript, latest, recentCues = [] }) {
    if (!this.isConfigured()) {
      return { outcome: OUTCOME.NO_ACTION, skipped: 'sarvam-not-configured' };
    }

    const cueHistory =
      recentCues.length === 0
        ? 'None yet.'
        : recentCues.map((cue) => `- ${cue.observation} / ${cue.action}`).join('\n');

    const user = [
      '# User goal',
      summarizeGoal(goal),
      '',
      '# Conversation so far (most recent last)',
      formatDialogue(transcript),
      '',
      '# Cues already shown to the user',
      cueHistory,
      '',
      '# Latest utterance',
      latest?.text ?? '',
      '',
      'Decide the next action now.',
    ].join('\n');

    const result = await this.complete({
      system: DECISION_SYSTEM_PROMPT,
      user,
      schema: DECISION_SCHEMA,
      schemaName: 'psst_decision',
      maxTokens: 200,
    });

    if (!result || result.error || !result.data) {
      return { outcome: OUTCOME.NO_ACTION, error: result?.error ?? 'no-decision' };
    }

    return this.normalizeDecision(result.data);
  }

  /** Defensive validation: anything questionable becomes NO_ACTION. */
  normalizeDecision(data) {
    if (typeof data !== 'object' || data === null) {
      return { outcome: OUTCOME.NO_ACTION, error: 'malformed-decision' };
    }

    if (data.action !== OUTCOME.PSST) {
      return { outcome: OUTCOME.NO_ACTION };
    }

    const observation = clamp(data.observation, MAX_CUE_CHARS);
    const suggestion = clamp(data.suggestion, MAX_CUE_CHARS);
    const confidence = typeof data.confidence === 'number' ? data.confidence : 0;

    if (observation === '' || suggestion === '') {
      return { outcome: OUTCOME.NO_ACTION, error: 'incomplete-cue' };
    }
    if (confidence < MIN_CONFIDENCE) {
      return { outcome: OUTCOME.NO_ACTION, error: 'low-confidence' };
    }

    return {
      outcome: OUTCOME.PSST,
      cue: { observation, suggestion, confidence },
    };
  }

  /**
   * Optional model-written recap. Returns null on any failure so the caller can
   * fall back to the transcript-derived recap: a session is never lost because
   * summarisation failed.
   */
  async summarize({ goal, transcript, cues, durationMs }) {
    if (!this.isConfigured() || transcript.length === 0) return null;

    const user = [
      '# User goal',
      summarizeGoal(goal),
      '',
      `# Duration\n${Math.round(durationMs / 1000)} seconds, ${cues.length} cue(s) shown.`,
      '',
      '# Transcript',
      formatDialogue(transcript, 60),
      '',
      'Summarise what happened for the user. Be factual and specific: quote numbers and',
      'commitments exactly as spoken. Never invent details that were not said.',
    ].join('\n');

    const result = await this.complete({
      system:
        'You summarise a finished private conversation for the person who took part in it. ' +
        'Reply with JSON only. Use plain language, no filler, no advice beyond concrete next actions.',
      user,
      schema: RECAP_SCHEMA,
      schemaName: 'psst_recap',
      maxTokens: 900,
    });

    if (!result || result.error || !result.data) return null;

    const data = result.data;
    const asList = (value) =>
      Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim() !== '') : [];

    if (typeof data.summary !== 'string' || data.summary.trim() === '') return null;

    return {
      summary: data.summary.trim(),
      keyPoints: asList(data.keyPoints),
      commitments: asList(data.commitments),
      missed: asList(data.missed),
      nextActions: asList(data.nextActions),
    };
  }
}
