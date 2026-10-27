/// <reference lib="webworker" />
/**
 * CamScan — page processing pipeline worker.
 *
 * Receives a captured JPEG (Blob) and runs, entirely off the main thread:
 *
 *   1. decode            → ImageBitmap (createImageBitmap in a worker)
 *   2. detect            → page quad, or fall back to the full frame
 *   3. rectify           → perspective-corrected page at ≤2000 px long edge
 *   4. sample colours    → true paper & ink colours from the ORIGINAL pixels
 *   5. enhance           → shadow flattening + conservative level stretch
 *   6. quality metrics   → sharpness / exposure / glare
 *   7. layout hints      → ink density, column guess, blank detection
 *   8. OCR               → OcrProvider (Tesseract.js, itself in another worker)
 *   9. page model        → buildPageModel() → typed JSON
 *  10. thumbnails        → small JPEG data URLs for UI
 *
 * The ORIGINAL image is never modified; enhanced output is derived only.
 *
 * Messages
 *   in : { type:'process', id, blob, options }
 *        { type:'ping' }
 *   out: progress events + one final result / error
 */
import {
  detectPageQuad,
  enhancePage,
  analyzeLayout,
  measureQuality,
  qualityWarnings,
  rectifyPage,
  sampleColors,
  downscale,
  type PixelBuffer,
  type EnhanceProfile,
} from '../lib/imageAnalysis';
import { buildPageModel, rgbToHex, type OcrObservation } from '../lib/pageModel';
import { guessLanguage } from '../lib/normalize';
import { TesseractProvider } from '../lib/ocr/tesseractProvider';
import type { PageModel } from '../lib/types';

export interface ProcessOptions {
  pageId: string;
  sequence: number;
  languages: string[];
  profile: EnhanceProfile;
  arabicFont?: string;
  latinFont?: string;
  reviewThreshold: number;
  /** Skip OCR (used for "photo only" imports or quick thumbnails). */
  skipOcr?: boolean;
  /** Max long edge of the rectified image. */
  maxLongEdge?: number;
}

export interface ProcessResult {
  model: PageModel;
  /** Enhanced JPEG (rectified) as an array buffer + mime. */
  processed: { buffer: ArrayBuffer; type: string };
  thumb: string;
  width: number;
  height: number;
  avgConfidence: number;
  metrics: {
    processingMs: number;
    preprocessMs: number;
    ocrMs: number;
    sharpness: number;
    brightness: number;
    coverage: number;
    detectionConfidence: number;
  };
  warnings: string[];
  /** Set when OCR threw (kept so the UI can show a precise reason). */
  ocrError?: string;
}

