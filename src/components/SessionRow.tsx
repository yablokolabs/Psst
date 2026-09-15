import { Pressable, StyleSheet, Text, View } from 'react-native';

import { getPreset } from '@/constants/presets';
import { Palette, Radii, Spacing } from '@/constants/theme';
import type { Recap } from '@/types/conversation';
import { formatDurationWords, formatSessionDate } from '@/utils/format';

export interface SessionRowProps {
  session: Recap;
  onPress: () => void;
}

export function SessionRow({ session, onPress }: SessionRowProps) {
  const preset = getPreset(session.preset);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Open recap: ${session.title}`}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      <View style={styles.main}>
        <Text style={styles.title} numberOfLines={1}>
          {session.title}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {preset.label} · {formatDurationWords(session.durationMs)} ·{' '}
          {formatSessionDate(session.startedAt)}
        </Text>
        <Text style={styles.summary} numberOfLines={2}>
          {session.summary}
        </Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    backgroundColor: Palette.backgroundElement,
    borderRadius: Radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.border,
    padding: Spacing.three,
  },
  pressed: {
    opacity: 0.8,
  },
  main: {
    flex: 1,
    gap: 3,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    color: Palette.text,
  },
  meta: {
    fontSize: 12,
    color: Palette.textFaint,
  },
  summary: {
    fontSize: 13,
    lineHeight: 18,
    color: Palette.textSecondary,
  },
  chevron: {
    fontSize: 22,
    color: Palette.textFaint,
  },
});
