import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { Palette, Radii, Spacing } from '@/constants/theme';

export type RecapTone = 'default' | 'accent' | 'warning' | 'success';

const TONE_COLORS: Record<RecapTone, string> = {
  default: Palette.textSecondary,
  accent: Palette.accentSoft,
  warning: Palette.warning,
  success: Palette.success,
};

export interface RecapSectionProps {
  title: string;
  body?: string;
  items?: string[];
  /** Renders items as a numbered list (used for next actions). */
  numbered?: boolean;
  tone?: RecapTone;
  style?: StyleProp<ViewStyle>;
}

export function RecapSection({
  title,
  body,
  items,
  numbered = false,
  tone = 'default',
  style,
}: RecapSectionProps) {
  const hasItems = Array.isArray(items) && items.length > 0;
  const hasBody = typeof body === 'string' && body.trim() !== '';
  const accent = TONE_COLORS[tone];

  return (
    <View style={[styles.section, style]}>
      <Text style={styles.title}>{title.toUpperCase()}</Text>

      {hasBody ? <Text style={styles.body}>{body}</Text> : null}

      {hasItems ? (
        <View style={styles.list}>
          {items.map((item, index) => (
            <View key={`${title}-${index}`} style={styles.itemRow}>
              <Text style={[styles.marker, { color: accent }]}>
                {numbered ? `${index + 1}` : '•'}
              </Text>
              <Text style={styles.itemText}>{item}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {!hasBody && !hasItems ? (
        <Text style={styles.empty}>Nothing captured here.</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    backgroundColor: Palette.backgroundElement,
    borderRadius: Radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.border,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  title: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.5,
    color: Palette.textFaint,
  },
  body: {
    fontSize: 15,
    lineHeight: 22,
    color: Palette.text,
  },
  list: {
    gap: Spacing.two,
  },
  itemRow: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  marker: {
    fontSize: 14,
    lineHeight: 21,
    fontWeight: '700',
    minWidth: 12,
  },
  itemText: {
    flex: 1,
    fontSize: 15,
    lineHeight: 21,
    color: Palette.text,
  },
  empty: {
    fontSize: 14,
    lineHeight: 20,
    color: Palette.textFaint,
  },
});
