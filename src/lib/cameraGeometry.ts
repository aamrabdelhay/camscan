import type { Point } from './types';

const SIGNATURE_COLUMNS = 24;

/**
 * Convert page corners produced by imageAnalysis (source pixels) to the
 * normalised 0..1 coordinates used by the preview overlay and stability logic.
 */
export function normalizeQuad(
  corners: readonly Point[] | null | undefined,
  width: number,
  height: number,
): Point[] | null {
  if (!corners || corners.length !== 4 || width <= 0 || height <= 0) return null;
  return corners.map((point) => ({
    x: clamp(point.x / width, 0, 1),
    y: clamp(point.y / height, 0, 1),
  }));
}

/**
 * Compact, exposure-normalised signature of a camera frame. The grid averages
 * small pixel regions so sensor noise is damped while a turned page still
 * changes the signature even when the page boundary stays in the same place.
 */
export function makeFrameSignature(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
): number[] {
  if (width < 1 || height < 1 || rgba.length < width * height * 4) return [];

  const columns = SIGNATURE_COLUMNS;
  const rows = Math.max(8, Math.round((columns * height) / width));
  const cells: number[] = [];

  for (let row = 0; row < rows; row++) {
    const y0 = Math.floor((row * height) / rows);
    const y1 = Math.max(y0 + 1, Math.floor(((row + 1) * height) / rows));
    for (let column = 0; column < columns; column++) {
      const x0 = Math.floor((column * width) / columns);
      const x1 = Math.max(x0 + 1, Math.floor(((column + 1) * width) / columns));
      let sum = 0;
      let count = 0;
      // A 5x5 sampling grid averages local detail and is less sensitive to
      // one-pixel camera jitter than a sparse hash of exact coordinates.
      for (let sy = 0; sy < 5; sy++) {
        const y = Math.min(height - 1, y0 + Math.floor(((sy + 0.5) * (y1 - y0)) / 5));
        for (let sx = 0; sx < 5; sx++) {
          const x = Math.min(width - 1, x0 + Math.floor(((sx + 0.5) * (x1 - x0)) / 5));
          const offset = (y * width + x) * 4;
          sum += (0.2126 * rgba[offset] + 0.7152 * rgba[offset + 1] + 0.0722 * rgba[offset + 2]) / 255;
          count++;
        }
      }
      cells.push(sum / count);
    }
  }

  const mean = cells.reduce((sum, value) => sum + value, 0) / cells.length;
  const variance = cells.reduce((sum, value) => sum + (value - mean) ** 2, 0) / cells.length;
  const scale = Math.max(0.12, Math.sqrt(variance) * 2.4);

  // Removing global brightness/contrast makes a stable page compare similarly
  // when the phone's auto-exposure shifts slightly between frames.
  return cells.map((value) => clamp(0.5 + (value - mean) / scale, 0, 1));
}

/** True when two normalised frame signatures depict effectively the same page. */
export function frameSignaturesClose(
  a: readonly number[] | null | undefined,
  b: readonly number[] | null | undefined,
  tolerance = 0.08,
): boolean {
  if (!a || !b || a.length === 0 || a.length !== b.length) return false;
  let distance = 0;
  for (let i = 0; i < a.length; i++) distance += Math.abs(a[i] - b[i]);
  return distance / a.length <= tolerance;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
