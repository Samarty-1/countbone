/**
 * Live capture guidance: turns per-frame samples into what the operator
 * should do right now.
 *
 * Every threshold is tied to what the countbone backend will do with the
 * footage, so a warning on the phone means "this would hurt the count":
 *
 *  - Blur uses the quality gate's own threshold (min_blur 45) on the same
 *    960 px-scale measure (see metrics.blurAtBackendScale).
 *  - Light mirrors the gate's brightness band (35..225) and clipped limit
 *    (0.28), warning a little before the gate would drop a frame.
 *  - Pace: the backend samples every 5th frame (6/s at 30 fps) and needs an
 *    object in >= 2 kept frames; motion blur at a 1/60 s shutter grows by
 *    ~16 px per frame-width/s at 960 px. Past ~0.8 frame-widths/s objects get
 *    too few sharp sightings; 0.45 is the comfortable ceiling.
 *  - Reversing: the tracker forgets an object a few samples after it leaves
 *    view, so walking back over counted stock counts it again.
 */

import { estimateScale, estimateShift, type Box, type FrameSample } from './metrics.ts';

export type Level = 'good' | 'caution' | 'bad';
export type Arrow = 'left' | 'right' | 'up' | 'down' | 'in' | 'out';

export type CueId =
  | 'lens'
  | 'fast'
  | 'soft'
  | 'dark'
  | 'glare'
  | 'reverse'
  | 'tilt-up'
  | 'tilt-down'
  | 'level'
  | 'closer'
  | 'back'
  | 'aim';

export interface Cue {
  id: CueId;
  level: Exclude<Level, 'good'>;
  title: string;
  detail: string;
  arrow?: Arrow;
}

export interface Guidance {
  status: Level;
  /** Short status for the pill: "Quality good", "Too fast", "Blurry", ... */
  label: string;
  pace: Level;
  cues: Cue[];
  hud: {
    fps: number;
    blur: number;
    /** 0..1 mean luminance. */
    light: number;
    /** Frame widths per second, signed (+ = scene moving right = camera panning left). */
    speed: number;
    /** Frame heights per second, signed. */
    vertical: number;
    /** Camera scan direction once established. */
    direction: 'left' | 'right' | null;
  };
  boxes: Box[];
}

export const THRESHOLDS = {
  blurBad: 45, // quality_gate min_blur
  blurCaution: 90,
  lensSeconds: 1.2, // blur must persist this long (while slow) to blame the lens
  darkBad: 45,
  darkCaution: 60,
  brightCaution: 210,
  clippedBad: 0.2,
  paceCaution: 0.45,
  paceBad: 0.8,
  directionSpeed: 0.08, // below this the operator is effectively still
  directionSeconds: 1.0,
  reverseSpeed: 0.1, // walking back slowly still re-counts; just above the noise floor
  verticalCaution: 0.15,
  tiltCaution: 15, // degrees from upright
  tiltBad: 25,
  distanceBand: 0.12, // |log scale| drift since the recording started
  contrastMin: 10,
} as const;

/** Cues switch on quickly and off slowly, so the banner does not flicker. */
const ENTER_S = 0.25;
const EXIT_S = 0.6;

interface CueState {
  since: number | null; // when the condition started holding
  lastTrue: number; // last time the condition held
  active: boolean;
  cue: Cue | null;
}

export interface EngineInput {
  sample: FrameSample;
  /** Device pitch in degrees from upright (+ = top tilted away), or null if no sensor. */
  tiltDeg: number | null;
  recording: boolean;
}

export class GuidanceEngine {
  private prev: FrameSample | null = null;
  private vx = 0;
  private vy = 0;
  private priorDx = 0;
  private priorDy = 0;
  private fps = 0;
  private logScale = 0;
  private lowBlurSince: number | null = null;
  private dirSign = 0;
  private dirSince: number | null = null;
  private direction: 'left' | 'right' | null = null;
  private cues = new Map<CueId, CueState>();
  private wasRecording = false;

