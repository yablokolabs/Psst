import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Checkbox } from '@/components/Checkbox';
import { Palette, Radii, Spacing } from '@/constants/theme';
import type { DebriefTask } from '@/types/debrief';
import { formatSessionDate } from '@/utils/format';

export interface TaskRowProps {
  task: DebriefTask;
  onToggle: (done: boolean) => void;
  /** Absent when the device has no writable calendar. */
  onAddReminder?: () => void;
  reminderBusy?: boolean;
  /** Set when a reminder already exists for this task. */
  reminderAdded?: boolean;
  onRemove: () => void;
}

export function TaskRow({
  task,
  onToggle,
  onAddReminder,
  reminderBusy = false,
  reminderAdded = false,
  onRemove,
}: TaskRowProps) {
  const due = task.dueAt ? formatSessionDate(task.dueAt) : '';

  return (
    <View style={styles.row}>
      <View style={styles.checkbox}>
        <Checkbox
          checked={task.done}
          onToggle={onToggle}
          label={task.title}
          testID={`task-${task.id}`}
        />
      </View>

      {due !== '' ? <Text style={styles.due}>{due}</Text> : null}

      <View style={styles.actions}>
        {onAddReminder && !reminderAdded ? (
          <Pressable
            onPress={onAddReminder}
            disabled={reminderBusy}
            accessibilityRole="button"
            accessibilityLabel={`Add a calendar reminder for ${task.title}`}
            style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
            <Text style={styles.actionLabel}>{reminderBusy ? 'Adding…' : 'Remind me'}</Text>
          </Pressable>
        ) : null}

        {reminderAdded ? <Text style={styles.added}>Reminder set</Text> : null}

        <Pressable
          onPress={onRemove}
          accessibilityRole="button"
          accessibilityLabel={`Remove ${task.title}`}
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
          <Text style={styles.removeLabel}>Remove</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    gap: Spacing.one,
  },
  checkbox: {
    flex: 1,
  },
  due: {
    fontSize: 12,
    color: Palette.textFaint,
    marginLeft: 36,
    marginTop: -Spacing.two,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    marginLeft: 36,
  },
  action: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: Radii.pill,
    backgroundColor: Palette.backgroundSelected,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.borderStrong,
  },
  pressed: {
    opacity: 0.8,
  },
  actionLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: Palette.accentSoft,
  },
  removeLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: Palette.textFaint,
  },
  added: {
    fontSize: 12,
    fontWeight: '600',
    color: Palette.success,
  },
});
