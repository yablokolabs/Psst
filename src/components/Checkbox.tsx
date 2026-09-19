import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Palette, Radii, Spacing, TouchTarget } from '@/constants/theme';

export interface CheckboxProps {
  checked: boolean;
  onToggle: (next: boolean) => void;
  /** The main line of the row. */
  label: string;
  /** Optional second line, for the consent explanation. */
  description?: string;
  disabled?: boolean;
  testID?: string;
}

export function Checkbox({ checked, onToggle, label, description, disabled, testID }: CheckboxProps) {
  return (
    <Pressable
      onPress={() => !disabled && onToggle(!checked)}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
      accessibilityLabel={description ? `${label}. ${description}` : label}
      testID={testID}
      style={({ pressed }) => [styles.row, pressed && !disabled && styles.pressed]}>
      <View style={[styles.box, checked && styles.boxChecked]}>
        {checked ? <Text style={styles.tick}>✓</Text> : null}
      </View>

      <View style={styles.text}>
        <Text style={styles.label}>{label}</Text>
        {description ? <Text style={styles.description}>{description}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: Spacing.three,
    alignItems: 'flex-start',
    minHeight: TouchTarget,
    paddingVertical: Spacing.two,
  },
  pressed: {
    opacity: 0.8,
  },
  box: {
    width: 24,
    height: 24,
    borderRadius: Radii.sm,
    borderWidth: 1.5,
    borderColor: Palette.borderStrong,
    backgroundColor: Palette.backgroundElement,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  boxChecked: {
    backgroundColor: Palette.accent,
    borderColor: Palette.accent,
  },
  tick: {
    fontSize: 14,
    fontWeight: '800',
    color: Palette.onAccent,
    lineHeight: 18,
  },
  text: {
    flex: 1,
    gap: 2,
  },
  label: {
    fontSize: 15,
    lineHeight: 21,
    fontWeight: '600',
    color: Palette.text,
  },
  description: {
    fontSize: 13,
    lineHeight: 19,
    color: Palette.textSecondary,
  },
});
