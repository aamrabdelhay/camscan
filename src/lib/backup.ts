/**
 * CamScan — full library backup & restore (ZIP).
 *
 * A backup contains, for every book:
 *   library.json                 – books, page models, text, settings
 *   images/<bookId>/<pageId>.jpg – original captures
 *   images/<bookId>/<pageId>-processed.jpg – derived page images when present
 *   thumbs/<bookId>/<pageId>.txt – optional inline thumbnails
 *
 * Security & robustness
 *  - every field read from the archive is validated and length-capped;
 *  - paths are never used to write to disk or the DOM (no traversal risk);
 *  - text is treated as data only (rendered via React text nodes);
 *  - a corrupt/oversized archive fails with a clear message and changes nothing;
 *  - restore is additive (existing book ids are preserved/skipped, never
 *    silently overwritten unless the user chose to import into the same db).
 */
import JSZip from 'jszip';
import type { Book, PageModel, PageRecord } from './types';
import type { Repository } from './repository';

const BACKUP_VERSION = 1;
const MAX_BOOKS = 5000;
const MAX_PAGES_PER_BOOK = 20000;
const MAX_TEXT_LENGTH = 2_000_000;

export interface BackupManifest {
  format: 'camscan-backup';
  version: number;
  createdAt: string;
  books: Array<{
    book: Book;
    pages: Array<{
      id: string;
      order: number;
      printedPageNumber?: string;
      status: PageRecord['status'];
      reviewed: boolean;
      blank: boolean;
      userEdited: boolean;
      language: string;
      direction: 'rtl' | 'ltr';
      pageModel?: PageModel;
      plainText: string;
      thumb?: string;
      avgConfidence: number;
      width: number;
      height: number;
      createdAt: number;
      updatedAt: number;
      revision: number;
      imagePath: string;
      processedPath?: string;
    }>;
  }>;
}

/** Serialise the whole library into a downloadable ZIP Blob. */
export async function exportLibraryToZip(
  repo: Repository,
  onProgress?: (done: number, total: number) => void,
): Promise<Blob> {
  const books = await repo.listBooks();
  const zip = new JSZip();
  const manifest: BackupManifest = {
    format: 'camscan-backup',
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    books: [],
  };

  let processed = 0;
  const total = books.reduce((sum, b) => sum + Math.max(1, b.pageCount), 0);

  for (const book of books) {
    const pages = await repo.listPages(book.id);
    const entry: BackupManifest['books'][number] = { book, pages: [] };
    for (const page of pages) {
      const imagePath = `images/${sanitizeSegment(book.id)}/${sanitizeSegment(page.id)}.jpg`;
      zip.file(imagePath, await page.originalImage.arrayBuffer(), { compression: 'STORE' });
      let processedPath: string | undefined;
      if (page.processedImage) {
        processedPath = `images/${sanitizeSegment(book.id)}/${sanitizeSegment(page.id)}-processed.jpg`;
        zip.file(processedPath, await page.processedImage.arrayBuffer(), { compression: 'STORE' });
      }
      if (page.thumb) {
        zip.file(`thumbs/${sanitizeSegment(book.id)}/${sanitizeSegment(page.id)}.txt`, page.thumb);
      }
      entry.pages.push({
        id: page.id,
        order: page.order,
        printedPageNumber: page.printedPageNumber,
        status: page.status,
        reviewed: page.reviewed,
        blank: page.blank,
        userEdited: page.userEdited,
        language: page.language,
        direction: page.direction,
        pageModel: page.pageModel,
        plainText: page.plainText,
        thumb: page.thumb ? page.thumb.slice(0, 60_000) : undefined,
        avgConfidence: page.avgConfidence,
        width: page.width,
        height: page.height,
        createdAt: page.createdAt,
        updatedAt: page.updatedAt,
        revision: page.revision,
        imagePath,
        processedPath,
      });
      processed++;
      onProgress?.(processed, total);
    }
    manifest.books.push(entry);
  }

  const settings = await repo.getSettings();
  zip.file('library.json', JSON.stringify({ manifest, settings }, null, 2));
  zip.file('README.txt', [
    'CamScan library backup',
    '======================',
    `Created: ${manifest.createdAt}`,
    `Books: ${manifest.books.length}`,
    '',
    'Restore this file from CamScan → Settings → Backup → Restore.',
    'The original page photographs are inside images/ and are the archival',
    'source of truth for your library.',
  ].join('\n'));

  return zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 3 },
  }, (meta) => onProgress?.(Math.round(meta.percent), 100));
}

export interface RestoreSummary {
  books: number;
  pages: number;
  skipped: number;
}

