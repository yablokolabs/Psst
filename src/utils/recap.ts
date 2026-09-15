import { getPreset } from '@/constants/presets';
import type { Recap } from '@/types/conversation';
import { formatDurationWords, formatSessionDate } from '@/utils/format';

function bullets(items: string[]): string {
  return items.map((item) => `• ${item}`).join('\n');
}

function numbered(items: string[]): string {
  return items.map((item, index) => `${index + 1}. ${item}`).join('\n');
}

/** Plain-text recap used by the native share sheet. */
export function buildRecapText(recap: Recap): string {
  const preset = getPreset(recap.preset);
  const sections: string[] = [
    `Psst recap — ${recap.title}`,
    `${preset.label} · ${formatSessionDate(recap.startedAt)} · ${formatDurationWords(recap.durationMs)}`,
    '',
    'SUMMARY',
    recap.summary,
  ];

  if (recap.keyPoints.length > 0) {
    sections.push('', 'KEY POINTS', bullets(recap.keyPoints));
  }
  if (recap.commitments.length > 0) {
    sections.push('', 'COMMITMENTS', bullets(recap.commitments));
  }
  if (recap.missed.length > 0) {
    sections.push('', 'THINGS YOU MAY HAVE MISSED', bullets(recap.missed));
  }
  if (recap.nextActions.length > 0) {
    sections.push('', 'NEXT ACTIONS', numbered(recap.nextActions));
  }

  sections.push('', 'Shared from Psst — Know what to say next.');
  return sections.join('\n');
}
