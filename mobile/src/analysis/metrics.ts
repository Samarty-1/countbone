/**
 * Frame metrics for live capture guidance.
 *
 * Plain TypeScript over a small grayscale buffer, with no React and no
 * platform APIs, so the same code runs in a VisionCamera worklet, in the
 * browser preview, and under `node --test`. Every function here is written
 * to be worklet-safe: no closures over module state, no classes.
 *
 * Definitions match the countbone backend (stages/preprocess.py) where one
 * exists, so "blurry" on the phone means what the quality gate means by it:
 *   blur     variance of the 3x3 Laplacian (cv2.Laplacian ksize=1)
 *   bright   mean luminance 0-255
 *   clipped  fraction of pixels <= 4 or >= 251
 * The backend measures at 960 px wide; this runs at ANALYSIS_WIDTH, so the
 * thresholds in guidance.ts are calibrated for this width, not copied.
 */

export const ANALYSIS_WIDTH = 160;

export interface Luma {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Area-average a luma (1 byte/px) or RGBA (4 bytes/px) buffer down to
 * `targetWidth`, keeping aspect. `stride` is bytes per row of the source.
 */
export function downsample(
  src: Uint8Array | Uint8ClampedArray,
  srcW: number,
  srcH: number,
  stride: number,
  bytesPerPixel: 1 | 4,
  targetWidth: number = ANALYSIS_WIDTH,
): Luma {
  'worklet';
  const w = Math.max(1, Math.min(targetWidth, srcW));
  const h = Math.max(1, Math.round((srcH * w) / srcW));
  const out = new Uint8Array(w * h);
  const sx = srcW / w;
  const sy = srcH / h;
  // Sample a fixed grid inside each cell rather than every pixel: an average
  // of 4x4 points is plenty for these metrics and ~20x cheaper at 1080p.
  const n = 4;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let j = 0; j < n; j++) {
        const py = Math.min(srcH - 1, Math.floor((y + (j + 0.5) / n) * sy));
        const row = py * stride;
        for (let i = 0; i < n; i++) {
          const px = Math.min(srcW - 1, Math.floor((x + (i + 0.5) / n) * sx));
          const o = row + px * bytesPerPixel;
          sum +=
            bytesPerPixel === 1
              ? src[o]!
              : // Rec.601 luma, the same weights OpenCV's BGR2GRAY uses.
                0.299 * src[o]! + 0.587 * src[o + 1]! + 0.114 * src[o + 2]!;
        }
      }
      out[y * w + x] = sum / (n * n);
    }
  }
  return { data: out, width: w, height: h };
}

/**
 * The backend resizes frames to 960 px wide (capture.resize_width) before its
 * quality gate measures blur. Measuring blur on a 160 px thumbnail does not
 * work: the downsample itself removes the fine detail blur destroys, and on
 * calibration footage sharp and badly blurred frames overlapped completely.
 * So blur is measured at that same 960 px scale (blurAtBackendScale), which
 * lets the phone use the gate's own threshold and mean the same thing:
 * on calibration frames the two agree within 1%.
 */
export const BACKEND_WIDTH = 960;

/**
 * Laplacian variance of the whole frame as the backend would measure it
 * after resizing to BACKEND_WIDTH, without allocating that resized frame.
 *
 * A centre crop is not enough: when the centre falls between two cartons
 * the crop is blank and reads as blurred while the frame is sharp. The
 * whole-frame value matches the gate; evaluating it on every other row and
 * column (an unbiased sample of the same statistic) keeps it cheap enough
 * to run per frame on a phone.
 */
