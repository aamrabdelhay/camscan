/**
 * CamScan — page detection, rectification and conservative enhancement.
 *
 * Everything in this file is **pure**: it operates on plain
 * `{ data, width, height }` pixel buffers so it can run identically in a Web
 * Worker (fast path) or under Vitest in Node (unit tests) without a DOM.
 *
 * What is implemented here (no OpenCV dependency):
 *  - Otsu binarisation + largest bright-region extraction
 *  - contour tracing (Moore neighbourhood) + Ramer–Douglas–Peucker simplify
 *  - quadrilateral fitting with validation (convexity, coverage, angle sanity)
 *  - projective rectification (bilinear sampling)
 *  - shadow/uneven-light flattening via a large-radius background division
 *  - levels stretch tuned per capture profile, with bleed-through damping
 *  - paper colour and ink colour sampling from the ORIGINAL pixels
 *  - quality metrics: sharpness (variance of Laplacian), brightness, contrast,
 *    glare/highlight ratio, coverage — used for live capture hints and for the
 *    "Needs review" decision
 *
 * OpenCV.js is still used elsewhere (see cv.worker.ts) for its faster
 * `findContours`/warp path when it loads successfully; this module is the
 * always-available, deterministic implementation and the one we unit-test.
 */
import type { NormBox, Point, Size } from './types';

export interface PixelBuffer {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface QuadResult {
  /** Corners in source-image coordinates, ordered TL, TR, BR, BL. */
  corners: [Point, Point, Point, Point] | null;
  /** 0..1 confidence that the detection is a real page boundary. */
  confidence: number;
  /** Fraction of the frame covered by the quad (0..1). */
  coverage: number;
  /** Why detection failed, when it did. */
  reason?: 'no-quad' | 'too-small' | 'not-convex' | 'low-contrast';
}

export interface QualityMetrics {
  /** Normalised sharpness 0..1 (variance of Laplacian / 500, clamped). */
  sharpness: number;
  /** Mean luminance 0..1. */
  brightness: number;
  /** RMS contrast 0..1. */
  contrast: number;
  /** Fraction of pixels that are near-saturated highlights. */
  glare: number;
  /** Fraction of pixels that are pure black (underside of the book). */
  darkRatio: number;
}

/* ------------------------------------------------------------------ */
/* Basic colour helpers                                                */
/* ------------------------------------------------------------------ */

export const luminanceAt = (data: Uint8ClampedArray, i: number): number =>
  (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);

export function grayscale(src: PixelBuffer): Uint8ClampedArray {
  const { data, width, height } = src;
  const out = new Uint8ClampedArray(width * height);
  for (let p = 0, i = 0; p < out.length; p++, i += 4) {
    out[p] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
  }
  return out;
}

/** Downscale by integer-ish factor using area averaging (fast, alias-free). */
export function downscale(src: PixelBuffer, targetLongEdge: number): PixelBuffer {
  const longEdge = Math.max(src.width, src.height);
  if (longEdge <= targetLongEdge) return src;
  const scale = targetLongEdge / longEdge;
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));
  const out = new Uint8ClampedArray(w * h * 4);
  const xRatio = src.width / w;
  const yRatio = src.height / h;
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor(y * yRatio);
    const sy1 = Math.min(src.height, Math.max(sy0 + 1, Math.floor((y + 1) * yRatio)));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor(x * xRatio);
      const sx1 = Math.min(src.width, Math.max(sx0 + 1, Math.floor((x + 1) * xRatio)));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        let idx = (sy * src.width + sx0) * 4;
        for (let sx = sx0; sx < sx1; sx++, idx += 4) {
          r += src.data[idx]; g += src.data[idx + 1]; b += src.data[idx + 2]; n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

/* ------------------------------------------------------------------ */
/* Otsu threshold                                                      */
/* ------------------------------------------------------------------ */

export function otsuThreshold(gray: Uint8ClampedArray): number {
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

/* ------------------------------------------------------------------ */
/* Largest connected bright component + contour                        */
/* ------------------------------------------------------------------ */

/** Result of "which blob is the page?" — kept for diagnostics. */
export interface MaskInfo {
  mask: Uint8Array;
  area: number;
  touchesBorder: boolean;
}


/** 3×3-ish separable morphological close, used to bridge ink lines. */
export function morphClose(mask: Uint8Array<ArrayBuffer>, width: number, height: number, r: number): Uint8Array<ArrayBuffer> {
  const dilated = morph(mask, width, height, r, true);
  return morph(dilated, width, height, r, false);
}

function morph(mask: Uint8Array<ArrayBuffer>, width: number, height: number, r: number, dilate: boolean): Uint8Array<ArrayBuffer> {
  const tmp = new Uint8Array(width * height);
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = dilate ? 0 : 1;
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= width) continue;
        const s = mask[y * width + xx];
        v = dilate ? (v | s) : (v & s);
      }
      tmp[y * width + x] = v;
    }
  }
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let v = dilate ? 0 : 1;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        const s = tmp[yy * width + x];
        v = dilate ? (v | s) : (v & s);
      }
      out[y * width + x] = v;
    }
  }
  return out as Uint8Array<ArrayBuffer>;
}

