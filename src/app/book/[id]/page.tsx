'use client';

/**
 * CamScan — book reader (`/book/[id]`).
 *
 *  - three views: replica (real text), original photo, side-by-side
 *  - comfortable reading mode that reflows the same stored text
 *  - inline editing with revisions (never a silent overwrite)
 *  - page management: reorder, retake, insert, delete, mark blank/reviewed
 *  - in-book search + highlight, export dialog, reprocess flow
 */
import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useLiveQuery } from 'dexie-react-hooks';
import { useApp } from '@/components/AppProviders';
import { useToast } from '@/components/Toast';
import { AppHeader } from '@/components/AppHeader';
import { Badge, Button, Card, EmptyState, Field, Modal, Progress, Select, Spinner, StatusPill } from '@/components/ui';
import { ReplicaPage, ComfortablePage } from '@/components/reader/ReplicaPage';
import { FreeAiDialog } from '@/components/reader/FreeAiDialog';
import { t } from '@/lib/i18n';
import { getSearchIndex } from '@/lib/search';
import { highlightSegments } from '@/lib/normalize';
import { modelConfidence, modelPlainText } from '@/lib/pageModel';
import { toStructuredOcrJson } from '@/lib/ocr/structuredOutput';
import { normalizeSearchText } from '@/lib/repository';
import { getProcessingPool } from '@/lib/pipeline';
import { exportBookToPdf, downloadBlob, safeFilename } from '@/lib/pdf/browserExport';
import type { Book, PageModel } from '@/lib/types';
import type { PageRow } from '@/lib/db';

type ViewMode = 'replica' | 'original' | 'side-by-side' | 'comfortable';

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string; pageId?: string; q?: string }>;
}

