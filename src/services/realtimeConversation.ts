/**
 * RealtimeConversationService — the live engine, behind the same interface as
 * the demo engine.
 *
 * Speaks the protocol in `src/types/realtime.ts` to the Psst backend, which is
 * the only place that ever touches ElevenLabs. It emits exactly the same events
 * as `MockConversationService`, so the LIVE screen does not change when the
 * engine is swapped.
 *
 * Transport (this file): session lifecycle over WSS, microphone frames out as
 * `audio.frame`, transcript/cue/notice frames in. The backend owns every
 * provider integration, so no ElevenLabs or Sarvam detail exists here.
 *
 * Stopping is deliberately synchronous in effect: the status leaves `listening`
 * the moment `stop()` is called, so microphone capture stops and no further
 * audio is sent while the recap is still on its way. The socket stays open only
 * to receive that recap.
 *
 * It fails soft: an unreachable or misconfigured backend produces an ERROR event
 * (and an honest recap), never a crash.
 */

import Constants from 'expo-constants';
import { Platform } from 'react-native';

import { AUDIO_FRAME_MAX_BYTES } from '@/constants/audio';
import { resolveRealtimeSocketTarget } from '@/services/backend';
import type {
  ConversationEvent,
  ConversationGoal,
  ConversationService,
  ConversationStatus,
  MicrophoneFrame,
  PsstCue,
  Recap,
  TranscriptEntry,
} from '@/types/conversation';
import { encodeBase64, sliceBytes } from '@/utils/base64';
import {
  encodeClientMessage,
  parseServerMessage,
  type ClientMessage,
  type RealtimeClientInfo,
} from '@/types/realtime';

type Listener = (event: ConversationEvent) => void;

/** How long to wait for the socket to open before giving up. */
const CONNECT_TIMEOUT_MS = 8000;
/** How long to wait for the backend recap before falling back locally. */
const STOP_TIMEOUT_MS = 12000;
/**
 * Unsent bytes tolerated on the socket before captured audio is dropped.
 * A stalled connection must not turn into a growing backlog of stale audio:
 * a cue about something said a minute ago is worthless.
 */
const MAX_SOCKET_BUFFER_BYTES = 512 * 1024;

/** Statuses in which the session is expected to be usable. */
const LIVE_STATUSES: ConversationStatus[] = ['connecting', 'listening', 'paused'];

