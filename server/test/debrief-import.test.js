/**
 * Import analysis tests.
 *
 * These drive the real HTTP endpoint over a real socket, with both providers
 * replaced by local fakes, so the whole wire path is exercised offline: the
 * upload, the multipart request the backend builds, the transcript grouping, the
 * debrief, and every rejection path. Nothing here can cost money or need a
 * provider key.
 *
 * The fakes also let the suite prove what the backend sent: the file bytes, the
 * model, and that the provider key only ever travels in the request header.
 */

import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';

import { startBackend, startFakeBatchStt, startFakeSarvam } from './support/harness.js';

/** Stand-in recording bytes. The backend never parses the container itself. */
const AUDIO = Buffer.alloc(4096, 7);

async function startImport(options = {}) {
  const stt = await startFakeBatchStt(options.stt ?? {});
  const sarvam = await startFakeSarvam(options.sarvam ?? {});
  const backend = await startBackend({
    ELEVENLABS_STT_FILE_ENDPOINT: stt.endpoint,
    SARVAM_ENDPOINT: sarvam.endpoint,
    SARVAM_API_KEY: 'test-sarvam-key-never-sent-anywhere-real',
    PSST_CLIENT_TOKEN: 'test-token',
    ...(options.env ?? {}),
  });

  return {
    stt,
    sarvam,
    backend,
    /** The exact request the app sends: metadata in the query, audio as the body. */
    post(body = AUDIO, { contentType = 'audio/mp4', token = 'test-token', query = '' } = {}) {
      const params = new URLSearchParams({
        callType: 'sales',
        title: 'Acme pilot call',
        contact: 'Priya Raman',
        token,
      });
      return fetch(`${backend.base}/debrief?${params.toString()}${query}`, {
        method: 'POST',
        headers: { 'content-type': contentType },
        body,
      });
    },
    stop: async () => {
      await backend.stop();
      await stt.close();
      await sarvam.close();
    },
  };
}

test('a recording is uploaded, transcribed and turned into a debrief', async () => {
  const harness = await startImport();
  try {
    const response = await harness.post();
    assert.equal(response.status, 200);

    // Read once: a response body can only be consumed a single time.
    const raw = await response.text();
    const body = JSON.parse(raw);
    assert.equal(body.ok, true);
    assert.equal(body.origin, 'backend');
    assert.equal(body.degraded, false);
    assert.match(body.debrief.summary, /pilot call/i);
    assert.equal(body.debrief.commitments[0].what, 'Send the pilot proposal');
    assert.equal(body.debrief.commitments[0].when, 'Friday');
    assert.deepEqual(body.debrief.tasks, ['Send the pilot proposal']);
    assert.equal(body.debrief.risks[0].label, 'Budget timing');
    assert.ok(body.debrief.reminders.length > 0, 'a promised reminder must survive the round trip');

    // Two speakers with a pause between them become separate labelled lines, and
    // the roles stay unresolved rather than guessed.
    const lines = body.transcript.lines;
    assert.ok(lines.length >= 2, `expected grouped lines, got ${JSON.stringify(lines)}`);
    assert.equal(lines[0].speaker, 'unknown');
    assert.equal(lines[0].label, 'Speaker 1');
    assert.equal(lines[1].label, 'Speaker 2');
    assert.match(lines[0].text, /budget/);
    assert.ok(body.transcript.durationMs > 3000, 'the recording length comes from the provider');

    // What the backend actually sent the provider.
    const request = harness.stt.lastRequest();
    assert.ok(request, 'the provider must have been called');
    assert.match(request.contentType, /^multipart\/form-data; boundary=/);
    assert.equal(request.apiKey, 'test-key-never-sent-anywhere-real');
    assert.ok(request.body.includes(AUDIO), 'the file bytes must be in the multipart body');
    assert.match(request.body.toString('latin1'), /name="model_id"/);
    assert.match(request.body.toString('latin1'), /scribe_v2/);
    assert.match(request.body.toString('latin1'), /name="diarize"/);

    // The key travels in a header and must never appear in an app-facing body.
    assert.ok(!raw.includes('test-key-never-sent-anywhere-real'));
    assert.ok(!raw.includes('test-sarvam-key-never-sent-anywhere-real'));
  } finally {
    await harness.stop();
  }
});

