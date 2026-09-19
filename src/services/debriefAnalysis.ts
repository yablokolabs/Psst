/**
 * Recording analysis transport.
 *
 * One call does the whole job: upload the recording to the Psst backend, read
 * back a debrief. Three outcomes, and the difference matters to the user:
 *
 *   - a real debrief from the backend;
 *   - a clearly-labelled offline demo debrief, when no backend is configured or
 *     it cannot do the work — the import still finishes, so the app is fully
 *     reviewable on a phone with no credentials;
 *   - a hard error, only when the recording itself is unusable or refused, in
 *     which case inventing a debrief would be dishonest.
 *
 * The recording is only ever uploaded after the consent gate in the import
 * screen has been acknowledged.
 */

import { File, UploadType } from 'expo-file-system';

import { isBackendConfigured, resolveDebriefUpload } from '@/services/backend';
import { createDemoDebrief, describeDemoReason } from '@/services/demoDebrief';
import { parseDebriefPayload, type DebriefPayload } from '@/services/debriefPayload';
import type { Debrief, DebriefDraft } from '@/types/debrief';

/** Upload can take minutes on a phone connection, so the ceiling is generous. */
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

export type AnalysisPhase = 'uploading' | 'analysing';

export interface AnalysisProgress {
  phase: AnalysisPhase;
  /** 0..1 while uploading, null when the size is unknown or work is opaque. */
  ratio: number | null;
}

export interface AnalysisOutcome {
  debrief: Debrief | null;
  /** Why an offline demo debrief was used, when one was. */
  notice: string | null;
  /** Why no debrief was produced. Never set together with `debrief`. */
  error: string | null;
}

export interface AnalyzeOptions {
  onProgress?: (progress: AnalysisProgress) => void;
}

function demoOutcome(draft: DebriefDraft, reason: 'unconfigured' | 'failed'): AnalysisOutcome {
  return { debrief: createDemoDebrief(draft), notice: describeDemoReason(reason), error: null };
}

/** React Native has no `AbortSignal.timeout`, so the deadline is explicit. */
function timeoutSignal(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

/** Pulls the server's own message out of an error body, without trusting it. */
function serverMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed?.error === 'string' && parsed.error.trim() !== '') return parsed.error.trim();
  } catch {
    // Not JSON: fall through to the generic message.
  }
  return null;
}

export async function analyzeRecording(
  draft: DebriefDraft,
  options: AnalyzeOptions = {}
): Promise<AnalysisOutcome> {
  const report = options.onProgress ?? (() => {});

  if (!isBackendConfigured()) {
    report({ phase: 'analysing', ratio: null });
    return demoOutcome(draft, 'unconfigured');
  }

  const target = resolveDebriefUpload({
    callType: draft.callType,
    title: draft.title,
    contact: draft.contact,
    durationMs: draft.durationMs,
  });

  // An insecure or malformed endpoint is a configuration problem, not something
  // the user can fix mid-import: fall back rather than fail.
  if ('error' in target) {
    return demoOutcome(draft, 'unconfigured');
  }

  const deadline = timeoutSignal(UPLOAD_TIMEOUT_MS);

  try {
    const file = new File(draft.audio.uri);
    const task = file.createUploadTask(target.url, {
      httpMethod: 'POST',
      uploadType: UploadType.BINARY_CONTENT,
      mimeType: draft.audio.mimeType || 'application/octet-stream',
      headers: { accept: 'application/json' },
      signal: deadline.signal,
      onProgress: ({ bytesSent, totalBytes }) => {
        report({
          phase: 'uploading',
          ratio: totalBytes > 0 ? Math.min(1, bytesSent / totalBytes) : null,
        });
      },
    });

    const response = await task.uploadAsync();
    report({ phase: 'analysing', ratio: null });

    if (response.status === 503) {
      // No provider configured: the same situation as having no backend.
      return demoOutcome(draft, 'unconfigured');
    }

    if (response.status === 400 || response.status === 413) {
      return {
        debrief: null,
        notice: null,
        error:
          serverMessage(response.body) ??
          'Psst could not analyse that recording. Check the format and length, then try again.',
      };
    }

    if (response.status < 200 || response.status >= 300) {
      return demoOutcome(draft, 'failed');
    }

    let payload: DebriefPayload;
    try {
      payload = JSON.parse(response.body) as DebriefPayload;
    } catch {
      return demoOutcome(draft, 'failed');
    }

    return { debrief: parseDebriefPayload(payload, draft), notice: null, error: null };
  } catch {
    return demoOutcome(draft, 'failed');
  } finally {
    deadline.cancel();
  }
}
