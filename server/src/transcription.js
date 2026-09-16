/**
 * Transcription pipeline.
 *
 *   audio.frame -> ElevenLabs realtime STT -> transcript frames -> decide()
 *               -> NO_ACTION / PSST -> psst frame
 *
 * Partials are display-only: they stream to the LIVE screen so the user can see
 * words as they are spoken, but they never reach the reasoning model.
 *
 * Only committed (final) utterances update conversation state and are eligible
 * for reasoning, and even then only if the gate below says an evaluation is
 * warranted. That keeps cost, latency and noise down.
 *
 * Scheduling rule: a final arriving while an evaluation is already running is
 * **not** discarded. Pending work is coalesced to the most recent relevant final
 * and evaluated as soon as the in-flight request finishes, so the last thing
 * somebody said is always considered.
 *
 * Staleness rule: a result that comes back after the session was paused,
 * stopped, detached or replaced is dropped before it can reach the UI. A cue is
 * only useful while the user is actually listening. Pausing is an explicit
 * boundary: it invalidates in-flight reasoning and clears queued work, because a
 * cue about speech from before a pause is worthless once the user resumes.
 * Nothing is reasoned about while paused, and no cue is emitted while paused —
 * the transcript itself is still kept, so the recap stays complete.
 *
 * Every failure path is non-fatal: a provider problem emits a notice frame and
 * the session keeps running (silently, if that is what reality dictates) rather
 * than dying.
 */

import { openTranscriptionSession, isElevenLabsConfigured, getElevenLabsConfig } from './elevenlabs.js';
import { psstMessage, transcriptMessage, noticeMessage } from './protocol.js';
import { OUTCOME, createReasoningProvider, decide } from './reasoning.js';

/** Utterances shorter than this are not worth a reasoning call. */
const REASONING_MIN_WORDS = 3;
/** Floor between two reasoning calls, in case finals arrive back to back. */
const REASONING_MIN_GAP_MS = 600;
/**
 * A final that has waited this long for the reasoning gate is no longer worth a
 * cue: by then the conversation has moved on.
 */
const PENDING_FINAL_MAX_AGE_MS = 5000;

const VALID_TONES = new Set(['opportunity', 'risk', 'question', 'signal']);

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

