/**
 * Timeline store tests.
 *
 * The row mapping is the boundary between SQLite and the app: one corrupted row
 * must not make the timeline unopenable, and a search term must never behave as
 * a wildcard just because it contained a `%`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDemoDebrief } from '../../src/services/demoDebrief.ts';
import {
  buildSearchParams,
  escapeLike,
  fromDebriefRow,
  matchesSearch,
  sortByRecordedAt,
  toDebriefRow,
} from '../../src/services/debriefRows.ts';

function demoDebrief(overrides = {}) {
  const debrief = createDemoDebrief({
    title: 'Acme pilot call',
    contact: 'Priya Raman',
    callType: 'sales',
    recordedAt: '2026-09-15T12:00:00.000Z',
    durationMs: 31 * 60 * 1000,
    audio: { uri: 'file:///recordings/acme.m4a', fileName: 'acme.m4a', bytes: 4096, mimeType: 'audio/mp4' },
    consentAt: '2026-09-15T12:05:00.000Z',
  });
  return { ...debrief, ...overrides };
}

test('a debrief survives the round trip through its row', () => {
  const debrief = demoDebrief();
  const row = toDebriefRow(debrief);
  const restored = fromDebriefRow(row);

  assert.ok(restored);
  assert.deepEqual(restored, debrief);
  assert.equal(row.call_type, 'sales');
  assert.equal(row.origin, 'demo');
  // The indexed columns are what the timeline sorts and searches on.
  assert.equal(row.recorded_at, debrief.recordedAt);
  assert.equal(row.summary, debrief.summary);
});

test('a row that cannot be read is skipped rather than thrown', () => {
  assert.equal(fromDebriefRow(null), null);
  assert.equal(fromDebriefRow(undefined), null);
  assert.equal(fromDebriefRow({ payload: '{not json' }), null);
  assert.equal(fromDebriefRow({ payload: '"a string"' }), null);
  assert.equal(fromDebriefRow({ payload: JSON.stringify({ title: 'no id' }) }), null);
});

test('a row with missing optional fields still opens', () => {
  const restored = fromDebriefRow({
    id: 'x',
    recorded_at: '2026-09-15T12:00:00.000Z',
    imported_at: '2026-09-15T12:05:00.000Z',
    title: 'Partial',
    contact: '',
    call_type: 'not-a-call-type',
    summary: '',
    origin: 'something-else',
    payload: JSON.stringify({ id: 'x', title: 'Partial' }),
  });

  assert.ok(restored);
  assert.equal(restored.callType, 'other', 'an unknown call type falls back');
  assert.equal(restored.origin, 'backend', 'an unknown origin is not treated as a demo');
  assert.deepEqual(restored.tasks, []);
  assert.deepEqual(restored.reminders, []);
  assert.equal(restored.audio, null);
  assert.equal(restored.degraded, false);
});

test('search terms are escaped so a wildcard stays a character', () => {
  assert.equal(escapeLike('50%'), '50\\%');
  assert.equal(escapeLike('a_b'), 'a\\_b');
  assert.equal(escapeLike('back\\slash'), 'back\\\\slash');

  const params = buildSearchParams(' 50% ');
  assert.equal(params.length, 4);
  for (const param of params) assert.equal(param, '%50\\%%');
});

test('search finds matches anywhere the user would expect them', () => {
  const debrief = demoDebrief();

  assert.equal(matchesSearch(debrief, ''), true);
  assert.equal(matchesSearch(debrief, 'acme'), true, 'title');
  assert.equal(matchesSearch(debrief, 'priya'), true, 'contact');
  assert.equal(matchesSearch(debrief, 'pilot'), true, 'summary');
  // Deep fields matter most in a memory product.
  assert.equal(matchesSearch(debrief, 'friday'), true, 'a commitment deadline');
  assert.equal(matchesSearch(debrief, debrief.people[0].name), true, 'a person mentioned');
  assert.equal(matchesSearch(debrief, 'not-in-this-debrief-at-all'), false);
});

test('the timeline is ordered newest call first', () => {
  const older = demoDebrief({ id: 'old', recordedAt: '2026-09-01T09:00:00.000Z' });
  const newer = demoDebrief({ id: 'new', recordedAt: '2026-09-18T09:00:00.000Z' });

  assert.deepEqual(sortByRecordedAt([older, newer]).map((item) => item.id), ['new', 'old']);
});
