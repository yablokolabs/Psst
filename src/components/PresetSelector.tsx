import { Pressable, StyleSheet, Text, View } from 'react-native';

import { PRESETS, getPreset } from '@/constants/presets';
import { Palette, Radii, Spacing } from '@/constants/theme';
import type { ConversationPreset } from '@/types/conversation';

export interface PresetSelectorProps {
  value: ConversationPreset;
  onChange: (preset: ConversationPreset) => void;
}

export function PresetSelector({ value, onChange }: PresetSelectorProps) {
  const selected = getPreset(value);

  return (
    <View style={styles.container}>
      <View style={styles.chips}>
        {PRESETS.map((preset) => {
          const isSelected = preset.id === value;
          return (
            <Pressable
              key={preset.id}
              onPress={() => onChange(preset.id)}
              accessibilityRole="radio"
              accessibilityState={{ selected: isSelected }}
              accessibilityLabel={preset.label}
              style={({ pressed }) => [
                styles.chip,
                isSelected && styles.chipSelected,
                pressed && styles.chipPressed,
              ]}>
              <Text style={[styles.chipLabel, isSelected && styles.chipLabelSelected]}>
                {preset.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={styles.blurb}>{selected.blurb}</Text>
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
  blurb: {
    fontSize: 13,
    color: Palette.textFaint,
  },
});
