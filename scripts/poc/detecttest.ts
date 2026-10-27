import { readFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import {
  detectPageQuad, grayscale, downscale, otsuThreshold, pageMask, traceBoundary,
  simplifyPath, convexHull, fitQuad, measureQuality, type PixelBuffer,
} from '../../src/lib/imageAnalysis';

const raw = readFileSync('tests/fixtures/page-photo.jpg');
const { data, width, height } = jpeg.decode(raw, { useTArray: true });
const src: PixelBuffer = { data: new Uint8ClampedArray(data), width, height };
console.log('image', width, height);
const small = downscale(src, 420);
const gray = grayscale(small);
const thr = otsuThreshold(gray);
const mask = pageMask(gray, small.width, small.height);
let on = 0; for (const v of mask) on += v;
console.log('otsu', thr, 'mask ratio', (on / mask.length).toFixed(3));
const contour = traceBoundary(mask, small.width, small.height);
console.log('contour pts', contour.length);
const closed = [...contour, contour[0]];
const eps = Math.max(1.5, contour.length * 0.012);
const simplified = simplifyPath(closed, eps);
const hull = convexHull(simplified.slice(0, -1));
console.log('simplified', simplified.length, 'hull', hull.length);
console.log('hull pts', hull.map(p => `${Math.round(p.x)},${Math.round(p.y)}`).join(' '));
const quad = fitQuad(hull, 0.2, small.width, small.height);
console.log('quad', JSON.stringify(quad));
console.log('detect', JSON.stringify(detectPageQuad(src, {})));
const q = measureQuality(src);
console.log('quality', q);
