/**
 * End-to-end wire tests against a spawned backend.
 *
 * These drive the real server over a real WebSocket connection with a local fake
 * STT endpoint, so nothing here is mocked at the protocol level:
 *
 *   test client -> ws -> src/index.js -> session -> transcription -> STT client
 *              -> fake provider
 *
 * Some tests also use a deliberately slow fake Sarvam endpoint, because the
 * recap is what a session keeps its connection open for after it has announced
 * the end.
 *
 * No provider credit is used and no microphone is needed.
 */

import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { WebSocket } from 'ws';

import {
  audioFrame,
  connectSession,
  pcmSilence,
  startBackend,
  startFakeProvider,
  startFakeSarvam,
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

/**
 * Spawns a backend wired to a fresh fake provider.
 *
 * The optional third argument adds a fake Sarvam endpoint, which is only needed
 * by tests that want the recap itself to be slow.
 */
async function harness(env = {}, providerOptions = {}, sarvamOptions = null) {
  const fake = await startFakeProvider(providerOptions);
  const sarvam = sarvamOptions ? await startFakeSarvam(sarvamOptions) : null;
  const backend = await startBackend({
    ELEVENLABS_STT_ENDPOINT: fake.endpoint,
    ...(sarvam
      ? {
          SARVAM_API_KEY: 'test-key-never-sent-anywhere-real',
          SARVAM_ENDPOINT: sarvam.endpoint,
        }
      : {}),
    ...env,
  });
  return {
    fake,
    sarvam,
    backend,
    close: async () => {
      await backend.stop();
      await fake.close();
      if (sarvam) await sarvam.close();
    },
  };
}

/** A handshake `ws` must refuse: the key is not 16 bytes of base64. */
function attemptBadHandshake(port, sessionId = 'bad-handshake') {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path: `/sessions/${sessionId}/stream`,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': 'not-a-valid-key',
        'sec-websocket-version': '13',
      },
    });
    req.on('response', (response) => {
      const status = response.statusCode;
      response.resume();
      resolve(status);
    });
    req.on('error', reject);
    req.end();
  });
}

