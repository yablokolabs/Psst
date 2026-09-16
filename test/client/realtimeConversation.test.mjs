/**
 * Realtime transport regression tests.
 *
 * These run the app's own `RealtimeConversationService` (the file that ships)
 * against a fake WebSocket, so the microphone-gating and staleness rules below
 * are asserted without a device:
 *
 *   - tapping End blocks outgoing audio immediately, while the recap is still
 *     in flight (the bug: the status stayed `listening`, so the mic kept
 *     capturing and frames kept flowing)
 *   - a cue produced for speech from before a pause/stop never reaches the UI
 *   - a stalled socket drops live audio instead of growing a backlog
 *   - the recap that arrives after End is still used
 */

import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

process.env.EXPO_PUBLIC_PSST_BACKEND_URL = 'https://psst.example.com';

const { RealtimeConversationService } = await import('../../src/services/realtimeConversation.ts');

const GOAL = { title: 'Budget call', objective: 'Find their budget.', notes: '', preset: 'sales' };

const pcmFrame = (bytes = 1024, sampleRate = 16000) => ({
  pcm: new Uint8Array(bytes),
  sampleRate,
  channels: 1,
  encoding: 'int16',
});

const SERVER_RECAP = {
  id: 'server-recap',
  title: 'Budget call',
  preset: 'sales',
  goal: GOAL,
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: '2026-01-01T00:05:00.000Z',
  durationMs: 300000,
  summary: 'The customer disclosed a two thousand dollar ceiling.',
  keyPoints: ['Two thousand dollars per month is above our budget.'],
  commitments: [],
  missed: [],
  nextActions: [],
  cueCount: 0,
};

const SERVER_CUE = {
  id: 'cue-1',
  observation: 'They never revealed their budget.',
  action: 'Ask for their range.',
  tone: 'signal',
  at: 1200,
};

/** Stand-in for React Native's WebSocket, with the surface the service uses. */
class FakeSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.sent = [];
    this.bufferedAmount = 0;
    this.closed = false;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    FakeSocket.instances.push(this);
  }

  send(raw) {
    this.sent.push(JSON.parse(raw));
  }

  close() {
    this.closed = true;
  }

  // --- test controls ---------------------------------------------------------
  accept() {
    this.onopen?.();
  }

  deliver(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  remoteFail() {
    this.onerror?.();
  }

  remoteClose() {
    this.onclose?.();
  }

  frames(type) {
    return this.sent.filter((message) => message.t === type);
  }
}

beforeEach(() => {
  FakeSocket.instances = [];
  globalThis.WebSocket = FakeSocket;
});

/** Starts a session and completes the connection handshake. */
function startSession() {
  const service = new RealtimeConversationService('test-session');
  const events = [];
  service.subscribe((event) => events.push(event));
  service.start(GOAL);

  const socket = FakeSocket.instances.at(-1);
  socket.accept();

  return { service, socket, events, typesOf: (type) => events.filter((event) => event.type === type) };
}

test('tapping End cuts audio immediately, while the recap is still delayed', async () => {
  const { service, socket, events } = startSession();

  assert.equal(service.getStatus(), 'listening');
  service.pushAudio(pcmFrame());
  assert.equal(socket.frames('audio.frame').length, 1, 'audio flows while listening');

  // End is tapped: the service must stop listening before any await, because
  // that is what stops microphone capture and blocks outgoing frames.
  const stopping = service.stop();

  assert.equal(service.getStatus(), 'ended', 'status must leave listening synchronously');
  assert.ok(
    events.some((event) => event.type === 'STATUS' && event.status === 'ended'),
    'the UI is told immediately'
  );
  assert.equal(socket.frames('session.stop').length, 1, 'the backend is asked to finish');
  assert.equal(socket.closed, false, 'the socket stays open to receive the recap');

  // Frames keep arriving from the native capture callback while the recap is on
  // its way: none of them may be sent.
  service.pushAudio(pcmFrame());
  service.pushAudio(pcmFrame());
  assert.equal(
    socket.frames('audio.frame').length,
    1,
    'no microphone frame may be sent after End, even before the recap arrives'
  );

  // A cue produced for speech from before the stop must not reach the UI.
  socket.deliver({ t: 'psst', cue: SERVER_CUE });
  assert.equal(events.filter((event) => event.type === 'PSST').length, 0, 'stale cue dropped');

  // The last utterance still belongs to the recap, so transcripts are kept.
  socket.deliver({
    t: 'transcript.final',
    entry: { id: 'l1', speaker: 'them', text: 'Above our budget.', isFinal: true, at: 900 },
  });
  assert.equal(events.filter((event) => event.type === 'TRANSCRIPT_FINAL').length, 1);

  // Only now does the recap land, which is the whole reason the socket stayed open.
  socket.deliver({ t: 'recap', recap: SERVER_RECAP });
  const recap = await stopping;

  assert.equal(recap.id, 'server-recap');
  assert.equal(recap.summary, SERVER_RECAP.summary);
  assert.equal(socket.closed, true, 'the socket is released once the recap is in');
});

