/**
 * Transcription attachment regression tests — offline.
 *
 * A local fake provider stands in for ElevenLabs (so `audio.frame` really
 * travels through protocol -> session -> STT client), and the reasoning engine is
 * injected, so the scheduling rules can be tested exactly:
 *
 *   - a final arriving while reasoning is busy is coalesced, not lost
 *   - NO_ACTION, duplicate suppression, confidence filtering and the minimum
 *     interval are preserved
 *   - a result that lands after pause/stop/detach never reaches the UI
 *   - the pause boundary invalidates in-flight reasoning, so a cue for pre-pause
 *     speech cannot surface after the user resumes
 *   - the final utterance before a stop is kept and appears in the recap
 */

import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

process.env.ELEVENLABS_API_KEY = 'test-key-never-sent-anywhere-real';
process.env.SARVAM_API_KEY = '';
process.env.PSST_MAX_PROVIDER_QUEUE_BYTES = '8192';
process.env.PSST_MAX_PROVIDER_BUFFERED_BYTES = '65536';

const { parseClientMessage } = await import('../src/protocol.js');
const { ConversationSession } = await import('../src/session.js');
const { attachTranscription } = await import('../src/transcription.js');
const { decide, OUTCOME } = await import('../src/reasoning.js');
const { SarvamReasoningProvider } = await import('../src/sarvam.js');
const { audioFrame, pcmSilence, startFakeProvider, waitFor } = await import('./support/harness.js');

const GOAL = {
  title: 'Budget call',
  objective: 'Understand the budget before offering a discount.',
  notes: '',
  preset: 'sales',
};

let fake = null;

before(async () => {
  fake = await startFakeProvider({ replyToCommit: false });
  process.env.ELEVENLABS_STT_ENDPOINT = fake.endpoint;
});

after(async () => {
  if (fake) await fake.close();
});

