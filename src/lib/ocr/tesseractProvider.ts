/**
 * CamScan — Tesseract.js OCR provider (real, local, no API keys).
 *
 * Details that matter:
 *  - Worker, WASM core and `.traineddata` packs are **served from our own
 *    origin** (`/vendor/tesseract/*`, `/tessdata/*`) so recognition works
 *    offline after the first load and no book content leaves the device.
 *  - Text is returned verbatim. We do not "fix" diacritics, spelling or
 *    direction — the reader shows exactly what the engine recognised and flags
 *    low-confidence lines for review.
 *  - It genuinely blocks nothing: the heavy work happens inside Tesseract's own
 *    Web Worker; our pipeline worker merely awaits it.
 */
import { createWorker, type Worker as TessWorker } from 'tesseract.js';
import type { NormBox } from '../types';
import type { OcrLine, OcrPageResult, OcrProvider, OcrRequest, OcrWord } from './provider';

/** Languages whose packs are vendored by scripts/fetch-assets.mjs. */
export const VENDORED_LANGUAGES = ['ara', 'eng', 'fra', 'deu', 'fas', 'urd', 'tur'] as const;

export interface TesseractProviderOptions {
  /** Base path for the tesseract.js worker script. */
  workerPath?: string;
  /** Base path for traineddata packs. */
  langPath?: string;
  /** Base path for core wasm builds. */
  corePath?: string;
  /** Logger (defaults to console.debug in dev). */
  logger?: (msg: string) => void;
}

const DEFAULT_OPTS: Required<Omit<TesseractProviderOptions, 'logger'>> = {
  workerPath: '/vendor/tesseract/worker.min.js',
  langPath: '/tessdata',
  corePath: '/vendor/tesseract',
};

export class TesseractProvider implements OcrProvider {
  readonly id = 'tesseract';
  readonly name = 'Tesseract.js (local)';
  readonly description = 'Runs fully in your browser. First use downloads the language pack; afterwards it works offline.';

  private worker: TessWorker | null = null;
  private workerLangs = '';
  private opts: TesseractProviderOptions;

  constructor(options: TesseractProviderOptions = {}) {
    this.opts = { ...DEFAULT_OPTS, ...options };
  }

