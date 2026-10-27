/// <reference lib="webworker" />
/**
 * CamScan — dedicated Computer Vision worker.
 *
 * Used by the live scanner for high-frequency page detection. Keeping this off
 * the main thread is what makes the capture button feel instant: the UI thread
 * only paints the overlay, while detection and quality analysis happen here.
 *
 * OpenCV.js *can* be loaded here for accelerated contours, but the pure-TS
 * implementation in `lib/imageAnalysis.ts` is always available and is what we
 * actually run — no 10 MB download on first paint, and identical behaviour in
 * tests. (`opencv.js` stays bundled for parity/future use.)
 */
import {
  detectPageQuad,
  downscale,
  measureQuality,
  qualityWarnings,
  rectSize,
  type PixelBuffer,
} from '../lib/imageAnalysis';

interface DetectMessage {
  type: 'detect';
  id: number;
  width: number;
  height: number;
  buffer: ArrayBuffer;
  /** Long edge used for detection (performance knob). */
  workingSize?: number;
}

interface RectifyMessage {
  type: 'rectify';
  id: number;
  width: number;
  height: number;
  buffer: ArrayBuffer;
  quad: Array<{ x: number; y: number }>;
  maxLongEdge?: number;
}

interface QualityMessage {
  type: 'quality';
  id: number;
  width: number;
  height: number;
  buffer: ArrayBuffer;
}

type Inbound = DetectMessage | RectifyMessage | QualityMessage;

interface Outbound {
  id: number;
  ok: boolean;
  error?: string;
  result?: unknown;
  timings: { detectionMs?: number; totalMs: number };
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function toPixelBuffer(width: number, height: number, buffer: ArrayBuffer): PixelBuffer {
  return { width, height, data: new Uint8ClampedArray(buffer) };
}

ctx.onmessage = (event: MessageEvent<Inbound>) => {
  const msg = event.data;
  const t0 = performance.now();
  try {
    if (msg.type === 'detect') {
      const src = toPixelBuffer(msg.width, msg.height, msg.buffer);
      const tDet = performance.now();
      const quad = detectPageQuad(src, { workingSize: msg.workingSize ?? 420 });
      const detectionMs = performance.now() - tDet;
      const quality = measureQuality(downscale(src, 240));
      const warnings = qualityWarnings(quality, quad.coverage);
      const out: Outbound = {
        id: msg.id,
        ok: true,
        result: { quad, quality, warnings, size: rectSize(src) },
        timings: { detectionMs: Math.round(detectionMs), totalMs: Math.round(performance.now() - t0) },
      };
      ctx.postMessage(out);
      return;
    }

    if (msg.type === 'quality') {
      const src = toPixelBuffer(msg.width, msg.height, msg.buffer);
      const quality = measureQuality(src);
      const out: Outbound = {
        id: msg.id,
        ok: true,
        result: { quality, warnings: qualityWarnings(quality) },
        timings: { totalMs: Math.round(performance.now() - t0) },
      };
      ctx.postMessage(out);
      return;
    }

    if (msg.type === 'rectify') {
      // Rectification is handled in the processing worker (full resolution).
      const out: Outbound = {
        id: msg.id,
        ok: false,
        error: 'rectify is handled by the processing worker',
        timings: { totalMs: Math.round(performance.now() - t0) },
      };
      ctx.postMessage(out);
    }
  } catch (err) {
    const out: Outbound = {
      id: msg.id,
      ok: false,
      error: (err as Error).message || String(err),
      timings: { totalMs: Math.round(performance.now() - t0) },
    };
    ctx.postMessage(out);
  }
};

export {};
