import { Pressable, StyleSheet, Text, View } from 'react-native';

import { CALL_TYPES, getCallType } from '@/constants/callTypes';
import { Palette, Radii, Spacing } from '@/constants/theme';
import type { CallType } from '@/types/debrief';

export interface CallTypeSelectorProps {
  value: CallType;
  onChange: (next: CallType) => void;
}

export function CallTypeSelector({ value, onChange }: CallTypeSelectorProps) {
  const selected = getCallType(value);

  return (
    <View style={styles.container}>
      <Text style={styles.label}>WHAT KIND OF CALL</Text>

      <View style={styles.pills}>
        {CALL_TYPES.map((callType) => {
          const active = callType.id === value;
          return (
            <Pressable
              key={callType.id}
              onPress={() => onChange(callType.id)}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              accessibilityLabel={callType.label}
              testID={`call-type-${callType.id}`}
              style={({ pressed }) => [
                styles.pill,
                active && styles.pillActive,
                pressed && styles.pressed,
              ]}>
              <Text style={[styles.pillLabel, active && styles.pillLabelActive]}>{callType.label}</Text>
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
  label: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.4,
    color: Palette.textFaint,
  },
  pills: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  pill: {
    paddingHorizontal: Spacing.three,
    paddingVertical: 10,
    borderRadius: Radii.pill,
    backgroundColor: Palette.backgroundElement,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.border,
  },
  pillActive: {
    backgroundColor: Palette.backgroundSelected,
    borderColor: Palette.accent,
  },
  pressed: {
    opacity: 0.85,
  },
  pillLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: Palette.textSecondary,
  },
  pillLabelActive: {
    color: Palette.text,
  },
  blurb: {
    fontSize: 12,
    color: Palette.textFaint,
  },
});
