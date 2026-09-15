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
 * Every failure path is non-fatal: a provider problem emits a notice frame and
 * the session keeps running (silently, if that is what reality dictates) rather
 * than dying.
 */

import { openTranscriptionSession, isElevenLabsConfigured } from './elevenlabs.js';
import { psstMessage, transcriptMessage, noticeMessage } from './protocol.js';
import { OUTCOME, createReasoningProvider, decide } from './reasoning.js';

/** Utterances shorter than this are not worth a reasoning call. */
const REASONING_MIN_WORDS = 3;
/** Floor between two reasoning calls, in case finals arrive back to back. */
const REASONING_MIN_GAP_MS = 600;
/** Grace period after stop, so a commit already in flight still lands. */
const FINALIZE_GRACE_MS = 400;

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

/**
 * @param {import('./session.js').ConversationSession} session
 * @param {(message: object) => void} emit protocol frame emitter
 * @param {{ provider?: object | null }} [options]
 * @returns {{ detach: () => void, finalize: () => Promise<void> }}
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
    return { detach: () => {}, finalize: async () => {} };
  }

  /** Segment counter: a partial and its commit share one transcript entry id. */
  let segment = 0;
  /** @type {string | null} */
  let partialId = null;
  let lastFinalText = '';
  let reasoningInFlight = false;
  let lastReasoningAt = 0;
  let sttFailureReported = false;
  let closed = false;

  const makeEntryId = () => `${session.id}-line-${segment}`;

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
    if (closed || session.status === 'paused') return;

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

  const runReasoning = async (entry) => {
    reasoningInFlight = true;
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
    } finally {
      reasoningInFlight = false;
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

    // Gate: is a reasoning evaluation warranted for this utterance at all?
    if (reasoningInFlight) return;
    if (wordCount(trimmed) < REASONING_MIN_WORDS) return;
    if (Date.now() - lastReasoningAt < REASONING_MIN_GAP_MS) return;

    void runReasoning(entry);
  };

  let transcription;
  try {
    transcription = openTranscriptionSession({
      onPartial: handlePartial,
      onFinal: handleFinal,
      onError: handleSttError,
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
    return { detach: () => {}, finalize: async () => {} };
  }

  session.transcriptionState = 'ready';
  session.audioSink = (frame) => {
    transcription.sendAudio(frame.pcm, frame.sampleRate);
  };

  const detach = () => {
    closed = true;
    session.audioSink = null;
    try {
      transcription.close();
    } catch {
      // Already closed.
    }
  };

  return {
    detach,
    finalize: async () => {
      if (closed) return;
      // Give a commit that is already in flight a moment to arrive before the
      // provider socket closes. We never synthesise a transcript for audio that
      // was not committed by the provider.
      await new Promise((resolve) => setTimeout(resolve, FINALIZE_GRACE_MS));
      detach();
    },
  };
}
