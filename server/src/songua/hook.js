/**
 * Finding the hook.
 *
 * Songua turns a whole song into one short clip — a chorus, not a verse. That
 * decision is made here, and it is made from **timings the transcriber already
 * returned**, so finding the hook costs nothing extra.
 *
 * The signal is repetition. A chorus is the part that comes back, so the hook is
 * the longest run of words that appears more than once, widened to whole phrases
 * so the clip never starts or ends mid-sentence.
 *
 * Everything in this file is pure: words in, a hook out, no network and no clock.
 * That is deliberate — this is the part of the pipeline whose quality is easiest
 * to get wrong and cheapest to test.
 */

/** A gap this long means the singer stopped, not that a note was held. */
const DEFAULT_PHRASE_GAP_MS = 700;
/** Two words are "the same word" after case, accents and punctuation come off. */
const COMBINING_MARKS = /[\u0300-\u036f]/g;
/** Vowel runs approximate syllables well enough to give the translator a budget. */
const VOWEL_GROUPS = /[aeiouyáéíóúâêîôûãõàèìòùäëïöüåæøœ]+/gi;
/** Shortest repeated run worth calling a hook. Below this it is usually a riff. */
const MIN_NGRAM = 4;
/** Longest repeated run considered. A hook longer than this is a whole verse. */
const MAX_NGRAM = 12;
/** A held note is this much longer than the phrase's typical word. */
const HELD_RATIO = 1.6;
/** ...and at least this long in absolute terms, so fast songs do not flag noise. */
const HELD_FLOOR_MS = 600;

/**
 * Comparison form of a word: lower case, no accents, no punctuation.
 *
 * "Coração," and "coracao" must collapse together or a chorus that varies only
 * in punctuation would never be recognised as a repeat.
 */
