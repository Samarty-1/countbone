/**
 * How far the phone leans back or forward from upright, in degrees.
 *
 * From gravity, not the rotation API: DeviceMotion.rotation is missing on
 * the web and reported in different units across platforms, while the
 * gravity vector (accelerationIncludingGravity) is available everywhere.
 * Positive = top tilted away (camera looks down), negative = toward you.
 *
 * On the web, the browser's own `devicemotion` event is used: expo-sensors
 * reports DeviceMotion as available in any browser that has the API (every
 * desktop Chrome), then fails to subscribe, which crashed the viewfinder.
 * Axis signs follow each platform's convention; confirm them on each target
 * device before relying on the up/down cue.
 */
import { DeviceMotion } from 'expo-sensors';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

function tiltFrom(y: number, z: number, upright: 1 | -1): number | null {
  if (Math.hypot(y, z) < 3) return null; // flat or in free fall: no meaningful answer
  return (Math.atan2(z, upright * y) * 180) / Math.PI;
}

export function useTilt(enabled = true): number | null {
  const [tilt, setTilt] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled) return;

    if (Platform.OS === 'web') {
      if (typeof window === 'undefined' || typeof window.DeviceMotionEvent === 'undefined') return;
      // Browsers report +g on y when the phone is upright.
      const onMotion = (e: DeviceMotionEvent) => {
        const g = e.accelerationIncludingGravity;
        if (g?.y == null || g.z == null) return;
        const t = tiltFrom(g.y, g.z, 1);
        if (t != null) setTilt(t);
      };
      window.addEventListener('devicemotion', onMotion);
      return () => window.removeEventListener('devicemotion', onMotion);
    }

    let sub: { remove: () => void } | null = null;
    let alive = true;
    (async () => {
      try {
        if (!(await DeviceMotion.isAvailableAsync()) || !alive) return;
        DeviceMotion.setUpdateInterval(100);
        sub = DeviceMotion.addListener((m) => {
          const g = m.accelerationIncludingGravity;
          if (!g) return;
          const t = tiltFrom(g.y, g.z, -1); // expo reports -g on y when upright
          if (t != null) setTilt(t);
        });
      } catch {
        // No motion sensor: the tilt cue simply stays off.
      }
    })();
    return () => {
      alive = false;
      sub?.remove();
    };
  }, [enabled]);

  return tilt;
}
