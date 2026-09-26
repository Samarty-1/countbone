/**
 * The live guidance layer drawn over the viewfinder, shared by the native
 * camera and the browser preview. Everything here is a pure function of the
 * GuidanceEngine's output, so the two platforms cannot drift apart.
 */
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CheckCircle2,
  Maximize2,
  Minimize2,
  OctagonAlert,
  type LucideIcon,
} from 'lucide-react-native';
import { useEffect, useMemo } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';

import type { Arrow, Guidance, Level } from '@/analysis/guidance.ts';
import { THRESHOLDS } from '@/analysis/guidance.ts';
import { clock } from '@/lib/format.ts';
import { color, font, levelColor, radius, space, touch } from '@/theme.ts';

export interface Viewport {
  width: number;
  height: number;
}

/**
 * Where a normalised frame box lands in a view showing the frame with
 * cover scaling (VisionCamera resizeMode "cover", CSS object-fit: cover).
 */
export function coverTransform(frame: { width: number; height: number }, view: Viewport) {
  const scale = Math.max(view.width / frame.width, view.height / frame.height);
  const dw = frame.width * scale;
  const dh = frame.height * scale;
  return { dw, dh, ox: (view.width - dw) / 2, oy: (view.height - dh) / 2 };
}

/* ---------------------------------------------------------------- grid */

/**
 * Thirds, plus a band across the middle: the shelf row being counted
 * belongs inside it. Keeping it there is what "hold level" asks for.
 */
export function FramingGrid() {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {[1 / 3, 2 / 3].map((f) => (
        <View
          key={`v${f}`}
          style={[styles.gridLine, { left: `${f * 100}%`, top: 0, bottom: 0, width: StyleSheet.hairlineWidth }]}
        />
      ))}
      {[1 / 3, 2 / 3].map((f) => (
        <View
          key={`h${f}`}
          style={[styles.gridLine, { top: `${f * 100}%`, left: 0, right: 0, height: StyleSheet.hairlineWidth }]}
        />
      ))}
      <View style={styles.band}>
        {(['tl', 'tr', 'bl', 'br'] as const).map((c) => (
          <View
            key={c}
            style={[
              styles.corner,
              c[0] === 't' ? { top: 0, borderTopWidth: 2 } : { bottom: 0, borderBottomWidth: 2 },
              c[1] === 'l' ? { left: 0, borderLeftWidth: 2 } : { right: 0, borderRightWidth: 2 },
            ]}
          />
        ))}
      </View>
    </View>
  );
}

/* --------------------------------------------------------------- boxes */

export function BoxOverlay({
  guidance,
  frame,
  view,
}: {
  guidance: Guidance | null;
  frame: { width: number; height: number } | null;
  view: Viewport | null;
}) {
  if (!guidance || !frame || !view || !guidance.boxes.length) return null;
  const { dw, dh, ox, oy } = coverTransform(frame, view);
  const tint = levelColor[guidance.status];
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {guidance.boxes.map((b, i) => (
        <View
          key={i}
          style={{
            position: 'absolute',
            left: ox + b.x * dw,
            top: oy + b.y * dh,
            width: b.w * dw,
            height: b.h * dh,
            borderWidth: 1.5,
            borderColor: tint,
            borderRadius: 3,
            opacity: 0.8,
          }}
        />
      ))}
    </View>
  );
}

/* -------------------------------------------------------------- banner */

const STATUS_ICON: Record<Level, LucideIcon> = { good: CheckCircle2, caution: AlertTriangle, bad: OctagonAlert };

export function WarningBanner({ guidance, recording }: { guidance: Guidance | null; recording: boolean }) {
  const status: Level = guidance?.status ?? 'caution';
  const Icon = STATUS_ICON[status];
  const top = guidance?.cues[0];
  const more = (guidance?.cues.length ?? 0) - 1;
  const tint = levelColor[status];
  const title = guidance ? guidance.label : 'Starting camera…';
  const detail = top?.detail ?? (guidance ? (recording ? 'Keep walking at this pace' : 'Ready to record') : null);
  return (
    <View
      style={[styles.banner, { borderColor: tint }, status === 'bad' && { backgroundColor: 'rgba(58,16,18,0.9)' }]}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      accessibilityLabel={`${title}. ${detail ?? ''}`}
    >
      <Icon size={22} color={tint} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.bannerTitle, { color: tint }]} numberOfLines={1}>
          {title}
        </Text>
        {detail ? (
          <Text style={styles.bannerDetail} numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
      </View>
      {more > 0 ? <Text style={styles.bannerMore}>+{more}</Text> : null}
    </View>
  );
}

/* --------------------------------------------------------------- arrow */

const ARROW_ICON: Record<Arrow, LucideIcon> = {
  left: ArrowLeft,
  right: ArrowRight,
  up: ArrowUp,
  down: ArrowDown,
  in: Maximize2,
  out: Minimize2,
};

const ARROW_TEXT: Record<Arrow, string> = {
  left: 'Go left',
  right: 'Go right',
  up: 'Aim higher',
  down: 'Aim lower',
  in: 'Closer',
  out: 'Back off',
};