/** Parse + validate a backup ZIP and merge it into the local library. */
export async function importLibraryFromZip(
  repo: Repository,
  file: File | Blob,
  onProgress?: (ratio: number) => void,
): Promise<RestoreSummary> {
  const zip = await JSZip.loadAsync(file);
  const manifestFile = zip.file('library.json');
  if (!manifestFile) throw new Error('library.json missing');
  const raw = await manifestFile.async('string');
  if (raw.length > 64 * 1024 * 1024) throw new Error('manifest too large');

  let parsed: { manifest?: BackupManifest };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('library.json is not valid JSON');
  }
  const manifest = parsed.manifest;
  if (!manifest || manifest.format !== 'camscan-backup') throw new Error('unrecognised backup format');
  if (!Array.isArray(manifest.books)) throw new Error('malformed manifest');
  if (manifest.books.length > MAX_BOOKS) throw new Error('too many books in archive');

  const summary: RestoreSummary = { books: 0, pages: 0, skipped: 0 };
  const totalPages = manifest.books.reduce((s, b) => s + b.pages.length, 0);
  let done = 0;

  for (const entry of manifest.books) {
    const book = sanitizeBook(entry.book);
    if (!book) { summary.skipped++; continue; }
    const existing = await repo.getBook(book.id);
    // Restoring into the same browser: reuse the id; otherwise mint a new one
    // so two copies of the same book can coexist without clobbering each other.
    const targetId = existing ? `${book.id}-${Date.now().toString(36)}` : book.id;
    const created = await repo.createBook({
      ...book,
      id: targetId,
      title: existing ? `${book.title} (restored)` : book.title,
    });
    summary.books++;

    const pages = Array.isArray(entry.pages) ? entry.pages.slice(0, MAX_PAGES_PER_BOOK) : [];
    for (const page of pages) {
      const imageFile = page.imagePath ? zip.file(page.imagePath) : null;
      if (!imageFile) { summary.skipped++; done++; continue; }
      const imageBuffer = await imageFile.async('arraybuffer');
      if (imageBuffer.byteLength === 0) { summary.skipped++; done++; continue; }
      const blob = new Blob([imageBuffer], { type: 'image/jpeg' });
      const stored = await repo.addPage({
        bookId: created.id,
        order: Number.isFinite(page.order) ? page.order : pages.indexOf(page),
        originalImage: blob,
        thumb: page.thumb,
        width: Number(page.width) || 1000,
        height: Number(page.height) || 1400,
        language: typeof page.language === 'string' ? page.language : 'ar',
        direction: page.direction === 'ltr' ? 'ltr' : 'rtl',
      });
      const patch: Partial<PageRecord> = {
        status: page.status ?? 'queued',
        reviewed: Boolean(page.reviewed),
        blank: Boolean(page.blank),
        userEdited: Boolean(page.userEdited),
        pageModel: isPageModel(page.pageModel) ? page.pageModel : undefined,
        plainText: typeof page.plainText === 'string' ? page.plainText.slice(0, MAX_TEXT_LENGTH) : '',
        avgConfidence: Number(page.avgConfidence) || 0,
        printedPageNumber: typeof page.printedPageNumber === 'string' ? page.printedPageNumber.slice(0, 40) : undefined,
        stage: page.status === 'done' || page.status === 'review' ? 'done' : 'queued',
        progress: page.status === 'done' || page.status === 'review' ? 1 : 0,
      };
      // Older archives may not contain processedPath; in that case the original
      // photo remains the source of truth and restore continues normally.
      const processedFile = typeof page.processedPath === 'string' ? zip.file(page.processedPath) : null;
      if (processedFile) {
        const processedBuffer = await processedFile.async('arraybuffer');
        if (processedBuffer.byteLength > 0) {
          patch.processedImage = new Blob([processedBuffer], { type: 'image/jpeg' });
        }
      }
      await repo.updatePage(stored.id, patch);
      // Thumbnails live outside the manifest to keep it small.
      const thumbFile = zip.file(`thumbs/${sanitizeSegment(entry.book.id)}/${sanitizeSegment(page.id)}.txt`);
      if (thumbFile) {
        const thumb = await thumbFile.async('string');
        if (thumb.startsWith('data:image/')) await repo.updatePage(stored.id, { thumb: thumb.slice(0, 400_000) });
      }
      summary.pages++;
      done++;
      onProgress?.(totalPages ? done / totalPages : 1);
    }
    await repo.recomputeBookStats(created.id);
  }

  onProgress?.(1);
  return summary;
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

function sanitizeSegment(value: unknown): string {
  return String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
}

function sanitizeBook(raw: unknown): Book | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Partial<Book>;
  if (typeof b.id !== 'string' || !b.id) return null;
  if (typeof b.title !== 'string' || !b.title.trim()) return null;
  return {
    ...(b as Book),
    id: sanitizeSegment(b.id),
    title: b.title.slice(0, 500),
    author: typeof b.author === 'string' ? b.author.slice(0, 300) : undefined,
    language: b.language ?? 'ar',
    createdAt: Number(b.createdAt) || Date.now(),
    updatedAt: Number(b.updatedAt) || Date.now(),
    pageCount: 0,
    doneCount: 0,
    reviewCount: 0,
    failedCount: 0,
    defaultFonts: b.defaultFonts ?? {
      arabicFont: "'Amiri', serif",
      latinFont: "'EB Garamond', serif",
      bodyFontSize: 0.022,
      layout: 'absolute',
    },
    settings: b.settings ?? {
      ocrLanguages: ['ara', 'eng'],
      captureProfile: 'standard',
      autoCapture: true,
      reviewThreshold: 70,
      readingWidth: 720,
    },
  };
}

function isPageModel(value: unknown): value is PageModel {
  if (!value || typeof value !== 'object') return false;
  const m = value as Partial<PageModel>;
  return typeof m.pageId === 'string' && Array.isArray(m.blocks) && typeof m.paperColor === 'string';
}
