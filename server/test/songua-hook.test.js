/**
 * Unit tests for hook detection.
 *
 * Offline and deterministic: a hook is found from word timings alone, so the
 * whole module can be exercised with hand-built arrays. The song below is
 * synthetic but shaped like the real thing — a verse, a chorus, a verse, the
 * chorus again — because the point of these tests is that the *repeat* is what
 * gets found, not that some arbitrary window comes out.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

const { approximateSyllables, findHook, normalizeWord, rhymeTail } = await import(
  '../src/songua/hook.js'
);

/** One provider word, with timings in the seconds the API actually returns. */
const word = (text, start, end) => ({ text, type: 'word', start, end });

/**
 * A four-phrase song. The chorus is the only run of words that comes back, and
 * its second word is sung long — the case the whole held-note rule exists for.
 */
function buildSong() {
  return [
    // Verse, 0.0 -> 3.0
    word('eu', 0.0, 0.5),
    word('ando', 0.6, 1.1),
    word('pela', 1.2, 1.7),
    word('rua', 1.8, 2.3),
    word('sozinho', 2.4, 3.0),
    // Chorus, 4.0 -> 8.4. "coracao" is held for two full seconds.
    word('meu', 4.0, 4.5),
    word('coracao', 4.6, 6.6),
    word('e', 6.7, 6.9),
    word('teu', 7.0, 7.4),
    word('minha', 7.5, 7.9),
    word('cancao', 8.0, 8.4),
    // Verse, 9.6 -> 12.0
    word('o', 9.6, 10.0),
    word('tempo', 10.1, 10.6),
    word('passa', 10.7, 11.2),
    word('devagar', 11.3, 12.0),
    // Chorus again, 13.4 -> 17.8
    word('meu', 13.4, 13.9),
    word('coracao', 14.0, 16.0),
    word('e', 16.1, 16.3),
    word('teu', 16.4, 16.8),
    word('minha', 16.9, 17.3),
    word('cancao', 17.4, 17.8),
    // Outro, so the requested clip length is not truncated by the song ending.
    word('e', 19.5, 19.9),
    word('o', 20.0, 20.4),
    word('fim', 20.5, 21.0),
  ];
}

test('normalizeWord strips case, accents and punctuation so repeats match', () => {
  assert.equal(normalizeWord('  Coração, '), 'coracao');
  assert.equal(normalizeWord('CORAÇÃO!'), 'coracao');
  assert.equal(normalizeWord('—'), '');
});

test('approximateSyllables gives a usable budget for the languages Songua targets', () => {
  assert.equal(approximateSyllables('coração'), 3);
  assert.equal(approximateSyllables('meu'), 1);
  assert.equal(approximateSyllables('teu'), 1);
  assert.equal(approximateSyllables('canção'), 2);
  assert.equal(approximateSyllables(''), 0);
});

test('rhymeTail exposes the ending a translator can rhyme against', () => {
  assert.equal(rhymeTail('coração'), 'ao');
  assert.equal(rhymeTail('canção'), 'ao');
  assert.equal(rhymeTail('teu'), 'eu');
});

test('findHook picks the repeated chorus, not the first phrase', () => {
  const hook = findHook(buildSong(), { targetMs: 15000 });

  assert.equal(hook.ok, true);
  assert.equal(hook.reason, 'repeated');
  assert.equal(hook.occurrences, 2);
  assert.equal(hook.startMs, 4000);
  assert.ok(hook.text.startsWith('meu coracao e teu minha cancao'));
});

test('the clip is widened to cover every word it contains', () => {
  const hook = findHook(buildSong(), { targetMs: 15000 });

  // The anchor is six words, but a clip that long is not worth hearing. Every
  // word inside the window must be translated too, or the rest of the clip plays
  // in the original language.
  assert.ok(hook.words.length > 6, `expected more than 6 words, got ${hook.words.length}`);
  assert.equal(hook.words.length, 16);
  assert.ok(hook.text.endsWith('meu coracao e teu minha cancao'));
});

