/**
 * Psst backend.
 *
 * Two jobs, and only one of them is still used by the app:
 *
 *   1. Import analysis — the primary API. A recording the user chose is POSTed
 *      to `/debrief`, transcribed in one batch call, and returned as a Debrief:
 *      summary, decisions, commitments, follow-ups, people, risks, reminders.
 *      Catch it here:
 *        POST /debrief?token=…&callType=…&title=…&contact=…&durationMs=…
 *        body: raw audio bytes (audio/*)
 *
 *   2. The realtime WebSocket session API (`/sessions/{id}/stream`). Psst no
 *      longer opens it — the app is import-first, and no app can capture a
 *      phone call's audio — but the pipeline stays until its removal is a
 *      deliberate change, because it is what the live cue engine was built on
 *      and it is still covered by tests.
 *
 * This server holds ELEVENLABS_API_KEY and SARVAM_API_KEY, server-side only.
 * No database, no framework: analysis is stateless and nothing uploaded here is
 * written to disk. An optional shared client token gates both APIs. That token
 * is a throttle, not authentication: it ships inside the app bundle (see
 * `PSST_CLIENT_TOKEN` below), so real authorization is a public-release gate,
 * not something this server does yet.
 */

import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

import { WebSocket, WebSocketServer } from 'ws';

import { buildDebrief } from './debrief.js';
import { getElevenLabsConfig, isElevenLabsConfigured } from './elevenlabs.js';
import { loadServerEnv } from './env.js';
import { LIMITS, describeLimits } from './limits.js';
import { encode, noticeMessage, parseClientMessage, recapMessage, statusMessage } from './protocol.js';
import { buildRecap, createReasoningProvider } from './reasoning.js';
import { SarvamReasoningProvider, getSarvamConfig, isSarvamConfigured } from './sarvam.js';
import { ConversationSession } from './session.js';
import { getFalConfig, isFalConfigured } from './songua/fal.js';
import { getBatchSttConfig, isBatchSttConfigured, transcribeRecording } from './stt.js';
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
/** The import analysis endpoint. */
const DEBRIEF_PATH = '/debrief';
/** Longest free-text metadata accepted from the query string. */
const MAX_METADATA_CHARS = 200;

/**
 * Live sessions, keyed by session id.
 *
 * A session is registered **before** the upgrade completes, so the cap check and
 * the id check are atomic with admission: nothing else can claim the same id or
 * the same last slot while the handshake is in flight.
 *
 * @type {Map<string, ConversationSession>}
 */
const sessions = new Map();
let totalSessions = 0;
/** Imports currently being read or transcribed, for the concurrency cap. */
let activeImports = 0;
/** Start timestamps of recent imports, for the per-minute cap. */
const recentImportStarts = [];
/** Process-wide counters for /health. Numbers only. */
const counters = {
  rejectedAudioFrames: 0,
  throttledMessages: 0,
  idleTimeouts: 0,
  durationLimitEnds: 0,
  audioBudgetEnds: 0,
  handlerErrors: 0,
  importsCompleted: 0,
  importsRejected: 0,
  importsTooLarge: 0,
  importsTranscribeFailed: 0,
  importsUnavailable: 0,
};

function minutes(ms) {
  return Math.round(ms / 60000);
}

/** Human-readable duration for limit messages (seconds below a minute). */
function describeDuration(ms) {
  if (ms < 60000) return `${Math.max(1, Math.round(ms / 1000))}-second`;
  return `${minutes(ms)}-minute`;
}