interface InMessage {
  type: 'process' | 'ping';
  id: number;
  blob?: Blob;
  options?: ProcessOptions;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

/** One reusable Tesseract provider per worker instance. */
const tesseract = new TesseractProvider({
  workerPath: '/vendor/tesseract/worker.min.js',
  langPath: '/tessdata',
  corePath: '/vendor/tesseract',
});

const progress = (id: number, value: number, stage: string) => {
  ctx.postMessage({ type: 'progress', id, value, stage });
};

ctx.onmessage = async (event: MessageEvent<InMessage>) => {
  const msg = event.data;
  if (msg.type === 'ping') {
    ctx.postMessage({ type: 'pong', id: msg.id });
    return;
  }
  if (msg.type !== 'process' || !msg.blob || !msg.options) return;

  const { id, blob, options } = msg;
  const t0 = performance.now();
  try {
    const result = await processPage(blob, options, (p, stage) => progress(id, p, stage));
    ctx.postMessage({ type: 'done', id, result }, [result.processed.buffer]);
  } catch (err) {
    ctx.postMessage({ type: 'error', id, error: (err as Error).message || String(err) });
  }
};

/* ------------------------------------------------------------------ */
/* Pipeline                                                            */
/* ------------------------------------------------------------------ */

export async function processPage(
  blob: Blob,
  options: ProcessOptions,
  onProgress: (p: number, stage: string) => void,
): Promise<ProcessResult> {
  const t0 = performance.now();
  const warnings: string[] = [];

  /* 1. Decode -------------------------------------------------------- */
  onProgress(0.05, 'decode');
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const c2d = canvas.getContext('2d', { willReadFrequently: true });
  if (!c2d) throw new Error('Canvas 2D is unavailable in this browser');
  c2d.drawImage(bitmap, 0, 0);
  const imageData = c2d.getImageData(0, 0, bitmap.width, bitmap.height);
  const source: PixelBuffer = {
    data: imageData.data,
    width: bitmap.width,
    height: bitmap.height,
  };
  bitmap.close();

  const tPre = performance.now();

  /* 2. Detect -------------------------------------------------------- */
  onProgress(0.15, 'detect');
  const quad = detectPageQuad(source, { workingSize: 480, minCoverage: 0.2 });
  if (!quad.corners) warnings.push('page-boundary-not-detected');
  else if (quad.confidence < 0.45) warnings.push('low-boundary-confidence');

  /* 3. Rectify ------------------------------------------------------- */
  onProgress(0.3, 'rectify');
  const maxLongEdge = options.maxLongEdge ?? 2000;
  const rectified = rectifyPage(source, quad, { maxLongEdge });
  // Free the full-size buffer as soon as possible.
  source.data = new Uint8ClampedArray(0);

  /* 4. Sample true colours from the ORIGINAL (pre-enhancement) pixels -- */
  const colors = sampleColors(rectified.buffer);
  const paperColor = rgbToHex(colors.paper.r, colors.paper.g, colors.paper.b);
  const inkColor = pickInkColor(colors.ink);

  /* 5. Enhance (derived image only) ---------------------------------- */
  onProgress(0.42, 'enhance');
  const enhanced = rectified.usedFullFrame && quad.confidence >= 0.25
    ? rectified.buffer
    : enhancePage(rectified.buffer, { profile: options.profile });

  /* 6. Quality metrics + 7. layout hints ----------------------------- */
  onProgress(0.5, 'quality');
  // Quality is measured on the ORIGINAL rectified capture: the enhanced image
  // is deliberately pushed toward bright paper, so measuring it would report
  // false "glare"/"too bright" warnings and hide real exposure problems.
  const quality = measureQuality(rectified.buffer);
  const qWarnings = qualityWarnings(quality, quad.coverage);
  for (const w of qWarnings) warnings.push(w);

  const preliminaryLanguage = options.languages[0] ?? 'ar';
  const direction = ['ara', 'fas', 'urd'].includes(preliminaryLanguage) ? 'rtl' : 'ltr';
  const hints = analyzeLayout(enhanced, direction);
  if (hints.likelyBlank) warnings.push('possibly-blank');
  const expectedContentBottom = hints.contentBox.y + hints.contentBox.h;

  /* 8. Encode processed JPEG ----------------------------------------- */
  onProgress(0.58, 'encode');
  const outCanvas = new OffscreenCanvas(enhanced.width, enhanced.height);
  const outCtx = outCanvas.getContext('2d');
  if (!outCtx) throw new Error('Canvas 2D is unavailable');
  outCtx.putImageData(new ImageData(enhanced.data as Uint8ClampedArray<ArrayBuffer>, enhanced.width, enhanced.height), 0, 0);
  const processedBlob = await outCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.86 });
  const processedBuffer = await processedBlob.arrayBuffer();

  /* 9. OCR ----------------------------------------------------------- */
  const tOcr = performance.now();
  let observations: OcrObservation[] = [];
  let avgConfidence = 0;
  let engine = 'none';
  let engineVersion: string | undefined;
  let ocrWarnings: string[] = [];
  let ocrError: string | undefined;

  if (!options.skipOcr && !hints.likelyBlank) {
    onProgress(0.62, 'ocr');
    try {
      const ocr = await recognizeByScriptBands(
        processedBlob,
        options.languages,
        direction,
        expectedContentBottom,
        (p) => onProgress(0.62 + p * 0.28, 'ocr'),
      );
      engine = ocr.engine;
      engineVersion = ocr.engineVersion;
      avgConfidence = ocr.confidence;
      ocrWarnings = ocr.warnings ?? [];
      observations = ocr.lines.map((line) => ({
        text: line.text,
        bbox: line.bbox,
        confidence: line.confidence,
        wordConfidences: line.words?.map((w) => w.confidence),
      }));
      if (!observations.length) warnings.push('no-text-recognised');
    } catch (err) {
      // OCR failure must not lose the capture — the page stays reviewable and
      // can be retried or typed manually.
      warnings.push('ocr-failed');
      ocrError = (err as Error).message || String(err);
      ocrWarnings.push(ocrError);
    }
  }

  /* 10. Page model --------------------------------------------------- */
  onProgress(0.94, 'model');
  const model = buildPageModel(observations, {
    pageId: options.pageId,
    sequence: options.sequence,
    pixelWidth: enhanced.width,
    pixelHeight: enhanced.height,
    paperColor,
    inkColor,
    languages: options.languages,
    arabicFont: options.arabicFont,
    latinFont: options.latinFont,
    blockReviewThreshold: options.reviewThreshold,
    engine: engine === 'none' ? 'tesseract:skipped' : engine,
    engineVersion,
    profile: options.profile,
  });
  for (const w of ocrWarnings) model.warnings?.push(w);
  if (hints.columns > 1) model.warnings?.push('two-column-layout-detected');
  if (hints.likelyBlank) model.warnings?.push('possibly-blank');

  // Language refinement using the recognised text (honest: heuristic).
  if (model.blocks.length) {
    const joined = model.blocks.map((b) => b.text).join(' ');
    const guessed = guessLanguage(joined);
    model.language = guessed.language === 'und' ? preliminaryLanguage : guessed.language;
  }

  /* Thumbnail -------------------------------------------------------- */
  onProgress(0.97, 'thumbnail');
  const thumb = await makeThumb(enhanced, 168);

  const processingMs = Math.round(performance.now() - t0);
  onProgress(1, 'done');

  return {
    model,
    processed: { buffer: processedBuffer, type: 'image/jpeg' },
    thumb,
    width: enhanced.width,
    height: enhanced.height,
    avgConfidence,
    metrics: {
      processingMs,
      preprocessMs: Math.round(tPre - t0),
      ocrMs: Math.round(performance.now() - tOcr - (processingMs - (performance.now() - t0)) / 2),
      sharpness: Number(quality.sharpness.toFixed(3)),
      brightness: Number(quality.brightness.toFixed(3)),
      coverage: Number(quad.coverage.toFixed(3)),
      detectionConfidence: Number(quad.confidence.toFixed(3)),
    },
    warnings,
    ocrError,
  };
}


