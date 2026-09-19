/**
 * Import metadata helpers.
 *
 * Everything here is pure and offline: it decides whether a picked file is a
 * recording Psst will accept, and guesses the title/contact/date from the file
 * name so the user does not have to type what the file already knows. Every
 * guess is a prefill the user can overwrite in the import screen — nothing here
 * is authoritative, and a guess is never treated as consent.
 */

import {
  MAX_IMPORT_BYTES,
  MAX_IMPORT_DURATION_MS,
  SUPPORTED_AUDIO_EXTENSIONS,
  SUPPORTED_AUDIO_LABEL,
} from '@/constants/limits';

/** The subset of a picked file this module needs. Keeps it testable offline. */
export interface ImportCandidate {
  name: string;
  /** Bytes, when the picker reported them. */
  size?: number;
  mimeType?: string;
}

const EXTENSION_PATTERN = /\.([a-z0-9]+)$/i;

/** Lower-case extension without the dot, or '' when the name has none. */
export function extensionOf(fileName: string): string {
  const match = EXTENSION_PATTERN.exec(fileName ?? '');
  return match ? match[1].toLowerCase() : '';
}

export function isSupportedAudioFile(fileName: string): boolean {
  return (SUPPORTED_AUDIO_EXTENSIONS as readonly string[]).includes(extensionOf(fileName));
}

