/**
 * ElevenLabs realtime speech-to-text.
 *
 * ELEVENLABS_API_KEY is a server-side secret: it is read here, on the backend,
 * sent to ElevenLabs as the `xi-api-key` handshake header, and never sent to the
 * Psst app in any form. This module never logs the key.
 *
 * Transport (verified against the published API reference):
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
 * Everything provider-specific stays inside this file: `transcription.js` only
 * sees onPartial(text) / onFinal(text).
 */

import { WebSocket } from 'ws';

import { DEFAULT_SAMPLE_RATE, audioFormatForSampleRate } from './audio.js';
import { loadServerEnv } from './env.js';

loadServerEnv();

const DEFAULT_ENDPOINT = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
/** Scribe Realtime v2, the current realtime STT model. */
const DEFAULT_MODEL_ID = 'scribe_v2_realtime';
const DEFAULT_COMMIT_STRATEGY = 'vad';
/** How long to wait for `session_started` before declaring the provider dead. */
const OPEN_TIMEOUT_MS = 10000;
/** Bounded queue: audio captured before the provider socket finished opening. */
const MAX_QUEUED_CHUNKS = 200;

export function getElevenLabsApiKey() {
  return process.env.ELEVENLABS_API_KEY ?? '';
}

export function isElevenLabsConfigured() {
  // Deliberately reports a boolean only: never the key, never its length.
  return getElevenLabsApiKey().length > 0;
}

export function getElevenLabsConfig() {
  return {
    endpoint: process.env.ELEVENLABS_STT_ENDPOINT ?? DEFAULT_ENDPOINT,
    modelId: process.env.ELEVENLABS_STT_MODEL ?? DEFAULT_MODEL_ID,
    commitStrategy: process.env.ELEVENLABS_STT_COMMIT_STRATEGY ?? DEFAULT_COMMIT_STRATEGY,
    languageCode: process.env.ELEVENLABS_STT_LANGUAGE ?? '',
    noVerbatim: (process.env.ELEVENLABS_STT_NO_VERBATIM ?? 'true') !== 'false',
    vadSilenceSecs: process.env.ELEVENLABS_STT_VAD_SILENCE_SECS ?? '',
    minSilenceMs: process.env.ELEVENLABS_STT_MIN_SILENCE_MS ?? '',
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

function buildProviderUrl({ sampleRate, languageCode }) {
  const config = getElevenLabsConfig();
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
 * socket is open, frames are queued (bounded) instead of dropped, so the first
 * words of a conversation are not lost to connection setup latency.
 *
 * @param {{
 *   onPartial?: (text: string) => void,
 *   onFinal?: (text: string) => void,
 *   onError?: (message: string) => void,
 *   onOpen?: () => void,
 *   languageCode?: string,
 * }} handlers
 * @returns {{
 *   sendAudio: (pcmBase64: string, sampleRate?: number) => void,
 *   close: () => void,
 *   isOpen: () => boolean,
 * }}
 */
export function openTranscriptionSession(handlers = {}) {
  loadServerEnv();

  if (!isElevenLabsConfigured()) {
    throw new Error('ELEVENLABS_API_KEY is not set on the backend.');
  }

  const { onPartial, onFinal, onError, onOpen, languageCode } = handlers;
  const config = getElevenLabsConfig();

  /** @type {WebSocket | null} */
  let socket = null;
  let open = false;
  let closed = false;
  let openTimer = null;
  let sampleRate = DEFAULT_SAMPLE_RATE;
  /** @type {string[]} */
  let queue = [];
  let sentChunks = 0;

  const clearOpenTimer = () => {
    if (openTimer !== null) {
      clearTimeout(openTimer);
      openTimer = null;
    }
  };

  const reportError = (message) => {
    if (typeof onError === 'function') onError(message);
  };

  const fail = (message) => {
    if (closed) return;
    closed = true;
    clearOpenTimer();
    const current = socket;
    socket = null;
    open = false;
    queue = [];
    if (current) {
      try {
        current.removeAllListeners();
        current.close();
      } catch {
        // Already gone.
      }
    }
    reportError(message);
  };

  const flushQueue = () => {
    if (!socket || !open || queue.length === 0) return;
    const pending = queue;
    queue = [];
    for (const payload of pending) {
      try {
        socket.send(payload);
        sentChunks += 1;
      } catch {
        queue = [];
        return;
      }
    }
  };

  const connect = (rate) => {
    sampleRate = rate;
    const url = buildProviderUrl({ sampleRate: rate, languageCode });

    let ws;
    try {
      ws = new WebSocket(url, {
        headers: { 'xi-api-key': getElevenLabsApiKey() },
        // Long conversations: keep the provider socket alive between utterances.
        handshakeTimeout: OPEN_TIMEOUT_MS,
      });
    } catch (error) {
      fail(`ElevenLabs connection failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    socket = ws;

    openTimer = setTimeout(() => {
      fail('ElevenLabs did not start the transcription session in time.');
    }, OPEN_TIMEOUT_MS);

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
     */
    sendAudio(pcmBase64, rate) {
      if (closed || typeof pcmBase64 !== 'string' || pcmBase64 === '') return;

      const nextRate =
        typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : sampleRate;

      if (!socket) {
        // First frame: we now know the real sample rate, so dial the provider.
        if (nextRate !== sampleRate) sampleRate = nextRate;
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
        try {
          socket?.send(payload);
          sentChunks += 1;
        } catch {
          fail('ElevenLabs connection dropped while sending audio.');
        }
        return;
      }

      if (queue.length >= MAX_QUEUED_CHUNKS) queue.shift();
      queue.push(payload);
    },

    close() {
      if (closed) return;
      closed = true;
      clearOpenTimer();
      const current = socket;
      socket = null;
      open = false;
      queue = [];
      if (current) {
        try {
          current.removeAllListeners();
          current.close(1000, 'session ended');
        } catch {
          // Already gone.
        }
      }
    },

    isOpen() {
      return open && !closed;
    },

    /** Diagnostics for /health and logs: counts and format, never key material. */
    stats() {
      return { sentChunks, modelId: config.modelId, audioFormat: audioFormatForSampleRate(sampleRate) };
    },
  };
}
