/**
 * End-to-end wire tests against a spawned backend.
 *
 * These drive the real server over a real WebSocket connection with a local fake
 * STT endpoint, so nothing here is mocked at the protocol level:
 *
 *   test client -> ws -> src/index.js -> session -> transcription -> STT client
 *              -> fake provider
 *
 * No provider credit is used and no microphone is needed.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocket } from 'ws';

import {
  audioFrame,
  connectSession,
  pcmSilence,
  startBackend,
  startFakeProvider,
  startMessage,
  waitFor,
} from './support/harness.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Spawns a backend wired to a fresh fake provider. */
async function harness(env = {}, providerOptions = {}) {
  const fake = await startFakeProvider(providerOptions);
  const backend = await startBackend({
    ELEVENLABS_STT_ENDPOINT: fake.endpoint,
    ...env,
  });
  return {
    fake,
    backend,
    close: async () => {
      await backend.stop();
      await fake.close();
    },
  };
}

test('the backend survives a malformed audio frame and keeps the session alive', async () => {
  const { backend, close } = await harness();

  try {
    const client = await connectSession(backend.wsUrl('malformed'));
    await client.open();
    client.send(startMessage());
    await client.waitFor((message) => message.t === 'status' && message.status === 'listening');

    // Exactly the frame that killed the process before this fix.
    client.send(JSON.stringify({ t: 'audio.frame', pcm: 'AA==', audio: null }));
    client.send(JSON.stringify({ t: 'audio.frame', pcm: 'AAAA' }));
    client.send(JSON.stringify({ t: 'audio.frame', pcm: 12, audio: 7 }));
    client.send(JSON.stringify({ t: 'audio.frame', audio: null, byteLength: 'nope' }));
    await sleep(250);

    assert.equal(backend.exited(), null, 'the backend must not exit on malformed input');

    // Proof of life: the session still answers control frames.
    client.send({ t: 'session.pause' });
    await client.waitFor((message) => message.t === 'status' && message.status === 'paused');
    client.send({ t: 'session.resume' });
    await client.waitFor((message) => message.t === 'status' && message.status === 'listening');
    client.close();
  } finally {
    await close();
  }
});

test('the delivered sample rate survives the whole wire, unchanged', async () => {
  const { fake, backend, close } = await harness();

  try {
    for (const sampleRate of [16000, 44100, 48000]) {
      const client = await connectSession(backend.wsUrl(`rate-${sampleRate}`));
      await client.open();
      client.send(startMessage());
      await client.waitFor((message) => message.t === 'status' && message.status === 'listening');

      client.send(audioFrame({ pcm: pcmSilence(100, sampleRate), sampleRate, seq: 1 }));

      const chunk = await waitFor(
        () => fake.audioChunks().find((candidate) => candidate.sample_rate === sampleRate),
        { description: `${sampleRate} Hz chunk at the provider` }
      );

      const query = new URLSearchParams(chunk.url.split('?')[1]);
      assert.equal(
        query.get('audio_format'),
        `pcm_${sampleRate}`,
        'the provider format must match the audio it was actually given'
      );
      assert.notEqual(chunk.audio_base_64, '');

      client.close();
    }
  } finally {
    await close();
  }
});

test('an unsupported sample rate is rejected with an explanation, not relabelled', async () => {
  const { fake, backend, close } = await harness();

  try {
    const client = await connectSession(backend.wsUrl('unsupported-rate'));
    await client.open();
    client.send(startMessage());
    await client.waitFor((message) => message.t === 'status' && message.status === 'listening');

    client.send(audioFrame({ pcm: pcmSilence(100, 32000), sampleRate: 32000, seq: 1 }));

    const notice = await client.waitFor(
      (message) => message.t === 'notice' && /sample rate/.test(message.message)
    );
    assert.equal(notice.level, 'warning');
    assert.match(notice.message, /32000 Hz/);

    await sleep(150);
    assert.equal(fake.state.connections, 0, 'no provider session may be opened for it');
    client.close();
  } finally {
    await close();
  }
});

test('the last utterance before a stop is preserved in the recap', async () => {
  const { fake, backend, close } = await harness(
    {},
    { replyToCommit: true, commitText: 'Two thousand dollars per month is above our budget.' }
  );

  try {
    const client = await connectSession(backend.wsUrl('final-utterance'));
    await client.open();
    client.send(startMessage());
    await client.waitFor((message) => message.t === 'status' && message.status === 'listening');

    client.send(audioFrame({ pcm: pcmSilence(200, 16000), sampleRate: 16000, seq: 1 }));
    await waitFor(() => fake.audioChunks().length > 0, { description: 'audio at the provider' });

    client.send({ t: 'session.stop' });

    const recapFrame = await client.waitFor((message) => message.t === 'recap', 12000);
    const recap = recapFrame.recap;

    assert.ok(
      recap.keyPoints.some((point) => point.includes('Two thousand dollars per month')),
      `the final utterance must be in the recap, got: ${JSON.stringify(recap.keyPoints)}`
    );
    assert.ok(recap.summary.length > 0);

    // The provider was asked to commit with the documented empty flush chunk,
    // and no audio was invented locally to force it.
    const flush = fake.flushChunks().at(-1);
    assert.equal(flush.commit, true);
    assert.equal(flush.audio_base_64, '');
    assert.equal(flush.sample_rate, 16000);

    await client.waitFor((message) => message.t === 'status' && message.status === 'ended');
  } finally {
    await close();
  }
});

