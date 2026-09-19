#!/usr/bin/env node
/**
 * Device-run preflight.
 *
 * Answers one question before you pick up the phone: *will the app's exact
 * endpoint do the import right now?* It checks the same URL, over the same
 * transport, that the build bakes in.
 *
 * It is deliberately cheap and safe:
 *   - `GET /health` only reports booleans, names and numbers
 *   - the two POSTs are rejected **before** any audio is read: one has a
 *     non-audio content type, one omits the token when a token is required
 *   - no recording is uploaded, so no transcription credit is used and no
 *     provider call is made
 *
 * Usage:
 *   npm run preflight                                       # EXPO_PUBLIC_PSST_BACKEND_URL
 *   npm run preflight -- --url https://psst.example.com
 *   npm run preflight -- --url http://127.0.0.1:8787        # local backend only
 *
 * The URL handling mirrors `src/services/backend.ts`: `https` stays secure. A
 * **release** build (the `preview`/`production` profiles) refuses a non-TLS
 * backend, so `http` is only useful for a development build or a local check.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** scripts/preflight.mjs -> repository root. */
const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * Loads the app's own `.env`, because only the Expo CLI does that automatically:
 * a plain `npm run` script would otherwise see no `EXPO_PUBLIC_*` values at all.
 * Real environment variables still win (`process.loadEnvFile` never replaces an
 * existing variable), so an explicit export or `--url` always takes precedence.
 */
function loadLocalEnv() {
  const file = path.join(REPO_ROOT, '.env');
  if (!existsSync(file)) return;
  try {
    process.loadEnvFile(file);
  } catch {
    // A malformed .env is not fatal here: the checks below report what is missing.
  }
}

const HEALTH_TIMEOUT_MS = 10000;
const REJECT_TIMEOUT_MS = 10000;

