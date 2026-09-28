/**
 * Unit tests for singable translation.
 *
 * Offline: the reasoning provider is a stub, so no request leaves the machine.
 * The environment is set before the module is imported because Sarvam's config
 * is read at call time.
 *
 * The first test is the important one. It asserts that the constraint which
 * makes this step special — knowing which word sits on the long note — actually
 * reaches the model. Everything else here guards the shape of what comes back.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

process.env.SARVAM_API_KEY = '';
process.env.ELEVENLABS_API_KEY = 'test-key-never-sent-anywhere-real';

const { normalizeTranslation, translateHook } = await import('../src/songua/translate.js');

/** A provider that records the request and answers with whatever it is given. */
function stubProvider(data) {
  const calls = [];
  return {
    calls,
    complete: async (request) => {
      calls.push(request);
      return { data };
    },
  };
}

const HOOK = {
  ok: true,
  text: 'meu coracao e teu',
  words: [
    { text: 'meu', syllables: 1, durationMs: 500, held: false },
    { text: 'coracao', syllables: 3, durationMs: 2000, held: true },
    { text: 'e', syllables: 1, durationMs: 200, held: false },
    { text: 'teu', syllables: 1, durationMs: 400, held: true },
  ],
  syllables: 6,
  heldWords: ['coracao', 'teu'],
  lineEndings: [{ text: 'teu', rhymeTail: 'eu', durationMs: 400 }],
};

const GOOD = {
  translation: 'my soul is yours',
  words: [
    { source: 'meu', target: 'my', syllables: 1 },
    { source: 'coracao', target: 'soul', syllables: 1 },
    { source: 'e', target: 'is', syllables: 1 },
    { source: 'teu', target: 'yours', syllables: 1 },
  ],
  choices: [
    {
      source: 'coracao',
      chosen: 'soul',
      literal: 'heart',
      reason: 'The note is held for two seconds; "heart" ends on a hard consonant.',
    },
  ],
  confidence: 0.82,
};

test('the prompt tells the model where the long notes are', () => {
  const provider = stubProvider(GOOD);
  return translateHook({
    hook: HOOK,
    sourceLanguage: 'pt',
    targetLanguage: 'en',
    provider,
  }).then(() => {
    const { user, system } = provider.calls[0];

    assert.match(user, /HELD/);
    assert.match(user, /coracao \[3 syl, 2000ms, HELD\]/);
    assert.match(user, /Portuguese/);
    assert.match(user, /English/);
    assert.match(user, /rhyme must live/);
    assert.match(system, /Never let a sustained note end on a/);
  });
});

test('the transcriber\'s three-letter language codes reach the prompt as names', async () => {
  // Scribe reports `eng`, not `en`. Both must end up readable in the prompt.
  const provider = stubProvider(GOOD);
  await translateHook({
    hook: HOOK,
    sourceLanguage: 'por',
    targetLanguage: 'eng',
    provider,
  });

  const { user } = provider.calls[0];
  assert.match(user, /From: Portuguese/);
  assert.match(user, /To: English/);
  assert.doesNotMatch(user, /From: por/);
});

test('an unrecognised language code is passed through rather than mangled', async () => {
  const provider = stubProvider(GOOD);
  await translateHook({ hook: HOOK, sourceLanguage: 'xx', targetLanguage: 'en', provider });
  assert.match(provider.calls[0].user, /From: xx/);
});

test('a clean translation comes back with no warnings', async () => {
  const result = await translateHook({
    hook: HOOK,
    sourceLanguage: 'pt',
    targetLanguage: 'en',
    provider: stubProvider(GOOD),
  });

  assert.equal(result.ok, true);
  assert.equal(result.translation, 'my soul is yours');
  assert.equal(result.words.length, 4);
  assert.equal(result.choices.length, 1);
  assert.equal(result.confidence, 0.82);
  assert.deepEqual(result.warnings, []);
});

test('a word count that does not match is reported, not silently accepted', () => {
  const result = normalizeTranslation(
    { ...GOOD, words: GOOD.words.slice(0, 3) },
    HOOK
  );

  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((warning) => warning.startsWith('word-count-mismatch')));
});

test('held notes are exempt from the syllable budget', () => {
  // "coracao" (3) becomes "soul" (1) over a two-second note. That is a good
  // translation, so it must not be reported as drift.
  const result = normalizeTranslation(GOOD, HOOK);
  assert.deepEqual(result.warnings, []);
});

test('syllable drift is measured on the words that must fit the note grid', () => {
  const result = normalizeTranslation(
    {
      ...GOOD,
      words: GOOD.words.map((word) => ({ ...word, syllables: 4 })),
    },
    HOOK
  );

  assert.ok(result.warnings.some((warning) => warning.startsWith('syllable-drift')));
});

test('a held note ending on a hard consonant is caught', () => {
  const result = normalizeTranslation(
    {
      ...GOOD,
      words: [
        { source: 'meu', target: 'my', syllables: 1 },
        { source: 'coracao', target: 'heart', syllables: 1 },
        { source: 'e', target: 'is', syllables: 1 },
        { source: 'teu', target: 'yours', syllables: 1 },
      ],
    },
    HOOK
  );

  // This is the exact defect the product's headline example is about.
  assert.ok(result.warnings.some((warning) => warning.startsWith('held-note-hard-consonant')));
});

test('an empty translation is a failure, not an empty song', async () => {
  const result = await translateHook({
    hook: HOOK,
    targetLanguage: 'en',
    provider: stubProvider({ ...GOOD, translation: '   ' }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'empty-translation');
});

test('a provider error is returned rather than thrown', async () => {
  const result = await translateHook({
    hook: HOOK,
    targetLanguage: 'en',
    provider: { complete: async () => ({ error: 'Sarvam returned HTTP 429' }) },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /translation-failed/);
});

test('a provider that never answers is survivable', async () => {
  const result = await translateHook({
    hook: HOOK,
    targetLanguage: 'en',
    provider: { complete: async () => null },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /translation-failed/);
});

test('nonsense targets and hooks are refused before any request is made', async () => {
  const provider = stubProvider(GOOD);

  const noTarget = await translateHook({ hook: HOOK, targetLanguage: '', provider });
  assert.equal(noTarget.error, 'no-target-language');

  const noHook = await translateHook({ hook: { ok: false }, targetLanguage: 'en', provider });
  assert.equal(noHook.error, 'nothing-to-translate');

  assert.equal(provider.calls.length, 0);
});

test('an over-long hook is refused instead of half-translated', async () => {
  const words = Array.from({ length: 200 }, (_, index) => ({
    text: `w${index}`,
    syllables: 1,
    durationMs: 300,
    held: false,
  }));

  const result = await translateHook({
    hook: { ...HOOK, words, syllables: 200 },
    targetLanguage: 'en',
    provider: stubProvider(GOOD),
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /hook-too-long/);
});

test('off-schema word entries are dropped rather than trusted', () => {
  const result = normalizeTranslation(
    {
      ...GOOD,
      words: [
        { source: 'meu', target: 'my', syllables: 1 },
        null,
        'a bare string',
        { source: 'coracao', target: '   ', syllables: 3 },
        { source: 'teu', target: 'yours', syllables: 'lots' },
      ],
      choices: [null, { chosen: '' }, { chosen: 'soul', literal: 'heart', reason: 'held note' }],
    },
    HOOK
  );

  assert.equal(result.ok, true);
  assert.equal(result.words.length, 2);
  assert.equal(result.words[1].syllables, 0);
  assert.equal(result.choices.length, 1);
});