  /** Forget motion history, e.g. when a recording starts or the source changes. */
  reset(): void {
    this.prev = null;
    this.vx = this.vy = this.priorDx = this.priorDy = 0;
    this.logScale = 0;
    this.lowBlurSince = null;
    this.dirSign = 0;
    this.dirSince = null;
    this.direction = null;
    this.cues.clear();
  }

  update({ sample, tiltDeg, recording }: EngineInput): Guidance {
    if (recording && !this.wasRecording) {
      // A new take: direction and distance are relative to how it started.
      this.direction = null;
      this.dirSince = null;
      this.logScale = 0;
    }
    this.wasRecording = recording;

    const t = sample.t;
    const prev = this.prev;
    if (prev && t > prev.t && prev.thumbWidth === sample.thumbWidth) {
      const dt = t - prev.t;
      const cols = Float32Array.from(sample.cols);
      const rows = Float32Array.from(sample.rows);
      const maxX = Math.round(sample.thumbWidth * 0.25);
      const maxY = Math.round(sample.thumbHeight * 0.2);
      const sx = estimateShift(Float32Array.from(prev.cols), cols, maxX, this.priorDx);
      const sy = estimateShift(Float32Array.from(prev.rows), rows, maxY, this.priorDy);
      // A featureless view gives no trustworthy motion; hold the last estimate.
      const dx = sx.confidence > 0.15 ? sx.shift : this.priorDx;
      const dy = sy.confidence > 0.15 ? sy.shift : this.priorDy;
      this.priorDx = dx;
      this.priorDy = dy;
      const a = Math.min(1, dt / 0.3); // ~0.3 s smoothing
      this.vx += a * (dx / sample.thumbWidth / dt - this.vx);
      this.vy += a * (dy / sample.thumbHeight / dt - this.vy);
      this.fps += Math.min(1, dt / 0.5) * (1 / dt - this.fps);
      if (recording) {
        const s = estimateScale(Float32Array.from(prev.rows), rows);
        // Only confident, non-trivial steps accumulate: noise must not drift.
        if (Math.abs(s - 1) >= 0.02 && sy.confidence > 0.3) this.logScale += Math.log(s);
      }
    }
    this.prev = sample;

    this.trackDirection(t, recording);

    const speed = Math.abs(this.vx);
    const raw = this.rawCues(sample, t, tiltDeg, recording, speed);
    const cues = this.debounce(raw, t);

    const pace: Level =
      speed >= THRESHOLDS.paceBad ? 'bad' : speed >= THRESHOLDS.paceCaution ? 'caution' : 'good';
    const status: Level = cues.some((c) => c.level === 'bad')
      ? 'bad'
      : cues.length || pace === 'caution'
        ? 'caution'
        : 'good';
    return {
      status,
      label: status === 'good' ? 'Quality good' : (cues[0]?.title ?? (pace === 'caution' ? 'Ease off' : 'Adjust')),
      pace,
      cues,
      hud: {
        fps: this.fps,
        blur: sample.blur,
        light: sample.brightness / 255,
        speed: this.vx,
        vertical: this.vy,
        direction: this.direction,
      },
      boxes: sample.boxes,
    };
  }

  /** The scan direction is whichever way the operator first walks steadily. */
  private trackDirection(t: number, recording: boolean): void {
    if (!recording) return;
    const sign = Math.abs(this.vx) >= THRESHOLDS.directionSpeed ? Math.sign(this.vx) : 0;
    if (sign !== this.dirSign) {
      this.dirSign = sign;
      this.dirSince = sign ? t : null;
    }
    if (!this.direction && this.dirSince != null && t - this.dirSince >= THRESHOLDS.directionSeconds) {
      // Content moving left (vx < 0) means the camera is moving right.
      this.direction = this.dirSign < 0 ? 'right' : 'left';
    }
  }