/** Correct implementation of largest-component mask extraction. */
export function pageMask(gray: Uint8ClampedArray, width: number, height: number): Uint8Array<ArrayBuffer> {
  const threshold = otsuThreshold(gray);
  let mask = new Uint8Array(width * height) as Uint8Array<ArrayBuffer>;
  for (let i = 0; i < gray.length; i++) mask[i] = gray[i] > threshold ? 1 : 0;
  mask = morphClose(mask, width, height, 2);

  const labels = new Int32Array(width * height);
  const stack = new Int32Array(width * height);
  const areas = new Map<number, number>();
  let nextLabel = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    nextLabel++;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = nextLabel;
    let area = 0;
    while (sp > 0) {
      const p = stack[--sp];
      area++;
      const x = p % width;
      const y = (p / width) | 0;
      if (x > 0) { const q = p - 1; if (mask[q] && !labels[q]) { labels[q] = nextLabel; stack[sp++] = q; } }
      if (x < width - 1) { const q = p + 1; if (mask[q] && !labels[q]) { labels[q] = nextLabel; stack[sp++] = q; } }
      if (y > 0) { const q = p - width; if (mask[q] && !labels[q]) { labels[q] = nextLabel; stack[sp++] = q; } }
      if (y < height - 1) { const q = p + width; if (mask[q] && !labels[q]) { labels[q] = nextLabel; stack[sp++] = q; } }
    }
    areas.set(nextLabel, area);
  }

  let bestLabel = 0;
  let bestArea = 0;
  for (const [label, area] of areas) {
    if (area > bestArea) { bestArea = area; bestLabel = label; }
  }
  const out = new Uint8Array(width * height) as Uint8Array<ArrayBuffer>;
  if (bestLabel) {
    for (let i = 0; i < labels.length; i++) if (labels[i] === bestLabel) out[i] = 1;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Contour tracing + simplification                                    */
/* ------------------------------------------------------------------ */

/**
 * Moore-neighbour boundary tracing of a binary mask (outer contour).
 * Returns pixel points in order, capped at `maxPoints` for safety.
 *
 * Used for the OpenCV-parity path and for debugging; the production detector
 * additionally extracts the four extreme corners (below), which is more robust
 * for pages whose edges are partly hidden by a book gutter.
 */
export function traceBoundary(mask: Uint8Array, width: number, height: number, maxPoints = 4000): Point[] {
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < width && y < height ? mask[y * width + x] : 0);
  // Find the first foreground pixel in scan order (top-most, left-most).
  let startX = -1;
  let startY = -1;
  for (let y = 0; y < height && startY < 0; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) { startX = x; startY = y; break; }
    }
  }
  if (startX < 0) return [];

  // 8-neighbourhood, clockwise starting east (screen coords, y down).
  const dirs = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const points: Point[] = [];
  let cx = startX;
  let cy = startY;
  let dir = 6; // came from "north" convention for the very first step
  const maxSteps = Math.min(width * height * 4, 400_000);
  for (let step = 0; step < maxSteps; step++) {
    points.push({ x: cx, y: cy });
    let moved = false;
    // Moore boundary following: start scanning from the neighbour we came in
    // through, rotating clockwise until the next foreground pixel.
    for (let k = 1; k <= 8; k++) {
      const d = (dir + k) % 8;
      const nx = cx + dirs[d][0];
      const ny = cy + dirs[d][1];
      if (at(nx, ny)) {
        dir = (d + 4) % 8; // direction we came from for the next pixel
        cx = nx;
        cy = ny;
        moved = true;
        break;
      }
    }
    if (!moved) break; // isolated pixel
    if (cx === startX && cy === startY) break;
    if (points.length >= maxPoints) break;
  }
  return points;
}

/** Ramer–Douglas–Peucker polyline simplification. */
export function simplifyPath(points: Point[], epsilon: number): Point[] {
  if (points.length < 3) return [...points];
  const first = points[0];
  const last = points[points.length - 1];
  let index = -1;
  let maxDist = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], first, last);
    if (d > maxDist) { maxDist = d; index = i; }
  }
  if (maxDist > epsilon) {
    const left = simplifyPath(points.slice(0, index + 1), epsilon);
    const right = simplifyPath(points.slice(index), epsilon);
    return [...left.slice(0, -1), ...right];
  }
  return [first, last];
}

export function perpendicularDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const norm = Math.hypot(dx, dy) || 1;
  return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / norm;
}

/** Convex hull (Andrew's monotone chain). */
export function convexHull(points: Point[]): Point[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return [...lower, ...upper];
}

/** Signed area of a polygon. */
export function polygonArea(points: Point[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area / 2);
}