/** Human-readable byte size for limit messages. */
function describeBytes(bytes) {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** Rough spoken duration of a PCM16 mono audio budget, for limit messages. */
function describeAudioBudget(bytes) {
  const secondsAt48k = bytes / (48000 * 2);
  return `${Math.floor(secondsAt48k / 60)} minutes`;
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Compares the shared client token without leaking its length through timing.
 *
 * This is still not authentication — the token ships in the app bundle — it just
 * avoids making the throttle trivially guessable character by character.
 */
function tokenAccepted(provided) {
  if (CLIENT_TOKEN.length === 0) return true;
  if (typeof provided !== 'string' || provided.length === 0) return false;

  const given = Buffer.from(provided);
  const expected = Buffer.from(CLIENT_TOKEN);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

/** Reads a query parameter as trimmed text within a length cap. */
function readMetadata(url, name, max = MAX_METADATA_CHARS) {
  const value = url.searchParams.get(name);
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/**
 * Reads a request body, refusing anything past the byte cap.
 *
 * The cap is enforced while reading rather than after: a client that ignores the
 * limit must not be able to make the server buffer an arbitrary body first.
 *
 * When the cap is passed the request is **drained, not destroyed**. Destroying it
 * mid-upload resets the connection, and the client never sees the 413 — the app
 * would report a network failure for a limit it is supposed to explain. Draining
 * is bounded (a few times the cap) so an absurd body still cannot hold the
 * connection open indefinitely.
 */
function readBody(req, limit) {
  const drainCapBytes = limit * 4;

  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let draining = false;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    req.on('data', (chunk) => {
      total += chunk.length;

      if (draining) {
        if (total > drainCapBytes) req.destroy();
        return;
      }

      if (total > limit) {
        draining = true;
        chunks.length = 0;
        finish({ ok: false, reason: 'too-large' });
        if (total > drainCapBytes) req.destroy();
        return;
      }

      chunks.push(chunk);
    });
    req.on('end', () => finish({ ok: true, bytes: Buffer.concat(chunks) }));
    req.on('error', () => finish({ ok: false, reason: 'read-error' }));
    req.on('aborted', () => finish({ ok: false, reason: 'aborted' }));
  });
}

/** True while this process may start another import. Also records the start. */
function admitImport(now) {
  const cutoff = now - 60000;
  while (recentImportStarts.length > 0 && recentImportStarts[0] < cutoff) recentImportStarts.shift();

  if (recentImportStarts.length >= LIMITS.maxImportsPerMinute) return false;
  if (activeImports >= LIMITS.maxConcurrentImports) return false;

  recentImportStarts.push(now);
  return true;
}

/** The MIME types an imported recording may arrive as. */
function isAudioContentType(contentType) {
  const value = String(contentType ?? '').toLowerCase();
  return value.startsWith('audio/') || value.startsWith('application/octet-stream');
}

/**
 * POST /debrief — transcribe one recording and turn it into a Debrief.
 *
 * Order matters: the cheap, unambiguous rejections happen before a single byte
 * of audio is read, and the authoritative duration check happens after the
 * transcript, because only the provider can measure a file whose container the
 * client cannot parse.
 */
async function handleDebriefRequest(req, res, url) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Use POST to analyse a recording.' });
    return;
  }

  const token = url.searchParams.get('token') ?? req.headers['x-psst-token'];
  if (!tokenAccepted(token)) {
    counters.importsRejected += 1;
    sendJson(res, 401, { error: 'This Psst backend requires a valid client token.' });
    return;
  }

  if (!isBatchSttConfigured()) {
    counters.importsUnavailable += 1;
    sendJson(res, 503, {
      error: 'This Psst backend has no transcription provider configured, so it cannot analyse recordings.',
    });
    return;
  }

  const declaredDurationMs = Number(url.searchParams.get('durationMs'));
  if (Number.isFinite(declaredDurationMs) && declaredDurationMs > LIMITS.maxImportDurationMs) {
    counters.importsRejected += 1;
    sendJson(res, 413, {
      error: `That recording is longer than the ${minutes(
        LIMITS.maxImportDurationMs
      )}-minute limit Psst analyses.`,
    });
    return;
  }

  if (!isAudioContentType(req.headers['content-type'])) {
    counters.importsRejected += 1;
    sendJson(res, 400, { error: 'Send the recording itself as audio (for example audio/mp4).' });
    return;
  }

  const now = Date.now();
  if (!admitImport(now)) {
    counters.importsRejected += 1;
    sendJson(res, 429, { error: 'Psst is analysing other recordings right now. Try again in a minute.' });
    return;
  }

  activeImports += 1;
  const startedAt = Date.now();

  try {
    const body = await readBody(req, LIMITS.maxImportBytes);

    if (!body.ok) {
      if (body.reason === 'too-large') {
        counters.importsTooLarge += 1;
        // The client is still uploading; close the connection once this answer
        // has been flushed so the limit is explained rather than reset.
        res.setHeader('connection', 'close');
        sendJson(res, 413, {
          error: `That recording is larger than the ${describeBytes(
            LIMITS.maxImportBytes
          )} Psst analyses.`,
        });
        return;
      }

      counters.importsRejected += 1;
      // An aborted upload may have destroyed the socket already: answer only if
      // there is still someone able to read it.
      if (!res.writableEnded && req.socket?.writable) {
        sendJson(res, 400, { error: 'The recording upload did not complete. Try again.' });
      }
      return;
    }

    if (body.bytes.length === 0) {
      counters.importsRejected += 1;
      sendJson(res, 400, { error: 'The recording was empty.' });
      return;
    }

    const draft = {
      title: readMetadata(url, 'title'),
      contact: readMetadata(url, 'contact'),
      callType: readMetadata(url, 'callType', 40),
      durationMs: Number.isFinite(declaredDurationMs) && declaredDurationMs > 0 ? declaredDurationMs : 0,
    };

    const stt = await transcribeRecording({
      bytes: body.bytes,
      fileName: `import-${startedAt}.${(req.headers['content-type'] || '').includes('wav') ? 'wav' : 'm4a'}`,
      mimeType: String(req.headers['content-type'] ?? 'application/octet-stream'),
    });

    if (!stt.ok) {
      counters.importsTranscribeFailed += 1;
      // Provider detail stays in the server log: it can name internals the app
      // has no use for, and a submission ID is not the user's business.
      console.log(`[psst] import transcription failed after ${Date.now() - startedAt}ms`);
      sendJson(res, 502, {
        error: 'Psst could not transcribe that recording. Check the file and try again.',
      });
      return;
    }

    if (stt.durationMs > LIMITS.maxImportDurationMs) {
      counters.importsRejected += 1;
      sendJson(res, 413, {
        error: `That recording is longer than the ${minutes(
          LIMITS.maxImportDurationMs
        )}-minute limit Psst analyses.`,
      });
      return;
    }

    const reasoning = await buildDebrief({
      draft,
      transcript: stt.lines,
      provider: isSarvamConfigured() ? new SarvamReasoningProvider() : null,
    });

    counters.importsCompleted += 1;
    console.log(
      `[psst] import analysed: ${body.bytes.length}B, ${stt.lines.length} line(s), ` +
        `${Math.round(stt.durationMs / 1000)}s, ${reasoning.degraded ? 'transcript-only' : 'full debrief'}, ` +
        `${Date.now() - startedAt}ms`
    );

    sendJson(res, 200, {
      ok: true,
      origin: 'backend',
      degraded: reasoning.degraded,
      notice: reasoning.notice,
      transcript: {
        lines: stt.lines,
        durationMs: stt.durationMs,
        languageCode: stt.languageCode,
      },
      debrief: reasoning.debrief,
    });
  } catch (error) {
    // One failed import must never take down a server that is also serving other
    // people's uploads.
    counters.handlerErrors += 1;
    const detail = error instanceof Error ? error.message : String(error);
    console.log(`[psst] import handler error: ${detail.slice(0, 200)}`);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'Psst could not analyse that recording.' });
    }
  } finally {
    activeImports -= 1;
  }
}

