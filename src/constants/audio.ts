/**
 * Microphone capture format.
 *
 * Chosen so nothing in the pipeline has to transcode:
 *
 *   device mic -> PCM16 little-endian mono @ 16 kHz -> base64 -> WebSocket
 *   -> backend -> ElevenLabs realtime STT (`pcm_16000`)
 *
 * 16 kHz mono is the standard speech rate and the format the realtime STT
 * endpoint expects, so the bytes we capture are the bytes the model receives.
 *
 * If the device cannot deliver 16 kHz, the buffer carries the rate it actually
 * delivered and that rate is forwarded unchanged: the backend selects the
 * matching PCM format rather than resampling.
 */

/** Requested capture rate in Hz. */
export const MIC_SAMPLE_RATE = 16000;
/** Mono: realtime STT is a single-channel feed. */
export const MIC_CHANNELS = 1;
/** 16-bit signed little-endian PCM. */
export const MIC_ENCODING = 'int16' as const;

/**
 * Largest payload sent in one `audio.frame`. Anything bigger is split so a
 * single oversized buffer can never produce a frame the backend has to reject.
 */
export const AUDIO_FRAME_MAX_BYTES = 32 * 1024;