function createCueId() {
  return `cue-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function pickTone(tone) {
  return typeof tone === 'string' && VALID_TONES.has(tone) ? tone : 'signal';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function inertAttachment() {
  return { detach: () => {}, finalize: async () => false, commit: () => {}, pause: () => {} };
}

/**
 * @param {import('./session.js').ConversationSession} session
 * @param {(message: object) => void} emit protocol frame emitter
 * @param {{ provider?: object | null }} [options]
 * @returns {{ detach: () => void, finalize: () => Promise<boolean>, commit: () => void, pause: () => void }}
 */
export function attachTranscription(session, emit, options = {}) {
  const provider = options.provider === undefined ? createReasoningProvider() : options.provider;

  if (!isElevenLabsConfigured()) {
    emit(
      noticeMessage(
        'warning',
        'Realtime transcription is unavailable: the server has no ElevenLabs key configured. The session will stay silent.'
      )
    );
    return inertAttachment();
  }

  const sttConfig = getElevenLabsConfig();
  /** With `manual` commit there is no VAD, so the server commits at its own boundaries. */
  const manualCommit = sttConfig.commitStrategy === 'manual';

  /** Segment counter: a partial and its commit share one transcript entry id. */
  let segment = 0;
  /** @type {string | null} */
  let partialId = null;
  let lastFinalText = '';
  /** Bumped whenever in-flight work stops being relevant (pause/stop/detach). */
  let epoch = 0;
  /** @type {{ entry: object, queuedAt: number } | null} */
  let pendingFinal = null;
  let draining = false;
  let lastReasoningAt = 0;
  let sttFailureReported = false;
  let congestionReported = false;
  let stopping = false;
  let closed = false;

  const makeEntryId = () => `${session.id}-line-${segment}`;

  /** True while the session should still be producing cues. */
  const listening = () => !closed && !stopping && session.status === 'listening';

  /** True when a result produced now is still worth showing. */
  const stillRelevant = (myEpoch) => listening() && myEpoch === epoch;

  const handleSttError = (message) => {
    session.transcriptionState = 'failed';
    if (sttFailureReported) return;
    sttFailureReported = true;
    // The session survives: this is a warning about a degraded pipeline, not an
    // end-of-session event.
    emit(
      noticeMessage(
        'warning',
        `Live transcription stopped: ${message} The session is still running, but new speech will not appear.`
      )
    );
  };

  const handlePartial = (text) => {
    if (closed || stopping || session.status === 'paused') return;

    if (partialId === null) partialId = makeEntryId();

    const entry = {
      id: partialId,
      speaker: 'them',
      text,
      isFinal: false,
      at: session.durationMs,
    };
    session.addTranscriptEntry(entry);
    session.partialUpdates += 1;
    emit(transcriptMessage(entry));
  };

  const runReasoning = async (entry, myEpoch) => {
    lastReasoningAt = Date.now();
    session.reasoningCalls += 1;

    try {
      const result = await decide(
        {
          goal: session.goal,
          transcript: session.finalEntries,
          latest: entry,
          recentCues: session.recentCues,
          lastCueAt: session.lastCueAt,
        },
        { provider }
      );

      // The session moved on while the model was thinking: this cue is stale.
      if (!stillRelevant(myEpoch)) return;

      if (result.outcome !== OUTCOME.PSST || !result.cue) {
        if (result.error) {
          session.reasoningFailures += 1;
          // One notice is enough; a flaky provider must not spam the screen.
          if (!session.reasoningFailureReported) {
            session.reasoningFailureReported = true;
            emit(
              noticeMessage(
                'info',
                'Psst is transcribing normally, but the cue engine could not be reached, so no suggestions are being generated right now.'
              )
            );
          }
        }
        return;
      }

      const cue = {
        id: createCueId(),
        observation: result.cue.observation,
        action: result.cue.suggestion,
        tone: pickTone(result.cue.tone),
        at: session.durationMs,
      };
      session.addCue(cue);
      emit(psstMessage(cue));
    } catch (error) {
      session.reasoningFailures += 1;
      console.warn(`[psst] reasoning failed, staying silent: ${describe(error)}`);
    }
  };

  /**
   * Evaluates pending finals one at a time, always picking up the most recent
   * one. This is what keeps a final that arrived while reasoning was busy from
   * being lost.
   */
  const drainReasoning = async () => {
    if (draining) return;
    draining = true;

    try {
      // `listening()` covers pause as well as stop/detach: nothing is evaluated
      // while the user is not being listened to.
      while (pendingFinal && listening()) {
        const { entry, queuedAt } = pendingFinal;
        pendingFinal = null;

        // Already superseded by newer speech, or too old to be worth a cue.
        if (Date.now() - queuedAt > PENDING_FINAL_MAX_AGE_MS) continue;

        const waitMs = REASONING_MIN_GAP_MS - (Date.now() - lastReasoningAt);
        if (waitMs > 0) {
          await sleep(waitMs);
          // A newer final arrived while we waited: evaluate that one instead.
          if (pendingFinal) continue;
          if (!listening()) break;
        }

        const myEpoch = epoch;
        await runReasoning(entry, myEpoch);
      }
    } finally {
      draining = false;
    }
  };

  const handleFinal = (text) => {
    if (closed) return;

    const trimmed = text.trim();
    if (trimmed === '' || trimmed === lastFinalText) {
      partialId = null;
      segment += 1;
      return;
    }
    lastFinalText = trimmed;

    const entry = {
      id: partialId ?? makeEntryId(),
      speaker: 'them',
      text: trimmed,
      isFinal: true,
      at: session.durationMs,
    };
    partialId = null;
    segment += 1;

    session.addTranscriptEntry(entry);
    emit(transcriptMessage(entry));

    // A final that arrives while the session is ending is the last thing that
    // was said: it is kept for the recap, but the user has already ended the
    // session so it must not produce a cue.
    if (stopping) return;
    // The same is true of a paused session. A pause commits what was heard (the
    // transcript below is preserved for the recap), but reasoning must not start
    // on it: the cue would arrive after the user resumed, about speech from
    // before the pause.
    if (session.status === 'paused') return;
    if (wordCount(trimmed) < REASONING_MIN_WORDS) return;

    pendingFinal = { entry, queuedAt: Date.now() };
    void drainReasoning();
  };

  let transcription;
  try {
    transcription = openTranscriptionSession({
      onPartial: handlePartial,
      onFinal: handleFinal,
      onError: handleSttError,
      onCongestion: () => {
        if (congestionReported) return;
        congestionReported = true;
        emit(
          noticeMessage(
            'warning',
            'Psst is dropping some audio because the transcription connection cannot keep up, so the transcript may have gaps.'
          )
        );
      },
      onOpen: () => {
        session.transcriptionState = 'streaming';
      },
    });
  } catch (error) {
    session.transcriptionState = 'failed';
    console.warn(`[psst] transcription unavailable, session stays silent: ${describe(error)}`);
    emit(
      noticeMessage(
        'warning',
        'Realtime transcription could not be started on the server, so this session will stay silent.'
      )
    );
    return inertAttachment();
  }

  session.transcriptionState = 'ready';
  session.audioSink = (frame) => {
    // The delivered rate lives on the validated audio block; `frame.sampleRate`
    // does not exist on the wire and would silently fall back to 16 kHz.
    if (!frame || !frame.audio) return;
    transcription.sendAudio(frame.pcm, frame.audio.sampleRate);
  };

  const detach = () => {
    closed = true;
    stopping = true;
    epoch += 1;
    pendingFinal = null;
    session.audioSink = null;
    try {
      transcription.close();
    } catch {
      // Already closed.
    }
  };

  return {
    detach,

    /**
     * Ends transcription without ending the session's record of it: the provider
     * is asked to commit what it has already received, the resulting final
     * transcript is given a bounded window to arrive, and only then is the
     * provider socket closed. The physical microphone is already off.
     *
     * @returns {Promise<boolean>} true when the provider committed a final utterance
     */
    finalize: async () => {
      if (closed) return false;
      stopping = true;
      // Anything the model is still chewing on is no longer relevant.
      epoch += 1;
      pendingFinal = null;

      const committed = await transcription.flush();
      detach();
      return committed;
    },

    /**
     * Boundary commit for `manual` commit strategy, where the provider never
     * commits on its own. A no-op in the default VAD mode.
     */
    commit: () => {
      if (closed || !manualCommit) return;
      void transcription.flush();
    },

    /**
     * Pause boundary. Whatever the model is currently working on belongs to
     * speech from before the pause, and whatever is queued is from then too, so
     * both are invalidated here. Resuming starts from a clean slate: the next
     * final after resume is reasoned about normally.
     */
    pause: () => {
      epoch += 1;
      pendingFinal = null;
    },
  };
}
