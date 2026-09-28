import { Platform } from 'react-native';

import type { Level } from '@/analysis/guidance.ts';

/**
 * The dashboard's tokens (web/src/index.css), so phone and desktop read as
 * one product. Contrast on `bg` was measured there: fg 16.9, muted 7.5,
 * subtle 5.1, ok 10.4, warn 10.9, bad 6.8 : 1. Over live video, text also
 * sits on a scrim (`overlay`) so bright shelves cannot wash it out.
 */
export const color = {
  bg: '#0b0c0e',
  surface: '#111316',
  raised: '#171a1e',
  hover: '#1d2126',
  line: '#23272e',
  lineStrong: '#323841',
  fg: '#edeef0',
  muted: '#9ba1ab',
  subtle: '#7c828c',
  accent: '#5b8cff',
  accentFg: '#0b0c0e',
  ok: '#3dd68c',
  warn: '#ffb224',
  bad: '#ff6369',
  info: '#52a8ff',
  overlay: 'rgba(11,12,14,0.72)',
  overlayStrong: 'rgba(11,12,14,0.88)',
} as const;

export const levelColor: Record<Level, string> = { good: color.ok, caution: color.warn, bad: color.bad };

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 6, md: 10, lg: 14, pill: 999 } as const;

/** Apple HIG / Material minimums; gloved warehouse hands get more. */
export const touch = { min: 48, primary: 84 } as const;

export const font = {
  mono: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, Menlo, Consolas, monospace' }),
  size: { xs: 11, sm: 13, md: 15, lg: 17, xl: 22, xxl: 32 },
} as const;
