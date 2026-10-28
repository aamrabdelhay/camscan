/**
 * CamScan — browser-side PDF generation.
 *
 * Runs on the main thread (pdfkit is not worker-friendly: it relies on
 * streams and, in some builds, Node shims). Work is chunked with `await
 * idle()` between pages so the UI stays responsive and the progress bar moves,
 * even for books with hundreds of pages.
 *
 * Output: a real PDF 1.4 file with **selectable, searchable Unicode text**,
 * embedded font subsets, correct Arabic shaping and RTL order.
 */
import type PDFDocument from 'pdfkit';
import { ensureStdFonts, loadPdfkit } from './pdfkitClient';
import type { Book, PageModel } from '../types';
import { drawPage, drawBidiLine, familyIdFromCss, hasArabic, type DrawContext, type PdfFontSet } from './renderPage';

export interface PdfPageInput {
  model: PageModel;
  /** Cropped illustrations keyed by `block.imageUrl`. */
  images?: Map<string, Uint8Array>;
  /** Optional original JPEG (used only by the explicitly labelled photo mode). */
  originalJpeg?: Uint8Array;
}

export interface ExportPdfOptions {
  book: Book;
  pages: PdfPageInput[];
  mode: 'replica' | 'photos';
  includeTitlePage?: boolean;
  /** When true, append original page photographs after the searchable replica. */
  appendOriginalPhotos?: boolean;
  onProgress?: (done: number, total: number, stage: string) => void;
  signal?: AbortSignal;
}

export interface ExportResult {
  blob: Blob;
  pageCount: number;
  bytes: number;
  durationMs: number;
  /** True when at least one page rendered real (non-image) text. */
  hasTextLayer: boolean;
}

/* ------------------------------------------------------------------ */
/* Font loading (bundled TTFs from /fonts)                             */
/* ------------------------------------------------------------------ */

const FONT_FILES: Record<string, Partial<Record<'400' | '700' | '400i' | '700i', string>>> = {
  Amiri: { 400: 'Amiri-Regular.ttf', 700: 'Amiri-Bold.ttf' },
  ScheherazadeNew: { 400: 'ScheherazadeNew-Regular.ttf', 700: 'ScheherazadeNew-Bold.ttf' },
  NotoNaskhArabic: { 400: 'NotoNaskhArabic-Regular.ttf' },
  NotoKufiArabic: { 400: 'NotoKufiArabic-Regular.ttf' },
  Cairo: { 400: 'Cairo-Regular.ttf', 700: 'Cairo-Bold.ttf' },
  EBGaramond: { 400: 'EBGaramond-Regular.ttf', 700: 'EBGaramond-Bold.ttf', '400i': 'EBGaramond-Italic.ttf' },
  Merriweather: { 400: 'Merriweather-Regular.ttf', 700: 'Merriweather-Bold.ttf' },
  Inter: { 400: 'Inter-Regular.ttf', 700: 'Inter-Bold.ttf' },
  JetBrainsMono: { 400: 'JetBrainsMono-Regular.ttf' },
};

const fontCache = new Map<string, ArrayBuffer>();

async function fetchFont(file: string): Promise<ArrayBuffer> {
  const cached = fontCache.get(file);
  if (cached) return cached;
  const res = await fetch(`/fonts/${file}`);
  if (!res.ok) throw new Error(`Font ${file} not found (run npm run assets)`);
  const buf = await res.arrayBuffer();
  fontCache.set(file, buf);
  return buf;
}

/* ------------------------------------------------------------------ */
/* Main exporter                                                       */
/* ------------------------------------------------------------------ */

