/**
 * Offline test harness.
 *
 * Nothing here talks to a real provider: the fake STT endpoint speaks just
 * enough of the documented ElevenLabs realtime protocol (`session_started`,
 * `partial_transcript`, `committed_transcript`, `input_audio_chunk`) to exercise
 * the production code path, so these tests cost nothing and never need a
 * microphone.
 *
 * The real `.env` is deliberately left in the environment for the child server
 * (if it exists) and then overridden by explicit values: Node's
 * `process.loadEnvFile()` never replaces a variable that is already set, so the
 * fake key and the local endpoint always win over anything in a file, and an
 * explicitly empty `SARVAM_API_KEY` keeps the reasoning engine unconfigured so
 * no paid call can happen.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WebSocket, WebSocketServer } from 'ws';

/** server/test/support/harness.js -> server/ */
export const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Raw PCM16 silence, used as stand-in audio. */
export function pcmSilence(ms, sampleRate) {
  return Buffer.alloc(Math.round((sampleRate * ms) / 1000) * 2);
}

/**
 * A fake ElevenLabs realtime endpoint.
 *
 * `commitDelayMs` deliberately slows the flush response, which is what makes a
 * stop take time: the finalization window a session has to keep the connection
 * open for its recap lives there.
 *
 * @param {{ announceSession?: boolean, replyToCommit?: boolean, commitText?: string, commitDelayMs?: number }} [options]
 */
export async function startFakeProvider(initialOptions = {}) {
  /** Mutable: a test can change the provider's behaviour mid-session. */
  const options = { ...initialOptions };
  const state = { chunks: [], urls: [], sockets: [], connections: 0 };
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => wss.once('listening', resolve));
  const port = wss.address().port;

  wss.on('connection', (socket, req) => {
    state.connections += 1;
    state.urls.push(req.url ?? '');
    state.sockets.push(socket);
    socket.on('error', () => {});

    if (options.announceSession !== false) {
      socket.send(
        JSON.stringify({ message_type: 'session_started', session_id: 'fake-provider', config: {} })
      );
    }

    socket.on('message', (raw) => {
      let message = null;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      state.chunks.push({ ...message, url: req.url ?? '' });

      if (message.commit === true && options.replyToCommit !== false) {
        const reply = () =>
          socket.send(
            JSON.stringify({
              message_type: 'committed_transcript',
              text: options.commitText ?? 'Two thousand dollars per month is above our budget.',
            })
          );
        const delay = Number(options.commitDelayMs ?? 0);
        if (delay > 0) setTimeout(reply, delay);
        else reply();
      }
    });
  });

  const audioChunks = () =>
    state.chunks.filter(
      (chunk) => chunk.message_type === 'input_audio_chunk' && chunk.audio_base_64 !== ''
    );
  const flushChunks = () =>
    state.chunks.filter(
      (chunk) => chunk.message_type === 'input_audio_chunk' && chunk.audio_base_64 === ''
    );

  return {
    state,
    options,
    port,
    endpoint: `ws://127.0.0.1:${port}/v1/speech-to-text/realtime`,
    audioChunks,
    flushChunks,
    /** Query parameters the provider saw on the most recent connection. */
    query: () => new URLSearchParams((state.urls.at(-1) ?? '').split('?')[1] ?? ''),
    /** Pushes a provider frame to every connected client. */
    emit: (payload) => {
      for (const socket of state.sockets) {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
      }
    },
    /**
     * Shuts down cleanly: a graceful close first so the client's close handshake
     * completes (ws otherwise keeps a 30 s close timer alive), then terminate.
     */
    close: async () => {
      for (const socket of state.sockets) {
        try {
          socket.close();
        } catch {
          // Already closing.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 60));
      for (const socket of state.sockets) {
        try {
          socket.terminate();
        } catch {
          // Already gone.
        }
      }
      await new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}

/**
 * A fake ElevenLabs **batch** transcription endpoint.
 *
 * The import pipeline posts one multipart body and reads one JSON transcript
 * back, so this fake only has to accept that body and answer in the documented
 * shape. Every request is recorded (headers and raw bytes) so a test can prove
 * what the backend actually sent: the file, the model, and that the key travelled
 * in the header and never appeared in a response.
 *
 * @param {{ status?: number, payload?: object, entries?: Array<{speaker: string, text: string, start: number}> }} [options]
 */
export async function startFakeBatchStt(options = {}) {
  const requests = [];

  /** Two speakers with a pause between them, so line grouping is exercised. */
  const defaultEntries = [
    { speaker: 'speaker_0', text: 'Two thousand dollars per month is above our budget.', start: 0 },
    { speaker: 'speaker_1', text: 'I will send the deck on Friday.', start: 4 },
  ];

  const words = [];
  for (const entry of options.entries ?? defaultEntries) {
    let at = entry.start;
    for (const token of entry.text.split(' ')) {
      words.push({ text: token, type: 'word', start: at, end: at + 0.2, speaker_id: entry.speaker });
      at += 0.25;
    }
  }

  const payload = options.payload ?? {
    language_code: 'eng',
    language_probability: 0.99,
    text: words.map((word) => word.text).join(' '),
    words,
  };

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        url: req.url ?? '',
        contentType: String(req.headers['content-type'] ?? ''),
        apiKey: String(req.headers['xi-api-key'] ?? ''),
        body: Buffer.concat(chunks),
      });

      const status = Number(options.status ?? 200);
      if (status !== 200) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ detail: 'fake transcription failure' }));
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
    req.on('error', () => {});
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    endpoint: `http://127.0.0.1:${server.address().port}/v1/speech-to-text`,
    requests,
    lastRequest: () => requests.at(-1) ?? null,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * A fake Sarvam chat-completions endpoint.
 *
 * Only used when a test needs a deliberately slow **recap**: the backend asks the
 * provider for the summary after it has flushed transcription, so delaying this
 * response delays the recap itself. Offline, no key, no credit.
 *
 * @param {{ delayMs?: number, decision?: object, recap?: object, debrief?: object }} [options]
 */
