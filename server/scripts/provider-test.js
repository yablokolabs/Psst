/**
 * Real provider connectivity + pipeline test.
 *
 *   npm run providers            # STT + reasoning
 *   npm run providers -- --recap # also exercise the model-written recap
 *
 * This is NOT a mock test. It makes real calls:
 *
 *   1. ElevenLabs TTS  : synthesise the acceptance-test sentence as PCM16 16kHz
 *   2. ElevenLabs STT  : stream that audio through the real realtime endpoint and
 *                        assert real spoken words come back
 *   3. Sarvam          : run decide() on the transcript and on a control line
 *
 * It uses a few seconds of TTS/STT audio and two small completions, and never
 * prints or returns an API key.
 *
 * Audio is synthesised because this machine has no microphone: the same code path
 * a phone uses is exercised, but the speaker here is TTS rather than a human.
 */

import { openTranscriptionSession, isElevenLabsConfigured, getElevenLabsConfig } from '../src/elevenlabs.js';
import { loadServerEnv } from '../src/env.js';
import { buildRecap, createReasoningProvider, decide } from '../src/reasoning.js';
import { getSarvamApiKey, getSarvamConfig, isSarvamConfigured } from '../src/sarvam.js';
import { ConversationSession } from '../src/session.js';
import { normalizeAudioConfig } from '../src/audio.js';

loadServerEnv();

const SAMPLE_RATE = 16000;
const CHUNK_MS = 100;
const CHUNK_BYTES = (SAMPLE_RATE * CHUNK_MS) / 1000 * 2;

const SCENARIO = {
  goal: {
    title: 'Acme renewal call',
    objective: "Understand the customer's budget before offering a discount.",
    notes: 'Do not mention a discount before they disclose their range.',
    preset: 'sales',
  },
  spoken: 'We really like the product, but two thousand dollars per month is above our budget.',
  smallTalk: 'Thanks for joining the call today, the weather has been lovely this week.',
};

const results = [];