/* ------------------------------------------------------------------ */
/* Mixed-script OCR                                                    */
/* ------------------------------------------------------------------ */

const LATIN_LETTER = /[A-Za-z\u00C0-\u024F]/g;
const ARABIC_LETTER = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/g;

function scriptRatio(text: string): { latin: number; arabic: number; total: number } {
  const latin = (text.match(LATIN_LETTER) ?? []).length;
  const arabic = (text.match(ARABIC_LETTER) ?? []).length;
  return { latin, arabic, total: latin + arabic };
}

/**
 * Recognize a page that may contain more than one script.
 *
 * Why this exists: a single Tesseract pass with `ara+eng` runs *both* models on
 * every line, so Latin word-lists get forced onto Arabic glyphs and vice versa
 * (measured: "تاريخالعلم Saale"). Instead we:
 *
 *   1. run the primary language only (cheap, correct for most pages);
 *   2. group the recognised lines into text rows;
 *   3. mark rows the primary engine was unsure about as *suspect*;
 *   4. if any row is suspect, run the secondary language over the whole page;
 *   5. splice a second-pass line in for a suspect row only when it is clearly
 *      more confident **and** actually written in the secondary script.
 *
 * Cropping just the suspect bands was tried first and made things worse: a wide,
 * thin crop has no layout for Tesseract to work with. Recognising the full page
 * with the second model keeps both passes in the same coordinate space, so line
 * boxes line up without any correction.
 *
 * Honest scope: this is a row-level heuristic, not real polyglot layout
 * analysis. A page with a single script costs exactly one pass.
 */
