import { useEffect } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { Palette, Radii, Spacing } from '@/constants/theme';
import type { ConversationStatus } from '@/types/conversation';

const LABELS: Record<ConversationStatus, string> = {
  idle: 'Not listening',
  connecting: 'Connecting',
  listening: 'Listening',
  paused: 'Paused',
  ended: 'Session ended',
  error: 'Stopped',
};

const COLORS: Record<ConversationStatus, string> = {
  idle: Palette.textFaint,
  connecting: Palette.warning,
  listening: Palette.success,
  paused: Palette.warning,
  ended: Palette.textFaint,
  error: Palette.danger,
};

export interface ListeningIndicatorProps {
  status: ConversationStatus;
  style?: StyleProp<ViewStyle>;
}

/**
 * Always visible while a session exists: Psst never records without saying so.
 */
export function ListeningIndicator({ status, style }: ListeningIndicatorProps) {
  const pulse = useSharedValue(0);
  const active = status === 'listening';
  const color = COLORS[status];

  useEffect(() => {
    if (active) {
      pulse.value = withRepeat(
        withTiming(1, { duration: 1800, easing: Easing.out(Easing.quad) }),
        -1,
        false
      );
    } else {
      pulse.value = withTiming(0, { duration: 200 });
    }
  }, [active, pulse]);

  const ringStyle = useAnimatedStyle(() => ({
    opacity: 0.5 * (1 - pulse.value),
    transform: [{ scale: 1 + pulse.value * 2.2 }],
  }));

  return (
    <View style={[styles.container, style]} accessibilityLabel={LABELS[status]}>
      <View style={styles.dotWrapper}>
        <Animated.View style={[styles.ring, { backgroundColor: color }, ringStyle]} />
        <View style={[styles.dot, { backgroundColor: color }]} />
      </View>
      <Text style={[styles.label, { color }]}>{LABELS[status].toUpperCase()}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  dotWrapper: {
    width: 12,
    height: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ring: {
    position: 'absolute',
    width: 12,
    height: 12,
    borderRadius: Radii.pill,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: Radii.pill,
  },
  label: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.4,
  },
});
