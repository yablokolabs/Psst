/**
 * Audio format helpers shared by the STT client and the protocol layer.
 *
 * The app captures PCM16 little-endian mono at the hardware sample rate and
 * sends raw frames. Because the payload is already `pcm_*` audio, nothing is
 * transcoded anywhere in the pipeline: the sample rate the phone actually
 * delivered is what we hand to ElevenLabs.
 *
 * A rate the provider does not accept is **rejected**, never relabelled as a
 * nearby rate: telling ElevenLabs that 32 kHz audio is 24 kHz would silently
 * transcribe a pitch-shifted conversation, which is worse than staying silent.
 */

import { LIMITS } from './limits.js';

/** Rates the realtime STT endpoint accepts, from the published `AudioFormatEnum`. */
export const SUPPORTED_SAMPLE_RATES = [8000, 16000, 22050, 24000, 44100, 48000];

export const DEFAULT_SAMPLE_RATE = 16000;

function isFinitePositive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** A numeric string, matched literally so nothing is coerced through a method. */
const NUMERIC_STRING = /^-?\d+(?:\.\d+)?$/;

/**
 * Converts one wire value to a finite number, using **primitives only**.
 *
 * `Number(value)` calls `valueOf`/`toString` on objects, and JSON happily
 * carries `{"toString":null,"valueOf":null}` as a plain object. `Number()` on
 * that throws `TypeError: Cannot convert object to primitive value`, which would
 * escape the WebSocket message handler and take the whole backend down. So every
 * field arriving from a client goes through this guard instead: numbers and
 * numeric strings convert, everything else (objects, arrays, null, booleans,
 * `NaN`, `Infinity`) is `null`.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
export function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && NUMERIC_STRING.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function isSupportedSampleRate(sampleRate) {
  return SUPPORTED_SAMPLE_RATES.includes(sampleRate);
}

/**
 * Picks the PCM format string for a delivered sample rate.
 * Returns null for anything outside `AudioFormatEnum`, so the caller drops the
 * frame rather than asking the provider to misread it.
 */
export function audioFormatForSampleRate(sampleRate) {
  if (!isSupportedSampleRate(sampleRate)) return null;
  return `pcm_${sampleRate}`;
}

/**
 * Normalises the audio description announced by the app on its first frame.
 * Returns null when the frame is unusable, so the caller can drop it instead of
 * opening a provider session with nonsense parameters.
 *
 * Accepts anything, including null and non-objects: this runs on raw client
 * input inside the WebSocket message handler, where a thrown TypeError would
 * take the whole backend down.
 */
export function normalizeAudioConfig(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;

  const { sampleRate, channels, encoding } = value;
  if (!isFinitePositive(sampleRate)) return null;
  if (!isSupportedSampleRate(sampleRate)) return null;

  const channelCount = isFinitePositive(channels) ? Math.trunc(channels) : 1;
  // Realtime STT is a mono feed; a stereo frame would halve the effective rate.
  if (channelCount !== 1) return null;

  const format = typeof encoding === 'string' ? encoding : 'int16';
  // Only 16-bit signed PCM is forwarded. float32 from the mic would need a
  // conversion pass, which the app avoids by requesting int16 directly.
  if (format !== 'int16' && format !== 'pcm16') return null;

  return {
    sampleRate,
    channels: channelCount,
    encoding: 'int16',
    audioFormat: audioFormatForSampleRate(sampleRate),
  };
}

/**
 * Validates a base64 PCM16 payload against the metadata the app declared.
 *
 * The decoded byte count is authoritative: a frame whose declared `byteLength`
 * disagrees with its payload is rejected rather than half-trusted.
 *
 * @param {unknown} pcmBase64
 * @param {unknown} declaredByteLength
 * @param {number} [maxBytes]
 * @returns {{ ok: true, byteLength: number } | { ok: false, reason: string, byteLength?: number }}
 */
export function validatePcmFrame(pcmBase64, declaredByteLength, maxBytes = LIMITS.maxAudioFrameBytes) {
  if (typeof pcmBase64 !== 'string' || pcmBase64 === '') {
    return { ok: false, reason: 'missing-pcm' };
  }
  // Reject anything that is not well-formed base64 before decoding: Buffer.from
  // silently ignores invalid characters instead of failing.
  if (pcmBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(pcmBase64)) {
    return { ok: false, reason: 'invalid-base64' };
  }

  const byteLength = Buffer.from(pcmBase64, 'base64').byteLength;
  if (byteLength === 0) return { ok: false, reason: 'empty-pcm' };
  // PCM16 is two bytes per sample: an odd length cannot be a valid frame.
  if (byteLength % 2 !== 0) return { ok: false, reason: 'unaligned-pcm', byteLength };
  if (byteLength > maxBytes) return { ok: false, reason: 'frame-too-large', byteLength };

  // Primitive-only conversion: a declared length of `{"toString":null}` must
  // read as "not declared" rather than throwing out of the parser.
  const declared = toFiniteNumber(declaredByteLength);
  if (declared !== null && declared > 0 && declared !== byteLength) {
    return { ok: false, reason: 'byte-length-mismatch', byteLength };
  }

  return { ok: true, byteLength };
}

/** Bytes -> milliseconds of audio, used for transcript timestamps. */
export function pcmDurationMs(byteLength, sampleRate, channels = 1) {
  if (!isFinitePositive(byteLength) || !isFinitePositive(sampleRate)) return 0;
  const samples = byteLength / 2 / Math.max(1, channels);
  return Math.max(0, Math.round((samples / sampleRate) * 1000));
}
