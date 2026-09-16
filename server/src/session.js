/**
 * In-memory session state for one live Psst conversation.
 *
 * Sessions live in memory only: no database, no persistence. When a session ends
 * the backend returns a recap built from what it collected and the entry is
 * dropped.
 *
 * This object is also the compact conversation state handed to the reasoning
 * provider: the user's goal, recent final dialogue, the important moments and the
 * cues already shown. Partials are deliberately excluded — they are display-only.
 */

import { pushRecentCue } from './cue.js';
import { pcmDurationMs } from './audio.js';
import { LIMITS } from './limits.js';

export class ConversationSession {
  constructor({ id, goal = null, client = null }) {
    this.id = id;
    this.goal = goal;
    this.client = client;
    this.status = 'idle';
    this.startedAt = new Date().toISOString();
    this.endedAt = null;
    /** Latest entry per id: partials are replaced by their final version. */
    this.entries = [];
    this.cues = [];
    /** Rolling window of recent cues, kept for de-duplication and suppression. */
    this.recentCues = [];
    this.listeningMs = 0;
    this.listeningSince = null;

    /** Audio diagnostics. Counted, never stored: raw frames are not retained. */
    this.audioFrames = 0;
    this.audioBytes = 0;
    this.audioDurationMs = 0;
    /** Frames dropped because the session was not listening (or had too much audio). */
    this.droppedAudioFrames = 0;
    /** Frames the protocol layer refused before they reached the session. */
    this.rejectedAudioFrames = 0;
    /** True once this session has hit its total-audio ceiling. */
    this.audioLimitReached = false;
    /** @type {{ sampleRate: number, channels: number, encoding: string, audioFormat: string } | null} */
    this.audioConfig = null;

    /** 'idle' | 'ready' | 'streaming' | 'failed' */
    this.transcriptionState = 'idle';
    this.partialUpdates = 0;

    /** Reasoning counters, surfaced in /health and logs as numbers only. */
    this.reasoningCalls = 0;
    this.reasoningFailures = 0;
    this.reasoningFailureReported = false;
    /** Timestamp of the last cue, used for the minimum-interval suppression. */
    this.lastCueAt = null;

    /** Set by the transcription attachment: the STT provider's audio intake. */
    this.audioSink = null;
  }

  start(goal, client) {
    this.goal = goal;
    this.client = client;
    this.startedAt = new Date().toISOString();
    this.setStatus('listening');
  }

  pause() {
    if (this.status === 'listening') this.setStatus('paused');
  }

  resume() {
    if (this.status === 'paused') this.setStatus('listening');
  }

  end() {
    this.setStatus('ended');
    this.endedAt = new Date().toISOString();
    this.audioSink = null;
  }

  addTranscriptEntry(entry) {
    const index = this.entries.findIndex((candidate) => candidate.id === entry.id);
    if (index === -1) this.entries.push(entry);
    else this.entries[index] = entry;
  }

  addCue(cue) {
    this.cues.push(cue);
    this.recentCues = pushRecentCue(this.recentCues, cue);
    this.lastCueAt = Date.now();
  }

  /**
   * Forwards one microphone frame to the transcription pipeline.
   * Frames arriving while paused, or before STT is attached, are dropped and
   * counted rather than buffered: Psst never accumulates audio it is not
   * actively transcribing. A session also has a total-audio ceiling so one
   * connection cannot stream forever.
   */
  pushAudioFrame(frame) {
    if (!frame || !frame.audio) {
      this.rejectedAudioFrames += 1;
      return;
    }
    if (!this.audioSink || this.status !== 'listening') {
      this.droppedAudioFrames += 1;
      return;
    }

    const bytes = frame.byteLength || 0;
    if (this.audioBytes + bytes > LIMITS.maxSessionAudioBytes) {
      this.droppedAudioFrames += 1;
      this.audioLimitReached = true;
      return;
    }

    this.audioFrames += 1;
    if (this.audioConfig === null) this.audioConfig = frame.audio;

    this.audioBytes += bytes;
    this.audioDurationMs += pcmDurationMs(bytes, frame.audio.sampleRate, frame.audio.channels);

    this.audioSink(frame);
  }

  get durationMs() {
    const running = this.listeningSince === null ? 0 : Date.now() - this.listeningSince;
    return Math.max(0, this.listeningMs + running);
  }

  get finalEntries() {
    return this.entries.filter((entry) => entry.isFinal);
  }

  setStatus(status) {
    if (this.status === status) return;

    if (this.status === 'listening' && this.listeningSince !== null) {
      this.listeningMs += Date.now() - this.listeningSince;
      this.listeningSince = null;
    }
    if (status === 'listening') {
      this.listeningSince = Date.now();
    }

    this.status = status;
  }

  /** Resets the clock references so a stopped session reports a frozen duration. */
  freezeClock() {
    if (this.listeningSince !== null) {
      this.listeningMs += Date.now() - this.listeningSince;
      this.listeningSince = null;
    }
  }
}
