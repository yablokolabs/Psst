/**
 * Import metadata tests.
 *
 * These cover the two things a wrong guess would cost the user: importing a file
 * Psst cannot read, and dating a debrief to a day the call did not happen on.
 * Every guess must be a guess — prefill only, never a silent correction.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeDurationProblem,
  describeImportProblem,
  extensionOf,
  formatBytes,
  formatDuration,
  fromDateInputValue,
  inferRecordedAt,
  inferTitleAndContact,
  isSupportedAudioFile,
  mimeTypeForExtension,
  toDateInputValue,
} from '../../src/utils/importMetadata.ts';

test('only the documented audio formats are importable', () => {
  assert.equal(extensionOf('Call with Sarah.M4A'), 'm4a');
  assert.equal(extensionOf('no-extension'), '');
  assert.equal(extensionOf(''), '');

  for (const name of ['call.m4a', 'call.mp3', 'CALL.WAV', 'voice.aac']) {
    assert.equal(isSupportedAudioFile(name), true, `${name} must be importable`);
  }
  for (const name of ['notes.txt', 'video.mp4', 'recording', 'call.m4a.exe']) {
    assert.equal(isSupportedAudioFile(name), false, `${name} must be refused`);
  }
});

test('an unsupported or oversized file is refused with a reason the user can act on', () => {
  assert.equal(describeImportProblem({ name: 'call.m4a', size: 1024 }), null);

  const unsupported = describeImportProblem({ name: 'call.mp4', size: 1024 });
  assert.match(unsupported, /M4A, MP3, WAV, AAC/);

  const huge = describeImportProblem({ name: 'call.m4a', size: 500 * 1024 * 1024 });
  assert.match(huge, /analyses up to/i);

  const empty = describeImportProblem({ name: 'call.m4a', size: 0 });
  assert.match(empty, /empty/i);

  const nameless = describeImportProblem({ name: '   ' });
  assert.ok(nameless);

  // A picker that reports no size must not block the import.
  assert.equal(describeImportProblem({ name: 'call.m4a' }), null);
});

test('duration limits are checked only when a duration is known', () => {
  assert.equal(describeDurationProblem(30 * 60 * 1000), null);
  assert.match(describeDurationProblem(0), /could not read the length/i);
  assert.match(describeDurationProblem(9 * 60 * 60 * 1000), /analyses up to/i);
});

test('a title and contact are inferred from the shapes recorders produce', () => {
  assert.deepEqual(inferTitleAndContact('Call with Sarah Bennett 2026-09-15.m4a'), {
    title: 'Call with Sarah Bennett',
    contact: 'Sarah Bennett',
  });
  assert.deepEqual(inferTitleAndContact('Acme renewal call.m4a'), {
    title: 'Acme renewal',
    contact: 'Acme renewal',
  });
  assert.deepEqual(inferTitleAndContact('Recording_with_Acme.mp3'), {
    title: 'Call with Acme',
    contact: 'Acme',
  });

  // A timestamp-only name says nothing, so nothing is claimed.
  for (const name of ['20260915_143012.m4a', '2026-09-15 14-30-12.m4a']) {
    assert.deepEqual(inferTitleAndContact(name), { title: 'Call recording', contact: '' });
  }

  assert.equal(inferTitleAndContact('').title, 'Call recording');
  // A long descriptive title is not mistaken for a person's name.
  assert.equal(inferTitleAndContact('quarterly planning and budget review call.m4a').contact, '');
});

test('a recorded date is inferred only when the file name contains a real date', () => {
  const now = new Date('2026-09-19T12:00:00Z');

  assert.equal(
    inferRecordedAt('Call 2026-09-15.m4a', now),
    new Date(2026, 8, 15, 12, 0, 0, 0).toISOString()
  );
  assert.equal(
    inferRecordedAt('20260915_143012.m4a', now),
    new Date(2026, 8, 15, 14, 30, 0, 0).toISOString()
  );

  // A clock stamp that cannot be a time is dropped, and the real date is kept.
  assert.equal(
    inferRecordedAt('call 2026-09-15 at 99-99.m4a', now),
    new Date(2026, 8, 15, 12, 0, 0, 0).toISOString()
  );
  // An impossible clock time attached to the date is refused outright.
  assert.equal(inferRecordedAt('call 2026-09-15 25-99.m4a', now), null);

  // Impossible and future dates are refused rather than quietly rolled forward.
  assert.equal(inferRecordedAt('call 2026-02-31.m4a', now), null);
  assert.equal(inferRecordedAt('call 2026-13-01.m4a', now), null);
  assert.equal(inferRecordedAt('call 2027-01-01.m4a', now), null);
  assert.equal(inferRecordedAt('call.m4a', now), null);
});

test('the date input round-trips, and rejects anything that is not a real date', () => {
  const iso = new Date(2026, 8, 15, 12, 0, 0, 0).toISOString();
  assert.equal(toDateInputValue(iso), '2026-09-15');
  assert.equal(fromDateInputValue('2026-09-15'), iso);

  assert.equal(fromDateInputValue('15/09/2026'), null);
  assert.equal(fromDateInputValue('2026-02-31'), null);
  assert.equal(fromDateInputValue(''), null);
  assert.equal(toDateInputValue('not a date'), '');
});

test('sizes and durations read the way a person writes them', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(12 * 1024 * 1024), '12 MB');
  assert.equal(formatBytes(4 * 1024 * 1024), '4.0 MB');
  assert.equal(formatBytes(0), '0 B');

  assert.equal(formatDuration(48 * 1000), '48s');
  assert.equal(formatDuration(12 * 60 * 1000 + 5000), '12m 05s');
  assert.equal(formatDuration(64 * 60 * 1000), '1h 04m');
});

test('each format maps to the MIME type the backend expects', () => {
  assert.equal(mimeTypeForExtension('m4a'), 'audio/mp4');
  assert.equal(mimeTypeForExtension('MP3'), 'audio/mpeg');
  assert.equal(mimeTypeForExtension('wav'), 'audio/wav');
  assert.equal(mimeTypeForExtension('aac'), 'audio/aac');
  assert.equal(mimeTypeForExtension('unknown'), 'application/octet-stream');
});