/** Order 4 points as TL, TR, BR, BL (screen coordinates, y down). */
export function orderCorners(points: Point[]): [Point, Point, Point, Point] {
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
  const withAngle = points.map((p) => ({ p, a: Math.atan2(p.y - cy, p.x - cx) }));
  withAngle.sort((u, v) => u.a - v.a);
  const ordered = withAngle.map((w) => w.p);
  // Start at the point closest to the top-left corner, keeping winding order.
  let startIndex = 0;
  let bestScore = Infinity;
  ordered.forEach((p, i) => {
    const score = p.x + p.y;
    if (score < bestScore) { bestScore = score; startIndex = i; }
  });
  const rotated = [...ordered.slice(startIndex), ...ordered.slice(0, startIndex)];
  // Ensure clockwise (in screen coords TL→TR→BR→BL has positive shoelace sum).
  const signed = rotated.reduce((acc, p, i) => {
    const q = rotated[(i + 1) % 4];
    return acc + (p.x * q.y - q.x * p.y);
  }, 0);
  if (signed < 0) rotated.reverse();
  return [rotated[0], rotated[1], rotated[2], rotated[3]];
}

/**
 * Fit a quadrilateral to a simplified contour. We try every 4-combination of
 * *hull* vertices (usually < 20 after simplification) and keep the largest
 * valid, convex quad — far more tolerant of curved page edges near a spine
 * than a strict min-area rectangle.
 */
export function fitQuad(hull: Point[], minCoverage: number, width: number, height: number): QuadResult {
  const pts = hull.length > 3 ? hull : [];
  if (pts.length < 4) {
    return { corners: null, confidence: 0, coverage: 0, reason: 'no-quad' };
  }
  // Reduce vertex count for combinatorial search.
  const reduced = pts.length > 16
    ? simplifyPath([...pts, pts[0]], Math.max(2, perimeter(pts) / 40)).slice(0, -1)
    : pts;

  let best: { quad: [Point, Point, Point, Point]; area: number } | null = null;
  const n = reduced.length;
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      for (let c = b + 1; c < n; c++) {
        for (let d = c + 1; d < n; d++) {
          const candidate = [reduced[a], reduced[b], reduced[c], reduced[d]];
          const area = polygonArea(candidate);
          if (!best || area > best.area) {
            if (isConvexQuad(candidate) && area > 0) best = { quad: orderCorners(candidate), area };
          }
        }
      }
    }
  }
  if (!best) return { corners: null, confidence: 0, coverage: 0, reason: 'not-convex' };

  const coverage = best.area / (width * height);
  if (coverage < minCoverage) {
    return { corners: best.quad, confidence: 0.2, coverage, reason: 'too-small' };
  }

  // Confidence: coverage + angle regularity + how well the quad fills the mask.
  const angles = quadAngles(best.quad);
  const angleScore = angles.reduce((s, ang) => s + (1 - Math.min(1, Math.abs(ang - 90) / 45)), 0) / 4;
  const confidence = Math.max(0, Math.min(1, 0.45 + 0.35 * angleScore + 0.2 * Math.min(1, coverage)));
  return { corners: best.quad, confidence, coverage };
}

function perimeter(pts: Point[]): number {
  let p = 0;
  for (let i = 0; i < pts.length; i++) p += Math.hypot(pts[(i + 1) % pts.length].x - pts[i].x, pts[(i + 1) % pts.length].y - pts[i].y);
  return p;
}

export function isConvexQuad(quad: Point[]): boolean {
  const signs: number[] = [];
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const c = quad[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    signs.push(Math.sign(cross));
  }
  return signs.every((s) => s > 0) || signs.every((s) => s < 0);
}

export function quadAngles(quad: Point[]): number[] {
  return quad.map((p, i) => {
    const a = quad[(i + 3) % 4];
    const b = quad[(i + 1) % 4];
    const v1 = { x: a.x - p.x, y: a.y - p.y };
    const v2 = { x: b.x - p.x, y: b.y - p.y };
    const dot = v1.x * v2.x + v1.y * v2.y;
    const m = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) || 1;
    return (Math.acos(Math.max(-1, Math.min(1, dot / m))) * 180) / Math.PI;
  });
}

/* ------------------------------------------------------------------ */
/* Full-page detection pipeline                                        */
/* ------------------------------------------------------------------ */

export interface DetectOptions {
  /** Working resolution for detection (long edge). Lower = faster. */
  workingSize?: number;
  /** Minimum fraction of the frame the page must cover. */
  minCoverage?: number;
}

/**
 * Detect the page quadrilateral in a frame.
 * Returns corners in *source* coordinates (scaled back up from the working res).
 */
export function detectPageQuad(src: PixelBuffer, options: DetectOptions = {}): QuadResult {
  const { workingSize = 420, minCoverage = 0.18 } = options;
  const small = downscale(src, workingSize);
  const gray = grayscale(small);
  const mask = pageMask(gray, small.width, small.height);
  const quad = quadFromMask(mask, small.width, small.height, minCoverage);
  if (!quad.corners) return quad;

  const scaleX = src.width / small.width;
  const scaleY = src.height / small.height;
  const corners = quad.corners.map((p) => ({ x: p.x * scaleX, y: p.y * scaleY })) as [Point, Point, Point, Point];
  return { ...quad, corners };
}