test('audio sent after a stop is ignored', async () => {
  const { fake, backend, close } = await harness({}, { replyToCommit: true });

  try {
    const client = await connectSession(backend.wsUrl('late-audio'));
    await client.open();
    client.send(startMessage());
    await client.waitFor((message) => message.t === 'status' && message.status === 'listening');

    client.send(audioFrame({ pcm: pcmSilence(100, 16000), sampleRate: 16000, seq: 1 }));
    await waitFor(() => fake.audioChunks().length > 0, { description: 'first audio chunk' });

    const before = fake.audioChunks().length;
    client.send({ t: 'session.stop' });
    // Frames arriving after End must never reach the provider.
    for (let seq = 2; seq < 8; seq += 1) {
      client.send(audioFrame({ pcm: pcmSilence(100, 16000), sampleRate: 16000, seq }));
    }

    await client.waitFor((message) => message.t === 'recap', 12000);
    await sleep(100);

    assert.equal(
      fake.audioChunks().length,
      before,
      'no audio may be forwarded once the session has stopped'
    );
  } finally {
    await close();
  }
});

test('concurrency is capped', async () => {
  const { backend, close } = await harness({ PSST_MAX_SESSIONS: '1' });

  try {
    const first = await connectSession(backend.wsUrl('first'));
    await first.open();
    first.send(startMessage());
    await first.waitFor((message) => message.t === 'status' && message.status === 'listening');

    const refusal = await new Promise((resolve) => {
      const socket = new WebSocket(backend.wsUrl('second'));
      socket.on('error', (error) => resolve(error.message));
      socket.on('open', () => resolve(null));
    });

    assert.match(String(refusal), /503/, 'the second session must be refused');
    first.close();
  } finally {
    await close();
  }
});

test('an idle session is ended with an explanation and a recap', async () => {
  const { backend, close } = await harness({ PSST_IDLE_TIMEOUT_MS: '400' });

  try {
    const client = await connectSession(backend.wsUrl('idle'));
    await client.open();
    client.send(startMessage());

    const notice = await client.waitFor(
      (message) => message.t === 'notice' && /nothing was heard/.test(message.message),
      8000
    );
    assert.equal(notice.level, 'warning');

    const recap = await client.waitFor((message) => message.t === 'recap', 12000);
    assert.equal(recap.recap.title, 'Budget call');
    assert.equal(backend.exited(), null);
    client.close();
  } finally {
    await close();
  }
});

test('a session that hits the duration limit is ended cleanly', async () => {
  const { backend, close } = await harness({ PSST_MAX_SESSION_DURATION_MS: '500' });

  try {
    const client = await connectSession(backend.wsUrl('long'));
    await client.open();
    client.send(startMessage());

    const notice = await client.waitFor(
      (message) => message.t === 'notice' && /limit and was ended/.test(message.message),
      8000
    );
    assert.equal(notice.level, 'warning');

    await client.waitFor((message) => message.t === 'recap', 12000);
    await client.waitFor((message) => message.t === 'status' && message.status === 'ended');
    client.close();
  } finally {
    await close();
  }
});

test('a message flood is throttled without taking the session down', async () => {
  const { backend, close } = await harness({ PSST_MAX_MESSAGES_PER_SEC: '5' });

  try {
    const client = await connectSession(backend.wsUrl('flood'));
    await client.open();
    client.send(startMessage());
    await client.waitFor((message) => message.t === 'status' && message.status === 'listening');

    for (let seq = 0; seq < 40; seq += 1) {
      client.send(audioFrame({ pcm: pcmSilence(20, 16000), sampleRate: 16000, seq }));
    }
    await sleep(300);

    const health = await backend.health();
    assert.ok(health.throttledMessages > 0, 'excess frames must be counted, not queued');
    assert.equal(backend.exited(), null);

    client.send({ t: 'session.pause' });
    await client.waitFor((message) => message.t === 'status' && message.status === 'paused');
    client.close();
  } finally {
    await close();
  }
});

test('/health reports configuration as numbers and booleans only', async () => {
  const { backend, close } = await harness();

  try {
    const health = await backend.health();

    assert.equal(health.status, 'ok');
    assert.equal(typeof health.elevenlabsConfigured, 'boolean');
    assert.equal(health.elevenlabsConfigured, true);
    assert.equal(health.sarvamConfigured, false, 'no Sarvam key is provided to tests');

    for (const field of ['limits', 'rejectedAudioFrames', 'throttledMessages', 'idleTimeouts']) {
      assert.ok(field in health, `/health must report ${field}`);
    }
    assert.ok(health.limits.maxPayloadBytes > 0);
    assert.ok(health.limits.maxAudioFrameBytes > 0);
    assert.ok(health.limits.maxSessions > 0);
    assert.ok(health.limits.idleTimeoutMs > 0);
    assert.ok(health.limits.maxSessionDurationMs > 0);

    const serialized = JSON.stringify(health);
    assert.ok(!serialized.includes('test-key-never-sent-anywhere-real'), 'no key material ever');
    assert.ok(!/apiKey/i.test(serialized), 'no key field is exposed');
  } finally {
    await close();
  }
});
