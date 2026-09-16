/**
 * Psst backend configuration.
 *
 * Pipeline:
 *   phone mic -> Psst Expo app -> secure connection -> Psst backend
 *   -> ElevenLabs realtime STT -> transcript -> conversation state
 *   -> LLM reasoning -> NO_ACTION / PSST -> cue on the phone.
 *
 * The backend endpoint and its optional shared token are public values (they
 * ship inside the app bundle); neither is a secret. The shared token is a
 * throttle, not authentication — real authorization (checking the caller's Psst
 * Pro entitlement) is a server-side feature that lands before public release.
 *
 * NEVER put ELEVENLABS_API_KEY (or any renamed variant such as
 * EXPO_PUBLIC_ELEVENLABS_API_KEY) in this app: it is a server-side secret and
 * only ever belongs on the backend.
 */

export const PSST_BACKEND_URL = (process.env.EXPO_PUBLIC_PSST_BACKEND_URL ?? '').replace(/\/+$/, '');
/** Optional shared token, only needed when the backend sets PSST_CLIENT_TOKEN. */
export const PSST_BACKEND_TOKEN = process.env.EXPO_PUBLIC_PSST_BACKEND_TOKEN ?? '';

/** `https://host[:port][/path]` — the only shape a backend URL may take. */
const BACKEND_URL_PATTERN = /^(https?|wss?):\/\/([^/?#\s]+)(\/[^?#\s]*)?$/i;

export function isBackendConfigured(): boolean {
  return PSST_BACKEND_URL.length > 0;
}

/** True in a development build, where an insecure local backend is acceptable. */
function isDevelopmentBuild(): boolean {
  return typeof globalThis !== 'undefined' && (globalThis as { __DEV__?: unknown }).__DEV__ === true;
}

export type RealtimeSocketTarget = { url: string } | { error: string };

/**
 * Builds the WebSocket endpoint for a live session from an explicit base URL.
 *
 * Production requires TLS: microphone audio is streamed continuously to a
 * backend that holds provider credentials, so a release build refuses to open an
 * insecure `ws://` connection instead of silently downgrading `http://` to it.
 * A development build may point at a plain `http://`/`ws://` host on the local
 * network (a phone on the same LAN as a dev server, for example).
 *
 * `https` becomes `wss` and `http` becomes `ws`; the scheme is never left
 * implicit, because an insecure transport is the failure mode this guards.
 */
export function buildRealtimeSocketUrl(options: {
  baseUrl: string;
  sessionId: string;
  token?: string;
  /** Development builds may use a plain http/ws backend. */
  development?: boolean;
}): RealtimeSocketTarget {
  const baseUrl = (options.baseUrl ?? '').trim().replace(/\/+$/, '');

  if (baseUrl === '') {
    return {
      error:
        'Realtime sessions need EXPO_PUBLIC_PSST_BACKEND_URL. Add it and rebuild to stream audio.',
    };
  }

  const match = BACKEND_URL_PATTERN.exec(baseUrl);
  if (!match) {
    return {
      error: `"${baseUrl}" is not a valid Psst backend URL. Use https://your-psst-backend.example.com.`,
    };
  }

  const scheme = match[1].toLowerCase();
  const authority = match[2];
  const basePath = match[3] ?? '';
  const secure = scheme === 'https' || scheme === 'wss';

  if (!secure && options.development !== true) {
    return {
      error:
        'Psst will not stream audio over an insecure connection in a release build. Use an https:// backend URL.',
    };
  }

  const url = `${secure ? 'wss' : 'ws'}://${authority}${basePath}/sessions/${encodeURIComponent(
    options.sessionId
  )}/stream`;

  const token = options.token ?? '';
  return { url: token === '' ? url : `${url}?token=${encodeURIComponent(token)}` };
}

/** Resolves the endpoint for a live session from the configured environment. */
export function resolveRealtimeSocketTarget(sessionId: string): RealtimeSocketTarget {
  return buildRealtimeSocketUrl({
    baseUrl: PSST_BACKEND_URL,
    sessionId,
    token: PSST_BACKEND_TOKEN,
    development: isDevelopmentBuild(),
  });
}
