/**
 * Unit tests for the import pipeline's internals.
 *
 * Everything here is offline: the provider is either a stub object or an
 * injected `fetchImpl`, so no request leaves the machine and no key is used. The
 * environment is set before the modules are imported because they read the keys
 * at call time, which is exactly the behaviour these tests depend on.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

process.env.ELEVENLABS_API_KEY = 'test-key-never-sent-anywhere-real';
process.env.SARVAM_API_KEY = '';

const { normalizeDebrief, buildDebrief, formatTranscriptForPrompt, emptyDebrief } = await import(
  '../src/debrief.js'
);
const { transcribeRecording } = await import('../src/stt.js');

const DRAFT = {
  title: 'Acme pilot call',
  contact: 'Priya Raman',
  callType: 'sales',
  durationMs: 12 * 60 * 1000,
};

test('normalizeDebrief keeps what is valid and drops what is not', () => {
  const debrief = normalizeDebrief({
    summary: '  A   call with   pricing on the table. ',
    keyDecisions: ['Pilot agreed', '', 42, '  ', 'Pricing deferred'],
    commitments: [
      { owner: 'nonsense', person: 'Priya', what: 'Send the deck', when: 'Friday' },
      { owner: 'you', what: '   ' },
      'a bare string is off-schema and must not invent an owner',
    ],
    tasks: ['Send the proposal', 5, ''],
    people: [{ name: 'Priya', context: 'budget' }, { name: '' }, 'not an object'],
    risks: [{ detail: 'Budget was never confirmed' }],
    tone: { label: 'Warm' },
    reminders: ['You promised the deck by Friday'],
  });

  assert.equal(debrief.summary, 'A call with pricing on the table.');
  assert.deepEqual(debrief.keyDecisions, ['Pilot agreed', 'Pricing deferred']);
  assert.equal(debrief.commitments.length, 1, 'a commitment with no "what" is dropped');
  assert.equal(debrief.commitments[0].owner, 'unknown', 'an unknown owner is not guessed');
  assert.equal(debrief.commitments[0].what, 'Send the deck');
  assert.deepEqual(debrief.tasks, ['Send the proposal']);
  assert.equal(debrief.people.length, 1);
  assert.equal(debrief.people[0].context, 'budget');
  assert.equal(debrief.risks[0].label, 'Budget was never confirmed', 'label falls back to detail');
  assert.equal(debrief.tone.label, 'Warm');
  assert.equal(debrief.tone.note, '');
  assert.deepEqual(debrief.reminders, ['You promised the deck by Friday']);
});

test('normalizeDebrief answers with empty sections for junk input', () => {
  for (const input of [null, undefined, 42, 'text', []]) {
    const debrief = normalizeDebrief(input);
    assert.deepEqual(debrief, emptyDebrief(), `junk input ${JSON.stringify(input)} must be empty`);
  }
});

test('normalizeDebrief caps how much one answer can add', () => {
  const many = Array.from({ length: 40 }, (_, index) => `Decision ${index}`);
  const debrief = normalizeDebrief({ summary: 'ok', keyDecisions: many });
  assert.equal(debrief.keyDecisions.length, 20);
});

test('formatTranscriptForPrompt labels lines and keeps the most recent ones', () => {
  assert.equal(formatTranscriptForPrompt([]), '(no speech was detected)');

  const labelled = formatTranscriptForPrompt([
    { label: 'Speaker 1', text: '  Two thousand   a month. ' },
    { label: '', text: 'No label here' },
  ]);
  assert.match(labelled, /^Speaker 1: Two thousand a month\./);
  assert.match(labelled, /No label here/);

  const long = Array.from({ length: 60 }, (_, index) => ({
    label: `Speaker ${index % 2 === 0 ? 1 : 2}`,
    text: `Line number ${index} ${'x'.repeat(80)}`,
  }));
  const clipped = formatTranscriptForPrompt(long, 500);
  assert.match(clipped, /^\(\d+ earlier line\(s\) omitted\)/);
  assert.match(clipped, /Line number 59/, 'the end of a call is the part worth keeping');
  assert.ok(!clipped.includes('Line number 0 '), 'the beginning is dropped first');
});

test('buildDebrief reports a degraded result instead of inventing content', async () => {
  const provider = {
    async complete() {
      return { data: { summary: 'Real summary', keyDecisions: ['One'], tone: { label: 'Warm', note: 'Easy' } } };
    },
  };

  const result = await buildDebrief({ draft: DRAFT, transcript: [{ label: 'Speaker 1', text: 'Hello' }], provider });
  assert.equal(result.degraded, false);
  assert.equal(result.notice, null);
  assert.equal(result.debrief.summary, 'Real summary');
  assert.deepEqual(result.debrief.tasks, [], 'an absent section stays absent');

  const failed = await buildDebrief({
    draft: DRAFT,
    transcript: [],
    provider: { async complete() { return { error: 'provider exploded' }; } },
  });
  assert.equal(failed.degraded, true);
  assert.ok(failed.notice, 'the user must be told the summary is missing');
  assert.equal(failed.debrief.summary, '');

  const unconfigured = await buildDebrief({ draft: DRAFT, transcript: [], provider: null });
  assert.equal(unconfigured.degraded, true);
  assert.match(unconfigured.notice, /analysis model/i);
});

test('buildDebrief treats an empty summary as a degraded result', async () => {
  const result = await buildDebrief({
    draft: DRAFT,
    transcript: [],
    provider: { async complete() { return { data: { summary: '   ' } }; } },
  });
  assert.equal(result.degraded, true);
  assert.ok(result.notice);
});

/** A fetch stub answering one canned ElevenLabs response. */
function fakeFetch(response) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return response;
  };
  impl.calls = calls;
  return impl;
}

