/**
 * Batch speech-to-text for imported recordings.
 *
 * The realtime path in `elevenlabs.js` streams microphone frames from a live
 * session. This module is the other half: one finished audio file uploaded once
 * and transcribed in a single request. Psst needs both — the live copilot is
 * gone, but a recording imported from Files must still become a transcript.
 *
 * Transport (verified against the published API reference,
 * https://elevenlabs.io/docs/api-reference/speech-to-text/convert):
 *   POST https://api.elevenlabs.io/v1/speech-to-text
 *   Content-Type: multipart/form-data
 *   header: xi-api-key
 *   form: model_id (required), file (required), language_code?, diarize?,
 *         num_speakers?, timestamps_granularity?, no_verbatim?
 *   response: { text, language_code, words: [{ text, type, start, end, speaker_id }] }
 *
 * ELEVENLABS_API_KEY is read here and never logged, returned, or sent to the
 * app. Everything provider-specific stays in this file: callers only see a
 * transcript with speaker-labelled lines.
 */

import { randomBytes } from 'node:crypto';

import { getElevenLabsApiKey } from './elevenlabs.js';
import { loadServerEnv } from './env.js';

loadServerEnv();

const DEFAULT_ENDPOINT = 'https://api.elevenlabs.io/v1/speech-to-text';
/** Scribe v2 is the current batch model. */
const DEFAULT_MODEL_ID = 'scribe_v2';
/** A long call takes a while to transcribe; this is a ceiling, not an estimate. */
const DEFAULT_TIMEOUT_MS = 300000;
/** A new line starts when the same speaker pauses for longer than this. */
const LINE_GAP_MS = 700;
/** Lines are capped so one hostile file cannot grow an unbounded response. */
const MAX_LINES = 4000;
const MAX_LINE_CHARS = 1000;

export function isBatchSttConfigured() {
  // Boolean only: never the key, never its length.
  return getElevenLabsApiKey().length > 0;
}

function readPositiveInt(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : fallback;
}