  async isAvailable(): Promise<boolean> {
    if (typeof window === 'undefined' || typeof Worker === 'undefined') return false;
    try {
      const res = await fetch(this.opts.workerPath ?? DEFAULT_OPTS.workerPath, { method: 'HEAD' });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Create (or reuse) one Tesseract worker for a language set. */
  private async ensureWorker(languages: string[], logger?: (m: string) => void): Promise<{ worker: TessWorker; loaded: string[]; warnings: string[] }> {
    const wanted = normalizeLanguages(languages);
    const key = wanted.join('+');
    const warnings: string[] = [];

    if (this.worker && this.workerLangs === key) {
      return { worker: this.worker, loaded: wanted, warnings };
    }

    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
    }

    // Only ask for packs we actually vendored; unknown codes are skipped with a
    // warning instead of crashing the whole page.
    const usable = wanted.filter((l) => (VENDORED_LANGUAGES as readonly string[]).includes(l));
    for (const missing of wanted.filter((l) => !usable.includes(l))) {
      warnings.push(`language pack "${missing}" is not bundled — skipped`);
    }
    const langs = usable.length ? usable : ['eng'];

    const worker = await createWorker(langs, 1, {
      workerPath: this.opts.workerPath ?? DEFAULT_OPTS.workerPath,
      langPath: this.opts.langPath ?? DEFAULT_OPTS.langPath,
      corePath: this.opts.corePath ?? DEFAULT_OPTS.corePath,
      workerBlobURL: false,
      gzip: false,
      logger: (m: { status: string; progress: number }) => {
        logger?.(`${m.status} ${Math.round((m.progress ?? 0) * 100)}%`);
      },
      errorHandler: (e: unknown) => {
        logger?.(`tesseract error: ${String(e)}`);
      },
    });

    // PSM 3 = fully automatic page segmentation without OSD.
    // PSM 6 = single uniform block: only used as a retry fallback.
    await worker.setParameters({
      tessedit_pageseg_mode: '3' as never,
      preserve_interword_spaces: '1',
      // Keep native UTF-8 output; do not normalise away diacritics.
      tessedit_do_invert: '0' as never,
    });

    this.worker = worker;
    this.workerLangs = key;
    return { worker, loaded: langs, warnings };
  }

  async recognize(request: OcrRequest): Promise<OcrPageResult> {
    const started = performance.now();
    const { worker, loaded, warnings } = await this.ensureWorker(request.languages, this.opts.logger);

    if (request.signal?.aborted) throw new DOMException('OCR cancelled', 'AbortError');

    request.onProgress?.(0.1, 'ocr-init');

    let imageInput: Parameters<TessWorker['recognize']>[0] = request.image as never;
    let cropOffset = { x: 0, y: 0, w: 1, h: 1 };
    /** Pixel size of the image actually handed to Tesseract. */
    let analysedSize: { w: number; h: number } | null = null;

    const sourceSize = await imageSize(request.image);
    if (request.region) {
      const cropped = await cropRegion(request.image, request.region, request.minWidth);
      if (cropped) {
        imageInput = cropped.image as never;
        cropOffset = { x: request.region.x, y: request.region.y, w: request.region.w, h: request.region.h };
        analysedSize = cropped.size;
      }
    } else {
      analysedSize = sourceSize;
    }

    const progress = { current: 0.15 };
    const onProgress = request.onProgress;
    // Tesseract's own logger was bound at creation; surface coarse progress so
    // the UI moves even if the logger isn't re-bound.
    const ticker = setInterval(() => {
      progress.current = Math.min(0.85, progress.current + 0.05);
      onProgress?.(progress.current, 'ocr');
    }, 900);
    onProgress?.(0.2, 'ocr');

    if (request.psm) {
      await worker.setParameters({ tessedit_pageseg_mode: request.psm as never }).catch(() => undefined);
    }

    let result: Awaited<ReturnType<TessWorker['recognize']>>;
    try {
      // Pass 1 — automatic page segmentation (PSM 3).
      result = await worker.recognize(imageInput as never, {}, { blocks: true, text: true });

      /**
       * Adaptive segmentation.
       *
       * Measured behaviour on real mixed Arabic/Latin pages: PSM 3 sometimes
       * stops after the first big text column, silently dropping the Latin
       * block, footnotes and the page number. PSM 6 (uniform block) reads the
       * whole page but is worse for genuinely multi-column layouts.
       *
       * So: if the recognised text does not reach near the measured bottom of
       * the printed area, re-run once with PSM 6 and keep whichever pass read
       * more of the page. Truncation is the failure mode we care about; it is
       * invisible to the user otherwise.
       */
      const expectedBottom = request.expectedContentBottom ?? 0.9;
      const bottom = result.data.blocks?.length ? maxBottom(result) : 1;
      if (!request.psm && bottom < expectedBottom - 0.12) {
        const firstPass = result;
        try {
          await worker.setParameters({ tessedit_pageseg_mode: '6' as never });
          const secondPass = await worker.recognize(imageInput as never, {}, { blocks: true, text: true });
          await worker.setParameters({ tessedit_pageseg_mode: '3' as never });
          const score = (r: typeof firstPass) => {
            const lines = countLines(r);
            const b = maxBottom(r);
            const conf = typeof r.data.confidence === 'number' ? r.data.confidence : 0;
            return lines * (0.4 + b) * (0.5 + conf / 100);
          };
          if (score(secondPass) > score(firstPass)) {
            result = secondPass;
            warnings.push('used uniform-block segmentation (fuller page read)');
          }
        } catch {
          await worker.setParameters({ tessedit_pageseg_mode: '3' as never }).catch(() => undefined);
        }
      }
    } catch (err) {
      // Fallback: some engines choke on unusual page segmentation; retry once
      // with a single-block mode before we give up on the page.
      try {
        await worker.setParameters({ tessedit_pageseg_mode: '6' as never });
        result = await worker.recognize(imageInput as never, {}, { blocks: true, text: true });
        warnings.push('retried with single-block segmentation');
        await worker.setParameters({ tessedit_pageseg_mode: '3' as never });
      } catch (retryErr) {
        clearInterval(ticker);
        throw new Error(`OCR failed: ${(retryErr as Error).message || String(retryErr)}`);
      }
    } finally {
      clearInterval(ticker);
    }

    onProgress?.(0.95, 'ocr-finalise');

    /**
     * Normalisation size. tesseract.js 6 does **not** populate
     * `result.data.width/height` (verified: both are `undefined`), so using them
     * — or a hardcoded fallback — silently squashes every line box toward the
     * top-left of the page. Measure the analysed image instead.
     */
    const reported = result.data as unknown as { width?: number; height?: number };
    const pageWidth = reported?.width || analysedSize?.w || sourceSize?.w || 1;
    const pageHeight = reported?.height || analysedSize?.h || sourceSize?.h || 1;

    const lines = extractLines(result, pageWidth, pageHeight, cropOffset);
    const confidence = typeof result.data.confidence === 'number'
      ? result.data.confidence
      : lines.length ? lines.reduce((s, l) => s + l.confidence, 0) / lines.length : 0;

    onProgress?.(1, 'ocr-done');

    return {
      lines,
      text: result.data.text ?? lines.map((l) => l.text).join('\n'),
      confidence: Math.max(0, Math.min(100, confidence)),
      engine: this.id,
      engineVersion: typeof result.data.version === 'string' ? result.data.version : undefined,
      languages: loaded,
      durationMs: Math.round(performance.now() - started),
      warnings: warnings.length ? warnings : undefined,
    };
  }

  async terminate(): Promise<void> {
    if (this.worker) {
      try {
        await this.worker.terminate();
      } catch {
        /* ignore */
      }
      this.worker = null;
      this.workerLangs = '';
    }
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Arabic first, English second, de-duplicated, max 3 packs (perf guard). */
export function normalizeLanguages(languages: string[]): string[] {
  const clean = languages
    .flatMap((l) => l.split('+'))
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean);
  const priority = (l: string) => (l === 'ara' ? 0 : l === 'eng' ? 1 : 2);
  return [...new Set(clean)].sort((a, b) => priority(a) - priority(b)).slice(0, 3);
}

/** Number of recognised lines across all blocks. */
function countLines(result: { data: { blocks?: Array<{ paragraphs?: Array<{ lines?: unknown[] }> }> | null } }): number {
  let n = 0;
  for (const block of result.data.blocks ?? []) {
    for (const para of block.paragraphs ?? []) n += para.lines?.length ?? 0;
  }
  return n;
}

/** Normalised bottom edge of the last recognised line on the page. */
function maxBottom(result: { data: { blocks?: Array<{ paragraphs?: Array<{ lines?: Array<{ bbox?: { y1: number } }> }> }> | null; height?: number } }): number {
  const height = result.data.height || 1;
  let max = 0;
  for (const block of result.data.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        const y1 = line.bbox?.y1 ?? 0;
        if (y1 / height > max) max = y1 / height;
      }
    }
  }
  return max;
}

