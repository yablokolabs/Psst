#!/usr/bin/env node
/**
 * Songua pipeline spike.
 *
 * Takes one song and produces one short hook in another language. This exists to
 * answer the only question that decides the product — does the output sound like
 * the same song, sung in a new language? — before any app code is written around
 * the assumption that it does.
 *
 * Usage:
 *   node scripts/songua-spike.js <song> --to en [--from pt] [--tags "fado, guitar"]
 *     --to      target language (default en)
 *     --from    source language; omitted means auto-detect
 *     --tags    genre tags for the re-sung audio (default "pop")
 *     --hook-ms length of the clip to produce (default 15000)
 *     --out     output directory (default /tmp/songua)
 *     --no-separate  transcribe the full mix instead of an isolated vocal
 *
 * Pipeline:
 *   [fal] Demucs  -> isolated vocal, because ASR on a full mix is guesswork
 *   [EL]  Scribe  -> words WITH timings, which is what makes the next two steps
 *                    possible at all
 *   local findHook -> the repeated chorus, with held notes marked
 *   local ffmpeg   -> cut that window out
 *   [LLM] Sarvam   -> singable translation (the part no vendor sells)
 *   [fal] ACE-Step -> rewrite the lyric, keep the melody and the performance
 *
 * Every stage that needs a vendor is skipped with a clear message rather than
 * crashing, so the pipeline can be exercised with the keys that exist today.
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { isFalConfigured, separateStems, toDataUri, transformLyrics } from '../src/songua/fal.js';
import { findHook } from '../src/songua/hook.js';
import { translateHook } from '../src/songua/translate.js';
import { isBatchSttConfigured, transcribeRecording } from '../src/stt.js';

const execFileAsync = promisify(execFile);

const DEFAULTS = {
  to: 'en',
  from: '',
  tags: 'pop',
  hookMs: 15000,
  out: '/tmp/songua',
  separate: true,
};

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  /** @type {string[]} */
  const positional = [];

  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at];
    if (arg === '--to') options.to = argv[++at] ?? options.to;
    else if (arg === '--from') options.from = argv[++at] ?? options.from;
    else if (arg === '--tags') options.tags = argv[++at] ?? options.tags;
    else if (arg === '--hook-ms') options.hookMs = Number(argv[++at]) || options.hookMs;
    else if (arg === '--out') options.out = argv[++at] ?? options.out;
    else if (arg === '--no-separate') options.separate = false;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else positional.push(arg);
  }

  options.input = positional[0] ?? '';
  return options;
}

/** Timed step logger: knowing which stage is slow is half of what a spike is for. */
function step(label) {
  const startedAt = Date.now();
  process.stdout.write(`\n▸ ${label}\n`);
  return (detail) => {
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    process.stdout.write(`  ${seconds}s${detail ? ` — ${detail}` : ''}\n`);
  };
}

function info(message) {
  process.stdout.write(`  ${message}\n`);
}

function warn(message) {
  process.stdout.write(`  ! ${message}\n`);
}

/** Container length, in milliseconds. */
async function probeDurationMs(file) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file,
  ]);
  const seconds = Number(String(stdout).trim());
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0;
}

/**
 * Cuts a window out of the song as 44.1 kHz stereo PCM.
 *
 * Stereo is kept deliberately: the model is being asked to preserve an
 * arrangement, and folding the music to mono first would only make that harder.
 */
async function sliceWindow(input, startMs, endMs, outFile) {
  await execFileAsync('ffmpeg', [
    '-y',
    '-ss', (startMs / 1000).toFixed(3),
    '-t', (Math.max(0, endMs - startMs) / 1000).toFixed(3),
    '-i', input,
    '-vn',
    '-ac', '2',
    '-ar', '44100',
    '-c:a', 'pcm_s16le',
    outFile,
  ]);
  return outFile;
}

/** Fetches a generated file to disk. */
async function download(url, outFile) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(outFile, bytes);
  return bytes.length;
}

function mimeTypeFor(file) {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.wav') return 'audio/wav';
  if (extension === '.mp3') return 'audio/mpeg';
  if (extension === '.flac') return 'audio/flac';
  if (extension === '.ogg' || extension === '.opus') return 'audio/ogg';
  if (extension === '.m4a' || extension === '.aac') return 'audio/mp4';
  return 'application/octet-stream';
}

async function transcribe(file, sourceLanguage) {
  // stt.js reads the language from the environment at call time, so a `--from`
  // override applies without touching the module's configuration surface.
  if (sourceLanguage) process.env.ELEVENLABS_STT_LANGUAGE = sourceLanguage;

  const bytes = await readFile(file);
  const result = await transcribeRecording({
    bytes,
    fileName: path.basename(file),
    mimeType: mimeTypeFor(file),
    includeWords: true,
  });
  if (!result.ok) throw new Error(result.error);
  return result;
}

/** Human-readable view of the hook: the words, their budget and the long notes. */
function printHook(hook) {
  info(`hook found by: ${hook.reason} (${hook.occurrences}x)`);
  info(`window: ${(hook.startMs / 1000).toFixed(2)}s → ${(hook.endMs / 1000).toFixed(2)}s (${(hook.durationMs / 1000).toFixed(1)}s)`);
  info(`${hook.words.length} words, ${hook.syllables} syllables`);
  if (hook.heldWords.length > 0) info(`held notes on: ${hook.heldWords.join(', ')}`);
  process.stdout.write(`\n  "${hook.text}"\n`);
}

