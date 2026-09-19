/**
 * Transport security regression tests for the analysis endpoint.
 *
 * A recording is private audio and the backend holds provider credentials, so a
 * release build must refuse to POST it in the clear. These tests pin that: an
 * `https` backend becomes an `https` upload, a plain `http` one is refused rather
 * than silently downgraded, and metadata travels in the query string so the body
 * stays the audio itself.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDebriefEndpoint } from '../../src/services/backend.ts';

const draft = {
  callType: 'sales',
  title: 'Acme pilot call',
  contact: 'Priya Raman',
  durationMs: 60000,
};

const build = (options) => buildDebriefEndpoint({ ...draft, ...options });

test('an https backend becomes an https upload with the metadata in the query', () => {
  const result = build({ baseUrl: 'https://psst.example.com' });
  assert.ok('url' in result);

  const url = new URL(result.url);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.pathname, '/debrief');
  assert.equal(url.searchParams.get('callType'), 'sales');
  assert.equal(url.searchParams.get('title'), 'Acme pilot call');
  assert.equal(url.searchParams.get('contact'), 'Priya Raman');
  assert.equal(url.searchParams.get('durationMs'), '60000');
});

test('a backend behind a path or port keeps its path and port', () => {
  const withPath = build({ baseUrl: 'https://psst.example.com/psst' });
  assert.ok('url' in withPath);
  assert.equal(new URL(withPath.url).pathname, '/psst/debrief');

  const withPort = build({ baseUrl: 'https://psst.example.com:8443/' });
  assert.ok('url' in withPort);
  assert.equal(new URL(withPort.url).port, '8443');
});

test('an insecure backend is refused in a release build', () => {
  for (const baseUrl of ['http://psst.example.com', 'ws://psst.example.com', 'http://10.0.2.2:8787']) {
    const result = build({ baseUrl });
    assert.ok('error' in result, `${baseUrl} must be refused`);
    assert.match(result.error, /insecure connection|https:\/\//);
  }
});

test('an insecure backend is allowed only in a development build', () => {
  const development = build({ baseUrl: 'http://192.168.1.20:8787', development: true });
  assert.ok('url' in development);
  assert.equal(new URL(development.url).protocol, 'http:');

  // `development: undefined` is a release build, not a development one.
  assert.ok('error' in build({ baseUrl: 'http://192.168.1.20:8787' }));
});

test('the shared token is appended when one is configured', () => {
  const withToken = build({ baseUrl: 'https://psst.example.com', token: 'shared-token' });
  assert.ok('url' in withToken);
  assert.equal(new URL(withToken.url).searchParams.get('token'), 'shared-token');

  const withoutToken = build({ baseUrl: 'https://psst.example.com', token: '' });
  assert.ok('url' in withoutToken);
  assert.equal(new URL(withoutToken.url).searchParams.has('token'), false);
});

test('an empty or unusable base URL is rejected with an actionable message', () => {
  for (const baseUrl of ['', '   ', 'psst.example.com', 'ftp://psst.example.com', 'https://h?x=1', 'javascript:alert(1)']) {
    const result = build({ baseUrl });
    assert.ok('error' in result, `${JSON.stringify(baseUrl)} must be rejected`);
    assert.ok(result.error.length > 0);
  }
});

test('metadata that needs escaping survives the query string intact', () => {
  const result = build({
    baseUrl: 'https://psst.example.com',
    title: 'Call with * + & = ?',
    contact: 'Ana Müller',
    durationMs: 0,
  });
  assert.ok('url' in result);

  const url = new URL(result.url);
  assert.equal(url.searchParams.get('title'), 'Call with * + & = ?');
  assert.equal(url.searchParams.get('contact'), 'Ana Müller');
  assert.equal(url.searchParams.get('durationMs'), '0');
});