/** A controllable reasoning provider: `evaluate` is exactly what tests drive. */
function fakeReasoning(handler) {
  return {
    kind: 'fake',
    calls: [],
    async evaluate(context) {
      this.calls.push(context);
      return handler(context, this.calls.length);
    },
    async summarize() {
      return null;
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Wires a session to the real STT path, opening the provider socket with one frame. */
async function attachReal({ provider, sampleRate = 16000 }) {
  const session = new ConversationSession({ id: `t-${Math.random().toString(36).slice(2)}`, goal: GOAL });
  session.start(GOAL, { platform: 'node', appVersion: 'test' });

  const frames = [];
  const attachment = attachTranscription(session, (message) => frames.push(message), { provider });

  const connectionsBefore = fake.state.connections;
  const chunksBefore = fake.audioChunks().length;

  const parsed = parseClientMessage(JSON.stringify(audioFrame({ sampleRate })));
  assert.equal(parsed.t, 'audio.frame');
  session.pushAudioFrame(parsed);

  // Wait for *this* session's provider socket to be open and its frame flushed,
  // so a later injected transcript cannot be lost to connection setup.
  await waitFor(() => fake.state.connections > connectionsBefore, { description: 'provider connection' });
  await waitFor(() => fake.audioChunks().length > chunksBefore, { description: 'first audio chunk' });

  return { session, attachment, frames, framesOf: (type) => frames.filter((frame) => frame.t === type) };
}

function commit(text) {
  fake.emit({ message_type: 'committed_transcript', text });
}

test('a final arriving while reasoning is busy is coalesced to the latest one', async () => {
  const gate = deferred();
  const provider = fakeReasoning(async (_context, call) => {
    if (call === 1) await gate.promise;
    return { outcome: OUTCOME.NO_ACTION };
  });

  const { attachment, framesOf } = await attachReal({ provider });

  commit('They have not mentioned their budget yet.');
  await waitFor(() => provider.calls.length === 1, { description: 'first evaluation' });

  // These two arrive while the first evaluation is still in flight.
  commit('The budget is two thousand dollars per month.');
  commit('We should ask whether a joining bonus is on the table.');

  // Nothing is evaluated while the gate is closed: work is coalesced, not queued.
  assert.equal(provider.calls.length, 1);

  gate.resolve();
  await waitFor(() => provider.calls.length === 2, { timeoutMs: 8000, description: 'coalesced evaluation' });

  assert.equal(
    provider.calls[1].latest.text,
    'We should ask whether a joining bonus is on the table.',
    'the most recent relevant final must be the one evaluated'
  );
  assert.equal(provider.calls.length, 2, 'intermediate finals are superseded, not replayed');

  attachment.detach();
  assert.deepEqual(framesOf('psst'), [], 'NO_ACTION stays silent');
});

test('short utterances and repeats are never evaluated', async () => {
  const provider = fakeReasoning(async () => ({ outcome: OUTCOME.NO_ACTION }));
  const { attachment, session } = await attachReal({ provider });

  commit('Yes.');                                     // below the word count
  commit('They have not mentioned their budget yet.'); // evaluated
  await waitFor(() => provider.calls.length === 1, { description: 'first evaluation' });

  commit('They have not mentioned their budget yet.'); // exact duplicate from the provider
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.equal(provider.calls.length, 1, 'a repeated final must not be evaluated again');
  assert.equal(
    session.finalEntries.filter((entry) => entry.text === 'They have not mentioned their budget yet.').length,
    1,
    'the duplicate is not stored twice either'
  );
  assert.ok(
    session.finalEntries.some((entry) => entry.text === 'Yes.'),
    'a short utterance is still shown in the transcript, it is just never reasoned about'
  );
  attachment.detach();
});

test('the pause boundary invalidates in-flight reasoning, and resume starts fresh', async () => {
  const gate = deferred();
  const cueAbout = (observation, suggestion) => ({
    observation,
    suggestion,
    confidence: 0.9,
  });
  const provider = fakeReasoning(async (_context, call) => {
    if (call === 1) {
      // Reasoning for the pre-pause utterance is still in flight over the pause.
      await gate.promise;
      return { outcome: OUTCOME.PSST, cue: cueAbout('They never revealed their budget.', 'Ask for their range.') };
    }
    return { outcome: OUTCOME.PSST, cue: cueAbout('They mentioned a joining bonus.', 'Confirm the start date.') };
  });

  const { session, attachment, framesOf } = await attachReal({ provider });

  commit('We really like the product so far.');
  await waitFor(() => provider.calls.length === 1, { description: 'first evaluation' });

  // The pause boundary is explicit: `pause()` advances the epoch, so a result
  // produced for the old epoch is stale even after the user resumes.
  session.pause();
  attachment.pause();
  session.resume();

  gate.resolve();
  await sleep(500);
  assert.deepEqual(
    framesOf('psst'),
    [],
    'a cue for speech from before the pause must never reach the UI, even after resume'
  );

  // New speech after resume is reasoned about fresh and still produces a cue.
  commit('They also mentioned a joining bonus in the first year.');
  await waitFor(() => framesOf('psst').length === 1, { description: 'fresh cue after resume' });
  assert.equal(framesOf('psst')[0].cue.action, 'Confirm the start date.');
  assert.equal(framesOf('psst')[0].cue.observation, 'They mentioned a joining bonus.');

  attachment.detach();
});

test('nothing is reasoned about while paused, and the transcript is still kept', async () => {
  const provider = fakeReasoning(async () => ({ outcome: OUTCOME.NO_ACTION }));
  const { session, attachment, framesOf } = await attachReal({ provider });

  commit('They said the budget is two thousand dollars.');
  await waitFor(() => provider.calls.length === 1, { description: 'first evaluation' });

  session.pause();
  attachment.pause();

  commit('Buying this would make the quarter for us.');
  await sleep(400);

  assert.equal(provider.calls.length, 1, 'a paused session must not start reasoning');
  assert.ok(
    framesOf('transcript.final').some((frame) => frame.entry.text.includes('make the quarter')),
    'the transcript is still shown while paused'
  );
  assert.equal(
    session.finalEntries.filter((entry) => entry.text.includes('make the quarter')).length,
    1,
    'and is kept for the recap'
  );

  attachment.detach();
});

test('stale cue rejection: a result landing after a pause never reaches the UI', async () => {
  const gate = deferred();
  const provider = fakeReasoning(async () => {
    await gate.promise;
    return {
      outcome: OUTCOME.PSST,
      cue: { observation: 'They never revealed their budget.', suggestion: 'Ask for their range.', confidence: 0.9 },
    };
  });

  const { session, attachment, framesOf } = await attachReal({ provider });

  commit('We really like the product.');
  await waitFor(() => provider.calls.length === 1, { description: 'first evaluation' });

  session.pause();
  gate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 400));

  assert.deepEqual(framesOf('psst'), [], 'a cue produced during a pause must be dropped');
  attachment.detach();
});

test('stale cue rejection: a result landing after detach never reaches the UI', async () => {
  const gate = deferred();
  const provider = fakeReasoning(async () => {
    await gate.promise;
    return {
      outcome: OUTCOME.PSST,
      cue: { observation: 'They never revealed their budget.', suggestion: 'Ask for their range.', confidence: 0.9 },
    };
  });

  const { attachment, framesOf } = await attachReal({ provider });

  commit('We really like the product.');
  await waitFor(() => provider.calls.length === 1, { description: 'first evaluation' });

  attachment.detach();
  gate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 400));

  assert.deepEqual(framesOf('psst'), []);
});