/**
 * Derive a quadrilateral from a page mask using the four *extreme* corners.
 *
 * For each of the four diagonal directions (↘, ↙, ↗, ↖) we take the pixels
 * with the highest score, average the top 0.4 % of them, and treat that as a
 * corner. This is much more tolerant than a min-area rectangle when the page
 * curves into a gutter or a finger covers an edge — exactly the fragile-book
 * case we care about.
 */
export function quadFromMask(mask: Uint8Array, width: number, height: number, minCoverage = 0.18): QuadResult {
  const pts: Point[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) pts.push({ x, y });
    }
  }
  if (pts.length < 200) return { corners: null, confidence: 0, coverage: pts.length / (width * height), reason: 'no-quad' };

  const corners = extractExtremeCorners(pts);
  if (!corners) return { corners: null, confidence: 0, coverage: pts.length / (width * height), reason: 'not-convex' };

  const area = polygonArea(corners);
  const coverage = area / (width * height);
  if (coverage < minCoverage) {
    return { corners, confidence: 0.15, coverage, reason: 'too-small' };
  }

  // Confidence = coverage + corner angle regularity + convexity.
  const angles = quadAngles(corners);
  const angleScore = angles.reduce((acc, a) => acc + Math.max(0, 1 - Math.abs(a - 90) / 55), 0) / 4;
  const convex = isConvexQuad(corners) ? 1 : 0.4;
  const confidence = Math.max(0, Math.min(1, 0.35 + 0.4 * angleScore * convex + 0.25 * Math.min(1, coverage / 0.6)));
  return { corners, confidence, coverage };
}

/** Average the top-N most extreme pixels along each diagonal direction. */
export function extractExtremeCorners(points: Point[]): [Point, Point, Point, Point] | null {
  const n = Math.max(6, Math.round(points.length * 0.004));
  const scores: Array<(p: Point) => number> = [
    (p) => p.x + p.y,          // top-left  (min)
    (p) => p.x - p.y,          // top-right (max)
    (p) => p.x + p.y,          // bottom-right (max)
    (p) => p.x - p.y,          // bottom-left (min)
  ];
  const picks: Point[] = [];
  const ops: Array<'min' | 'max'> = ['min', 'max', 'max', 'min'];
  for (let i = 0; i < 4; i++) {
    const scored = points
      .map((p) => ({ p, s: scores[i](p) }))
      .sort((a, b) => (ops[i] === 'min' ? a.s - b.s : b.s - a.s))
      .slice(0, n);
    const avg = scored.reduce((acc, cur) => ({ x: acc.x + cur.p.x / n, y: acc.y + cur.p.y / n }), { x: 0, y: 0 });
    picks.push(avg);
  }
  // De-duplicate corners that collapsed onto the same spot (a cut-off page).
  const uniq: Point[] = [];
  for (const p of picks) {
    if (!uniq.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 8)) uniq.push(p);
  }
  if (uniq.length < 4) return null;
  const ordered = orderCorners(uniq);
  return isConvexQuad(ordered) ? ordered : null;
}

/** Do two quads describe (roughly) the same page? Used for capture de-dup. */
export function quadsSimilar(a: Point[], b: Point[], tolerance = 0.045): boolean {
  if (a.length !== b.length) return false;
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y);
  return total / a.length < tolerance;
}

/* ------------------------------------------------------------------ */
/* Rectification                                                       */
/* ------------------------------------------------------------------ */

/** Solve the 8 unknowns of a projective transform (unit square → quad). */
export function solveHomography(src: [Point, Point, Point, Point], dst: [Point, Point, Point, Point]): number[] {
  // Build 8×8 linear system A·h = b, solved by Gaussian elimination.
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let row = col + 1; row < 8; row++) {
      if (Math.abs(A[row][col]) > Math.abs(A[pivot][col])) pivot = row;
    }
    if (Math.abs(A[pivot][col]) < 1e-10) return [1, 0, 0, 0, 1, 0, 0, 0];
    [A[col], A[pivot]] = [A[pivot], A[col]];
    [b[col], b[pivot]] = [b[pivot], b[col]];
    const pv = A[col][col];
    for (let k = col; k < 8; k++) A[col][k] /= pv;
    b[col] /= pv;
    for (let row = 0; row < 8; row++) {
      if (row === col) continue;
      const f = A[row][col];
      if (!f) continue;
      for (let k = col; k < 8; k++) A[row][k] -= f * A[col][k];
      b[row] -= f * b[col];
    }
  }
  return b;
}

export interface RectifyOptions {
  /** Output long-edge size in pixels (bounds processing cost & storage). */
  maxLongEdge?: number;
}

