/**
 * Everything drawn over the live camera: the framing guide and scan line,
 * the edge-box preview, the status pill, the coaching banner with its
 * direction arrow, and the stats readout. Each piece is small and
 * stateless; the capture screen feeds them the current Guidance.
 */
import { memo, useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  FadeInDown,
  FadeOutUp,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Path, Rect } from 'react-native-svg';

import type { Arrow, Cue, Guidance, Level } from '@/analysis/guidance.ts';
import type { Exposure } from '@/camera/types';
import { color, font, levelColor, radius, space } from '@/theme';

const LEVEL_INDEX: Record<Level, number> = { good: 0, caution: 1, bad: 2 };

/** A rule-of-thirds grid and a band marking where the shelf should sit. */
export const FrameGuide = memo(function FrameGuide({ scanning }: { scanning: boolean }) {
  const y = useSharedValue(0);
  useEffect(() => {
    y.value = scanning ? withRepeat(withTiming(1, { duration: 1800, easing: Easing.inOut(Easing.quad) }), -1, true) : 0;
  }, [scanning, y]);
  const lineStyle = useAnimatedStyle(() => ({ top: `${12 + y.value * 76}%`, opacity: scanning ? 0.9 : 0 }));
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {[1, 2].map((i) => (
        <View key={`v${i}`} style={[styles.gridV, { left: `${(i * 100) / 3}%` }]} />
      ))}
      {[1, 2].map((i) => (
        <View key={`h${i}`} style={[styles.gridH, { top: `${(i * 100) / 3}%` }]} />
      ))}
      <View style={styles.band} />
      <Animated.View style={[styles.scan, lineStyle]} />
    </View>
  );
});

/** Where the phone sees objects right now: the preview of what will be counted. */
export const BoxesOverlay = memo(function BoxesOverlay({ boxes, level }: { boxes: Guidance['boxes']; level: Level }) {
  const stroke = levelColor[level];
  return (
    <Svg pointerEvents="none" style={StyleSheet.absoluteFill} viewBox="0 0 100 100" preserveAspectRatio="none">
      {boxes.slice(0, 40).map((b, i) => (
        <Rect key={i} x={b.x * 100} y={b.y * 100} width={b.w * 100} height={b.h * 100} stroke={stroke} strokeWidth={0.3} fill="none" rx={0.6} opacity={0.6} />
      ))}
    </Svg>
  );
});

/** Recording / Quality good / Too fast: colour and word, never colour alone. */
export function StatusPill({ status, label, recording, seconds }: { status: Level; label: string; recording: boolean; seconds: number }) {
  const idx = useSharedValue(LEVEL_INDEX[status]);
  const blink = useSharedValue(1);
  useEffect(() => {
    idx.value = withTiming(LEVEL_INDEX[status], { duration: 250 });
  }, [status, idx]);
  useEffect(() => {
    blink.value = recording ? withRepeat(withTiming(0.25, { duration: 600 }), -1, true) : 1;
  }, [recording, blink]);
  const pill = useAnimatedStyle(() => ({
    borderColor: interpolateColor(idx.value, [0, 1, 2], [color.ok, color.warn, color.bad]),
  }));
  const dot = useAnimatedStyle(() => ({
    opacity: blink.value,
    backgroundColor: interpolateColor(idx.value, [0, 1, 2], [color.ok, color.warn, color.bad]),
  }));
  const mm = Math.floor(seconds / 60);
  const ss = Math.floor(seconds % 60).toString().padStart(2, '0');
  return (
    <Animated.View style={[styles.pill, pill]} accessibilityLiveRegion="polite" accessibilityLabel={`${recording ? 'Recording, ' : ''}${label}`}>
      {recording && <View style={styles.recDot} />}
      {recording && <Text style={styles.pillTime}>{`${mm}:${ss}`}</Text>}
      <Animated.View style={[styles.pillDot, dot]} />
      <Text style={styles.pillText}>{label}</Text>
    </Animated.View>
  );
}

function ArrowGlyph({ arrow, tint }: { arrow: Arrow; tint: string }) {
  const rot = { right: 0, down: 90, left: 180, up: 270 }[arrow as 'right'] ?? 0;
  if (arrow === 'in' || arrow === 'out') {
    const d = arrow === 'in' ? 'M4 4 L10 10 M20 4 L14 10 M4 20 L10 14 M20 20 L14 14' : 'M10 10 L4 4 M14 10 L20 4 M10 14 L4 20 M14 14 L20 20';
    return (
      <Svg width={34} height={34} viewBox="0 0 24 24">
        <Path d={d} stroke={tint} strokeWidth={2.4} strokeLinecap="round" />
      </Svg>
    );
  }
  return (
    <Svg width={34} height={34} viewBox="0 0 24 24" style={{ transform: [{ rotate: `${rot}deg` }] }}>
      <Path d="M4 12 H18 M12 6 L18 12 L12 18" stroke={tint} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </Svg>
  );
}

