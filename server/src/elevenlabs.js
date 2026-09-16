/**
 * ElevenLabs realtime speech-to-text.
 *
 * ELEVENLABS_API_KEY is a server-side secret: it is read here, on the backend,
 * sent to ElevenLabs as the `xi-api-key` handshake header, and never sent to the
 * Psst app in any form. This module never logs the key.
 *
 * Transport (verified against the published API reference,
 * https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime):
 *   wss://api.elevenlabs.io/v1/speech-to-text/realtime
 *     ?model_id=scribe_v2_realtime&audio_format=pcm_16000&commit_strategy=vad
 *   header: xi-api-key
 *
 * Client -> provider:
 *   { message_type: 'input_audio_chunk', audio_base_64, commit, sample_rate }
 * Provider -> client:
 *   session_started | partial_transcript | committed_transcript
 *   | committed_transcript_with_timestamps | warning | *_error
 *
 * Finalization uses the endpoint's own documented flush: an `input_audio_chunk`
 * with an empty `audio_base_64` and `commit: true`, followed by a bounded wait
 * for the resulting `committed_transcript`. Nothing is synthesised locally and
 * the microphone is never kept open to force a commit.
 *
 * Everything provider-specific stays inside this file: `transcription.js` only
 * sees onPartial(text) / onFinal(text).
 */

import { WebSocket } from 'ws';

import { DEFAULT_SAMPLE_RATE, audioFormatForSampleRate, isSupportedSampleRate } from './audio.js';
import { loadServerEnv } from './env.js';
import { LIMITS } from './limits.js';

loadServerEnv();

const DEFAULT_ENDPOINT = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
/** Scribe Realtime v2, the current realtime STT model. */
const DEFAULT_MODEL_ID = 'scribe_v2_realtime';
/** VAD commits on silence; `manual` only commits when we ask (see flush()). */
export const COMMIT_STRATEGIES = ['vad', 'manual'];
const DEFAULT_COMMIT_STRATEGY = 'vad';
/** How long to wait for `session_started` before declaring the provider dead. */
const DEFAULT_OPEN_TIMEOUT_MS = 10000;
/** How long a flush may wait for the resulting committed transcript. */
const DEFAULT_FLUSH_TIMEOUT_MS = 2500;
/** Minimum gap between two congestion notices for one session. */
const CONGESTION_NOTICE_INTERVAL_MS = 5000;

export function getElevenLabsApiKey() {
  return process.env.ELEVENLABS_API_KEY ?? '';
}

export function isElevenLabsConfigured() {
  // Deliberately reports a boolean only: never the key, never its length.
  return getElevenLabsApiKey().length > 0;
}

function readPositiveInt(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : fallback;
}

export function getElevenLabsConfig() {
  const requested = (process.env.ELEVENLABS_STT_COMMIT_STRATEGY ?? DEFAULT_COMMIT_STRATEGY)
    .trim()
    .toLowerCase();

  return {
    endpoint: process.env.ELEVENLABS_STT_ENDPOINT ?? DEFAULT_ENDPOINT,
    modelId: process.env.ELEVENLABS_STT_MODEL ?? DEFAULT_MODEL_ID,
    commitStrategy: COMMIT_STRATEGIES.includes(requested) ? requested : DEFAULT_COMMIT_STRATEGY,
    /** True when a documented strategy was requested but is not one we support. */
    commitStrategyRejected: !COMMIT_STRATEGIES.includes(requested),
    languageCode: (process.env.ELEVENLABS_STT_LANGUAGE ?? '').trim(),
    noVerbatim: (process.env.ELEVENLABS_STT_NO_VERBATIM ?? 'true') !== 'false',
    vadSilenceSecs: process.env.ELEVENLABS_STT_VAD_SILENCE_SECS ?? '',
    minSilenceMs: process.env.ELEVENLABS_STT_MIN_SILENCE_MS ?? '',
    openTimeoutMs: readPositiveInt('PSST_STT_OPEN_TIMEOUT_MS', DEFAULT_OPEN_TIMEOUT_MS),
    flushTimeoutMs: readPositiveInt('PSST_STT_FLUSH_TIMEOUT_MS', DEFAULT_FLUSH_TIMEOUT_MS),
  };
}