export async function startFakeSarvam(options = {}) {
  const requests = [];
  const decision = options.decision ?? {
    action: 'NO_ACTION',
    observation: '',
    suggestion: '',
    confidence: 0,
  };
  const recap = options.recap ?? {
    summary: 'A deliberately delayed recap from the fake recap provider.',
    keyPoints: ['The delayed recap key point.'],
    commitments: [],
    missed: [],
    nextActions: [],
  };

  /** The import pipeline's answer, in the documented debrief shape. */
  const debrief = options.debrief ?? {
    summary: 'A pilot call where pricing came up but the budget was never confirmed.',
    keyDecisions: ['A two-week pilot was agreed before any annual commitment.'],
    commitments: [
      { owner: 'you', person: '', what: 'Send the pilot proposal', when: 'Friday' },
    ],
    tasks: ['Send the pilot proposal'],
    suggestedMessage: 'Thanks for the call today. The pilot proposal is coming on Friday.',
    people: [{ name: 'Priya', context: 'Owns the budget' }],
    openQuestions: ['Is the budget approved this quarter?'],
    risks: [{ label: 'Budget timing', detail: 'Budget was mentioned but never confirmed.' }],
    tone: { label: 'Positive, cautious', note: 'Interested but non-committal.' },
    relationship: 'Early and warm.',
    reminders: ['You promised the pilot proposal by Friday.'],
  };

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let payload = null;
      try {
        payload = JSON.parse(body);
      } catch {
        // Fall through with an unknown schema; the decision payload is harmless.
      }
      const schemaName = payload?.response_format?.json_schema?.name ?? '';
      requests.push({ schemaName, at: Date.now() });

      const respond = () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify(
                    schemaName === 'psst_recap'
                      ? recap
                      : schemaName === 'psst_debrief'
                        ? debrief
                        : decision
                  ),
                },
              },
            ],
          })
        );
      };

      const delay = Number(options.delayMs ?? 0);
      if (delay > 0) setTimeout(respond, delay);
      else respond();
    });
    req.on('error', () => {});
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
    requests,
    delayMs: options.delayMs ?? 0,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** A TCP server that accepts connections and never answers: a stalled STT handshake. */
