/**
 * Audio format helpers shared by the STT client and the protocol layer.
 *
 * The app captures PCM16 little-endian mono at the hardware sample rate (16 kHz
 * on the S24 Ultra) and sends raw frames. Because the payload is already
 * `pcm_*` audio, nothing is transcoded anywhere in the pipeline: the sample rate
 * the phone actually delivered is what we hand to ElevenLabs.
 *
 * ElevenLabs accepts exactly these PCM rates for realtime STT.
 */

/** Rates the realtime STT endpoint accepts, from the published `AudioFormatEnum`. */
export const SUPPORTED_SAMPLE_RATES = [8000, 16000, 22050, 24000, 44100, 48000];

export const DEFAULT_SAMPLE_RATE = 16000;

/** Guards against a malformed or hostile frame claiming an absurd rate. */
export const MIN_SAMPLE_RATE = 8000;
export const MAX_SAMPLE_RATE = 96000;

function isFinitePositive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Picks the PCM format string for a delivered sample rate.
 * Falls back to the closest supported rate so a device that reports something
 * unusual still transcribes instead of failing the session.
 */
export function audioFormatForSampleRate(sampleRate) {
  if (!isFinitePositive(sampleRate)) return `pcm_${DEFAULT_SAMPLE_RATE}`;

  if (SUPPORTED_SAMPLE_RATES.includes(sampleRate)) return `pcm_${sampleRate}`;

  const closest = SUPPORTED_SAMPLE_RATES.reduce((best, candidate) =>
    Math.abs(candidate - sampleRate) < Math.abs(best - sampleRate) ? candidate : best
  );
  return `pcm_${closest}`;
}

/**
 * Normalises the audio description announced by the app on its first frame.
 * Returns null when the frame is unusable, so the caller can drop it instead of
 * opening a provider session with nonsense parameters.
 */
export function normalizeAudioConfig({ sampleRate, channels, encoding } = {}) {
  if (!isFinitePositive(sampleRate)) return null;
  if (sampleRate < MIN_SAMPLE_RATE || sampleRate > MAX_SAMPLE_RATE) return null;

  const channelCount = isFinitePositive(channels) ? Math.trunc(channels) : 1;
  // Realtime STT is a mono feed; a stereo frame would halve the effective rate.
  if (channelCount !== 1) return null;

  const format = typeof encoding === 'string' ? encoding : 'int16';
  // Only 16-bit signed PCM is forwarded. float32 from the mic would need a
  // conversion pass, which the app avoids by requesting int16 directly.
  if (format !== 'int16' && format !== 'pcm16') return null;

  return { sampleRate, channels: channelCount, encoding: 'int16', audioFormat: audioFormatForSampleRate(sampleRate) };
}

/** Bytes -> milliseconds of audio, used for transcript timestamps. */
export function pcmDurationMs(byteLength, sampleRate, channels = 1) {
  if (!isFinitePositive(byteLength) || !isFinitePositive(sampleRate)) return 0;
  const samples = byteLength / 2 / Math.max(1, channels);
  return Math.max(0, Math.round((samples / sampleRate) * 1000));
}
