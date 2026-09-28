/// <reference types="node" />
/**
 * The analysis core is plain TypeScript, so it is tested under Node directly:
 *   npm test
 * Frames here are synthetic with known answers: a shelf pattern we shift by
 * a known amount, blur by a known kernel, or darken to a known level.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { GuidanceEngine, THRESHOLDS } from './guidance.ts';
import {
  blurAtBackendScale,
  downsample,
  edgeBoxes,
  estimateShift,
  projections,
  rotateLuma,
  sampleFrame,
  type FrameSample,
  type Luma,
} from './metrics.ts';

const W = 960;
const H = 540;

/** A shelf: grey wall, dark-outlined cartons with a pale label, repeating. */
function shelf(offset = 0, value = 1): Uint8Array {
  const img = new Uint8Array(W * H).fill(Math.round(150 * value));
  const pitch = 142;
  for (let row = 0; row < 3; row++) {
    const y0 = 30 + row * 175;
    for (let k = -2; k < 10; k++) {
      // Irregular widths so the pattern is not perfectly periodic.
      const x0 = k * pitch + ((k * 37) % 23) - offset;
      const bw = 96 + ((k * 13) % 9);
      for (let y = y0; y < y0 + 130; y++) {
        for (let x = Math.max(0, x0); x < Math.min(W, x0 + bw); x++) {
          const edge = y < y0 + 3 || y >= y0 + 127 || x < x0 + 3 || x >= x0 + bw - 3;
          const label = y > y0 + 24 && y < y0 + 52 && x > x0 + 16 && x < x0 + bw - 16;
          img[y * W + x] = Math.round((edge ? 30 : label ? 235 : 60 + ((k * 40 + row * 70) % 120)) * value);
        }
      }
    }
  }
  return img;
}

/** Separable box blur, radius r. */
function blur(img: Uint8Array, r: number): Uint8Array {
  const tmp = new Float32Array(W * H);
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0;
      let n = 0;
      for (let d = -r; d <= r; d++) {
        const xx = x + d;
        if (xx >= 0 && xx < W) {
          s += img[y * W + xx]!;
          n++;
        }
      }
      tmp[y * W + x] = s / n;
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0;
      let n = 0;
      for (let d = -r; d <= r; d++) {
        const yy = y + d;
        if (yy >= 0 && yy < H) {
          s += tmp[yy * W + x]!;
          n++;
        }
      }
      out[y * W + x] = s / n;
    }
  }
  return out;
}

test('blur separates sharp from blurred on the backend scale', () => {
  const sharp = blurAtBackendScale(shelf(), W, H, W, 1);
  const soft = blurAtBackendScale(blur(shelf(), 6), W, H, W, 1);
  assert.ok(sharp > THRESHOLDS.blurBad * 4, `sharp ${sharp}`);
  assert.ok(soft < THRESHOLDS.blurBad, `blurred ${soft}`);
});

test('blur is resolution-independent: a 2x source reads the same', () => {
  const small = shelf();
  const big = new Uint8Array(W * 2 * H * 2);
  for (let y = 0; y < H * 2; y++) for (let x = 0; x < W * 2; x++) big[y * W * 2 + x] = small[(y >> 1) * W + (x >> 1)]!;
  const a = blurAtBackendScale(small, W, H, W, 1);
  const b = blurAtBackendScale(big, W * 2, H * 2, W * 2, 1);
  assert.ok(Math.abs(a - b) / a < 0.1, `${a} vs ${b}`);
});

test('RGBA input gives the same luma metrics as grayscale', () => {
  const g = shelf();
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) rgba.set([g[i]!, g[i]!, g[i]!, 255], i * 4);
  const a = sampleFrame(g, W, H, W, 1, 0, false);
  const b = sampleFrame(rgba, W, H, W * 4, 4, 0, false);
  assert.ok(Math.abs(a.brightness - b.brightness) < 1);
  assert.ok(Math.abs(a.blur - b.blur) / a.blur < 0.02);
});

test('horizontal shift is recovered, including past one carton pitch of aliasing', () => {
  const a = projections(downsample(shelf(0), W, H, W, 1));
  for (const px of [6, 24, 48]) {
    const b = projections(downsample(shelf(px), W, H, W, 1));
    // px at 960 is px/6 at the 160 px analysis width; content moves left.
    const s = estimateShift(a.cols, b.cols, 40, -px / 6);
    assert.ok(Math.abs(s.shift - -px / 6) < 1, `moved ${px}: got ${s.shift}`);
    assert.ok(s.confidence > 0.3, `confidence ${s.confidence}`);
  }
});

test('edge preview outlines cartons and drops their labels', () => {
  let full = 0; // cartons wholly inside the frame, from the same layout as shelf()
  for (let row = 0; row < 3; row++) {
    for (let k = -2; k < 10; k++) {
      const x0 = k * 142 + ((k * 37) % 23);
      if (x0 > 6 && x0 + 96 + ((k * 13) % 9) < W - 6) full++;
    }
  }
  const boxes = edgeBoxes(downsample(shelf(), W, H, W, 1));
  // A preview at 160 px: most cartons, never more than exist.
  assert.ok(boxes.length >= full - 3 && boxes.length <= full, `found ${boxes.length} of ${full}`);
  // No box sits inside another (labels are nested inside cartons).
  for (const b of boxes) {
    const nested = boxes.some((o) => o !== b && b.x >= o.x && b.y >= o.y && b.x + b.w <= o.x + o.w && b.y + b.h <= o.y + o.h);
    assert.equal(nested, false);
  }
});