export async function startHangingProvider() {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    endpoint: `ws://127.0.0.1:${server.address().port}/v1/speech-to-text/realtime`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 25, description = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out waiting for ${description}`);
}

/** Picks a free-ish port so parallel test files do not collide. */
function randomPort() {
  return 15000 + Math.floor(Math.random() * 20000);
}

/**
 * Spawns the real backend with provider calls pointed at a local fake.
 *
 * @param {Record<string, string>} [extraEnv]
 */
export async function startBackend(extraEnv = {}) {
  const port = Number(extraEnv.PORT ?? randomPort());
  const child = spawn(process.execPath, [path.join(SERVER_ROOT, 'src', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      ELEVENLABS_API_KEY: 'test-key-never-sent-anywhere-real',
      SARVAM_API_KEY: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];
  child.stdout.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr.on('data', (chunk) => logs.push(String(chunk)));
  let exitCode = null;
  child.on('exit', (code) => {
    exitCode = code;
  });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10000;
  let healthy = false;
  while (Date.now() < deadline && !healthy) {
    if (exitCode !== null) break;
    try {
      const response = await fetch(`${base}/health`);
      healthy = response.ok;
    } catch {
      // Not up yet.
    }
    if (!healthy) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!healthy) {
    child.kill('SIGKILL');
    throw new Error(`backend did not become healthy (exit ${exitCode}):\n${logs.join('')}`);
  }

  return {
    port,
    base,
    logs: () => logs.join(''),
    exited: () => exitCode,
    health: async () => (await fetch(`${base}/health`)).json(),
    wsUrl: (sessionId) => `ws://127.0.0.1:${port}/sessions/${sessionId}/stream`,
    stop: async () => {
      if (exitCode !== null) return;
      const done = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 2000))]);
      if (exitCode === null) child.kill('SIGKILL');
    },
  };
}

/** A TestClient over the app's own protocol. */
export async function connectSession(url) {
  const socket = new WebSocket(url);
  const messages = [];
  const listeners = new Set();

  socket.on('error', () => {});
  socket.on('message', (raw) => {
    let message = null;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    messages.push(message);
    for (const listener of [...listeners]) listener(message);
  });

  return {
    socket,
    messages,
    open: () =>
      new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      }),
    send: (message) => socket.send(typeof message === 'string' ? message : JSON.stringify(message)),
    waitFor: (predicate, timeoutMs = 8000) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(listener);
          reject(
            new Error(
              `timed out waiting for a frame; saw: ${JSON.stringify(messages.map((m) => m.t))}`
            )
          );
        }, timeoutMs);
        const listener = (message) => {
          if (!predicate(message)) return;
          clearTimeout(timer);
          listeners.delete(listener);
          resolve(message);
        };
        const existing = messages.find(predicate);
        if (existing) {
          clearTimeout(timer);
          resolve(existing);
          return;
        }
        listeners.add(listener);
      }),
    close: () => socket.close(),
  };
}

/** The app's own audio frame shape, built the way the client builds it. */
export function audioFrame({ pcm, seq = 1, sampleRate = 16000, byteLength } = {}) {
  const bytes = pcm ?? pcmSilence(100, sampleRate);
  return {
    t: 'audio.frame',
    seq,
    pcm: bytes.toString('base64'),
    audio: { sampleRate, channels: 1, encoding: 'int16' },
    byteLength: byteLength ?? bytes.byteLength,
  };
}

export function startMessage(overrides = {}) {
  return {
    t: 'session.start',
    goal: {
      title: 'Budget call',
      objective: 'Understand the budget before offering a discount.',
      notes: '',
      preset: 'sales',
    },
    client: { platform: 'node', appVersion: '0.1.0' },
    ...overrides,
  };
}