  private rawCues(s: FrameSample, t: number, tilt: number | null, recording: boolean, speed: number): Cue[] {
    const T = THRESHOLDS;
    const out: Cue[] = [];
    const lowTexture = s.contrast < T.contrastMin;

    if (lowTexture) {
      out.push({ id: 'aim', level: 'caution', title: 'Aim at the shelf', detail: 'Nothing to count in view' });
    }

    if (!lowTexture && s.blur < T.blurBad) {
      this.lowBlurSince ??= t;
      if (speed >= T.paceCaution) {
        out.push({ id: 'fast', level: 'bad', title: 'Too fast', detail: 'Motion blur — slow down', arrow: this.slowArrow() });
      } else if (t - this.lowBlurSince >= T.lensSeconds) {
        out.push({ id: 'lens', level: 'bad', title: 'Lens blurry', detail: 'Wipe the lens or tap to focus' });
      }
    } else {
      this.lowBlurSince = null;
      if (speed >= T.paceBad) {
        out.push({ id: 'fast', level: 'bad', title: 'Too fast', detail: 'Slow down', arrow: this.slowArrow() });
      } else if (!lowTexture && s.blur < T.blurCaution) {
        out.push({ id: 'soft', level: 'caution', title: 'Getting soft', detail: 'Hold steadier' });
      }
    }

    if (s.brightness < T.darkBad) {
      out.push({ id: 'dark', level: 'bad', title: 'Too dark', detail: 'Turn on the torch or find light' });
    } else if (s.brightness < T.darkCaution) {
      out.push({ id: 'dark', level: 'caution', title: 'Dim', detail: 'More light will help' });
    } else if (s.clipped > T.clippedBad) {
      out.push({ id: 'glare', level: 'bad', title: 'Glare', detail: 'Angle away from the light' });
    } else if (s.brightness > T.brightCaution) {
      out.push({ id: 'glare', level: 'caution', title: 'Very bright', detail: 'Watch for glare' });
    }

    if (recording && this.direction) {
      const backwards = this.direction === 'right' ? this.vx > T.reverseSpeed : this.vx < -T.reverseSpeed;
      if (backwards) {
        out.push({
          id: 'reverse',
          level: 'bad',
          title: 'Wrong way',
          detail: 'Going back counts stock twice',
          arrow: this.direction,
        });
      }
    }

    if (tilt != null && Math.abs(tilt) >= T.tiltCaution) {
      const level = Math.abs(tilt) >= T.tiltBad ? 'bad' : 'caution';
      out.push(
        tilt > 0
          ? { id: 'tilt-down', level, title: 'Tilt down', detail: 'Keep the phone upright', arrow: 'down' }
          : { id: 'tilt-up', level, title: 'Tilt up', detail: 'Keep the phone upright', arrow: 'up' },
      );
    } else if (Math.abs(this.vy) >= T.verticalCaution) {
      out.push({
        id: 'level',
        level: 'caution',
        title: 'Hold level',
        detail: 'Keep the shelf at one height',
        arrow: this.vy > 0 ? 'up' : 'down',
      });
    }

    if (recording && this.logScale > T.distanceBand) {
      out.push({ id: 'back', level: 'caution', title: 'Step back', detail: 'Keep a steady distance', arrow: 'out' });
    } else if (recording && this.logScale < -T.distanceBand) {
      out.push({ id: 'closer', level: 'caution', title: 'Move closer', detail: 'Keep a steady distance', arrow: 'in' });
    }

    return out;
  }

  private slowArrow(): Arrow | undefined {
    return this.direction ?? undefined;
  }

  private debounce(raw: Cue[], t: number): Cue[] {
    const now = new Map(raw.map((c) => [c.id, c]));
    for (const id of new Set<CueId>([...this.cues.keys(), ...now.keys()])) {
      const st = this.cues.get(id) ?? { since: null, lastTrue: -Infinity, active: false, cue: null };
      const cue = now.get(id);
      if (cue) {
        st.since ??= t;
        st.lastTrue = t;
        st.cue = cue;
        if (!st.active && t - st.since >= ENTER_S) st.active = true;
        // A bad cue is urgent: show it immediately.
        if (cue.level === 'bad') st.active = true;
      } else {
        st.since = null;
        if (st.active && t - st.lastTrue >= EXIT_S) st.active = false;
      }
      this.cues.set(id, st);
    }
    const rank = { bad: 0, caution: 1 } as const;
    return [...this.cues.values()]
      .filter((s) => s.active && s.cue)
      .map((s) => s.cue!)
      .sort((a, b) => rank[a.level] - rank[b.level]);
  }
}
