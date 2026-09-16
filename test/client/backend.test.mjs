/**
 * Transport security regression tests.
 *
 * `replace(/^http/, 'ws')` looks like it upgrades a URL, but it also quietly
 * turns a plain `http://` backend into an insecure `ws://` connection in a
 * release build. These tests pin the behaviour that replaced it: production
 * requires TLS, and a non-TLS backend is refused with an actionable message
 * rather than silently downgraded.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRealtimeSocketUrl } from '../../src/services/backend.ts';

const url = (options) => buildRealtimeSocketUrl(options);

test('https and wss backend URLs become a secure wss endpoint', () => {
  assert.deepEqual(url({ baseUrl: 'https://psst.example.com', sessionId: 'abc' }), {
    url: 'wss://psst.example.com/sessions/abc/stream',
  });
  assert.deepEqual(url({ baseUrl: 'wss://psst.example.com', sessionId: 'abc' }), {
    url: 'wss://psst.example.com/sessions/abc/stream',
  });
});

test('a backend behind a path or port keeps its path and port', () => {
  assert.deepEqual(url({ baseUrl: 'https://psst.example.com/psst', sessionId: 'abc' }), {
    url: 'wss://psst.example.com/psst/sessions/abc/stream',
  });
  assert.deepEqual(url({ baseUrl: 'https://psst.example.com:8443/', sessionId: 'abc' }), {
    url: 'wss://psst.example.com:8443/sessions/abc/stream',
  });
});

test('an insecure backend is refused in a release build', () => {
  for (const baseUrl of ['http://psst.example.com', 'ws://psst.example.com', 'http://10.0.2.2:8787']) {
    const result = url({ baseUrl, sessionId: 'abc' });
    assert.ok('error' in result, `${baseUrl} must be refused`);
    assert.match(result.error, /insecure connection|https:\/\//);
  }
});

test('an insecure backend is allowed only in a development build', () => {
  assert.deepEqual(
    url({ baseUrl: 'http://192.168.1.20:8787', sessionId: 'abc', development: true }),
    { url: 'ws://192.168.1.20:8787/sessions/abc/stream' }
  );
  assert.deepEqual(
    url({ baseUrl: 'ws://192.168.1.20:8787', sessionId: 'abc', development: true }),
    { url: 'ws://192.168.1.20:8787/sessions/abc/stream' }
  );
  // `development: undefined` is a release build, not a development one.
  assert.ok('error' in url({ baseUrl: 'http://192.168.1.20:8787', sessionId: 'abc' }));
});

test('the shared token is appended when one is configured', () => {
  assert.deepEqual(
    url({ baseUrl: 'https://psst.example.com', sessionId: 'abc', token: 'shared-token' }),
    { url: 'wss://psst.example.com/sessions/abc/stream?token=shared-token' }
  );
  assert.deepEqual(url({ baseUrl: 'https://psst.example.com', sessionId: 'abc', token: '' }), {
    url: 'wss://psst.example.com/sessions/abc/stream',
  });
});

test('session ids are URL-encoded and unusable base URLs are rejected', () => {
  assert.deepEqual(url({ baseUrl: 'https://psst.example.com', sessionId: 'a/b c' }), {
    url: 'wss://psst.example.com/sessions/a%2Fb%20c/stream',
  });

  for (const baseUrl of ['', '   ', 'psst.example.com', 'ftp://psst.example.com', 'https://h?x=1', 'javascript:alert(1)']) {
    const result = url({ baseUrl, sessionId: 'abc' });
    assert.ok('error' in result, `${JSON.stringify(baseUrl)} must be rejected`);
  }
});