interface RawLine {
  text?: string;
  confidence?: number;
  bbox?: { x0: number; y0: number; x1: number; y1: number };
  words?: RawLine[];
}

/**
 * Flatten Tesseract's block/paragraph/line tree into normalised lines.
 * Coordinates from Tesseract are in the *cropped* image's pixel space.
 */
export function extractLines(
  result: { data: { blocks?: Array<{ paragraphs?: Array<{ lines?: RawLine[] }> }> | null; width?: number; height?: number } },
  pageWidth: number,
  pageHeight: number,
  cropOffset: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: 1, h: 1 },
): OcrLine[] {
  const rawLines: RawLine[] = [];
  for (const block of result.data.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) rawLines.push(line);
    }
  }

  if (!rawLines.length) return [];

  const w = pageWidth || 1;
  const h = pageHeight || 1;

  return rawLines
    .filter((l) => (l.text ?? '').trim().length > 0)
    .map((line) => {
      const b = line.bbox ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
      const bbox: NormBox = {
        x: Math.max(0, Math.min(1, cropOffset.x + (b.x0 / w) * cropOffset.w)),
        y: Math.max(0, Math.min(1, cropOffset.y + (b.y0 / h) * cropOffset.h)),
        w: Math.max(0, Math.min(1, ((b.x1 - b.x0) / w) * cropOffset.w)),
        h: Math.max(0, Math.min(1, ((b.y1 - b.y0) / h) * cropOffset.h)),
      };
      const words: OcrWord[] | undefined = line.words?.map((word) => {
        const wb = word.bbox ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
        return {
          text: word.text ?? '',
          confidence: word.confidence ?? 0,
          bbox: {
            x: Math.max(0, Math.min(1, cropOffset.x + (wb.x0 / w) * cropOffset.w)),
            y: Math.max(0, Math.min(1, cropOffset.y + (wb.y0 / h) * cropOffset.h)),
            w: Math.max(0, Math.min(1, ((wb.x1 - wb.x0) / w) * cropOffset.w)),
            h: Math.max(0, Math.min(1, ((wb.y1 - wb.y0) / h) * cropOffset.h)),
          },
        };
      });
      return {
        text: (line.text ?? '').trim(),
        confidence: typeof line.confidence === 'number' ? line.confidence : 0,
        bbox,
        words,
      };
    })
    .filter((l) => l.bbox.w > 0 && l.bbox.h > 0);
}

