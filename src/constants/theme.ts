/**
 * Psst design tokens.
 *
 * Psst is a dark-first brand: deep navy / near-black background, violet accent,
 * soft lavender highlights. Both colour schemes resolve to the same palette so
 * the app stays on-brand on every device (app.json pins the dark appearance).
 */

import '@/global.css';

import { Platform } from 'react-native';

export const Palette = {
  background: '#08070F',
  backgroundElevated: '#111026',
  backgroundElement: '#15132E',
  backgroundSelected: '#231F49',
  border: '#26214A',
  borderStrong: '#332B63',

  text: '#F5F3FF',
  textSecondary: '#A29BC7',
  textFaint: '#6E6796',

  accent: '#7C5CFF',
  accentStrong: '#6A46F5',
  accentSoft: '#C9BEFF',
  accentWash: '#1B1740',
  onAccent: '#FFFFFF',

  live: '#9C8BFF',
  success: '#4ED2A6',
  warning: '#F2B457',
  danger: '#FF7C8B',
} as const;

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const Radii = {
  sm: 10,
  md: 16,
  lg: 22,
  xl: 28,
  pill: 999,
} as const;

/** Minimum touch target on Android. */
export const TouchTarget = 48;

export const MaxContentWidth = 800;
