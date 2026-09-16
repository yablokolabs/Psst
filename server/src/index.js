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
 * No database, no framework. Sessions live in memory and an optional shared
 * client token gates access. That token is a throttle, not authentication: it
 * ships inside the app bundle (see `PSST_CLIENT_TOKEN` below), so real
 * authorization is a public-release gate, not something this server does yet.
 */

import { createServer } from 'node:http';

import { WebSocket, WebSocketServer } from 'ws';

import { getElevenLabsConfig, isElevenLabsConfigured } from './elevenlabs.js';
import { loadServerEnv } from './env.js';
import { LIMITS, describeLimits } from './limits.js';
import { encode, noticeMessage, parseClientMessage, recapMessage, statusMessage } from './protocol.js';
import { buildRecap, createReasoningProvider } from './reasoning.js';
import { getSarvamConfig, isSarvamConfigured } from './sarvam.js';
import { ConversationSession } from './session.js';
import { attachTranscription } from './transcription.js';
import { MIN_CUE_INTERVAL_MS } from './cue.js';

loadServerEnv();

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';
/** Optional shared token. Public value: it ships in the app bundle. */
const CLIENT_TOKEN = process.env.PSST_CLIENT_TOKEN ?? '';
const SESSION_PATH = /^\/sessions\/([^/]+)\/stream$/;
/** Longest session id accepted in the URL. */
const MAX_SESSION_ID_CHARS = 120;

/** @type {Map<string, ConversationSession>} */
const sessions = new Map();
let totalSessions = 0;
/** Process-wide counters for /health. Numbers only. */
const counters = { rejectedAudioFrames: 0, throttledMessages: 0, idleTimeouts: 0, durationLimitEnds: 0 };

function minutes(ms) {
  return Math.round(ms / 60000);
}

/** Human-readable duration for limit messages (seconds below a minute). */
function describeDuration(ms) {
  if (ms < 60000) return `${Math.max(1, Math.round(ms / 1000))}-second`;
  return `${minutes(ms)}-minute`;
}

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
    const elevenlabs = getElevenLabsConfig();
    sendJson(res, 200, {
      status: 'ok',
      service: 'psst-backend',
      phase: '2b',
      // Booleans and names only: no key material, ever.
      elevenlabsConfigured: isElevenLabsConfigured(),
      sarvamConfigured: isSarvamConfigured(),
      elevenlabsModel: elevenlabs.modelId,
      elevenlabsCommitStrategy: elevenlabs.commitStrategy,
      elevenlabsCommitStrategyRejected: elevenlabs.commitStrategyRejected,
      elevenlabsLanguageCode: elevenlabs.languageCode || null,
      sarvamModel: getSarvamConfig().model,
      minCueIntervalMs: MIN_CUE_INTERVAL_MS,
      tokenRequired: CLIENT_TOKEN.length > 0,
      activeSessions: sessions.size,
      totalSessions,
      ...counters,
      limits: describeLimits(),
      uptimeSeconds: Math.round(process.uptime()),
    });
    return;
  }

  sendJson(res, 404, { error: 'not_found' });
}

