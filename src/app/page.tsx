'use client';

/**
 * CamScan — home library.
 *
 *  - global full-text search across every book (Arabic-normalised, fuzzy)
 *  - responsive grid of book cards rendered from compact metadata only
 *  - add book / rename / delete / export / continue scanning
 *  - sorting + status filtering designed to stay fast with hundreds of books
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLiveQuery } from 'dexie-react-hooks';
import { AppHeader } from '@/components/AppHeader';
import { useApp } from '@/components/AppProviders';
import { useToast } from '@/components/Toast';
import { Badge, Button, Card, EmptyState, Field, Modal, Progress, Select, Spinner } from '@/components/ui';
import { t } from '@/lib/i18n';
import { highlightSegments } from '@/lib/normalize';
import { getSearchIndex, type SearchHit } from '@/lib/search';
import type { Book, BookLanguage } from '@/lib/types';
import { LANGUAGES } from '@/lib/i18n';
import { safeFilename, exportBookToPdf, downloadBlob } from '@/lib/pdf/browserExport';
import { getProcessingPool } from '@/lib/pipeline';

type SortKey = 'recent' | 'oldest' | 'title' | 'pages';
type StatusFilter = 'all' | 'scanning' | 'review' | 'done';

export default function HomePage() {
  const { repo, settings, ready, fatalError } = useApp();
  const { push } = useToast();
  const lang = settings.uiLanguage;
  const router = useRouter();

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [sort, setSort] = useState<SortKey>('recent');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [authorFilter, setAuthorFilter] = useState('');
  const [languageFilter, setLanguageFilter] = useState('all');
  const [createdAfter, setCreatedAfter] = useState('');
  const [createdBefore, setCreatedBefore] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Book | null>(null);
  const [deleting, setDeleting] = useState<Book | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [exportProgress, setExportProgress] = useState<{ bookId: string; value: number } | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const books = useLiveQuery(async () => {
    if (!ready || fatalError) return [];
    return repo.listBooks();
  }, [repo, ready, fatalError]) ?? [];

  /* ---------------- search ---------------- */
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!query.trim()) {
      setHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    searchTimer.current = setTimeout(() => {
      try {
        const index = getSearchIndex();
        const results = index.search(query, { limit: 80 });
        setHits(results);
      } catch (err) {
        console.warn('search failed', err);
        setHits([]);
      } finally {
        setSearching(false);
      }
    }, 140);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [query]);

  const groupedHits = useMemo(() => {
    const map = new Map<string, { title: string; author?: string; hits: SearchHit[] }>();
    for (const hit of hits) {
      const entry = map.get(hit.bookId) ?? { title: hit.bookTitle, author: hit.author, hits: [] };
      entry.hits.push(hit);
      map.set(hit.bookId, entry);
    }
    return [...map.entries()];
  }, [hits]);

  const authors = useMemo(
    () => [...new Set(books.map((book) => book.author?.trim()).filter((author): author is string => Boolean(author)))].sort((a, b) => a.localeCompare(b, lang === 'ar' ? 'ar' : 'en')),
    [books, lang],
  );

  const visibleBooks = useMemo(() => {
    const from = createdAfter ? Date.parse(`${createdAfter}T00:00:00`) : Number.NEGATIVE_INFINITY;
    const to = createdBefore ? Date.parse(`${createdBefore}T23:59:59.999`) : Number.POSITIVE_INFINITY;
    const filtered = books.filter((b) => {
      if (statusFilter === 'scanning' && !(b.pageCount === 0 || b.doneCount + b.reviewCount < b.pageCount)) return false;
      if (statusFilter === 'review' && b.reviewCount <= 0) return false;
      if (statusFilter === 'done' && !(b.pageCount > 0 && b.reviewCount === 0 && b.doneCount === b.pageCount)) return false;
      if (authorFilter && (b.author?.trim() ?? '') !== authorFilter) return false;
      if (languageFilter !== 'all' && b.language !== languageFilter && !(b.additionalLanguages ?? []).includes(languageFilter)) return false;
      if (b.createdAt < from || b.createdAt > to) return false;
      return true;
    });
    const sorted = [...filtered];
    switch (sort) {
      case 'title': sorted.sort((a, b) => a.title.localeCompare(b.title, lang === 'ar' ? 'ar' : 'en')); break;
      case 'pages': sorted.sort((a, b) => b.pageCount - a.pageCount); break;
      case 'oldest': sorted.sort((a, b) => a.createdAt - b.createdAt); break;
      default: sorted.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    return sorted;
  }, [books, sort, statusFilter, authorFilter, languageFilter, createdAfter, createdBefore, lang]);

  /* ---------------- actions ---------------- */
  const handleExport = useCallback(async (book: Book, appendOriginalPhotos = false) => {
    setBusy(book.id);
    setExportProgress({ bookId: book.id, value: 0 });
    try {
      const pages = await repo.listPages(book.id);
      const withModels = pages.filter((p) => p.pageModel);
      if (!withModels.length) {
        push(lang === 'ar' ? 'لا توجد صفحات معالجة بعد' : 'No processed pages yet', 'warn');
        return;
      }
      const pdfPages = await Promise.all(withModels.map(async (page) => ({
        model: page.pageModel!,
        ...(appendOriginalPhotos ? { originalJpeg: new Uint8Array(await page.originalImage.arrayBuffer()) } : {}),
      })));
      const result = await exportBookToPdf({
        book,
        pages: pdfPages,
        mode: 'replica',
        includeTitlePage: true,
        appendOriginalPhotos,
        onProgress: (done, total) => setExportProgress({ bookId: book.id, value: total ? done / total : 0 }),
      });
      downloadBlob(result.blob, safeFilename(book.title, 'pdf'));
      push(`${t(lang, 'exportDone')} · ${result.pageCount} ${t(lang, 'pages')} · ${(result.bytes / 1024).toFixed(0)} KB`, 'success');
      await repo.addExport({ bookId: book.id, format: 'pdf-replica', state: 'done', pageCount: result.pageCount });
    } catch (err) {
      push(`${t(lang, 'exportError')}: ${(err as Error).message}`, 'error', 6000);
      await repo.addExport({ bookId: book.id, format: 'pdf-replica', state: 'failed', error: (err as Error).message });
    } finally {
      setBusy(null);
      setExportProgress(null);
    }
  }, [repo, push, lang]);

  const handleDelete = useCallback(async (book: Book) => {
    setBusy(book.id);
    try {
      getSearchIndex().removeBook(book.id);
      await repo.deleteBook(book.id);
      push(lang === 'ar' ? 'تم حذف الكتاب' : 'Book deleted', 'success');
      setDeleting(null);
    } catch (err) {
      push((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  }, [repo, push, lang]);

  if (fatalError) {
    return (
      <main className="mx-auto max-w-2xl p-6">
        <Card className="p-6">
          <h1 className="text-lg font-semibold">{t(lang, 'cameraUnavailable')}</h1>
          <p className="mt-2 text-sm text-[var(--camscan-text-muted)]">{fatalError}</p>
          <p className="mt-2 text-sm text-[var(--camscan-text-muted)]">
            {lang === 'ar'
              ? 'كام سكان يحتاج إلى IndexedDB لتخزين مكتبتك محليًا. جرّب نافذة تصفح عادية (وليست خاصة) أو متصفحًا أحدث.'
              : 'CamScan needs IndexedDB to store your library locally. Try a normal (not private) window or a newer browser.'}
          </p>
        </Card>
      </main>
    );
  }

  return (
    <>
      <AppHeader />
      <main className="mx-auto w-full max-w-7xl px-3 pb-24 pt-3 sm:px-6">
        {/* ---------- hero + search ---------- */}
        <section className="mb-6 rounded-2xl border border-[var(--camscan-border)] bg-gradient-to-b from-[var(--camscan-surface-2)] to-[var(--camscan-surface)] p-4 sm:p-6">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="font-[family-name:var(--font-arabic-display)] text-2xl font-bold tracking-tight sm:text-3xl">
                {t(lang, 'appTagline')}
              </h1>
              <p className="mt-1 text-sm text-[var(--camscan-text-muted)]">{t(lang, 'privacyNote')}</p>
            </div>
            <Button variant="accent" size="lg" onClick={() => setAddOpen(true)} className="shrink-0">
              <span aria-hidden="true" className="text-xl leading-none">＋</span> {t(lang, 'addBook')}
            </Button>
          </div>

          <div className="relative">
            <label htmlFor="global-search" className="sr-only">{t(lang, 'search')}</label>
            <svg
              className="pointer-events-none absolute inset-y-0 start-3 my-auto text-[var(--camscan-text-muted)]"
              width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
              <path d="m16.5 16.5 4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <input
              id="global-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t(lang, 'searchPlaceholder')}
              aria-describedby="search-help"
              className="h-14 w-full rounded-xl border border-[var(--camscan-border)] bg-[var(--camscan-surface)] pe-4 ps-11 text-[16px] shadow-sm placeholder:text-[var(--camscan-text-muted)]/70"
            />
            <span id="search-help" className="sr-only">
              {lang === 'ar'
                ? 'يبحث في عناوين الكتب ونصوص كل الصفحات، متجاهلًا التشكيل وأشكال الألف'
                : 'Searches book titles and every page, ignoring diacritics and alef variants'}
            </span>
            {searching ? (
              <span className="absolute inset-y-0 end-3 my-auto flex items-center">
                <Spinner />
              </span>
            ) : null}
          </div>
        </section>

        {/* ---------- search results ---------- */}
        {query.trim() ? (
          <section aria-live="polite" className="mb-8">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--camscan-text-muted)]">
              {t(lang, 'searchResults')} · {hits.length}
            </h2>
            {hits.length === 0 ? (
              <Card className="p-6 text-center text-sm text-[var(--camscan-text-muted)]">{t(lang, 'noResults')}</Card>
            ) : (
              <div className="space-y-4">
                {groupedHits.map(([bookId, group]) => (
                  <Card key={bookId} className="overflow-hidden">
                    <div className="flex items-center justify-between gap-3 border-b border-[var(--camscan-border)] bg-[var(--camscan-surface-2)] px-4 py-2.5">
                      <Link href={`/book/${bookId}`} className="font-semibold hover:underline">
                        {group.title}
                      </Link>
                      <span className="text-xs text-[var(--camscan-text-muted)]">
                        {group.hits.length} {lang === 'ar' ? 'نتيجة' : 'matches'}
                      </span>
                    </div>
                    <ul className="divide-y divide-[var(--camscan-border)]">
                      {group.hits.slice(0, 12).map((hit) => (
                        <li key={hit.pageId}>
                          <Link
                            href={`/book/${bookId}?page=${hit.pageNumber}&q=${encodeURIComponent(query)}`}
                            className="block px-4 py-3 hover:bg-[var(--camscan-surface-2)]"
                          >
                            <span className="mb-1 flex items-center gap-2 text-xs text-[var(--camscan-text-muted)]">
                              <Badge tone="neutral">
                                {t(lang, 'page')} {hit.pageNumber}
                                {hit.printedNumber && hit.printedNumber !== String(hit.pageNumber) ? ` · ${hit.printedNumber}` : ''}
                              </Badge>
                              {hit.fuzzy ? <Badge tone="info">≈</Badge> : null}
                            </span>
                            <span className="block text-sm leading-relaxed">
                              {highlightSegments(hit.snippet, query).map((seg, i) =>
                                seg.hit ? (
                                  <mark key={i} className="rounded bg-[var(--color-warn-100)] px-0.5 text-[var(--color-warn-500)]">{seg.text}</mark>
                                ) : (
                                  <span key={i}>{seg.text}</span>
                                ),
                              )}
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </Card>
                ))}
              </div>
            )}
          </section>
        ) : null}

        {/* ---------- library ---------- */}
        <section>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="me-auto text-lg font-semibold">
              {t(lang, 'library')}
              <span className="ms-2 text-sm font-normal text-[var(--camscan-text-muted)]">
                {visibleBooks.length} {t(lang, 'books')}
              </span>
            </h2>
            <Segmented
              value={statusFilter}
              onChange={(v) => setStatusFilter(v as StatusFilter)}
              options={[
                { value: 'all', label: t(lang, 'statusAll') },
                { value: 'scanning', label: t(lang, 'statusScanning') },
                { value: 'review', label: t(lang, 'statusReview') },
                { value: 'done', label: t(lang, 'statusDone') },
              ]}
            />
            <Select
              aria-label={t(lang, 'sortBy')}
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="h-9 w-auto text-sm"
            >
              <option value="recent">{t(lang, 'sortNewest')}</option>
              <option value="oldest">{t(lang, 'sortOldest')}</option>
              <option value="title">{t(lang, 'sortTitle')}</option>
              <option value="pages">{t(lang, 'sortPages')}</option>
            </Select>
          </div>

          <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-5">
            <Select
              aria-label={lang === 'ar' ? 'تصفية حسب المؤلف' : 'Filter by author'}
              value={authorFilter}
              onChange={(e) => setAuthorFilter(e.target.value)}
              className="h-9 w-full text-sm"
            >
              <option value="">{lang === 'ar' ? 'كل المؤلفين' : 'All authors'}</option>
              {authors.map((author) => <option key={author} value={author}>{author}</option>)}
            </Select>
            <Select
              aria-label={lang === 'ar' ? 'تصفية حسب اللغة' : 'Filter by language'}
              value={languageFilter}
              onChange={(e) => setLanguageFilter(e.target.value)}
              className="h-9 w-full text-sm"
            >
              <option value="all">{lang === 'ar' ? 'كل اللغات' : 'All languages'}</option>
              {LANGUAGES.map((language) => (
                <option key={language.code} value={language.code}>{lang === 'ar' ? language.labelAr : language.label}</option>
              ))}
            </Select>
            <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--camscan-text-muted)]">
              <span>{lang === 'ar' ? 'من تاريخ الإضافة' : 'Added from'}</span>
              <input
                type="date"
                value={createdAfter}
                max={createdBefore || undefined}
                onChange={(e) => setCreatedAfter(e.target.value)}
                className="h-9 min-w-0 rounded-lg border border-[var(--camscan-border)] bg-[var(--camscan-surface)] px-2 text-sm text-[var(--camscan-text)]"
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--camscan-text-muted)]">
              <span>{lang === 'ar' ? 'إلى تاريخ الإضافة' : 'Added to'}</span>
              <input
                type="date"
                value={createdBefore}
                min={createdAfter || undefined}
                onChange={(e) => setCreatedBefore(e.target.value)}
                className="h-9 min-w-0 rounded-lg border border-[var(--camscan-border)] bg-[var(--camscan-surface)] px-2 text-sm text-[var(--camscan-text)]"
              />
            </label>
            <Button variant="ghost" onClick={() => {
              setAuthorFilter('');
              setLanguageFilter('all');
              setCreatedAfter('');
              setCreatedBefore('');
              setStatusFilter('all');
            }}>
              {lang === 'ar' ? 'مسح التصفية' : 'Clear filters'}
            </Button>
          </div>

          {!ready ? (
            <div className="grid place-items-center py-20"><Spinner size={28} /></div>
          ) : visibleBooks.length === 0 ? (
            <EmptyState
              icon={<LogoLarge />}
              title={t(lang, 'noBooks')}
              description={t(lang, 'noBooksHelp')}
              action={<Button variant="accent" size="lg" onClick={() => setAddOpen(true)}>{t(lang, 'addBook')}</Button>}
            />
          ) : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {visibleBooks.map((book) => (
                <li key={book.id}>
                  <BookCard
                    book={book}
                    lang={lang}
                    exportProgress={exportProgress?.bookId === book.id ? exportProgress.value : null}
                    busy={busy === book.id}
                    onExport={() => void handleExport(book)}
                    onEdit={() => setEditing(book)}
                    onDelete={() => setDeleting(book)}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>

      {/* ---------- dialogs ---------- */}
      <AddBookDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={(book) => {
          setAddOpen(false);
          router.push(`/book/${book.id}/scan`);
        }}
      />

      <EditBookDialog
        book={editing}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); push(t(lang, 'saved'), 'success'); }}
      />

      <Modal
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title={t(lang, 'deleteBook')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>{t(lang, 'cancel')}</Button>
            <Button variant="danger" loading={busy === deleting?.id} onClick={() => deleting && void handleDelete(deleting)}>
              {t(lang, 'delete')}
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-[var(--camscan-text-muted)]">{t(lang, 'deleteBookConfirm')}</p>
        {deleting ? (
          <p className="mt-3 rounded-lg bg-[var(--camscan-surface-2)] p-3 text-sm font-medium">{deleting.title}</p>
        ) : null}
      </Modal>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Book card                                                           */
/* ------------------------------------------------------------------ */

function BookCard({
  book, lang, busy, exportProgress, onExport, onEdit, onDelete,
}: {
  book: Book;
  lang: 'ar' | 'en';
  busy: boolean;
  exportProgress: number | null;
  onExport: (appendOriginalPhotos?: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const total = book.pageCount;
  const processed = book.doneCount + book.reviewCount;
  const progress = total ? processed / total : 0;

  return (
    <Card className="group relative flex h-full flex-col overflow-hidden">
      <Link href={`/book/${book.id}`} className="block">
        <div className="relative aspect-[3/4] w-full overflow-hidden bg-[var(--camscan-surface-2)]">
          {book.coverThumb ? (
            <img
              src={typeof book.coverThumb === 'string' ? book.coverThumb : undefined}
              alt=""
              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-[var(--camscan-text-muted)]">
              <svg width="42" height="42" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10l2 2h6.5A1.5 1.5 0 0 1 20 7.5v11A1.5 1.5 0 0 1 18.5 20h-13A1.5 1.5 0 0 1 4 18.5v-13Z" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </div>
          )}
          <div className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/55 to-transparent p-2">
            {book.reviewCount > 0 ? (
              <Badge tone="warn">⚠ {book.reviewCount}</Badge>
            ) : null}
            {book.failedCount > 0 ? <Badge tone="danger">✕ {book.failedCount}</Badge> : null}
            {total === 0 ? <Badge tone="info">{t(lang, 'noPages')}</Badge> : null}
          </div>
        </div>
      </Link>

      <div className="flex flex-1 flex-col p-3">
        <Link href={`/book/${book.id}`} className="line-clamp-2 text-sm font-semibold leading-snug hover:underline">
          {book.title}
        </Link>
        {book.author ? (
          <p className="mt-0.5 line-clamp-1 text-xs text-[var(--camscan-text-muted)]">{book.author}</p>
        ) : null}
        <p className="mt-1 text-xs text-[var(--camscan-text-muted)]">
          {total} {t(lang, 'pages')} · {new Date(book.createdAt).toLocaleDateString(lang === 'ar' ? 'ar-EG' : 'en-GB')}
        </p>

        {total > 0 && progress < 1 ? (
          <Progress className="mt-2" value={progress} />
        ) : null}

        <div className="mt-2 flex items-center gap-1">
          <Link href={`/book/${book.id}/scan`} className="flex-1">
            <Button size="sm" variant="secondary" className="w-full">
              {total ? t(lang, 'continueScanning') : t(lang, 'scan')}
            </Button>
          </Link>
          <Button
            size="sm"
            variant="ghost"
            aria-label={t(lang, 'settings')}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            ⋯
          </Button>
        </div>

        {menuOpen ? (
          <div className="absolute inset-x-1 bottom-1 z-10 rounded-xl border border-[var(--camscan-border)] bg-[var(--camscan-surface)] p-1 shadow-xl">
            <MenuItem onClick={onEdit}>{t(lang, 'rename')}</MenuItem>
            <MenuItem onClick={() => { setMenuOpen(false); onExport(); }} disabled={busy || total === 0}>
              {busy ? <Spinner size={14} /> : null} {t(lang, 'exportPdf')}
            </MenuItem>
            <MenuItem onClick={() => { setMenuOpen(false); onExport(true); }} disabled={busy || total === 0}>
              {lang === 'ar' ? 'تصدير PDF مع الصور الأصلية' : 'Export PDF with original photos'}
            </MenuItem>
            <MenuItem onClick={() => { setMenuOpen(false); onDelete(); }} danger>{t(lang, 'delete')}</MenuItem>
            <MenuItem onClick={() => setMenuOpen(false)}>{t(lang, 'close')}</MenuItem>
          </div>
        ) : null}

        {exportProgress !== null ? (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-[var(--camscan-surface)]/95 p-4">
            <Spinner />
            <p className="text-xs">{t(lang, 'exportProgress')}</p>
            <Progress value={exportProgress} className="w-full" />
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function MenuItem({ children, onClick, danger, disabled }: {
  children: React.ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-sm hover:bg-[var(--camscan-surface-2)] disabled:opacity-50 ${
        danger ? 'text-[var(--color-danger-600)]' : ''
      }`}
    >
      {children}
    </button>
  );
}

function Segmented({ value, onChange, options }: {
  value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }>;
}) {
  return (
    <div role="tablist" className="flex flex-wrap gap-1 rounded-lg border border-[var(--camscan-border)] p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          role="tab"
          type="button"
          aria-selected={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={`rounded-md px-2.5 py-1 text-xs ${
            value === opt.value ? 'bg-[var(--camscan-text)] text-[var(--camscan-bg)]' : 'text-[var(--camscan-text-muted)]'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function LogoLarge() {
  return (
    <svg width="56" height="56" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10l2 2h6.5A1.5 1.5 0 0 1 20 7.5v11A1.5 1.5 0 0 1 18.5 20h-13A1.5 1.5 0 0 1 4 18.5v-13Z" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8 11h8M8 14h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Add / edit book dialogs                                             */
/* ------------------------------------------------------------------ */

function AddBookDialog({
  open, onClose, onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (book: Book) => void;
}) {
  const { repo, settings, updateSettings } = useApp();
  const { push } = useToast();
  const lang = settings.uiLanguage;
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [language, setLanguage] = useState<BookLanguage>('ar');
  const [more, setMore] = useState(false);
  const [extra, setExtra] = useState({
    subtitle: '',
    publisher: '',
    publicationYear: '',
    edition: '',
    isbn: '',
    category: '',
    description: '',
    notes: '',
    additionalLanguages: [] as string[],
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setTitle(''); setAuthor(''); setLanguage('ar'); setMore(false); setError(null);
    setExtra({
      subtitle: '',
      publisher: '',
      publicationYear: '',
      edition: '',
      isbn: '',
      category: '',
      description: '',
      notes: '',
      additionalLanguages: [],
    });
  };

  const submit = async () => {
    if (!title.trim()) { setError(lang === 'ar' ? 'العنوان مطلوب' : 'Title is required'); return; }
    setSaving(true);
    try {
      const book = await repo.createBook({
        title,
        author,
        language,
        ...extra,
        settings: {
          ocrLanguages: settings.ocrLanguages,
          captureProfile: settings.captureProfile,
          autoCapture: settings.autoCapture,
          reviewThreshold: settings.reviewThreshold,
          readingWidth: 720,
        },
      });
      await updateSettings({ lastBookId: book.id });
      push(lang === 'ar' ? 'تم إنشاء الكتاب' : 'Book created', 'success');
      reset();
      onCreated(book);
    } catch (err) {
      setError((err as Error).message);
      push(`${t(lang, 'persistenceFailed')}`, 'error', 7000);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => { onClose(); reset(); }}
      title={t(lang, 'newBook')}
      footer={
        <>
          <Button variant="ghost" onClick={() => { onClose(); reset(); }}>{t(lang, 'cancel')}</Button>
          <Button variant="accent" loading={saving} onClick={() => void submit()}>
            {t(lang, 'create')} →
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field
          label={`${t(lang, 'title')} *`}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={lang === 'ar' ? 'مثال: المقدمة — ابن خلدون' : 'e.g. The Muqaddimah'}
          autoFocus
          error={error ?? undefined}
          required
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t(lang, 'author')} value={author} onChange={(e) => setAuthor(e.target.value)} />
          <Select label={t(lang, 'primaryLanguage')} value={language} onChange={(e) => setLanguage(e.target.value as BookLanguage)}>
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>{lang === 'ar' ? l.labelAr : l.label}</option>
            ))}
          </Select>
        </div>

        <button type="button" onClick={() => setMore((v) => !v)} className="text-sm text-[var(--camscan-accent)] underline">
          {more ? '− ' : '+ '}{lang === 'ar' ? 'بيانات إضافية (اختياري)' : 'More details (optional)'}
        </button>

        {more ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t(lang, 'subtitle')} value={extra.subtitle} onChange={(e) => setExtra({ ...extra, subtitle: e.target.value })} />
            <Field label={t(lang, 'publisher')} value={extra.publisher} onChange={(e) => setExtra({ ...extra, publisher: e.target.value })} />
            <Field label={t(lang, 'publicationYear')} value={extra.publicationYear} onChange={(e) => setExtra({ ...extra, publicationYear: e.target.value })} inputMode="numeric" />
            <Field label={t(lang, 'edition')} value={extra.edition} onChange={(e) => setExtra({ ...extra, edition: e.target.value })} />
            <Field label={t(lang, 'isbn')} value={extra.isbn} onChange={(e) => setExtra({ ...extra, isbn: e.target.value })} inputMode="numeric" />
            <Field label={t(lang, 'category')} value={extra.category} onChange={(e) => setExtra({ ...extra, category: e.target.value })} />
            <div className="sm:col-span-2">
              <label className="mb-1.5 block text-sm font-medium">{t(lang, 'additionalLanguages')}</label>
              <select
                multiple
                size={Math.min(4, LANGUAGES.length)}
                value={extra.additionalLanguages}
                onChange={(e) => setExtra({ ...extra, additionalLanguages: Array.from(e.currentTarget.selectedOptions, (option) => option.value) })}
                className="w-full rounded-xl border border-[var(--camscan-border)] bg-[var(--camscan-surface)] px-3 py-2 text-sm"
              >
                {LANGUAGES.filter((item) => item.code !== language).map((item) => (
                  <option key={item.code} value={item.code}>{lang === 'ar' ? item.labelAr : item.label}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-[var(--camscan-text-muted)]">
                {lang === 'ar' ? 'يمكن اختيار أكثر من لغة باستخدام Ctrl أو ⌘.' : 'Select multiple languages with Ctrl or ⌘.'}
              </p>
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1.5 block text-sm font-medium">{t(lang, 'description')}</label>
              <textarea
                value={extra.description}
                onChange={(e) => setExtra({ ...extra, description: e.target.value })}
                rows={2}
                className="w-full rounded-xl border border-[var(--camscan-border)] bg-[var(--camscan-surface)] px-3 py-2 text-sm"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1.5 block text-sm font-medium">{t(lang, 'notes')}</label>
              <textarea
                value={extra.notes}
                onChange={(e) => setExtra({ ...extra, notes: e.target.value })}
                rows={2}
                className="w-full rounded-xl border border-[var(--camscan-border)] bg-[var(--camscan-surface)] px-3 py-2 text-sm"
              />
            </div>
          </div>
        ) : null}

        <p className="rounded-lg bg-[var(--camscan-surface-2)] p-3 text-xs text-[var(--camscan-text-muted)]">
          {t(lang, 'ocrLanguageHint')}
        </p>
      </div>
    </Modal>
  );
}

function EditBookDialog({ book, onClose, onSaved }: { book: Book | null; onClose: () => void; onSaved: () => void }) {
  const { repo, settings } = useApp();
  const { push } = useToast();
  const lang = settings.uiLanguage;
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [details, setDetails] = useState({
    subtitle: '',
    publisher: '',
    publicationYear: '',
    edition: '',
    isbn: '',
    language: 'ar' as BookLanguage,
    category: '',
    description: '',
    notes: '',
    additionalLanguages: [] as string[],
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setTitle(book?.title ?? '');
    setAuthor(book?.author ?? '');
    setDetails({
      subtitle: book?.subtitle ?? '',
      publisher: book?.publisher ?? '',
      publicationYear: book?.publicationYear ?? '',
      edition: book?.edition ?? '',
      isbn: book?.isbn ?? '',
      language: book?.language ?? 'ar',
      category: book?.category ?? '',
      description: book?.description ?? '',
      notes: book?.notes ?? '',
      additionalLanguages: book?.additionalLanguages ?? [],
    });
  }, [book]);

  if (!book) return null;

  const updateDetail = <K extends keyof typeof details,>(key: K, value: (typeof details)[K]) => {
    setDetails((current) => ({ ...current, [key]: value }));
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={lang === 'ar' ? 'تعديل بيانات الكتاب' : 'Edit book details'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t(lang, 'cancel')}</Button>
          <Button
            variant="accent"
            loading={saving}
            onClick={async () => {
              setSaving(true);
              try {
                await repo.updateBook(book.id, {
                  title: title.trim() || book.title,
                  author: author.trim(),
                  ...details,
                });
                push(lang === 'ar' ? 'تم حفظ بيانات الكتاب' : 'Book details saved', 'success');
                onSaved();
              } catch (error) {
                push((error as Error).message || (lang === 'ar' ? 'تعذر حفظ بيانات الكتاب' : 'Could not save book details'), 'error');
              } finally {
                setSaving(false);
              }
            }}
          >
            {t(lang, 'save')}
          </Button>
        </>
      }
    >
      <div className="max-h-[70vh] space-y-3 overflow-y-auto pe-1">
        <Field label={t(lang, 'title')} value={title} onChange={(e) => setTitle(e.target.value)} required />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t(lang, 'author')} value={author} onChange={(e) => setAuthor(e.target.value)} />
          <Select label={t(lang, 'primaryLanguage')} value={details.language} onChange={(e) => updateDetail('language', e.target.value as BookLanguage)}>
            {LANGUAGES.map((item) => (
              <option key={item.code} value={item.code}>{lang === 'ar' ? item.labelAr : item.label}</option>
            ))}
          </Select>
          <Field label={t(lang, 'subtitle')} value={details.subtitle} onChange={(e) => updateDetail('subtitle', e.target.value)} />
          <Field label={t(lang, 'publisher')} value={details.publisher} onChange={(e) => updateDetail('publisher', e.target.value)} />
          <Field label={t(lang, 'publicationYear')} value={details.publicationYear} onChange={(e) => updateDetail('publicationYear', e.target.value)} />
          <Field label={t(lang, 'edition')} value={details.edition} onChange={(e) => updateDetail('edition', e.target.value)} />
          <Field label={t(lang, 'isbn')} value={details.isbn} onChange={(e) => updateDetail('isbn', e.target.value)} />
          <Field label={t(lang, 'category')} value={details.category} onChange={(e) => updateDetail('category', e.target.value)} />
          <div className="sm:col-span-2">
            <label className="mb-1.5 block text-sm font-medium">{t(lang, 'additionalLanguages')}</label>
            <select
              multiple
              size={Math.min(4, LANGUAGES.length)}
              value={details.additionalLanguages}
              onChange={(e) => updateDetail('additionalLanguages', Array.from(e.currentTarget.selectedOptions, (option) => option.value))}
              className="w-full rounded-xl border border-[var(--camscan-border)] bg-[var(--camscan-surface)] px-3 py-2 text-sm"
            >
              {LANGUAGES.filter((item) => item.code !== details.language).map((item) => (
                <option key={item.code} value={item.code}>{lang === 'ar' ? item.labelAr : item.label}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-[var(--camscan-text-muted)]">
              {lang === 'ar' ? 'يمكن اختيار أكثر من لغة باستخدام Ctrl أو ⌘.' : 'Select multiple languages with Ctrl or ⌘.'}
            </p>
          </div>
          <div className="sm:col-span-2">
            <label className="mb-1.5 block text-sm font-medium">{t(lang, 'description')}</label>
            <textarea value={details.description} onChange={(e) => updateDetail('description', e.target.value)} rows={2} className="w-full rounded-xl border border-[var(--camscan-border)] bg-[var(--camscan-surface)] px-3 py-2 text-sm" />
          </div>
          <div className="sm:col-span-2">
            <label className="mb-1.5 block text-sm font-medium">{t(lang, 'notes')}</label>
            <textarea value={details.notes} onChange={(e) => updateDetail('notes', e.target.value)} rows={2} className="w-full rounded-xl border border-[var(--camscan-border)] bg-[var(--camscan-surface)] px-3 py-2 text-sm" />
          </div>
        </div>
      </div>
    </Modal>
  );
}