/** The single most important instruction right now: "Slow down", "Move left"... */
export function CueBanner({ cue }: { cue: Cue | undefined }) {
  if (!cue) return null;
  const tint = levelColor[cue.level];
  return (
    <Animated.View key={cue.id} entering={FadeInDown.duration(180)} exiting={FadeOutUp.duration(150)} style={[styles.cue, { borderColor: tint }]} accessibilityRole="alert">
      {cue.arrow ? <ArrowGlyph arrow={cue.arrow} tint={tint} /> : null}
      <View style={{ flex: 1 }}>
        <Text style={[styles.cueTitle, { color: tint }]}>{cue.title}</Text>
        <Text style={styles.cueDetail}>{cue.detail}</Text>
      </View>
    </Animated.View>
  );
}

function Stat({ label, value, level }: { label: string; value: string; level?: Level }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, level && level !== 'good' ? { color: levelColor[level] } : null]}>{value}</Text>
    </View>
  );
}

/** FPS, light, ISO/shutter, sharpness and pace, at a glance. */
export function Hud({ guidance, exposure }: { guidance: Guidance; exposure: Exposure }) {
  const { hud, pace } = guidance;
  const blurLevel: Level = hud.blur < 45 ? 'bad' : hud.blur < 90 ? 'caution' : 'good';
  const lightLevel: Level = hud.light < 0.18 ? 'bad' : hud.light < 0.24 || hud.light > 0.82 ? 'caution' : 'good';
  const shutter = exposure.shutter ? `1/${Math.max(1, Math.round(1 / exposure.shutter))}` : '—';
  return (
    <View style={styles.hud} accessibilityLabel="Camera readout">
      <Stat label="FPS" value={hud.fps ? hud.fps.toFixed(0) : '—'} />
      {/* Phones expose no calibrated lux sensor to apps: this is scene brightness. */}
      <Stat label="LIGHT" value={`${Math.round(hud.light * 100)}%`} level={lightLevel} />
      <Stat label="ISO" value={exposure.iso ? String(Math.round(exposure.iso)) : '—'} />
      <Stat label="SHUTTER" value={shutter} />
      <Stat label="SHARP" value={hud.blur ? String(Math.round(hud.blur)) : '—'} level={blurLevel} />
      <Stat label="PACE" value={`${Math.abs(hud.speed).toFixed(2)}`} level={pace} />
    </View>
  );
}

const styles = StyleSheet.create({
  gridV: { position: 'absolute', top: 0, bottom: 0, width: StyleSheet.hairlineWidth, backgroundColor: '#ffffff33' },
  gridH: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: '#ffffff33' },
  band: { position: 'absolute', left: '4%', right: '4%', top: '12%', bottom: '12%', borderWidth: 1.5, borderColor: '#ffffff66', borderRadius: radius.md },
  scan: { position: 'absolute', left: '4%', right: '4%', height: 2, backgroundColor: color.accent, shadowColor: color.accent, shadowOpacity: 0.8, shadowRadius: 6 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'center', paddingHorizontal: 14, height: 36, borderRadius: radius.pill, borderWidth: 1.5, backgroundColor: color.overlayStrong },
  pillDot: { width: 8, height: 8, borderRadius: 4 },
  recDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: color.bad },
  pillTime: { color: color.fg, fontFamily: font.mono, fontSize: font.size.sm },
  pillText: { color: color.fg, fontWeight: '700', fontSize: font.size.sm },
  cue: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginHorizontal: space.lg, padding: space.md, borderRadius: radius.lg, borderWidth: 1.5, backgroundColor: color.overlayStrong },
  cueTitle: { fontSize: font.size.lg, fontWeight: '800' },
  cueDetail: { color: color.fg, fontSize: font.size.sm, marginTop: 2 },
  hud: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 6, marginHorizontal: space.md, padding: space.sm, borderRadius: radius.md, backgroundColor: color.overlay },
  stat: { minWidth: 48, alignItems: 'center' },
  statLabel: { color: color.subtle, fontSize: 9, fontWeight: '700', letterSpacing: 0.8 },
  statValue: { color: color.fg, fontFamily: font.mono, fontSize: font.size.sm },
});
