/**
 * CamScan — repository boundary.
 *
 * Everything the UI needs from storage is declared here as an interface.
 * `createLocalRepository()` implements it on top of IndexedDB/Dexie.
 * A cloud implementation (Supabase/Postgres + object storage) only has to
 * satisfy this interface — no component imports Dexie.
 */
import { getDb, type PageRow } from './db';
import type {
  AppSettings,
  Book,
  BookDefaults,
  BookSettings,
  ExportRecord,
  JobRecord,
  PageModel,
  PageRecord,
  PageStatus,
  RevisionRecord,
  ThemePreference,
  UiLanguage,
} from './types';
import { modelPlainText } from './pageModel';
import { normalizeArabic } from './normalize';

export const DEFAULT_BOOK_FONTS: BookDefaults = {
  arabicFont: "'Amiri', serif",
  latinFont: "'EB Garamond', serif",
  bodyFontSize: 0.022,
  layout: 'absolute',
};

export const DEFAULT_BOOK_SETTINGS: BookSettings = {
  ocrLanguages: ['ara', 'eng'],
  captureProfile: 'standard',
  autoCapture: true,
  reviewThreshold: 70,
  readingWidth: 720,
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
  id: 'app',
  uiLanguage: 'ar',
  theme: 'system',
  ocrLanguages: ['ara', 'eng'],
  captureProfile: 'standard',
  autoCapture: true,
  reviewThreshold: 70,
  hasSeenTips: false,
  updatedAt: 0,
};

/* ------------------------------------------------------------------ */
/* Interfaces                                                          */
/* ------------------------------------------------------------------ */

export interface BookStats {
  pageCount: number;
  doneCount: number;
  reviewCount: number;
  failedCount: number;
  queuedCount: number;
}

export interface Repository {
  /* Books */
  listBooks(): Promise<Book[]>;
  getBook(id: string): Promise<Book | undefined>;
  createBook(input: Partial<Book> & { title: string }): Promise<Book>;
  updateBook(id: string, patch: Partial<Book>): Promise<void>;
  deleteBook(id: string): Promise<void>;
  recomputeBookStats(bookId: string): Promise<BookStats>;

  /* Pages */
  listPages(bookId: string): Promise<PageRecord[]>;
  listPageRows(bookId: string): Promise<PageRow[]>;
  getPage(pageId: string): Promise<PageRecord | undefined>;
  getPageRow(pageId: string): Promise<PageRow | undefined>;
  /** Persist a new capture; returns the stored page (with blob id). */
  addPage(input: {
    bookId: string;
    order: number;
    originalImage: Blob;
    thumb?: string;
    /** Skip synchronous thumbnail work when capture must be persisted immediately. */
    skipThumbnail?: boolean;
    width: number;
    height: number;
    language?: string;
    direction?: 'rtl' | 'ltr';
  }): Promise<PageRecord>;
  updatePage(pageId: string, patch: Partial<Omit<PageRecord, 'id' | 'bookId'>>): Promise<void>;
  updatePageStatus(pageId: string, status: PageStatus, extra?: Partial<PageRecord>): Promise<void>;
  savePageModel(args: {
    pageId: string;
    model: PageModel;
    processedImage?: Blob;
    avgConfidence: number;
    status: PageStatus;
    metricsPatch?: Partial<NonNullable<PageRecord['metrics']>>;
    keepEdit?: boolean;
  }): Promise<void>;
  deletePage(pageId: string): Promise<void>;
  /** Transaction-safe renumbering to the given id order. */
  reorderPages(bookId: string, orderedIds: string[]): Promise<void>;
  getOriginalImage(pageId: string): Promise<Blob | undefined>;
  getProcessedImage(pageId: string): Promise<Blob | undefined>;

  /* Revisions */
  addRevision(rev: Omit<RevisionRecord, 'id' | 'createdAt'>): Promise<void>;
  listRevisions(pageId: string): Promise<RevisionRecord[]>;