/** A valid upgrade whose socket dies before the handshake completes. */
function abandonHandshake(port, sessionId = 'abandoned') {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        `GET /sessions/${sessionId}/stream HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          'Connection: Upgrade\r\n' +
          'Upgrade: websocket\r\n' +
          `Sec-WebSocket-Key: ${Buffer.from('0123456789abcdef').toString('base64')}\r\n` +
          'Sec-WebSocket-Version: 13\r\n\r\n'
      );
      socket.end();
      socket.destroy();
      resolve();
    });
    socket.on('error', () => resolve());
  });
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

test('a refused handshake releases its reservation instead of eating a slot', async () => {
  const { backend, close } = await harness({ PSST_MAX_SESSIONS: '2' });

  try {
    // Two handshakes `ws` answers with 400: they return without throwing and
    // without ever reaching the connection handler, which is exactly how a
    // reservation used to stay allocated forever.
    assert.equal(await attemptBadHandshake(backend.port, 'bad-one'), 400);
    assert.equal(await attemptBadHandshake(backend.port, 'bad-two'), 400);
    // A socket that dies mid-handshake is the other way to never arrive.
    await abandonHandshake(backend.port, 'abandoned-one');
    await abandonHandshake(backend.port, 'abandoned-two');
    await sleep(150);

    assert.equal(
      (await backend.health()).activeSessions,
      0,
      'a handshake that never completed must not hold a session slot'
    );

    // The whole point: both slots are still available to real clients.
    const first = await connectSession(backend.wsUrl('after-bad-one'));
    await first.open();
    first.send(startMessage());
    await first.waitFor((message) => message.t === 'status' && message.status === 'listening');

    const second = await connectSession(backend.wsUrl('after-bad-two'));
    await second.open();
    second.send(startMessage());
    await second.waitFor((message) => message.t === 'status' && message.status === 'listening');

    assert.equal((await backend.health()).activeSessions, 2);
    assert.equal(backend.exited(), null);

    first.close();
    second.close();
    await waitForActiveSessions(backend, 0);
  } finally {
    await close();
  }
});

test('concurrent admission cannot exceed the cap', async () => {
  const { backend, close } = await harness({ PSST_MAX_SESSIONS: '2' });

  try {
    const attempts = await Promise.all(
      [1, 2, 3, 4, 5, 6].map(
        (index) =>
          new Promise((resolve) => {
            const socket = new WebSocket(backend.wsUrl(`slot-${index}`));
            socket.on('open', () => resolve({ socket }));
            socket.on('error', (error) => resolve({ error: String(error.message) }));
          })
      )
    );

    const admitted = attempts.filter((attempt) => attempt.socket);
    const refused = attempts.filter((attempt) => attempt.error);

    assert.equal(admitted.length, 2, 'exactly the cap may be admitted');
    assert.equal(refused.length, 4);
    for (const attempt of refused) assert.match(attempt.error, /503/);
    assert.equal((await backend.health()).activeSessions, 2);
    assert.equal(backend.exited(), null);

    for (const attempt of admitted) attempt.socket.close();
    await waitForActiveSessions(backend, 0);

    // Every slot is reusable again once the winners are gone.
    const later = await connectSession(backend.wsUrl('after-the-rush'));
    await later.open();
    assert.equal((await backend.health()).activeSessions, 1);
    later.close();
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

test('an audio-budget end stops capture immediately, with the recap still delayed behind it', async () => {
  const budget = 4096;
  const { fake, sarvam, backend, close } = await harness(
    { PSST_MAX_SESSION_AUDIO_BYTES: String(budget) },
    { replyToCommit: true, commitDelayMs: 400, commitText: 'Let us revisit the pricing next quarter.' },
    {
      delayMs: 600,
      recap: {
        summary: 'A delayed but honest recap of the session.',
        keyPoints: ['The delayed recap key point.'],
        commitments: [],
        missed: [],
        nextActions: [],
      },
    }
  );

  try {
    const client = await connectSession(backend.wsUrl('budget-stop'));
    await client.open();
    client.send(startMessage());
    await client.waitFor((message) => message.t === 'status' && message.status === 'listening');

    const pcm = pcmSilence(64, 16000);
    const framesToFill = budget / pcm.byteLength;
    assert.equal(framesToFill * pcm.byteLength, budget, 'the budget must be an exact number of frames');

    let seq = 0;
    const sendFrame = () => {
      seq += 1;
      client.send(audioFrame({ pcm, sampleRate: 16000, seq }));
    };
    for (let index = 0; index < framesToFill; index += 1) sendFrame();
    await waitFor(() => fake.audioChunks().length >= framesToFill, { description: 'the accepted audio' });
    const acceptedChunks = fake.audioChunks().length;

    sendFrame();
    const notice = await client.waitFor(
      (message) => message.t === 'notice' && /audio limit/.test(message.message),
      8000
    );
    assert.equal(notice.level, 'warning');

    // The terminal status must arrive *before* finalization finishes: that is
    // what stops microphone capture while the flush and the recap are slow.
    await client.waitFor((message) => message.t === 'status' && message.status === 'ended', 2000);
    assert.equal(
      client.messages.some((message) => message.t === 'recap'),
      false,
      'the end of the session must be announced before the recap is ready, not after it'
    );

    // Nothing is forwarded after that announcement, whatever keeps arriving.
    for (let index = 0; index < 5; index += 1) sendFrame();
    await sleep(700);
    assert.equal(fake.audioChunks().length, acceptedChunks, 'no audio after the session ended');

    const recapFrame = await client.waitFor((message) => message.t === 'recap', 12000);
    assert.equal(
      recapFrame.recap.summary,
      'A delayed but honest recap of the session.',
      'the delayed recap is still delivered'
    );
    assert.ok(sarvam.requests.some((entry) => entry.schemaName === 'psst_recap'));

    await sleep(200);
    assert.equal(
      client.messages.filter((message) => message.t === 'recap').length,
      1,
      'exactly one recap remains available'
    );
    assert.equal(backend.exited(), null);

    client.close();
    await waitForActiveSessions(backend, 0);
  } finally {
    await close();
  }
});

test('a duration-limit end also stops capture before its recap is ready', async () => {
  const { fake, backend, close } = await harness(
    { PSST_MAX_SESSION_DURATION_MS: '300' },
    { replyToCommit: true, commitDelayMs: 400, commitText: 'We will review the numbers on Friday.' },
    {
      delayMs: 600,
      recap: {
        summary: 'The session hit its duration ceiling.',
        keyPoints: ['The duration recap key point.'],
        commitments: [],
        missed: [],
        nextActions: [],
      },
    }
  );

  try {
    const client = await connectSession(backend.wsUrl('duration-stop'));
    await client.open();
    client.send(startMessage());
    await client.waitFor((message) => message.t === 'status' && message.status === 'listening');

    // One frame opens the provider session, so the flush has something to commit.
    client.send(audioFrame({ pcm: pcmSilence(64, 16000), sampleRate: 16000, seq: 1 }));
    await waitFor(() => fake.audioChunks().length > 0, { description: 'the first audio chunk' });
    const acceptedChunks = fake.audioChunks().length;

    const notice = await client.waitFor(
      (message) => message.t === 'notice' && /limit and was ended/.test(message.message),
      8000
    );
    assert.equal(notice.level, 'warning');

    await client.waitFor((message) => message.t === 'status' && message.status === 'ended', 2000);
    assert.equal(
      client.messages.some((message) => message.t === 'recap'),
      false,
      'the terminal status must not wait for the recap'
    );

    let seq = 1;
    for (let index = 0; index < 5; index += 1) {
      seq += 1;
      client.send(audioFrame({ pcm: pcmSilence(64, 16000), sampleRate: 16000, seq }));
    }
    await sleep(700);
    assert.equal(fake.audioChunks().length, acceptedChunks, 'no audio after the session ended');

    const recapFrame = await client.waitFor((message) => message.t === 'recap', 12000);
    assert.equal(recapFrame.recap.summary, 'The session hit its duration ceiling.');
    await sleep(200);
    assert.equal(client.messages.filter((message) => message.t === 'recap').length, 1);

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
