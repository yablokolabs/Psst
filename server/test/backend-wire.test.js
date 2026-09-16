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

/** Resolves with the handshake error message, or null when the socket opened. */
function attemptConnection(url) {
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    socket.on('error', (error) => resolve(error.message));
    socket.on('open', () => {
      socket.close();
      resolve(null);
    });
  });
}

/** Waits for the server's own count to settle, since cleanup is asynchronous. */
async function waitForActiveSessions(backend, expected) {
  const deadline = Date.now() + 5000;
  let last = null;
  while (Date.now() < deadline) {
    last = (await backend.health()).activeSessions;
    if (last === expected) return;
    await sleep(50);
  }
  throw new Error(`activeSessions stayed at ${last}, expected ${expected}`);
}

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

test('a duplicate live session id is refused instead of overwriting the first', async () => {
  const { backend, close } = await harness({ PSST_MAX_SESSIONS: '4' });

  try {
    const first = await connectSession(backend.wsUrl('duplicate'));
    await first.open();
    first.send(startMessage());
    await first.waitFor((message) => message.t === 'status' && message.status === 'listening');

    // Same id, second connection: the slot is not a fresh one, so this is a
    // conflict rather than an admission.
    const refusal = await attemptConnection(backend.wsUrl('duplicate'));
    assert.match(String(refusal), /409/, 'a duplicate id must be refused');
    assert.equal((await backend.health()).activeSessions, 1, 'the duplicate never registered');

    // The first connection is completely undisturbed by the refusal.
    first.send({ t: 'session.pause' });
    await first.waitFor((message) => message.t === 'status' && message.status === 'paused');
    first.send({ t: 'session.resume' });
    await first.waitFor((message) => message.t === 'status' && message.status === 'listening');

    first.close();
    await waitForActiveSessions(backend, 0);
  } finally {
    await close();
  }
});

test('the cap counts live connections, frees one slot at a time, and never evicts', async () => {
  const { backend, close } = await harness({ PSST_MAX_SESSIONS: '2' });

  try {
    const first = await connectSession(backend.wsUrl('one'));
    await first.open();
    first.send(startMessage());
    await first.waitFor((message) => message.t === 'status' && message.status === 'listening');

    const second = await connectSession(backend.wsUrl('two'));
    await second.open();
    second.send(startMessage());
    await second.waitFor((message) => message.t === 'status' && message.status === 'listening');

    assert.equal((await backend.health()).activeSessions, 2);

    // At the cap, a new id is refused and the existing count is not inflated.
    assert.match(String(await attemptConnection(backend.wsUrl('three'))), /503/);
    assert.equal((await backend.health()).activeSessions, 2);

    // Closing one frees exactly one slot, and must not remove the other
    // connection's registration.
    first.close();
    await waitForActiveSessions(backend, 1);

    second.send({ t: 'session.pause' });
    await second.waitFor((message) => message.t === 'status' && message.status === 'paused');

    // ...and the freed slot admits a new connection, including the refused id.
    const third = await connectSession(backend.wsUrl('three'));
    await third.open();
    third.send(startMessage());
    await third.waitFor((message) => message.t === 'status' && message.status === 'listening');
    assert.equal((await backend.health()).activeSessions, 2);

    third.close();
    second.close();
    await waitForActiveSessions(backend, 0);
  } finally {
    await close();
  }
});

test('the audio budget ends the session visibly, then still delivers a recap', async () => {
  const budget = 8192;
  const { fake, backend, close } = await harness(
    { PSST_MAX_SESSION_AUDIO_BYTES: String(budget) },
    { replyToCommit: true, commitText: 'We should revisit the pricing next quarter.' }
  );

  try {
    const client = await connectSession(backend.wsUrl('budget'));
    await client.open();
    client.send(startMessage());
    await client.waitFor((message) => message.t === 'status' && message.status === 'listening');

    const pcm = pcmSilence(64, 16000);
    const frameBytes = pcm.byteLength;
    assert.equal(frameBytes * 4, budget, 'the test budget must be exactly four frames');

    let seq = 0;
    const sendFrame = () => {
      seq += 1;
      client.send(audioFrame({ pcm, sampleRate: 16000, seq }));
    };

    for (let index = 0; index < 4; index += 1) sendFrame();
    await waitFor(() => fake.audioChunks().length >= 4, { description: 'the accepted audio' });

    // The next frame is over budget: the ceiling is announced, not silent.
    sendFrame();
    const noticesSeen = () =>
      client.messages.filter((message) => message.t === 'notice' && /audio limit/.test(message.message));

    const notice = await client.waitFor(
      (message) => message.t === 'notice' && /audio limit/.test(message.message),
      8000
    );
    assert.equal(notice.level, 'warning');
    assert.match(notice.message, /and was ended/);

    // Frames that keep arriving are dropped without repeating the explanation.
    for (let index = 0; index < 20; index += 1) sendFrame();
    await sleep(250);
    assert.equal(noticesSeen().length, 1, 'exhaustion is explained exactly once');

    // Clean termination: what was already accepted is flushed and the recap is
    // honest about what happened.
    const recapFrame = await client.waitFor((message) => message.t === 'recap', 12000);
    assert.equal(recapFrame.recap.title, 'Budget call');
    assert.ok(recapFrame.recap.summary.length > 0);
    assert.ok(
      recapFrame.recap.keyPoints.some((point) => point.includes('revisit the pricing')),
      'audio already accepted must still make it into the recap'
    );
    await client.waitFor((message) => message.t === 'status' && message.status === 'ended', 8000);

    assert.equal(backend.exited(), null, 'the backend survives the budget end');
    const health = await backend.health();
    assert.equal(health.audioBudgetEnds, 1);
    assert.equal(health.limits.maxSessionAudioBytes, budget);

    client.close();
    await waitForActiveSessions(backend, 0);
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