export interface RectifiedPage {
  buffer: PixelBuffer;
  /** Corners actually used, in source coordinates. */
  quad: [Point, Point, Point, Point] | null;
  /** True when the full frame was used (no reliable detection). */
  usedFullFrame: boolean;
}

/**
 * Perspective-correct the detected quad into a rectangular pixel buffer.
 * Output size keeps the *measured* aspect ratio of the quad (average of
 * opposite edges), so the replica keeps the physical page proportions.
 */
export function rectifyPage(src: PixelBuffer, quad: QuadResult, options: RectifyOptions = {}): RectifiedPage {
  const { maxLongEdge = 2000 } = options;
  const corners = quad.corners;
  if (!corners || quad.confidence < 0.25) {
    const scaled = downscale(src, maxLongEdge);
    return { buffer: scaled, quad: null, usedFullFrame: true };
  }

  const [tl, tr, br, bl] = corners;
  const topW = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const bottomW = Math.hypot(br.x - bl.x, br.y - bl.y);
  const leftH = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  const rightH = Math.hypot(br.x - tr.x, br.y - tr.y);
  let outW = Math.round((topW + bottomW) / 2);
  let outH = Math.round((leftH + rightH) / 2);
  const longEdge = Math.max(outW, outH);
  if (longEdge > maxLongEdge) {
    const k = maxLongEdge / longEdge;
    outW = Math.round(outW * k);
    outH = Math.round(outH * k);
  }
  outW = Math.max(16, outW);
  outH = Math.max(16, outH);

  // Homography from the unit square to the source quad.
  const h = solveHomography(
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
    [tl, tr, br, bl],
  );

  const out = new Uint8ClampedArray(outW * outH * 4);
  const { data, width, height } = src;
  for (let y = 0; y < outH; y++) {
    const v = (y + 0.5) / outH;
    for (let x = 0; x < outW; x++) {
      const u = (x + 0.5) / outW;
      const denom = h[6] * u + h[7] * v + 1;
      const sx = (h[0] * u + h[1] * v + h[2]) / denom;
      const sy = (h[3] * u + h[4] * v + h[5]) / denom;
      sampleBilinear(data, width, height, sx, sy, out, (y * outW + x) * 4);
    }
  }
  return { buffer: { data: out, width: outW, height: outH }, quad: corners, usedFullFrame: false };
}

function sampleBilinear(
  data: Uint8ClampedArray, width: number, height: number,
  sx: number, sy: number, out: Uint8ClampedArray, o: number,
): void {
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(sx)));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(sy)));
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, sx - x0));
  const fy = Math.max(0, Math.min(1, sy - y0));
  const i00 = (y0 * width + x0) * 4;
  const i10 = (y0 * width + x1) * 4;
  const i01 = (y1 * width + x0) * 4;
  const i11 = (y1 * width + x1) * 4;
  for (let c = 0; c < 3; c++) {
    const top = data[i00 + c] * (1 - fx) + data[i10 + c] * fx;
    const bottom = data[i01 + c] * (1 - fx) + data[i11 + c] * fx;
    out[o + c] = top * (1 - fy) + bottom * fy;
  }
  out[o + 3] = 255;
}

/* ------------------------------------------------------------------ */
/* Colour sampling                                                     */
/* ------------------------------------------------------------------ */

export interface ColorSample {
  paper: { r: number; g: number; b: number };
  ink: { r: number; g: number; b: number };
}

/**
 * Sample paper + ink colours from the ORIGINAL (pre-enhancement) rectified page.
 * Paper = median of the brightest 45 % of pixels; ink = median of the darkest
 * 3 % — this preserves the true yellow of old paper instead of assuming white.
 */
export function sampleColors(src: PixelBuffer): ColorSample {
  const { data, width, height } = src;
  // Sample the interior only: page edges carry shadows and the desk behind.
  const insetX = Math.floor(width * 0.06);
  const insetY = Math.floor(height * 0.06);
  const interior: number[] = [];
  for (let y = insetY; y < height - insetY; y += 1) {
    for (let x = insetX; x < width - insetX; x += 1) interior.push((y * width + x) * 4);
  }
  const lum = new Float64Array(interior.length);
  for (let p = 0; p < interior.length; p++) lum[p] = luminanceAt(data, interior[p]);
  const sorted = Array.from(lum).sort((a, b) => a - b);
  const paperThresh = sorted[Math.floor(sorted.length * 0.55)];
  const inkThresh = sorted[Math.max(0, Math.floor(sorted.length * 0.012))];

  const paper = collectMedian(data, lum, (v) => v >= paperThresh, interior);
  let ink = collectMedian(data, lum, (v) => v <= inkThresh, interior);

  /**
   * Guard against a bad ink sample: if the "ink" is not clearly darker than the
   * paper (e.g. a page of very faint print, or mostly blank), derive the ink
   * colour from the paper instead of returning an illegible mid-grey.
   * We still store the sampled value in the model's provenance for honesty.
   */
  const paperLum = paper.r * 0.299 + paper.g * 0.587 + paper.b * 0.114;
  const inkLum = ink.r * 0.299 + ink.g * 0.587 + ink.b * 0.114;
  if (paperLum > 0 && inkLum > paperLum * 0.28) {
    const k = 0.16; // ~84 % darker than the paper, keeping its hue
    ink = {
      r: Math.round(paper.r * k),
      g: Math.round(paper.g * k),
      b: Math.round(paper.b * k * 1.05),
    };
  }
  return { paper, ink };
}