export function getBatchSttConfig() {
  return {
    endpoint: process.env.ELEVENLABS_STT_FILE_ENDPOINT ?? DEFAULT_ENDPOINT,
    modelId: process.env.ELEVENLABS_STT_FILE_MODEL ?? DEFAULT_MODEL_ID,
    languageCode: (process.env.ELEVENLABS_STT_LANGUAGE ?? '').trim(),
    /** Diarization is what makes a multi-speaker call readable. */
    diarize: (process.env.ELEVENLABS_STT_DIARIZE ?? 'true') !== 'false',
    timeoutMs: readPositiveInt('PSST_STT_FILE_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
  };
}

/** Strips anything that could break out of the multipart header line. */
function safeFileName(fileName) {
  return (fileName || 'recording.m4a')
    .replace(/[\r\n"]/g, '')
    .replace(/[\\/]+/g, '-')
    .slice(-120);
}

/**
 * Builds a multipart/form-data body.
 *
 * Written by hand rather than with a dependency: the form has one file and a
 * handful of scalar fields, and a hand-built body keeps the whole request on one
 * buffer that can be aborted as a unit.
 */
function buildMultipart(fields, file) {
  const boundary = `----psst${randomBytes(12).toString('hex')}`;
  const chunks = [];

  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${String(value)}\r\n`
      )
    );
  }

  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeFileName(
        file.fileName
      )}"\r\nContent-Type: ${file.mimeType || 'application/octet-stream'}\r\n\r\n`
    )
  );
  chunks.push(file.bytes);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/**
 * Groups provider words into readable lines.
 *
 * Consecutive words from one speaker stay on one line until that speaker pauses.
 * Diarization labels are kept as `label` ("Speaker 1") and never mapped to
 * "you"/"them": a recording cannot tell Psst which voice belongs to the user,
 * and guessing would misattribute every commitment in the debrief.
 */
function buildLines(words) {
  const speakerLabels = new Map();
  const lines = [];

  let current = null;

  for (const word of words) {
    if (!word || word.type !== 'word') continue;
    const text = typeof word.text === 'string' ? word.text.trim() : '';
    if (text === '') continue;

    const startMs = typeof word.start === 'number' ? Math.max(0, Math.round(word.start * 1000)) : null;
    const endMs = typeof word.end === 'number' ? Math.max(0, Math.round(word.end * 1000)) : startMs;
    const speakerId = typeof word.speaker_id === 'string' && word.speaker_id !== '' ? word.speaker_id : '';

    if (!speakerLabels.has(speakerId)) {
      speakerLabels.set(speakerId, speakerId === '' ? '' : `Speaker ${speakerLabels.size + 1}`);
    }
    const label = speakerLabels.get(speakerId);

    const startsNewLine =
      current === null ||
      current.label !== label ||
      (startMs !== null && current.endMs !== null && startMs - current.endMs > LINE_GAP_MS) ||
      current.text.length + text.length + 1 > MAX_LINE_CHARS;

    if (startsNewLine) {
      if (current) lines.push(current);
      if (lines.length >= MAX_LINES) break;
      current = { label, text, at: startMs ?? 0, endMs: endMs ?? startMs ?? 0 };
    } else {
      current.text = `${current.text} ${text}`;
      if (endMs !== null) current.endMs = endMs;
    }
  }

  if (current && lines.length < MAX_LINES) lines.push(current);

  return lines.map((line, index) => ({
    id: `line_${index + 1}`,
    // Diarization cannot resolve roles, so the honest speaker is `unknown`.
    speaker: 'unknown',
    label: line.label,
    text: line.text,
    at: line.at,
  }));
}

/**
 * Transcribes one recording.
 *
 * Never throws: a provider failure is a returned result, because the caller has
 * to answer with an HTTP status rather than crash the backend.
 *
 * @returns {Promise<
 *   { ok: true, text: string, languageCode: string, lines: Array<object>, durationMs: number }
 *   | { ok: false, error: string }
 * >}
 */
export async function transcribeRecording({ bytes, fileName, mimeType, fetchImpl, signal }) {
  const apiKey = getElevenLabsApiKey();
  if (apiKey === '') {
    return { ok: false, error: 'batch-stt-not-configured' };
  }

  const config = getBatchSttConfig();
  const request = buildMultipart(
    {
      model_id: config.modelId,
      language_code: config.languageCode,
      diarize: config.diarize ? 'true' : '',
      // Word timings are what make the transcript lines and the recording length.
      timestamps_granularity: 'word',
      no_verbatim: 'true',
    },
    { bytes, fileName, mimeType }
  );

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), config.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;

  try {
    const response = await (fetchImpl ?? globalThis.fetch)(config.endpoint, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'content-type': request.contentType,
        'content-length': String(request.body.length),
      },
      body: request.body,
      signal: combined,
    });

    if (!response.ok) {
      // The provider's body can name the offending parameter; it never contains
      // the key, but it is still truncated and never logged verbatim.
      let detail = '';
      try {
        detail = (await response.text()).slice(0, 300);
      } catch {
        detail = '';
      }
      return {
        ok: false,
        error: `transcription failed: HTTP ${response.status}${detail ? ` (${detail})` : ''}`,
      };
    }

    const payload = await response.json();
    const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
    const words = Array.isArray(payload?.words) ? payload.words : [];
    const lines = buildLines(words);

    if (text === '' && lines.length === 0) {
      return { ok: false, error: 'transcription returned no speech' };
    }

    const lastEnd = words.reduce(
      (latest, word) => (typeof word?.end === 'number' && word.end > latest ? word.end : latest),
      0
    );

    return {
      ok: true,
      text,
      languageCode: typeof payload?.language_code === 'string' ? payload.language_code : '',
      lines,
      durationMs: Math.round(lastEnd * 1000),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `transcription failed: ${message.slice(0, 200)}` };
  } finally {
    clearTimeout(timer);
  }
}
