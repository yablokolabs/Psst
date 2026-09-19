/**
 * The debrief timeline store.
 *
 * A memory product has to survive a restart, so debriefs live in SQLite rather
 * than in React state. The imported recordings themselves are copied into the
 * app's own document directory, never left pointing at a picker cache or another
 * app's folder: the permission to read that copy can expire, and the user is
 * promised the source audio is theirs and deletable.
 */

import { Directory, File, Paths } from 'expo-file-system';
import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import { createSeedDebriefs } from '@/services/demoDebrief';
import {
  DEBRIEF_SCHEMA,
  DEBRIEF_SEARCH_SQL,
  buildSearchParams,
  fromDebriefRow,
  toDebriefRow,
  type DebriefRow,
} from '@/services/debriefRows';
import type { Debrief, DebriefAudio } from '@/types/debrief';
import { mimeTypeForExtension } from '@/utils/importMetadata';

const DATABASE_NAME = 'psst.db';
const RECORDINGS_FOLDER = 'recordings';

let databasePromise: Promise<SQLiteDatabase> | null = null;

function getDatabase(): Promise<SQLiteDatabase> {
  if (!databasePromise) {
    databasePromise = openDatabaseAsync(DATABASE_NAME).then(async (database) => {
      await database.execAsync('PRAGMA journal_mode = WAL;');
      await database.execAsync(DEBRIEF_SCHEMA);
      return database;
    });
  }
  return databasePromise;
}

/** Newest call first — the timeline order the user expects. */
export async function listDebriefs(): Promise<Debrief[]> {
  const database = await getDatabase();
  const rows = await database.getAllAsync<DebriefRow>(
    'SELECT * FROM debriefs ORDER BY recorded_at DESC'
  );
  return rows.map(fromDebriefRow).filter((debrief): debrief is Debrief => debrief !== null);
}

export async function searchDebriefs(term: string): Promise<Debrief[]> {
  const trimmed = term.trim();
  if (trimmed === '') return listDebriefs();

  const database = await getDatabase();
  const rows = await database.getAllAsync<DebriefRow>(DEBRIEF_SEARCH_SQL, buildSearchParams(trimmed));
  return rows.map(fromDebriefRow).filter((debrief): debrief is Debrief => debrief !== null);
}

export async function getDebrief(id: string): Promise<Debrief | null> {
  const database = await getDatabase();
  const row = await database.getFirstAsync<DebriefRow>('SELECT * FROM debriefs WHERE id = ?', id);
  return fromDebriefRow(row);
}

/** Insert or replace. The whole debrief is rewritten, which is what editing does. */
export async function saveDebrief(debrief: Debrief): Promise<void> {
  const database = await getDatabase();
  const row = toDebriefRow(debrief);
  await database.runAsync(
    `INSERT INTO debriefs (id, recorded_at, imported_at, title, contact, call_type, summary, origin, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       recorded_at = excluded.recorded_at,
       imported_at = excluded.imported_at,
       title = excluded.title,
       contact = excluded.contact,
       call_type = excluded.call_type,
       summary = excluded.summary,
       origin = excluded.origin,
       payload = excluded.payload`,
    row.id,
    row.recorded_at,
    row.imported_at,
    row.title,
    row.contact,
    row.call_type,
    row.summary,
    row.origin,
    row.payload
  );
}

export async function deleteDebrief(id: string): Promise<void> {
  const database = await getDatabase();
  await database.runAsync('DELETE FROM debriefs WHERE id = ?', id);
}

export async function deleteAllDebriefs(): Promise<void> {
  const database = await getDatabase();
  await database.runAsync('DELETE FROM debriefs');
}

/**
 * Puts the three worked examples in an empty timeline.
 *
 * Only ever runs when the table is empty, so deleting them is permanent — the
 * user's choice to clear the timeline is respected.
 */
export async function seedDebriefsIfEmpty(): Promise<void> {
  const database = await getDatabase();
  const existing = await database.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) as count FROM debriefs'
  );
  if ((existing?.count ?? 0) > 0) return;

  for (const debrief of createSeedDebriefs()) {
    await saveDebrief(debrief);
  }
}

/* ── Source audio ─────────────────────────────────────────────────────────── */

function recordingsDirectory(): Directory {
  return new Directory(Paths.document, RECORDINGS_FOLDER);
}

/** Strips anything that could escape the recordings folder. */
function safeFileName(fileName: string, fallbackExtension: string): string {
  const base = (fileName || 'recording')
    .replace(/[\\/]+/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(-80);
  const clean = base.trim() === '' ? 'recording' : base;
  return /\.[a-z0-9]+$/i.test(clean) ? clean : `${clean}${fallbackExtension}`;
}

/**
 * Copies a picked recording into app storage so it survives the picker's cache
 * being cleared, and returns the metadata the debrief keeps.
 */
export function storeRecording(sourceUri: string, fileName: string): DebriefAudio {
  const directory = recordingsDirectory();
  directory.create({ intermediates: true, idempotent: true });

  const source = new File(sourceUri);
  const extension = /\.[a-z0-9]+$/i.exec(fileName ?? '')?.[0]?.toLowerCase() ?? '.m4a';
  const destination = new File(directory, `${Date.now().toString(36)}-${safeFileName(fileName, extension)}`);

  source.copySync(destination);

  return {
    uri: destination.uri,
    fileName: fileName || destination.name,
    bytes: destination.size ?? source.size ?? 0,
    mimeType: mimeTypeForExtension(extension.replace('.', '')),
  };
}

/** Deletes a stored recording. Missing files are not an error. */
export function deleteRecording(uri: string): void {
  if (!uri) return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // The file is already gone, or the URI was never ours. Either way the
    // debrief no longer claims to hold it.
  }
}
