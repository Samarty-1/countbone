import { DeviceMotion } from 'expo-sensors';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { GuidanceEngine, type Guidance } from '@/analysis/guidance.ts';
import type { FrameSample } from '@/analysis/metrics.ts';

/**
 * Camera aim in degrees above level, from the motion sensor, or null.
 *
 * DeviceMotion's beta is rotation about the device's x axis: 90° when a
 * portrait phone stands upright, less as its top tips away from the operator
 * (camera aims at the floor), more as it tips back (camera aims up).
 */
export function useCameraAim(enabled: boolean): React.RefObject<number | null> {
  const aim = useRef<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let sub: { remove: () => void } | null = null;
    let cancelled = false;
    (async () => {
      try {
        if (!(await DeviceMotion.isAvailableAsync())) return;
        // iOS Safari only grants motion after a user gesture; the web preview
        // on a desktop has no sensor at all. Either way: no tilt cue.
        if (Platform.OS !== 'web') {
          const perm = await DeviceMotion.requestPermissionsAsync();
          if (!perm.granted) return;
        }
        if (cancelled) return;
        DeviceMotion.setUpdateInterval(100);
        sub = DeviceMotion.addListener((m) => {
          const beta = m.rotation?.beta;
          aim.current = typeof beta === 'number' && Number.isFinite(beta) ? (beta * 180) / Math.PI - 90 : null;
        });
      } catch (err) {
        console.warn('motion sensor unavailable', err);
      }
    })();
    return () => {
      cancelled = true;
      sub?.remove();
      aim.current = null;
    };
  }, [enabled]);
  return aim;
}

/**
 * React re-renders the overlay at most this often; the engine sees every
 * sample. Just under the 100 ms analysis interval, so every sample renders:
 * skipping one leaves outlines a whole interval behind a moving shelf.
 */
const RENDER_MS = 90;

export interface GuidanceFeed {
  guidance: Guidance | null;
  /** Upright frame size of the latest sample, for mapping outlines. */
  frame: { width: number; height: number } | null;
  push: (sample: FrameSample) => void;
  reset: () => void;
}

export function useGuidance(recording: boolean): GuidanceFeed {
  const engine = useRef(new GuidanceEngine());
  const aim = useCameraAim(true);
  const recordingRef = useRef(recording);
  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);
  const [state, setState] = useState<{ guidance: Guidance | null; frame: GuidanceFeed['frame'] }>({
    guidance: null,
    frame: null,
  });
  const lastRender = useRef(0);

  const push = useCallback(
    (sample: FrameSample) => {
      const g = engine.current.update({ sample, tiltDeg: aim.current, recording: recordingRef.current });
      const now = Date.now();
      // A new bad cue renders immediately; everything else is rate-limited.
      if (now - lastRender.current >= RENDER_MS || g.status === 'bad') {
        lastRender.current = now;
        setState({ guidance: g, frame: { width: sample.srcWidth, height: sample.srcHeight } });
      }
    },
    [aim],
  );

  const reset = useCallback(() => {
    engine.current.reset();
    setState({ guidance: null, frame: null });
  }, []);

  return { ...state, push, reset };
}
