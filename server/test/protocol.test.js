/**
 * Protocol-layer regression tests.
 *
 * These cover the frame that used to take the whole backend down:
 *
 *   {"t":"audio.frame","pcm":"AA==","audio":null}
 *
 * `parseClientMessage` runs inside the WebSocket message handler on raw client
 * input, so every case below asserts that parsing returns a value instead of
 * throwing.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { audioFormatForSampleRate, normalizeAudioConfig, validatePcmFrame } from '../src/audio.js';
import { parseClientMessage } from '../src/protocol.js';
import { audioFrame, pcmSilence } from './support/harness.js';

const frame = (overrides) => JSON.stringify(audioFrame(overrides));

test('the frame that used to crash the backend is rejected, not thrown', () => {
  const raw = JSON.stringify({ t: 'audio.frame', pcm: 'AA==', audio: null });
  const parsed = parseClientMessage(raw);

  assert.equal(parsed.t, 'audio.frame.rejected');
  assert.equal(parsed.reason, 'malformed-audio-config');
});

test('audio metadata that is absent, null or the wrong type never throws', () => {
  const cases = [
    { t: 'audio.frame', pcm: 'AAAA' },
    { t: 'audio.frame', pcm: 'AAAA', audio: null },
    { t: 'audio.frame', pcm: 'AAAA', audio: 'pcm_16000' },
    { t: 'audio.frame', pcm: 'AAAA', audio: [] },
    { t: 'audio.frame', pcm: 'AAAA', audio: 16000 },
    { t: 'audio.frame', pcm: 'AAAA', audio: { sampleRate: null, channels: null, encoding: null } },
    { t: 'audio.frame', pcm: 'AAAA', audio: { sampleRate: 'sixteen thousand' } },
    { t: 'audio.frame', pcm: null, audio: { sampleRate: 16000, channels: 1, encoding: 'int16' } },
    { t: 'audio.frame', audio: { sampleRate: 16000, channels: 1, encoding: 'int16' } },
  ];

  for (const payload of cases) {
    const parsed = parseClientMessage(JSON.stringify(payload));
    assert.ok(parsed, `expected a parse result for ${JSON.stringify(payload)}`);
    assert.equal(parsed.t, 'audio.frame.rejected', `unexpected result for ${JSON.stringify(payload)}`);
  }
});

test('unsupported sample rates are rejected with the rate the client reported', () => {
  for (const sampleRate of [1, 12345, 32000, 44000, 96000, 192000]) {
    const parsed = parseClientMessage(frame({ sampleRate }));
    assert.equal(parsed.t, 'audio.frame.rejected', `${sampleRate} Hz should be rejected`);
    assert.equal(parsed.reason, 'unsupported-audio-format');
    assert.equal(parsed.reportedSampleRate, sampleRate);
  }
});

test('supported sample rates survive parsing with their own rate, never a nearby one', () => {
  for (const sampleRate of [8000, 16000, 22050, 24000, 44100, 48000]) {
    const parsed = parseClientMessage(frame({ sampleRate }));
    assert.equal(parsed.t, 'audio.frame');
    assert.equal(parsed.audio.sampleRate, sampleRate);
    assert.equal(parsed.audio.audioFormat, `pcm_${sampleRate}`);
    assert.equal(parsed.byteLength, pcmSilence(100, sampleRate).byteLength);
  }
});

test('stereo and non-int16 frames are rejected rather than silently transcribed', () => {
  const stereo = parseClientMessage(
    JSON.stringify({
      t: 'audio.frame',
      pcm: pcmSilence(100, 16000).toString('base64'),
      audio: { sampleRate: 16000, channels: 2, encoding: 'int16' },
      byteLength: pcmSilence(100, 16000).byteLength,
    })
  );
  assert.equal(stereo.t, 'audio.frame.rejected');

  const float32 = parseClientMessage(
    JSON.stringify({
      t: 'audio.frame',
      pcm: pcmSilence(100, 16000).toString('base64'),
      audio: { sampleRate: 16000, channels: 1, encoding: 'float32' },
      byteLength: pcmSilence(100, 16000).byteLength,
    })
  );
  assert.equal(float32.t, 'audio.frame.rejected');
});

test('declared byteLength is validated against the decoded payload', () => {
  const pcm = pcmSilence(100, 16000);

  const mismatched = parseClientMessage(frame({ pcm, byteLength: pcm.byteLength + 2 }));
  assert.equal(mismatched.t, 'audio.frame.rejected');
  assert.equal(mismatched.reason, 'byte-length-mismatch');

  const omitted = parseClientMessage(
    JSON.stringify({
      t: 'audio.frame',
      pcm: pcm.toString('base64'),
      audio: { sampleRate: 16000, channels: 1, encoding: 'int16' },
    })
  );
  assert.equal(omitted.t, 'audio.frame');
  assert.equal(omitted.byteLength, pcm.byteLength, 'decoded size is authoritative');
});

test('payload shape problems are rejected with a specific reason', () => {
  const sampleRate = 16000;
  const audio = { sampleRate, channels: 1, encoding: 'int16' };

  const cases = [
    [{ t: 'audio.frame', pcm: 'AAAA', audio, byteLength: 3 }, 'unaligned-pcm'],
    [{ t: 'audio.frame', pcm: 'not base64!!', audio, byteLength: 0 }, 'invalid-base64'],
    [{ t: 'audio.frame', pcm: '', audio, byteLength: 0 }, 'missing-pcm'],
    [{ t: 'audio.frame', audio, byteLength: 0 }, 'missing-pcm'],
    [{ t: 'audio.frame', pcm: 'AA==', audio, byteLength: 0 }, 'unaligned-pcm'],
  ];

  for (const [payload, reason] of cases) {
    const parsed = parseClientMessage(JSON.stringify(payload));
    assert.equal(parsed.reason, reason, `expected ${reason} for ${JSON.stringify(payload)}`);
  }

  const oversized = parseClientMessage(
    JSON.stringify({ t: 'audio.frame', pcm: pcmSilence(5000, 48000).toString('base64'), audio })
  );
  assert.equal(oversized.reason, 'frame-too-large');
});

test('validatePcmFrame accepts only well-formed PCM16', () => {
  const pcm = pcmSilence(20, 16000);
  assert.deepEqual(validatePcmFrame(pcm.toString('base64'), pcm.byteLength), {
    ok: true,
    byteLength: pcm.byteLength,
  });
  assert.equal(validatePcmFrame(pcm.toString('base64'), 0).ok, true);
  assert.equal(validatePcmFrame(pcm.toString('base64'), pcm.byteLength + 2).ok, false);
  assert.equal(validatePcmFrame('A', 0).ok, false);
});

test('audioFormatForSampleRate refuses to relabel audio', () => {
  assert.equal(audioFormatForSampleRate(16000), 'pcm_16000');
  assert.equal(audioFormatForSampleRate(32000), null);
  assert.equal(audioFormatForSampleRate(16001), null);
  assert.equal(audioFormatForSampleRate(null), null);
  assert.equal(audioFormatForSampleRate(undefined), null);
  assert.equal(audioFormatForSampleRate(NaN), null);
});

test('normalizeAudioConfig is total: odd inputs return null instead of throwing', () => {
  const oddInputs = [
    null,
    undefined,
    'pcm_16000',
    16000,
    [],
    {},
    { sampleRate: '16000', channels: 1, encoding: 'int16' },
    { sampleRate: Infinity, channels: 1, encoding: 'int16' },
    { sampleRate: NaN, channels: 1, encoding: 'int16' },
    { sampleRate: 16000, channels: 2, encoding: 'int16' },
    { sampleRate: 44100, channels: 1, encoding: 'float32' },
    { sampleRate: 32000, channels: 1, encoding: 'int16' },
  ];

  for (const input of oddInputs) {
    assert.equal(normalizeAudioConfig(input), null, `expected null for ${JSON.stringify(input)}`);
  }

  // A missing or nonsense channel count is treated as the mono feed STT needs.
  assert.equal(normalizeAudioConfig({ sampleRate: 16000, encoding: 'int16' }).channels, 1);
  assert.equal(normalizeAudioConfig({ sampleRate: 16000, channels: 0 }).channels, 1);

  // `pcm16` is accepted as a synonym of `int16`, and the format string is
  // normalised so downstream code only ever sees `int16`.
  const parsed = normalizeAudioConfig({ sampleRate: 48000, channels: 1, encoding: 'pcm16' });
  assert.deepEqual(parsed, {
    sampleRate: 48000,
    channels: 1,
    encoding: 'int16',
    audioFormat: 'pcm_48000',
  });
});

test('control frames and malformed envelopes are parsed defensively', () => {
  assert.deepEqual(parseClientMessage(JSON.stringify({ t: 'session.pause' })), { t: 'session.pause' });
  assert.deepEqual(parseClientMessage(JSON.stringify({ t: 'session.resume' })), { t: 'session.resume' });
  assert.deepEqual(parseClientMessage(JSON.stringify({ t: 'session.stop' })), { t: 'session.stop' });

  assert.equal(parseClientMessage('not json at all'), null);
  assert.equal(parseClientMessage(''), null);
  assert.equal(parseClientMessage('[]'), null);
  assert.equal(parseClientMessage('null'), null);
  assert.equal(parseClientMessage('42'), null);
  assert.equal(parseClientMessage(JSON.stringify({ t: 'unknown.message' })), null);
  assert.equal(parseClientMessage(JSON.stringify({ t: 'session.start' })), null);
  assert.equal(
    parseClientMessage(JSON.stringify({ t: 'session.start', goal: { title: 'x' } })),
    null
  );
});

test('session.start fields are validated and clipped', () => {
  const parsed = parseClientMessage(
    JSON.stringify({
      t: 'session.start',
      goal: {
        title: 't'.repeat(500),
        objective: 'o'.repeat(5000),
        notes: 'n'.repeat(5000),
        preset: 'p'.repeat(500),
      },
      client: { platform: 'android', appVersion: '1.0.0' },
    })
  );

  assert.equal(parsed.goal.title.length, 200);
  assert.equal(parsed.goal.objective.length, 2000);
  assert.equal(parsed.goal.notes.length, 2000);
  assert.equal(parsed.goal.preset.length, 40);

  const noClient = parseClientMessage(
    JSON.stringify({
      t: 'session.start',
      goal: { title: 'a', objective: '', notes: '', preset: 'sales' },
    })
  );
  assert.deepEqual(noClient.client, { platform: 'unknown', appVersion: 'unknown' });
});