test('transcribeRecording groups provider words into labelled lines', async () => {
  const payload = {
    language_code: 'eng',
    text: 'Two thousand dollars is above our budget I will send the deck on Friday',
    words: [
      { text: 'Two', type: 'word', start: 0, end: 0.2, speaker_id: 'speaker_0' },
      { text: 'thousand', type: 'word', start: 0.3, end: 0.5, speaker_id: 'speaker_0' },
      { text: 'dollars', type: 'word', start: 0.6, end: 0.8, speaker_id: 'speaker_0' },
      // A long pause and a new voice: this must start a new line.
      { text: 'I', type: 'word', start: 4, end: 4.1, speaker_id: 'speaker_1' },
      { text: 'will', type: 'word', start: 4.2, end: 4.3, speaker_id: 'speaker_1' },
      // Non-word events are ignored rather than becoming transcript text.
      { text: '(laughter)', type: 'audio_event', start: 4.4, end: 4.5, speaker_id: 'speaker_1' },
      { text: 'Friday', type: 'word', start: 4.6, end: 4.9, speaker_id: 'speaker_1' },
    ],
  };

  const fetchImpl = fakeFetch({ ok: true, json: async () => payload });
  const result = await transcribeRecording({
    bytes: Buffer.from('audio-bytes'),
    fileName: 'call.m4a',
    mimeType: 'audio/mp4',
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(result.languageCode, 'eng');
  assert.ok(result.durationMs > 4000);
  assert.equal(result.lines.length, 2);
  assert.equal(result.lines[0].label, 'Speaker 1');
  assert.equal(result.lines[0].text, 'Two thousand dollars');
  assert.equal(result.lines[1].label, 'Speaker 2');
  assert.equal(result.lines[1].text, 'I will Friday');
  assert.equal(result.lines[0].speaker, 'unknown', 'a recording cannot resolve who is the user');
  assert.ok(!result.lines.some((line) => line.text.includes('laughter')));

  // The key belongs in the header, and the model in the form body.
  const [call] = fetchImpl.calls;
  assert.equal(call.init.headers['xi-api-key'], 'test-key-never-sent-anywhere-real');
  assert.equal(call.init.method, 'POST');
  assert.match(String(call.init.headers['content-type']), /^multipart\/form-data; boundary=/);
  assert.ok(String(call.init.body).includes('audio-bytes'));
});

test('transcribeRecording reports provider failures instead of throwing', async () => {
  const failed = await transcribeRecording({
    bytes: Buffer.from('x'),
    fileName: 'call.m4a',
    mimeType: 'audio/mp4',
    fetchImpl: fakeFetch({ ok: false, status: 401, text: async () => 'invalid api key' }),
  });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /HTTP 401/);

  const silent = await transcribeRecording({
    bytes: Buffer.from('x'),
    fileName: 'call.m4a',
    mimeType: 'audio/mp4',
    fetchImpl: fakeFetch({ ok: true, json: async () => ({ text: '', words: [] }) }),
  });
  assert.equal(silent.ok, false);
  assert.match(silent.error, /no speech/);

  const threw = await transcribeRecording({
    bytes: Buffer.from('x'),
    fileName: 'call.m4a',
    mimeType: 'audio/mp4',
    fetchImpl: async () => {
      throw new Error('socket hang up');
    },
  });
  assert.equal(threw.ok, false);
  assert.match(threw.error, /socket hang up/);
});

test('transcribeRecording refuses to run without a key', async () => {
  const previous = process.env.ELEVENLABS_API_KEY;
  process.env.ELEVENLABS_API_KEY = '';
  try {
    const result = await transcribeRecording({
      bytes: Buffer.from('x'),
      fileName: 'call.m4a',
      mimeType: 'audio/mp4',
      fetchImpl: fakeFetch({ ok: true, json: async () => ({}) }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'batch-stt-not-configured');
  } finally {
    process.env.ELEVENLABS_API_KEY = previous;
  }
});
