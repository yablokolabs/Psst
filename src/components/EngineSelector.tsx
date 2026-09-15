import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Palette, Radii, Spacing } from '@/constants/theme';
import { isRealtimeAvailable, type ConversationMode } from '@/services/conversation';

export interface EngineSelectorProps {
  value: ConversationMode;
  onChange: (mode: ConversationMode) => void;
}

const OPTIONS: { mode: ConversationMode; label: string }[] = [
  { mode: 'realtime', label: 'Live audio' },
  { mode: 'mock', label: 'Demo' },
];

const BLURBS: Record<ConversationMode, string> = {
  realtime: 'Uses the microphone. Psst transcribes what is actually said and suggests in real time.',
  mock: 'Plays a scripted sample conversation. No microphone, works offline and during provider outages.',
};

/**
 * Lets the user pick the engine before a session starts, so realtime is an
 * explicit choice and the demo engine is available on purpose rather than by
 * silent fallback.
 */
export function EngineSelector({ value, onChange }: EngineSelectorProps) {
  const realtimeAvailable = isRealtimeAvailable();

  return (
    <View style={styles.container}>
      <View style={styles.chips}>
        {OPTIONS.map((option) => {
          const isSelected = option.mode === value;
          const isDisabled = option.mode === 'realtime' && !realtimeAvailable;

          return (
            <Pressable
              key={option.mode}
              onPress={() => onChange(option.mode)}
              disabled={isDisabled}
              accessibilityRole="radio"
              accessibilityState={{ selected: isSelected, disabled: isDisabled }}
              accessibilityLabel={option.label}
              style={({ pressed }) => [
                styles.chip,
                isSelected && styles.chipSelected,
                isDisabled && styles.chipDisabled,
                pressed && !isDisabled && styles.chipPressed,
              ]}>
              <Text
                style={[
                  styles.chipLabel,
                  isSelected && styles.chipLabelSelected,
                  isDisabled && styles.chipLabelDisabled,
                ]}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Text style={styles.blurb}>
        {realtimeAvailable
          ? BLURBS[value]
          : 'Live audio is unavailable in this build: no Psst backend is configured, so there is nothing to stream audio to. The demo engine still works.'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: Spacing.two,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: Radii.pill,
    backgroundColor: Palette.backgroundElement,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.border,
  },
  chipSelected: {
    backgroundColor: Palette.accentWash,
    borderColor: Palette.accent,
  },
  chipDisabled: {
    opacity: 0.45,
  },
  chipPressed: {
    opacity: 0.75,
  },
  chipLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: Palette.textSecondary,
  },
  chipLabelSelected: {
    color: Palette.accentSoft,
  },
  chipLabelDisabled: {
    color: Palette.textFaint,
  },
  blurb: {
    fontSize: 13,
    lineHeight: 19,
    color: Palette.textFaint,
  },
});
