'use client';
/**
 * CamScan — camera + live detection hook.
 *
 * Responsibilities
 *  - getUserMedia lifecycle (rear camera preferred, best supported resolution,
 *    torch capability detection, device switching)
 *  - frame sampling at a resource-appropriate rate (default 8 fps) sent to the
 *    CV worker so detection never blocks the UI thread
 *  - stability tracking + auto-capture decision (≈0.5 s of stable, sharp,
 *    well-exposed, fully-visible page)
 *  - de-duplication (cooldown + visual frame signature) so a held page isn't
 *    captured twice while a page turn at the same camera angle remains eligible
 *  - instant capture: grab the full-resolution frame, hand it to the caller,
 *    and return to ready immediately
 *
 * Honest behaviour: if `getUserMedia` is unavailable or denied we surface a
 * typed error — we never pretend a stream is live.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Point } from './types';
import type { QualityMetrics } from './imageAnalysis';
import { frameSignaturesClose, makeFrameSignature, normalizeQuad } from './cameraGeometry';

export type CameraStatus =
  | 'idle'
  | 'requesting'
  | 'live'
  | 'paused'
  | 'denied'
  | 'unavailable'
  | 'insecure'
  | 'error';

export type CaptureHint =
  | 'none'
  | 'no-page'
  | 'hold-steady'
  | 'blurry'
  | 'too-dark'
  | 'too-bright'
  | 'glare'
  | 'cut-off'
  | 'move-closer';

export interface DetectedQuad {
  /** Corners in normalised video coordinates (0..1) for overlay drawing. */
  points: Point[];
  coverage: number;
  confidence: number;
}

export interface CameraState {
  status: CameraStatus;
  error?: string;
  devices: MediaDeviceInfo[];
  activeDeviceId?: string;
  torchSupported: boolean;
  torchOn: boolean;
  /** Latest detection result (null when nothing found). */
  quad: DetectedQuad | null;
  quality: QualityMetrics | null;
  hint: CaptureHint;
  /** 0..1 progress toward auto-capture (only > 0 while a page is stable). */
  stability: number;
  /** Frames per second actually being analysed. */
  detectionFps: number;
  videoSize: { width: number; height: number };
}

export interface CapturedFrame {
  blob: Blob;
  width: number;
  height: number;
  quad: Point[] | null;
  quality: QualityMetrics | null;
  /** ms from shutter trigger to blob ready (for the <300 ms budget). */
  captureMs: number;
}

export interface UseCameraOptions {
  /** ms of stability required before auto-capture. */
  stableMs?: number;
  /** ms after a capture during which auto-capture is suppressed. */
  cooldownMs?: number;
  /** Called with the full-resolution frame; may be async but is not awaited. */
  onCapture: (frame: CapturedFrame) => void;
  autoCaptureEnabled: boolean;
  /** JPEG quality for the capture (0..1). */
  jpegQuality?: number;
}

interface DetectResponse {
  id: number;
  ok: boolean;
  error?: string;
  result?: {
    quad: { corners: Point[] | null; confidence: number; coverage: number; reason?: string };
    quality: QualityMetrics;
    warnings: string[];
    size: { width: number; height: number };
  };
}

const DETECT_INTERVAL_MS = 125; // ≈8 fps — plenty for a page held in front of a lens