/**
 * Maps a provider message to a plain error string, or null when the message is
 * not an error. ElevenLabs reports many distinct failure message types; they all
 * carry `message_type` plus `error`.
 */
function readProviderError(message) {
  const type = typeof message.message_type === 'string' ? message.message_type : '';
  if (type === 'warning') return null;
  if (!type.includes('error')) return null;
  const detail = typeof message.error === 'string' && message.error ? message.error : type;
  return `${type}: ${detail}`.slice(0, 300);
}

/**
 * Shuts a provider socket down without ever leaving it able to raise an
 * unhandled `'error'` event.
 *
 * `ws` emits `'error'` asynchronously when a socket that is still CONNECTING is
 * closed ("WebSocket was closed before the connection was established"), and an
 * `'error'` event with no listener is an uncaught exception that takes the whole
 * backend down. So the error listener is attached first and only removed once
 * the socket has actually closed.
 */
function shutdownSocket(ws, code, reason) {
  if (!ws) return;

  const state = ws.readyState;
  if (state === WebSocket.CLOSED) return;

  ws.on('error', () => {});
  try {
    ws.removeAllListeners('message');
    ws.removeAllListeners('open');
  } catch {
    // Nothing to detach.
  }

  const release = () => {
    try {
      ws.removeAllListeners();
    } catch {
      // Already gone.
    }
  };
  ws.once('close', release);

  try {
    if (state === WebSocket.CONNECTING) {
      // Aborts the handshake; needs the error listener above to stay attached.
      ws.terminate();
      return;
    }
    // CLOSING: the handshake is already under way, just let it finish.
    if (state === WebSocket.OPEN) ws.close(code, reason);
  } catch {
    release();
  }
}

function buildProviderUrl({ sampleRate, languageCode, config }) {
  const params = new URLSearchParams({
    model_id: config.modelId,
    audio_format: audioFormatForSampleRate(sampleRate),
    commit_strategy: config.commitStrategy,
  });

  if (languageCode) params.set('language_code', languageCode);
  if (!config.noVerbatim) params.set('no_verbatim', 'false');
  if (config.vadSilenceSecs) params.set('vad_silence_threshold_secs', config.vadSilenceSecs);
  if (config.minSilenceMs) params.set('min_silence_duration_ms', config.minSilenceMs);

  return `${config.endpoint}?${params.toString()}`;
}

/**
 * Opens a realtime transcription session.
 *
 * The provider socket is dialled lazily on the first audio frame, because only
 * then do we know the sample rate the device actually delivered. Until the
 * socket is open, frames are queued — bounded by both bytes and age — instead of
 * dropped, so the first words of a conversation are not lost to connection setup
 * latency without ever accumulating a backlog of stale audio.
 *
 * @param {{
 *   onPartial?: (text: string) => void,
 *   onFinal?: (text: string) => void,
 *   onError?: (message: string) => void,
 *   onOpen?: () => void,
 *   onCongestion?: (info: { reason: string, droppedChunks: number, queuedBytes: number }) => void,
 *   languageCode?: string,
 * }} handlers
 * @returns {{
 *   sendAudio: (pcmBase64: string, sampleRate?: number) => boolean,
 *   flush: () => Promise<boolean>,
 *   close: () => void,
 *   isOpen: () => boolean,
 *   stats: () => object,
 * }}
 */
