import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { Palette, Radii, TouchTarget } from '@/constants/theme';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';

export interface PrimaryButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  /** Small line under the label, e.g. why a button is disabled. */
  hint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function PrimaryButton({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  hint,
  style,
  testID,
}: PrimaryButtonProps) {
  const inactive = disabled || loading;

  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy: loading }}
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.base,
        styles[variant],
        pressed && !inactive && styles.pressed,
        inactive && styles.inactive,
        style,
      ]}>
      <View style={styles.content}>
        {loading ? <ActivityIndicator size="small" color={labelColor(variant)} /> : null}
        <Text style={[styles.label, { color: labelColor(variant) }]} numberOfLines={2}>
          {label}
        </Text>
      </View>
      {hint ? (
        <Text style={[styles.hint, { color: labelColor(variant) }]} numberOfLines={2}>
          {hint}
        </Text>
      ) : null}
    </Pressable>
  );
}

function labelColor(variant: ButtonVariant): string {
  switch (variant) {
    case 'primary':
      return Palette.onAccent;
    case 'destructive':
      return Palette.onAccent;
    case 'secondary':
      return Palette.text;
    case 'ghost':
      return Palette.accentSoft;
  }
}

const styles = StyleSheet.create({
  base: {
    minHeight: TouchTarget,
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: Radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  primary: {
    backgroundColor: Palette.accent,
  },
  secondary: {
    backgroundColor: Palette.backgroundElement,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.borderStrong,
  },
  ghost: {
    backgroundColor: 'transparent',
  },
  destructive: {
    backgroundColor: Palette.danger,
  },
  pressed: {
    opacity: 0.82,
  },
  inactive: {
    opacity: 0.45,
  },
  label: {
    fontSize: 16,
    fontWeight: '600',
  },
  hint: {
    fontSize: 12,
    opacity: 0.8,
  },
});
