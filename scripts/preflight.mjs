#!/usr/bin/env node
/**
 * Device-run preflight.
 *
 * Answers one question before you pick up the phone: *will the device's exact
 * endpoint accept a session right now?* It walks the same path the app walks —
 * `GET /health`, then a real WebSocket session (`session.start` -> `listening`
 * -> `session.stop` -> `recap` -> `ended`) over the URL you are about to build
 * into the app.
 *
 * It is deliberately cheap and safe:
 *   - no audio frames are sent, so no STT session is opened and no transcription
 *     credit is used
 *   - no transcript exists at the end, so the recap is built locally without a
 *     model call
 *   - it uses one session slot for a few seconds and disconnects
 *
 * Usage:
 *   npm run preflight                              # EXPO_PUBLIC_PSST_BACKEND_URL
 *   npm run preflight -- --url https://tunnel.example.com
 *   npm run preflight -- --url http://127.0.0.1:8787   # local backend only
 *
 * The URL handling mirrors `src/services/backend.ts`: `https` becomes `wss`,
 * `http` becomes `ws`. A **release** build (the `preview`/`production` profiles)
 * refuses a non-TLS backend, so `http`/`ws` is only useful for a development
 * build or for a local check.
 */

const HEALTH_TIMEOUT_MS = 10000;
const SOCKET_OPEN_TIMEOUT_MS = 10000;
const LISTENING_TIMEOUT_MS = 10000;
const RECAP_TIMEOUT_MS = 15000;