export function openTranscriptionSession(handlers = {}) {
  loadServerEnv();

  if (!isElevenLabsConfigured()) {
    throw new Error('ELEVENLABS_API_KEY is not set on the backend.');
  }

  const { onPartial, onFinal, onError, onOpen, onCongestion } = handlers;
  const config = getElevenLabsConfig();
  /** Language hint: an explicit handler wins, otherwise ELEVENLABS_STT_LANGUAGE. */
  const languageCode = handlers.languageCode ?? config.languageCode;

  /** @type {WebSocket | null} */
  let socket = null;
  let open = false;
  let closed = false;
  let openTimer = null;
  let sampleRate = DEFAULT_SAMPLE_RATE;
  /** @type {Array<{ payload: string, bytes: number, at: number }>} */
  let queue = [];
  let queuedBytes = 0;
  let sentChunks = 0;
  let droppedChunks = 0;
  let congested = false;
  let lastCongestionNoticeAt = 0;
  /** @type {Array<{ resolve: (value: boolean) => void, timer: ReturnType<typeof setTimeout> }>} */
  let finalWaiters = [];

  const clearOpenTimer = () => {
    if (openTimer !== null) {
      clearTimeout(openTimer);
      openTimer = null;
    }
  };

  const reportError = (message) => {
    if (typeof onError === 'function') onError(message);
  };

  const notifyCongestion = (reason) => {
    congested = true;
    const now = Date.now();
    if (now - lastCongestionNoticeAt < CONGESTION_NOTICE_INTERVAL_MS) return;
    lastCongestionNoticeAt = now;
    if (typeof onCongestion === 'function') {
      onCongestion({ reason, droppedChunks, queuedBytes });
    }
  };

  const settleWaiters = (value) => {
    if (finalWaiters.length === 0) return;
    const waiters = finalWaiters;
    finalWaiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(value);
    }
  };

  /** Drops queued audio that is older than the configured age ceiling. */
  const pruneQueueByAge = (now) => {
    if (queue.length === 0) return;
    const cutoff = now - LIMITS.providerQueueMaxAgeMs;
    if (queue[0].at >= cutoff) return;

    let dropped = 0;
    while (queue.length > 0 && queue[0].at < cutoff) {
      queuedBytes -= queue.shift().bytes;
      dropped += 1;
    }
    droppedChunks += dropped;
    if (dropped > 0) notifyCongestion('queue-stale');
  };

  const enqueue = (payload, bytes) => {
    const now = Date.now();
    pruneQueueByAge(now);

    queue.push({ payload, bytes, at: now });
    queuedBytes += bytes;

    let droppedForBytes = 0;
    while (queuedBytes > LIMITS.maxProviderQueueBytes && queue.length > 0) {
      queuedBytes -= queue.shift().bytes;
      droppedForBytes += 1;
    }
    if (droppedForBytes > 0) {
      droppedChunks += droppedForBytes;
      notifyCongestion('queue-full');
    }
  };

  const fail = (message) => {
    if (closed) return;
    closed = true;
    clearOpenTimer();
    const current = socket;
    socket = null;
    open = false;
    queue = [];
    queuedBytes = 0;
    shutdownSocket(current, 1000, 'session failed');
    settleWaiters(false);
    reportError(message);
  };

  const flushQueue = () => {
    if (!socket || !open || queue.length === 0) return;

    while (queue.length > 0) {
      // A stalled provider socket must not make us queue up unbounded stale
      // audio in the kernel buffer: stop feeding it and let the age ceiling
      // discard what is no longer worth transcribing.
      if (socket.bufferedAmount > LIMITS.maxProviderBufferedBytes) {
        notifyCongestion('socket-buffered');
        return;
      }

      const next = queue.shift();
      queuedBytes -= next.bytes;
      try {
        socket.send(next.payload);
        sentChunks += 1;
      } catch {
        queue = [];
        queuedBytes = 0;
        fail('ElevenLabs connection dropped while sending audio.');
        return;
      }
    }
  };

  const connect = (rate) => {
    sampleRate = rate;
    const url = buildProviderUrl({ sampleRate: rate, languageCode, config });

    let ws;
    try {
      ws = new WebSocket(url, {
        headers: { 'xi-api-key': getElevenLabsApiKey() },
        // Long conversations: keep the provider socket alive between utterances.
        handshakeTimeout: config.openTimeoutMs,
      });
    } catch (error) {
      fail(`ElevenLabs connection failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    socket = ws;

    openTimer = setTimeout(() => {
      fail('ElevenLabs did not start the transcription session in time.');
    }, config.openTimeoutMs);

    ws.on('open', () => {
      // Wait for `session_started` before sending audio; the timer stays armed
      // until then so a silent provider socket is still detected.
    });

    ws.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (typeof message !== 'object' || message === null) return;

      const providerError = readProviderError(message);
      if (providerError) {
        // Provider errors end the transcription stream but must not end the
        // Psst session: the caller decides how to surface them.
        fail(providerError);
        return;
      }

      switch (message.message_type) {
        case 'session_started': {
          open = true;
          congested = false;
          clearOpenTimer();
          if (typeof onOpen === 'function') onOpen();
          flushQueue();
          break;
        }
        case 'partial_transcript':
          if (typeof message.text === 'string' && message.text.trim() !== '') {
            onPartial?.(message.text);
          }
          break;
        case 'committed_transcript':
        case 'committed_transcript_with_timestamps':
          if (typeof message.text === 'string' && message.text.trim() !== '') {
            onFinal?.(message.text);
          }
          // Resolve flush waiters only after the final has been handed over, so
          // a caller that awaits flush() already has the utterance recorded.
          settleWaiters(true);
          break;
        default:
          break;
      }
    });

    ws.on('error', (error) => {
      fail(`ElevenLabs connection error: ${error instanceof Error ? error.message : String(error)}`);
    });

    ws.on('close', (code, reason) => {
      if (closed) return;
      const detail = reason ? reason.toString() : '';
      fail(`ElevenLabs closed the transcription stream (${code}${detail ? `: ${detail}` : ''}).`);
    });
  };

  return {
    /**
     * @param {string} pcmBase64 base64 PCM16 little-endian mono
     * @param {number} [rate] the rate the device actually delivered
     * @returns {boolean} false when the frame was refused rather than forwarded
     */
    sendAudio(pcmBase64, rate) {
      if (closed || typeof pcmBase64 !== 'string' || pcmBase64 === '') return false;

      if (rate !== undefined && rate !== null) {
        if (!isSupportedSampleRate(rate)) return false;
        // The first frame fixes the session's rate; the app never changes the
        // capture rate mid-session, and if it did the audio would have to be
        // resampled rather than relabelled.
        if (rate !== sampleRate && socket !== null) return false;
      }

      const nextRate = rate ?? sampleRate;
      if (!isSupportedSampleRate(nextRate)) return false;

      if (!socket) {
        // First frame: we now know the real sample rate, so dial the provider.
        sampleRate = nextRate;
        connect(nextRate);
      }

      const payload = JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: pcmBase64,
        // VAD commit strategy: ElevenLabs decides when an utterance is complete.
        commit: false,
        sample_rate: sampleRate,
      });

      if (open) {
        if (socket && socket.bufferedAmount > LIMITS.maxProviderBufferedBytes) {
          // Live audio is only useful now: dropping a frame is better than
          // transcribing it a conversation later.
          droppedChunks += 1;
          notifyCongestion('socket-buffered');
          return true;
        }
        try {
          socket?.send(payload);
          sentChunks += 1;
        } catch {
          fail('ElevenLabs connection dropped while sending audio.');
        }
        return true;
      }

      enqueue(payload, Buffer.byteLength(pcmBase64));
      return true;
    },

    /**
     * Provider-supported finalization: the documented empty `input_audio_chunk`
     * with `commit: true`. Resolves true when the resulting committed transcript
     * arrived, false when the session was not open or the bounded wait expired.
     */
    flush() {
      if (closed || !open || !socket) return Promise.resolve(false);

      const payload = JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: '',
        commit: true,
        sample_rate: sampleRate,
      });

      const waited = new Promise((resolve) => {
        const timer = setTimeout(() => {
          finalWaiters = finalWaiters.filter((candidate) => candidate.resolve !== resolve);
          resolve(false);
        }, config.flushTimeoutMs);
        // Do not hold the process open for a flush.
        timer.unref?.();
        finalWaiters.push({ resolve, timer });
      });

      try {
        socket.send(payload);
      } catch {
        return Promise.resolve(false);
      }

      return waited;
    },

    close() {
      if (closed) return;
      closed = true;
      clearOpenTimer();
      const current = socket;
      socket = null;
      open = false;
      queue = [];
      queuedBytes = 0;
      shutdownSocket(current, 1000, 'session ended');
      settleWaiters(false);
    },

    isOpen() {
      return open && !closed;
    },

    /** Diagnostics for /health and logs: counts and format, never key material. */
    stats() {
      return {
        sentChunks,
        droppedChunks,
        queuedChunks: queue.length,
        queuedBytes,
        congested,
        modelId: config.modelId,
        commitStrategy: config.commitStrategy,
        languageCode: languageCode || null,
        audioFormat: audioFormatForSampleRate(sampleRate),
        sampleRate,
      };
    },
  };
}
