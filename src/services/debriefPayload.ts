/**
 * Turns the backend's debrief JSON into the app's `Debrief`.
 *
 * The backend is a remote process and its answer is untrusted input. A missing
 * field here means a missing section on screen, never a crash, so every value is
 * validated and anything unusable degrades to an empty section. Nothing is
 * invented to fill a gap: an absent commitment stays absent.
 */

import { isCallType } from '@/constants/callTypes';
import type {
  Debrief,
  DebriefCommitment,
  DebriefDraft,
  DebriefRisk,
  DebriefTask,
  PersonMention,
  TranscriptLine,
  TranscriptSpeaker,
} from '@/types/debrief';
import { createId } from '@/utils/ids';

export interface DebriefPayload {
  origin?: unknown;
  degraded?: unknown;
  transcript?: unknown;
  debrief?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asStringList(value: unknown, limit = 24): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = asString(item);
    if (text !== '') out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function asSpeaker(value: unknown): TranscriptSpeaker {
  return value === 'you' || value === 'them' ? value : 'unknown';
}

function parseTranscript(value: unknown): TranscriptLine[] | null {
  if (!isRecord(value)) return null;
  const lines = value.lines;
  if (!Array.isArray(lines)) return null;

  const parsed: TranscriptLine[] = [];
  for (const line of lines) {
    if (!isRecord(line)) continue;
    const text = asString(line.text);
    if (text === '') continue;
    const at = typeof line.at === 'number' && Number.isFinite(line.at) ? Math.max(0, line.at) : 0;
    parsed.push({ id: createId('line'), speaker: asSpeaker(line.speaker), label: asString(line.label), text, at });
  }
  return parsed.length > 0 ? parsed : null;
}

function parseCommitments(value: unknown): DebriefCommitment[] {
  if (!Array.isArray(value)) return [];
  const out: DebriefCommitment[] = [];
  for (const item of value) {
    // The model is asked for objects, but a plain sentence still beats losing it.
    if (typeof item === 'string') {
      const what = asString(item);
      if (what !== '') out.push({ id: createId('commitment'), owner: 'unknown', person: '', what, when: '' });
      continue;
    }
    if (!isRecord(item)) continue;
    const what = asString(item.what);
    if (what === '') continue;
    const owner = item.owner === 'you' || item.owner === 'them' ? item.owner : 'unknown';
    out.push({
      id: createId('commitment'),
      owner,
      person: asString(item.person),
      what,
      when: asString(item.when),
    });
    if (out.length >= 24) break;
  }
  return out;
}

function parseTasks(value: unknown): DebriefTask[] {
  if (!Array.isArray(value)) return [];
  const out: DebriefTask[] = [];
  for (const item of value) {
    const title = typeof item === 'string' ? asString(item) : isRecord(item) ? asString(item.title) : '';
    if (title === '') continue;
    out.push({ id: createId('task'), title, done: false, dueAt: null, calendarEventId: null });
    if (out.length >= 24) break;
  }
  return out;
}

function parsePeople(value: unknown): PersonMention[] {
  if (!Array.isArray(value)) return [];
  const out: PersonMention[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      const name = asString(item);
      if (name !== '') out.push({ id: createId('person'), name, context: '' });
      continue;
    }
    if (!isRecord(item)) continue;
    const name = asString(item.name);
    if (name === '') continue;
    out.push({ id: createId('person'), name, context: asString(item.context) });
    if (out.length >= 24) break;
  }
  return out;
}

function parseRisks(value: unknown): DebriefRisk[] {
  if (!Array.isArray(value)) return [];
  const out: DebriefRisk[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      const label = asString(item);
      if (label !== '') out.push({ id: createId('risk'), label, detail: '' });
      continue;
    }
    if (!isRecord(item)) continue;
    const label = asString(item.label) || asString(item.detail);
    if (label === '') continue;
    out.push({ id: createId('risk'), label, detail: asString(item.detail) });
    if (out.length >= 24) break;
  }
  return out;
}

/**
 * Builds the app's `Debrief` from a backend response plus the draft the user
 * confirmed. The draft always wins for audio, dates and consent: those are facts
 * about the user's file, not model output.
 */
export function parseDebriefPayload(payload: DebriefPayload, draft: DebriefDraft): Debrief {
  const body = isRecord(payload?.debrief) ? payload.debrief : {};
  const tone = isRecord(body.tone) ? body.tone : {};
  const hasContent = asString(body.summary) !== '';

  // The backend measures the real length from the transcript; the client's
  // guess from the player is only a fallback.
  const serverDuration = isRecord(payload?.transcript) ? payload.transcript.durationMs : undefined;
  const durationMs =
    typeof serverDuration === 'number' && Number.isFinite(serverDuration) && serverDuration > 0
      ? Math.round(serverDuration)
      : draft.durationMs;

  return {
    id: createId('debrief'),
    title: draft.title,
    contact: draft.contact,
    callType: draft.callType,
    recordedAt: draft.recordedAt,
    importedAt: new Date().toISOString(),
    durationMs,
    audio: draft.audio,
    transcript: parseTranscript(payload?.transcript),
    summary: asString(body.summary),
    keyDecisions: asStringList(body.keyDecisions),
    commitments: parseCommitments(body.commitments),
    tasks: parseTasks(body.tasks),
    suggestedMessage: asString(body.suggestedMessage),
    people: parsePeople(body.people),
    openQuestions: asStringList(body.openQuestions),
    risks: parseRisks(body.risks),
    tone: { label: asString(tone.label), note: asString(tone.note) },
    relationship: asString(body.relationship),
    reminders: asStringList(body.reminders),
    origin: payload?.origin === 'demo' ? 'demo' : 'backend',
    // An empty summary is a real outcome: the provider transcribed but could not
    // summarise. Saying so is better than showing blank sections as if analysed.
    degraded: payload?.degraded === true || !hasContent,
    consentAt: draft.consentAt,
  };
}

/** Sanity check for a call type coming from anywhere but the model. */
export function normalizeCallType(value: unknown, fallback: Debrief['callType']): Debrief['callType'] {
  return isCallType(value) ? value : fallback;
}
