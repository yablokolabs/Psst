/**
 * Shared debrief text tests.
 *
 * This string is what leaves the app: the share sheet, and whatever the user
 * pastes into email, WhatsApp or a CRM note. It has to carry the commitment and
 * its deadline without mangling either.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDemoDebrief } from '../../src/services/demoDebrief.ts';
import { buildDebriefText, describeCommitment, describeDebriefPreview, describeTask } from '../../src/utils/debriefText.ts';

function debrief(overrides = {}) {
  return {
    ...createDemoDebrief({
      title: 'Acme pilot call',
      contact: 'Priya Raman',
      callType: 'sales',
      recordedAt: '2026-09-15T12:00:00.000Z',
      durationMs: 31 * 60 * 1000,
      audio: { uri: 'file:///a.m4a', fileName: 'a.m4a', bytes: 1, mimeType: 'audio/mp4' },
      consentAt: '2026-09-15T12:05:00.000Z',
    }),
    ...overrides,
  };
}

test('a commitment reads as who, what and when', () => {
  assert.equal(
    describeCommitment({ id: '1', owner: 'you', person: '', what: 'Send the deck', when: 'Friday' }),
    'You: Send the deck by Friday'
  );
  assert.equal(
    describeCommitment({ id: '2', owner: 'them', person: 'Priya', what: 'Share the questionnaire', when: '' }),
    'Priya: Share the questionnaire'
  );
  assert.equal(
    describeCommitment({ id: '3', owner: 'unknown', person: '', what: 'Something was agreed', when: '' }),
    'They: Something was agreed'
  );
});

test('a task shows its completion and its date', () => {
  const open = describeTask({ id: '1', title: 'Send the deck', done: false, dueAt: null, calendarEventId: null });
  assert.match(open, /^☐ Send the deck$/);

  const done = describeTask({
    id: '2',
    title: 'Send the deck',
    done: true,
    dueAt: '2026-09-18T09:00:00.000Z',
    calendarEventId: 'evt',
  });
  assert.match(done, /^☑ Send the deck \(due /);
});

test('the shared debrief carries every section that has content', () => {
  const text = buildDebriefText(
    debrief({
      keyDecisions: ['A two-week pilot was agreed.'],
      commitments: [{ id: 'c1', owner: 'you', person: '', what: 'Send the proposal', when: 'Friday' }],
      tasks: [{ id: 't1', title: 'Send the proposal', done: false, dueAt: null, calendarEventId: null }],
      openQuestions: ['Is the budget approved?'],
      risks: [{ id: 'r1', label: 'Budget timing', detail: 'Never confirmed.' }],
      relationship: 'Early and warm.',
      reminders: ['You promised the proposal by Friday.'],
      suggestedMessage: 'Thanks for the call today.',
    })
  );

  assert.match(text, /Psst debrief — Acme pilot call/);
  assert.match(text, /Sales · /);
  assert.match(text, /With: Priya Raman/);
  assert.match(text, /SUMMARY/);
  assert.match(text, /KEY DECISIONS\n• A two-week pilot was agreed\./);
  assert.match(text, /COMMITMENTS\n• You: Send the proposal by Friday/);
  assert.match(text, /FOLLOW-UP\n☐ Send the proposal/);
  assert.match(text, /OPEN QUESTIONS\n• Is the budget approved\?/);
  assert.match(text, /RISKS\n• Budget timing: Never confirmed\./);
  assert.match(text, /TONE AND RELATIONSHIP/);
  assert.match(text, /REMEMBER\n• You promised the proposal by Friday\./);
  assert.match(text, /SUGGESTED FOLLOW-UP\nThanks for the call today\./);
  assert.match(text, /Record anywhere\. Let Psst remember everything\./);

  assert.ok(!text.includes('undefined'));
  assert.ok(!text.includes('null'));
});

test('a demo debrief says so in the shared text', () => {
  assert.match(buildDebriefText(debrief()), /demo analysis/i);
  assert.ok(!/demo analysis/i.test(buildDebriefText(debrief({ origin: 'backend' }))));
});

test('empty sections are omitted rather than printed as headings with nothing under them', () => {
  const text = buildDebriefText(
    debrief({ keyDecisions: [], openQuestions: [], risks: [], reminders: [], people: [], suggestedMessage: '' })
  );
  assert.ok(!text.includes('KEY DECISIONS'));
  assert.ok(!text.includes('OPEN QUESTIONS'));
  assert.ok(!text.includes('SUGGESTED FOLLOW-UP'));
  assert.match(text, /SUMMARY/);
});

test('the timeline preview degrades sensibly', () => {
  assert.equal(describeDebriefPreview(debrief({ summary: 'A short summary.' })), 'A short summary.');
  assert.equal(
    describeDebriefPreview(
      debrief({
        summary: '',
        tasks: [{ id: 't', title: 'Send the deck', done: false, dueAt: null, calendarEventId: null }],
      })
    ),
    'Follow-up: Send the deck'
  );
  assert.match(describeDebriefPreview(debrief({ summary: '', tasks: [] })), /of audio$/);
});