test('the final utterance before a stop is preserved and reaches the recap', async () => {
  const provider = fakeReasoning(async () => ({ outcome: OUTCOME.NO_ACTION }));
  fake.options.replyToCommit = true;
  fake.options.commitText = 'Let us send the revised numbers tomorrow morning.';

  try {
    const { session, attachment, framesOf } = await attachReal({ provider });

    // The provider commits the last thing it heard when we flush, which is
    // exactly what a stop must capture instead of discarding.
    const committed = await attachment.finalize();

    assert.equal(committed, true, 'finalize resolves once the provider commits');
    assert.ok(
      framesOf('transcript.final').some((frame) =>
        frame.entry.text.includes('Let us send the revised numbers')
      ),
      'the final utterance must be handed to the UI before the session closes'
    );
    assert.deepEqual(
      framesOf('psst'),
      [],
      'the last utterance is recorded, not reasoned about: the user already ended the session'
    );
    assert.equal(session.audioSink, null, 'no audio path survives the stop');
    assert.equal(session.finalEntries.length, 1);
  } finally {
    fake.options.replyToCommit = false;
    delete fake.options.commitText;
  }
});

test('finalize uses the provider flush instead of a blind delay', async () => {
  const provider = fakeReasoning(async () => ({ outcome: OUTCOME.NO_ACTION }));
  const { attachment } = await attachReal({ provider });

  const committed = await attachment.finalize();
  assert.equal(committed, false, 'nothing to commit: no audio was spoken');

  const flush = fake.flushChunks().at(-1);
  assert.equal(flush.commit, true, 'the documented empty commit chunk is the flush');
  assert.equal(flush.audio_base_64, '', 'no synthesised audio is invented to force a commit');
  assert.equal(flush.sample_rate, 16000);
});

test('finalize on a session whose provider never opened is still bounded', async () => {
  const provider = fakeReasoning(async () => ({ outcome: OUTCOME.NO_ACTION }));
  const session = new ConversationSession({ id: 'never-opened', goal: GOAL });
  session.start(GOAL, { platform: 'node', appVersion: 'test' });

  const hung = await startFakeProvider({ announceSession: false });
  process.env.ELEVENLABS_STT_ENDPOINT = hung.endpoint;
  const attachment = attachTranscription(session, () => {}, { provider });

  const parsed = parseClientMessage(JSON.stringify(audioFrame({ sampleRate: 16000 })));
  session.pushAudioFrame(parsed);

  const startedAt = Date.now();
  const committed = await attachment.finalize();
  assert.equal(committed, false);
  assert.ok(Date.now() - startedAt < 100, 'no wait when there is nothing to flush');

  await hung.close();
  process.env.ELEVENLABS_STT_ENDPOINT = fake.endpoint;
});

test('sudden provider congestion is explained once, not silently hidden', async () => {
  const provider = fakeReasoning(async () => ({ outcome: OUTCOME.NO_ACTION }));
  const slow = await startFakeProvider({ announceSession: false });
  process.env.ELEVENLABS_STT_ENDPOINT = slow.endpoint;

  const session = new ConversationSession({ id: 'congested', goal: GOAL });
  session.start(GOAL, { platform: 'node', appVersion: 'test' });
  const frames = [];
  const attachment = attachTranscription(session, (message) => frames.push(message), { provider });

  // Far more audio than the queue ceiling allows while the provider is silent.
  for (let index = 0; index < 12; index += 1) {
    session.pushAudioFrame(
      parseClientMessage(JSON.stringify(audioFrame({ pcm: pcmSilence(50, 16000), seq: index })))
    );
  }

  const warnings = frames.filter((frame) => frame.t === 'notice' && frame.level === 'warning');
  assert.equal(warnings.length, 1, 'congestion is explained exactly once');
  assert.match(warnings[0].message, /dropping some audio/);

  attachment.detach();
  await slow.close();
  process.env.ELEVENLABS_STT_ENDPOINT = fake.endpoint;
});