  /* Jobs */
  enqueueJob(job: Omit<JobRecord, 'id' | 'createdAt' | 'updatedAt' | 'attempts' | 'state' | 'progress'> & {
    state?: JobRecord['state'];
    attempts?: number;
    progress?: number;
  }): Promise<JobRecord>;
  updateJob(id: string, patch: Partial<JobRecord>): Promise<void>;
  listJobs(filter?: { state?: JobRecord['state']; bookId?: string }): Promise<JobRecord[]>;
  getJob(id: string): Promise<JobRecord | undefined>;
  /** Idempotency: find an open job for a page of a given type. */
  findOpenJob(pageId: string, type: JobRecord['type'], optionsKey?: string): Promise<JobRecord | undefined>;

  /* Settings */
  getSettings(): Promise<AppSettings>;
  saveSettings(patch: Partial<AppSettings>): Promise<AppSettings>;

  /* Exports */
  addExport(rec: Omit<ExportRecord, 'id' | 'createdAt'>): Promise<ExportRecord>;
  updateExport(id: string, patch: Partial<ExportRecord>): Promise<void>;
  listExports(bookId?: string): Promise<ExportRecord[]>;

  /* Maintenance */
  storageEstimate(): Promise<{ usage: number; quota: number } | null>;
}

/* ------------------------------------------------------------------ */
/* Local (IndexedDB) implementation                                    */
/* ------------------------------------------------------------------ */