async function recognizeByScriptBands(
  image: Blob,
  languages: string[],
  direction: 'rtl' | 'ltr',
  expectedContentBottom: number,
  onProgress: (p: number) => void,
) {
  const priority = languages.includes('ara') ? ['ara', ...languages.filter((l) => l !== 'ara')] : [...languages];
  const primary = priority[0] ?? 'eng';
  const secondary = priority.find((l) => l !== primary);

  const first = await tesseract.recognize({
    image,
    languages: [primary],
    directionHint: direction,
    expectedContentBottom,
    onProgress: (p) => onProgress(p * 0.6),
  });

  if (!secondary || !first.lines.length) return first;

  /**
   * Row grouping: lines whose vertical spans overlap belong to the same row.
   * A mixed-script page usually has whole *rows* in the other script, so rows
   * are the right granularity to retry.
   */
  type Row = { lines: typeof first.lines; y0: number; y1: number; conf: number; text: string };
  const rows: Row[] = [];
  for (const line of [...first.lines].sort((a, b) => a.bbox.y - b.bbox.y)) {
    const row = rows[rows.length - 1];
    const y0 = line.bbox.y;
    const y1 = line.bbox.y + line.bbox.h;
    if (row && y0 < row.y1 - 0.004) {
      row.lines.push(line);
      row.y1 = Math.max(row.y1, y1);
      row.conf = Math.min(row.conf, line.confidence); // a row is as good as its weakest line
      row.text += ` ${line.text}`;
    } else {
      rows.push({ lines: [line], y0, y1, conf: line.confidence, text: line.text });
    }
  }

  // A row is suspect when the primary engine was unsure about it.
  const suspect = rows.filter((row) => row.conf < 55);
  if (!suspect.length) return first;

  try {
    const second = await tesseract.recognize({
      image,
      languages: [secondary],
      directionHint: secondary === 'eng' ? 'ltr' : 'rtl',
      expectedContentBottom,
      onProgress: (p) => onProgress(0.6 + p * 0.4),
    });
    if (!second.lines.length) return first;

    type SecondaryLine = (typeof second.lines)[number];
    const replaced = new Map<(typeof first.lines)[number], SecondaryLine>();

    /** Fraction of a text's letters that belong to the expected script. */
    const scriptOK = (text: string) => {
      const r = scriptRatio(text);
      if (r.total === 0) return false;
      return (secondary === 'eng' ? r.latin : r.arabic) / r.total >= 0.75;
    };

    for (const row of suspect) {
      const rx0 = Math.min(...row.lines.map((l) => l.bbox.x));
      const rx1 = Math.max(...row.lines.map((l) => l.bbox.x + l.bbox.w));
      const candidates = second.lines.filter((l) => {
        const cy = l.bbox.y + l.bbox.h / 2;
        // Vertical: the line must sit inside the row it would replace.
        if (cy < row.y0 - 0.006 || cy > row.y1 + 0.006) return false;
        // Horizontal: and over the same columns, so a wide row can never pick up
        // a line from a different part of the page.
        const overlap = Math.max(0, Math.min(l.bbox.x + l.bbox.w, rx1) - Math.max(l.bbox.x, rx0));
        const union = Math.max(1e-6, Math.max(l.bbox.x + l.bbox.w, rx1) - Math.min(l.bbox.x, rx0));
        return overlap / union >= 0.5;
      });
      if (!candidates.length) continue;

      const best = candidates.reduce((a, b) => (b.confidence > a.confidence ? b : a));
      /**
       * Strict acceptance — both conditions are required:
       *   • the secondary read must be clearly more confident, and
       *   • it must actually be in the secondary script.
       * Without the script check a confident Latin line could overwrite a good
       * Arabic row; that happened during development and is exactly the kind of
       * silent corruption this app must never do.
       */
      if (best.confidence <= row.conf + 12 || !scriptOK(best.text)) continue;

      for (const line of row.lines) replaced.set(line, best);
      // A wrapped paragraph yields several second-pass lines for one row: keep
      // the ones that overlap it and are in the right script.
      for (const extra of candidates) {
        if (extra === best || !scriptOK(extra.text)) continue;
        replaced.set(extra as never, extra);
      }
    }

    if (!replaced.size) return first;

    const merged: typeof first.lines = [];
    const seen = new Set<string>();
    for (const line of first.lines) {
      const chosen = replaced.get(line) ?? line;
      const key = `${chosen.text}|${chosen.bbox.y.toFixed(3)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(chosen);
    }
    for (const line of replaced.values()) {
      const key = `${line.text}|${line.bbox.y.toFixed(3)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(line);
    }
    merged.sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);

    const confidence = merged.length
      ? merged.reduce((sum, l) => sum + l.confidence, 0) / merged.length
      : first.confidence;

    return {
      ...first,
      lines: merged,
      text: merged.map((l) => l.text).join('\n'),
      confidence,
      warnings: [
        ...(first.warnings ?? []),
        `second-script pass (${secondary}) replaced ${replaced.size} line(s)`,
      ],
    };
  } catch {
    return first;
  }
}

/**
 * Ink colour: sampled darkest colour, made readable against the paper.
 * Old books often use brown/sepia ink — we keep it, only nudging values that
 * would be invisible (e.g. scanning noise) toward a legible tone.
 */
function pickInkColor(ink: { r: number; g: number; b: number }): string {
  const lum = ink.r * 0.299 + ink.g * 0.587 + ink.b * 0.114;
  if (lum < 250) return rgbToHex(ink.r, ink.g, ink.b);
  return '#241d12';
}

/** Small JPEG data URL thumbnail from a PixelBuffer (worker-safe). */
async function makeThumb(buffer: PixelBuffer, maxSize: number): Promise<string> {
  const small = downscale(buffer, maxSize);
  const canvas = new OffscreenCanvas(small.width, small.height);
  const ctx2 = canvas.getContext('2d');
  if (!ctx2) return '';
  ctx2.putImageData(new ImageData(small.data as Uint8ClampedArray<ArrayBuffer>, small.width, small.height), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
  return blobToDataUrl(blob);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export {};