test('a transcript still comes back when no analysis model is configured', async () => {
  const harness = await startImport({ env: { SARVAM_API_KEY: '' } });
  try {
    const response = await harness.post();
    assert.equal(response.status, 200, 'the transcript is still worth returning');

    const body = await response.json();
    assert.equal(body.degraded, true);
    assert.ok(body.notice, 'the user is told why there is no summary');
    assert.equal(body.debrief.summary, '');
    assert.ok(body.transcript.lines.length > 0, 'the transcript must survive');
  } finally {
    await harness.stop();
  }
});

test('an oversized recording is refused before it is transcribed', async () => {
  const harness = await startImport({ env: { PSST_MAX_IMPORT_BYTES: '1024' } });
  try {
    const response = await harness.post(Buffer.alloc(4096, 1));
    assert.equal(response.status, 413);
    assert.match((await response.json()).error, /larger than/i);
    assert.equal(harness.stt.requests.length, 0, 'nothing may reach a paid provider');
  } finally {
    await harness.stop();
  }
});

test('a recording longer than the limit is refused after transcription', async () => {
  const harness = await startImport({ env: { PSST_MAX_IMPORT_DURATION_MS: '1000' } });
  try {
    const response = await harness.post();
    assert.equal(response.status, 413);
    assert.match((await response.json()).error, /longer than/i);
  } finally {
    await harness.stop();
  }
});

test('non-audio bodies, empty recordings and bad tokens are refused', async () => {
  const harness = await startImport();
  try {
    const notAudio = await harness.post(AUDIO, { contentType: 'application/json' });
    assert.equal(notAudio.status, 400);
    assert.equal(harness.stt.requests.length, 0);

    const empty = await harness.post(Buffer.alloc(0));
    assert.equal(empty.status, 400);

    const wrongToken = await harness.post(AUDIO, { token: 'not-the-token' });
    assert.equal(wrongToken.status, 401);
    assert.equal(harness.stt.requests.length, 0, 'an unauthenticated upload never reaches a provider');
  } finally {
    await harness.stop();
  }
});

test('a provider failure is answered and the backend survives it', async () => {
  const harness = await startImport({ stt: { status: 500 } });
  try {
    const response = await harness.post();
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /could not transcribe/i);

    // The important part: one failed import must not take the process down.
    const health = await harness.backend.health();
    assert.equal(health.status, 'ok');
  } finally {
    await harness.stop();
  }
});

test('imports are rate limited per minute', async () => {
  const harness = await startImport({ env: { PSST_MAX_IMPORTS_PER_MINUTE: '2' } });
  try {
    assert.equal((await harness.post()).status, 200);
    assert.equal((await harness.post()).status, 200);

    const limited = await harness.post();
    assert.equal(limited.status, 429);
    assert.match((await limited.json()).error, /try again/i);
  } finally {
    await harness.stop();
  }
});

test('an abandoned upload does not crash the process', async () => {
  const harness = await startImport();
  try {
    // Announce far more body than we send, then vanish mid-request.
    await new Promise((resolve) => {
      const socket = net.connect(harness.backend.port, '127.0.0.1', () => {
        socket.write(
          `POST /debrief?token=test-token HTTP/1.1\r\nHost: psst.test\r\n` +
            `Content-Type: audio/mp4\r\nContent-Length: 500000\r\n\r\n`
        );
        socket.write(Buffer.alloc(512, 3));
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 80);
      });
      socket.on('error', () => resolve());
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    const health = await harness.backend.health();
    assert.equal(health.status, 'ok', 'the backend must survive a half-sent upload');
  } finally {
    await harness.stop();
  }
});

test('/health reports import readiness without leaking key material', async () => {
  const harness = await startImport();
  try {
    const health = await harness.backend.health();
    assert.equal(health.importAnalysisReady, true);
    assert.equal(health.batchSttModel, 'scribe_v2');
    assert.equal(health.tokenRequired, true);
    assert.equal(typeof health.limits.maxImportBytes, 'number');
    assert.equal(typeof health.limits.maxConcurrentImports, 'number');

    const serialized = JSON.stringify(health);
    assert.ok(!serialized.includes('test-key-never-sent-anywhere-real'));
    assert.ok(!serialized.includes('test-sarvam-key-never-sent-anywhere-real'));
    assert.ok(!/"apiKey"/i.test(serialized), 'no key field of any kind in /health');
  } finally {
    await harness.stop();
  }
});
