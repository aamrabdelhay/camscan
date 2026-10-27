'use client';

/**
 * CamScan — scan workspace (`/book/[id]/scan`).
 *
 * Flow (the product's critical path):
 *   start camera → hold page steady → AUTO-CAPTURE (≈0.5 s) → Blob persisted
 *   immediately + queued → camera ready again before OCR finishes → repeat.
 *
 * The page counter only ever grows; OCR results land later on the *same* page
 * row, so capture order is never affected by processing order.
 */
import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLiveQuery } from 'dexie-react-hooks';
import { useApp } from '@/components/AppProviders';
import { useToast } from '@/components/Toast';
import { Badge, Button, Card, EmptyState, Progress, Spinner } from '@/components/ui';
import { CameraView, CaptureStrip } from '@/components/scanner/CameraView';
import { t } from '@/lib/i18n';
import { getProcessingPool, type PipelineEvent } from '@/lib/pipeline';
import { makeThumb } from '@/lib/repository';
import type { CapturedFrame } from '@/lib/useCamera';

import { TipsDialog } from '@/components/TipsDialog';

interface Props {
  params: Promise<{ id: string }>;
}

export default function ScanPage({ params }: Props) {
  const { id: bookId } = use(params);
  const { repo, settings, ready, updateSettings } = useApp();
  const { push } = useToast();
  const router = useRouter();
  const lang = settings.uiLanguage;

  const [cameraOpen, setCameraOpen] = useState(false);
  const [paused, setPaused] = useState(false);
  const [captureDisabled, setCaptureDisabled] = useState(false);
  const [lastJobEvent, setLastJobEvent] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [showTips, setShowTips] = useState(false);
  const [recentCaptureMs, setRecentCaptureMs] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const poolRef = useRef<ReturnType<typeof getProcessingPool> | null>(null);

  /**
   * Dexie's `useLiveQuery` yields `undefined` both while the query is still
   * resolving *and* when the row genuinely does not exist, so we wrap the result
   * in an object: the wrapper is only `undefined` while loading, and
   * `{ book: null }` unambiguously means "no such book" (stale link, or a
   * library that was wiped/restored in another tab).
   */
  const bookQuery = useLiveQuery(async () => {
    if (!ready) return undefined;
    return { book: (await repo.getBook(bookId)) ?? null };
  }, [repo, bookId, ready]);
  const book = bookQuery ? bookQuery.book : undefined;

  const pages = useLiveQuery(async () => {
    if (!ready) return [];
    return repo.listPageRows(bookId);
  }, [repo, bookId, ready]) ?? [];

  /* ---------------- pool lifecycle ---------------- */
  // NB: depend on `book.id`, never on the live-queried `book` object. Dexie
  // hands back a new object on every write, so an object dependency re-runs this
  // effect after every progress update — and each run called `resume()`, which
  // re-queued the job that was still in flight, so pages were reprocessed in an
  // endless loop (measured: a page's updatedAt advancing every 10 s).
  const bookIdForPool = book?.id;
  useEffect(() => {
    if (!ready || !bookIdForPool) return;
    const pool = getProcessingPool(repo);
    poolRef.current = pool;
    pool.setActiveBook(bookIdForPool);
    const unsubscribe = pool.subscribe((event: PipelineEvent) => {
      if (event.type === 'job-done') {
        setLastJobEvent(`${t(lang, 'page')} ${event.pageId.slice(-4)} → ${event.status}`);
      }
      if (event.type === 'job-failed' && event.attempts >= 3) {
        push(`${t(lang, 'failed')}: ${event.error}`, 'warn', 6000);
      }
    });
    // Resume anything left pending from a previous session (honest about
    // browser suspension: we pick up where we stopped, on reopen).
    void pool.resume(bookIdForPool).then((count) => {
      if (count > 0) push(`${t(lang, 'queueResumed')} · ${count}`, 'info');
    });
    return () => {
      unsubscribe();
      pool.setActiveBook(null);
    };
  }, [ready, bookIdForPool, repo, push, lang]);

  /* ---------------- first-use tips ---------------- */
  useEffect(() => {
    if (ready && !settings.hasSeenTips) setShowTips(true);
  }, [ready, settings.hasSeenTips]);

  /* ---------------- capture handler (must be FAST) ---------------- */
  const handleCapture = useCallback(async (frame: CapturedFrame) => {
    if (!book) return;
    const started = performance.now();
    try {
      // 1. Persist the ORIGINAL image immediately, before any processing.
      const thumb = await makeThumb(frame.blob, 160);
      const nextOrder = pages.length ? Math.max(...pages.map((p) => p.order)) + 1 : 0;
      const page = await repo.addPage({
        bookId: book.id,
        order: nextOrder,
        originalImage: frame.blob,
        thumb,
        width: frame.width,
        height: frame.height,
        language: book.settings.ocrLanguages[0]?.replace('ara', 'ar') ?? 'ar',
        direction: book.settings.ocrLanguages[0] === 'eng' ? 'ltr' : 'rtl',
      });
      setRecentCaptureMs(Math.round(performance.now() - started));

      // 2. Queue processing in the background — do NOT await OCR.
      const pool = poolRef.current ?? getProcessingPool(repo);
      poolRef.current = pool;
      await pool.enqueue(page.id, book.id, {
        languages: book.settings.ocrLanguages,
        profile: book.settings.captureProfile,
        arabicFont: book.defaultFonts.arabicFont,
        latinFont: book.defaultFonts.latinFont,
        reviewThreshold: book.settings.reviewThreshold,
      });
      await repo.recomputeBookStats(book.id);
    } catch (err) {
      // Persistence failure is the one error we must never swallow: stop
      // automatic capture so the user doesn't keep "capturing" into the void.
      console.error('persist failed', err);
      setCaptureDisabled(true);
      setPaused(true);
      push(t(lang, 'persistenceFailed'), 'error', 0);
    }
  }, [book, pages, repo, push, lang]);

  /* ---------------- upload fallback ---------------- */
  const handleFiles = useCallback(async (files: FileList) => {
    if (!book) return;
    setImporting(true);
    try {
      const list = Array.from(files).slice(0, 100);
      let order = pages.length ? Math.max(...pages.map((p) => p.order)) + 1 : 0;
      for (const file of list) {
        if (!file.type.startsWith('image/')) continue;
        const bitmap = await createImageBitmap(file);
        const { width, height } = bitmap;
        bitmap.close();
        const thumb = await makeThumb(file, 160);
        const page = await repo.addPage({
          bookId: book.id,
          order: order++,
          originalImage: file,
          thumb,
          width,
          height,
          language: book.language === 'en' ? 'en' : 'ar',
          direction: book.language === 'en' ? 'ltr' : 'rtl',
        });
        const pool = poolRef.current ?? getProcessingPool(repo);
        poolRef.current = pool;
        await pool.enqueue(page.id, book.id, {
          languages: book.settings.ocrLanguages,
          profile: book.settings.captureProfile,
          arabicFont: book.defaultFonts.arabicFont,
          latinFont: book.defaultFonts.latinFont,
          reviewThreshold: book.settings.reviewThreshold,
        });
      }
      await repo.recomputeBookStats(book.id);
      push(lang === 'ar' ? 'تم استيراد الصور' : 'Images imported', 'success');
    } catch (err) {
      push((err as Error).message, 'error');
    } finally {
      setImporting(false);
    }
  }, [book, pages, repo, push, lang]);

  const stats = useMemo(() => {
    const queued = pages.filter((p) => p.status === 'queued' || p.status === 'processing').length;
    const review = pages.filter((p) => p.status === 'review').length;
    const failed = pages.filter((p) => p.status === 'failed').length;
    const done = pages.filter((p) => p.status === 'done').length;
    return { queued, review, failed, done };
  }, [pages]);

  if (!ready || book === undefined) {
    return <div className="grid min-h-dvh place-items-center"><Spinner size={30} /></div>;
  }
  /**
   * `null` (not `undefined`) means the live query has answered and there is no
   * such book — a stale link, or a library that was wiped/restored meanwhile.
   * Showing a spinner forever here was a real dead end: the page simply never
   * loaded with no explanation.
   */
  if (book === null) {
    return (
      <main className="mx-auto max-w-lg p-6">
        <Card className="p-6 text-center">
          <p className="text-sm">{t(lang, 'bookNotFound')}</p>
          <Link href="/" className="mt-3 inline-block text-sm text-[var(--camscan-accent)] underline">
            {t(lang, 'backToLibrary')}
          </Link>
        </Card>
      </main>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col bg-[var(--camscan-bg)]">
      {/* -------- header (minimal, scan-optimised) -------- */}
      <header className="flex items-center gap-2 border-b border-[var(--camscan-border)] px-3 py-2 no-print">
        <Link href={`/book/${book.id}`} className="rounded-lg p-2 hover:bg-[var(--camscan-surface-2)]" aria-label={t(lang, 'backToLibrary')}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d={lang === 'ar' ? 'M9 6l6 6-6 6' : 'M15 6l-6 6 6 6'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{book.title}</h1>
          <p className="text-xs text-[var(--camscan-text-muted)]">
            {t(lang, 'page')} {pages.length} ·{' '}
            {stats.queued > 0 ? `${stats.queued} ${t(lang, 'processing')}` : t(lang, 'readyForNext')}
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => router.push(`/book/${book.id}`)}>
          {t(lang, 'openBook')}
        </Button>
      </header>

      {/* -------- main area -------- */}
      <main className="flex flex-1 flex-col">
        {cameraOpen ? (
          <div className="relative flex-1">
            <CameraView
              lang={lang}
              autoCapture={settings.autoCapture}
              onCapture={(frame) => void handleCapture(frame)}
              captureDisabled={captureDisabled}
              paused={paused}
              onPauseToggle={() => setPaused((v) => !v)}
              onFinish={() => setCameraOpen(false)}
            />
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
            <div className="w-full max-w-md space-y-4">
              <Card className="p-5 text-center">
                <div className="mx-auto mb-3 grid h-16 w-16 place-items-center rounded-full bg-[var(--color-accent-50)] text-[var(--color-accent-600)]">
                  <svg width="30" height="30" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <rect x="3" y="6" width="18" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
                    <circle cx="12" cy="12.5" r="3.2" stroke="currentColor" strokeWidth="1.7" />
                    <path d="M8.5 6l1-1.6h5L15.5 6" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
                  </svg>
                </div>
                <h2 className="text-lg font-semibold">{pages.length ? t(lang, 'continueScanning') : t(lang, 'startScanning')}</h2>
                <p className="mx-auto mt-1.5 max-w-sm text-sm text-[var(--camscan-text-muted)]">
                  {lang === 'ar'
                    ? 'افتح الكاميرا مرة واحدة ثم اقلب الصفحات — سيتم التصوير تلقائيًا عندما تثبت الصفحة.'
                    : 'Open the camera once and turn the pages — each stable page is captured automatically.'}
                </p>
                <Button variant="accent" size="xl" className="mt-4 w-full" onClick={() => setCameraOpen(true)}>
                  📷 {t(lang, 'startScanning')}
                </Button>
                <div className="mt-2 flex gap-2">
                  <Button variant="secondary" className="flex-1" onClick={() => fileInputRef.current?.click()} loading={importing}>
                    {t(lang, 'importImages')}
                  </Button>
                  <Button variant="ghost" onClick={() => setShowTips(true)}>{t(lang, 'tips')}</Button>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    const files = e.target.files;
                    if (files?.length) void handleFiles(files);
                    e.target.value = '';
                  }}
                />
              </Card>

              {/* quality tips card */}
              <Card className="p-4">
                <h3 className="mb-2 text-sm font-semibold">🛡️ {t(lang, 'tipsTitle')}</h3>
                <ul className="space-y-1.5 text-xs leading-relaxed text-[var(--camscan-text-muted)]">
                  <li>• {t(lang, 'tips1')}</li>
                  <li>• {t(lang, 'tips2')}</li>
                  <li>• {t(lang, 'tips3')}</li>
                </ul>
              </Card>
            </div>
          </div>
        )}

        {/* -------- capture strip + queue state -------- */}
        {pages.length > 0 ? (
          <section className="border-t border-[var(--camscan-border)] bg-[var(--camscan-surface)] pb-3 no-print">
            <div className="flex items-center gap-2 px-3 pt-2 text-xs text-[var(--camscan-text-muted)]">
              <span className="font-medium text-[var(--camscan-text)]">
                {t(lang, 'page')} {pages.length}
              </span>
              {stats.queued > 0 ? <Badge tone="info"><Spinner size={10} /> {stats.queued} {t(lang, 'queued')}</Badge> : null}
              {stats.done > 0 ? <Badge tone="success">{stats.done} {t(lang, 'done')}</Badge> : null}
              {stats.review > 0 ? <Badge tone="warn">⚠ {stats.review} {t(lang, 'needsReview')}</Badge> : null}
              {stats.failed > 0 ? <Badge tone="danger">✕ {stats.failed}</Badge> : null}
              {recentCaptureMs !== null ? (
                <span className="ms-auto tabular-nums" title="Capture → persisted">
                  ⚡ {recentCaptureMs}ms
                </span>
              ) : null}
            </div>
            <CaptureStrip
              lang={lang}
              pages={pages.map((p) => ({
                id: p.id, thumb: p.thumb, status: p.status, order: p.order, progress: p.progress, stage: p.stage,
              }))}
              onOpen={(id) => router.push(`/book/${book.id}?pageId=${id}`)}
            />
            {lastJobEvent ? (
              <p aria-live="polite" className="px-3 text-[11px] text-[var(--camscan-text-muted)]">{lastJobEvent}</p>
            ) : null}
          </section>
        ) : (
          <div className="p-4">
            <EmptyState title={t(lang, 'noPages')} description={t(lang, 'noPagesHelp')} />
          </div>
        )}
      </main>

      <TipsDialog
        open={showTips}
        onClose={async () => {
          setShowTips(false);
          await updateSettings({ hasSeenTips: true });
        }}
      />

      {/* capture queue progress for screen readers */}
      <div className="sr-only" role="status" aria-live="polite">
        {stats.queued > 0 ? `${stats.queued} ${t(lang, 'processing')}` : ''}
      </div>
    </div>
  );
}