/** Mirrors the base-URL handling in `src/services/backend.ts`. */
const BACKEND_URL_PATTERN = /^(https?|wss?):\/\/([^/?#\s]+)(\/[^?#\s]*)?$/i;

function readArgs(argv) {
  const args = {
    url: process.env.EXPO_PUBLIC_PSST_BACKEND_URL ?? '',
    token: process.env.EXPO_PUBLIC_PSST_BACKEND_TOKEN ?? '',
  };
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

/** Parses the configured base URL the way the app does. */
function parseBackendUrl(baseUrl) {
  const match = BACKEND_URL_PATTERN.exec((baseUrl ?? '').trim().replace(/\/+$/, ''));
  if (!match) return null;

  const scheme = match[1].toLowerCase();
  const secure = scheme === 'https' || scheme === 'wss';
  return {
    secure,
    base: `${secure ? 'https' : 'http'}://${match[2]}${match[3] ?? ''}`,
  };
}

async function checkHealth(baseUrl) {
  let response;
  try {
    response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
  } catch (error) {
    return {
      ok: false,
      detail: `GET /health failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!response.ok) return { ok: false, detail: `GET /health returned HTTP ${response.status}` };

  try {
    return { ok: true, health: await response.json() };
  } catch {
    return { ok: false, detail: 'GET /health returned non-JSON' };
  }
}

/**
 * One rejection the backend must produce without reading any audio.
 *
 * This is the whole point of the preflight: it proves the import route exists,
 * that the transport works from this URL, and that the gate in front of the
 * provider behaves, at zero cost.
 */
async function expectRejection(baseUrl, { label, contentType, token }) {
  const params = new URLSearchParams({ callType: 'other', title: 'preflight', contact: '' });
  if (token) params.set('token', token);

  let response;
  try {
    response = await fetch(`${baseUrl}/debrief?${params.toString()}`, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: Buffer.from('preflight-probe'),
      signal: AbortSignal.timeout(REJECT_TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, detail: `${label}: request failed (${error instanceof Error ? error.message : String(error)})` };
  }

  let message = '';
  try {
    message = String((await response.json())?.error ?? '');
  } catch {
    message = '';
  }
  return { ok: true, status: response.status, message };
}

async function main() {
  loadLocalEnv();
  const args = readArgs(process.argv.slice(2));
  const rawBase = args.url.trim() || 'http://127.0.0.1:8787';
  const parsed = parseBackendUrl(rawBase);

  console.log('Psst preflight — import path\n');

  if (!parsed) {
    report(false, 'backend URL', `"${rawBase}" is not a valid URL. Use https://your-backend.example.com`);
    return;
  }

  const baseUrl = parsed.base;
  const host = new URL(baseUrl).hostname;
  const privateHost = isPrivateHost(host);

  if (parsed.secure) {
    report(true, 'TLS transport', 'https, accepted by release builds');
  } else if (privateHost) {
    warn('TLS transport', `${baseUrl} is http — a release (preview/production) build will refuse to upload to it`);
  } else {
    report(false, 'TLS transport', `${baseUrl} is http — a release build refuses to upload a recording over it`);
    note('use an https URL for the phone', 'a Cloudflare tunnel or the named tunnel gives you one');
  }

  const health = await checkHealth(baseUrl);
  if (!health.ok) {
    report(false, 'backend reachable', health.detail);
    return;
  }
  report(true, 'backend reachable', `${baseUrl}/health`);

  const { health: data } = health;
  const limits = data.limits ?? {};

  report(data.status === 'ok', 'health status', String(data.status));
  report(data.importAnalysisReady === true, 'import analysis ready', String(data.importAnalysisReady));
  report(data.elevenlabsConfigured === true, 'ElevenLabs configured (server-side)', String(data.elevenlabsConfigured));
  note('batch model', String(data.batchSttModel ?? '?'));
  note('diarization', String(data.batchSttDiarize ?? '?'));
  note('analysis model', `${data.sarvamConfigured === true ? data.sarvamModel : 'not configured — transcript only'}`);
  note('import ceilings', `bytes ${limits.maxImportBytes ?? '?'}, duration ${limits.maxImportDurationMs ?? '?'} ms`);
  note('import throughput', `${limits.maxImportsPerMinute ?? '?'}/min, ${limits.maxConcurrentImports ?? '?'} at once`);
  note('active imports', String(data.activeImports ?? '?'));
  note('token required', String(data.tokenRequired ?? '?'));

  const serialized = JSON.stringify(data);
  report(
    !/(apiKey|api_key|secret|xi-api-key)/i.test(serialized),
    'no credential fields in /health',
    'keys stay server-side'
  );

  const wrongType = await expectRejection(baseUrl, {
    label: 'non-audio upload',
    contentType: 'application/json',
    token: args.token,
  });
  report(
    wrongType.ok && wrongType.status === 400,
    'the import route rejects a non-audio body',
    wrongType.ok ? `HTTP ${wrongType.status}${wrongType.message ? ` — ${wrongType.message}` : ''}` : wrongType.detail
  );

  if (data.tokenRequired === true) {
    const noToken = await expectRejection(baseUrl, {
      label: 'missing token',
      contentType: 'audio/mp4',
      token: '',
    });
    report(
      noToken.ok && noToken.status === 401,
      'the import route requires the token this build sends',
      noToken.ok ? `HTTP ${noToken.status}` : noToken.detail
    );

    if (args.token === '') {
      warn('no client token in this shell', 'EXPO_PUBLIC_PSST_BACKEND_TOKEN is empty, so a real import would be refused');
    }
  }

  if (process.exitCode === 1) {
    console.log('\nFix the FAIL lines above before starting a phone run.');
    return;
  }

  console.log('\nThe import path is reachable from this URL.');
  if (privateHost || !parsed.secure) {
    console.log('NOTE: that was a local check. A phone cannot reach a private address — build with a public https URL.');
  }
  console.log(`Bake this into the build:  EXPO_PUBLIC_PSST_BACKEND_URL=${baseUrl}`);
  console.log('Then follow the S24 acceptance checklist in README.md.');
  console.log('\n(No recording was uploaded and no provider call was made.)');
}

await main();
