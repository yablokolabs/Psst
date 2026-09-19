/**
 * Psst backend configuration.
 *
 * Pipeline:
 *   imported recording -> Psst Expo app -> secure upload -> Psst backend
 *   -> batch STT -> transcript -> LLM debrief -> debrief on the phone.
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

/**
 * Builds the analysis endpoint an imported recording is uploaded to.
 *
 * Production requires TLS: a recording is private audio and the backend holds
 * provider credentials, so a release build refuses to send it over plain
 * `http://` instead of silently posting it in the clear. A development build may
 * point at a plain `http://` host on the local network (a phone on the same LAN
 * as a dev server, for example).
 *
 * Metadata travels as query parameters rather than form fields: the body stays
 * the raw audio bytes, so the backend never has to parse multipart and the
 * upload is a single contiguous stream the phone can report progress for.
 */
export interface DebriefUploadRequest {
  /** `https://host[:port][/path]` for the analysis endpoint. */
  url: string;
}

export function buildDebriefEndpoint(options: {
  baseUrl: string;
  token?: string;
  callType: string;
  title: string;
  contact: string;
  durationMs: number;
  development?: boolean;
}): DebriefUploadRequest | { error: string } {
  const baseUrl = (options.baseUrl ?? '').trim().replace(/\/+$/, '');

  if (baseUrl === '') {
    return {
      error:
        'Analysis needs EXPO_PUBLIC_PSST_BACKEND_URL. Add it and rebuild, or use the offline demo debrief.',
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
        'Psst will not upload a recording over an insecure connection in a release build. Use an https:// backend URL.',
    };
  }

  const query = new URLSearchParams({
    callType: options.callType,
    title: options.title,
    contact: options.contact,
    durationMs: String(Math.max(0, Math.round(options.durationMs))),
  });
  const token = options.token ?? '';
  if (token !== '') query.set('token', token);

  // `ws`/`wss` are accepted in configuration for backward compatibility, but an
  // upload is HTTP, so the transport scheme is http/https either way.
  return { url: `${secure ? 'https' : 'http'}://${authority}${basePath}/debrief?${query.toString()}` };
}

/** Resolves the upload endpoint from the configured environment. */
export function resolveDebriefUpload(draft: {
  callType: string;
  title: string;
  contact: string;
  durationMs: number;
}): DebriefUploadRequest | { error: string } {
  return buildDebriefEndpoint({
    baseUrl: PSST_BACKEND_URL,
    token: PSST_BACKEND_TOKEN,
    development: isDevelopmentBuild(),
    ...draft,
  });
}