function createSessionId(): string {
  return `psst-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function describe(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'The connection to the Psst backend failed.';
}

function clientInfo(): RealtimeClientInfo {
  return {
    platform: Platform.OS,
    appVersion: Constants.expoConfig?.version ?? 'unknown',
  };
}

export class RealtimeConversationService implements ConversationService {
  readonly kind = 'realtime' as const;

  private readonly sessionId: string;
  private listeners = new Set<Listener>();
  private socket: WebSocket | null = null;
  private socketOpen = false;
  private status: ConversationStatus = 'idle';
  private goal: ConversationGoal | null = null;
  private entries: TranscriptEntry[] = [];
  private cues: PsstCue[] = [];
  private startedAtIso = new Date().toISOString();
  private accumulatedMs = 0;
  private runStartedAt: number | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRecap: ((recap: Recap | null) => void) | null = null;
  /** A recap the backend sent without being asked (it ended the session itself). */
  private unclaimedRecap: Recap | null = null;
  /** True once the backend has ended the session on its own. */
  private serverEnded = false;
  private congestionReported = false;
  private droppedAudioFrames = 0;
  /** Cues that arrived after the session stopped listening. Diagnostics only. */
  private droppedStaleCues = 0;
  /** Monotonic counter for audio frames; the backend uses it for diagnostics. */
  private audioSeq = 0;

  constructor(sessionId: string = createSessionId()) {
    this.sessionId = sessionId;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getStatus(): ConversationStatus {
    return this.status;
  }

  start(goal: ConversationGoal): void {
    this.teardownSocket();

    this.goal = goal;
    this.entries = [];
    this.cues = [];
    this.audioSeq = 0;
    this.accumulatedMs = 0;
    this.runStartedAt = null;
    this.startedAtIso = new Date().toISOString();
    this.unclaimedRecap = null;
    this.serverEnded = false;
    this.congestionReported = false;
    this.droppedAudioFrames = 0;
    this.droppedStaleCues = 0;
    this.setStatus('connecting');

    const target = resolveRealtimeSocketTarget(this.sessionId);
    if ('error' in target) {
      this.fail(target.error);
      return;
    }

    let socket: WebSocket;
    try {
      socket = new WebSocket(target.url);
    } catch (error) {
      this.fail(describe(error));
      return;
    }

    this.socket = socket;

    this.connectTimer = setTimeout(() => {
      if (this.status !== 'connecting') return;
      this.fail('The Psst backend did not respond in time.');
      this.teardownSocket();
    }, CONNECT_TIMEOUT_MS);

    socket.onopen = () => {
      this.clearConnectTimer();
      this.socketOpen = true;
      this.setStatus('listening');
      this.send({ t: 'session.start', goal, client: clientInfo() });
    };

    socket.onmessage = (event: WebSocketMessageEvent) => {
      if (typeof event.data === 'string') this.handleMessage(event.data);
    };

    socket.onerror = () => {
      if (!this.serverEnded && LIVE_STATUSES.includes(this.status)) {
        this.fail('The connection to the Psst backend was interrupted.');
      }
      // The recap can no longer arrive: do not keep the user waiting for it.
      this.settlePendingRecap(null);
    };

    socket.onclose = () => {
      this.clearConnectTimer();
      this.socketOpen = false;
      this.socket = null;
      // A backend-initiated end is not a failure: it already sent its recap.
      if (this.serverEnded) {
        this.setStatus('ended');
        this.settlePendingRecap(null);
        return;
      }
      if (LIVE_STATUSES.includes(this.status)) {
        this.fail('The connection to the Psst backend closed.');
      }
      this.settlePendingRecap(null);
    };
  }

  pause(): void {
    if (this.status !== 'listening') return;
    this.setStatus('paused');
    this.send({ t: 'session.pause' });
  }

  resume(): void {
    if (this.status !== 'paused') return;
    this.setStatus('listening');
    this.send({ t: 'session.resume' });
  }

  /**
   * Sends one captured microphone buffer to the backend.
   *
   * Frames are forwarded exactly as captured (PCM16 little-endian mono) with the
   * rate the device delivered, so nothing is resampled or re-encoded. Audio only
   * flows while the session is actually listening: paused, connecting or ended
   * sessions drop frames instead of accumulating a recording.
   */
  pushAudio(frame: MicrophoneFrame): void {
    if (this.status !== 'listening' || !this.socketOpen) return;
    if (frame.channels !== 1 || frame.encoding !== 'int16') return;
    if (frame.pcm.byteLength === 0 || frame.sampleRate <= 0) return;

    const socket = this.socket;
    if (!socket) return;

    // Congestion is explicit rather than silent: drop live audio, tell the user
    // once, and never queue a backlog of audio that is no longer relevant.
    if (typeof socket.bufferedAmount === 'number' && socket.bufferedAmount > MAX_SOCKET_BUFFER_BYTES) {
      this.droppedAudioFrames += 1;
      this.reportCongestion();
      return;
    }

    const audio = { sampleRate: frame.sampleRate, channels: 1, encoding: 'int16' as const };

    // An unusually large buffer is split so a single frame can never exceed what
    // the backend will accept.
    for (const slice of sliceBytes(frame.pcm, AUDIO_FRAME_MAX_BYTES)) {
      this.audioSeq += 1;
      this.send({
        t: 'audio.frame',
        seq: this.audioSeq,
        pcm: encodeBase64(slice),
        audio,
        byteLength: slice.byteLength,
      });
    }
  }

  async stop(): Promise<Recap> {
    const durationMs = this.elapsed();
    const canWaitForRecap =
      this.socketOpen && !this.serverEnded && this.status !== 'error' && this.status !== 'ended';

    // Leave `listening` immediately: this is what stops microphone capture and
    // blocks every further outgoing frame, before any asynchronous recap work.
    this.setStatus('ended');

    if (canWaitForRecap) {
      this.send({ t: 'session.stop' });
      const recap = await this.waitForRecap();
      this.teardownSocket();
      if (recap) return recap;
    } else {
      this.teardownSocket();
    }

    const claimed = this.unclaimedRecap;
    this.unclaimedRecap = null;
    if (claimed) return claimed;

    return this.buildLocalRecap(durationMs);
  }

  /** Releases the socket and timers. Called when the LIVE screen unmounts. */
  dispose(): void {
    this.pendingRecap?.(null);
    this.pendingRecap = null;
    this.unclaimedRecap = null;
    this.serverEnded = false;
    this.clearTimers();
    this.teardownSocket();
    this.listeners.clear();
    this.status = 'idle';
  }

  // ---------------------------------------------------------------- internals

  private handleMessage(raw: string): void {
    const message = parseServerMessage(raw);
    if (!message) return;

    switch (message.t) {
      case 'status':
        this.setStatus(message.status);
        break;

      case 'transcript.partial':
      case 'transcript.final': {
        const entry = message.entry;
        const index = this.entries.findIndex((candidate) => candidate.id === entry.id);
        if (index === -1) this.entries.push(entry);
        else this.entries[index] = entry;

        this.emit(
          message.t === 'transcript.final'
            ? { type: 'TRANSCRIPT_FINAL', entry }
            : { type: 'TRANSCRIPT_PARTIAL', entry }
        );
        break;
      }

      case 'psst':
        // A cue is only useful while Psst is actually listening. One produced
        // before a pause/stop reached the server is dropped instead of popping
        // onto a screen the user has already left.
        if (this.status !== 'listening') {
          this.droppedStaleCues += 1;
          break;
        }
        this.cues.push(message.cue);
        this.emit({ type: 'PSST', cue: message.cue });
        break;

      case 'recap': {
        if (this.pendingRecap) {
          this.settlePendingRecap(message.recap);
          break;
        }
        // Nobody asked for it: the backend ended the session itself (idle or
        // duration limit). Keep it, so ending from the app still shows it.
        this.unclaimedRecap = message.recap;
        this.serverEnded = true;
        break;
      }

      case 'notice':
        // Non-fatal: the session keeps running, the user is told what degraded.
        this.emit({ type: 'NOTICE', level: message.level, message: message.message });
        break;

      case 'error':
        this.fail(message.message);
        break;
    }
  }

  private send(message: ClientMessage): void {
    const socket = this.socket;
    if (!socket || !this.socketOpen) return;
    try {
      socket.send(encodeClientMessage(message));
    } catch {
      // A failed control frame is not worth interrupting the session for; the
      // socket onclose/onerror handlers report anything serious.
    }
  }

  private reportCongestion(): void {
    if (this.congestionReported) return;
    this.congestionReported = true;
    this.emit({
      type: 'NOTICE',
      level: 'warning',
      message:
        'Your connection is too slow to stream audio continuously, so Psst dropped some audio. The transcript may have gaps and cues may be less accurate.',
    });
  }

  /** Resolves an in-flight recap wait, from a recap frame or from a dead socket. */
  private settlePendingRecap(recap: Recap | null): void {
    const resolve = this.pendingRecap;
    this.pendingRecap = null;
    this.clearStopTimer();
    resolve?.(recap);
  }

  private waitForRecap(): Promise<Recap | null> {
    return new Promise((resolve) => {
      this.pendingRecap = resolve;

      this.stopTimer = setTimeout(() => {
        this.pendingRecap = null;
        resolve(null);
      }, STOP_TIMEOUT_MS);
    });
  }

  /**
   * Used when the backend does not return a recap: reports exactly what arrived
   * instead of inventing summary content.
   */
  private buildLocalRecap(durationMs: number): Recap {
    const goal = this.goal;
    const title = goal && goal.title.trim() !== '' ? goal.title : 'Realtime session';

    return {
      id: `realtime-${this.sessionId}`,
      title,
      preset: goal?.preset ?? 'other',
      goal: goal ?? { title, objective: '', notes: '', preset: 'other' },
      startedAt: this.startedAtIso,
      endedAt: new Date().toISOString(),
      durationMs,
      summary:
        this.status === 'error'
          ? 'This session did not reach the Psst backend, so no summary was generated.'
          : 'The Psst backend did not return a summary for this session. What arrived before the session ended is listed below.',
      keyPoints: this.entries.filter((entry) => entry.isFinal).map((entry) => entry.text),
      commitments: [],
      missed: [],
      nextActions: [],
      cueCount: this.cues.length,
    };
  }

  private elapsed(): number {
    if (this.runStartedAt === null) return this.accumulatedMs;
    return this.accumulatedMs + (Date.now() - this.runStartedAt);
  }

  private setStatus(status: ConversationStatus): void {
    if (this.status === status) return;

    if (this.status === 'listening' && this.runStartedAt !== null) {
      this.accumulatedMs += Date.now() - this.runStartedAt;
      this.runStartedAt = null;
    }
    if (status === 'listening') {
      this.runStartedAt = Date.now();
    }

    this.status = status;
    this.emit({ type: 'STATUS', status });
  }

  private fail(message: string): void {
    this.setStatus('error');
    this.emit({ type: 'ERROR', message });
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private clearStopTimer(): void {
    if (this.stopTimer !== null) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearConnectTimer();
    this.clearStopTimer();
  }

  private teardownSocket(): void {
    this.clearConnectTimer();
    const socket = this.socket;
    this.socket = null;
    this.socketOpen = false;

    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close();
      } catch {
        // Already closed.
      }
    }
  }

  private emit(event: ConversationEvent): void {
    this.listeners.forEach((listener) => listener(event));
  }
}
