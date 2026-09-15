/**
 * Server-side environment loading.
 *
 * Development keeps a single `.env` at the repository root so the mobile app and
 * the backend never need duplicated copies of the same secret. This module loads
 * that file (if it exists) before any provider module reads a key.
 *
 * Precedence is deliberate and verified: values already present in the real
 * process environment always win, so a production systemd `EnvironmentFile`
 * can never be silently overridden by a leftover development `.env`.
 *
 * Nothing here logs or returns a value: callers ask the provider modules for
 * booleans (`isElevenLabsConfigured()`, `isSarvamConfigured()`).
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** server/src/env.js -> server/ -> repository root. */
const SERVER_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = path.dirname(SERVER_ROOT);

/**
 * Ordered by precedence: a file earlier in the list wins. `server/.env` exists
 * for a standalone deployment; the repository root `.env` is the development
 * default shared with the app.
 */
const CANDIDATES = [
  process.env.PSST_ENV_FILE ?? null,
  path.join(SERVER_ROOT, '.env'),
  path.join(REPO_ROOT, '.env'),
].filter((candidate) => typeof candidate === 'string');

/** @type {string[]} */
const loadedFiles = [];
let loadAttempted = false;

function loadFile(file) {
  if (!existsSync(file)) return false;
  try {
    process.loadEnvFile(file);
    return true;
  } catch {
    // A malformed .env must not take the server down: the provider modules
    // simply report "not configured" and sessions stay silent.
    return false;
  }
}

/**
 * Loads the environment once. Safe to import from any module; repeat calls are
 * no-ops. Returns the paths that were actually read (never their contents).
 */
export function loadServerEnv() {
  if (loadAttempted) return loadedFiles;
  loadAttempted = true;

  for (const file of CANDIDATES) {
    if (loadFile(file)) loadedFiles.push(file);
  }
  return loadedFiles;
}

/** Paths loaded so far — filenames only, safe to log. */
export function getLoadedEnvFiles() {
  return loadedFiles;
}

loadServerEnv();