function handleRequest(req, res) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === DEBRIEF_PATH) {
    void handleDebriefRequest(req, res, url);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    const elevenlabs = getElevenLabsConfig();
    const batchStt = getBatchSttConfig();
    const fal = getFalConfig();
    sendJson(res, 200, {
      status: 'ok',
      service: 'psst-backend',
      phase: 'import',
      // Booleans and names only: no key material, ever.
      elevenlabsConfigured: isElevenLabsConfigured(),
      sarvamConfigured: isSarvamConfigured(),
      // The import pipeline: batch transcription, then the debrief. A recording
      // can only be analysed when the first of these is configured.
      importAnalysisReady: isBatchSttConfigured(),
      batchSttModel: batchStt.modelId,
      batchSttDiarize: batchStt.diarize,
      // Songua's clip pipeline. It needs all three providers: transcription for
      // the lyrics and their timings, Sarvam for the singable translation, and
      // fal for stem separation and the re-sung audio. Reported as one boolean
      // because a partially configured pipeline cannot produce a clip at all.
      falConfigured: isFalConfigured(),
      songuaPipelineReady:
        isFalConfigured() && isBatchSttConfigured() && isSarvamConfigured(),
      demucsModel: fal.demucsModel,
      aceStepModel: fal.aceStepModel,
      elevenlabsModel: elevenlabs.modelId,
      elevenlabsCommitStrategy: elevenlabs.commitStrategy,
      elevenlabsCommitStrategyRejected: elevenlabs.commitStrategyRejected,
      elevenlabsLanguageCode: elevenlabs.languageCode || null,
      sarvamModel: getSarvamConfig().model,
      minCueIntervalMs: MIN_CUE_INTERVAL_MS,
      tokenRequired: CLIENT_TOKEN.length > 0,
      activeImports,
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

  const sessionId = match[1];

  // Bounded concurrency: one deployment cannot be exhausted by connection churn.
  if (sessions.size >= LIMITS.maxSessions) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    socket.destroy();
    return;
  }

  // The cap alone is not enough: two connections claiming the same id would both
  // pass it and the second would silently overwrite the first (and closing one
  // would remove the other's entry). Duplicate ids are refused instead.
  if (sessions.has(sessionId)) {
    socket.write('HTTP/1.1 409 Conflict\r\n\r\n');
    socket.destroy();
    return;
  }

  // Reserve the slot and the id now, while the handshake is still synchronous.
  const session = new ConversationSession({ id: sessionId });
  sessions.set(sessionId, session);

  /**
   * Releases this reservation: exactly once, and only for this session.
   *
   * A handshake can fail **without throwing and without invoking the callback** —
   * an invalid `Sec-WebSocket-Key` is answered with HTTP 400, and a socket that
   * already sent FIN is destroyed — so a reservation cannot be left to the
   * connection handler alone. Leaking one would permanently consume a slot of the
   * concurrency budget.
   */
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (sessions.get(sessionId) === session) sessions.delete(sessionId);
  };

  /** Set by the upgrade callback; until then this reservation owns cleanup. */
  let upgraded = false;
  const releaseIfUnfinished = () => {
    if (!upgraded) release();
  };
  // A socket that dies mid-handshake never reaches the connection handler.
  socket.once('error', releaseIfUnfinished);
  socket.once('close', releaseIfUnfinished);

  try {
    wss.handleUpgrade(req, socket, head, (ws) => {
      // The handshake succeeded: the live connection now owns cleanup for this
      // session, and shares the same idempotent, identity-checked release.
      upgraded = true;
      wss.emit('connection', ws, req, session, release);
    });
  } catch (error) {
    release();
    try {
      socket.destroy();
    } catch {
      // Already gone.
    }
    console.warn(`[psst] upgrade failed for ${sessionId}: ${String(error)}`);
    return;
  }

  // `ws` refuses a bad handshake by aborting the socket, not by throwing, so a
  // missing callback is the only signal that this reservation is unconsumed.
  if (!upgraded) release();
});

