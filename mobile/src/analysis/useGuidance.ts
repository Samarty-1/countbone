/**
 * Frame samples in, what to tell the operator out.
 *
 * Samples arrive at camera rate on the JS thread; the engine keeps its own
 * timing and debouncing, and React state is updated at most ~8 times a
 * second, which is as fast as anyone reads a HUD.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { GuidanceEngine, type Guidance } from './guidance.ts';
import type { FrameSample } from './metrics.ts';

const INITIAL: Guidance = {
  status: 'good',
  label: 'Point at the shelf',
  pace: 'good',
  cues: [],
  hud: { fps: 0, blur: 0, light: 0, speed: 0, vertical: 0, direction: null },
  boxes: [],
};

export function useGuidance(tiltDeg: number | null, recording: boolean) {
  const engine = useRef(new GuidanceEngine());
  const [guidance, setGuidance] = useState<Guidance>(INITIAL);
  const lastPush = useRef(0);
  const tiltRef = useRef(tiltDeg);
  const recRef = useRef(recording);
  // Refs, so the sample callback stays stable while reading the latest values.
  useEffect(() => {
    tiltRef.current = tiltDeg;
    recRef.current = recording;
  }, [tiltDeg, recording]);

  useEffect(() => {
    // A new recording starts from a clean slate (direction, distance, ...).
    if (recording) engine.current.reset();
  }, [recording]);

  const onSample = useCallback((sample: FrameSample) => {
    const g = engine.current.update({ sample, tiltDeg: tiltRef.current, recording: recRef.current });
    const now = Date.now();
    if (now - lastPush.current >= 120) {
      lastPush.current = now;
      setGuidance(g);
    }
  }, []);

  return { guidance, onSample };
}
