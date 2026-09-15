/**
 * Smoke test: starts the backend, opens a session over WebSocket, exercises the
 * session lifecycle and checks the protocol frames that come back.
 *
 *   npm run smoke
 *
 * This test is deliberately offline: it never sends real audio, so no provider
 * credit is consumed and it passes with or without provider keys configured. It
 * asserts that a session with no audio goes to `listening`, stays silent, keeps
 * running through pause/resume, survives malformed frames, and returns a recap.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { WebSocket } from 'ws';

const PORT = Number(process.env.SMOKE_PORT ?? 8799);
const BASE = `http://127.0.0.1:${PORT}`;
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function fail(message) {
  console.error(`✖ ${message}`);
  process.exitCode = 1;
}

async function waitForHealth(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return response.json();
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('backend did not become healthy in time');
}

const child = spawn(process.execPath, [path.join(root, 'src', 'index.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});

child.stdout.on('data', (chunk) => process.stdout.write(`  server> ${chunk}`));
child.stderr.on('data', (chunk) => process.stderr.write(`  server! ${chunk}`));

const messages = [];
const notices = [];

try {
  const health = await waitForHealth();
  console.log(
    `✓ /health ok (elevenlabsConfigured=${health.elevenlabsConfigured}, sarvamConfigured=${health.sarvamConfigured})`
  );

  // Health must never expose credential material.
  const forbidden = ['elevenlabsApiKey', 'sarvamApiKey', 'apiKey', 'key', 'token'];
  const leaked = forbidden.filter((field) => field in health);
  if (leaked.length > 0) fail(`/health exposes sensitive fields: ${leaked.join(', ')}`);
  if (typeof health.sarvamConfigured !== 'boolean') fail('sarvamConfigured must be a boolean');

  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/sessions/smoke-test/stream`);
  /** Guards the lifecycle so the echoed `listening` status cannot re-trigger it. */
  let lifecycleRan = false;

  const finished = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for recap')), 15000);

    socket.on('open', () => {
      socket.send(
        JSON.stringify({
          t: 'session.start',
          goal: {
            title: 'Smoke test',
            objective: 'Confirm the session protocol works.',
            notes: '',
            preset: 'other',
          },
          client: { platform: 'node', appVersion: '0.1.0' },
        })
      );
    });

    socket.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        fail('server sent a non-JSON frame');
        return;
      }
      messages.push(message.t);
      if (message.t === 'notice') notices.push(message);

      if (message.t === 'status' && message.status === 'listening' && !lifecycleRan) {
        lifecycleRan = true;
        socket.send(JSON.stringify({ t: 'session.pause' }));
        socket.send(JSON.stringify({ t: 'session.resume' }));

        // Malformed and unknown frames must be ignored, not fatal.
        socket.send('not json at all');
        socket.send(JSON.stringify({ t: 'audio.frame' }));
        socket.send(JSON.stringify({ t: 'unknown.message' }));
        socket.send(JSON.stringify({ t: 'audio.frame', pcm: '', seq: 1 }));

        setTimeout(() => socket.send(JSON.stringify({ t: 'session.stop' })), 150);
      }

      if (message.t === 'recap') {
        clearTimeout(timer);
        resolve(message.recap);
      }
    });

    socket.on('error', reject);
  });

  const recap = await finished;
  console.log(`✓ frames: ${messages.join(', ')}`);
  if (notices.length > 0) {
    console.log(`✓ notices: ${notices.map((notice) => `${notice.level}: ${notice.message}`).join(' | ')}`);
  }
  console.log(`✓ recap: "${recap.title}" (${recap.durationMs}ms, ${recap.cueCount} cues)`);
  console.log(`✓ recap summary: ${recap.summary}`);

  const expected = ['status', 'status', 'status', 'recap', 'status'];
  const missing = expected.filter((frame) => !messages.includes(frame));
  if (missing.length > 0) fail(`missing frames: ${missing.join(', ')}`);
  if (recap.keyPoints.length !== 0) fail('expected an empty transcript when no audio was sent');
  if (recap.cueCount !== 0) fail('expected no cues when no audio was sent');

  if (process.exitCode !== 1) console.log('✓ smoke test passed');
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  child.kill('SIGTERM');
}