const uid = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export function createLocalRepository(): Repository {
  const db = () => getDb();

  /** Internal: read blobs for a row set in one transaction. */
  async function hydrate(row: PageRow): Promise<PageRecord> {
    const d = db();
    const orig = await d.blobs.get(row.originalBlobId);
    const proc = row.processedBlobId ? await d.blobs.get(row.processedBlobId) : undefined;
    const { originalBlobId: _a, processedBlobId: _b, ...rest } = row;
    return {
      ...rest,
      originalImage: orig?.blob ?? new Blob(),
      processedImage: proc?.blob,
    } as PageRecord;
  }

  return {
    /* ---------------- books ---------------- */

    async listBooks() {
      return db().books.orderBy('updatedAt').reverse().toArray();
    },

    async getBook(id) {
      return db().books.get(id);
    },

    async createBook(input) {
      const now = Date.now();
      const book: Book = {
        id: input.id ?? uid('bk'),
        title: input.title.trim() || 'Untitled',
        author: input.author?.trim() || undefined,
        subtitle: input.subtitle?.trim() || undefined,
        publisher: input.publisher?.trim() || undefined,
        publicationYear: input.publicationYear?.trim() || undefined,
        edition: input.edition?.trim() || undefined,
        isbn: input.isbn?.trim() || undefined,
        language: input.language ?? 'ar',
        additionalLanguages: input.additionalLanguages ?? [],
        category: input.category?.trim() || undefined,
        description: input.description?.trim() || undefined,
        notes: input.notes?.trim() || undefined,
        createdAt: now,
        updatedAt: now,
        coverPageId: undefined,
        defaultFonts: { ...DEFAULT_BOOK_FONTS, ...input.defaultFonts },
        settings: { ...DEFAULT_BOOK_SETTINGS, ...input.settings },
        pageCount: 0,
        doneCount: 0,
        reviewCount: 0,
        failedCount: 0,
      };
      await db().books.add(book);
      return book;
    },

    async updateBook(id, patch) {
      await db().books.update(id, { ...patch, updatedAt: Date.now() });
    },

    async deleteBook(id) {
      const d = db();
      await d.transaction('rw', [d.books, d.pages, d.blobs, d.jobs, d.revisions, d.exports], async () => {
        const rows = await d.pages.where('bookId').equals(id).toArray();
        const blobIds = rows.flatMap((r) => [r.originalBlobId, r.processedBlobId].filter(Boolean) as string[]);
        await d.blobs.bulkDelete(blobIds);
        await d.pages.where('bookId').equals(id).delete();
        await d.jobs.where('bookId').equals(id).delete();
        await d.revisions.where('bookId').equals(id).delete();
        await d.exports.where('bookId').equals(id).delete();
        await d.books.delete(id);
      });
    },

    async recomputeBookStats(bookId) {
      const rows = await db().pages.where('bookId').equals(bookId).toArray();
      const stats: BookStats = {
        pageCount: rows.length,
        doneCount: rows.filter((r) => r.status === 'done' && !r.reviewed).length,
        reviewCount: rows.filter((r) => r.status === 'review' || (r.status === 'done' && !r.reviewed)).length,
        failedCount: rows.filter((r) => r.status === 'failed').length,
        queuedCount: rows.filter((r) => r.status === 'queued' || r.status === 'processing').length,
      };
      // reviewCount should not double count.
      stats.reviewCount = rows.filter((r) => r.status === 'review').length;
      await db().books.update(bookId, {
        pageCount: stats.pageCount,
        doneCount: rows.filter((r) => (r.status === 'done' || r.status === 'blank') && (r.reviewed || r.status === 'blank')).length,
        reviewCount: stats.reviewCount,
        failedCount: stats.failedCount,
        updatedAt: Date.now(),
      });
      return stats;
    },

    /* ---------------- pages ---------------- */

    async listPageRows(bookId) {
      return db().pages.where('[bookId+order]').between([bookId, DexieMinKey], [bookId, DexieMaxKey]).toArray()
        .then((rows) => rows.sort((a, b) => a.order - b.order));
    },

    async listPages(bookId) {
      const rows = await this.listPageRows(bookId);
      return Promise.all(rows.map(hydrate));
    },

    async getPageRow(pageId) {
      return db().pages.get(pageId);
    },

    async getPage(pageId) {
      const row = await db().pages.get(pageId);
      return row ? hydrate(row) : undefined;
    },

    async addPage(input) {
      const d = db();
      const now = Date.now();
      const id = uid('pg');
      const originalBlobId = uid('bl');
      const thumb = input.thumb ?? (input.skipThumbnail ? undefined : await makeThumb(input.originalImage));
      const row: PageRow = {
        id,
        bookId: input.bookId,
        order: input.order,
        status: 'queued',
        stage: 'queued',
        progress: 0,
        originalBlobId,
        thumb,
        plainText: '',
        searchText: '',
        avgConfidence: 0,
        language: input.language ?? 'ar',
        direction: input.direction ?? 'rtl',
        width: input.width,
        height: input.height,
        reviewed: false,
        blank: false,
        userEdited: false,
        createdAt: now,
        updatedAt: now,
        revision: 1,
      };
      await d.transaction('rw', [d.pages, d.blobs, d.books], async () => {
        await d.blobs.add({ id: originalBlobId, blob: input.originalImage, kind: 'original', size: input.originalImage.size, createdAt: now });
        await d.pages.add(row);
        const book = await d.books.get(input.bookId);
        if (book) {
          const patch: Partial<Book> = { updatedAt: now };
          // First capture becomes the cover automatically. Use the existing
          // thumb when available; camera captures attach it asynchronously.
          if (!book.coverPageId) {
            patch.coverPageId = id;
            if (thumb) patch.coverThumb = thumb;
          }
          await d.books.update(input.bookId, patch);
        }
      });
      return hydrate(row);
    },

    async updatePage(pageId, patch) {
      const { originalImage, processedImage, ...rest } = patch as Partial<PageRecord>;
      void originalImage;
      const d = db();
      await d.transaction('rw', [d.pages, d.blobs, d.books], async () => {
        const row = await d.pages.get(pageId);
        if (!row) return;
        const update: Partial<PageRow> = { ...(rest as Partial<PageRow>), updatedAt: Date.now() };
        if (processedImage) {
          const bid = row.processedBlobId ?? uid('bl');
          await d.blobs.put({ id: bid, blob: processedImage, kind: 'processed', size: processedImage.size, createdAt: Date.now() });
          update.processedBlobId = bid;
        }
        if (patch.pageModel) {
          update.plainText = patch.plainText ?? modelPlainText(patch.pageModel);
          update.searchText = normalizeSearchText(update.plainText);
        }
        await d.pages.update(pageId, update);
        // Keep the book-card cover in sync when its first page's thumbnail is
        // generated asynchronously after an immediate camera capture.
        if (typeof patch.thumb === 'string') {
          const book = await d.books.get(row.bookId);
          if (book?.coverPageId === pageId) {
            await d.books.update(book.id, { coverThumb: patch.thumb });
          }
        }
      });
    },

    async updatePageStatus(pageId, status, extra) {
      const patch: Partial<PageRow> = { status, updatedAt: Date.now(), ...(extra as Partial<PageRow>) };
      await db().pages.update(pageId, patch);
    },

    async savePageModel({ pageId, model, processedImage, avgConfidence, status, metricsPatch, keepEdit }) {
      const d = db();
      await d.transaction('rw', [d.pages, d.blobs], async () => {
        const row = await d.pages.get(pageId);
        if (!row) return;
        const update: Partial<PageRow> = {
          pageModel: model,
          plainText: modelPlainText(model),
          avgConfidence,
          status,
          stage: status === 'failed' ? 'failed' : 'done',
          progress: 1,
          updatedAt: Date.now(),
          revision: (row.revision ?? 1) + 1,
          metrics: { ...(row.metrics ?? {}), ...(metricsPatch ?? {}) },
        };
        update.searchText = normalizeSearchText(update.plainText ?? '');
        if (keepEdit !== true) {
          // Only clear the edit flag if explicitly allowed by the caller.
          update.userEdited = row.userEdited;
        }
        if (processedImage) {
          const bid = row.processedBlobId ?? uid('bl');
          await d.blobs.put({ id: bid, blob: processedImage, kind: 'processed', size: processedImage.size, createdAt: Date.now() });
          update.processedBlobId = bid;
        }
        await d.pages.update(pageId, update);
      });
    },

    async deletePage(pageId) {
      const d = db();
      await d.transaction('rw', [d.pages, d.blobs, d.jobs, d.revisions, d.books], async () => {
        const row = await d.pages.get(pageId);
        if (!row) return;
        await d.blobs.bulkDelete([row.originalBlobId, row.processedBlobId].filter(Boolean) as string[]);
        await d.pages.delete(pageId);
        await d.jobs.where('pageId').equals(pageId).delete();
        await d.revisions.where('pageId').equals(pageId).delete();
        const book = await d.books.get(row.bookId);
        if (book?.coverPageId === pageId) {
          const next = await d.pages.where('bookId').equals(row.bookId).sortBy('order');
          await d.books.update(book.id, { coverPageId: next[0]?.id, coverThumb: next[0]?.thumb });
        }
      });
    },

    async reorderPages(bookId, orderedIds) {
      const d = db();
      await d.transaction('rw', d.pages, async () => {
        const rows = await d.pages.where('bookId').equals(bookId).toArray();
        const byId = new Map(rows.map((r) => [r.id, r]));
        // Two-phase write avoids unique-index collisions if one is ever added:
        // first move everything to a temporary offset, then write final order.
        const OFFSET = 100000;
        for (const [i, id] of orderedIds.entries()) {
          const row = byId.get(id);
          if (!row) continue;
          await d.pages.update(id, { order: OFFSET + i * 2, updatedAt: Date.now() });
        }
        for (const [i, id] of orderedIds.entries()) {
          if (byId.has(id)) await d.pages.update(id, { order: i, updatedAt: Date.now() });
        }
        await d.books.update(bookId, { updatedAt: Date.now() });
      });
    },

    async getOriginalImage(pageId) {
      const row = await db().pages.get(pageId);
      if (!row) return undefined;
      return (await db().blobs.get(row.originalBlobId))?.blob;
    },

    async getProcessedImage(pageId) {
      const row = await db().pages.get(pageId);
      if (!row?.processedBlobId) return undefined;
      return (await db().blobs.get(row.processedBlobId))?.blob;
    },

    /* ---------------- revisions ---------------- */

    async addRevision(rev) {
      await db().revisions.add({
        ...rev,
        id: uid('rv'),
        createdAt: Date.now(),
      } as RevisionRecord);
      // Cap history per page to keep storage bounded.
      const all = await db().revisions.where('pageId').equals(rev.pageId).sortBy('createdAt');
      if (all.length > 20) {
        await db().revisions.bulkDelete(all.slice(0, all.length - 20).map((r) => r.id));
      }
    },

    async listRevisions(pageId) {
      return db().revisions.where('pageId').equals(pageId).reverse().sortBy('createdAt');
    },

    /* ---------------- jobs ---------------- */

    async enqueueJob(job) {
      const key = job.options ? JSON.stringify(job.options) : '';
      const existing = await this.findOpenJob(job.pageId, job.type, key);
      if (existing) return existing;
      const now = Date.now();
      const rec: JobRecord = {
        id: uid('job'),
        bookId: job.bookId,
        pageId: job.pageId,
        type: job.type,
        state: job.state ?? 'pending',
        attempts: job.attempts ?? 0,
        maxAttempts: job.maxAttempts,
        progress: job.progress ?? 0,
        options: job.options,
        createdAt: now,
        updatedAt: now,
      };
      await db().jobs.add(rec);
      return rec;
    },

    async updateJob(id, patch) {
      await db().jobs.update(id, { ...patch, updatedAt: Date.now() });
    },

    async listJobs(filter) {
      const coll = db().jobs.toCollection();
      const rows = await coll.toArray();
      return rows
        .filter((r) => (filter?.state ? r.state === filter.state : true))
        .filter((r) => (filter?.bookId ? r.bookId === filter.bookId : true))
        .sort((a, b) => a.createdAt - b.createdAt);
    },

    async getJob(id) {
      return db().jobs.get(id);
    },

    async findOpenJob(pageId, type, optionsKey) {
      const rows = await db().jobs.where('pageId').equals(pageId).toArray();
      return rows.find((r) => r.type === type
        && (r.state === 'pending' || r.state === 'running')
        && (!optionsKey || JSON.stringify(r.options ?? {}) === optionsKey));
    },

    /* ---------------- settings ---------------- */

    async getSettings() {
      const s = await db().settings.get('app');
      if (s) return s;
      const init: AppSettings = { ...DEFAULT_APP_SETTINGS, updatedAt: Date.now() };
      await db().settings.put(init);
      return init;
    },

    async saveSettings(patch) {
      const current = await this.getSettings();
      const next: AppSettings = { ...current, ...patch, id: 'app', updatedAt: Date.now() };
      await db().settings.put(next);
      return next;
    },

    /* ---------------- exports ---------------- */

    async addExport(rec) {
      const full: ExportRecord = { ...rec, id: uid('ex'), createdAt: Date.now() };
      await db().exports.add(full);
      return full;
    },

    async updateExport(id, patch) {
      await db().exports.update(id, patch);
    },

    async listExports(bookId) {
      const rows = await db().exports.toArray();
      return rows
        .filter((r) => (bookId ? r.bookId === bookId : true))
        .sort((a, b) => b.createdAt - a.createdAt);
    },

    /* ---------------- maintenance ---------------- */

    async storageEstimate() {
      if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
      try {
        const est = await navigator.storage.estimate();
        return { usage: est.usage ?? 0, quota: est.quota ?? 0 };
      } catch {
        return null;
      }
    },
  };
}

/** Normalised text stored alongside the display text for search. */
export function normalizeSearchText(text: string): string {
  return normalizeArabic(text);
}

/* Dexie range helpers (kept local so UI never imports Dexie). */
const DexieMinKey = -Infinity as unknown as number;
const DexieMaxKey = Infinity as unknown as number;

/* ------------------------------------------------------------------ */
/* Thumbnail helper (DOM-only; guarded for tests)                      */
/* ------------------------------------------------------------------ */

/**
 * Render a small JPEG data URL thumbnail for the capture strip.
 * Runs on the main thread but is bounded (max 160 px) and cheap.
 */
export async function makeThumb(blob: Blob, maxSize = 160): Promise<string | undefined> {
  if (typeof document === 'undefined' || typeof createImageBitmap === 'undefined') return undefined;
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL('image/jpeg', 0.72);
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Settings helpers for UI language / theme                            */
/* ------------------------------------------------------------------ */

export type { UiLanguage, ThemePreference };
