'use client';

/**
 * Live camera view with page-quad overlay, stability meter, quality hints and
 * auto/manual capture. Deliberately minimal chrome with very large touch
 * targets — this screen is used one-handed next to an open book.
 */
import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { useCamera, type CameraState, type CapturedFrame, type CaptureHint } from '@/lib/useCamera';
import { Button } from '@/components/ui';
import type { TranslationKey } from '@/lib/i18n';
import { t } from '@/lib/i18n';

export interface CameraViewProps {
  lang: 'ar' | 'en';
  autoCapture: boolean;
  /** Called for every accepted frame. MUST return fast (persist + enqueue only). */
  onCapture: (frame: CapturedFrame) => void;
  /** Notify parent so it can show the same hint above the strip. */
  onStateChange?: (state: CameraState) => void;
  /** Disable capture (e.g. persistence failure). */
  captureDisabled?: boolean;
  onDisableCapture?: () => void;
  paused: boolean;
  onPauseToggle: () => void;
  onFinish: () => void;
}

export function CameraView({
  lang, autoCapture, onCapture, onStateChange, captureDisabled, paused, onPauseToggle, onFinish,
}: CameraViewProps) {
  const captureHookRef = useRef<((frame: CapturedFrame) => void) | null>(null);
  const [flash, setFlash] = useState(false);
  const [localAuto, setLocalAuto] = useState(autoCapture);
  const [lastCaptureMs, setLastCaptureMs] = useState<number | null>(null);
  const [captureCount, setCaptureCount] = useState(0);
  const [videoAspect, setVideoAspect] = useState(16 / 9);

  const updateVideoAspect = useCallback((event: SyntheticEvent<HTMLVideoElement>) => {
    const { videoWidth, videoHeight } = event.currentTarget;
    if (videoWidth <= 0 || videoHeight <= 0) return;
    const nextAspect = videoWidth / videoHeight;
    setVideoAspect((current) => Math.abs(current - nextAspect) < 0.001 ? current : nextAspect);
  }, []);

  // Wrap the parent callback: visual confirmation + never block on it.
  const handleCapture = useCallback((frame: CapturedFrame) => {
    setFlash(true);
    setLastCaptureMs(frame.captureMs);
    setCaptureCount((c) => c + 1);
    setTimeout(() => setFlash(false), 300);
    // Optional physical/vibration feedback where supported & allowed.
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try { navigator.vibrate?.(18); } catch { /* ignored */ }
    }
    onCapture(frame);
  }, [onCapture]);

  const onCaptureRef = useRef(handleCapture);
  useEffect(() => { onCaptureRef.current = handleCapture; }, [handleCapture]);

  const camera = useCamera({
    autoCaptureEnabled: localAuto && !paused && !captureDisabled,
    onCapture: useCallback((frame: CapturedFrame) => onCaptureRef.current(frame), []),
    stableMs: 500,
    cooldownMs: 1800,
    jpegQuality: 0.92,
  });
  captureHookRef.current = null;

  /**
   * Start the stream as soon as this view is mounted.
   *
   * The parent renders <CameraView> only after the user taps "start scanning",
   * so mounting *is* the user gesture. Nothing else called `start()`, which left
   * the preview black and the status stuck on "idle" — including when the
   * permission was denied, so the failure never reached the user at all.
   */
  const { start: startCamera, stop: stopCamera } = camera;
  useEffect(() => {
    void startCamera();
    return () => stopCamera();
  }, [startCamera, stopCamera]);

  useEffect(() => {
    onStateChange?.(camera.state);
  }, [camera.state, onStateChange]);

  useEffect(() => {
    setLocalAuto(autoCapture);
  }, [autoCapture]);

  const hintText = hintLabel(lang, camera.state.hint);
  const showHint = Boolean(hintText) && camera.isLive && !paused;
  /** Camera failed to start: show a full explanation instead of a blank preview. */
  const cameraBlocked = ['denied', 'unavailable', 'insecure', 'error'].includes(camera.state.status);
  // Read dimensions from the media element's own metadata/resize events.
  // The hook's React state can lag behind the first decoded frame on some browsers.
  const overlayViewBoxHeight = 100 / videoAspect;

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      <video
        ref={camera.videoRef}
        className="h-full w-full object-contain"
        playsInline
        muted
        onLoadedMetadata={updateVideoAspect}
        onResize={updateVideoAspect}
        aria-label={lang === 'ar' ? 'معاينة الكاميرا المباشرة' : 'Live camera preview'}
      />

      {/* -------- page quad overlay -------- */}
      <svg
        data-testid="camera-quad-overlay"
        className="pointer-events-none absolute inset-0 h-full w-full"
        viewBox={`0 0 100 ${overlayViewBoxHeight}`}
        aria-hidden="true"
      >
        {camera.state.quad ? (
          <>
            <polygon
              points={camera.state.quad.points.map((p) => `${p.x * 100},${p.y * overlayViewBoxHeight}`).join(' ')}
              fill="rgba(47,141,124,0.12)"
              stroke="rgba(134,201,187,0.95)"
              strokeWidth="0.5"
              vectorEffect="non-scaling-stroke"
              strokeDasharray={camera.state.hint === 'none' ? undefined : '1.4 0.8'}
            />
            {camera.state.quad.points.map((p, i) => (
              <circle key={i} cx={p.x * 100} cy={p.y * overlayViewBoxHeight} r="0.9" fill="rgba(134,201,187,0.95)" />
            ))}
          </>
        ) : null}
      </svg>

      {/* -------- flash confirmation -------- */}
      {flash ? <div className="capture-flash absolute inset-0 bg-white" aria-hidden="true" /> : null}

      {/* -------- top overlay: status + counter -------- */}
      <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-2 bg-gradient-to-b from-black/65 to-transparent p-3">
        <div className="flex flex-col gap-1.5">
          <StatusLine
            lang={lang}
            status={camera.state.status}
            hint={camera.state.hint}
            stability={camera.state.stability}
            paused={paused}
          />
          {captureCount > 0 ? (
            <span className="w-fit rounded-full bg-white/12 px-2.5 py-1 text-xs text-white backdrop-blur">
              {t(lang, 'pageCaptured')} · {captureCount}
              {lastCaptureMs !== null ? ` · ${lastCaptureMs}ms` : ''}
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-1.5">
          {camera.state.torchSupported ? (
            <IconButton
              label={t(lang, 'torch')}
              active={camera.state.torchOn}
              onClick={() => void camera.toggleTorch()}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M9 3h6l1.5 6.5L14 14v7h-4v-7L7.5 9.5 9 3Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
              </svg>
            </IconButton>
          ) : null}
          {camera.state.devices.length > 1 ? (
            <select
              aria-label={t(lang, 'camera')}
              value={camera.state.activeDeviceId ?? ''}
              onChange={(e) => void camera.switchCamera(e.target.value)}
              className="max-w-[8.5rem] rounded-lg bg-white/15 px-2 py-1.5 text-xs text-white backdrop-blur"
            >
              {camera.state.devices.map((d, i) => (
                <option key={d.deviceId} value={d.deviceId} className="text-black">
                  {d.label || `${t(lang, 'camera')} ${i + 1}`}
                </option>
              ))}
            </select>
          ) : null}
          <IconButton label={t(lang, 'close')} onClick={onFinish}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
          </IconButton>
        </div>
      </div>

      {/* -------- camera blocked: explain + offer the upload path -------- */}
      {cameraBlocked ? (
        <div className="absolute inset-0 grid place-items-center bg-black/70 p-6 text-center">
          <div className="max-w-sm">
            <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-white/10 text-2xl" aria-hidden="true">
              📷
            </div>
            <p className="text-base font-semibold text-white">
              {camera.state.status === 'denied' ? t(lang, 'cameraDenied') : t(lang, 'cameraUnavailable')}
            </p>
            <p className="mt-2 text-sm leading-relaxed text-white/80">
              {camera.state.status === 'denied' ? t(lang, 'cameraDeniedHint') : t(lang, 'importHint')}
            </p>
            {camera.state.error ? (
              <p className="mt-2 break-words text-[11px] text-white/50">{camera.state.error}</p>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* -------- hint banner -------- */}
      {showHint ? (
        <div
          role="status"
          aria-live="polite"
          className={`absolute inset-x-0 bottom-40 mx-auto w-fit max-w-[92%] rounded-full px-4 py-2 text-center text-sm font-medium text-white shadow-lg ${
            camera.state.hint === 'hold-steady' ? 'bg-[var(--color-accent-500)]/90' : 'bg-[var(--color-warn-500)]/92'
          }`}
        >
          {hintText}
        </div>
      ) : null}

      {/* -------- capture controls: hidden entirely when the camera is blocked,
           so there is no dead shutter button inviting a tap that cannot work --- */}
      {!cameraBlocked && (
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-3 bg-gradient-to-t from-black/70 to-transparent p-4">
        <div className="flex flex-1 justify-start">
          <button
            type="button"
            onClick={onPauseToggle}
            className="flex h-12 min-w-12 items-center gap-2 rounded-full bg-white/15 px-3 text-sm text-white backdrop-blur"
            aria-pressed={paused}
          >
            {paused ? '▶' : '❚❚'}
            <span className="hidden sm:inline">{paused ? t(lang, 'resume') : t(lang, 'pause')}</span>
          </button>
        </div>

        {/* Shutter — the largest touch target on the screen */}
        <button
          type="button"
          onClick={() => void camera.triggerCapture()}
          disabled={!camera.isLive || paused || captureDisabled}
          aria-label={t(lang, 'capture')}
          className="relative grid h-20 w-20 place-items-center rounded-full border-4 border-white/85 bg-white/20 backdrop-blur transition active:scale-95 disabled:opacity-40"
        >
          <span className="h-14 w-14 rounded-full bg-white shadow-inner" />
        </button>

        <div className="flex flex-1 justify-end">
          <button
            type="button"
            onClick={() => setLocalAuto((v) => !v)}
            aria-pressed={localAuto}
            className="flex h-12 items-center gap-2 rounded-full bg-white/15 px-3 text-sm text-white backdrop-blur"
          >
            <span aria-hidden="true">{localAuto ? '🅰' : '✋'}</span>
            <span className="hidden sm:inline">{localAuto ? t(lang, 'autoCapture') : t(lang, 'manual')}</span>
          </button>
        </div>
      </div>
      )}

      {/* -------- stability meter (only meaningful with a live stream) -------- */}
      {!cameraBlocked ? (
      <div className="absolute inset-x-0 bottom-32 mx-auto flex w-56 items-center gap-2" aria-hidden="true">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/25">
          <div
            className={`h-full rounded-full transition-[width] duration-150 ${camera.state.hint === 'none' ? 'bg-[var(--color-accent-300)]' : 'bg-[var(--color-warn-100)]'}`}
            style={{ width: `${(camera.state.hint === 'none' ? camera.state.stability : 0) * 100}%` }}
          />
        </div>
        <span className="text-[10px] tabular-nums text-white/80">{Math.round(camera.state.stability * 100)}%</span>
      </div>
      ) : null}

    </div>
  );
}

/* ------------------------------------------------------------------ */

function StatusLine({ lang, status, hint, stability, paused }: {
  lang: 'ar' | 'en';
  status: CameraState['status'];
  hint: CaptureHint;
  stability: number;
  paused: boolean;
}) {
  let label: string;
  let tone = 'bg-white/15 text-white';
  let isWarning = false;
  /**
   * Order matters: a camera that never started must never claim "page detected".
   * The capture-pipeline fields (hint/stability) are meaningless before a stream
   * exists, and leaving them in the flow made a denied camera look alive.
   */
  if (status === 'requesting') {
    label = t(lang, 'cameraStarting');
  } else if (status === 'denied') {
    label = t(lang, 'cameraDenied');
    tone = 'bg-[var(--color-danger-500)]/90 text-white';
    isWarning = true;
  } else if (status === 'unavailable' || status === 'insecure' || status === 'error') {
    label = t(lang, 'cameraUnavailable');
    tone = 'bg-[var(--color-danger-500)]/90 text-white';
    isWarning = true;
  } else if (status === 'idle') {
    label = t(lang, 'camera');
    tone = 'bg-white/15 text-white';
  } else if (paused) {
    label = t(lang, 'pause');
  } else if (hint === 'none' && stability > 0.15) {
    label = t(lang, 'holdSteady');
    tone = 'bg-[var(--color-accent-500)] text-white';
  } else if (hint === 'no-page') {
    label = t(lang, 'pointAtPage');
  } else if (hint !== 'none') {
    label = hintLabel(lang, hint) ?? '';
    tone = 'bg-[var(--color-warn-500)]/92 text-white';
  } else {
    label = t(lang, 'pageDetected');
    tone = 'bg-[var(--color-accent-500)] text-white';
  }

  return (
    <span className={`w-fit rounded-full px-3 py-1.5 text-sm font-medium backdrop-blur ${tone}`} role="status">
      <span aria-hidden="true" className="me-1.5">{isWarning ? '⚠' : '●'}</span>
      {label}
    </span>
  );
}

function hintLabel(lang: 'ar' | 'en', hint: CaptureHint): string | null {
  const map: Partial<Record<CaptureHint, TranslationKey>> = {
    'hold-steady': 'holdSteady',
    blurry: 'blurry',
    'too-dark': 'tooDark',
    'too-bright': 'tooDark',
    glare: 'glare',
    'cut-off': 'pageCutOff',
    'move-closer': 'moveCloser',
  };
  const key = map[hint];
  return key ? t(lang, key) : null;
}

function IconButton({ label, onClick, children, active }: {
  label: string; onClick: () => void; children: React.ReactNode; active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      className={`grid h-10 w-10 place-items-center rounded-full backdrop-blur ${
        active ? 'bg-[var(--color-accent-500)] text-white' : 'bg-white/15 text-white'
      }`}
    >
      {children}
    </button>
  );
}

/* Re-exported helper for the capture strip */
export function CaptureStrip({
  lang, pages, onOpen, activeId,
}: {
  lang: 'ar' | 'en';
  pages: Array<{ id: string; thumb?: string; status: string; order: number; progress: number; stage: string }>;
  onOpen: (id: string) => void;
  activeId?: string;
}) {
  return (
    <div className="flex gap-2 overflow-x-auto camscan-scroll px-3 py-2">
      {pages.map((page) => (
        <button
          key={page.id}
          type="button"
          onClick={() => onOpen(page.id)}
          className={`relative h-20 w-16 shrink-0 overflow-hidden rounded-lg border-2 ${
            activeId === page.id ? 'border-[var(--camscan-accent)]' : 'border-transparent'
          }`}
          aria-label={`${t(lang, 'page')} ${page.order + 1} — ${page.status}`}
        >
          {page.thumb ? (
            <img src={page.thumb} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="h-full w-full bg-[var(--camscan-surface-2)]" />
          )}
          <span className="absolute inset-x-0 bottom-0 bg-black/55 py-0.5 text-center text-[10px] text-white">
            {page.order + 1}
          </span>
          {page.status === 'processing' ? (
            <span className="absolute inset-x-0 top-0 h-1 bg-[var(--color-accent-300)]" style={{ width: `${Math.round(page.progress * 100)}%` }} />
          ) : null}
          {page.status === 'review' ? <span className="absolute end-0 top-0 bg-[var(--color-warn-500)] px-1 text-[9px] text-white">⚠</span> : null}
          {page.status === 'failed' ? <span className="absolute end-0 top-0 bg-[var(--color-danger-500)] px-1 text-[9px] text-white">✕</span> : null}
        </button>
      ))}
    </div>
  );
}
