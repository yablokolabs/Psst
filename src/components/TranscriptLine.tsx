import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { Palette, Radii, Spacing } from '@/constants/theme';
import type { TranscriptEntry } from '@/types/conversation';

export interface TranscriptLineProps {
  entry: TranscriptEntry;
  animate?: boolean;
}

/** One spoken line. Partials fade while they stream in, then settle when final. */
export function TranscriptLine({ entry, animate = true }: TranscriptLineProps) {
  const isYou = entry.speaker === 'you';

  return (
    <Animated.View entering={animate ? FadeIn.duration(240) : undefined} style={styles.row}>
      <View style={[styles.speakerChip, isYou ? styles.speakerYou : styles.speakerThem]}>
        <Text style={[styles.speakerLabel, isYou ? styles.speakerLabelYou : styles.speakerLabelThem]}>
          {isYou ? 'YOU' : 'THEM'}
        </Text>
      </View>
      <Text style={[styles.text, !entry.isFinal && styles.partial]}>
        {entry.text}
        {entry.isFinal ? '' : '…'}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
  },
  speakerChip: {
    marginTop: 3,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: Radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  speakerYou: {
    backgroundColor: Palette.accentWash,
    borderColor: Palette.accent,
  },
  speakerThem: {
    backgroundColor: Palette.backgroundElement,
    borderColor: Palette.border,
  },
  speakerLabel: {
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.1,
  },
  speakerLabelYou: {
    color: Palette.accentSoft,
  },
  speakerLabelThem: {
    color: Palette.textSecondary,
  },
  text: {
    flex: 1,
    fontSize: 16,
    lineHeight: 23,
    color: Palette.text,
  },
  partial: {
    color: Palette.textSecondary,
    fontStyle: 'italic',
  },
});
