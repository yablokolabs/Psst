/**
 * MockConversationService — Phase 1 conversation engine.
 *
 * Owns every timer for the simulated conversation so no UI component has to
 * schedule anything. It replays a scripted scenario with word-by-word
 * transcript partials and only emits a PSST cue when the script says a moment
 * is genuinely worth interrupting for — the same NO_ACTION / PSST shape the
 * real reasoning engine will produce.
 *
 * Swapping this out in Phase 2 means writing a `RealtimeConversationService`
 * that implements `ConversationService` and emitting the same events.
 */

import { getScenario } from '@/services/mockScenarios';
import type {
  ConversationEvent,
  ConversationGoal,
  ConversationService,
  ConversationStatus,
  Recap,
  TranscriptEntry,
} from '@/types/conversation';

type Listener = (event: ConversationEvent) => void;

type ScheduledAction =
  | { kind: 'partial'; at: number; entry: TranscriptEntry }
  | { kind: 'line'; at: number; entry: TranscriptEntry }
  | { kind: 'cue'; at: number; observation: string; action: string; tone: 'opportunity' | 'risk' | 'question' | 'signal' };

/** How long the mock connection takes before it starts "listening". */
const CONNECT_DELAY_MS = 700;
/** Lead time between the first partial and the final transcript line. */
const PARTIAL_LEAD_MS = 900;

function splitIntoPartials(text: string): string[] {
  const words = text.split(' ');
  if (words.length < 5) return [];
  const first = Math.max(2, Math.round(words.length * 0.35));
  const second = Math.max(first + 1, Math.round(words.length * 0.7));
  return [words.slice(0, first).join(' '), words.slice(0, second).join(' ')].filter(
    (partial) => partial !== text
  );
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export class MockConversationService implements ConversationService {
  readonly kind = 'mock' as const;

  private listeners = new Set<Listener>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queue: ScheduledAction[] = [];
  private cursor = 0;
  private status: ConversationStatus = 'idle';
  private goal: ConversationGoal | null = null;
  private startedAtIso = new Date().toISOString();
  /** Milliseconds of listening accumulated before the current run. */
  private elapsedBase = 0;
  private runStartedAt: number | null = null;
  private cueCount = 0;
  private preset = 'other';

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getStatus(): ConversationStatus {
    return this.status;
  }

  start(goal: ConversationGoal): void {
    if (this.status === 'listening' || this.status === 'connecting' || this.status === 'paused') {
      this.clearTimer();
    }

    const scenario = getScenario(goal.preset);
    this.goal = goal;
    this.preset = goal.preset;
    this.startedAtIso = new Date().toISOString();
    this.elapsedBase = 0;
    this.runStartedAt = null;
    this.cueCount = 0;
    this.cursor = 0;
    this.queue = this.buildQueue(scenario);
    this.status = 'connecting';
    this.emit({ type: 'STATUS', status: 'connecting' });

    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.status !== 'connecting') return;
      this.status = 'listening';
      this.runStartedAt = Date.now();
      this.emit({ type: 'STATUS', status: 'listening' });
      this.schedule();
    }, CONNECT_DELAY_MS);
  }

  pause(): void {
    if (this.status !== 'listening') return;
    this.clearTimer();
    this.elapsedBase = this.elapsed();
    this.runStartedAt = null;
    this.status = 'paused';
    this.emit({ type: 'STATUS', status: 'paused' });
  }

  resume(): void {
    if (this.status !== 'paused') return;
    this.runStartedAt = Date.now();
    this.status = 'listening';
    this.emit({ type: 'STATUS', status: 'listening' });
    this.schedule();
  }

  async stop(): Promise<Recap> {
    this.clearTimer();
    const durationMs = this.elapsed();
    this.status = 'ended';
    this.emit({ type: 'STATUS', status: 'ended' });

    const scenario = getScenario(this.preset);
    const goal: ConversationGoal =
      this.goal ?? { title: scenario.sampleTitle, objective: scenario.sampleObjective, notes: '', preset: scenario.preset as ConversationGoal['preset'] };

    return {
      id: createId('session'),
      title: goal.title.trim() === '' ? scenario.sampleTitle : goal.title,
      preset: goal.preset,
      goal,
      startedAt: this.startedAtIso,
      endedAt: new Date().toISOString(),
      durationMs,
      summary: scenario.recap.summary,
      keyPoints: [...scenario.recap.keyPoints],
      commitments: [...scenario.recap.commitments],
      missed: [...scenario.recap.missed],
      nextActions: [...scenario.recap.nextActions],
      cueCount: this.cueCount,
    };
  }

  /** Milliseconds the session has been actively listening. */
  elapsed(): number {
    if (this.runStartedAt === null) return this.elapsedBase;
    return this.elapsedBase + (Date.now() - this.runStartedAt);
  }

  private buildQueue(scenario: ReturnType<typeof getScenario>): ScheduledAction[] {
    const actions: ScheduledAction[] = [];

    scenario.lines.forEach((line, index) => {
      const id = `${scenario.preset}-line-${index}`;
      const partials = splitIntoPartials(line.text);
      partials.forEach((text, partialIndex) => {
        const offset = PARTIAL_LEAD_MS + (partials.length - partialIndex) * 250;
        const at = Math.max(0, line.at - offset);
        actions.push({
          kind: 'partial',
          at,
          entry: { id, speaker: line.speaker, text, isFinal: false, at },
        });
      });
      actions.push({
        kind: 'line',
        at: line.at,
        entry: { id, speaker: line.speaker, text: line.text, isFinal: true, at: line.at },
      });
    });

    scenario.cues.forEach((cue) => {
      actions.push({
        kind: 'cue',
        at: cue.at,
        observation: cue.observation,
        action: cue.action,
        tone: cue.tone,
      });
    });

    return actions.sort((a, b) => a.at - b.at);
  }

  private schedule(): void {
    if (this.status !== 'listening') return;
    this.clearTimer();

    const now = this.elapsed();
    // Skip anything the queue already passed (for example while paused).
    while (this.cursor < this.queue.length && this.queue[this.cursor].at <= now) {
      this.cursor += 1;
    }

    const next = this.queue[this.cursor];
    if (!next) return;

    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.fire(next);
      },
      Math.max(20, next.at - now)
    );
  }

  private fire(action: ScheduledAction): void {
    if (this.status !== 'listening') return;
    this.cursor += 1;

    if (action.kind === 'partial') {
      this.emit({ type: 'TRANSCRIPT_PARTIAL', entry: action.entry });
    } else if (action.kind === 'line') {
      this.emit({ type: 'TRANSCRIPT_FINAL', entry: action.entry });
    } else {
      this.cueCount += 1;
      this.emit({
        type: 'PSST',
        cue: {
          id: createId('cue'),
          observation: action.observation,
          action: action.action,
          tone: action.tone,
          at: action.at,
        },
      });
    }

    this.schedule();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private emit(event: ConversationEvent): void {
    this.listeners.forEach((listener) => listener(event));
  }

  /** Releases all timers. Called when the LIVE screen unmounts. */
  dispose(): void {
    this.clearTimer();
    this.listeners.clear();
    this.status = 'idle';
  }
}
