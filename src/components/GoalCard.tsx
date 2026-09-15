import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { Palette, Radii, Spacing } from '@/constants/theme';
import { getPreset } from '@/constants/presets';
import type { ConversationGoal } from '@/types/conversation';

export interface GoalCardProps {
  goal: ConversationGoal;
  /** Hide the objective to keep the LIVE header compact. */
  showObjective?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function GoalCard({ goal, showObjective = true, style }: GoalCardProps) {
  const preset = getPreset(goal.preset);
  const objective = goal.objective.trim();

  return (
    <View style={[styles.card, style]}>
      <View style={styles.headerRow}>
        <Text style={styles.eyebrow}>GOAL</Text>
        <View style={styles.presetChip}>
          <Text style={styles.presetLabel}>{preset.label.toUpperCase()}</Text>
        </View>
      </View>

      <Text style={styles.title} numberOfLines={2}>
        {goal.title.trim() === '' ? preset.titlePlaceholder : goal.title}
      </Text>

      {showObjective ? (
        <Text style={styles.objective} numberOfLines={3}>
          {objective === '' ? 'No objective set. Psst will follow the conversation.' : objective}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Palette.backgroundElement,
    borderRadius: Radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.border,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  eyebrow: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.4,
    color: Palette.textFaint,
  },
  presetChip: {
    backgroundColor: Palette.backgroundSelected,
    borderRadius: Radii.pill,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  presetLabel: {
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.1,
    color: Palette.textSecondary,
  },
  title: {
    fontSize: 18,
    lineHeight: 24,
    fontWeight: '600',
    color: Palette.text,
  },
  objective: {
    fontSize: 14,
    lineHeight: 20,
    color: Palette.textSecondary,
  },
});