function collectMedian(
  data: Uint8ClampedArray,
  lum: Float64Array,
  predicate: (v: number) => boolean,
  indices?: number[],
): { r: number; g: number; b: number } {
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const step = Math.max(1, Math.floor(lum.length / 60000)); // cap work for huge pages
  for (let p = 0; p < lum.length; p += step) {
    if (!predicate(lum[p])) continue;
    const i = indices ? indices[p] : p * 4;
    rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]);
  }
  const median = (arr: number[]) => {
    if (!arr.length) return 0;
    arr.sort((a, b) => a - b);
    return arr[Math.floor(arr.length / 2)];
  };
  if (!rs.length) return { r: 245, g: 240, b: 225 };
  return { r: median(rs), g: median(gs), b: median(bs) };
}

/* ------------------------------------------------------------------ */
/* Enhancement                                                         */
/* ------------------------------------------------------------------ */

export type EnhanceProfile = 'standard' | 'fragile' | 'smallPrint' | 'fadedInk' | 'historical';

export interface EnhanceOptions {
  profile?: EnhanceProfile;
  /** 0..1 strength of the background flattening (default depends on profile). */
  shadowStrength?: number;
}

/**
 * Conservative enhancement applied to the **derived** processed image only.
 * The original capture is never modified. Steps:
 *  1. Estimate the illumination field with a huge box blur (integral image).
 *  2. Divide it out (removes shadows / vignetting without clipping ink).
 *  3. Stretch levels between robust ink/paper percentiles.
 *  4. Bleed-through damping: lift very light grey marks back toward paper.
 */
export function enhancePage(src: PixelBuffer, options: EnhanceOptions = {}): PixelBuffer {
  const { profile = 'standard', shadowStrength } = options;
  const { width, height, data } = src;

  /**
   * Per-profile parameters. `paper` is the target luminance of the paper after
   * flattening; `gamma` < 1 darkens mid-tones (good for faded ink) and
   * `inkFloor` clamps so we never blow faint strokes to pure white.
   */
  const params: Record<EnhanceProfile, { shadow: number; paper: number; inkPct: number; paperPct: number; gamma: number; inkFloor: number }> = {
    standard:    { shadow: 0.9, paper: 242, inkPct: 0.02, paperPct: 0.72, gamma: 1.0,  inkFloor: 12 },
    fragile:     { shadow: 0.95, paper: 238, inkPct: 0.015, paperPct: 0.78, gamma: 1.0, inkFloor: 10 },
    smallPrint:  { shadow: 0.85, paper: 246, inkPct: 0.03, paperPct: 0.68, gamma: 0.95, inkFloor: 14 },
    fadedInk:    { shadow: 0.8, paper: 240, inkPct: 0.06, paperPct: 0.6, gamma: 0.82, inkFloor: 20 },
    historical:  { shadow: 0.75, paper: 234, inkPct: 0.015, paperPct: 0.8, gamma: 1.05, inkFloor: 8 },
  };
  const p = params[profile];
  const shadow = shadowStrength ?? p.shadow;

  const gray = new Float32Array(width * height);
  for (let i = 0, q = 0; q < gray.length; q++, i += 4) gray[q] = luminanceAt(data, i);

  // Integral image → O(1) local mean for the illumination field.
  const integral = new Float64Array((width + 1) * (height + 1));
  for (let y = 1; y <= height; y++) {
    let rowSum = 0;
    for (let x = 1; x <= width; x++) {
      rowSum += gray[(y - 1) * width + (x - 1)];
      integral[y * (width + 1) + x] = integral[(y - 1) * (width + 1) + x] + rowSum;
    }
  }
  // A large radius is essential: the background must follow lighting gradients
  // (spine shadow, vignette) but NOT individual text lines.
  const radius = Math.max(16, Math.floor(Math.max(width, height) / 8));
  const boxMean = (x: number, y: number) => {
    const x0 = Math.max(0, x - radius);
    const y0 = Math.max(0, y - radius);
    const x1 = Math.min(width, x + radius + 1);
    const y1 = Math.min(height, y + radius + 1);
    const area = (x1 - x0) * (y1 - y0);
    return (integral[y1 * (width + 1) + x1] - integral[y0 * (width + 1) + x1]
      - integral[y1 * (width + 1) + x0] + integral[y0 * (width + 1) + x0]) / area;
  };

  // Pass 1: divide out the illumination field (multiplicative shading model).
  const flat = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const bg = boxMean(x, y) || 1;
      const gain = 1 + shadow * (p.paper / Math.max(bg, p.paper * 0.75) - 1);
      flat[idx] = Math.min(255, Math.max(0, gray[idx] * gain));
    }
  }

  // Pass 2: robust level stretch between the ink and paper percentiles.
  const sorted = Float32Array.from(flat).sort();
  const lo = sorted[Math.floor(sorted.length * p.inkPct)] ?? 0;
  const hi = Math.max(lo + 8, sorted[Math.floor(sorted.length * p.paperPct)] ?? 255);
  const span = hi - lo;
  const invGamma = 1 / p.gamma;
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    let n = (v - lo) / span;                 // 0..1
    n = Math.max(0, Math.min(1, n));
    n = Math.pow(n, invGamma);               // gamma correction
    // Keep ink darker than the floor so faint strokes survive; keep paper warm.
    const out = Math.max(p.inkFloor * (1 - n), n * 255);
    lut[v] = Math.max(0, Math.min(255, Math.round(out)));
  }

  // Apply the LUT to the *colour* channels scaled by the per-pixel luminance
  // change, so sepia/brown ink stays coloured instead of turning grey.
  const out = new Uint8ClampedArray(data.length);
  for (let idx = 0; idx < gray.length; idx++) {
    const target = lut[Math.max(0, Math.min(255, Math.round(flat[idx])))];
    const ratio = gray[idx] > 0.5 ? target / gray[idx] : 1;
    const o = idx * 4;
    out[o] = data[o] * ratio;
    out[o + 1] = data[o + 1] * ratio;
    out[o + 2] = data[o + 2] * ratio;
    out[o + 3] = 255;
  }
  return { data: out, width, height };
}