/** Mirrors the base-URL handling in `src/services/backend.ts`. */
const BACKEND_URL_PATTERN = /^(https?|wss?):\/\/([^/?#\s]+)(\/[^?#\s]*)?$/i;

function readArgs(argv) {
  const args = { url: process.env.EXPO_PUBLIC_PSST_BACKEND_URL ?? '', token: process.env.EXPO_PUBLIC_PSST_BACKEND_TOKEN ?? '' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--url') args.url = argv[index + 1] ?? '';
    else if (value === '--token') args.token = argv[index + 1] ?? '';
  }
  return args;
}

function report(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`);
  if (!ok) process.exitCode = 1;
  return ok;
}

function note(label, detail = '') {
  console.log(`      ${label}${detail === '' ? '' : ` — ${detail}`}`);
}

/** A problem worth knowing about that does not, on its own, block the run. */
function warn(label, detail = '') {
  console.log(`WARN  ${label}${detail === '' ? '' : ` — ${detail}`}`);
}

/** Loopback or private address: reachable only from this machine or its LAN. */
function isPrivateHost(hostname) {
  return (
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === '127.0.0.1' ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  );
}

/** `https://host` -> `wss://host/sessions/<id>/stream`, mirroring the app. */
function toSocketUrl(baseUrl, sessionId, token) {
  const match = BACKEND_URL_PATTERN.exec(baseUrl.trim().replace(/\/+$/, ''));
  if (!match) return null;

  const scheme = match[1].toLowerCase();
  const secure = scheme === 'https' || scheme === 'wss';
  const url = `${secure ? 'wss' : 'ws'}://${match[2]}${match[3] ?? ''}/sessions/${encodeURIComponent(
    sessionId
  )}/stream`;

  return { url: token === '' ? url : `${url}?token=${encodeURIComponent(token)}`, secure };
}

async function checkHealth(baseUrl) {
  let response;
  try {
    response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
  } catch (error) {
    return { ok: false, detail: `GET /health failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  if (!response.ok) return { ok: false, detail: `GET /health returned HTTP ${response.status}` };

  let health;
  try {
    health = await response.json();
  } catch {
    return { ok: false, detail: 'GET /health returned non-JSON' };
  }

  return { ok: true, health };
}

/**
 * One full session over the real URL: start, listening, stop, recap, ended.
 * Resolves with per-step timings so a slow link is visible before the run.
 */
function checkSession(socketUrl) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const steps = {};
    const frames = [];
    const socket = new WebSocket(socketUrl);

    const finish = (ok, detail) => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Already closing.
      }
      resolve({ ok, detail, steps, frames });
    };

    const timer = setTimeout(() => finish(false, 'timed out waiting for the session to finish'), RECAP_TIMEOUT_MS);

    socket.onopen = () => {
      steps.openedMs = Date.now() - startedAt;
      socket.send(
        JSON.stringify({
          t: 'session.start',
          goal: {
            title: 'Preflight check',
            objective: 'Confirm the device endpoint accepts a session.',
            notes: '',
            preset: 'other',
          },
          client: { platform: 'preflight', appVersion: '1.0.0' },
        })
      );
    };

    socket.onerror = (event) => {
      finish(false, `WebSocket error: ${event?.message ?? 'connection failed'}`);
    };

    socket.onmessage = (event) => {
      let message = null;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      frames.push(message.t);

      if (message.t === 'status' && message.status === 'listening' && !steps.listeningMs) {
        steps.listeningMs = Date.now() - startedAt;
        // Nothing to transcribe: end immediately, which is exactly the recap
        // path the device exercises when a user taps End.
        socket.send(JSON.stringify({ t: 'session.stop' }));
      } else if (message.t === 'status' && message.status === 'ended') {
        steps.endedMs = Date.now() - startedAt;
      } else if (message.t === 'recap') {
        steps.recapMs = Date.now() - startedAt;
        finish(true, `recap "${message.recap?.title ?? '(untitled)'}" in ${steps.recapMs} ms`);
      } else if (message.t === 'error') {
        finish(false, `backend error frame: ${message.message}`);
      }
    };

    socket.onclose = (event) => {
      if (process.exitCode === 1) return;
      if (steps.recapMs) return;
      finish(false, `socket closed before the recap (code ${event?.code ?? '?'})`);
    };
  });
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  const baseUrl = (args.url.trim() || 'http://127.0.0.1:8787').replace(/\/+$/, '');

  console.log('Psst preflight — device run\n');

  const target = toSocketUrl(baseUrl, 'preflight-check', args.token);
  if (!target) {
    report(false, 'backend URL', `"${baseUrl}" is not a valid URL. Use https://your-backend.example.com`);
    return;
  }

  const socketHost = new URL(target.url).hostname;
  const privateHost = isPrivateHost(socketHost);

  if (target.secure) {
    report(true, 'TLS transport', 'https/wss, accepted by release builds');
  } else if (privateHost) {
    // Fine for a local check or a development build; a release build refuses it.
    warn('TLS transport', `${baseUrl} is http/ws — a release (preview/production) build will refuse it`);
  } else {
    report(false, 'TLS transport', `${baseUrl} is http/ws — a release build refuses to stream audio over it`);
    note('use an https URL for the phone:', 'a Cloudflare quick tunnel gives one without a domain');
  }

  const health = await checkHealth(baseUrl);
  if (!health.ok) {
    report(false, 'backend reachable', health.detail);
    return;
  }
  report(true, 'backend reachable', `${baseUrl}/health`);

  const { health: data } = health;
  report(data.status === 'ok', 'health status', String(data.status));
  report(data.elevenlabsConfigured === true, 'ElevenLabs configured (server-side)', String(data.elevenlabsConfigured));
  report(data.sarvamConfigured === true, 'Sarvam configured (server-side)', String(data.sarvamConfigured));
  note('commit strategy', String(data.elevenlabsCommitStrategy ?? '?'));
  note('language code', String(data.elevenlabsLanguageCode ?? '(auto)'));
  note('min cue interval', `${data.minCueIntervalMs ?? '?'} ms`);
  note('active sessions', `${data.activeSessions ?? '?'} / ${data.limits?.maxSessions ?? '?'}`);
  note(
    'session ceilings',
    `audio ${data.limits?.maxSessionAudioBytes ?? '?'} B, duration ${data.limits?.maxSessionDurationMs ?? '?'} ms, idle ${data.limits?.idleTimeoutMs ?? '?'} ms`
  );

  const serialized = JSON.stringify(data);
  report(
    !/(apiKey|api_key|secret|xi-api-key)/i.test(serialized),
    'no credential fields in /health',
    'keys stay server-side'
  );

  const session = await checkSession(target.url);
  report(session.ok, 'full session over the device URL', session.detail);
  if (session.steps.openedMs !== undefined) note('handshake', `${session.steps.openedMs} ms`);
  if (session.steps.listeningMs !== undefined) note('to listening', `${session.steps.listeningMs} ms`);
  if (session.steps.recapMs !== undefined) note('to recap', `${session.steps.recapMs} ms`);
  note('frames', session.frames.join(', ') || '(none)');

  if (process.exitCode === 1) {
    console.log('\nFix the FAIL lines above before starting a phone run.');
    return;
  }

  console.log('\nReady for the S24 run.');
  if (privateHost || !target.secure) {
    console.log('NOTE: that was a local check. The phone cannot reach a private address — build with a public https URL.');
  }
  console.log(`Bake this into the build:  EXPO_PUBLIC_PSST_BACKEND_URL=${baseUrl}`);
  console.log('Then follow the S24 acceptance checklist in README.md.');
}

await main();
