/**
 * Row mapping and search for the debrief store.
 *
 * Kept separate from the SQLite calls so the shape of the data — and the search
 * matching — can be tested in plain Node, where there is no database.
 *
 * The whole debrief is stored as JSON in `payload`, alongside the few columns
 * the timeline sorts and searches on. That keeps the schema migration-free while
 * the debrief shape is still moving, without giving up a real query for the list
 * and the search box.
 */

import type { CallType, Debrief, DebriefOrigin } from '@/types/debrief';
import { DEFAULT_CALL_TYPE, isCallType } from '@/constants/callTypes';

export interface DebriefRow {
  id: string;
  recorded_at: string;
  imported_at: string;
  title: string;
  contact: string;
  call_type: string;
  summary: string;
  origin: string;
  payload: string;
}

export const DEBRIEF_SCHEMA = `
CREATE TABLE IF NOT EXISTS debriefs (
  id TEXT PRIMARY KEY NOT NULL,
  recorded_at TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  title TEXT NOT NULL,
  contact TEXT NOT NULL DEFAULT '',
  call_type TEXT NOT NULL DEFAULT 'other',
  summary TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT 'backend',
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS debriefs_recorded_at_idx ON debriefs (recorded_at DESC);
`;

export function toDebriefRow(debrief: Debrief): DebriefRow {
  return {
    id: debrief.id,
    recorded_at: debrief.recordedAt,
    imported_at: debrief.importedAt,
    title: debrief.title,
    contact: debrief.contact,
    call_type: debrief.callType,
    summary: debrief.summary,
    origin: debrief.origin,
    payload: JSON.stringify(debrief),
  };
}

/**
 * Rebuilds a debrief from its stored row.
 *
 * A row that cannot be parsed is reported as null rather than throwing: one
 * corrupted row must not make the whole timeline unopenable.
 */
export function fromDebriefRow(row: DebriefRow | null | undefined): Debrief | null {
  if (!row || typeof row.payload !== 'string') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const value = parsed as Partial<Debrief>;
  if (typeof value.id !== 'string' || value.id === '') return null;

  const callType: CallType = isCallType(value.callType) ? value.callType : DEFAULT_CALL_TYPE;
  const origin: DebriefOrigin = value.origin === 'demo' ? 'demo' : 'backend';

  return {
    id: value.id,
    title: typeof value.title === 'string' ? value.title : 'Call recording',
    contact: typeof value.contact === 'string' ? value.contact : '',
    callType,
    // The indexed column wins: it is what the timeline was sorted by.
    recordedAt: row.recorded_at || (typeof value.recordedAt === 'string' ? value.recordedAt : ''),
    importedAt: row.imported_at || (typeof value.importedAt === 'string' ? value.importedAt : ''),
    durationMs: typeof value.durationMs === 'number' ? value.durationMs : 0,
    audio: value.audio ?? null,
    transcript: value.transcript ?? null,
    summary: typeof value.summary === 'string' ? value.summary : '',
    keyDecisions: Array.isArray(value.keyDecisions) ? value.keyDecisions : [],
    commitments: Array.isArray(value.commitments) ? value.commitments : [],
    tasks: Array.isArray(value.tasks) ? value.tasks : [],
    suggestedMessage: typeof value.suggestedMessage === 'string' ? value.suggestedMessage : '',
    people: Array.isArray(value.people) ? value.people : [],
    openQuestions: Array.isArray(value.openQuestions) ? value.openQuestions : [],
    risks: Array.isArray(value.risks) ? value.risks : [],
    tone: value.tone ?? { label: '', note: '' },
    relationship: typeof value.relationship === 'string' ? value.relationship : '',
    reminders: Array.isArray(value.reminders) ? value.reminders : [],
    origin,
    degraded: value.degraded === true,
    consentAt: typeof value.consentAt === 'string' ? value.consentAt : '',
  };
}

/** Escapes the LIKE wildcards so a search for "50%" does not match everything. */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * The search predicate over the stored row.
 *
 * Searching `payload` too means a match inside a task or a person's name is
 * found, which is what a user means when they search a memory product.
 */
export const DEBRIEF_SEARCH_SQL = `SELECT * FROM debriefs
  WHERE title LIKE ? ESCAPE '\\'
     OR contact LIKE ? ESCAPE '\\'
     OR summary LIKE ? ESCAPE '\\'
     OR payload LIKE ? ESCAPE '\\'
  ORDER BY recorded_at DESC`;

export function buildSearchParams(term: string): string[] {
  const pattern = `%${escapeLike(term.trim())}%`;
  return [pattern, pattern, pattern, pattern];
}

/** In-memory equivalent of the SQL search, used for already-loaded lists. */
export function matchesSearch(debrief: Debrief, term: string): boolean {
  const needle = term.trim().toLowerCase();
  if (needle === '') return true;

  const haystack = [
    debrief.title,
    debrief.contact,
    debrief.summary,
    debrief.relationship,
    debrief.suggestedMessage,
    ...debrief.keyDecisions,
    ...debrief.openQuestions,
    ...debrief.reminders,
    ...debrief.commitments.map((commitment) => `${commitment.person} ${commitment.what} ${commitment.when}`),
    ...debrief.tasks.map((task) => task.title),
    ...debrief.people.map((person) => `${person.name} ${person.context}`),
    ...debrief.risks.map((risk) => `${risk.label} ${risk.detail}`),
  ]
    .join('\n')
    .toLowerCase();

  return haystack.includes(needle);
}

export function sortByRecordedAt(debriefs: Debrief[]): Debrief[] {
  return [...debriefs].sort((a, b) => {
    const left = new Date(b.recordedAt).getTime();
    const right = new Date(a.recordedAt).getTime();
    if (Number.isNaN(left) || Number.isNaN(right)) return 0;
    return left - right;
  });
}