/* ------------------------------------------------------------------ */
/* Quality metrics                                                     */
/* ------------------------------------------------------------------ */

/**
 * Variance-of-Laplacian sharpness + exposure stats.
 * Normalised: sharpness 0..1 where ≥0.35 is generally sharp enough for OCR.
 */
export function measureQuality(src: PixelBuffer): QualityMetrics {
  const small = downscale(src, 480);
  const gray = grayscale(small);
  const { width, height } = small;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < gray.length; i++) { sum += gray[i]; sumSq += gray[i] * gray[i]; }
  const mean = sum / gray.length;
  const variance = Math.max(0, sumSq / gray.length - mean * mean);

  // Laplacian on the interior.
  let lapSum = 0;
  let lapSq = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const lap = -4 * gray[i] + gray[i - 1] + gray[i + 1] + gray[i - width] + gray[i + width];
      lapSum += lap;
      lapSq += lap * lap;
      count++;
    }
  }
  const lapMean = lapSum / Math.max(1, count);
  const lapVar = Math.max(0, lapSq / Math.max(1, count) - lapMean * lapMean);

  let highlights = 0;
  let darks = 0;
  for (let i = 0; i < gray.length; i++) {
    if (gray[i] > 248) highlights++;
    if (gray[i] < 12) darks++;
  }

  return {
    sharpness: Math.max(0, Math.min(1, lapVar / 650)),
    brightness: mean / 255,
    contrast: Math.sqrt(variance) / 128,
    glare: highlights / gray.length,
    darkRatio: darks / gray.length,
  };
}

/**
 * Translate metrics into human, actionable warnings.
 * Deliberately conservative: only complain when it matters for OCR.
 */
export function qualityWarnings(q: QualityMetrics, coverage?: number): Array<'blurry' | 'too-dark' | 'too-bright' | 'glare' | 'cut-off'> {
  const out: Array<'blurry' | 'too-dark' | 'too-bright' | 'glare' | 'cut-off'> = [];
  if (q.sharpness < 0.08) out.push('blurry');
  if (q.brightness < 0.28) out.push('too-dark');
  if (q.brightness > 0.93) out.push('too-bright');
  if (q.glare > 0.12) out.push('glare');
  if (coverage !== undefined && coverage < 0.3) out.push('cut-off');
  return out;
}

/* ------------------------------------------------------------------ */
/* Layout hints from the rectified page                                */
/* ------------------------------------------------------------------ */

export interface LayoutHints {
  /** Fraction of the page that contains ink (0..1). */
  inkDensity: number;
  /** Estimated printed area as a normalised box. */
  contentBox: NormBox;
  /** Whether text appears to be in two columns. */
  columns: number;
  /** Estimated stroke thickness relative to median line height (boldness). */
  strokeRatio: number;
  /** Estimated font category (weak, honest heuristic). */
  fontCategory: 'naskh' | 'kufi' | 'serif' | 'sans' | 'mono';
  /** Whether the page looks mostly empty (blank page). */
  likelyBlank: boolean;
}

/**
 * Coarse layout analysis on the (already rectified + enhanced) page.
 * This feeds block classification and typography hints; it is *not* a full
 * layout analyser and never invents structure that isn't visible.
 */
