/**
 * Conversation service factory.
 *
 * The LIVE screen only ever talks to a `ConversationService`. Two engines
 * implement it and are interchangeable:
 *
 *   mock     - scripted scenarios on timers. No microphone, no network. Kept
 *              deliberately: it is the screenshot/backup mode, it works during a
 *              provider outage and it needs no permissions.
 *   realtime - real microphone audio streamed to the Psst backend, which owns
 *              ElevenLabs STT and Sarvam reasoning.
 *
 * Realtime never silently falls back to mock. If the backend or a provider
 * fails, the LIVE screen shows the failure and offers a retry or an explicit
 * switch to the demo engine.
 */

import { isBackendConfigured } from '@/services/backend';
import { MockConversationService } from '@/services/mockConversation';
import { RealtimeConversationService } from '@/services/realtimeConversation';
import type { ConversationService } from '@/types/conversation';

export type ConversationMode = 'mock' | 'realtime';

/** Lets a build pin the engine: `mock`/`demo` or `realtime`/`live`. */
export const PSST_MODE_ENV = (process.env.EXPO_PUBLIC_PSST_MODE ?? '').trim().toLowerCase();

function resolveDefaultMode(): ConversationMode {
  if (PSST_MODE_ENV === 'mock' || PSST_MODE_ENV === 'demo') return 'mock';
  if (PSST_MODE_ENV === 'realtime' || PSST_MODE_ENV === 'live') return 'realtime';

  // No explicit pin: a configured backend means the app can genuinely stream
  // audio, which is the point of Psst. Without one, the honest default is the
  // offline demo rather than a permanently broken live session.
  return isBackendConfigured() ? 'realtime' : 'mock';
}

export const DEFAULT_CONVERSATION_MODE: ConversationMode = resolveDefaultMode();

/** Short label for the LIVE screen so the running engine is never ambiguous. */
export function describeMode(mode: ConversationMode): string {
  return mode === 'realtime' ? 'REALTIME AUDIO' : 'SIMULATED AUDIO';
}

/** True when realtime mode can actually capture and stream audio. */
export function isRealtimeAvailable(): boolean {
  return isBackendConfigured();
}

export function createConversationService(
  mode: ConversationMode = DEFAULT_CONVERSATION_MODE
): ConversationService {
  return mode === 'realtime' ? new RealtimeConversationService() : new MockConversationService();
}

export type {
  ConversationEvent,
  ConversationGoal,
  ConversationService,
  ConversationStatus,
  PsstCue,
  Recap,
  TranscriptEntry,
} from '@/types/conversation';

export type { ClientMessage, ServerMessage } from '@/types/realtime';
