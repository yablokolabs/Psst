/**
 * Psst domain types — debrief edition.
 *
 * Psst is not a call recorder and it never captures a phone call. The user
 * records a call somewhere else, then imports the audio file. Psst turns that
 * recording into a Debrief: the memory, follow-through and relationship layer
 * that survives after the call.
 *
 * Everything here is produced from a file the user chose to share, and every
 * field is editable afterwards — a debrief is a draft the user owns, not a
 * verdict from a model.
 */

/** The kind of call. Reuses the preset vocabulary the app already had. */
export type CallType = 'negotiation' | 'sales' | 'customer' | 'meeting' | 'difficult' | 'other';

/** Who owes the commitment. `unknown` is used when the transcript is unclear. */
export type CommitmentOwner = 'you' | 'them' | 'unknown';

export interface DebriefCommitment {
  id: string;
  owner: CommitmentOwner;
  /** Named person, when the call named one. */
  person: string;
  /** What was promised, in the speaker's own terms. */
  what: string;
  /** Deadline exactly as it was said ("Friday", "end of the month"), or ''. */
  when: string;
}

/** A follow-up the user can tick off. */
export interface DebriefTask {
  id: string;
  title: string;
  done: boolean;
  /** ISO date the user set, or null. */
  dueAt: string | null;
  /** Calendar event id once a reminder has been created, else null. */
  calendarEventId: string | null;
}

export interface PersonMention {
  id: string;
  name: string;
  /** Why they came up: their role, a decision they own, what was promised. */
  context: string;
}

export interface DebriefRisk {
  id: string;
  /** Short label, e.g. "Pricing objection". */
  label: string;
  /** One line of detail from the call. */
  detail: string;
}

/** How the conversation felt, kept deliberately separate from the facts. */
export interface DebriefTone {
  label: string;
  note: string;
}

/**
 * The imported source audio. `null` on a `Debrief` means the user deleted the
 * recording (the debrief stays).
 */
export interface DebriefAudio {
  /** Local file URI inside the app's own storage. */
  uri: string;
  fileName: string;
  bytes: number;
  mimeType: string;
}

export type TranscriptSpeaker = 'you' | 'them' | 'unknown';

export interface TranscriptLine {
  id: string;
  speaker: TranscriptSpeaker;
  /**
   * The provider's diarization label ("Speaker 1"). A recording cannot tell Psst
   * which voice is the user, so the label is shown rather than pretended away.
   */
  label: string;
  text: string;
  /** Milliseconds from the start of the recording. */
  at: number;
}

/** Where the debrief text came from, so the UI never overstates it. */
export type DebriefOrigin = 'backend' | 'demo';

export interface Debrief {
  id: string;
  title: string;
  /** Person or company the call was with. Free text, editable. */
  contact: string;
  callType: CallType;
  /** When the call happened. Prefilled from metadata, always editable. */
  recordedAt: string;
  importedAt: string;
  durationMs: number;
  audio: DebriefAudio | null;
  /** `null` when the user deleted the transcript. */
  transcript: TranscriptLine[] | null;
  summary: string;
  keyDecisions: string[];
  commitments: DebriefCommitment[];
  tasks: DebriefTask[];
  /** A ready-to-send follow-up message the user can copy. */
  suggestedMessage: string;
  people: PersonMention[];
  openQuestions: string[];
  risks: DebriefRisk[];
  tone: DebriefTone;
  relationship: string;
  /** The "mom reminders": plain promises worth being reminded about. */
  reminders: string[];
  origin: DebriefOrigin;
  /**
   * True when the analysis was thinner than requested (no model configured, or
   * the provider failed) so the UI can say so instead of pretending.
   */
  degraded: boolean;
  /** When the user acknowledged the consent notice. ISO. */
  consentAt: string;
}

/** Everything the import screen collects before the analysis runs. */
export interface DebriefDraft {
  title: string;
  contact: string;
  callType: CallType;
  recordedAt: string;
  durationMs: number;
  audio: DebriefAudio;
  consentAt: string;
}

/** Fields the user can edit after the fact. */
export type DebriefEdits = Partial<
  Pick<
    Debrief,
    | 'title'
    | 'contact'
    | 'callType'
    | 'recordedAt'
    | 'summary'
    | 'keyDecisions'
    | 'commitments'
    | 'tasks'
    | 'suggestedMessage'
    | 'openQuestions'
    | 'risks'
    | 'reminders'
    | 'relationship'
    | 'transcript'
  >
>;
