import { describe, expect, it } from 'vitest';
import { frameSignaturesClose, makeFrameSignature, normalizeQuad } from '@/lib/cameraGeometry';

describe('camera geometry and frame identity', () => {
  it('normalises pixel coordinates for the preview overlay', () => {
    expect(normalizeQuad([
      { x: 48, y: 27 },
      { x: 432, y: 27 },
      { x: 432, y: 243 },
      { x: 48, y: 243 },
    ], 480, 270)).toEqual([
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.1 },
      { x: 0.9, y: 0.9 },
      { x: 0.1, y: 0.9 },
    ]);
  });

  it('rejects an invalid frame size and clamps out-of-frame points', () => {
    expect(normalizeQuad([{ x: 0, y: 0 }], 480, 270)).toBeNull();
    expect(normalizeQuad([
      { x: -10, y: 2 },
      { x: 500, y: 2 },
      { x: 500, y: 280 },
      { x: -10, y: 280 },
    ], 480, 270)?.[1]).toEqual({ x: 1, y: 2 / 270 });
  });

  it('matches the same visual page and detects meaningfully different content', () => {
    const width = 240;
    const height = 160;
    const pageA = makePageFrame(width, height, false);
    const pageAWithExposureShift = makePageFrame(width, height, false, 18);
    const pageAShifted = shiftFrame(pageA, width, height, 4);
    const pageB = makePageFrame(width, height, true);
    const signatureA = makeFrameSignature(pageA, width, height);
    const signatureAChangedExposure = makeFrameSignature(pageAWithExposureShift, width, height);
    const signatureAShifted = makeFrameSignature(pageAShifted, width, height);
    const signatureB = makeFrameSignature(pageB, width, height);

    expect(frameSignaturesClose(signatureA, signatureAChangedExposure)).toBe(true);
    expect(frameSignaturesClose(signatureA, signatureAShifted)).toBe(true);
    expect(frameSignaturesClose(signatureA, signatureB)).toBe(false);
  });

  it('does not treat missing signatures as equal', () => {
    expect(frameSignaturesClose(null, null)).toBe(false);
    expect(frameSignaturesClose([0.1, 0.2], [0.1])).toBe(false);
  });
});

function makePageFrame(width: number, height: number, reverse: boolean, brightnessOffset = 0): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inText = reverse
        ? (y % 24 >= 7 && y % 24 <= 12 && x % 70 < 34)
        : (y % 24 >= 7 && y % 24 <= 12 && x % 70 > 18);
      const value = Math.max(0, Math.min(255, (inText ? 42 : 236) + brightnessOffset));
      const offset = (y * width + x) * 4;
      pixels[offset] = value;
      pixels[offset + 1] = value;
      pixels[offset + 2] = value;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

function shiftFrame(source: Uint8ClampedArray, width: number, height: number, shiftX: number): Uint8ClampedArray {
  const shifted = new Uint8ClampedArray(source.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = (y * width + Math.max(0, x - shiftX)) * 4;
      const to = (y * width + x) * 4;
      shifted[to] = source[from];
      shifted[to + 1] = source[from + 1];
      shifted[to + 2] = source[from + 2];
      shifted[to + 3] = 255;
    }
  }
  return shifted;
}
