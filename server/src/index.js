/**
 * Psst realtime backend.
 *
 * Responsibilities:
 *   - own the WebSocket session API the Psst app connects to
 *   - hold ELEVENLABS_API_KEY and SARVAM_API_KEY, server-side only
 *   - pipe microphone frames through realtime STT, then reasoning, then cues
 *   - build the recap when a session stops
 *
 * Pipeline:
 *   phone mic -> app -> audio.frame -> ElevenLabs realtime STT -> transcript
 *             -> committed utterance -> Sarvam reasoning -> NO_ACTION / PSST
 *             -> cue frame -> existing LIVE screen
 *
 * No database, no framework, no authentication system: sessions live in memory
 * and an optional shared client token gates access.
 */

import { createServer } from 'node:http';

import { WebSocket, WebSocketServer } from 'ws';

import { getElevenLabsConfig, isElevenLabsConfigured } from './elevenlabs.js';
import { loadServerEnv } from './env.js';
import { encode, noticeMessage, parseClientMessage, recapMessage, statusMessage } from './protocol.js';
import { buildRecap, createReasoningProvider } from './reasoning.js';
import { getSarvamConfig, isSarvamConfigured } from './sarvam.js';
import { ConversationSession } from './session.js';
import { attachTranscription } from './transcription.js';
import { MIN_CUE_INTERVAL_MS } from './cue.js';

loadServerEnv();

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';
/** Optional shared token. Configure the app with the same public value. */
const CLIENT_TOKEN = process.env.PSST_CLIENT_TOKEN ?? '';
const SESSION_PATH = /^\/sessions\/([^/]+)\/stream$/;

/** @type {Map<string, ConversationSession>} */
const sessions = new Map();
let totalSessions = 0;

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function handleRequest(req, res) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, {
      status: 'ok',
      service: 'psst-backend',
      phase: '2b',
      // Booleans and names only: no key material, ever.
      elevenlabsConfigured: isElevenLabsConfigured(),
      sarvamConfigured: isSarvamConfigured(),
      elevenlabsModel: getElevenLabsConfig().modelId,
      sarvamModel: getSarvamConfig().model,
      minCueIntervalMs: MIN_CUE_INTERVAL_MS,
      tokenRequired: CLIENT_TOKEN.length > 0,
      activeSessions: sessions.size,
      totalSessions,
      uptimeSeconds: Math.round(process.uptime()),
    });
    return;
  }

  sendJson(res, 404, { error: 'not_found' });
}

const server = createServer(handleRequest);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const match = SESSION_PATH.exec(url.pathname);

  if (!match) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  if (CLIENT_TOKEN.length > 0 && url.searchParams.get('token') !== CLIENT_TOKEN) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  const sessionId = match[1];
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, sessionId);
  });
});

wss.on('connection', (socket, _req, sessionId) => {
  const session = new ConversationSession({ id: sessionId });
  sessions.set(sessionId, session);
  totalSessions += 1;

  // One reasoning provider per session keeps the conversation state local.
  const provider = createReasoningProvider();

  /** @type {{ detach: () => void, finalize: () => Promise<void> }} */
  let transcription = { detach: () => {}, finalize: async () => {} };
  let started = false;
  let stopping = false;

  const send = (message) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(encode(message));
  };

  socket.on('message', (raw) => {
    const message = parseClientMessage(raw.toString());
    if (!message) return;

    switch (message.t) {
      case 'session.start':
        if (started) return;
        started = true;
        session.start(message.goal, message.client);
        send(statusMessage('listening'));

        if (!isElevenLabsConfigured()) {
          send(
            noticeMessage(
              'warning',
              'Realtime transcription is unavailable: the server has no ElevenLabs key configured.'
            )
          );
        }
        if (!provider) {
          send(
            noticeMessage(
              'warning',
              'Psst can transcribe, but the cue engine is not configured on the server, so no suggestions will be generated.'
            )
          );
        }

        transcription = attachTranscription(session, send, { provider });
        break;

      case 'session.pause':
        // Audio stops flowing; the transcript and conversation state are kept,
        // and the STT session is left open so resuming is instant.
        session.pause();
        send(statusMessage('paused'));
        break;

      case 'session.resume':
        session.resume();
        send(statusMessage('listening'));
        break;

      case 'session.stop': {
        if (stopping) return;
        stopping = true;

        // Let a commit that is already in flight land, then close the provider.
        // The transcript captured so far is never discarded.
        void transcription.finalize().then(async () => {
          let recap;
          try {
            recap = await buildRecap(session, { provider });
          } catch (error) {
            console.warn(
              `[psst] recap generation failed, returning what was captured: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
            recap = await buildRecap(session, { provider: null });
          }

          send(recapMessage(recap));
          session.end();
          // Close after the recap frame has been flushed. The app keeps its own
          // fallback recap if this never arrives.
          send(statusMessage('ended'));
          setTimeout(() => socket.close(1000, 'session ended'), 50);
          sessions.delete(sessionId);
        });
        break;
      }

      case 'audio.frame':
        session.pushAudioFrame(message);
        break;
    }
  });

  socket.on('error', () => {
    transcription.detach();
  });

  socket.on('close', () => {
    transcription.detach();
    transcription = { detach: () => {}, finalize: async () => {} };
    sessions.delete(sessionId);
  });
});

const httpServer = server.listen(PORT, HOST, () => {
  console.log(`[psst] backend listening on http://${HOST}:${PORT} (phase 2b)`);
  console.log(`[psst] session endpoint: ws://${HOST}:${PORT}/sessions/{id}/stream`);
  console.log(
    `[psst] elevenlabs: ${
      isElevenLabsConfigured() ? `configured (server-side, ${getElevenLabsConfig().modelId})` : 'not set'
    }`
  );
  console.log(
    `[psst] sarvam: ${
      isSarvamConfigured() ? `configured (server-side, ${getSarvamConfig().model})` : 'not set'
    }`
  );
  console.log(`[psst] client token: ${CLIENT_TOKEN.length > 0 ? 'required' : 'not required'}`);
});

function shutdown(signal) {
  console.log(`[psst] received ${signal}, shutting down`);
  wss.clients.forEach((client) => client.close(1001, 'server shutting down'));
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