export function analyzeLayout(src: PixelBuffer, direction: 'rtl' | 'ltr'): LayoutHints {
  const small = downscale(src, 700);
  const gray = grayscale(small);
  const { width, height } = small;
  const threshold = Math.max(90, otsuThreshold(gray));

  // Row ink profile — used to find text bands and the content box.
  const rowInk = new Float32Array(height);
  let totalInk = 0;
  for (let y = 0; y < height; y++) {
    let c = 0;
    for (let x = 0; x < width; x++) if (gray[y * width + x] < threshold) c++;
    rowInk[y] = c;
    totalInk += c;
  }
  const inkDensity = totalInk / (width * height);

  // Content box from rows/cols with meaningful ink.
  const minRowInk = Math.max(2, width * 0.005);
  let top = 0;
  let bottom = height - 1;
  while (top < height && rowInk[top] < minRowInk) top++;
  while (bottom > top && rowInk[bottom] < minRowInk) bottom--;

  const colInk = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    let c = 0;
    for (let y = top; y <= bottom; y++) if (gray[y * width + x] < threshold) c++;
    colInk[x] = c;
  }
  const minColInk = Math.max(1, (bottom - top) * 0.004);
  let left = 0;
  let right = width - 1;
  while (left < width && colInk[left] < minColInk) left++;
  while (right > left && colInk[right] < minColInk) right--;

  const contentBox: NormBox = {
    x: Math.max(0, left / width),
    y: Math.max(0, top / height),
    w: Math.min(1, Math.max(0.05, (right - left) / width)),
    h: Math.min(1, Math.max(0.05, (bottom - top) / height)),
  };

  // Column detection: find a vertical whitespace valley inside the content box.
  let columns = 1;
  if (contentBox.w > 0.5 && bottom - top > height * 0.3) {
    const midStart = Math.floor(width * 0.38);
    const midEnd = Math.floor(width * 0.62);
    let valley = Infinity;
    for (let x = midStart; x < midEnd; x++) {
      // Ignore gutters that only exist in a single band.
      const avg = colInk[x] / Math.max(1, bottom - top);
      valley = Math.min(valley, avg);
    }
    const sideInk = (colInk[Math.floor(width * 0.15)] + colInk[Math.floor(width * 0.85)]) / 2 / Math.max(1, bottom - top);
    if (valley < sideInk * 0.22 && sideInk > 0.06) columns = 2;
  }

  // Stroke ratio: ink area / (ink area's perimeter proxy). Bold text has a
  // higher fill ratio inside its bounding rows.
  const textBandRows = Array.from(rowInk).filter((v) => v > minRowInk);
  const meanRowInk = textBandRows.length ? textBandRows.reduce((a, b) => a + b, 0) / textBandRows.length : 0;
  const fillRatio = meanRowInk / width;
  const strokeRatio = Math.max(0, Math.min(1, fillRatio * 6));

  // Very weak serif/sans heuristic for Latin: serifs add ink at line ends.
  // For Arabic we default to naskh (by far the most common printed style).
  let fontCategory: LayoutHints['fontCategory'] = direction === 'rtl' ? 'naskh' : 'serif';
  if (direction !== 'rtl' && strokeRatio > 0.55) fontCategory = 'sans';

  return {
    inkDensity,
    contentBox,
    columns,
    strokeRatio,
    fontCategory,
    likelyBlank: inkDensity < 0.0015,
  };
}

/* ------------------------------------------------------------------ */
/* Page model → region boxes for OCR                                   */
/* ------------------------------------------------------------------ */

/**
 * Convert detected attribute boxes (from the recognition worker) into
 * normalised boxes, dropping degenerate ones. Sorted top-to-bottom.
 */
export function normalizeBoxes(
  boxes: Array<{ x0: number; y0: number; x1: number; y1: number }>,
  width: number,
  height: number,
): NormBox[] {
  return boxes
    .map((b) => ({
      x: Math.max(0, Math.min(1, b.x0 / width)),
      y: Math.max(0, Math.min(1, b.y0 / height)),
      w: Math.max(0, Math.min(1, (b.x1 - b.x0) / width)),
      h: Math.max(0, Math.min(1, (b.y1 - b.y0) / height)),
    }))
    .filter((b) => b.w > 0.004 && b.h > 0.004)
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

/** Estimate the page's aspect ratio from a set of corner points. */
export function quadAspect(corners: Point[]): number {
  if (corners.length !== 4) return 0.72;
  const [tl, tr, br, bl] = corners;
  const topW = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const bottomW = Math.hypot(br.x - bl.x, br.y - bl.y);
  const leftH = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  const rightH = Math.hypot(br.x - tr.x, br.y - tr.y);
  const w = (topW + bottomW) / 2;
  const h = (leftH + rightH) / 2;
  return h > 0 ? w / h : 0.72;
}

export function rectSize(src: Size): Size {
  return { width: src.width, height: src.height };
}