function printTranslation(translation, hook) {
  process.stdout.write(`\n  "${translation.translation}"\n\n`);
  for (const [index, word] of translation.words.entries()) {
    const source = hook.words[index] ?? {};
    const marks = [`${word.syllables} syl`];
    if (source.held) marks.push('HELD');
    info(`${word.source || source.text || '?'} → ${word.target} [${marks.join(', ')}]`);
  }

  if (translation.choices.length > 0) {
    process.stdout.write('\n  Trade-offs made for singability:\n');
    for (const choice of translation.choices) {
      info(`"${choice.source}" → "${choice.chosen}" (literal: "${choice.literal}") — ${choice.reason}`);
    }
  }

  for (const warning of translation.warnings) warn(warning);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help || options.input === '') {
    process.stdout.write(
      'Usage: node scripts/songua-spike.js <song> [--to en] [--from pt] [--tags "pop"] [--hook-ms 15000] [--out dir] [--no-separate]\n'
    );
    process.exit(options.help ? 0 : 1);
  }

  const falReady = isFalConfigured();
  const sttReady = isBatchSttConfigured();

  process.stdout.write(`Songua spike — ${options.input}\n`);
  process.stdout.write(
    `  ElevenLabs STT: ${sttReady ? 'configured' : 'MISSING'} | fal: ${falReady ? 'configured' : 'MISSING (FAL_KEY)'}\n`
  );
  if (!sttReady) throw new Error('ElevenLabs is required: the hook cannot be found without a transcript.');

  await mkdir(options.out, { recursive: true });

  const durationMs = await probeDurationMs(options.input);
  info(`song is ${(durationMs / 1000).toFixed(1)}s long`);

  // 1. An isolated vocal transcribes far better than a full mix. When fal is
  //    available this is always worth the extra call, because every later stage
  //    inherits whatever the transcript got wrong.
  let transcriptionSource = options.input;
  const separateStep = options.separate && falReady ? step('Splitting the song into stems (Demucs)') : null;
  if (separateStep) {
    const songBytes = await readFile(options.input);
    const stems = await separateStems({ audio: toDataUri(songBytes, mimeTypeFor(options.input)) });
    if (stems.ok && stems.vocalsUrl) {
      const vocalFile = path.join(options.out, 'vocals.mp3');
      const size = await download(stems.vocalsUrl, vocalFile);
      transcriptionSource = vocalFile;
      separateStep(`vocal stem ${Math.round(size / 1024)} KB`);
    } else {
      separateStep(`skipped: ${stems.error}`);
      warn('falling back to transcribing the full mix');
    }
  } else if (options.separate && !falReady) {
    info('Skipping stem separation: FAL_KEY is not set.');
  }

  // 2. Transcription with word timings. This is where the held notes come from.
  const transcribeStep = step('Transcribing for lyrics and word timings (Scribe)');
  const transcript = await transcribe(transcriptionSource, options.from);
  transcribeStep(`${transcript.words.length} words, language ${transcript.languageCode || 'unknown'}`);
  if (transcript.words.length === 0) {
    throw new Error('No words were transcribed. Sung lyrics are harder than speech — check the audio and the language.');
  }

  // 3. Which part of the song is the hook.
  const hookStep = step('Finding the hook');
  const hook = findHook(transcript.words, { targetMs: options.hookMs });
  if (!hook.ok) throw new Error(`Could not find a hook: ${hook.error}`);
  hookStep();
  printHook(hook);

  // 4. The window the clip is cut from. When separation ran, this is the vocal's
  //    timing against the original mix, so the cut is taken from the mix.
  const windowFile = path.join(options.out, 'hook-source.wav');
  await sliceWindow(options.input, hook.startMs, hook.endMs, windowFile);
  info(`cut the hook window to ${windowFile}`);

  // 5. The moat: a translation that can actually be sung on this melody.
  const translateStep = step(`Translating singably into ${options.to} (Sarvam)`);
  const translation = await translateHook({
    hook,
    sourceLanguage: options.from || transcript.languageCode,
    targetLanguage: options.to,
  });
  if (!translation.ok) {
    translateStep(`failed: ${translation.error}`);
    throw new Error(translation.error);
  }
  translateStep(`confidence ${translation.confidence}`);
  printTranslation(translation, hook);

  // 6. Re-sing it. The one step that decides whether any of the above matters.
  let transformedUrl = null;
  if (falReady) {
    const transformStep = step('Rewriting the lyric, keeping the melody (ACE-Step)');
    const windowBytes = await readFile(windowFile);
    const result = await transformLyrics({
      audio: toDataUri(windowBytes, 'audio/wav'),
      sourceLyrics: hook.text,
      targetLyrics: translation.translation,
      tags: options.tags,
      onProgress: (progress) => info(String(progress)),
    });
    if (result.ok) {
      transformedUrl = result.audioUrl;
      const outFile = path.join(options.out, `hook.${options.to}.wav`);
      const size = await download(result.audioUrl, outFile);
      transformStep(`${outFile} (${Math.round(size / 1024)} KB)`);
      process.stdout.write(`\n  ▶ Original:    ${windowFile}\n  ▶ Translated:  ${outFile}\n`);
    } else {
      transformStep(`failed: ${result.error}`);
      warn('the translation above is still valid — only the re-sung audio is missing');
    }
  } else {
    process.stdout.write('\n  Set FAL_KEY to run the final step (stem separation + re-sung audio).\n');
  }

  const reportFile = path.join(options.out, 'report.json');
  await writeFile(
    reportFile,
    `${JSON.stringify(
      {
        input: options.input,
        durationMs,
        targetLanguage: options.to,
        sourceLanguage: options.from || transcript.languageCode,
        transcriptionSource,
        hook,
        translation,
        transformedUrl,
      },
      null,
      2
    )}\n`
  );
  process.stdout.write(`\n  Full report: ${reportFile}\n`);
}

main().catch((error) => {
  process.stderr.write(`\n✗ ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