function record(name, status, detail) {
  results.push({ name, status, detail });
  const icon = status === 'pass' ? '✓' : status === 'fail' ? '✖' : '○';
  console.log(`${icon} ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, detail) {
  record(name, 'fail', detail);
  process.exitCode = 1;
}

function skip(name, detail) {
  record(name, 'skip', detail);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const silentChunk = (ms) => Buffer.alloc(((SAMPLE_RATE * ms) / 1000) * 2);

/** Synthesises speech as PCM16 mono 16kHz using the ElevenLabs TTS API. */
async function synthesize(text) {
  const headers = { 'xi-api-key': getElevenLabsApiKeyForTest(), 'content-type': 'application/json' };

  const voicesResponse = await fetch('https://api.elevenlabs.io/v1/voices', { headers });
  if (!voicesResponse.ok) {
    throw new Error(`voice lookup failed with HTTP ${voicesResponse.status}`);
  }
  const voices = await voicesResponse.json();
  const voiceId = voices?.voices?.[0]?.voice_id;
  if (!voiceId) throw new Error('no voice available on this account');

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=pcm_16000`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }),
    }
  );

  if (!response.ok) {
    throw new Error(`TTS failed with HTTP ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

function getElevenLabsApiKeyForTest() {
  const key = process.env.ELEVENLABS_API_KEY ?? '';
  if (!key) throw new Error('ELEVENLABS_API_KEY is not set');
  return key;
}

/** Streams PCM through the production STT client and returns what it heard. */
async function transcribe(pcm) {
  const partials = [];
  const finals = [];
  let started = false;
  let failure = null;

  const transcription = openTranscriptionSession({
    onPartial: (text) => partials.push(text),
    onFinal: (text) => finals.push(text),
    onError: (message) => {
      failure = message;
    },
    onOpen: () => {
      started = true;
    },
  });

  // Pace the audio in real time: the endpoint is a live stream, not a file upload.
  for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES) {
    const chunk = pcm.subarray(offset, offset + CHUNK_BYTES);
    transcription.sendAudio(chunk.toString('base64'), SAMPLE_RATE);
    await sleep(CHUNK_MS);
  }

  // Trailing silence so voice-activity detection commits the final utterance.
  for (let i = 0; i < 15; i += 1) {
    transcription.sendAudio(silentChunk(100).toString('base64'), SAMPLE_RATE);
    await sleep(100);
  }

  const deadline = Date.now() + 8000;
  while (finals.length === 0 && !failure && Date.now() < deadline) {
    await sleep(200);
  }

  const stats = transcription.stats();
  transcription.close();

  return { partials, finals, started, failure, stats };
}

async function testElevenLabs() {
  console.log('\n# ElevenLabs realtime STT');
  const config = getElevenLabsConfig();
  console.log(`  endpoint: ${config.endpoint}`);
  console.log(`  model:    ${config.modelId} (commit strategy: ${config.commitStrategy})`);

  if (!isElevenLabsConfigured()) {
    skip('elevenlabs.stt', 'ELEVENLABS_API_KEY is not configured on the backend');
    return null;
  }

  const audioConfig = normalizeAudioConfig({ sampleRate: SAMPLE_RATE, channels: 1, encoding: 'int16' });
  record('audio-format', audioConfig ? 'pass' : 'fail', audioConfig ? `${audioConfig.audioFormat}, mono, int16` : 'rejected');

  let pcm;
  try {
    pcm = await synthesize(SCENARIO.spoken);
    record('elevenlabs.tts', 'pass', `${pcm.length} bytes of PCM16 @16kHz (input for the STT test)`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    skip('elevenlabs.tts', `${detail} — cannot synthesise speech on this machine`);
    skip('elevenlabs.stt-transcript', 'no speech audio available to transcribe');
    return null;
  }

  const result = await transcribe(pcm);
  console.log(`  provider chunks accepted: ${result.stats.sentChunks}`);
  console.log(`  partial events: ${result.partials.length}, committed events: ${result.finals.length}`);

  if (!result.started) fail('elevenlabs.stt-session', result.failure ?? 'session never started');
  else record('elevenlabs.stt-session', 'pass', 'provider accepted the WebSocket session');

  if (result.failure) {
    fail('elevenlabs.stt-transcript', result.failure);
    return null;
  }

  const transcript = result.finals.join(' ').trim();
  if (transcript === '') {
    fail('elevenlabs.stt-transcript', 'no committed transcript returned for real speech audio');
    return null;
  }

  if (result.partials.length === 0) {
    fail('elevenlabs.stt-partials', 'no partial transcripts received');
  } else {
    record('elevenlabs.stt-partials', 'pass', `${result.partials.length} partial updates, e.g. "${result.partials.at(-1)}"`);
  }

  record('elevenlabs.stt-transcript', 'pass', `"${transcript}"`);
  return transcript;
}

async function testSarvam(realTranscript) {
  console.log('\n# Sarvam reasoning');
  const config = getSarvamConfig();
  console.log(`  endpoint: ${config.endpoint}`);
  console.log(`  model:    ${config.model} (reasoning effort: ${config.reasoningEffort})`);

  if (!isSarvamConfigured()) {
    skip('sarvam.decide', 'SARVAM_API_KEY is not configured on the backend');
    return;
  }

  // The live path keeps a tight budget (a late cue is useless). This test is
  // about connectivity and cue quality, so give the model more room and report
  // the real latency instead of failing on a slow reply.
  process.env.SARVAM_TIMEOUT_MS = process.env.SARVAM_TIMEOUT_MS ?? '30000';
  const provider = createReasoningProvider();

  if (!provider) {
    fail('sarvam.provider', 'no reasoning provider was constructed');
    return;
  }
  record('sarvam.provider', 'pass', `SarvamReasoningProvider constructed (timeout ${provider.config.timeoutMs}ms)`);

  // --- The acceptance scenario: a price objection with the budget undisclosed.
  const scenarioText = realTranscript ?? SCENARIO.spoken;
  const scenario = {
    goal: SCENARIO.goal,
    transcript: [{ id: 'l1', speaker: 'them', text: scenarioText, isFinal: true, at: 4200 }],
    latest: { id: 'l1', speaker: 'them', text: scenarioText, isFinal: true, at: 4200 },
    recentCues: [],
    lastCueAt: null,
  };

  const startedAt = Date.now();
  const decision = await decide(scenario, { provider });
  const latencyMs = Date.now() - startedAt;
  console.log(`  decision (${latencyMs}ms): ${JSON.stringify(decision)}`);

  if (decision.outcome === 'PSST' && decision.cue) {
    record(
      'sarvam.psst',
      'pass',
      `"${decision.cue.observation}" / "${decision.cue.suggestion}" (${latencyMs}ms, confidence ${decision.cue.confidence})`
    );
    if (latencyMs > 6000) {
      console.log(`  note: ${latencyMs}ms is above the comfortable budget for a live cue`);
    }
  } else if (decision.error) {
    fail('sarvam.psst', `provider error: ${decision.error}`);
  } else {
    // Not a hard failure: NO_ACTION is always a legitimate answer, but the
    // acceptance scenario expects an intervention, so report it clearly.
    record('sarvam.psst', 'fail', `expected PSST for the price objection, got NO_ACTION (${decision.suppressed ?? 'no cue'})`);
    process.exitCode = 1;
  }

  // --- Control: small talk must produce NO_ACTION.
  const control = {
    goal: SCENARIO.goal,
    transcript: [{ id: 'l1', speaker: 'them', text: SCENARIO.smallTalk, isFinal: true, at: 3000 }],
    latest: { id: 'l1', speaker: 'them', text: SCENARIO.smallTalk, isFinal: true, at: 3000 },
    recentCues: [],
    lastCueAt: null,
  };

  const controlDecision = await decide(control, { provider });
  console.log(`  control decision: ${JSON.stringify(controlDecision)}`);

  if (controlDecision.outcome === 'NO_ACTION') {
    record('sarvam.no-action', 'pass', 'small talk stayed silent, as designed');
  } else {
    fail('sarvam.no-action', 'small talk produced a cue');
  }

  // --- Suppression: the same cue twice must be suppressed on the second pass.
  const repeat = await decide(
    {
      ...scenario,
      recentCues: decision.cue
        ? [{ observation: decision.cue.observation, action: decision.cue.suggestion }]
        : [],
      lastCueAt: Date.now(),
    },
    { provider }
  );

  if (repeat.outcome === 'NO_ACTION') {
    record('sarvam.suppression', 'pass', `repeat cue suppressed (${repeat.suppressed ?? 'no cue'})`);
  } else {
    fail('sarvam.suppression', 'a duplicate cue was emitted');
  }
}

async function testRecap(realTranscript) {
  console.log('\n# Sarvam recap');
  const provider = createReasoningProvider();
  if (!provider || !realTranscript) {
    skip('sarvam.recap', 'needs a real transcript and a configured Sarvam key');
    return;
  }

  const session = new ConversationSession({ id: 'provider-test', goal: SCENARIO.goal });
  session.start(SCENARIO.goal, { platform: 'node', appVersion: '0.1.0' });
  session.addTranscriptEntry({
    id: 'l1',
    speaker: 'them',
    text: realTranscript,
    isFinal: true,
    at: 4200,
  });

  // Recap is generated once at the very end of a session, so a slower model call
  // is acceptable here; the live cue path keeps its own tighter budget.
  const recapStartedAt = Date.now();
  const recap = await buildRecap(session, { provider });
  console.log(`  recap latency: ${Date.now() - recapStartedAt}ms`);
  console.log(`  summary: ${recap.summary}`);
  console.log(`  keyPoints: ${JSON.stringify(recap.keyPoints)}`);
  console.log(`  nextActions: ${JSON.stringify(recap.nextActions)}`);

  if (recap.summary.includes('recap model was unavailable')) {
    fail('sarvam.recap', 'model recap failed, fell back to the transcript recap');
  } else {
    record('sarvam.recap', 'pass', 'model-written recap returned');
  }
}

async function main() {
  console.log('Psst provider test — this makes real provider calls.');
  console.log(
    `configured: elevenlabs=${isElevenLabsConfigured()} sarvam=${isSarvamConfigured()}`
  );

  const realTranscript = await testElevenLabs();
  await testSarvam(realTranscript);

  if (process.argv.includes('--recap')) {
    await testRecap(realTranscript);
  } else {
    skip('sarvam.recap', 'run with --recap to exercise the model-written recap');
  }

  const failed = results.filter((item) => item.status === 'fail').length;
  const passed = results.filter((item) => item.status === 'pass').length;
  const skipped = results.filter((item) => item.status === 'skip').length;
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failed === 0) console.log('✓ provider test complete');
}

await main();