export async function exportBookToPdf(options: ExportPdfOptions): Promise<ExportResult> {
  const { book, pages, mode, includeTitlePage = true, appendOriginalPhotos = false, onProgress, signal } = options;
  if (!pages.length) throw new Error('No pages to export');
  const extraPhotoPages = mode === 'replica' && appendOriginalPhotos
    ? pages.filter((page) => Boolean(page.originalJpeg)).length
    : 0;
  const workPageCount = pages.length + extraPhotoPages;
  const started = performance.now();

  // Page size: use the first page's measured aspect ratio, at a fixed width so
  // a whole book has consistent, printable pages (roughly 148 mm wide ≈ 420 pt).
  const firstAspect = pages[0].model.aspectRatio || 0.72;
  const pageWidth = 420;
  const pageHeight = Math.round(pageWidth / Math.max(0.4, Math.min(1.6, firstAspect)));
  const pdfPageHeight = Math.max(300, Math.min(800, pageHeight));

  const { PDF, registerStdFonts } = await loadPdfkit();
  await ensureStdFonts(registerStdFonts);
  const doc = new PDF({
    size: [pageWidth, pdfPageHeight],
    margin: 0,
    autoFirstPage: false,
    compress: true,
    info: {
      Title: book.title,
      Author: book.author ?? 'CamScan',
      Subject: book.subtitle ?? 'Digitised with CamScan',
      Creator: 'CamScan (local-first)',
      Producer: 'CamScan · pdfkit',
      Keywords: book.id,
    } as never,
  });

  const chunks: Uint8Array[] = [];
  const done = new Promise<Blob>((resolve, reject) => {
    doc.on('data', (c) => { if (c) chunks.push(c); });
    doc.on('end', () => resolve(new Blob(chunks as BlobPart[], { type: 'application/pdf' })));
    doc.on('error', reject);
  });

  /* ---- fonts ---- */
  const registered = new Map<string, string>();
  let arabicFallback = 'Helvetica';
  let latinFallback = 'Helvetica';

  const ensureFont = async (familyId: string, weight: 400 | 700, italic: boolean): Promise<void> => {
    const key = `${familyId}-${weight}${italic ? 'i' : ''}`;
    if (registered.has(key)) return;
    const files = FONT_FILES[familyId] ?? FONT_FILES.Amiri;
    const file = (italic ? files[`${weight}i` as '400i' | '700i'] : files[String(weight) as '400' | '700'])
      ?? files[String(weight === 700 ? 700 : 400) as '400' | '700']
      ?? files['400'];
    if (!file) return;
    try {
      const buf = await fetchFont(file);
      doc.registerFont(key, Buffer.from(buf));
      registered.set(key, key);
    } catch (err) {
      console.warn('[pdf] font registration failed', file, err);
    }
  };

  // Pre-load the book's default fonts (plus both weights) before drawing.
  const families = new Set<string>();
  for (const p of pages) {
    for (const b of p.model.blocks) {
      const id = familyIdFromCss(b.fontFamily);
      if (id) families.add(id);
    }
  }
  if (!families.size) families.add('Amiri');
  onProgress?.(0, workPageCount, 'fonts');
  for (const id of families) {
    await ensureFont(id, 400, false);
    if (FONT_FILES[id]?.['700']) await ensureFont(id, 700, false);
    if (FONT_FILES[id]?.['400i']) await ensureFont(id, 400, true);
  }
  arabicFallback = registered.get('Amiri-400') ?? 'Helvetica';
  latinFallback = registered.get('EBGaramond-400') ?? registered.get('Inter-400') ?? 'Helvetica';

  const fonts: PdfFontSet = {
    register: (familyId, weight, italic) => {
      const key = `${familyId}-${weight}${italic ? 'i' : ''}`;
      if (registered.has(key)) return registered.get(key)!;
      const fallbackWeight = registered.get(`${familyId}-400`);
      return fallbackWeight ?? null;
    },
    arabicFallback,
    latinFallback,
  };
  const ctx: DrawContext = { doc, fonts, pageWidth, pageHeight: pdfPageHeight };

  /* ---- optional title page ---- */
  if (includeTitlePage) {
    doc.addPage({ size: [pageWidth, pdfPageHeight], margin: 0 });
    doc.rect(0, 0, pageWidth, pdfPageHeight).fill('#f7f1e3');
    const centerX = pageWidth / 2;
    const direction = book.language === 'ar' || book.language === 'mixed' ? 'rtl' : 'ltr';
    const drawCentered = (text: string, y: number, size: number, color = '#2b2417', bold = false) => {
      const isAr = hasArabic(text);
      const font = isAr ? (bold ? registered.get('Amiri-700') ?? arabicFallback : arabicFallback) : (bold ? registered.get('EBGaramond-700') ?? latinFallback : latinFallback);
      doc.font(font).fontSize(size);
      const w = doc.widthOfString(text, { lineBreak: false } as never);
      drawBidiLine(ctx, text, centerX + w / 2, y, size, color, direction, isAr ? font : arabicFallback, !isAr ? font : latinFallback);
    };
    drawCentered(book.title, pdfPageHeight * 0.3, 26, '#241d10', true);
    if (book.author) drawCentered(book.author, pdfPageHeight * 0.3 + 44, 15, '#4a3f2a');
    if (book.publisher) drawCentered(book.publisher, pdfPageHeight * 0.78, 11, '#6b5c41');
    drawCentered('CamScan', pdfPageHeight * 0.88, 10, '#8a7a5c');
  }

  /* ---- pages ---- */
  let hasTextLayer = false;
  for (let i = 0; i < pages.length; i++) {
    if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
    const input = pages[i];
    doc.addPage({ size: [pageWidth, pdfPageHeight], margin: 0 });

    if (mode === 'photos') {
      doc.rect(0, 0, pageWidth, pdfPageHeight).fill('#ffffff');
      if (input.originalJpeg) {
        doc.image(Buffer.from(input.originalJpeg), 0, 0, {
          fit: [pageWidth, pdfPageHeight],
          align: 'center',
          valign: 'center',
        });
      }
    } else {
      // Illustrations need their bytes registered under the block's key.
      const images = input.images ?? new Map<string, Uint8Array>();
      drawPage(ctx, input.model, images);
      if (input.model.blocks.some((b) => b.type !== 'illustration' && b.text.trim().length > 0)) {
        hasTextLayer = true;
      }
    }
    onProgress?.(i + 1, workPageCount, mode === 'photos' ? 'photos' : 'replica');

    // Yield to the event loop so the UI paints between pages.
    if (i % 2 === 1) await new Promise((r) => setTimeout(r, 0));
  }

  // Original photographs are a separate appendix, never a background image
  // behind the searchable text replica. This preserves selectable text while
  // giving archival users an exact visual reference for each exported page.
  if (mode === 'replica' && appendOriginalPhotos) {
    let photoIndex = 0;
    for (const input of pages) {
      if (!input.originalJpeg) continue;
      if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
      doc.addPage({ size: [pageWidth, pdfPageHeight], margin: 0 });
      doc.rect(0, 0, pageWidth, pdfPageHeight).fill('#ffffff');
      doc.image(Buffer.from(input.originalJpeg), 0, 0, {
        fit: [pageWidth, pdfPageHeight],
        align: 'center',
        valign: 'center',
      });
      photoIndex++;
      onProgress?.(pages.length + photoIndex, workPageCount, 'photos');
      if (photoIndex % 2 === 0) await new Promise((r) => setTimeout(r, 0));
    }
  }

  doc.end();
  const blob = await done;
  const durationMs = Math.round(performance.now() - started);
  onProgress?.(workPageCount, workPageCount, 'complete');
  return {
    blob,
    pageCount: pages.length + extraPhotoPages + (includeTitlePage ? 1 : 0),
    bytes: blob.size,
    durationMs,
    hasTextLayer,
  };
}

/* ------------------------------------------------------------------ */
/* Downloads + photo-only helper                                       */
/* ------------------------------------------------------------------ */

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next macrotask so Safari has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function safeFilename(title: string, extension: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 80) || 'camscan-book';
  return `${base}.${extension}`;
}