/** The first cue that carries a direction wins: one arrow, never a cluster. */
export function DirectionArrow({ guidance }: { guidance: Guidance | null }) {
  const cue = guidance?.cues.find((c) => c.arrow);
  const pulse = useMemo(() => new Animated.Value(0), []);
  const arrow = cue?.arrow;
  useEffect(() => {
    if (!arrow) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 450, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 450, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [arrow, pulse]);
  if (!cue?.arrow) return null;
  const Icon = ARROW_ICON[cue.arrow];
  const tint = levelColor[cue.level];
  const d = 14;
  const axis = cue.arrow === 'left' || cue.arrow === 'right' ? 'translateX' : 'translateY';
  const sign = cue.arrow === 'left' || cue.arrow === 'up' ? -1 : 1;
  const move = pulse.interpolate({ inputRange: [0, 1], outputRange: [0, sign * d] });
  const transform =
    cue.arrow === 'in' || cue.arrow === 'out'
      ? [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, cue.arrow === 'in' ? 1.2 : 0.85] }) }]
      : axis === 'translateX'
        ? [{ translateX: move }]
        : [{ translateY: move }];
  return (
    <View pointerEvents="none" style={styles.arrowWrap} accessibilityLabel={ARROW_TEXT[cue.arrow]}>
      <Animated.View style={[styles.arrowDisc, { borderColor: tint, transform }]}>
        <Icon size={56} color={tint} strokeWidth={2.5} />
      </Animated.View>
      <Text style={[styles.arrowText, { color: tint }]}>{ARROW_TEXT[cue.arrow]}</Text>
    </View>
  );
}

/* --------------------------------------------------------------- stats */

function paceLevel(speed: number): Level {
  const s = Math.abs(speed);
  return s >= THRESHOLDS.paceBad ? 'bad' : s >= THRESHOLDS.paceCaution ? 'caution' : 'good';
}
function blurLevel(blur: number): Level {
  return blur < THRESHOLDS.blurBad ? 'bad' : blur < THRESHOLDS.blurCaution ? 'caution' : 'good';
}
function lightLevel(light: number): Level {
  const b = light * 255;
  return b < THRESHOLDS.darkBad
    ? 'bad'
    : b < THRESHOLDS.darkCaution || b > THRESHOLDS.brightCaution
      ? 'caution'
      : 'good';
}

/** The numbers behind the banner, for the operator who wants to know why. */
export function StatsReadout({ guidance }: { guidance: Guidance | null }) {
  if (!guidance) return null;
  const { hud } = guidance;
  const rows: [string, string, Level | null][] = [
    ['fps', hud.fps.toFixed(0), null],
    ['sharp', hud.blur.toFixed(0), blurLevel(hud.blur)],
    ['light', `${Math.round(hud.light * 100)}%`, lightLevel(hud.light)],
    ['pace', `${Math.abs(hud.speed).toFixed(2)}`, paceLevel(hud.speed)],
    ['scan', hud.direction === 'right' ? '→' : hud.direction === 'left' ? '←' : '·', null],
  ];
  return (
    <View style={styles.stats} accessibilityLabel="Capture statistics">
      {rows.map(([k, v, lvl]) => (
        <View key={k} style={styles.statRow}>
          <Text style={styles.statKey}>{k}</Text>
          <Text style={[styles.statVal, lvl && { color: levelColor[lvl] }]}>{v}</Text>
        </View>
      ))}
    </View>
  );
}

/* -------------------------------------------------------------- record */

export function RecordButton({
  recording,
  elapsedS,
  onPress,
  disabled,
}: {
  recording: boolean;
  elapsedS: number;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <View style={styles.recordWrap}>
      <Text style={[styles.timer, !recording && { opacity: 0 }]} accessibilityElementsHidden={!recording}>
        ● {clock(elapsedS)}
      </Text>
      <Pressable
        onPress={onPress}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={recording ? 'Stop recording' : 'Start recording'}
        accessibilityState={{ disabled: !!disabled }}
        hitSlop={12}
        style={({ pressed }) => [
          styles.recordOuter,
          disabled && { opacity: 0.4 },
          pressed && { transform: [{ scale: 0.94 }] },
        ]}
      >
        <View style={recording ? styles.recordStop : styles.recordDot} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  gridLine: { position: 'absolute', backgroundColor: 'rgba(237,238,240,0.28)' },
  band: { position: 'absolute', left: '8%', right: '8%', top: '30%', bottom: '30%' },
  corner: { position: 'absolute', width: 22, height: 22, borderColor: 'rgba(237,238,240,0.7)' },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: color.overlayStrong,
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    minHeight: 60,
  },
  bannerTitle: { fontSize: font.size.lg, fontWeight: '700' },
  bannerDetail: { color: color.fg, fontSize: font.size.sm, marginTop: 1 },
  bannerMore: { color: color.muted, fontSize: font.size.sm, fontFamily: font.mono },
  arrowWrap: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', gap: space.sm },
  arrowDisc: {
    width: 104,
    height: 104,
    borderRadius: 52,
    borderWidth: 3,
    backgroundColor: color.overlay,
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowText: {
    fontSize: font.size.lg,
    fontWeight: '700',
    backgroundColor: color.overlay,
    paddingHorizontal: space.md,
    paddingVertical: 2,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  stats: {
    backgroundColor: color.overlay,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    gap: 2,
    minWidth: 104,
  },
  statRow: { flexDirection: 'row', justifyContent: 'space-between', gap: space.md },
  statKey: { color: color.subtle, fontFamily: font.mono, fontSize: font.size.xs },
  statVal: { color: color.fg, fontFamily: font.mono, fontSize: font.size.xs, fontVariant: ['tabular-nums'] },
  recordWrap: { alignItems: 'center', gap: space.sm },
  timer: {
    color: color.bad,
    fontFamily: font.mono,
    fontSize: font.size.md,
    fontWeight: '600',
    backgroundColor: color.overlay,
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  recordOuter: {
    width: touch.primary,
    height: touch.primary,
    borderRadius: touch.primary / 2,
    borderWidth: 4,
    borderColor: color.fg,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(11,12,14,0.35)',
  },
  recordDot: { width: 62, height: 62, borderRadius: 31, backgroundColor: color.bad },
  recordStop: { width: 32, height: 32, borderRadius: 6, backgroundColor: color.bad },
});
