/**
 * Import limits, shared by the import screen and mirrored on the backend.
 *
 * The backend enforces its own copy (`server/src/limits.js`) because a client
 * limit is only ever a courtesy: the server must reject an oversized body even
 * if the app never sends one.
 */

/** Largest recording Psst will analyse. A 60-minute call at 64 kbps is ~28 MB. */
export const MAX_IMPORT_BYTES = 100 * 1024 * 1024;

/** Longest recording Psst will analyse. Longer calls are out of scope for now. */
export const MAX_IMPORT_DURATION_MS = 4 * 60 * 60 * 1000;

/** Formats a user can import, matched by extension. */
export const SUPPORTED_AUDIO_EXTENSIONS = ['m4a', 'mp3', 'wav', 'aac'] as const;

/** Human-readable list for error copy. */
export const SUPPORTED_AUDIO_LABEL = SUPPORTED_AUDIO_EXTENSIONS.map((extension) =>
  extension.toUpperCase()
).join(', ');
