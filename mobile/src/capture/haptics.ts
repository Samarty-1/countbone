import * as Haptics from 'expo-haptics';
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

import type { CueId, Guidance } from '@/analysis/guidance.ts';

type Kind = 'start' | 'stop' | 'warn' | 'tap' | 'success';

/** Vibration patterns for the web preview (Android Chrome); iOS Safari has none. */
const WEB_PATTERN: Record<Kind, number | number[]> = {
  start: 40,
  stop: [30, 60, 30],
  warn: [80, 60, 80],
  tap: 10,
  success: [20, 40, 20],
};

/** Fire-and-forget: a missing vibrator must never break a count. */
export function buzz(kind: Kind, enabled: boolean): void {
  if (!enabled) return;
  if (Platform.OS === 'web') {
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function')
        navigator.vibrate(WEB_PATTERN[kind]);
    } catch {
      /* not supported */
    }
    return;
  }
  const p =
    kind === 'start'
      ? Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy)
      : kind === 'stop'
        ? Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
        : kind === 'warn'
          ? Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)
          : kind === 'success'
            ? Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
            : Haptics.selectionAsync();
  p.catch(() => undefined);
}

/**
 * While recording, buzz when a *bad* cue first appears: the operator is
 * looking at the shelf, not the screen. Each cue buzzes at most once per
 * REPEAT_S so a sustained problem nags without becoming noise.
 */
const REPEAT_S = 4;

export function useGuidanceHaptics(guidance: Guidance | null, recording: boolean, enabled: boolean): void {
  const lastBuzz = useRef(new Map<CueId, number>());
  const active = useRef(new Set<CueId>());

  useEffect(() => {
    if (!recording) {
      active.current.clear();
      return;
    }
    const now = Date.now() / 1000;
    const bad = new Set((guidance?.cues ?? []).filter((c) => c.level === 'bad').map((c) => c.id));
    let fire = false;
    for (const id of bad) {
      const isNew = !active.current.has(id);
      const due = now - (lastBuzz.current.get(id) ?? -Infinity) >= REPEAT_S;
      if (isNew && due) {
        lastBuzz.current.set(id, now);
        fire = true;
      }
    }
    active.current = bad;
    if (fire) buzz('warn', enabled);
  }, [guidance, recording, enabled]);
}