export default function ReaderPage({ params, searchParams }: Props) {
  const { id: bookId } = use(params);
  const sp = use(searchParams);
  const { repo, settings, ready } = useApp();
  const { push } = useToast();
  const lang = settings.uiLanguage;

  const [index, setIndex] = useState(() => Math.max(0, Number(sp.page ?? 1) - 1));
  const [view, setView] = useState<ViewMode>('replica');
  const [zoom, setZoom] = useState(1);
  const [query, setQuery] = useState(sp.q ?? '');
  const [editing, setEditing] = useState(false);
  const [draftModel, setDraftModel] = useState<PageModel | null>(null);
  const [saving, setSaving] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [reprocessOpen, setReprocessOpen] = useState(false);
  const [showOutlines, setShowOutlines] = useState(false);
  const [selectedBlock, setSelectedBlock] = useState<string | null>(null);
  const [originalUrl, setOriginalUrl] = useState<string | null>(null);
  const [processedUrl, setProcessedUrl] = useState<string | null>(null);
  const [showRawOriginal, setShowRawOriginal] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [pageWidth, setPageWidth] = useState(560);

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
  const pages = useLiveQuery(async () => (ready ? repo.listPageRows(bookId) : []), [repo, bookId, ready]) ?? [];

  const current = pages[Math.min(index, Math.max(0, pages.length - 1))];
  const model = draftModel ?? current?.pageModel;

  /* ---------------- object URLs for images ---------------- */
  useEffect(() => {
    const revoke: string[] = [];
    (async () => {
      if (!current) { setOriginalUrl(null); setProcessedUrl(null); return; }
      const orig = await repo.getOriginalImage(current.id);
      if (orig) {
        const url = URL.createObjectURL(orig);
        revoke.push(url);
        setOriginalUrl(url);
      } else setOriginalUrl(null);
      const proc = await repo.getProcessedImage(current.id);
      if (proc) {
        const url = URL.createObjectURL(proc);
        revoke.push(url);
        setProcessedUrl(url);
      } else setProcessedUrl(null);
    })();
    return () => { revoke.forEach((u) => URL.revokeObjectURL(u)); };
  }, [current?.id, repo, current]);

  /* ---------------- responsive page width ---------------- */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width;
      const target = view === 'side-by-side' ? Math.min(560, w / 2 - 12) : Math.min(720, w - 24);
      setPageWidth(Math.max(240, target * zoom));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [view, zoom]);

  /* ---------------- keep index in range ---------------- */
  useEffect(() => {
    if (pages.length && index > pages.length - 1) setIndex(pages.length - 1);
  }, [pages.length, index]);

  useEffect(() => {
    if (sp.pageId) {
      const found = pages.findIndex((p) => p.id === sp.pageId);
      if (found >= 0) setIndex(found);
    }
  }, [sp.pageId, pages]);

  /* ---------------- navigation ---------------- */
  const go = useCallback((delta: number) => {
    setEditing(false);
    setDraftModel(null);
    setIndex((i) => Math.max(0, Math.min(pages.length - 1, i + delta)));
  }, [pages.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.isContentEditable) return;
      const rtl = settings.uiLanguage === 'ar';
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(rtl ? 1 : -1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); go(rtl ? -1 : 1); }
      if (e.key === 'PageDown') { e.preventDefault(); go(1); }
      if (e.key === 'PageUp') { e.preventDefault(); go(-1); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [go, settings.uiLanguage]);

  /* ---------------- editing ---------------- */
  const startEditing = () => {
    if (!current?.pageModel) return;
    setDraftModel(structuredClone(current.pageModel));
    setEditing(true);
    setSelectedBlock(null);
  };

  const updateBlockText = (blockId: string, text: string) => {
    setDraftModel((draft) => {
      if (!draft) return draft;
      return {
        ...draft,
        blocks: draft.blocks.map((b) =>
          b.id === blockId ? { ...b, text, edited: true, confidence: Math.max(b.confidence, 99) } : b,
        ),
      };
    });
  };

  const updateBlockStyle = (blockId: string, patch: Partial<PageModel['blocks'][number]>) => {
    setDraftModel((draft) => draft
      ? { ...draft, blocks: draft.blocks.map((b) => (b.id === blockId ? { ...b, ...patch } : b)) }
      : draft);
  };

  const saveEdits = async () => {
    if (!current || !draftModel) return;
    setSaving(true);
    try {
      // Keep a revision of the *previous* state before overwriting anything.
      if (current.pageModel) {
        await repo.addRevision({
          pageId: current.id,
          bookId: current.bookId,
          previousModel: current.pageModel,
          previousPlainText: current.plainText,
          summary: 'inline text edit',
          kind: 'edit',
        });
      }
      const confidence = modelConfidence(draftModel);
      await repo.savePageModel({
        pageId: current.id,
        model: draftModel,
        avgConfidence: confidence,
        status: confidence >= (book?.settings.reviewThreshold ?? 70) ? 'done' : current.status,
        keepEdit: true,
      });
      await repo.updatePage(current.id, {
        userEdited: true,
        plainText: modelPlainText(draftModel),
        searchText: normalizeSearchText(modelPlainText(draftModel)),
      });
      const idx = pages.findIndex((p) => p.id === current.id);
      getSearchIndex().upsert({
        bookId: bookId,
        bookTitle: book?.title ?? '',
        author: book?.author,
        pageId: current.id,
        pageNumber: idx + 1,
        printedNumber: draftModel.printedNumber,
        displayText: modelPlainText(draftModel),
        language: draftModel.language,
        status: current.status,
      });
      setEditing(false);
      setDraftModel(null);
      push(t(lang, 'saved'), 'success');
    } catch (err) {
      push((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const cancelEdits = () => {
    setEditing(false);
    setDraftModel(null);
  };

  const exportStructuredJson = () => {
    if (!model || !book) return;
    try {
      const structured = toStructuredOcrJson(model);
      const blob = new Blob([JSON.stringify(structured, null, 2) + '\n'], {
        type: 'application/json;charset=utf-8',
      });
      downloadBlob(blob, safeFilename(`${book.title}-page-${index + 1}`, 'json'));
      push(lang === 'ar' ? 'تم تصدير بيانات OCR بصيغة JSON' : 'OCR JSON exported', 'success');
    } catch (err) {
      push((err as Error).message || (lang === 'ar' ? 'تعذر تصدير JSON' : 'Could not export JSON'), 'error');
    }
  };

  /* ---------------- page management ---------------- */
  const movePage = async (dir: -1 | 1) => {
    if (!current) return;
    const from = pages.findIndex((p) => p.id === current.id);
    const to = from + dir;
    if (to < 0 || to >= pages.length) return;
    const ids = pages.map((p) => p.id);
    [ids[from], ids[to]] = [ids[to], ids[from]];
    await repo.reorderPages(bookId, ids);
    setIndex(to);
  };

  const deleteCurrent = async () => {
    if (!current) return;
    if (!confirm(t(lang, 'deletePageConfirm'))) return;
    getSearchIndex().remove(current.id);
    await repo.deletePage(current.id);
    await repo.recomputeBookStats(bookId);
    setIndex((i) => Math.max(0, Math.min(pages.length - 2, i)));
    push(lang === 'ar' ? 'تم حذف الصفحة' : 'Page deleted', 'success');
  };

  const toggleReviewed = async () => {
    if (!current) return;
    const pool = getProcessingPool(repo);
    await pool.markReviewed(current.id, bookId, !current.reviewed);
  };

  const markBlank = async () => {
    if (!current) return;
    await repo.updatePage(current.id, { blank: !current.blank, status: current.blank ? 'queued' : 'blank' });
  };

  /* ---------------- in-book search ---------------- */
  const inBookResults = useMemo(() => {
    if (!query.trim() || !book) return [];
    return getSearchIndex().search(query, { bookId, limit: 100 });
  }, [query, bookId, book]);

  /* ---------------- reprocess ---------------- */
  const reprocessCurrent = async (allowReplaceEdits: boolean) => {
    if (!current || !book) return;
    const pool = getProcessingPool(repo);
    if (current.pageModel) {
      await repo.addRevision({
        pageId: current.id,
        bookId,
        previousModel: current.pageModel,
        previousPlainText: current.plainText,
        summary: allowReplaceEdits ? 'reprocess: replaced with new OCR' : 'reprocess: edits kept',
        kind: 'reprocess',
      });
    }
    if (allowReplaceEdits) await repo.updatePage(current.id, { userEdited: false });
    // enqueue with explicit option through the same idempotent queue
    const jobs = await repo.listJobs({ bookId });
    for (const j of jobs.filter((j) => j.pageId === current.id && (j.state === 'failed' || j.state === 'pending'))) {
      await repo.updateJob(j.id, { state: 'cancelled' });
    }
    await repo.updatePageStatus(current.id, 'queued', { progress: 0, stage: 'queued' });
    await pool.enqueue(current.id, bookId, {
      languages: book.settings.ocrLanguages,
      profile: book.settings.captureProfile,
      arabicFont: book.defaultFonts.arabicFont,
      latinFont: book.defaultFonts.latinFont,
      reviewThreshold: book.settings.reviewThreshold,
      reprocess: true,
    });
    setReprocessOpen(false);
    push(lang === 'ar' ? 'أُضيفت الصفحة لقائمة إعادة المعالجة' : 'Page queued for re-processing', 'info');
  };

  /* ---------------- render ---------------- */
  if (!ready || book === undefined) {
    return <div className="grid min-h-dvh place-items-center"><Spinner size={30} /></div>;
  }
  // `null` means the live query answered and the book does not exist (stale link
  // or a wiped/restored library) — say so instead of spinning forever.
  if (book === null) {
    return (
      <main className="mx-auto max-w-lg p-6">
        <Card className="p-6 text-center">
          <p className="text-sm">{t(lang, 'bookNotFound')}</p>
          <Link href="/" className="mt-3 inline-block text-sm underline">{t(lang, 'backToLibrary')}</Link>
        </Card>
      </main>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader compact />

      {/* -------- book toolbar -------- */}
      <div className="border-b border-[var(--camscan-border)] bg-[var(--camscan-surface)] no-print">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-2 px-3 py-2 sm:px-6">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold">{book.title}</h1>
            <p className="truncate text-xs text-[var(--camscan-text-muted)]">
              {book.author ? `${book.author} · ` : ''}{pages.length} {t(lang, 'pages')}
              {current ? ` · ${t(lang, 'page')} ${index + 1}${current.printedPageNumber ? ` (${current.printedPageNumber})` : ''}` : ''}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <div className="flex overflow-hidden rounded-lg border border-[var(--camscan-border)]" role="tablist" aria-label={t(lang, 'preview')}>
              {([
                ['replica', t(lang, 'replica')],
                ['original', t(lang, 'original')],
                ['side-by-side', t(lang, 'sideBySide')],
                ['comfortable', t(lang, 'comfortable')],
              ] as const).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={view === key}
                  onClick={() => setView(key)}
                  className={`px-2.5 py-1.5 text-xs ${view === key ? 'bg-[var(--camscan-text)] text-[var(--camscan-bg)]' : 'text-[var(--camscan-text-muted)]'}`}
                >
                  {label}
                </button>
              ))}
            </div>

            <Link href={`/book/${book.id}/scan`}>
              <Button size="sm" variant="secondary">📷 {t(lang, 'continueScanning')}</Button>
            </Link>
            <Button size="sm" variant="accent" onClick={() => setExportOpen(true)}>{t(lang, 'exportPdf')}</Button>
            <Button size="sm" variant="secondary" disabled={!model || !modelPlainText(model).trim()} onClick={() => setAiOpen(true)}>
              ✦ {lang === 'ar' ? 'مساعد AI' : 'AI assistant'}
            </Button>
            <Button size="sm" variant="secondary" disabled={!model} onClick={exportStructuredJson}>
              {lang === 'ar' ? 'تصدير OCR JSON' : 'Export OCR JSON'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setManageOpen(true)}>⋯</Button>
          </div>
        </div>

        {/* search row */}
        <div className="mx-auto flex w-full max-w-7xl items-center gap-2 px-3 pb-2 sm:px-6">
          <div className="relative flex-1">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t(lang, 'searchInBook')}
              aria-label={t(lang, 'searchInBook')}
              className="h-9 w-full rounded-lg border border-[var(--camscan-border)] bg-[var(--camscan-bg)] px-3 text-sm"
            />
          </div>
          <span className="text-xs text-[var(--camscan-text-muted)]">
            {query ? `${inBookResults.length}` : ''}
          </span>
          {editing ? (
            <>
              <Button size="sm" variant="ghost" onClick={cancelEdits}>{t(lang, 'cancel')}</Button>
              <Button size="sm" variant="primary" loading={saving} onClick={() => void saveEdits()}>{t(lang, 'saveEdits')}</Button>
            </>
          ) : (
            <Button size="sm" variant="secondary" disabled={!current?.pageModel} onClick={startEditing}>
              ✎ {t(lang, 'edit')}
            </Button>
          )}
        </div>

        {inBookResults.length > 0 ? (
          <div className="mx-auto max-h-40 w-full max-w-7xl overflow-y-auto border-t border-[var(--camscan-border)] px-3 py-1.5 sm:px-6">
            <ul className="space-y-0.5">
              {inBookResults.slice(0, 30).map((hit) => (
                <li key={hit.pageId}>
                  <button
                    type="button"
                    onClick={() => {
                      const idx = pages.findIndex((p) => p.id === hit.pageId);
                      if (idx >= 0) { setIndex(idx); setEditing(false); }
                    }}
                    className="w-full rounded px-2 py-1 text-start text-xs hover:bg-[var(--camscan-surface-2)]"
                  >
                    <span className="me-2 font-medium">{t(lang, 'page')} {hit.pageNumber}</span>
                    {highlightSegments(hit.snippet, query).map((s, i) =>
                      s.hit ? <mark key={i} className="rounded bg-[var(--color-warn-100)]">{s.text}</mark> : <span key={i}>{s.text}</span>,
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      {/* -------- content -------- */}
      <div className="flex flex-1 overflow-hidden">
        {/* thumbnails sidebar (desktop) */}
        <aside className="hidden w-36 shrink-0 overflow-y-auto border-e border-[var(--camscan-border)] bg-[var(--camscan-surface)] p-2 lg:block camscan-scroll no-print">
          {pages.map((p, i) => (
            <button
              key={p.id}
              type="button"
              onClick={() => { setIndex(i); setEditing(false); }}
              className={`mb-2 block w-full overflow-hidden rounded-lg border-2 text-start ${
                i === index ? 'border-[var(--camscan-accent)]' : 'border-transparent'
              }`}
              aria-current={i === index}
            >
              {p.thumb ? (
                 
                <img src={p.thumb} alt="" className="aspect-[3/4] w-full object-cover" />
              ) : (
                <div className="grid aspect-[3/4] w-full place-items-center bg-[var(--camscan-surface-2)] text-xs">
                  {i + 1}
                </div>
              )}
              <span className="flex items-center justify-between px-1 py-0.5 text-[10px]">
                <span>{i + 1}</span>
                <span aria-hidden="true">
                  {p.status === 'review' ? '⚠' : p.status === 'failed' ? '✕' : p.status === 'processing' ? '●' : ''}
                </span>
              </span>
            </button>
          ))}
        </aside>

        {/* page canvas */}
        <div ref={containerRef} className="flex flex-1 flex-col overflow-auto camscan-scroll">
          {pages.length === 0 ? (
            <div className="p-6">
              <EmptyState
                title={t(lang, 'noPages')}
                description={t(lang, 'noPagesHelp')}
                action={<Link href={`/book/${book.id}/scan`}><Button variant="accent">{t(lang, 'startScanning')}</Button></Link>}
              />
            </div>
          ) : current ? (
            <>
              <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs no-print">
                <div className="flex items-center gap-2">
                  <StatusPill
                    status={current.status}
                    reviewed={current.reviewed}
                    labels={{
                      done: t(lang, 'done'), review: t(lang, 'needsReview'), processing: t(lang, 'processing'),
                      queued: t(lang, 'queued'), failed: t(lang, 'failed'), blank: t(lang, 'blank'),
                    }}
                  />
                  {current.avgConfidence ? (
                    <span className="text-[var(--camscan-text-muted)]">{t(lang, 'confidence')}: {Math.round(current.avgConfidence)}%</span>
                  ) : null}
                  {current.userEdited ? <Badge tone="info">✎</Badge> : null}
                  {current.status === 'processing' ? (
                    <Progress value={current.progress} className="w-24" />
                  ) : null}
                </div>
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setZoom((z) => Math.max(0.6, Number((z - 0.1).toFixed(2))))} aria-label="−">−</Button>
                  <span className="w-10 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
                  <Button size="sm" variant="ghost" onClick={() => setZoom((z) => Math.min(2.2, Number((z + 0.1).toFixed(2))))} aria-label="+">+</Button>
                  <Button size="sm" variant="ghost" onClick={() => setShowOutlines((v) => !v)} aria-pressed={showOutlines} title={t(lang, 'pageActions')}>
                    ▦
                  </Button>
                </div>
              </div>

              <div className="flex-1 overflow-auto p-3 camscan-scroll">
                {current.status === 'queued' || current.status === 'processing' ? (
                  <div className="mx-auto max-w-md rounded-xl border border-[var(--camscan-border)] bg-[var(--camscan-surface)] p-6 text-center">
                    <Spinner size={26} />
                    <p className="mt-2 text-sm">{t(lang, 'processing')}…</p>
                    <Progress value={current.progress} className="mt-3" label={current.stage} />
                    {originalUrl ? (
                       
                      <img src={originalUrl} alt="" className="mt-4 max-h-64 w-auto rounded opacity-80" />
                    ) : null}
                  </div>
                ) : current.status === 'failed' ? (
                  <Card className="mx-auto max-w-md p-6 text-center">
                    <p className="text-sm font-medium text-[var(--color-danger-600)]">{t(lang, 'failed')}</p>
                    <p className="mt-1 text-xs text-[var(--camscan-text-muted)]">{t(lang, 'editsProtected')}</p>
                    <div className="mt-3 flex justify-center gap-2">
                      <Button size="sm" variant="secondary" onClick={() => void getProcessingPool(repo).retry(current.id, bookId)}>
                        {t(lang, 'retry')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setView('original')}>{t(lang, 'original')}</Button>
                    </div>
                    {originalUrl ? (
                       
                      <img src={originalUrl} alt="" className="mt-4 w-full rounded" />
                    ) : null}
                  </Card>
                ) : (
                  <div className={`flex ${view === 'side-by-side' ? 'flex-wrap gap-4' : 'justify-center'} pb-8`}>
                    {(view === 'replica' || view === 'side-by-side') && model ? (
                      <ReplicaPage
                        model={model}
                        width={pageWidth}
                        editing={editing}
                        query={query}
                        onBlockChange={updateBlockText}
                        onSelectBlock={editing ? setSelectedBlock : undefined}
                        selectedBlockId={selectedBlock}
                        showOutlines={showOutlines}
                      />
                    ) : view === 'comfortable' ? (
                      <div className="w-full rounded-xl border border-[var(--camscan-border)] bg-[var(--camscan-surface)]">
                        <ComfortablePage model={draftModel ?? current.pageModel ?? emptyModel(current)} query={query} onBlockChange={editing ? updateBlockText : undefined} />
                      </div>
                    ) : null}

                    {(view === 'original' || view === 'side-by-side') ? (
                      <div className="flex flex-col items-center gap-1">
                        {originalUrl ? (
                          <div className="relative">
                            {/*
                              The rectified + text-enhanced image is what OCR actually
                              read, so it is the more useful proofreading surface for
                              old/yellowed paper. A toggle keeps the untouched capture
                              one tap away — the original is never lost or altered.
                            */}
                            <img
                              src={showRawOriginal || !processedUrl ? originalUrl : processedUrl}
                              alt={`${lang === 'ar' ? 'الصورة الأصلية للصفحة' : 'Original capture of page'} ${index + 1}`}
                              className="rounded-sm shadow-[0_2px_18px_rgba(36,29,18,0.22)]"
                              style={{ width: pageWidth }}
                            />
                            {processedUrl ? (
                              <button
                                type="button"
                                onClick={() => setShowRawOriginal((v) => !v)}
                                className="absolute end-2 top-2 rounded-full bg-black/55 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur"
                              >
                                {showRawOriginal
                                  ? (lang === 'ar' ? 'الصورة المحسّنة' : 'Cleaned')
                                  : (lang === 'ar' ? 'الصورة الخام' : 'Raw')}
                              </button>
                            ) : null}
                          </div>
                        ) : (
                          <div className="grid place-items-center bg-[var(--camscan-surface-2)]" style={{ width: pageWidth, height: pageWidth * 1.4 }}>
                            <Spinner />
                          </div>
                        )}
                        <span className="text-[10px] text-[var(--camscan-text-muted)]">
                          {t(lang, 'original')}
                          {processedUrl ? (showRawOriginal ? '' : lang === 'ar' ? ' · محسّنة' : ' · cleaned') : ''}
                        </span>
                      </div>
                    ) : null}
                  </div>
                )}

                {/* block inspector while editing */}
                {editing && model ? (
                  <BlockInspector
                    lang={lang}
                    model={draftModel ?? model}
                    selectedBlockId={selectedBlock}
                    onChange={updateBlockStyle}
                    book={book}
                    onApplyFontAll={async (font) => {
                      if (!draftModel) return;
                      const next: PageModel = {
                        ...draftModel,
                        blocks: draftModel.blocks.map((b) => ({ ...b, fontFamily: font })),
                      };
                      setDraftModel(next);
                    }}
                  />
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      </div>

      {/* -------- bottom navigation bar -------- */}
      {pages.length > 0 ? (
        <nav className="sticky bottom-0 z-20 border-t border-[var(--camscan-border)] bg-[var(--camscan-surface)]/95 backdrop-blur no-print">
          <div className="mx-auto flex max-w-3xl items-center gap-3 px-3 py-2">
            <Button
              variant="secondary" size="lg" disabled={index === 0} onClick={() => go(-1)}
              aria-label={t(lang, 'previousPage')}
            >
              {settings.uiLanguage === 'ar' ? '→' : '←'}
            </Button>
            <div className="flex flex-1 items-center gap-2">
              <input
                type="range" min={1} max={pages.length} value={index + 1}
                onChange={(e) => { setIndex(Number(e.target.value) - 1); setEditing(false); }}
                className="w-full accent-[var(--camscan-accent)]"
                aria-label={t(lang, 'jumpToPage')}
              />
              <span className="w-20 shrink-0 text-center text-sm tabular-nums">
                {index + 1} / {pages.length}
              </span>
            </div>
            <Button
              variant="secondary" size="lg" disabled={index >= pages.length - 1} onClick={() => go(1)}
              aria-label={t(lang, 'nextPage')}
            >
              {settings.uiLanguage === 'ar' ? '←' : '→'}
            </Button>
          </div>
        </nav>
      ) : null}

      {/* -------- dialogs -------- */}
      <ExportDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        book={book}
        pages={pages}
        lang={lang}
      />

      <FreeAiDialog
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        lang={lang}
        bookTitle={book.title}
        pageNumber={index + 1}
        pageText={model ? modelPlainText(model) : current?.plainText ?? ''}
        bookText={pages.map((p, i) => `--- ${lang === 'ar' ? 'صفحة' : 'Page'} ${i + 1} ---\n${i === index && model ? modelPlainText(model) : p.plainText ?? ''}`).filter((text) => text.trim()).join('\n\n')}
      />

      <Modal
        open={manageOpen}
        onClose={() => setManageOpen(false)}
        title={t(lang, 'pageActions')}
        footer={<Button variant="ghost" onClick={() => setManageOpen(false)}>{t(lang, 'close')}</Button>}
      >
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" onClick={() => void movePage(-1)} disabled={index === 0}>↑ {t(lang, 'moveUp')}</Button>
            <Button variant="secondary" onClick={() => void movePage(1)} disabled={index >= pages.length - 1}>↓ {t(lang, 'moveDown')}</Button>
            <Button variant="secondary" onClick={() => void toggleReviewed()}>{current?.reviewed ? '↺' : '✓'} {current?.reviewed ? t(lang, 'reviewed') : t(lang, 'markReviewed')}</Button>
            <Button variant="secondary" onClick={() => void markBlank()}>{current?.blank ? '▣' : '▢'} {t(lang, 'blank')}</Button>
            <Button variant="secondary" onClick={() => setReprocessOpen(true)}>↻ {t(lang, 'reprocess')}</Button>
            <Button variant="danger" onClick={() => void deleteCurrent()}>🗑 {t(lang, 'deletePage')}</Button>
          </div>
          <div className="rounded-lg bg-[var(--camscan-surface-2)] p-3 text-xs text-[var(--camscan-text-muted)]">
            <p>{t(lang, 'reorderHint')}</p>
            <p className="mt-1">{t(lang, 'fontNote')}</p>
            {current?.userEdited ? <p className="mt-1 font-medium text-[var(--color-warn-500)]">{t(lang, 'editsProtected')}</p> : null}
          </div>
          <Button variant="secondary" className="w-full" onClick={async () => {
            if (!book) return;
            if (!confirm(t(lang, 'reprocessConfirm'))) return;
            const pool = getProcessingPool(repo);
            for (const p of pages) {
              await repo.updatePageStatus(p.id, 'queued', { progress: 0, stage: 'queued' });
              await pool.enqueue(p.id, bookId, {
                languages: book.settings.ocrLanguages,
                profile: book.settings.captureProfile,
                arabicFont: book.defaultFonts.arabicFont,
                latinFont: book.defaultFonts.latinFont,
                reviewThreshold: book.settings.reviewThreshold,
                reprocess: true,
              });
            }
            setManageOpen(false);
            push(lang === 'ar' ? 'أُضيفت كل الصفحات لإعادة المعالجة' : 'All pages queued for re-processing', 'info');
          }}>
            ↻ {t(lang, 'reprocessAll')}
          </Button>
        </div>
      </Modal>

      <Modal
        open={reprocessOpen}
        onClose={() => setReprocessOpen(false)}
        title={t(lang, 'reprocessConflictTitle')}
        footer={<Button variant="ghost" onClick={() => setReprocessOpen(false)}>{t(lang, 'cancel')}</Button>}
      >
        <p className="text-sm text-[var(--camscan-text-muted)]">{t(lang, 'reprocessConflictBody')}</p>
        <div className="mt-4 space-y-2">
          <Button variant="secondary" className="w-full" onClick={() => void reprocessCurrent(false)}>
            {t(lang, 'keepEdits')}
          </Button>
          <Button variant="danger" className="w-full" onClick={() => void reprocessCurrent(true)}>
            {t(lang, 'replaceText')}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Block style inspector                                               */
/* ------------------------------------------------------------------ */

function BlockInspector({
  lang, model, selectedBlockId, onChange, book, onApplyFontAll,
}: {
  lang: 'ar' | 'en';
  model: PageModel;
  selectedBlockId: string | null;
  onChange: (id: string, patch: Partial<PageModel['blocks'][number]>) => void;
  book: Book;
  onApplyFontAll: (font: string) => void;
}) {
  const block = model.blocks.find((b) => b.id === selectedBlockId) ?? null;
  const fonts = [
    { css: "'Amiri', serif", label: 'Amiri (Naskh)' },
    { css: "'Scheherazade New', serif", label: 'Scheherazade New' },
    { css: "'Noto Naskh Arabic', serif", label: 'Noto Naskh Arabic' },
    { css: "'Noto Kufi Arabic', sans-serif", label: 'Noto Kufi Arabic' },
    { css: "'Cairo', sans-serif", label: 'Cairo' },
    { css: "'EB Garamond', serif", label: 'EB Garamond' },
    { css: "'Merriweather', serif", label: 'Merriweather' },
    { css: "'Inter', sans-serif", label: 'Inter' },
    { css: "'JetBrains Mono', monospace", label: 'JetBrains Mono' },
  ];

  if (!block) {
    return (
      <Card className="mx-auto mt-4 max-w-2xl p-3 text-xs text-[var(--camscan-text-muted)]">
        {t(lang, 'reviewNote')}
      </Card>
    );
  }

  return (
    <Card className="mx-auto mt-4 max-w-2xl p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <Select label={t(lang, 'font')} value={block.fontFamily} onChange={(e) => onChange(block.id, { fontFamily: e.target.value })}>
          {fonts.map((f) => <option key={f.css} value={f.css}>{f.label}</option>)}
        </Select>
        <Select label={t(lang, 'blockType')} value={block.type} onChange={(e) => onChange(block.id, { type: e.target.value as PageModel['blocks'][number]['type'] })}>
          {['heading', 'paragraph', 'footnote', 'pageNumber', 'header', 'footer', 'caption', 'marginalNote'].map((tp) => (
            <option key={tp} value={tp}>{tp}</option>
          ))}
        </Select>
        <Select label={t(lang, 'align')} value={block.align} onChange={(e) => onChange(block.id, { align: e.target.value as PageModel['blocks'][number]['align'] })}>
          <option value="start">start</option>
          <option value="center">center</option>
          <option value="end">end</option>
          <option value="justify">justify</option>
        </Select>
        <label className="text-sm">
          <span className="mb-1.5 block font-medium">{t(lang, 'fontSize')}</span>
          <input
            type="range" min={0.008} max={0.06} step={0.001}
            value={block.fontSize}
            onChange={(e) => onChange(block.id, { fontSize: Number(e.target.value) })}
            className="w-full accent-[var(--camscan-accent)]"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1.5 block font-medium">{t(lang, 'color')}</span>
          <input type="color" value={block.color} onChange={(e) => onChange(block.id, { color: e.target.value })} className="h-9 w-full rounded border border-[var(--camscan-border)]" />
        </label>
        <label className="flex items-center gap-2 self-end text-sm">
          <input type="checkbox" checked={block.fontWeight === 700} onChange={(e) => onChange(block.id, { fontWeight: e.target.checked ? 700 : 400 })} className="h-4 w-4 accent-[var(--camscan-accent)]" />
          bold
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Badge tone="neutral">{t(lang, 'confidence')}: {Math.round(block.confidence)}%</Badge>
        <Button
          size="sm" variant="ghost"
          onClick={() => {
            if (confirm(t(lang, 'applyFontConfirm'))) onApplyFontAll(block.fontFamily);
          }}
        >
          {t(lang, 'applyFontAll')}
        </Button>
        <span className="text-[11px] text-[var(--camscan-text-muted)]">{t(lang, 'fontNote')}</span>
      </div>
      <p className="mt-2 text-[11px] text-[var(--camscan-text-muted)]">
        {t(lang, 'reviewNote')} · {book.title}
      </p>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Export dialog                                                       */
/* ------------------------------------------------------------------ */

function ExportDialog({
  open, onClose, book, pages, lang,
}: {
  open: boolean;
  onClose: () => void;
  book: Book;
  pages: PageRow[];
  lang: 'ar' | 'en';
}) {
  const { repo } = useApp();
  const { push } = useToast();
  const [mode, setMode] = useState<'replica' | 'photos'>('replica');
  const [range, setRange] = useState({ from: 1, to: Math.max(1, pages.length) });
  const [includeTitle, setIncludeTitle] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState('');

  useEffect(() => {
    setRange({ from: 1, to: Math.max(1, pages.length) });
  }, [pages.length]);

  const selected = pages.slice(
    Math.max(0, range.from - 1),
    Math.min(pages.length, range.to),
  );

  const run = async () => {
    if (!selected.length) return;
    setBusy(true);
    setProgress(0);
    try {
      const inputs = [];
      for (const [i, page] of selected.entries()) {
        setStage(`${i + 1}/${selected.length}`);
        if (mode === 'photos') {
          const blob = await repo.getOriginalImage(page.id);
          if (!blob) continue;
          inputs.push({
            model: page.pageModel ?? emptyModel(page),
            originalJpeg: new Uint8Array(await blob.arrayBuffer()),
          });
        } else {
          if (!page.pageModel) continue;
          // Crop illustrations out of the processed image so the PDF keeps them.
          const images = new Map<string, Uint8Array>();
          await Promise.all(
            page.pageModel.blocks
              .filter((b) => b.type === 'illustration' && b.imageUrl?.startsWith('data:'))
              .map(async (b) => {
                try {
                  const res = await fetch(b.imageUrl!);
                  images.set(b.imageUrl!, new Uint8Array(await res.arrayBuffer()));
                } catch { /* skip broken illustration */ }
              }),
          );
          inputs.push({ model: page.pageModel, images });
        }
        setProgress((i + 1) / selected.length * 0.3);
      }
      const result = await exportBookToPdf({
        book,
        pages: inputs,
        mode,
        includeTitlePage: includeTitle,
        onProgress: (done, total) => setProgress(0.3 + (done / Math.max(1, total)) * 0.7),
      });
      downloadBlob(result.blob, safeFilename(book.title, 'pdf'));
      await repo.addExport({ bookId: book.id, format: mode === 'photos' ? 'pdf-photos' : 'pdf-replica', state: 'done', pageCount: result.pageCount });
      push(`${t(lang, 'exportDone')} · ${result.pageCount} ${t(lang, 'pages')}`, 'success');
      onClose();
    } catch (err) {
      push(`${t(lang, 'exportError')}: ${(err as Error).message}`, 'error', 8000);
      await repo.addExport({ bookId: book.id, format: mode === 'photos' ? 'pdf-photos' : 'pdf-replica', state: 'failed', error: (err as Error).message });
    } finally {
      setBusy(false);
      setStage('');
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t(lang, 'exportTitle')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t(lang, 'cancel')}</Button>
          <Button variant="accent" loading={busy} onClick={() => void run()}>{t(lang, 'exportStart')}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <fieldset>
          <legend className="mb-2 text-sm font-medium">{t(lang, 'preview')}</legend>
          <label className={`mb-2 flex cursor-pointer gap-2 rounded-xl border p-3 ${mode === 'replica' ? 'border-[var(--camscan-accent)] bg-[var(--color-accent-50)]' : 'border-[var(--camscan-border)]'}`}>
            <input type="radio" name="mode" checked={mode === 'replica'} onChange={() => setMode('replica')} className="mt-1" />
            <span>
              <span className="block text-sm font-medium">{t(lang, 'exportReplica')}</span>
              <span className="block text-xs text-[var(--camscan-text-muted)]">{t(lang, 'exportSearchableNote')}</span>
            </span>
          </label>
          <label className={`flex cursor-pointer gap-2 rounded-xl border p-3 ${mode === 'photos' ? 'border-[var(--camscan-accent)] bg-[var(--color-accent-50)]' : 'border-[var(--camscan-border)]'}`}>
            <input type="radio" name="mode" checked={mode === 'photos'} onChange={() => setMode('photos')} className="mt-1" />
            <span>
              <span className="block text-sm font-medium">{t(lang, 'exportPhotos')}</span>
              <span className="block text-xs text-[var(--camscan-text-muted)]">
                {lang === 'ar' ? 'ملف صور غير قابل للبحث — للحفظ فقط.' : 'Image-based, not searchable — archival fallback only.'}
              </span>
            </span>
          </label>
        </fieldset>

        <div>
          <p className="mb-1.5 text-sm font-medium">{t(lang, 'exportRange')}</p>
          <div className="flex items-center gap-2">
            <Field label={t(lang, 'fromPage')} type="number" min={1} max={pages.length} value={range.from}
              onChange={(e) => setRange({ ...range, from: Math.max(1, Math.min(pages.length, Number(e.target.value))) })}
              inputMode="numeric" className="w-24" />
            <Field label={t(lang, 'toPage')} type="number" min={1} max={pages.length} value={range.to}
              onChange={(e) => setRange({ ...range, to: Math.max(1, Math.min(pages.length, Number(e.target.value))) })}
              inputMode="numeric" className="w-24" />
            <span className="mt-5 text-xs text-[var(--camscan-text-muted)]">
              {selected.filter((p) => mode === 'photos' || p.pageModel).length} {t(lang, 'pages')}
            </span>
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={includeTitle} onChange={(e) => setIncludeTitle(e.target.checked)} className="h-4 w-4 accent-[var(--camscan-accent)]" />
          {t(lang, 'includeMetadata')}
        </label>

        {busy ? (
          <Progress value={progress} label={`${t(lang, 'exportProgress')} ${stage}`} />
        ) : (
          <p className="rounded-lg bg-[var(--camscan-surface-2)] p-3 text-xs text-[var(--camscan-text-muted)]">
            {t(lang, 'confidenceNote')}
          </p>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

function emptyModel(page: PageRow): PageModel {
  return {
    schemaVersion: 2,
    pageId: page.id,
    sequence: page.order + 1,
    aspectRatio: page.height ? page.width / page.height : 0.72,
    paperColor: '#f7f1e3',
    inkColor: '#241d12',
    direction: page.direction,
    language: page.language,
    orientation: 0,
    bodyFontSize: 0.022,
    blocks: [],
    provenance: { engine: 'none', languages: [page.language], processedAt: new Date().toISOString() },
  };
}
