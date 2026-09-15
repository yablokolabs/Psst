import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { Fonts, Palette } from '@/constants/theme';
import { formatClock } from '@/utils/format';

export interface SessionTimerProps {
  elapsedMs: number;
  /** Optional trailing note, e.g. "of 10:00 free". */
  note?: string;
  style?: StyleProp<ViewStyle>;
}

export function SessionTimer({ elapsedMs, note, style }: SessionTimerProps) {
  return (
    <View style={[styles.container, style]}>
      <Text style={styles.value} accessibilityLabel={`Session time ${formatClock(elapsedMs)}`}>
        {formatClock(elapsedMs)}
      </Text>
      {note ? <Text style={styles.note}>{note}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'flex-end',
  },
  value: {
    fontFamily: Fonts.mono,
    fontSize: 18,
    fontWeight: '700',
    color: Palette.text,
    fontVariant: ['tabular-nums'],
  },
  note: {
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.4,
    color: Palette.textFaint,
  },
});