/** The MIME type to send for an extension, used when the picker reported none. */
export function mimeTypeForExtension(extension: string): string {
  switch (extension.toLowerCase()) {
    case 'm4a':
      return 'audio/mp4';
    case 'mp3':
      return 'audio/mpeg';
    case 'wav':
      return 'audio/wav';
    case 'aac':
      return 'audio/aac';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Reasons a file cannot be analysed, or null when it can.
 *
 * The message is written for the person holding the phone, not for a log: it
 * says which rule was broken and what still works.
 */
export function describeImportProblem(candidate: ImportCandidate): string | null {
  const name = candidate?.name ?? '';
  if (name.trim() === '') return 'That file has no name, so Psst cannot tell what it is.';

  if (!isSupportedAudioFile(name)) {
    return `Psst can only read ${SUPPORTED_AUDIO_LABEL} recordings. That file is ${
      extensionOf(name) === '' ? 'not an audio file' : `.${extensionOf(name)}`
    }.`;
  }

  const size = typeof candidate.size === 'number' && Number.isFinite(candidate.size) ? candidate.size : null;
  if (size !== null) {
    if (size <= 0) return 'That file is empty.';
    if (size > MAX_IMPORT_BYTES) {
      return `That recording is ${formatBytes(size)}. Psst analyses up to ${formatBytes(
        MAX_IMPORT_BYTES
      )} per recording.`;
    }
  }

  return null;
}

/** A duration that Psst will analyse, in the units the import screen uses. */
export function describeDurationProblem(durationMs: number): string | null {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return 'Psst could not read the length of that recording.';
  }
  if (durationMs > MAX_IMPORT_DURATION_MS) {
    return `That recording is ${formatDuration(durationMs)} long. Psst analyses up to ${formatDuration(
      MAX_IMPORT_DURATION_MS
    )} per recording.`;
  }
  return null;
}

/** "12.4 MB", "980 KB", "512 B" */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** "1h 04m", "48m 12s" — reuses the app's words-not-digits style. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

/** Recorder apps write a bare timestamp for a name; there is nothing to show the user. */
function isTimestampOnly(stem: string): boolean {
  return /^\d{4}[-_.]?\d{2}[-_.]?\d{2}(?:[-_. ]?\d{2}[-_.:]?\d{2}(?:[-_.:]?\d{2})?)?$/.test(stem.trim());
}

function humanise(stem: string): string {
  return stem
    .replace(EXTENSION_PATTERN, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s*-\s*/g, ' — ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Dates and clock stamps a recorder appends to the file name.
 *
 * People name a file after the call, not after the moment: leaving the stamp in
 * would turn "Sarah Bennett 2026-09-15" into a contact called "Sarah Bennett
 * 2026-09-15", which is worse than no guess at all.
 */
const TIMESTAMP_PATTERNS = [
  /\b20\d{2}[-_.]?\d{2}[-_.]?\d{2}(?:[-_. ]?\d{2}[-_.:]?\d{2}(?:[-_.:]?\d{2})?)?\b/g,
  /\b\d{6,8}[-_.]?\d{0,6}\b/g,
];

function stripStamps(text: string): string {
  let value = text;
  for (const pattern of TIMESTAMP_PATTERNS) value = value.replace(pattern, ' ');
  return value.replace(/\s+/g, ' ').replace(/^[\s_-]+|[\s_-]+$/g, '').trim();
}

/**
 * A title and a contact guessed from the file name.
 *
 * Handles the shapes recorders and people actually produce:
 *   "Call with Sarah Bennett 2026-09-15.m4a" -> contact "Sarah Bennett"
 *   "Acme renewal call.m4a"                  -> contact "Acme"
 *   "20260915_143012.m4a"                    -> no guess at all
 */
export function inferTitleAndContact(fileName: string): { title: string; contact: string } {
  const stem = (fileName ?? '').replace(EXTENSION_PATTERN, '').trim();
  if (stem === '') return { title: 'Call recording', contact: '' };
  if (isTimestampOnly(stem)) return { title: 'Call recording', contact: '' };

  const cleaned = stripStamps(stem);
  if (cleaned === '') return { title: 'Call recording', contact: '' };

  // "Call with Sarah" / "Recording - with Acme"
  const withMatch = /^(?:call|recording|audio|meeting)?[\s_-]*(?:with|w\/)[\s_-]+(.+)$/i.exec(cleaned);
  if (withMatch) {
    const contact = humanise(withMatch[1]).replace(/\s+—\s+.*$/, '').trim();
    if (contact !== '') return { title: `Call with ${contact}`, contact };
  }

  // "Acme renewal call" -> the leading name is the best contact guess.
  const trailingKind = /^(.+?)[\s_-]+(?:call|recording|meeting)$/i.exec(cleaned);
  const candidate = trailingKind ? trailingKind[1] : cleaned;

  const title = humanise(candidate);
  if (title === '') return { title: 'Call recording', contact: '' };

  // A contact is only inferred from a short, name-like first segment.
  const firstSegment = title.split(' — ')[0].trim();
  const looksLikeName = firstSegment.split(' ').length <= 3 && firstSegment.length <= 32;
  return { title, contact: looksLikeName ? firstSegment : '' };
}

/**
 * A recorded-at date guessed from the file name, or null.
 *
 * Only accepts a real calendar date, and refuses anything in the future: a
 * recorder that writes a nonsense stamp must not silently date the debrief
 * wrong. The user can always set the date by hand.
 */
export function inferRecordedAt(fileName: string, now: Date = new Date()): string | null {
  const stem = (fileName ?? '').replace(EXTENSION_PATTERN, '');
  const match = /(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})(?:[-_. ]?(\d{2})[-_.:]?(\d{2}))?/.exec(stem);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = match[4] === undefined ? 12 : Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;

  const date = new Date(year, month - 1, day, hour, minute, 0, 0);
  // Rejects impossible days such as 2026-02-31, which JS would roll forward.
  if (date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  if (date.getTime() > now.getTime() + 24 * 60 * 60 * 1000) return null;

  return date.toISOString();
}

/** "2026-09-15" for a date input, from an ISO instant. */
export function toDateInputValue(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Parses a user-typed `YYYY-MM-DD` into an ISO instant.
 *
 * Returns null for anything that is not a real date, so the screen can keep the
 * user's text on screen instead of silently replacing it.
 */
export function fromDateInputValue(value: string, fallbackTime = { hours: 12, minutes: 0 }): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec((value ?? '').trim());
  if (!match) return null;

  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    fallbackTime.hours,
    fallbackTime.minutes,
    0,
    0
  );
  if (Number.isNaN(date.getTime())) return null;
  if (date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[3])) return null;
  return date.toISOString();
}
