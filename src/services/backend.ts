/**
 * Psst backend configuration.
 *
 * Phase 2 pipeline:
 *   phone mic -> Psst Expo app -> secure connection -> Psst backend (Azure VM)
 *   -> ElevenLabs realtime STT -> transcript -> conversation state
 *   -> LLM reasoning -> NO_ACTION / PSST -> cue on the phone.
 *
 * The backend endpoint and its optional shared token are public values (they
 * ship inside the app bundle); neither is a secret. Real access control is a
 * server-side entitlement check and lands with Phase 2b.
 *
 * NEVER put ELEVENLABS_API_KEY (or any renamed variant such as
 * EXPO_PUBLIC_ELEVENLABS_API_KEY) in this app: it is a server-side secret and
 * only ever belongs on the backend.
 */

export const PSST_BACKEND_URL = (process.env.EXPO_PUBLIC_PSST_BACKEND_URL ?? '').replace(/\/+$/, '');
/** Optional shared token, only needed when the backend sets PSST_CLIENT_TOKEN. */
export const PSST_BACKEND_TOKEN = process.env.EXPO_PUBLIC_PSST_BACKEND_TOKEN ?? '';

export function isBackendConfigured(): boolean {
  return PSST_BACKEND_URL.length > 0;
}

/** Returns the WebSocket endpoint for a live session, or null if unconfigured. */
export function buildRealtimeSocketUrl(sessionId: string): string | null {
  if (!isBackendConfigured()) return null;
  const base = PSST_BACKEND_URL.replace(/^http/, 'ws');
  const url = `${base}/sessions/${encodeURIComponent(sessionId)}/stream`;
  return PSST_BACKEND_TOKEN === '' ? url : `${url}?token=${encodeURIComponent(PSST_BACKEND_TOKEN)}`;
}
