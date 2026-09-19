/**
 * Backend payload parser tests.
 *
 * The parser's job is to trust nothing. A missing field is a missing section on
 * screen; a malformed one must never crash the debrief the user just waited for.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDebriefPayload } from '../../src/services/debriefPayload.ts';

const draft = {
  title: 'Acme pilot call',
  contact: 'Priya Raman',
  callType: 'sales',
  recordedAt: '2026-09-15T12:00:00.000Z',
  durationMs: 60000,
  audio: { uri: 'file:///recordings/call.m4a', fileName: 'call.m4a', bytes: 2048, mimeType: 'audio/mp4' },
  consentAt: '2026-09-15T12:05:00.000Z',
};

test('a full payload becomes a debrief with the draft facts intact', () => {
  const debrief = parseDebriefPayload(
    {
      origin: 'backend',
      degraded: false,
      transcript: {
        durationMs: 61000,
        languageCode: 'eng',
        lines: [
          { speaker: 'them', label: 'Speaker 1', text: 'Two thousand a month.', at: 0 },
          { speaker: 'unknown', label: 'Speaker 2', text: 'That is above budget.', at: 3000 },
        ],
      },
      debrief: {
        summary: 'A pilot call where pricing came up.',
        keyDecisions: ['Pilot agreed'],
        commitments: [{ owner: 'you', person: '', what: 'Send the proposal', when: 'Friday' }],
        tasks: ['Send the proposal'],
        suggestedMessage: 'Thanks for the call.',
        people: [{ name: 'Priya', context: 'Owns the budget' }],
        openQuestions: ['Is it approved?'],
        risks: [{ label: 'Budget', detail: 'Never confirmed.' }],
        tone: { label: 'Positive', note: 'Cautious on money.' },
        relationship: 'Early and warm.',
        reminders: ['You promised the proposal by Friday.'],
      },
    },
    draft
  );

  assert.equal(debrief.title, draft.title);
  assert.equal(debrief.contact, draft.contact);
  assert.equal(debrief.recordedAt, draft.recordedAt);
  assert.equal(debrief.consentAt, draft.consentAt);
  assert.deepEqual(debrief.audio, draft.audio);
  assert.equal(debrief.origin, 'backend');
  assert.equal(debrief.degraded, false);
  assert.equal(debrief.summary, 'A pilot call where pricing came up.');
  assert.equal(debrief.commitments[0].what, 'Send the proposal');
  assert.equal(debrief.tasks[0].done, false, 'tasks always arrive unstarted');
  assert.equal(debrief.tasks[0].calendarEventId, null);
  assert.equal(debrief.people[0].context, 'Owns the budget');
  assert.equal(debrief.transcript.length, 2);
  assert.equal(debrief.transcript[0].label, 'Speaker 1');
  assert.equal(debrief.transcript[1].speaker, 'unknown');
  // The provider measured the real length, so it wins over the client's guess.
  assert.equal(debrief.durationMs, 61000);
});

test('junk sections are dropped without losing the rest', () => {
  const debrief = parseDebriefPayload(
    {
      transcript: {
        lines: [
          null,
          'not an object',
          { text: '' },
          { text: 'Kept', speaker: 'nonsense', at: -5 },
          { text: 'Also kept', at: Number.NaN },
        ],
      },
      debrief: {
        summary: 42,
        keyDecisions: ['kept', '', null, 'also kept'],
        commitments: ['a bare string commitment', { what: 'Kept commitment' }, { what: '  ' }],
        tasks: ['Kept task', 7],
        people: ['Bare name', { name: 'Named', context: 'role' }],
        risks: ['Bare risk', { label: '', detail: 'detail only' }],
        tone: 'not an object',
        reminders: ['Kept reminder'],
      },
    },
    draft
  );

  assert.equal(debrief.summary, '', 'a non-string summary is not coerced from nowhere');
  assert.equal(debrief.degraded, true, 'no summary means the result is degraded');
  assert.deepEqual(debrief.keyDecisions, ['kept', 'also kept']);
  assert.equal(debrief.commitments.length, 2);
  assert.equal(debrief.commitments[0].owner, 'unknown');
  assert.deepEqual(debrief.tasks.map((task) => task.title), ['Kept task']);
  assert.deepEqual(debrief.people.map((person) => person.name), ['Bare name', 'Named']);
  assert.equal(debrief.risks.length, 2);
  assert.equal(debrief.risks[1].label, 'detail only');
  assert.deepEqual(debrief.tone, { label: '', note: '' });
  assert.deepEqual(debrief.reminders, ['Kept reminder']);
  assert.equal(debrief.transcript.length, 2);
  assert.equal(debrief.transcript[0].at, 0, 'negative timestamps are clamped, not kept');
  assert.equal(debrief.transcript[1].at, 0);
});

test('a completely absent payload still produces a usable, honest debrief', () => {
  const debrief = parseDebriefPayload({}, draft);
  assert.equal(debrief.degraded, true);
  assert.equal(debrief.transcript, null);
  assert.deepEqual(debrief.commitments, []);
  assert.deepEqual(debrief.risks, []);
  assert.equal(debrief.origin, 'backend');
});

test('an unknown origin is treated as a backend result, not a demo', () => {
  const debrief = parseDebriefPayload({ origin: 'something-else', debrief: { summary: 'x' } }, draft);
  assert.equal(debrief.origin, 'backend');
  assert.equal(debrief.degraded, false);
});