wss.on('connection', (socket, _req, session, releaseReservation) => {
  const sessionId = session.id;
  totalSessions += 1;

  /**
   * Removes this connection's registration, and only its own: a duplicate id can
   * never have been admitted, but a stale callback must still not be able to
   * evict a different live session.
   */
  const releaseSession =
    releaseReservation ??
    (() => {
      if (sessions.get(sessionId) === session) sessions.delete(sessionId);
    });

  // One reasoning provider per session keeps the conversation state local.
  const provider = createReasoningProvider();

  /** @type {{ detach: () => void, finalize: () => Promise<boolean>, commit: () => void, pause: () => void }} */
  let transcription = { detach: () => {}, finalize: async () => false, commit: () => {}, pause: () => {} };
  let started = false;
  let stopping = false;
  let closed = false;
  let unsupportedFormatReported = false;
  let oversizedFrameReported = false;
  let audioBudgetReported = false;
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

    // Tell the app the session is over *now*, before the provider flush and the
    // recap. This is what stops microphone capture at the client while the
    // connection stays open for the recap that follows: waiting until the recap
    // is ready would leave the microphone running through the whole finalization
    // (an audio-budget or duration end reaches the app this way).
    send(statusMessage('ended'));

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
        releaseSession();
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
        releaseSession();
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

  /**
   * One client message, start to finish.
   *
   * Parsing is total by construction, but this runs on hostile input inside a
   * network callback: anything unexpected is contained to the one frame instead
   * of escaping as an uncaught exception that would kill the process for every
   * session. The counter keeps it visible in /health rather than silent.
   */
  const handleMessage = (raw) => {
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
        // The pause boundary invalidates anything the model is still thinking
        // about: a cue for speech from before the pause must not surface after
        // the user resumes. Whatever was heard is kept for the recap.
        transcription.pause();
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

      case 'audio.frame': {
        const outcome = session.pushAudioFrame(message);

        // The session's audio budget is a hard ceiling, so it is handled
        // visibly: one explanation, then a clean end that flushes what was
        // already accepted and still delivers an honest recap. Frames arriving
        // after this point are dropped without another word.
        if (outcome === 'limit-reached' && !audioBudgetReported) {
          audioBudgetReported = true;
          counters.audioBudgetEnds += 1;
          send(
            noticeMessage(
              'warning',
              `This session reached the ${describeBytes(
                LIMITS.maxSessionAudioBytes
              )} audio limit (about ${describeAudioBudget(
                LIMITS.maxSessionAudioBytes
              )} of speech at 48 kHz) and was ended. Your recap is below.`
            )
          );
          finishSession();
        }
        break;
      }

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
  };

  socket.on('message', (raw) => {
    try {
      handleMessage(raw);
    } catch (error) {
      counters.handlerErrors += 1;
      console.warn(`[psst] dropped a client message that could not be handled: ${String(error)}`);
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
    transcription = { detach: () => {}, finalize: async () => false, commit: () => {}, pause: () => {} };
    releaseSession();
  });
});

const httpServer = server.listen(PORT, HOST, () => {
  const elevenlabs = getElevenLabsConfig();
  console.log(`[psst] backend listening on http://${HOST}:${PORT} (import debriefs)`);
  console.log(`[psst] import endpoint: POST http://${HOST}:${PORT}/debrief`);
  console.log(
    `[psst] legacy session endpoint (unused by the app): ws://${HOST}:${PORT}/sessions/{id}/stream`
  );
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
  const batchStt = getBatchSttConfig();
  console.log(
    `[psst] import analysis: ${
      isBatchSttConfigured()
        ? `ready (${batchStt.modelId}, diarize=${batchStt.diarize})`
        : 'unavailable (no transcription provider configured)'
    } maxImport=${describeBytes(LIMITS.maxImportBytes)} maxImportDuration=${minutes(
      LIMITS.maxImportDurationMs
    )}min perMinute=${LIMITS.maxImportsPerMinute} concurrent=${LIMITS.maxConcurrentImports}`
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
