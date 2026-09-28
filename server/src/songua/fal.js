/**
 * Minimal fal.ai queue client.
 *
 * fal hosts the two models Songua cannot run here: Demucs (stem separation) and
 * ACE-Step (rewrite the lyrics, keep the melody). This machine has no GPU, so
 * every model call is a rented one.
 *
 * The client is hand-rolled `fetch` rather than `@fal-ai/client` for the same
 * reason `stt.js` builds its own multipart body: the surface used here is three
 * endpoints, and a dependency is one more thing that can break a deploy. It also
 * keeps FAL_KEY handling identical to every other provider in this server — read
 * in one place, never logged, never returned.
 *
 * Transport (verified against https://fal.ai/docs/documentation/model-apis/inference/queue):
 *   POST https://queue.fal.run/{model}        -> { request_id, status_url, response_url }
 *   GET  {status_url}?logs=1                  -> { status: IN_QUEUE | IN_PROGRESS | COMPLETED, ... }
 *   GET  {response_url}                       -> model-specific result
 *   header: Authorization: Key <FAL_KEY>
 *
 * Long jobs are the norm: a song is minutes of audio, not milliseconds, so the
 * queue is used explicitly rather than a blocking subscribe call. Polling is what
 * a webhook-less server can do today; `submit` returns the URLs a webhook-based
 * deployment would need instead.
 */

import { loadServerEnv } from '../env.js';

loadServerEnv();

const DEFAULT_BASE = 'https://queue.fal.run';
const DEFAULT_TIMEOUT_MS = 900000;
const DEFAULT_POLL_MS = 3000;
/** Backoff ceiling: a busy model can sit in the queue for a while. */
const DEFAULT_MAX_POLL_MS = 15000;

export function getFalApiKey() {
  return process.env.FAL_KEY ?? process.env.FAL_API_KEY ?? '';
}

/** Boolean only: never the key, never its length. */
export function isFalConfigured() {
  return getFalApiKey().length > 0;
}