export function normalizeWord(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[^a-z0-9'’]/g, '')
    .trim();
}

/**
 * Approximate syllable count of a word, by counting vowel runs.
 *
 * Deliberately rough. It is a *budget* handed to the translator, not a claim:
 * "coração" -> co-ra-ção -> 3, which is right; "fire" -> 1, which a singer would
 * probably sustain as 2. The model corrects the edge cases, and being off by one
 * on a word is far better than handing over no constraint at all.
 */
export function approximateSyllables(text) {
  const matches = String(text ?? '').match(VOWEL_GROUPS);
  return matches ? matches.length : 0;
}

/**
 * Trailing sound of a word, for rhyme reasoning.
 *
 * Not a rhyme detector — rhyme is language-specific and the translator is better
 * at judging it. This is the *evidence*: the last vowel run plus anything after
 * it, so a model can see that "coração" and "canção" end alike.
 */
export function rhymeTail(text) {
  const normalized = normalizeWord(text);
  const matches = normalized.match(VOWEL_GROUPS);
  if (!matches || matches.length === 0) return normalized;
  const last = matches[matches.length - 1];
  const at = normalized.lastIndexOf(last);
  return normalized.slice(at);
}

/** Converts provider words into comparable tokens, dropping anything unusable. */
function tokenize(words) {
  const tokens = [];
  for (const word of Array.isArray(words) ? words : []) {
    if (!word || typeof word !== 'object') continue;
    // Providers mark non-words (spaces, breaths, laughter) with other types.
    if (word.type !== undefined && word.type !== 'word') continue;

    const text = typeof word.text === 'string' ? word.text.trim() : '';
    const norm = normalizeWord(text);
    if (norm === '') continue;

    const startMs = Number.isFinite(word.start) ? Math.max(0, Math.round(word.start * 1000)) : null;
    const endMs = Number.isFinite(word.end) ? Math.max(0, Math.round(word.end * 1000)) : null;
    if (startMs === null) continue;

    tokens.push({
      text,
      norm,
      startMs,
      endMs: endMs === null ? startMs : Math.max(endMs, startMs),
    });
  }
  tokens.sort((a, b) => a.startMs - b.startMs);
  return tokens;
}

/** Enriches a token with the duration-dependent facts the translator needs. */
function enrich(token, heldThresholdMs) {
  const durationMs = Math.max(0, token.endMs - token.startMs);
  return {
    text: token.text,
    startMs: token.startMs,
    endMs: token.endMs,
    durationMs,
    syllables: approximateSyllables(token.text),
    // The single most useful signal in the whole pipeline: which word sits on
    // the long note. The pitch's "soul, not heart" decision depends on knowing
    // this, and nothing else in the system reveals it.
    held: durationMs >= heldThresholdMs,
  };
}

/** Median of a numeric list, without mutating the input. */
function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * Groups tokens into phrases: everything between two long silences.
 *
 * Phrase boundaries matter because a clip that starts mid-phrase sounds broken,
 * and because the last word of a phrase is where the rhyme lives.
 */
function buildPhrases(tokens, gapMs) {
  const phrases = [];
  let current = null;

  for (const token of tokens) {
    if (current === null || token.startMs - current.endMs > gapMs) {
      if (current) phrases.push(current);
      current = { tokens: [token], startMs: token.startMs, endMs: token.endMs };
    } else {
      current.tokens.push(token);
      current.endMs = Math.max(current.endMs, token.endMs);
    }
  }
  if (current) phrases.push(current);

  return phrases.map((phrase, index) => ({
    index,
    tokens: phrase.tokens,
    startMs: phrase.startMs,
    endMs: phrase.endMs,
    text: phrase.tokens.map((token) => token.text).join(' '),
  }));
}

/**
 * Scores every repeated n-gram and returns the best one.
 *
 * Score is `length * occurrences`: a six-word line sung twice beats a
 * four-word line sung three times, because the longer one carries more of the
 * song's identity. Ties break toward the longer run, then toward the earlier
 * occurrence, so the clip lands on the first chorus rather than the last.
 */
function findBestRepeat(tokens) {
  let best = null;

  for (let n = MAX_NGRAM; n >= MIN_NGRAM; n -= 1) {
    /** @type {Map<string, number[]>} */
    const positions = new Map();

    for (let at = 0; at + n <= tokens.length; at += 1) {
      const key = tokens
        .slice(at, at + n)
        .map((token) => token.norm)
        .join(' ');
      const list = positions.get(key);
      if (list) list.push(at);
      else positions.set(key, [at]);
    }

    for (const [key, list] of positions) {
      if (list.length < 2) continue;
      // Overlapping occurrences mean a word was simply repeated; that is not a
      // chorus. Require the repeats to be separated in time.
      const starts = list.map((at) => tokens[at].startMs);
      const spread = Math.max(...starts) - Math.min(...starts);
      if (spread < 2000) continue;

      const score = n * list.length;
      const candidate = { key, at: list[0], length: n, occurrences: list.length, score, spread };
      if (
        best === null ||
        candidate.score > best.score ||
        (candidate.score === best.score && candidate.length > best.length)
      ) {
        best = candidate;
      }
    }
  }

  return best;
}

/**
 * Index of the last token of the phrase containing `tokenIndex`.
 *
 * `phrase.offset` is the phrase's first global token index, assigned in
 * `findHook` once the phrase list is final.
 */
function endOfPhrase(phrases, tokenIndex) {
  for (const phrase of phrases) {
    const phraseEnd = phrase.offset + phrase.tokens.length - 1;
    if (phrase.offset <= tokenIndex && tokenIndex <= phraseEnd) return phraseEnd;
  }
  return tokenIndex;
}

/**
 * Widens a global token range to the phrase boundaries that contain it, so the
 * clip never begins or ends mid-phrase.
 *
 * `phrase.offset` is the phrase's first global token index, assigned in
 * `findHook` once the phrase list is final.
 */
function expandToPhrases(phrases, fromTokenIndex, tokenCount) {
  const toTokenIndex = fromTokenIndex + tokenCount - 1;
  let start = fromTokenIndex;
  let end = toTokenIndex;

  for (const phrase of phrases) {
    const phraseStart = phrase.offset;
    const phraseEnd = phrase.offset + phrase.tokens.length - 1;

    if (phraseStart <= fromTokenIndex && fromTokenIndex <= phraseEnd) start = phraseStart;
    if (phraseStart <= toTokenIndex && toTokenIndex <= phraseEnd) end = phraseEnd;
  }

  return { from: start, to: Math.max(end, toTokenIndex) };
}

/**
 * Selects the clip for a song: a repeated hook when there is one, otherwise the
 * longest phrase, otherwise something near the first third — where a chorus
 * almost always lands.
 *
 * @param {Array<object>} words provider words, in any order, with `start`/`end` in seconds
 * @param {{ targetMs?: number, gapMs?: number }} [options]
 * @returns {{ ok: true, text: string, reason: string, occurrences: number, startMs: number, endMs: number, durationMs: number, words: Array<object>, heldWords: string[], lineEndings: Array<object>, syllables: number } | { ok: false, error: string }}
 */
export function findHook(words, options = {}) {
  const targetMs = Number.isFinite(options.targetMs) && options.targetMs > 0 ? options.targetMs : 15000;
  const gapMs =
    Number.isFinite(options.gapMs) && options.gapMs >= 0 ? options.gapMs : DEFAULT_PHRASE_GAP_MS;

  const tokens = tokenize(words);
  if (tokens.length === 0) return { ok: false, error: 'no-words' };

  // Phrase offsets are computed once and reused for window expansion.
  const phrases = buildPhrases(tokens, gapMs);
  let offset = 0;
  for (const phrase of phrases) {
    phrase.offset = offset;
    offset += phrase.tokens.length;
  }

  const repeat = findBestRepeat(tokens);

  let from;
  let to;
  let reason;
  let occurrences;

  if (repeat) {
    const widened = expandToPhrases(phrases, repeat.at, repeat.length);
    from = widened.from;
    to = widened.to;
    reason = 'repeated';
    occurrences = repeat.occurrences;
  } else {
    // No repetition: the recording may be a fragment, or the transcription may
    // be too noisy to match runs. Fall back to the longest phrase.
    const longest = phrases.reduce((best, phrase) =>
      phrase.tokens.length > best.tokens.length ? phrase : best
    );
    from = longest.offset;
    to = longest.offset + longest.tokens.length - 1;
    reason = phrases.length > 1 ? 'longest-phrase' : 'single-phrase';
    occurrences = 1;
  }

  const startMs = tokens[from].startMs;
  const naturalEndMs = tokens[to].endMs;
  const songEndMs = tokens[tokens.length - 1].endMs;

  // The clip has to be long enough to be worth hearing, but a clip is only as
  // good as its lyric: whatever audio it contains must also be translated, or
  // the untranslated part plays in the original language. So the window is
  // widened to cover every word that starts inside it, rather than stopping at
  // the end of the hook phrase.
  let desiredEndMs = Math.max(naturalEndMs, startMs + targetMs);
  desiredEndMs = Math.min(desiredEndMs, songEndMs);

  let last = to;
  while (last + 1 < tokens.length && tokens[last + 1].startMs < desiredEndMs) last += 1;
  // Never end mid-phrase: a clip that cuts a word in half sounds broken.
  last = endOfPhrase(phrases, last);
  to = last;

  const windowTokens = tokens.slice(from, to + 1);
  const endMs = windowTokens[windowTokens.length - 1].endMs;

  const durations = windowTokens.map((token) => Math.max(0, token.endMs - token.startMs));
  const heldThresholdMs = Math.max(HELD_FLOOR_MS, median(durations) * HELD_RATIO);
  const enriched = windowTokens.map((token) => enrich(token, heldThresholdMs));

  // Rhyme evidence: the closing word of every phrase the clip covers.
  const lineEndings = phrases
    .filter((phrase) => phrase.endMs > startMs && phrase.startMs < endMs)
    .map((phrase) => {
      const last = phrase.tokens[phrase.tokens.length - 1];
      return {
        text: last.text,
        at: last.startMs,
        rhymeTail: rhymeTail(last.text),
        durationMs: Math.max(0, last.endMs - last.startMs),
      };
    });

  return {
    ok: true,
    text: enriched.map((word) => word.text).join(' '),
    reason,
    occurrences,
    startMs,
    endMs,
    durationMs: endMs - startMs,
    words: enriched,
    heldWords: enriched.filter((word) => word.held).map((word) => word.text),
    lineEndings,
    syllables: enriched.reduce((total, word) => total + word.syllables, 0),
  };
}
