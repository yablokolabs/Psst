/**
 * Singable translation — the part of Songua that is not available off the shelf.
 *
 * Every other step in the pipeline can be rented: separation, transcription and
 * the re-sung vocal are all bought from vendors. This step cannot be, and it is
 * also the only step that decides whether the output sounds like a song or like
 * a subtitle.
 *
 * The insight is that a lyric is constrained in ways prose is not, and the
 * constraints are *measurable* from data the transcriber already gave us:
 *
 *   - How many syllables each word gets, so a word cannot be stretched to fit a
 *     note that is not there.
 *   - Which words sit on a long held note. A held note is sung on an open vowel;
 *     ending three sustained seconds on "heart" is unsingable, which is exactly
 *     why the Portuguese "coração" becomes "soul" and not "heart". Nothing else
 *     in the system knows where the long notes are — `hook.js` is what surfaces
 *     them, and this file is what uses them.
 *   - Which line endings rhymed, so the rhyme can be rebuilt in the target
 *     language instead of lost.
 *
 * The model is asked to report the trade-offs it made. That is not decoration:
 * "I chose 'soul' over 'heart' because the note is held" is the product's whole
 * pitch, and it is also the fastest way for a human to audit a translation
 * without re-singing it.
 */

import { getSarvamConfig, SarvamReasoningProvider } from '../sarvam.js';

/** Above this many words the model starts dropping lines to save effort. */
const MAX_HOOK_WORDS = 120;
/** Enough for a per-word map plus the trade-off notes on a long hook. */
const DEFAULT_MAX_TOKENS = 1600;