test('the clip is at least as long as requested when the song allows it', () => {
  const hook = findHook(buildSong(), { targetMs: 10000 });
  assert.ok(hook.durationMs >= 10000, `expected >= 10000ms, got ${hook.durationMs}`);

  // A shorter request ends sooner, which is the whole point of the option.
  const shortHook = findHook(buildSong(), { targetMs: 5000 });
  assert.ok(shortHook.durationMs < hook.durationMs);
});

test('the clip never runs past the end of the song', () => {
  const hook = findHook(buildSong(), { targetMs: 120000 });
  assert.equal(hook.endMs, 21000);
});

test('the long note is flagged, and nothing short of it is', () => {
  const hook = findHook(buildSong(), { targetMs: 15000 });

  // Both choruses are inside the window, so the held word appears twice.
  assert.equal(hook.heldWords.filter((held) => held === 'coracao').length, 2);
  assert.ok(!hook.heldWords.includes('meu'));

  const held = hook.words.filter((entry) => entry.held);
  assert.ok(held.every((entry) => entry.durationMs >= 640));
});

test('every word carries the two facts the translator needs', () => {
  const hook = findHook(buildSong(), { targetMs: 15000 });
  const coracao = hook.words.find((entry) => entry.text === 'coracao');

  assert.equal(coracao.syllables, 3);
  assert.equal(coracao.durationMs, 2000);
  assert.equal(coracao.held, true);
});

test('phrase endings are reported for rhyme reasoning', () => {
  const hook = findHook(buildSong(), { targetMs: 15000 });
  assert.ok(hook.lineEndings.length >= 2);
  assert.ok(hook.lineEndings.some((ending) => ending.rhymeTail === 'ao'));
});

test('a song with no repeats falls back to its longest phrase', () => {
  const hook = findHook(
    [
      // Two phrases, split by a real silence, with nothing repeated across them.
      word('one', 0.0, 0.4),
      word('two', 0.5, 0.9),
      word('three', 1.0, 1.4),
      word('four', 2.4, 2.8),
      word('five', 2.9, 3.3),
      word('six', 3.4, 3.8),
      word('seven', 3.9, 4.3),
    ],
    { targetMs: 5000 }
  );

  assert.equal(hook.ok, true);
  assert.equal(hook.reason, 'longest-phrase');
  assert.ok(hook.text.startsWith('four five six seven'));
});

test('a clip drawn from a single phrase says so', () => {
  const hook = findHook(
    [word('one', 0.0, 0.4), word('two', 0.5, 0.9), word('three', 1.0, 1.4)],
    { targetMs: 5000 }
  );

  assert.equal(hook.reason, 'single-phrase');
});

test('silence between sung phrases is not treated as one phrase', () => {
  const hook = findHook([word('one', 0.0, 0.4), word('two', 9.0, 9.4)], { targetMs: 15000 });
  assert.equal(hook.reason, 'longest-phrase');
});

test('words the provider did not mark as words are ignored', () => {
  const hook = findHook(
    [
      { text: ' ', type: 'spacing', start: 0, end: 0.1 },
      { text: '[laughter]', type: 'audio_event', start: 0.1, end: 0.5 },
      word('hello', 0.6, 1.0),
    ],
    { targetMs: 5000 }
  );

  assert.equal(hook.ok, true);
  assert.equal(hook.text, 'hello');
});

test('an empty transcript is reported, not guessed at', () => {
  assert.deepEqual(findHook([]), { ok: false, error: 'no-words' });
  assert.deepEqual(findHook(undefined), { ok: false, error: 'no-words' });
});

test('words without timings are dropped rather than defaulted to zero', () => {
  const hook = findHook(
    [
      { text: 'no-timing', type: 'word' },
      { text: 'timed', type: 'word', start: 1, end: 1.4 },
    ],
    { targetMs: 5000 }
  );

  assert.equal(hook.text, 'timed');
});
