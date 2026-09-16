/**
 * ElevenLabs client regression tests — all offline.
 *
 * The provider is replaced by a local WebSocket server that speaks the
 * documented realtime protocol, so the production client code (URL building,
 * queueing, flush, shutdown) is exercised for real without any provider call.
 */

import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

// Environment first: limits.js reads these at import time and
// `process.loadEnvFile()` never overwrites a value that is already set, so these
// always win over the repository .env.
process.env.ELEVENLABS_API_KEY = 'test-key-never-sent-anywhere-real';
process.env.SARVAM_API_KEY = '';
process.env.PSST_MAX_PROVIDER_QUEUE_BYTES = '16384';
process.env.PSST_PROVIDER_QUEUE_MAX_AGE_MS = '200';
process.env.PSST_MAX_PROVIDER_BUFFERED_BYTES = '65536';

const { getElevenLabsConfig, openTranscriptionSession } = await import('../src/elevenlabs.js');
const { LIMITS } = await import('../src/limits.js');
const { pcmSilence, startFakeProvider, startHangingProvider, waitFor } = await import(
  './support/harness.js'
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const b64 = (ms, rate) => pcmSilence(ms, rate).toString('base64');

/** Collects uncaught exceptions so a crash is an assertion, not a dead test run. */
function trapUncaught() {
  const errors = [];
  const handler = (error) => errors.push(error);
  process.on('uncaughtException', handler);
  return {
    errors,
    release: () => process.off('uncaughtException', handler),
  };
}

let fake = null;

before(async () => {
  fake = await startFakeProvider();
  process.env.ELEVENLABS_STT_ENDPOINT = fake.endpoint;
});

after(async () => {
  if (fake) await fake.close();
});

test('the delivered sample rate reaches the provider unchanged', async () => {
  for (const sampleRate of [16000, 44100, 48000]) {
    const provider = await startFakeProvider();
    process.env.ELEVENLABS_STT_ENDPOINT = provider.endpoint;

    const session = openTranscriptionSession({});
    session.sendAudio(b64(100, sampleRate), sampleRate);

    await waitFor(() => provider.audioChunks().length > 0, { description: `${sampleRate} Hz chunk` });
    const chunk = provider.audioChunks()[0];

    assert.equal(chunk.sample_rate, sampleRate, 'the chunk must carry the real rate');
    assert.equal(
      provider.query().get('audio_format'),
      `pcm_${sampleRate}`,
      'the provider format must match the real rate, never a nearby one'
    );
    assert.equal(provider.query().get('commit_strategy'), 'vad');
    assert.equal(session.stats().sampleRate, sampleRate);

    session.close();
    await provider.close();
    process.env.ELEVENLABS_STT_ENDPOINT = fake.endpoint;
  }
});

test('a rate the provider does not accept is refused instead of relabelled', async () => {
  const provider = await startFakeProvider();
  process.env.ELEVENLABS_STT_ENDPOINT = provider.endpoint;

  const session = openTranscriptionSession({});
  assert.equal(session.sendAudio(b64(100, 16000), 32000), false, '32000 Hz must be refused');

  await sleep(150);
  assert.equal(provider.state.connections, 0, 'no provider session may be opened for it');
  assert.equal(session.isOpen(), false);
  assert.equal(session.stats().sampleRate, 16000, 'the session rate is untouched');

  session.close();
  await provider.close();
  process.env.ELEVENLABS_STT_ENDPOINT = fake.endpoint;
});

test('ELEVENLABS_STT_LANGUAGE is wired into the actual connection', async () => {
  const provider = await startFakeProvider();
  process.env.ELEVENLABS_STT_ENDPOINT = provider.endpoint;
  process.env.ELEVENLABS_STT_LANGUAGE = 'hi';

  assert.equal(getElevenLabsConfig().languageCode, 'hi');

  const session = openTranscriptionSession({});
  session.sendAudio(b64(100, 16000), 16000);
  await waitFor(() => provider.state.connections > 0, { description: 'provider connection' });

  assert.equal(provider.query().get('language_code'), 'hi');

  session.close();
  await provider.close();
  delete process.env.ELEVENLABS_STT_LANGUAGE;
  process.env.ELEVENLABS_STT_ENDPOINT = fake.endpoint;
});

test('commit strategy: manual is honoured, unknown values fall back to vad', () => {
  process.env.ELEVENLABS_STT_COMMIT_STRATEGY = 'manual';
  assert.equal(getElevenLabsConfig().commitStrategy, 'manual');
  assert.equal(getElevenLabsConfig().commitStrategyRejected, false);

  process.env.ELEVENLABS_STT_COMMIT_STRATEGY = 'sometimes';
  assert.equal(getElevenLabsConfig().commitStrategy, 'vad');
  assert.equal(getElevenLabsConfig().commitStrategyRejected, true);

  delete process.env.ELEVENLABS_STT_COMMIT_STRATEGY;
  assert.equal(getElevenLabsConfig().commitStrategy, 'vad');
});

test('audio waiting for the provider is bounded by bytes, never by chunk count', async () => {
  const provider = await startFakeProvider({ announceSession: false });
  process.env.ELEVENLABS_STT_ENDPOINT = provider.endpoint;

  const congestion = [];
  const session = openTranscriptionSession({
    onCongestion: (info) => congestion.push(info),
  });

  // Far more audio than the byte ceiling, sent before the provider is ready.
  for (let index = 0; index < 12; index += 1) {
    session.sendAudio(b64(50, 16000), 16000);
  }

  const stats = session.stats();
  assert.ok(stats.queuedBytes <= LIMITS.maxProviderQueueBytes, `queued ${stats.queuedBytes} bytes`);
  assert.ok(stats.droppedChunks > 0, 'the oldest audio must be dropped');
  assert.ok(congestion.length > 0, 'congestion must be reported');
  assert.equal(congestion[0].reason, 'queue-full');

  session.close();
  await provider.close();
  process.env.ELEVENLABS_STT_ENDPOINT = fake.endpoint;
});

test('audio waiting for the provider is bounded by age', async () => {
  const provider = await startFakeProvider({ announceSession: false });
  process.env.ELEVENLABS_STT_ENDPOINT = provider.endpoint;

  const session = openTranscriptionSession({});
  session.sendAudio(b64(20, 16000), 16000);
  assert.equal(session.stats().queuedChunks, 1);

  await sleep(LIMITS.providerQueueMaxAgeMs + 120);

  session.sendAudio(b64(20, 16000), 16000);
  const stats = session.stats();
  assert.equal(stats.queuedChunks, 1, 'stale audio is discarded when new audio arrives');
  assert.ok(stats.droppedChunks > 0);

  session.close();
  await provider.close();
  process.env.ELEVENLABS_STT_ENDPOINT = fake.endpoint;
});

test('flush() uses the documented empty commit chunk and waits for the transcript', async () => {
  const provider = await startFakeProvider({ commitText: 'We can do two thousand a month.' });
  process.env.ELEVENLABS_STT_ENDPOINT = provider.endpoint;

  const finals = [];
  const session = openTranscriptionSession({ onFinal: (text) => finals.push(text) });

  session.sendAudio(b64(100, 16000), 16000);
  await waitFor(() => provider.audioChunks().length > 0, { description: 'first audio chunk' });

  const committed = await session.flush();
  assert.equal(committed, true, 'flush resolves once the committed transcript lands');
  assert.deepEqual(finals, ['We can do two thousand a month.']);

  const flushChunk = provider.flushChunks()[0];
  assert.equal(flushChunk.commit, true);
  assert.equal(flushChunk.audio_base_64, '');
  assert.equal(flushChunk.sample_rate, 16000);

  session.close();
  process.env.ELEVENLABS_STT_ENDPOINT = fake.endpoint;
  await provider.close();
});

test('flush() on a session that never opened resolves false without hanging', async () => {
  const session = openTranscriptionSession({});
  assert.equal(await session.flush(), false);
  session.close();
});

test('closing a socket that is still CONNECTING does not raise an unhandled error', async () => {
  const uncaught = trapUncaught();
  const hanging = await startHangingProvider();
  process.env.ELEVENLABS_STT_ENDPOINT = hanging.endpoint;

  try {
    const session = openTranscriptionSession({});
    session.sendAudio(b64(20, 16000), 16000);
    // The handshake has not completed: this is exactly the path that used to
    // take the backend down asynchronously.
    session.close();

    await sleep(400);
    assert.deepEqual(uncaught.errors.map((error) => error.message), []);
  } finally {
    uncaught.release();
    await hanging.close();
    process.env.ELEVENLABS_STT_ENDPOINT = fake.endpoint;
  }
});

test('a stalled handshake reports an error bounded by the open timeout', async () => {
  const uncaught = trapUncaught();
  const hanging = await startHangingProvider();
  process.env.ELEVENLABS_STT_ENDPOINT = hanging.endpoint;
  process.env.PSST_STT_OPEN_TIMEOUT_MS = '150';

  try {
    const errors = [];
    const session = openTranscriptionSession({ onError: (message) => errors.push(message) });
    session.sendAudio(b64(20, 16000), 16000);

    await waitFor(() => errors.length > 0, { timeoutMs: 3000, description: 'provider error' });
    assert.match(errors[0], /did not start the transcription session in time/);
    assert.equal(session.isOpen(), false);

    await sleep(200);
    assert.deepEqual(uncaught.errors.map((error) => error.message), []);
    session.close();
  } finally {
    uncaught.release();
    delete process.env.PSST_STT_OPEN_TIMEOUT_MS;
    await hanging.close();
    process.env.ELEVENLABS_STT_ENDPOINT = fake.endpoint;
  }
});

test('sendAudio refuses everything once the session is closed', async () => {
  const session = openTranscriptionSession({});
  session.close();
  assert.equal(session.sendAudio(b64(20, 16000), 16000), false);
  assert.equal(await session.flush(), false);
});