/** Strict schema: Sarvam is called with `strict: true`, so every key is required. */
export const TRANSLATION_SCHEMA = {
  type: 'object',
  properties: {
    translation: {
      type: 'string',
      description: 'The whole hook, translated, as one singable line of text.',
    },
    words: {
      type: 'array',
      description: 'One entry per source word, in the same order. Never merge or reorder.',
      items: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'The original word, unchanged.' },
          target: { type: 'string', description: 'The word to sing instead.' },
          syllables: { type: 'integer', description: 'Syllables in the target word.' },
        },
        required: ['source', 'target', 'syllables'],
        additionalProperties: false,
      },
    },
    choices: {
      type: 'array',
      description:
        'Only the words where singability beat literal meaning. Empty array if none.',
      items: {
        type: 'object',
        properties: {
          source: { type: 'string' },
          chosen: { type: 'string' },
          literal: { type: 'string', description: 'The literal translation that was rejected.' },
          reason: { type: 'string', description: 'Max 20 words, concrete: notes, vowels, rhymes.' },
        },
        required: ['source', 'chosen', 'literal', 'reason'],
        additionalProperties: false,
      },
    },
    confidence: { type: 'number', description: '0 to 1.' },
  },
  required: ['translation', 'words', 'choices', 'confidence'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = [
  'You adapt a song lyric so it can be sung in another language on the SAME melody.',
  'You are not a translator producing text. You are writing words that a singer will',
  'perform, so every choice is judged by how it sounds when sung, not how it reads.',
  '',
  'Hard rules:',
  '1. One target word per source word, in the same order. Never merge, split, drop,',
  '   reorder or add words. The word count must match exactly.',
  '2. Each target word must have the source word\'s syllable count, give or take one.',
  '   The total must stay within about 10% of the source total.',
  '3. A word marked HELD is sung on a long sustained note. It MUST end on an open',
  '   vowel sound (a, ah, ay, ee, o, oh, oo). Never let a sustained note end on a',
  '   hard consonant (t, k, p, d, g, b, c). If the literal word fails this, choose a',
  '   different word that means something close enough and record it in "choices".',
  '4. Where the source line endings rhyme, make the target line endings rhyme with',
  '   each other. Rhyme is a feature of the song, not ornament.',
  '5. Preserve the meaning and the emotional register. A love song stays a love song.',
  '   Prefer the emotion over literal wording, but never invent a different subject.',
  '6. The result must sound native in the target language. No word-for-word',
  '   translationese, no awkward consonant clusters a singer would trip over.',
  '',
  'For "choices", list only the words where you traded literal accuracy for',
  'singability, and say which constraint forced it. Be concrete and brief. An empty',
  'array is a valid answer if nothing was traded.',
  '',
  'Reply with JSON only.',
].join('\n');

/**
 * Three-letter ISO 639-2 codes, as the transcriber returns them, mapped to the
 * two-letter tags `Intl` understands.
 *
 * Observed in practice: Scribe reports `eng`, and `Intl.DisplayNames` cannot
 * resolve a 639-2 code, so without this the prompt reads "From: eng" — the model
 * would still probably cope, but the constraint the whole step depends on would
 * be stated vaguely for no reason.
 */
const ISO_639_2_TO_1 = new Map(
  Object.entries({
    eng: 'en', por: 'pt', spa: 'es', fra: 'fr', fre: 'fr', deu: 'de', ger: 'de', ita: 'it',
    nld: 'nl', dut: 'nl', swe: 'sv', nor: 'no', dan: 'da', fin: 'fi', isl: 'is', ice: 'is',
    pol: 'pl', ces: 'cs', cze: 'cs', slk: 'sk', slo: 'sk', slv: 'sl', hrv: 'hr', srp: 'sr',
    bul: 'bg', ron: 'ro', rum: 'ro', hun: 'hu', ell: 'el', gre: 'el', rus: 'ru', ukr: 'uk',
    lit: 'lt', lav: 'lv', est: 'et', cat: 'ca', glg: 'gl', eus: 'eu', baq: 'eu', sqi: 'sq', alb: 'sq',
    tur: 'tr', ara: 'ar', heb: 'he', fas: 'fa', per: 'fa', urd: 'ur', hin: 'hi', ben: 'bn',
    tam: 'ta', tel: 'te', mar: 'mr', guj: 'gu', kan: 'kn', mal: 'ml', pan: 'pa',
    jpn: 'ja', kor: 'ko', zho: 'zh', chi: 'zh', tha: 'th', vie: 'vi', ind: 'id', msa: 'ms', may: 'ms',
    fil: 'fil', tgl: 'fil', swa: 'sw', afr: 'af',
  })
);

/** Turns an ISO code into a language name for the prompt. */
function languageName(code) {
  const value = String(code ?? '').trim().toLowerCase();
  if (value === '') return 'the source language';
  try {
    return (
      new Intl.DisplayNames(['en'], { type: 'language' }).of(ISO_639_2_TO_1.get(value) ?? value) ??
      value
    );
  } catch {
    return value;
  }
}

/**
 * Lays out the hook for the model: one word per line, with the two facts that
 * constrain it.
 *
 * Timing is given in milliseconds and syllables as a number, because both are
 * measured. Held notes are the deciding fact, so they are marked inline rather
 * than in a separate list the model has to cross-reference.
 */
function formatWords(hook) {
  return hook.words
    .map((word) => {
      const marks = [`${word.syllables} syl`, `${word.durationMs}ms`];
      if (word.held) marks.push('HELD');
      return `${word.text} [${marks.join(', ')}]`;
    })
    .join('\n');
}

function formatLineEndings(hook) {
  if (hook.lineEndings.length === 0) return 'No phrase endings were detected.';
  return hook.lineEndings
    .map((ending) => `${ending.text} (ends in "${ending.rhymeTail}", ${ending.durationMs}ms)`)
    .join('\n');
}

/**
 * Translates one hook.
 *
 * Never throws: a provider failure is a returned result, because the caller has
 * to report a status rather than crash. Partial-but-usable output is returned
 * with `warnings` attached instead of being discarded — a word count that is off
 * by one is worth showing to a human, and hiding it would make the pipeline look
 * better than it is.
 *
 * @param {{
 *   hook: object,
 *   sourceLanguage?: string,
 *   targetLanguage: string,
 *   provider?: { complete: (request: object) => Promise<object | null> },
 *   maxTokens?: number
 * }} options
 * @returns {Promise<
 *   { ok: true, translation: string, words: Array<object>, choices: Array<object>, confidence: number, warnings: string[] }
 *   | { ok: false, error: string }
 * >}
 */
export async function translateHook({
  hook,
  sourceLanguage = '',
  targetLanguage,
  provider,
  maxTokens = DEFAULT_MAX_TOKENS,
}) {
  if (!hook || hook.ok !== true || !Array.isArray(hook.words) || hook.words.length === 0) {
    return { ok: false, error: 'nothing-to-translate' };
  }
  if (String(targetLanguage ?? '').trim() === '') {
    return { ok: false, error: 'no-target-language' };
  }
  if (hook.words.length > MAX_HOOK_WORDS) {
    return { ok: false, error: `hook-too-long: ${hook.words.length} words` };
  }

  const engine = provider ?? new SarvamReasoningProvider();
  if (typeof engine?.complete !== 'function') {
    return { ok: false, error: 'translation-engine-unavailable' };
  }

  const heldCount = hook.heldWords.length;
  const user = [
    `# Languages`,
    `From: ${languageName(sourceLanguage)}`,
    `To: ${languageName(targetLanguage)}`,
    '',
    '# The hook, as it is sung now',
    formatWords(hook),
    '',
    `Total: ${hook.words.length} words, ${hook.syllables} syllables, ${heldCount} held note(s).`,
    '',
    '# Phrase endings (where rhyme must live)',
    formatLineEndings(hook),
    '',
    'Translate this hook so it can be sung on the same melody.',
  ].join('\n');

  const result = await engine.complete({
    system: SYSTEM_PROMPT,
    user,
    schema: TRANSLATION_SCHEMA,
    schemaName: 'songua_translation',
    maxTokens,
  });

  if (!result || result.error || !result.data) {
    return { ok: false, error: `translation-failed: ${result?.error ?? 'no result'}` };
  }

  return normalizeTranslation(result.data, hook);
}

/**
 * Validates and repairs the model's answer.
 *
 * The word-count rule is the one that silently ruins output: a longer
 * translation than melody fits cannot be sung, and a shorter one leaves a hole.
 * A mismatch is reported as a warning rather than thrown away, because the
 * translation is usually still worth listening to and the defect is worth
 * measuring across songs.
 */
export function normalizeTranslation(data, hook) {
  if (typeof data !== 'object' || data === null) {
    return { ok: false, error: 'malformed-translation' };
  }

  const translation = typeof data.translation === 'string' ? data.translation.trim() : '';
  if (translation === '') return { ok: false, error: 'empty-translation' };

  const rawWords = Array.isArray(data.words) ? data.words : [];
  const words = rawWords
    .filter((word) => word && typeof word === 'object')
    .map((word) => ({
      source: typeof word.source === 'string' ? word.source : '',
      target: typeof word.target === 'string' ? word.target.trim() : '',
      syllables: Number.isFinite(word.syllables) ? Math.max(0, Math.trunc(word.syllables)) : 0,
    }))
    .filter((word) => word.target !== '');

  const choices = (Array.isArray(data.choices) ? data.choices : [])
    .filter((choice) => choice && typeof choice === 'object')
    .map((choice) => ({
      source: typeof choice.source === 'string' ? choice.source : '',
      chosen: typeof choice.chosen === 'string' ? choice.chosen : '',
      literal: typeof choice.literal === 'string' ? choice.literal : '',
      reason: typeof choice.reason === 'string' ? choice.reason : '',
    }))
    .filter((choice) => choice.chosen !== '');

  const warnings = [];
  if (words.length !== hook.words.length) {
    warnings.push(
      `word-count-mismatch: ${hook.words.length} source words, ${words.length} returned`
    );
  }

  // Syllable drift is measured on the words that have to land on the note grid,
  // excluding held notes. A sustained note absorbs syllables: the product's own
  // headline example is "coração" (three syllables) becoming "soul" (one), sung
  // over the same three seconds. Counting held words here would flag the best
  // translations as the worst ones, which would make the metric actively
  // misleading rather than merely imprecise.
  let sourceBudget = 0;
  let targetBudget = 0;
  for (const [index, word] of words.entries()) {
    const sourceWord = hook.words[index];
    if (sourceWord?.held) continue;
    sourceBudget += sourceWord?.syllables ?? 0;
    targetBudget += word.syllables;
  }
  if (sourceBudget > 0) {
    const drift = Math.abs(targetBudget - sourceBudget) / sourceBudget;
    if (drift > 0.15) {
      warnings.push(
        `syllable-drift: ${sourceBudget} source vs ${targetBudget} target across the un-held words (${Math.round(drift * 100)}%)`
      );
    }
  }

  // A held note ending on a hard consonant is the specific defect rule 3 exists
  // to prevent, so it is checked rather than trusted.
  for (const [index, word] of words.entries()) {
    const sourceWord = hook.words[index];
    if (!sourceWord?.held) continue;
    if (/[tkpdgbc]$/i.test(word.target)) {
      warnings.push(`held-note-hard-consonant: "${word.target}" is marked HELD`);
    }
  }

  return {
    ok: true,
    translation,
    words,
    choices,
    confidence: Number.isFinite(data.confidence) ? data.confidence : 0,
    warnings,
  };
}

/** True when a translation engine is configured. Never returns key material. */
export function isTranslationConfigured() {
  return getSarvamConfig().model.length > 0 && Boolean(process.env.SARVAM_API_KEY);
}