export function useCamera(options: UseCameraOptions) {
  const { stableMs = 500, cooldownMs = 1600, onCapture, autoCaptureEnabled, jpegQuality = 0.92 } = options;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastDetectRef = useRef(0);
  const detectBusyRef = useRef(false);
  const msgIdRef = useRef(1);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stableSinceRef = useRef<number | null>(null);
  const lastQuadRef = useRef<Point[] | null>(null);
  const lastCaptureAtRef = useRef(0);
  const lastCaptureSignatureRef = useRef<number[] | null>(null);
  const lastFrameSignatureRef = useRef<number[] | null>(null);
  const currentFrameSignatureRef = useRef<number[] | null>(null);
  const detectionSizeRef = useRef({ width: 480, height: 270 });
  const capturingRef = useRef(false);
  const autoRef = useRef(autoCaptureEnabled);
  const onCaptureRef = useRef(onCapture);
  const pausedRef = useRef(false);

  useEffect(() => { autoRef.current = autoCaptureEnabled; }, [autoCaptureEnabled]);
  useEffect(() => { onCaptureRef.current = onCapture; }, [onCapture]);

  const [state, setState] = useState<CameraState>({
    status: 'idle',
    devices: [],
    torchSupported: false,
    torchOn: false,
    quad: null,
    quality: null,
    hint: 'none',
    stability: 0,
    detectionFps: 0,
    videoSize: { width: 0, height: 0 },
  });

  /* ---------------- worker ---------------- */
  const ensureWorker = useCallback(() => {
    if (workerRef.current) return workerRef.current;
    const worker = new Worker('/workers/cv.worker.js', { type: 'module' });
    worker.onmessage = (event: MessageEvent<DetectResponse>) => {
      const data = event.data;
      detectBusyRef.current = false;
      if (!data.ok || !data.result) {
        lastQuadRef.current = null;
        lastFrameSignatureRef.current = null;
        stableSinceRef.current = null;
        setState((s) => (s.hint === 'no-page' && s.quad === null ? s : { ...s, quad: null, hint: 'no-page', stability: 0 }));
        return;
      }
      const { quad, quality, warnings } = data.result;
      // imageAnalysis returns source-pixel coordinates; the UI/thresholds use 0..1.
      const points = normalizeQuad(quad.corners, detectionSizeRef.current.width, detectionSizeRef.current.height);
      const frameSignature = currentFrameSignatureRef.current;
      const now = performance.now();

      // ----- stability / de-dup logic -----
      // Page bounds can stay static while a leaf is turning. Require both the
      // geometry and page appearance to be stable before the shutter can fire.
      const stableAppearance = frameSignaturesClose(frameSignature, lastFrameSignatureRef.current, 0.075);
      const similar = Boolean(
        points
        && lastQuadRef.current
        && quadsClose(points, lastQuadRef.current, 0.03)
        && stableAppearance,
      );
      if (similar) {
        if (stableSinceRef.current === null) stableSinceRef.current = now;
      } else {
        stableSinceRef.current = null;
      }
      lastQuadRef.current = points;
      lastFrameSignatureRef.current = frameSignature ? [...frameSignature] : null;

      const sinceCapture = now - lastCaptureAtRef.current;
      // A fixed camera often sees the next leaf at the exact same geometry.
      // Compare page appearance instead of suppressing by quadrilateral alone.
      const samePageAsLast = frameSignaturesClose(frameSignature, lastCaptureSignatureRef.current, 0.04);

      let hint: CaptureHint = 'none';
      const severity = {
        blurry: quality.sharpness < 0.08,
        'too-dark': quality.brightness < 0.28,
        'too-bright': quality.brightness > 0.93,
        glare: quality.glare > 0.12,
        'cut-off': quad.coverage < 0.3,
        'move-closer': quad.coverage < 0.45 && quad.coverage >= 0.3,
      };
      if (!points || quad.confidence < 0.35) hint = 'no-page';
      else if (severity['cut-off']) hint = 'cut-off';
      else if (severity.blurry) hint = 'blurry';
      else if (severity['too-dark']) hint = 'too-dark';
      else if (severity['too-bright']) hint = 'too-bright';
      else if (severity.glare) hint = 'glare';
      else if (severity['move-closer']) hint = 'move-closer';
      else if (warnings.length) hint = 'hold-steady';

      const stableFor = stableSinceRef.current !== null ? now - stableSinceRef.current : 0;
      const stability = Math.max(0, Math.min(1, stableFor / stableMs));

      setState((s) => ({
        ...s,
        quad: points ? { points, coverage: quad.coverage, confidence: quad.confidence } : null,
        quality,
        hint,
        stability,
        detectionFps: data.result ? Math.round(1000 / Math.max(1, now - lastDetectRef.current)) : s.detectionFps,
      }));

      // ----- auto-capture trigger -----
      const ready = Boolean(
        points
        && quad.confidence >= 0.5
        && stableFor >= stableMs
        && hint === 'none'
        && sinceCapture > cooldownMs
        && !samePageAsLast
        && autoRef.current
        && !pausedRef.current
        && !capturingRef.current,
      );
      if (ready) void triggerCapture();
    };
    worker.onerror = () => {
      detectBusyRef.current = false;
    };
    workerRef.current = worker;
    return worker;
  }, [cooldownMs, stableMs]);

  /* ---------------- detection loop ---------------- */
  const loop = useCallback(() => {
    rafRef.current = requestAnimationFrame(loop);
    const video = videoRef.current;
    if (!video || video.readyState < 2 || pausedRef.current) return;
    const now = performance.now();
    if (now - lastDetectRef.current < DETECT_INTERVAL_MS || detectBusyRef.current) return;
    lastDetectRef.current = now;

    // Downscale into a reusable canvas for cheap transfer to the worker.
    const targetW = 480;
    const scale = targetW / video.videoWidth;
    const w = targetW;
    const h = Math.max(1, Math.round(video.videoHeight * scale));
    if (!canvasRef.current) canvasRef.current = document.createElement('canvas');
    const canvas = canvasRef.current;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, w, h);
    const imageData = ctx.getImageData(0, 0, w, h);
    detectionSizeRef.current = { width: w, height: h };
    currentFrameSignatureRef.current = makeFrameSignature(imageData.data, w, h);

    const worker = ensureWorker();
    detectBusyRef.current = true;
    const id = msgIdRef.current++;
    worker.postMessage(
      { type: 'detect', id, width: w, height: h, buffer: imageData.data.buffer, workingSize: 420 },
      [imageData.data.buffer],
    );
  }, [ensureWorker]);

  /* ---------------- capture ---------------- */
  const triggerCapture = useCallback(async (): Promise<CapturedFrame | null> => {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || capturingRef.current) return null;
    capturingRef.current = true;
    const started = performance.now();
    try {
      // IMPORTANT: capture at full sensor resolution, not the preview size.
      const width = video.videoWidth;
      const height = video.videoHeight;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('canvas unavailable');
      ctx.drawImage(video, 0, 0, width, height);

      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', jpegQuality),
      );
      if (!blob) throw new Error('capture failed');

      const frame: CapturedFrame = {
        blob,
        width,
        height,
        quad: lastQuadRef.current,
        quality: state.quality,
        captureMs: Math.round(performance.now() - started),
      };

      lastCaptureAtRef.current = performance.now();
      lastCaptureSignatureRef.current = currentFrameSignatureRef.current ? [...currentFrameSignatureRef.current] : null;
      stableSinceRef.current = null;

      // Fire-and-forget: the UI returns to ready immediately.
      void Promise.resolve(onCaptureRef.current(frame)).catch(() => undefined);
      return frame;
    } finally {
      capturingRef.current = false;
    }
  }, [jpegQuality, state.quality]);

  /* ---------------- start / stop ---------------- */
  const stop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setState((s) => ({ ...s, status: 'idle', quad: null, hint: 'none', stability: 0 }));
  }, []);

  const start = useCallback(async (deviceId?: string) => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setState((s) => ({ ...s, status: 'unavailable', error: 'getUserMedia unavailable' }));
      return;
    }
    if (!window.isSecureContext) {
      setState((s) => ({ ...s, status: 'insecure', error: 'secure context required' }));
      return;
    }
    setState((s) => ({ ...s, status: 'requesting', error: undefined }));
    try {
      // Stop any previous stream before opening a new device.
      streamRef.current?.getTracks().forEach((t) => t.stop());

      const constraints: MediaStreamConstraints = {
        audio: false,
        video: deviceId
          ? { deviceId: { exact: deviceId }, width: { ideal: 3840 }, height: { ideal: 2160 } }
          : {
              facingMode: { ideal: 'environment' },
              width: { ideal: 3840 },
              height: { ideal: 2160 },
              // Ask for continuous focus when the device supports it; browsers
              // silently ignore unsupported advanced constraints.
              advanced: [{ focusMode: 'continuous' } as unknown as MediaTrackConstraintSet],
            },
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;

      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;
        await video.play().catch(() => undefined);
      }

      // Torch support is only advertised on some Android rear cameras.
      const track = stream.getVideoTracks()[0];
      const capabilities = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean };
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter((d) => d.kind === 'videoinput');

      setState((s) => ({
        ...s,
        status: 'live',
        devices: videoDevices,
        activeDeviceId: track?.getSettings().deviceId,
        torchSupported: Boolean(capabilities.torch),
        videoSize: { width: video?.videoWidth ?? 0, height: video?.videoHeight ?? 0 },
        error: undefined,
      }));
      pausedRef.current = false;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(loop);
    } catch (err) {
      const name = (err as DOMException)?.name;
      const message = (err as Error)?.message ?? String(err);
      const status: CameraStatus =
        name === 'NotAllowedError' || name === 'SecurityError' ? 'denied'
          : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'unavailable'
            : 'error';
      setState((s) => ({ ...s, status, error: message }));
    }
  }, [loop]);

  const pause = useCallback(() => {
    pausedRef.current = true;
    setState((s) => ({ ...s, status: 'paused' }));
  }, []);

  const resume = useCallback(() => {
    pausedRef.current = false;
    setState((s) => ({ ...s, status: streamRef.current ? 'live' : s.status }));
  }, []);

  const toggleTorch = useCallback(async () => {
    const stream = streamRef.current;
    if (!stream) return;
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    const next = !state.torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as unknown as MediaTrackConstraintSet] });
      setState((s) => ({ ...s, torchOn: next }));
    } catch {
      setState((s) => ({ ...s, torchSupported: false }));
    }
  }, [state.torchOn]);

  const switchCamera = useCallback(async (deviceId: string) => {
    await start(deviceId);
  }, [start]);

  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    workerRef.current?.terminate();
  }, []);

  return {
    videoRef,
    state,
    start,
    stop,
    pause,
    resume,
    triggerCapture,
    toggleTorch,
    switchCamera,
    isLive: state.status === 'live',
  };
}

/** Are two quads within `tolerance` (normalised) of each other? */
export function quadsClose(a: Point[], b: Point[], tolerance: number): boolean {
  if (a.length !== b.length) return false;
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y);
  return total / a.length < tolerance;
}

/** Convenience: human label for a capture hint. */
export function hintLabelKey(hint: CaptureHint): string | null {
  switch (hint) {
    case 'none': return null;
    case 'no-page': return 'page detected?';
    case 'hold-steady': return 'holdSteady';
    case 'blurry': return 'blurry';
    case 'too-dark': return 'tooDark';
    case 'too-bright': return 'tooDark';
    case 'glare': return 'glare';
    case 'cut-off': return 'pageCutOff';
    case 'move-closer': return 'moveCloser';
    default: return null;
  }
}

export function useCameraMemo<T>(factory: () => T): T {
  return useMemo(factory, [factory]);
}
