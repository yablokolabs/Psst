/**
 * Seed data for the Home screen history demo.
 *
 * Each seed recap is derived from a mock scenario so the copy stays consistent
 * with what a live session produces. Phase 2 replaces this with recaps returned
 * by the backend; nothing is persisted yet.
 */

import { getScenario } from '@/services/mockScenarios';
import type { ConversationPreset, Recap } from '@/types/conversation';

interface SeedDefinition {
  preset: ConversationPreset;
  daysAgo: number;
  hour: number;
  minute: number;
  title: string;
}

const SEEDS: SeedDefinition[] = [
  { preset: 'sales', daysAgo: 0, hour: 14, minute: 20, title: 'Sales call with Acme' },
  { preset: 'negotiation', daysAgo: 1, hour: 9, minute: 45, title: 'Salary negotiation' },
  { preset: 'customer', daysAgo: 3, hour: 16, minute: 5, title: 'Customer renewal discussion' },
];

function buildSeed(seed: SeedDefinition, now: Date, index: number): Recap {
  const scenario = getScenario(seed.preset);
  const startedAt = new Date(now);
  startedAt.setDate(startedAt.getDate() - seed.daysAgo);
  startedAt.setHours(seed.hour, seed.minute, 0, 0);

  const endedAt = new Date(startedAt.getTime() + scenario.durationMs);

  return {
    id: `seed-${seed.preset}-${index}`,
    title: seed.title,
    preset: seed.preset,
    goal: {
      title: seed.title,
      objective: scenario.sampleObjective,
      notes: '',
      preset: seed.preset,
    },
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: scenario.durationMs,
    summary: scenario.recap.summary,
    keyPoints: [...scenario.recap.keyPoints],
    commitments: [...scenario.recap.commitments],
    missed: [...scenario.recap.missed],
    nextActions: [...scenario.recap.nextActions],
    cueCount: scenario.cues.length,
  };
}

/** Newest first. */
export function createSeedHistory(now: Date = new Date()): Recap[] {
  return SEEDS.map((seed, index) => buildSeed(seed, now, index)).sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );
}
