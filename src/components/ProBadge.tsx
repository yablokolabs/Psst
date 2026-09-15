import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { Palette, Radii } from '@/constants/theme';

export interface ProBadgeProps {
  label?: string;
  /** Solid accent treatment for the paywall header. */
  solid?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function ProBadge({ label = 'PRO', solid = false, style }: ProBadgeProps) {
  return (
    <View style={[styles.badge, solid && styles.solid, style]}>
      <Text style={[styles.label, solid && styles.solidLabel]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: Radii.pill,
    backgroundColor: Palette.accentWash,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.accent,
  },
  solid: {
    backgroundColor: Palette.accent,
    borderColor: Palette.accent,
  },
  label: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.4,
    color: Palette.accentSoft,
  },
  solidLabel: {
    color: Palette.onAccent,
  },
});
