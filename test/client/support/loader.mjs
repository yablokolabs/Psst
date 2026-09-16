/**
 * Node module hooks for testing the app's real TypeScript modules offline.
 *
 *   - resolves the app's `@/…` path alias (no bundler involved)
 *   - resolves extensionless relative imports the way Metro does
 *   - stubs the two React Native modules the transport layer touches, so
 *     `realtimeConversation.ts` and `backend.ts` can run in plain Node
 *
 * Node strips the TypeScript types itself, so the code under test is the file
 * that ships — not a copy.
 */

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

const STUBS = {
  'react-native': pathToFileURL(path.join(HERE, 'react-native.stub.mjs')).href,
  'expo-constants': pathToFileURL(path.join(HERE, 'expo-constants.stub.mjs')).href,
};

const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.json'];

/** Metro-style resolution: try the exact path, then a suffix, then an index file. */
function resolveFile(basePath) {
  if (existsSync(basePath) && statSync(basePath).isFile()) return basePath;

  for (const extension of EXTENSIONS) {
    const candidate = `${basePath}${extension}`;
    if (existsSync(candidate)) return candidate;
  }
  for (const extension of EXTENSIONS) {
    const candidate = path.join(basePath, `index${extension}`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export async function resolve(specifier, context, next) {
  if (STUBS[specifier]) {
    return { url: STUBS[specifier], shortCircuit: true };
  }

  const target = specifier.startsWith('@/')
    ? path.join(REPO_ROOT, 'src', specifier.slice(2))
    : specifier.startsWith('.') && context.parentURL?.startsWith('file:')
      ? path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier)
      : null;

  if (target !== null) {
    const resolved = resolveFile(target);
    if (resolved) return { url: pathToFileURL(resolved).href, shortCircuit: true };
  }

  return next(specifier, context);
}
