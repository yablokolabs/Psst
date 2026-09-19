/**
 * The shareable form of a debrief.
 *
 * This is what leaves the app: the native share sheet, and the copy button on
 * the follow-up message. It is deliberately plain text — it has to survive
 * being pasted into WhatsApp, email or a CRM note without formatting.
 */

import { getCallType } from '@/constants/callTypes';
import type { Debrief, DebriefTask } from '@/types/debrief';
import { formatSessionDate } from '@/utils/format';
import { formatDuration } from '@/utils/importMetadata';

function bullets(items: string[]): string {
  return items.map((item) => `• ${item}`).join('\n');
}

/** "You agreed to send the deck by Friday" */
export function describeCommitment(commitment: Debrief['commitments'][number]): string {
  const owner =
    commitment.owner === 'you' ? 'You' : commitment.person !== '' ? commitment.person : 'They';
  const deadline = commitment.when.trim() === '' ? '' : ` by ${commitment.when.trim()}`;
  return `${owner}: ${commitment.what.trim()}${deadline}`;
}

export function describeTask(task: DebriefTask): string {
  const box = task.done ? '☑' : '☐';
  const due = task.dueAt ? ` (due ${formatSessionDate(task.dueAt)})` : '';
  return `${box} ${task.title}${due}`;
}

/** The full debrief as text, for the share sheet. */
export function buildDebriefText(debrief: Debrief): string {
  const callType = getCallType(debrief.callType);
  const sections: string[] = [
    `Psst debrief — ${debrief.title}`,
    [callType.label, formatSessionDate(debrief.recordedAt), formatDuration(debrief.durationMs)]
      .filter((part) => part !== '')
      .join(' · '),
  ];

  if (debrief.contact.trim() !== '') sections.push(`With: ${debrief.contact.trim()}`);

  sections.push('', 'SUMMARY', debrief.summary.trim() === '' ? '—' : debrief.summary.trim());

  if (debrief.keyDecisions.length > 0) {
    sections.push('', 'KEY DECISIONS', bullets(debrief.keyDecisions));
  }
  if (debrief.commitments.length > 0) {
    sections.push('', 'COMMITMENTS', bullets(debrief.commitments.map(describeCommitment)));
  }
  if (debrief.tasks.length > 0) {
    sections.push('', 'FOLLOW-UP', debrief.tasks.map(describeTask).join('\n'));
  }
  if (debrief.people.length > 0) {
    sections.push(
      '',
      'PEOPLE MENTIONED',
      bullets(debrief.people.map((person) => `${person.name} — ${person.context}`))
    );
  }
  if (debrief.openQuestions.length > 0) {
    sections.push('', 'OPEN QUESTIONS', bullets(debrief.openQuestions));
  }
  if (debrief.risks.length > 0) {
    sections.push('', 'RISKS', bullets(debrief.risks.map((risk) => `${risk.label}: ${risk.detail}`)));
  }
  if (debrief.reminders.length > 0) {
    sections.push('', 'REMEMBER', bullets(debrief.reminders));
  }
  if (debrief.tone.label.trim() !== '' || debrief.relationship.trim() !== '') {
    sections.push(
      '',
      'TONE AND RELATIONSHIP',
      [debrief.tone.label, debrief.tone.note].filter((part) => part.trim() !== '').join(' — '),
      debrief.relationship
    );
  }
  if (debrief.suggestedMessage.trim() !== '') {
    sections.push('', 'SUGGESTED FOLLOW-UP', debrief.suggestedMessage.trim());
  }

  if (debrief.origin === 'demo') {
    sections.push('', 'Created by Psst from a demo analysis — not a provider transcript.');
  }

  sections.push('', 'Shared from Psst — Record anywhere. Let Psst remember everything.');
  return sections.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Short one-liner used for the timeline row preview. */
export function describeDebriefPreview(debrief: Debrief): string {
  const summary = debrief.summary.trim();
  if (summary !== '') return summary;
  const task = debrief.tasks[0];
  if (task) return `Follow-up: ${task.title}`;
  return `${formatDuration(debrief.durationMs)} of audio`;
}
