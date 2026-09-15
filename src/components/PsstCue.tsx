import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { Palette, Radii, Spacing } from '@/constants/theme';
import type { CueTone, PsstCue } from '@/types/conversation';

const TONES: Record<CueTone, { label: string; color: string }> = {
  opportunity: { label: 'Opportunity', color: Palette.success },
  risk: { label: 'Watch out', color: Palette.warning },
  question: { label: 'Ask this', color: Palette.accentSoft },
  signal: { label: 'Signal', color: Palette.live },
};

export interface PsstCueCardProps {
  cue: PsstCue;
  /** Set false when rendering a static list (recap, previews). */
  animate?: boolean;
}

/**
 * A cue is deliberately short: one observation, one action. It is visually
 * distinct from the transcript (accent wash, accent bar, larger type) so it can
 * be read at a glance without leaving the real conversation.
 */
export function PsstCueCard({ cue, animate = true }: PsstCueCardProps) {
  const tone = TONES[cue.tone] ?? TONES.signal;

  return (
    <Animated.View
      entering={animate ? FadeInDown.duration(320) : undefined}
      style={[styles.card, { borderLeftColor: tone.color }]}>
      <View style={styles.header}>
        <Text style={styles.eyebrow}>Psst...</Text>
        <View style={[styles.pill, { borderColor: tone.color }]}>
          <Text style={[styles.pillLabel, { color: tone.color }]}>{tone.label.toUpperCase()}</Text>
        </View>
      </View>

      <Text style={styles.observation}>{cue.observation}</Text>

      <View style={styles.actionRow}>
        <Text style={[styles.arrow, { color: tone.color }]}>→</Text>
        <Text style={styles.action}>{cue.action}</Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Palette.accentWash,
    borderRadius: Radii.lg,
    borderLeftWidth: 3,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
    gap: Spacing.two,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  eyebrow: {
    fontSize: 15,
    fontWeight: '700',
    color: Palette.accentSoft,
    letterSpacing: 0.2,
  },
  pill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: Radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  pillLabel: {
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.2,
  },
  observation: {
    fontSize: 20,
    lineHeight: 26,
    fontWeight: '600',
    color: Palette.text,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
  },
  arrow: {
    fontSize: 16,
    lineHeight: 22,
    fontWeight: '700',
  },
  action: {
    flex: 1,
    fontSize: 16,
    lineHeight: 22,
    color: Palette.textSecondary,
  },
});