export function blurAtBackendScale(
  src: Uint8Array | Uint8ClampedArray,
  srcW: number,
  srcH: number,
  stride: number,
  bytesPerPixel: 1 | 4,
): number {
  'worklet';
  const step = srcW / BACKEND_WIDTH; // source px per backend px
  const outW = BACKEND_WIDTH;
  const outH = Math.round(srcH / step);
  const taps = step >= 2 ? 2 : 1;
  // Luma at backend pixel (x, y), box-averaged when shrinking (like INTER_AREA).
  const at = (x: number, y: number): number => {
    'worklet';
    let s = 0;
    for (let j = 0; j < taps; j++) {
      const py = Math.min(srcH - 1, Math.floor((y + (j + 0.5) / taps) * step));
      for (let i = 0; i < taps; i++) {
        const px = Math.min(srcW - 1, Math.floor((x + (i + 0.5) / taps) * step));
        const o = py * stride + px * bytesPerPixel;
        s += bytesPerPixel === 1 ? src[o]! : 0.299 * src[o]! + 0.587 * src[o + 1]! + 0.114 * src[o + 2]!;
      }
    }
    return s / (taps * taps);
  };
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < outH - 1; y += 2) {
    for (let x = 1; x < outW - 1; x += 2) {
      const v = at(x, y - 1) + at(x, y + 1) + at(x - 1, y) + at(x + 1, y) - 4 * at(x, y);
      sum += v;
      sumSq += v * v;
      n++;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/** Variance of the 3x3 Laplacian. Low means soft focus or motion blur. */
export function laplacianVariance(l: Luma): number {
  'worklet';
  const { data, width: w, height: h } = l;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = data[i - w]! + data[i + w]! + data[i - 1]! + data[i + 1]! - 4 * data[i]!;
      sum += v;
      sumSq += v * v;
      n++;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

export function exposure(l: Luma): { brightness: number; clipped: number } {
  'worklet';
  let sum = 0;
  let clipped = 0;
  const { data } = l;
  for (let i = 0; i < data.length; i++) {
    const v = data[i]!;
    sum += v;
    if (v <= 4 || v >= 251) clipped++;
  }
  return { brightness: sum / data.length, clipped: clipped / data.length };
}

/** Mean of each column and each row, mean-removed (robust to exposure changes). */
export function projections(l: Luma): { cols: Float32Array; rows: Float32Array } {
  'worklet';
  const { data, width: w, height: h } = l;
  const cols = new Float32Array(w);
  const rows = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = data[y * w + x]!;
      cols[x] += v;
      rows[y] += v;
    }
  }
  let cm = 0;
  for (let x = 0; x < w; x++) cm += (cols[x]! /= h);
  cm /= w;
  for (let x = 0; x < w; x++) cols[x]! -= cm;
  let rm = 0;
  for (let y = 0; y < h; y++) rm += (rows[y]! /= w);
  rm /= h;
  for (let y = 0; y < h; y++) rows[y]! -= rm;
  return { cols, rows };
}

export interface Shift {
  /** Content displacement from `prev` to `curr`, in analysis pixels (+ = right/down). */
  shift: number;
  /**
   * 0..1: how much better the chosen shift explains the change than a typical
   * candidate does. Near 0 on a featureless wall, where no shift is trustworthy.
   */
  confidence: number;
}

/**
 * Global 1-D displacement between two projection profiles by minimising the
 * mean absolute difference over the overlap.
 *
 * Shelves are periodic (a row of identical cartons), so a shift one carton
 * pitch away can match almost as well as the true one. `prior` is the last
 * measured shift: real camera motion is smooth, so candidates far from it
 * pay a penalty. This is the same aliasing the backend's phase correlation
 * has to survive, solved the cheap way.
 */
export function estimateShift(
  prev: Float32Array,
  curr: Float32Array,
  maxShift: number,
  prior = 0,
  priorWeight = 0.35,
): Shift {
  'worklet';
  const n = Math.min(prev.length, curr.length);
  const minOverlap = Math.max(8, Math.floor(n * 0.4));
  let bestS = 0;
  let best = Infinity;
  let bestRaw = Infinity;
  const costs: number[] = [];
  const raws: number[] = [];
  let scale = 0;
  for (let i = 0; i < n; i++) scale += Math.abs(prev[i]!);
  scale = scale / n || 1;
  for (let s = -maxShift; s <= maxShift; s++) {
    let acc = 0;
    let cnt = 0;
    for (let i = Math.max(0, -s); i < n && i + s < n; i++) {
      acc += Math.abs(prev[i]! - curr[i + s]!);
      cnt++;
    }
    if (cnt < minOverlap) {
      costs.push(Infinity);
      continue;
    }
    const raw = acc / cnt / scale;
    raws.push(raw);
    const cost = raw + (priorWeight * Math.abs(s - prior)) / Math.max(1, maxShift);
    costs.push(cost);
    if (cost < best) {
      best = cost;
      bestS = s;
      bestRaw = raw;
    }
  }
  // Parabolic refinement to sub-pixel.
  const k = bestS + maxShift;
  const c0 = costs[k - 1];
  const c1 = costs[k];
  const c2 = costs[k + 1];
  let refined = bestS;
  if (c0 != null && c2 != null && c1 != null && Number.isFinite(c0) && Number.isFinite(c2)) {
    const denom = c0 - 2 * c1 + c2;
    if (denom > 1e-9) refined = bestS + (0.5 * (c0 - c2)) / denom;
  }
  raws.sort((a, b) => a - b);
  const typical = raws[Math.floor(raws.length / 2)] ?? 0;
  const confidence = typical > 1e-6 ? Math.max(0, Math.min(1, 1 - bestRaw / typical)) : 0;
  return { shift: refined, confidence };
}

/**
 * Relative zoom between two row profiles: > 1 means the scene got bigger
 * (camera moved closer). Row profiles barely change under a horizontal pan,
 * which is what isolates distance from walking.
 */
export function estimateScale(prev: Float32Array, curr: Float32Array): number {
  'worklet';
  const n = Math.min(prev.length, curr.length);
  const c = (n - 1) / 2;
  let bestScale = 1;
  let best = Infinity;
  for (let k = -6; k <= 6; k++) {
    const s = 1 + k * 0.01;
    let acc = 0;
    let cnt = 0;
    for (let i = 0; i < n; i++) {
      // Where row i of `prev` lands in `curr` if the scene scaled by s about the centre.
      const j = c + (i - c) * s;
      const j0 = Math.floor(j);
      if (j0 < 0 || j0 + 1 >= n) continue;
      const f = j - j0;
      const v = curr[j0]! * (1 - f) + curr[j0 + 1]! * f;
      acc += Math.abs(prev[i]! - v);
      cnt++;
    }
    if (cnt < n * 0.6) continue;
    const cost = acc / cnt;
    if (cost < best) {
      best = cost;
      bestScale = s;
    }
  }
  return bestScale;
}

/**
 * Cheap on-device object outlines for the viewfinder preview: Sobel edges,
 * connected components, then drop anything nested inside a bigger outline
 * (a carton's label inside the carton). A preview of what the detector will
 * see, not the count; the count happens on the server.
 */
export function edgeBoxes(l: Luma, maxBoxes = 40): Box[] {
  'worklet';
  const { data, width: w, height: h } = l;
  const mag = new Float32Array(w * h);
  let sum = 0;
  let sumSq = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx =
        data[i - w + 1]! + 2 * data[i + 1]! + data[i + w + 1]! - data[i - w - 1]! - 2 * data[i - 1]! - data[i + w - 1]!;
      const gy =
        data[i + w - 1]! + 2 * data[i + w]! + data[i + w + 1]! - data[i - w - 1]! - 2 * data[i - w]! - data[i - w + 1]!;
      const m = Math.abs(gx) + Math.abs(gy);
      mag[i] = m;
      sum += m;
      sumSq += m * m;
    }
  }
  const n = (w - 2) * (h - 2);
  const mean = sum / n;
  const sd = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  const thr = Math.max(60, mean + 1.5 * sd);

  const label = new Int32Array(w * h).fill(-1);
  const stack = new Int32Array(w * h);
  const boxes: Box[] = [];
  for (let start = 0; start < w * h; start++) {
    if (label[start] !== -1 || mag[start]! < thr) continue;
    let top = 0;
    stack[top++] = start;
    label[start] = boxes.length;
    let x0 = w;
    let y0 = h;
    let x1 = 0;
    let y1 = 0;
    let count = 0;
    while (top > 0) {
      const p = stack[--top]!;
      const px = p % w;
      const py = (p - px) / w;
      count++;
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (py < y0) y0 = py;
      if (py > y1) y1 = py;
      // 8-connected, with a one-pixel bridge so hairline gaps in an outline join up.
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const qx = px + dx;
          const qy = py + dy;
          if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
          const q = qy * w + qx;
          if (label[q] === -1 && mag[q]! >= thr) {
            label[q] = boxes.length;
            stack[top++] = q;
          }
        }
      }
    }
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    const aspect = bw / bh;
    const areaFrac = (bw * bh) / (w * h);
    const touchesEdge = x0 <= 1 || y0 <= 1 || x1 >= w - 2 || y1 >= h - 2;
    boxes.push(
      count >= 8 && bw >= 5 && bh >= 5 && aspect >= 0.2 && aspect <= 5 && areaFrac <= 0.3 && !touchesEdge
        ? { x: x0, y: y0, w: bw, h: bh }
        : { x: -1, y: -1, w: 0, h: 0 },
    );
  }
  const real = boxes.filter((b) => b.w > 0);
  const kept = real.filter(
    (b) =>
      !real.some(
        (o) => o !== b && o.w * o.h > b.w * b.h && b.x >= o.x && b.y >= o.y && b.x + b.w <= o.x + o.w && b.y + b.h <= o.y + o.h,
      ),
  );
  kept.sort((a, b) => b.w * b.h - a.w * a.h);
  return kept.slice(0, maxBoxes);
}