export function getFalConfig() {
  return {
    base: process.env.FAL_QUEUE_BASE ?? DEFAULT_BASE,
    timeoutMs: readPositiveInt('FAL_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
    pollMs: readPositiveInt('FAL_POLL_MS', DEFAULT_POLL_MS),
    maxPollMs: readPositiveInt('FAL_MAX_POLL_MS', DEFAULT_MAX_POLL_MS),
    demucsModel: process.env.FAL_DEMUCS_MODEL ?? 'fal-ai/demucs',
    aceStepModel: process.env.FAL_ACE_STEP_MODEL ?? 'fal-ai/ace-step/audio-to-audio',
  };
}

function readPositiveInt(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : fallback;
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Wraps bytes as a data URI.
 *
 * fal accepts public URLs or data URIs. A URL would be better for a real
 * deployment — fal's own storage, or ours — but a hook window is a few hundred
 * kilobytes and a data URI keeps a spike free of an upload step and of any
 * storage bucket that would need cleaning up.
 */
export function toDataUri(bytes, mimeType = 'audio/wav') {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;
}

/** Submits to the queue and returns immediately with the tracking URLs. */
async function submit({ model, input, fetchImpl }) {
  const apiKey = getFalApiKey();
  if (apiKey === '') return { ok: false, error: 'fal-not-configured' };

  const config = getFalConfig();
  let response;
  try {
    response = await (fetchImpl ?? globalThis.fetch)(`${config.base}/${model}`, {
      method: 'POST',
      headers: {
        authorization: `Key ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(60000),
    });
  } catch (error) {
    return { ok: false, error: `fal submit failed: ${describe(error).slice(0, 200)}` };
  }

  if (!response.ok) {
    let detail = '';
    try {
      detail = (await response.text()).slice(0, 300);
    } catch {
      detail = '';
    }
    return {
      ok: false,
      error: `fal submit failed: HTTP ${response.status}${detail ? ` (${detail})` : ''}`,
    };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, error: 'fal submit returned a non-JSON response' };
  }

  if (typeof payload?.request_id !== 'string') {
    return { ok: false, error: 'fal submit returned no request_id' };
  }

  return { ok: true, requestId: payload.request_id, statusUrl: payload.status_url, responseUrl: payload.response_url };
}

/**
 * Polls one queued request to completion and returns its result.
 *
 * A completed request can still carry an error in its body, and fal retries a
 * failed runner automatically, so `status === COMPLETED` is not the same as
 * success — both are checked.
 */
async function waitForResult({ model, requestId, statusUrl, responseUrl, fetchImpl, signal, onProgress }) {
  const config = getFalConfig();
  const deadline = Date.now() + config.timeoutMs;
  let delay = config.pollMs;

  while (Date.now() < deadline) {
    if (signal?.aborted) return { ok: false, error: 'fal request aborted' };

    let status;
    try {
      const response = await (fetchImpl ?? globalThis.fetch)(
        statusUrl ?? `${config.base}/${model}/requests/${requestId}/status?logs=1`,
        { headers: { authorization: `Key ${getFalApiKey()}` }, signal: AbortSignal.timeout(30000) }
      );
      if (!response.ok) {
        return { ok: false, error: `fal status failed: HTTP ${response.status}` };
      }
      status = await response.json();
    } catch (error) {
      return { ok: false, error: `fal status failed: ${describe(error).slice(0, 200)}` };
    }

    if (status?.status === 'COMPLETED') {
      if (typeof status.error === 'string' && status.error !== '') {
        return { ok: false, error: `fal model error: ${status.error.slice(0, 300)}` };
      }
      return fetchResult({ model, requestId, responseUrl, fetchImpl });
    }

    onProgress?.(status?.status === 'IN_QUEUE' ? status.queue_position : status?.status);

    await sleep(delay, signal);
    delay = Math.min(Math.round(delay * 1.4), config.maxPollMs);
  }

  return { ok: false, error: `fal request timed out after ${Math.round(config.timeoutMs / 1000)}s` };
}

/**
 * Fetches a completed result.
 *
 * The submit response returns `.../requests/{id}/response` while the documented
 * result curl uses `.../requests/{id}`. Both are accepted, because a 404 from the
 * first is a routing detail rather than a failed job.
 */
async function fetchResult({ model, requestId, responseUrl, fetchImpl }) {
  const config = getFalConfig();
  const candidates = [
    responseUrl,
    `${config.base}/${model}/requests/${requestId}`,
  ].filter((url) => typeof url === 'string' && url !== '');

  let lastError = 'fal returned no result URL';
  for (const url of candidates) {
    try {
      const response = await (fetchImpl ?? globalThis.fetch)(url, {
        headers: { authorization: `Key ${getFalApiKey()}` },
        signal: AbortSignal.timeout(120000),
      });
      if (response.ok) return { ok: true, data: await response.json() };
      lastError = `fal result failed: HTTP ${response.status}`;
    } catch (error) {
      lastError = `fal result failed: ${describe(error).slice(0, 200)}`;
    }
  }

  return { ok: false, error: lastError };
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/** Submit-and-wait, the shape every caller in the pipeline actually wants. */
export async function runModel({ model, input, fetchImpl, signal, onProgress }) {
  const submitted = await submit({ model, input, fetchImpl });
  if (!submitted.ok) return submitted;

  onProgress?.(`submitted ${model} as ${submitted.requestId}`);
  return waitForResult({ ...submitted, model, fetchImpl, signal, onProgress });
}

/**
 * Finds the first URL under a key matching one of `matchers`, depth-first.
 *
 * Model output schemas drift between versions and fal returns a
 * model-specific body, so the alternatives are a brittle hard-coded shape or a
 * tolerant search. `pickStemUrls` below shows what the keys look like.
 */
function findUrlByKeys(value, matchers, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return null;

  for (const [key, child] of Object.entries(value)) {
    const lowered = key.toLowerCase();
    if (matchers.some((matcher) => lowered.includes(matcher))) {
      if (typeof child === 'string' && child.startsWith('http')) return child;
      if (child && typeof child === 'object' && typeof child.url === 'string') return child.url;
    }
  }

  for (const child of Object.values(value)) {
    const found = findUrlByKeys(child, matchers, depth + 1);
    if (found) return found;
  }

  return null;
}

/** Any audio the model produced, whatever it chose to call it. */
export function findAudioUrl(result) {
  return findUrlByKeys(result, ['audio_url', 'audio']);
}

/**
 * Splits a song into stems.
 *
 * Only `vocals` is used by the pipeline today: an isolated vocal transcribes far
 * better than a full mix, and a clean vocal is what a voice clone would need
 * later. The accompaniment is not needed yet, because ACE-Step regenerates the
 * backing track itself when it rewrites the lyrics.
 */
export async function separateStems({ audio, fetchImpl, signal, onProgress }) {
  const config = getFalConfig();
  const result = await runModel({
    model: config.demucsModel,
    input: { audio_url: audio },
    fetchImpl,
    signal,
    onProgress,
  });
  if (!result.ok) return result;

  return {
    ok: true,
    vocalsUrl: findUrlByKeys(result.data, ['vocal']),
    instrumentalUrl: findUrlByKeys(result.data, ['instrumental', 'no_vocals', 'accompaniment']),
    raw: result.data,
  };
}

/**
 * Rewrites the words while keeping the performance.
 *
 * `edit_mode: 'lyrics'` is the whole reason Songua is buildable: it edits the
 * lyric and leaves melody, vocal character and accompaniment intact, rather than
 * generating a new song in the same style. `original_lyrics` is required for that
 * edit to be anchored — without it the model has nothing to subtract.
 */
export async function transformLyrics({
  audio,
  sourceLyrics,
  targetLyrics,
  tags,
  fetchImpl,
  signal,
  onProgress,
}) {
  const config = getFalConfig();
  const result = await runModel({
    model: config.aceStepModel,
    input: {
      audio_url: audio,
      edit_mode: 'lyrics',
      original_lyrics: sourceLyrics,
      original_tags: tags,
      lyrics: targetLyrics,
      tags,
    },
    fetchImpl,
    signal,
    onProgress,
  });
  if (!result.ok) return result;

  const audioUrl = findAudioUrl(result.data);
  if (!audioUrl) return { ok: false, error: 'ace-step returned no audio' };
  return { ok: true, audioUrl, raw: result.data };
}
