import { Pressable, StyleSheet, Text, View } from 'react-native';

import { getCallType } from '@/constants/callTypes';
import { Palette, Radii, Spacing } from '@/constants/theme';
import type { Debrief } from '@/types/debrief';
import { describeDebriefPreview } from '@/utils/debriefText';
import { formatSessionDate } from '@/utils/format';
import { formatDuration } from '@/utils/importMetadata';

export interface DebriefRowProps {
  debrief: Debrief;
  onPress: () => void;
}

export function DebriefRow({ debrief, onPress }: DebriefRowProps) {
  const callType = getCallType(debrief.callType);
  const openTasks = debrief.tasks.filter((task) => !task.done).length;
  const meta = [
    formatSessionDate(debrief.recordedAt),
    debrief.durationMs > 0 ? formatDuration(debrief.durationMs) : '',
  ]
    .filter((part) => part !== '')
    .join(' · ');

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Open debrief: ${debrief.title}`}
      testID={`debrief-row-${debrief.id}`}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      <View style={styles.headerRow}>
        <Text style={styles.title} numberOfLines={1}>
          {debrief.title}
        </Text>
        {debrief.origin === 'demo' ? (
          <View style={styles.demoBadge}>
            <Text style={styles.demoBadgeLabel}>DEMO</Text>
          </View>
        ) : null}
      </View>

      <Text style={styles.meta} numberOfLines={1}>
        {callType.label}
        {debrief.contact.trim() !== '' ? ` · ${debrief.contact.trim()}` : ''}
        {meta !== '' ? ` · ${meta}` : ''}
      </Text>

      <Text style={styles.preview} numberOfLines={2}>
        {describeDebriefPreview(debrief)}
      </Text>

      {openTasks > 0 ? (
        <Text style={styles.tasks}>
          {openTasks} {openTasks === 1 ? 'follow-up' : 'follow-ups'} open
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    backgroundColor: Palette.backgroundElement,
    borderRadius: Radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.border,
    padding: Spacing.three,
    gap: Spacing.one,
  },
  pressed: {
    opacity: 0.85,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  title: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    color: Palette.text,
  },
  demoBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: Radii.pill,
    backgroundColor: Palette.accentWash,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.borderStrong,
  },
  demoBadgeLabel: {
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1,
    color: Palette.accentSoft,
  },
  meta: {
    fontSize: 12,
    color: Palette.textFaint,
  },
  preview: {
    fontSize: 14,
    lineHeight: 20,
    color: Palette.textSecondary,
  },
  tasks: {
    fontSize: 12,
    fontWeight: '600',
    color: Palette.accentSoft,
  },
});
