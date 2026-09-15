import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { Palette } from '@/constants/theme';

const MARK_SIZES = {
  sm: 24,
  md: 32,
  lg: 56,
} as const;

const WORD_SIZES = {
  sm: 18,
  md: 24,
  lg: 44,
} as const;

export type PsstLogoSize = keyof typeof MARK_SIZES;

export interface PsstMarkProps {
  size?: PsstLogoSize;
  style?: StyleProp<ViewStyle>;
}

/** The whisper mark: a violet bubble with three dots. */
export function PsstMark({ size = 'md', style }: PsstMarkProps) {
  const dimension = MARK_SIZES[size];
  const dot = Math.max(3, Math.round(dimension * 0.12));

  return (
    <View
      style={[
        styles.mark,
        {
          width: dimension,
          height: dimension,
          borderRadius: dimension * 0.34,
        },
        style,
      ]}>
      <View style={styles.dotRow}>
        <View style={[styles.dot, { width: dot, height: dot, borderRadius: dot }]} />
        <View
          style={[
            styles.dot,
            styles.dotLead,
            { width: dot, height: dot, borderRadius: dot },
          ]}
        />
        <View style={[styles.dot, { width: dot, height: dot, borderRadius: dot }]} />
      </View>
    </View>
  );
}

export interface PsstLogoProps {
  size?: PsstLogoSize;
  /** Stack the mark above the wordmark instead of beside it. */
  stacked?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function PsstLogo({ size = 'md', stacked = false, style }: PsstLogoProps) {
  return (
    <View style={[stacked ? styles.stacked : styles.row, style]}>
      <PsstMark size={size} />
      <Text
        style={[
          styles.wordmark,
          { fontSize: WORD_SIZES[size], lineHeight: WORD_SIZES[size] * 1.2 },
        ]}>
        Psst
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  stacked: {
    alignItems: 'center',
    gap: 14,
  },
  mark: {
    backgroundColor: Palette.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dotRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  dot: {
    backgroundColor: Palette.onAccent,
    opacity: 0.75,
  },
  dotLead: {
    opacity: 1,
  },
  wordmark: {
    color: Palette.text,
    fontWeight: '700',
    letterSpacing: -1,
  },
});