const server = createServer(handleRequest);
const wss = new WebSocketServer({
  noServer: true,
  // Ceiling on any single frame, enforced by ws before we ever see the payload.
  maxPayload: LIMITS.maxPayloadBytes,
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const match = SESSION_PATH.exec(url.pathname);

  if (!match || match[1].length === 0 || match[1].length > MAX_SESSION_ID_CHARS) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  if (CLIENT_TOKEN.length > 0 && url.searchParams.get('token') !== CLIENT_TOKEN) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  if (sessions.size >= LIMITS.maxSessions) {
    // Bounded concurrency: one deployment cannot be exhausted by connection churn.
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
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

  /** @type {{ detach: () => void, finalize: () => Promise<boolean>, commit: () => void }} */
  let transcription = { detach: () => {}, finalize: async () => false, commit: () => {} };
  let started = false;
  let stopping = false;
  let closed = false;
  let unsupportedFormatReported = false;
  let oversizedFrameReported = false;
  /** Simple per-second message budget: a client cannot flood the pipeline. */
  let rateWindowStart = Date.now();
  let rateWindowCount = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let idleTimer = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let durationTimer = null;

  const send = (message) => {
    if (closed || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(encode(message));
    } catch {
      // The socket reported its own failure; nothing useful to add here.
    }
  };

  const clearSessionTimers = () => {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (durationTimer !== null) {
      clearTimeout(durationTimer);
      durationTimer = null;
    }
  };

  const armIdleTimer = () => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (closed || stopping) return;
      counters.idleTimeouts += 1;
      send(
        noticeMessage(
          'warning',
          `Psst ended this session because nothing was heard for ${describeDuration(LIMITS.idleTimeoutMs)} idle limit.`
        )
      );
      finishSession();
    }, LIMITS.idleTimeoutMs);
    idleTimer.unref?.();
  };

  const armDurationTimer = () => {
    if (durationTimer !== null) clearTimeout(durationTimer);
    durationTimer = setTimeout(() => {
      durationTimer = null;
      if (closed || stopping) return;
      counters.durationLimitEnds += 1;
      send(
        noticeMessage(
          'warning',
          `This session reached the ${describeDuration(LIMITS.maxSessionDurationMs)} limit and was ended. Your recap is below.`
        )
      );
      finishSession();
    }, LIMITS.maxSessionDurationMs);
    durationTimer.unref?.();
  };

  /**
   * Ends the session once: audio intake stops immediately, then the provider is
   * flushed, then the recap is generated from everything that was captured.
   */
  const finishSession = () => {
    if (stopping) return;
    stopping = true;
    clearSessionTimers();

    // Stop the audio intake before any asynchronous work: a frame arriving after
    // the user tapped End must never reach the provider or the session counters.
    session.end();

    void transcription
      .finalize()
      .then(async () => {
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
        send(statusMessage('ended'));
        sessions.delete(sessionId);
        // Close after the recap frame has been flushed. The app keeps its own
        // fallback recap if this never arrives.
        setTimeout(() => {
          if (closed) return;
          try {
            socket.close(1000, 'session ended');
          } catch {
            // Already gone.
          }
        }, 50);
      })
      .catch((error) => {
        console.warn(`[psst] session finalization failed: ${String(error)}`);
        sessions.delete(sessionId);
      });
  };

  /**
   * Rate budget for audio frames. A live pipeline needs a steady stream, so this
   * sits well above any real capture rate and only trips on abuse.
   *
   * Control frames (start/pause/resume/stop) are never throttled: a client must
   * always be able to end a session, even if it has exhausted its audio budget.
   */
  const withinAudioRateLimit = () => {
    const now = Date.now();
    if (now - rateWindowStart >= 1000) {
      rateWindowStart = now;
      rateWindowCount = 0;
    }
    rateWindowCount += 1;
    if (rateWindowCount > LIMITS.maxMessagesPerSecond) {
      counters.throttledMessages += 1;
      return false;
    }
    return true;
  };

  armIdleTimer();

  socket.on('message', (raw) => {
    if (closed) return;
    armIdleTimer();

    const text = typeof raw === 'string' ? raw : raw.toString();
    const message = parseClientMessage(text);
    if (!message) return;

    if ((message.t === 'audio.frame' || message.t === 'audio.frame.rejected') && !withinAudioRateLimit()) {
      return;
    }

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
        armDurationTimer();
        break;

      case 'session.pause':
        // Audio stops flowing; the transcript and conversation state are kept,
        // and the STT session is left open so resuming is instant.
        session.pause();
        // With the manual commit strategy the provider never commits on its own,
        // so a pause is the one boundary the server can honestly commit on.
        transcription.commit();
        send(statusMessage('paused'));
        break;

      case 'session.resume':
        session.resume();
        send(statusMessage('listening'));
        break;

      case 'session.stop':
        finishSession();
        break;

      case 'audio.frame':
        session.pushAudioFrame(message);
        break;

      case 'audio.frame.rejected': {
        counters.rejectedAudioFrames += 1;
        session.rejectedAudioFrames += 1;

        // Only explain what the user can act on, and only once: a malformed
        // frame is a client bug, not something to shout about mid-conversation.
        if (message.reason === 'unsupported-audio-format' && !unsupportedFormatReported) {
          unsupportedFormatReported = true;
          const rate = message.reportedSampleRate === null ? 'an unsupported' : `${message.reportedSampleRate} Hz`;
          send(
            noticeMessage(
              'warning',
              `This device is capturing audio at ${rate} sample rate, which the transcription provider does not accept. Psst cannot transcribe this session.`
            )
          );
        }
        if (message.reason === 'frame-too-large' && !oversizedFrameReported) {
          oversizedFrameReported = true;
          send(
            noticeMessage(
              'warning',
              'Some audio frames were larger than the server accepts and were dropped, so the transcript may have gaps.'
            )
          );
        }
        break;
      }
    }
  });

  socket.on('error', () => {
    transcription.detach();
    clearSessionTimers();
  });

  socket.on('close', () => {
    closed = true;
    clearSessionTimers();
    transcription.detach();
    transcription = { detach: () => {}, finalize: async () => false, commit: () => {} };
    sessions.delete(sessionId);
  });
});

const httpServer = server.listen(PORT, HOST, () => {
  const elevenlabs = getElevenLabsConfig();
  console.log(`[psst] backend listening on http://${HOST}:${PORT} (phase 2b)`);
  console.log(`[psst] session endpoint: ws://${HOST}:${PORT}/sessions/{id}/stream`);
  console.log(
    `[psst] elevenlabs: ${
      isElevenLabsConfigured()
        ? `configured (server-side, ${elevenlabs.modelId}, commit=${elevenlabs.commitStrategy})`
        : 'not set'
    }`
  );
  console.log(
    `[psst] sarvam: ${
      isSarvamConfigured() ? `configured (server-side, ${getSarvamConfig().model})` : 'not set'
    }`
  );
  console.log(
    `[psst] limits: maxPayload=${LIMITS.maxPayloadBytes}B maxFrame=${LIMITS.maxAudioFrameBytes}B sessions=${LIMITS.maxSessions} idle=${minutes(LIMITS.idleTimeoutMs)}min duration=${minutes(LIMITS.maxSessionDurationMs)}min`
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