export interface FrameSample {
  /** Seconds, from the camera clock. */
  t: number;
  srcWidth: number;
  srcHeight: number;
  /** Laplacian variance at the backend's 960 px scale (same scale as its quality gate). */
  blur: number;
  /** Mean luminance 0-255. */
  brightness: number;
  /** Fraction of pixels crushed or blown out. */
  clipped: number;
  /** Luminance standard deviation of the thumbnail: near 0 on a blank wall. */
  contrast: number;
  /** Column / row projection profiles of the thumbnail (for motion). */
  cols: number[];
  rows: number[];
  thumbWidth: number;
  thumbHeight: number;
  /** Edge-preview outlines, normalised to 0..1 of the frame. */
  boxes: Box[];
}

/**
 * Everything measured from one frame, in one pass, stateless: the worklet on
 * native and the canvas loop on web both call this and hand the result to the
 * guidance engine on the JS thread. Motion needs the previous frame, so it is
 * not computed here; the profiles it needs travel with the sample.
 */
export function sampleFrame(
  src: Uint8Array | Uint8ClampedArray,
  srcW: number,
  srcH: number,
  stride: number,
  bytesPerPixel: 1 | 4,
  t: number,
  withBoxes: boolean,
): FrameSample {
  'worklet';
  const thumb = downsample(src, srcW, srcH, stride, bytesPerPixel);
  const { brightness, clipped } = exposure(thumb);
  let sq = 0;
  for (let i = 0; i < thumb.data.length; i++) {
    const d = thumb.data[i]! - brightness;
    sq += d * d;
  }
  const { cols, rows } = projections(thumb);
  const boxes = withBoxes
    ? edgeBoxes(thumb).map((b) => ({
        x: b.x / thumb.width,
        y: b.y / thumb.height,
        w: b.w / thumb.width,
        h: b.h / thumb.height,
      }))
    : [];
  return {
    t,
    srcWidth: srcW,
    srcHeight: srcH,
    blur: blurAtBackendScale(src, srcW, srcH, stride, bytesPerPixel),
    brightness,
    clipped,
    contrast: Math.sqrt(sq / thumb.data.length),
    cols: Array.from(cols),
    rows: Array.from(rows),
    thumbWidth: thumb.width,
    thumbHeight: thumb.height,
    boxes,
  };
}
