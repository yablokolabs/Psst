/**
 * Demo debrief tests.
 *
 * The offline path exists so the app is fully reviewable with no credentials.
 * That makes honesty a testable property: every demo debrief must be marked demo
 * and apply to no real audio, and it must never fabricate a transcript of a
 * recording it never read.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { CALL_TYPES } from '../../src/constants/callTypes.ts';
import { createDemoDebrief, createSeedDebriefs, describeDemoReason } from '../../src/services/demoDebrief.ts';

const draft = {
  title: 'Acme pilot call',
  contact: 'Priya Raman',
  callType: 'sales',
  recordedAt: '2026-09-15T12:00:00.000Z',
  durationMs: 31 * 60 * 1000,
  audio: { uri: 'file:///recordings/acme.m4a', fileName: 'acme.m4a', bytes: 4096, mimeType: 'audio/mp4' },
  consentAt: '2026-09-15T12:05:00.000Z',
};

test('every call type produces a complete, clearly-labelled demo debrief', () => {
  for (const callType of CALL_TYPES) {
    const debrief = createDemoDebrief({ ...draft, callType: callType.id });

    assert.equal(debrief.origin, 'demo', `${callType.id} must be marked as a demo`);
    assert.equal(debrief.degraded, true, `${callType.id} must not claim full analysis`);
    assert.equal(debrief.transcript, null, 'a demo never invents a transcript');
    assert.ok(debrief.summary.trim().length > 40, `${callType.id} needs a real summary`);
    assert.ok(debrief.tasks.length > 0, `${callType.id} needs at least one follow-up`);
    assert.ok(debrief.commitments.length > 0, `${callType.id} needs a commitment`);
    assert.ok(debrief.suggestedMessage.trim() !== '', `${callType.id} needs a follow-up message`);
    assert.ok(debrief.reminders.length > 0, `${callType.id} needs a reminder`);
    assert.equal(debrief.title, draft.title);
    assert.equal(debrief.recordedAt, draft.recordedAt);
    assert.equal(debrief.consentAt, draft.consentAt);
    assert.equal(debrief.durationMs, draft.durationMs);
  }
});

test('demo ids are unique and tasks start unstarted', () => {
  const first = createDemoDebrief(draft);
  const second = createDemoDebrief(draft);

  assert.notEqual(first.id, second.id);
  assert.notEqual(first.tasks[0].id, second.tasks[0].id);
  for (const task of first.tasks) {
    assert.equal(task.done, false);
    assert.equal(task.dueAt, null);
    assert.equal(task.calendarEventId, null);
  }
});

test('an unnamed contact still reads naturally', () => {
  const debrief = createDemoDebrief({ ...draft, contact: '   ' });
  assert.match(debrief.summary, /the prospect/);
  assert.ok(!debrief.summary.includes('  '));
  assert.ok(!/undefined/.test(JSON.stringify(debrief)));
});

test('the reason a demo was used is explained in plain words', () => {
  assert.match(describeDemoReason('unconfigured'), /no analysis backend is configured/i);
  assert.match(describeDemoReason('unconfigured'), /not uploaded anywhere/i);
  assert.match(describeDemoReason('failed'), /could not be reached/i);
});

test('the first-run examples are examples: no audio, newest first', () => {
  const seeds = createSeedDebriefs(new Date('2026-09-19T12:00:00Z'));

  assert.equal(seeds.length, 3);
  for (const seed of seeds) {
    assert.equal(seed.audio, null, 'an example has no recording to keep or delete');
    assert.equal(seed.origin, 'demo');
    assert.match(seed.title, /^Example: /);
    assert.ok(seed.summary.trim() !== '');
  }

  const times = seeds.map((seed) => new Date(seed.recordedAt).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
  assert.equal(new Set(seeds.map((seed) => seed.id)).size, seeds.length);
});
