/**
 * Calendar reminders for follow-up tasks.
 *
 * The point of the "mom reminder" idea is that it lands somewhere the user will
 * actually see it, and that is the phone's own calendar rather than another list
 * inside Psst. Every failure here is a normal outcome with a sentence attached:
 * permission denied, a read-only device calendar, no calendar at all.
 */

import { getCalendars, requestCalendarPermissions } from 'expo-calendar';

/** Where a reminder lands when the task has no date of its own. */
const DEFAULT_HOUR = 9;
const DEFAULT_MINUTES = 30;

export interface ReminderResult {
  ok: boolean;
  eventId?: string;
  /** User-facing explanation. Never provider detail. */
  error?: string;
}

/** 9:00 tomorrow, local time — the first sensible moment to be reminded. */
export function defaultReminderDate(now: Date = new Date()): Date {
  const date = new Date(now);
  date.setDate(date.getDate() + 1);
  date.setHours(DEFAULT_HOUR, 0, 0, 0);
  return date;
}

function resolveStart(dueAt: string | null, now: Date): Date {
  if (!dueAt) return defaultReminderDate(now);
  const date = new Date(dueAt);
  if (Number.isNaN(date.getTime())) return defaultReminderDate(now);
  // A date in the past cannot be reminded about; roll it forward.
  return date.getTime() < now.getTime() ? defaultReminderDate(now) : date;
}

/**
 * Creates one calendar event.
 *
 * @param task the follow-up the reminder is for
 * @param context the debrief it came from, so the event explains itself
 */
export async function createTaskReminder(
  task: { title: string; dueAt: string | null },
  context: { debriefTitle: string; contact?: string }
): Promise<ReminderResult> {
  try {
    const permission = await requestCalendarPermissions();
    if (!permission.granted) {
      return {
        ok: false,
        error: 'Psst needs calendar access to add a reminder. You can still keep the follow-up here.',
      };
    }

    const calendars = await getCalendars();
    const writable =
      calendars.find((calendar) => calendar.allowsModifications && calendar.isPrimary) ??
      calendars.find((calendar) => calendar.allowsModifications);

    if (!writable) {
      return { ok: false, error: 'This device has no calendar Psst can write to.' };
    }

    const start = resolveStart(task.dueAt, new Date());
    const end = new Date(start.getTime() + DEFAULT_MINUTES * 60 * 1000);

    const notes = [
      `Follow-up from: ${context.debriefTitle}`,
      context.contact ? `With: ${context.contact}` : '',
      'Created by Psst.',
    ]
      .filter((line) => line !== '')
      .join('\n');

    const event = await writable.createEvent({
      title: task.title,
      notes,
      startDate: start,
      endDate: end,
      alarms: [{ relativeOffset: 0 }],
    });

    return { ok: true, eventId: event.id };
  } catch (error) {
    const detail = error instanceof Error ? error.message : '';
    // A permission-shaped failure is the common one and deserves plain words.
    if (/permission|denied/i.test(detail)) {
      return { ok: false, error: 'Calendar access was denied, so Psst could not add the reminder.' };
    }
    return { ok: false, error: 'Psst could not add that reminder to your calendar.' };
  }
}
