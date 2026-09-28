/**
 * Frame samples in, what to tell the operator out.
 *
 * Samples arrive at camera rate on the JS thread; the engine keeps its own
 * timing and debouncing, and React state is updated at most ~11 times a
 * second.
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
    // useTilt is + when the top tips away (camera looking down); the engine
    // wants + for aimed up, so it can say "Tilt up" to a camera aimed at the floor.
    const tilt = tiltRef.current == null ? null : -tiltRef.current;
    const g = engine.current.update({ sample, tiltDeg: tilt, recording: recRef.current });
    const now = Date.now();
    // Just under the ~100 ms sample interval, so every sample renders: skipping
    // one leaves the outlines a whole interval behind a moving shelf.
    if (now - lastPush.current >= 90) {
      lastPush.current = now;
      setGuidance(g);
    }
  }, []);

  return { guidance, onSample };
}