test('ending without a recap falls back to what actually arrived', async () => {
  const { service, socket } = startSession();

  service.pushAudio(pcmFrame());
  socket.deliver({
    t: 'transcript.final',
    entry: { id: 'l1', speaker: 'them', text: 'Two thousand is above our budget.', isFinal: true, at: 900 },
  });

  const stopping = service.stop();
  // Server never answers: the fallback must not invent a summary.
  socket.remoteClose();
  const recap = await stopping;

  assert.deepEqual(recap.keyPoints, ['Two thousand is above our budget.']);
  assert.match(recap.summary, /did not return a summary/);
});

test('a cue produced before a pause is dropped, and streams again after resume', () => {
  const { service, socket, events } = startSession();

  service.pushAudio(pcmFrame());
  service.pause();
  assert.equal(service.getStatus(), 'paused');

  service.pushAudio(pcmFrame());
  assert.equal(socket.frames('audio.frame').length, 1, 'pausing stops audio');

  socket.deliver({ t: 'psst', cue: SERVER_CUE });
  assert.equal(events.filter((event) => event.type === 'PSST').length, 0);

  service.resume();
  socket.deliver({ t: 'psst', cue: SERVER_CUE });
  assert.equal(events.filter((event) => event.type === 'PSST').length, 1);

  service.pushAudio(pcmFrame());
  assert.equal(socket.frames('audio.frame').length, 2);
});

test('a stalled socket drops live audio and says so once', () => {
  const { service, socket, events } = startSession();

  socket.bufferedAmount = 600 * 1024;
  service.pushAudio(pcmFrame());
  service.pushAudio(pcmFrame());

  assert.equal(socket.frames('audio.frame').length, 0, 'nothing is queued onto a stalled socket');
  const notices = events.filter((event) => event.type === 'NOTICE');
  assert.equal(notices.length, 1, 'the user is told exactly once');
  assert.equal(notices[0].level, 'warning');
  assert.match(notices[0].message, /too slow/);
  assert.equal(service.droppedAudioFrames > 0, true);

  // Recovery: once the socket drains, audio flows again.
  socket.bufferedAmount = 0;
  service.pushAudio(pcmFrame());
  assert.equal(socket.frames('audio.frame').length, 1);
});

test('microphone frames the backend cannot use are never sent', () => {
  const { service, socket } = startSession();

  service.pushAudio({ ...pcmFrame(), channels: 2 });
  service.pushAudio({ ...pcmFrame(), encoding: 'float32' });
  service.pushAudio({ ...pcmFrame(), sampleRate: 0 });
  service.pushAudio({ ...pcmFrame(), pcm: new Uint8Array(0) });

  assert.equal(socket.frames('audio.frame').length, 0);
});

test('a session the backend ended itself is not treated as a connection failure', async () => {
  const { service, socket, events } = startSession();

  // No stop() was called: the backend hit its own limit and sent a recap.
  socket.deliver({ t: 'recap', recap: SERVER_RECAP });
  socket.remoteClose();

  assert.equal(service.getStatus(), 'ended');
  assert.equal(
    events.filter((event) => event.type === 'ERROR').length,
    0,
    'a server-initiated end is not an error'
  );

  const recap = await service.stop();
  assert.equal(recap.id, 'server-recap', 'the recap the backend already sent is reused');
  assert.deepEqual(socket.frames('session.stop'), [], 'no stop is sent on a closed socket');
});

test('an unreachable backend reports an error instead of pretending to listen', () => {
  const service = new RealtimeConversationService('bad-session');
  const events = [];
  service.subscribe((event) => events.push(event));

  // clearTimeout is not needed: the fake socket is opened but never accepted.
  service.start(GOAL);
  const socket = FakeSocket.instances.at(-1);
  socket.remoteFail();

  assert.equal(service.getStatus(), 'error');
  const errors = events.filter((event) => event.type === 'ERROR');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /interrupted/);

  service.dispose();
});

test('dispose releases the socket and stops emitting', () => {
  const { service, socket, events } = startSession();

  service.dispose();
  const before = events.length;
  socket.deliver({ t: 'psst', cue: SERVER_CUE });
  socket.deliver({ t: 'status', status: 'listening' });

  assert.equal(events.length, before, 'no events after dispose');
  assert.equal(socket.closed, true);
  assert.equal(service.getStatus(), 'idle');
});