/** Crop an image source to a normalised region; returns a Blob. */
async function cropRegion(
  image: OcrRequest['image'],
  region: NormBox,
  minWidth = 0,
): Promise<{ image: Blob; size: { w: number; h: number } } | null> {
  if (typeof document === 'undefined' && typeof OffscreenCanvas === 'undefined') return null;
  let bitmap: ImageBitmap | null = null;
  if (image instanceof Blob) {
    bitmap = await createImageBitmap(image);
  } else if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) {
    bitmap = image;
  } else {
    return null;
  }
  const sx = Math.round(region.x * bitmap.width);
  const sy = Math.round(region.y * bitmap.height);
  const sw = Math.max(1, Math.round(region.w * bitmap.width));
  const sh = Math.max(1, Math.round(region.h * bitmap.height));

  // A thin band cropped from a downscaled page is often only ~100 px tall,
  // which Tesseract reads badly. Upscaling the crop costs little and lifts
  // small-print band recognition a lot.
  const scale = minWidth > 0 && sw < minWidth ? Math.min(4, minWidth / sw) : 1;
  const outW = Math.max(1, Math.round(sw * scale));
  const outH = Math.max(1, Math.round(sh * scale));

  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(outW, outH)
    : Object.assign(document.createElement('canvas'), { width: outW, height: outH });
  const ctx = (canvas as OffscreenCanvas).getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, outW, outH);
  bitmap.close?.();
  const blob = canvas instanceof OffscreenCanvas
    ? await canvas.convertToBlob({ type: 'image/png' })
    : await new Promise<Blob | null>((resolve) => (canvas as HTMLCanvasElement).toBlob(resolve, 'image/png'));
  return blob ? { image: blob, size: { w: outW, h: outH } } : null;
}

/**
 * Pixel dimensions of an image source.
 *
 * Tesseract reports line boxes in the pixel space of the image it analysed, so
 * we must normalise with exactly those dimensions — never a guess.
 */
async function imageSize(image: OcrRequest['image']): Promise<{ w: number; h: number } | null> {
  try {
    if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) {
      return { w: image.width, h: image.height };
    }
    if (typeof OffscreenCanvas !== 'undefined' && image instanceof OffscreenCanvas) {
      return { w: image.width, h: image.height };
    }
    if (typeof HTMLCanvasElement !== 'undefined' && image instanceof HTMLCanvasElement) {
      return { w: image.width, h: image.height };
    }
    if (image instanceof Blob) {
      const bitmap = await createImageBitmap(image);
      const size = { w: bitmap.width, h: bitmap.height };
      bitmap.close?.();
      return size;
    }
  } catch {
    /* fall through */
  }
  return null;
}