// -- guidance -------------------------------------------------------------

function run(frames: (i: number) => Uint8Array, n: number, fps = 10, opts: { tilt?: number; recording?: boolean } = {}) {
  const engine = new GuidanceEngine();
  let g;
  for (let i = 0; i < n; i++) {
    const s: FrameSample = sampleFrame(frames(i), W, H, W, 1, i / fps, false);
    g = engine.update({ sample: s, tiltDeg: opts.tilt ?? null, recording: opts.recording ?? true });
  }
  return g!;
}

test('a steady, sharp, well-lit walk is "Quality good"', () => {
  const g = run((i) => shelf(i * 6), 20); // 6 px/frame at 10 fps = 0.06 frame widths/s
  assert.equal(g.status, 'good', JSON.stringify(g.cues));
  assert.equal(g.label, 'Quality good');
});

test('walking too fast raises "Too fast"', () => {
  const g = run((i) => shelf(i * 90), 12); // 0.94 frame widths/s
  assert.equal(g.pace, 'bad');
  assert.ok(g.cues.some((c) => c.id === 'fast'), JSON.stringify(g.cues));
});

test('a blurred but still view blames the lens, after it persists', () => {
  const soft = blur(shelf(), 6);
  const early = run(() => soft, 5); // 0.4 s: not yet
  assert.ok(!early.cues.some((c) => c.id === 'lens'));
  const later = run(() => soft, 20); // 1.9 s
  assert.ok(later.cues.some((c) => c.id === 'lens'), JSON.stringify(later.cues));
});

test('darkness and tilt produce their cues', () => {
  const dark = run(() => shelf(0, 0.25), 8);
  assert.ok(dark.cues.some((c) => c.id === 'dark' && c.level === 'bad'));
  const tilted = run((i) => shelf(i * 6), 8, 10, { tilt: -30 });
  assert.ok(tilted.cues.some((c) => c.id === 'tilt-up' && c.arrow === 'up'));
});

test('walking back over counted stock is flagged', () => {
  // 1.5 s rightwards establishes the direction, then back at ~0.19 frame widths/s.
  const g = run((i) => shelf(i < 15 ? i * 12 : 180 - (i - 15) * 18), 25);
  assert.equal(g.hud.direction, 'right');
  assert.ok(g.cues.some((c) => c.id === 'reverse'), JSON.stringify(g.cues));
});

// -- orientation ----------------------------------------------------------

/** Rotate a full frame 90° anticlockwise: what a portrait phone's landscape sensor delivers. */
function sensorBuffer(upright: Uint8Array): Uint8Array {
  const out = new Uint8Array(W * H);
  // Output is H wide and W tall; output (x, y) = upright (W - 1 - y, x).
  for (let y = 0; y < W; y++) for (let x = 0; x < H; x++) out[y * H + x] = upright[x * W + (W - 1 - y)]!;
  return out;
}

test('rotateLuma is a clockwise quarter turn and four of them are the identity', () => {
  const l = { data: Uint8Array.from([1, 2, 3, 4, 5, 6]), width: 3, height: 2 };
  // 1 2 3        4 1
  // 4 5 6   ->   5 2
  //              6 3
  assert.deepEqual([...rotateLuma(l, 90).data], [4, 1, 5, 2, 6, 3]);
  let r: Luma = l;
  for (let i = 0; i < 4; i++) r = rotateLuma(r, 90);
  assert.deepEqual([...r.data], [...l.data]);
  assert.deepEqual([...rotateLuma(l, 180).data], [6, 5, 4, 3, 2, 1]);
  assert.deepEqual([...rotateLuma(rotateLuma(l, 90), 270).data], [...l.data]);
});

test('a walk filmed on a sideways sensor reads as horizontal once rotated', () => {
  const engine = new GuidanceEngine();
  let g;
  for (let i = 0; i < 20; i++) {
    const buf = sensorBuffer(shelf(i * 12)); // H wide, W tall
    const s = sampleFrame(buf, H, W, H, 1, i / 10, false, 90);
    assert.equal(s.srcWidth, W);
    assert.equal(s.srcHeight, H);
    g = engine.update({ sample: s, tiltDeg: null, recording: true });
  }
  // Content moves left at 0.125 frame widths/s: a steady walk to the right.
  assert.ok(g!.hud.speed < -0.08, `speed ${g!.hud.speed}`);
  assert.ok(Math.abs(g!.hud.vertical) < 0.05, `vertical ${g!.hud.vertical}`);
  assert.equal(g!.hud.direction, 'right');
});

test('outlines persist between measurements and follow the pan', () => {
  const engine = new GuidanceEngine();
  const a = engine.update({ sample: sampleFrame(shelf(0), W, H, W, 1, 0, true), tiltDeg: null, recording: false });
  assert.ok(a.boxes.length > 5, `measured ${a.boxes.length}`);
  // Next sample skips outlines; the content moved 24 px left (0.025 of the width).
  const b = engine.update({ sample: sampleFrame(shelf(24), W, H, W, 1, 0.1, false), tiltDeg: null, recording: false });
  assert.equal(b.boxes.length, a.boxes.length);
  const moved = b.boxes[0]!.x - a.boxes[0]!.x;
  assert.ok(Math.abs(moved - -24 / W) < 0.01, `moved ${moved}`);
});