test('decide() keeps NO_ACTION, duplicate suppression, confidence and the minimum interval', async () => {
  const context = {
    goal: GOAL,
    transcript: [{ id: 'l1', speaker: 'them', text: 'We like it.', isFinal: true, at: 0 }],
    latest: { id: 'l1', speaker: 'them', text: 'We like it.', isFinal: true, at: 0 },
    recentCues: [],
    lastCueAt: null,
  };

  const silent = fakeReasoning(async () => ({ outcome: OUTCOME.NO_ACTION }));
  assert.equal((await decide(context, { provider: silent })).outcome, OUTCOME.NO_ACTION);

  const cue = { observation: 'They never revealed their budget.', suggestion: 'Ask for their range.', confidence: 0.9 };
  const strong = fakeReasoning(async () => ({ outcome: OUTCOME.PSST, cue }));

  const first = await decide(context, { provider: strong });
  assert.equal(first.outcome, OUTCOME.PSST);
  assert.deepEqual(first.cue, cue);

  const duplicate = await decide(
    { ...context, recentCues: [{ observation: cue.observation, action: cue.suggestion }], lastCueAt: 1 },
    { provider: strong, now: Date.now() + 60000 }
  );
  assert.equal(duplicate.outcome, OUTCOME.NO_ACTION);
  assert.equal(duplicate.suppressed, 'duplicate');

  const tooSoon = await decide(
    { ...context, recentCues: [], lastCueAt: Date.now() },
    { provider: strong }
  );
  assert.equal(tooSoon.outcome, OUTCOME.NO_ACTION);
  assert.equal(tooSoon.suppressed, 'too-soon');

  const noProvider = await decide(context, { provider: null });
  assert.equal(noProvider.outcome, OUTCOME.NO_ACTION);
  assert.equal(noProvider.skipped, 'no-provider');
});

test('manual commit mode commits at the boundaries the server knows about', async () => {
  const provider = fakeReasoning(async () => ({ outcome: OUTCOME.NO_ACTION }));
  process.env.ELEVENLABS_STT_COMMIT_STRATEGY = 'manual';

  try {
    const { attachment } = await attachReal({ provider });
    const before = fake.flushChunks().length;

    // A pause is a boundary the server can honestly commit on: without it, a
    // manual-commit session would never commit anything.
    attachment.commit();
    await waitFor(() => fake.flushChunks().length > before, { description: 'manual commit' });

    const flush = fake.flushChunks().at(-1);
    assert.equal(flush.commit, true);
    assert.equal(flush.audio_base_64, '');
    attachment.detach();
  } finally {
    delete process.env.ELEVENLABS_STT_COMMIT_STRATEGY;
  }
});

test('the default VAD strategy never sends a boundary commit', async () => {
  const provider = fakeReasoning(async () => ({ outcome: OUTCOME.NO_ACTION }));
  const { attachment } = await attachReal({ provider });

  const before = fake.flushChunks().length;
  attachment.commit();
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(fake.flushChunks().length, before, 'VAD commits on its own');
  attachment.detach();
});

test('confidence filtering and cue clamping still apply to a real provider answer', () => {
  // Pure validation, no network: this is the same code path a live decision
  // takes once the model has answered.
  const provider = new SarvamReasoningProvider({ apiKey: 'not-used-by-this-test' });

  assert.equal(
    provider.normalizeDecision({
      action: OUTCOME.PSST,
      observation: 'Something might be up.',
      suggestion: 'Ask a question.',
      confidence: 0.2,
    }).outcome,
    OUTCOME.NO_ACTION
  );

  assert.equal(
    provider.normalizeDecision({
      action: OUTCOME.NO_ACTION,
      observation: '',
      suggestion: '',
      confidence: 0,
    }).outcome,
    OUTCOME.NO_ACTION
  );

  const incomplete = provider.normalizeDecision({
    action: OUTCOME.PSST,
    observation: '',
    suggestion: 'Ask for their range.',
    confidence: 0.9,
  });
  assert.equal(incomplete.outcome, OUTCOME.NO_ACTION);
  assert.equal(incomplete.error, 'incomplete-cue');

  const strong = provider.normalizeDecision({
    action: OUTCOME.PSST,
    observation: 'They never revealed their budget.',
    suggestion: 'Ask for their range.',
    confidence: 0.9,
  });
  assert.equal(strong.outcome, OUTCOME.PSST);
  assert.equal(strong.cue.observation, 'They never revealed their budget.');
});
