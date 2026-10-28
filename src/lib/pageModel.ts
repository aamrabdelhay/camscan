/**
 * CamScan — page model construction.
 *
 * This module is deliberately pure (no DOM, no workers, no OCR dependency):
 * it takes *observations* produced by the CV/OCR stages and turns them into the
 * versioned `PageModel` JSON that the reader renders and the PDF exporter
 * writes. Keeping it pure makes the interesting logic unit-testable.
 *
 * Responsibilities
 *  - merge OCR lines into logical blocks (paragraph / heading / footnote …)
 *  - infer reading order for RTL, LTR and mixed-direction pages
 *  - classify region type from geometry (headers/footers/page numbers/footnotes)
 *  - estimate font size from line height relative to the page
 *  - sample ink colour and paper colour
 *  - map a stylistic category to the closest bundled free font
 *  - flag uncertainty (low confidence, overlapping blocks, empty pages)
 *  - never invent text: empty recognition stays empty
 */
import type {
  BlockType,
  FontCategory,
  NormBox,
  PageBlock,
  PageModel,
  TextAlign,
  TextDirection,
} from './types';
import { guessLanguage, hasArabicScript } from './normalize';

/* ------------------------------------------------------------------ */
/* Input observations                                                  */
/* ------------------------------------------------------------------ */

export interface OcrObservation {
  /** Recognised text; may include internal spaces but not newlines. */
  text: string;
  /** Normalised bbox (0..1) of the line. */
  bbox: NormBox;
  /** 0..100 confidence from the engine. */
  confidence: number;
  /** Optional per-word confidences (used to flag uncertain words). */
  wordConfidences?: number[];
}

export interface BuildOptions {
  pageId: string;
  sequence: number;
  /** PDF/JPEG pixel size of the rectified page. */
  pixelWidth: number;
  pixelHeight: number;
  paperColor: string;
  inkColor: string;
  /** Selected OCR languages, most important first. */
  languages: string[];
  /** Font family to use for Arabic-script blocks. */
  arabicFont?: string;
  /** Font family to use for Latin-script blocks. */
  latinFont?: string;
  /** Confidence below which a block is flagged uncertain (0..100). */
  blockReviewThreshold?: number;
  /** Printed page number if the OCR stage identified one. */
  printedNumber?: string;
  /** Detected illustrations (cropped image URLs) to keep in the replica. */
  illustrations?: Array<{ bbox: NormBox; imageUrl?: string; confidence?: number }>;
  /** Engine metadata for provenance. */
  engine: string;
  engineVersion?: string;
  profile?: string;
  now?: string;
}

/* ------------------------------------------------------------------ */
/* Font mapping                                                        */
/* ------------------------------------------------------------------ */

/** Families bundled by scripts/fetch-assets.mjs (see public/fonts/families.json). */
export const ARABIC_FONTS = [
  { id: 'Amiri', css: "'Amiri', serif", category: 'naskh' as FontCategory, note: 'Naskh — closest to most old printed Arabic' },
  { id: 'ScheherazadeNew', css: "'Scheherazade New', serif", category: 'naskh' as FontCategory, note: 'Naskh with generous diacritics support' },
  { id: 'NotoNaskhArabic', css: "'Noto Naskh Arabic', serif", category: 'naskh' as FontCategory, note: 'Modern Naskh' },
  { id: 'NotoKufiArabic', css: "'Noto Kufi Arabic', sans-serif", category: 'kufi' as FontCategory, note: 'Kufi headings' },
  { id: 'Cairo', css: "'Cairo', sans-serif", category: 'sans' as FontCategory, note: 'Contemporary sans' },
];

export const LATIN_FONTS = [
  { id: 'EBGaramond', css: "'EB Garamond', serif", category: 'serif' as FontCategory, note: 'Old-style serif — good for early printed books' },
  { id: 'Merriweather', css: "'Merriweather', serif", category: 'serif' as FontCategory, note: 'Sturdy serif' },
  { id: 'Inter', css: "'Inter', sans-serif", category: 'sans' as FontCategory, note: 'Neutral sans' },
  { id: 'JetBrainsMono', css: "'JetBrains Mono', monospace", category: 'mono' as FontCategory, note: 'Monospace / typewriter' },
];

/** Default font stacks for a script. */
export const DEFAULT_ARABIC_FONT = ARABIC_FONTS[0].css;
export const DEFAULT_LATIN_FONT = LATIN_FONTS[0].css;

/**
 * Map an estimated font category to the closest bundled family.
 * Honest limitation: this is a *closest match*, never an identification.
 */
export function fontForCategory(category: FontCategory, script: 'arabic' | 'latin'): string {
  if (script === 'arabic') {
    const hit = ARABIC_FONTS.find((f) => f.category === category);
    return (hit ?? ARABIC_FONTS[0]).css;
  }
  const hit = LATIN_FONTS.find((f) => f.category === category);
  return (hit ?? LATIN_FONTS[0]).css;
}

/**
 * Heuristic font category from a photo is inherently weak. We can only observe
 * stroke contrast / regularity / stroke angle once we have pixels; the OCR
 * stage passes a hint. Without a hint we fall back to script defaults.
 */
export function inferFontCategory(
  hint: FontCategory | undefined,
  script: 'arabic' | 'latin',
): FontCategory {
  if (hint) return hint;
  return script === 'arabic' ? 'naskh' : 'serif';
}

/* ------------------------------------------------------------------ */
/* Colour helpers                                                      */
/* ------------------------------------------------------------------ */

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const num = Number.parseInt(full.slice(0, 6), 16);
  if (!Number.isFinite(num)) return { r: 0, g: 0, b: 0 };
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

/** Relative luminance (WCAG) — used to pick readable fallback colours. */
export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/* ------------------------------------------------------------------ */
/* Geometry helpers                                                    */
/* ------------------------------------------------------------------ */

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function unionBox(a: NormBox, b: NormBox): NormBox {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.max(a.x + a.w, b.x + b.w) - x;
  const h = Math.max(a.y + a.h, b.y + b.h) - y;
  return { x, y, w, h };
}

export function boxCenterY(b: NormBox): number {
  return b.y + b.h / 2;
}

export function boxCenterX(b: NormBox): number {
  return b.x + b.w / 2;
}

export function verticalGap(a: NormBox, b: NormBox): number {
  return b.y - (a.y + a.h);
}

export function horizontalOverlap(a: NormBox, b: NormBox): number {
  const left = Math.max(a.x, b.x);
  const right = Math.min(a.x + a.w, b.x + b.w);
  return Math.max(0, right - left);
}

/** Do two boxes overlap significantly (>25% of the smaller area)? */
export function boxesOverlap(a: NormBox, b: NormBox): boolean {
  const left = Math.max(a.x, b.x);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const top = Math.max(a.y, b.y);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  if (right <= left || bottom <= top) return false;
  const inter = (right - left) * (bottom - top);
  const minArea = Math.min(a.w * a.h, b.w * b.h) || 1;
  return inter / minArea > 0.25;
}

/* ------------------------------------------------------------------ */
/* Classification                                                      */
/* ------------------------------------------------------------------ */

const PAGE_NUMBER_RE = /^[\s\-–—.·]*([0-9]{1,4}|[IVXLCDM]{1,7}|[٠-٩]{1,4}|[۰-۹]{1,4})[\s\-–—.·]*$/i;

/**
 * Classify a merged block from geometry + text content.
 * `medianHeight` is the median line height of the page (normalised), which is
 * used as the yardstick for "this is a footnote" and "this is a heading".
 */
export function classifyBlock(
  box: NormBox,
  text: string,
  medianHeight: number,
  bodyBox: NormBox,
  /** Median height of the block's *own lines* (not the union box). */
  lineHeight?: number,
): BlockType {
  const trimmed = text.trim();
  const cy = boxCenterY(box);
  const ref = lineHeight && lineHeight > 0 ? lineHeight : box.h;
  const heightRatio = medianHeight > 0 ? ref / medianHeight : 1;

  // Page number: short numeric string sitting in the top or bottom 12%.
  if (PAGE_NUMBER_RE.test(trimmed) && (cy < 0.12 || cy > 0.88)) return 'pageNumber';

  // Header / footer zones.
  if (cy < 0.09) return 'header';
  if (cy > 0.94) return 'footer';

  // Footnotes: small text below the main body mass.
  const bodyBottom = bodyBox.y + bodyBox.h;
  if (box.y > bodyBottom - 0.02 && heightRatio < 0.9) return 'footnote';

  // Heading: noticeably larger than the body median, not a full page of text.
  if (heightRatio > 1.35) return 'heading';

  // Short line ending without punctuation above the body → likely a running head
  if (cy < 0.14 && trimmed.length < 60 && heightRatio <= 1.1) return 'header';

  return 'paragraph';
}

/* ------------------------------------------------------------------ */
/* Line merging                                                        */
/* ------------------------------------------------------------------ */

interface WorkingBlock {
  lines: OcrObservation[];
  box: NormBox;
  text: string;
  confidence: number;
}

/**
 * Merge OCR lines into logical blocks.
 *
 * Two lines join a block when:
 *  - they are in the same column (horizontal overlap or one is short)
 *  - the vertical gap is below ~0.8× line height (paragraph flow)
 *  - the horizontal extent is comparable (avoid merging a marginal note)
 *
 * Lines are consumed in reading order (see `readingOrder`).
 */
export function mergeLinesIntoBlocks(
  lines: OcrObservation[],
  direction: TextDirection,
  pageAspect: number,
): WorkingBlock[] {
  if (!lines.length) return [];
  const heights = lines.map((l) => l.bbox.h).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)] || 0.02;

  /**
   * Classify a single line by size relative to the page median. Lines are only
   * ever merged with lines of the same class, which keeps a large title from
   * swallowing the body paragraph underneath it (a real bug we hit in testing).
   */
  const classOf = (h: number): 'large' | 'normal' | 'small' => {
    const ratio = h / medianHeight;
    if (ratio > 1.22) return 'large';
    if (ratio < 0.82) return 'small';
    return 'normal';
  };

  const maxLineWidth = Math.max(...lines.map((l) => l.bbox.w), 0.001);
  const sorted = readingOrder(lines, direction, pageAspect);
  const blocks: WorkingBlock[] = [];
  const blockClass: Array<'large' | 'normal' | 'small'> = [];
  const blockLineHeight: number[] = [];

  for (const line of sorted) {
    const prev = blocks[blocks.length - 1];
    const cls = classOf(line.bbox.h);
    if (prev) {
      const prevLine = prev.lines[prev.lines.length - 1];
      const gap = verticalGap(prevLine.bbox, line.bbox);
      const gapOK = gap >= -0.005 && gap < Math.max(0.012, medianHeight * 0.9);
      const overlap = horizontalOverlap(prevLine.bbox, line.bbox);
      const minWidth = Math.min(prevLine.bbox.w, line.bbox.w) || 1;
      const sameColumn = overlap / minWidth > 0.45;
      const compatibleSize = blockClass[blockClass.length - 1] === cls;
      // A large size change inside a block means a new paragraph/heading.
      const sizeJump = line.bbox.h / (blockLineHeight[blockLineHeight.length - 1] || 1);
      const smoothSize = sizeJump > 0.8 && sizeJump < 1.25;
      // A short line that sits above the body is typically a title or a running
      // head — it must not swallow the paragraph below it.
      const prevIsShort = prevLine.bbox.w < maxLineWidth * 0.5 && prev.lines.length === 1;
      if (gapOK && sameColumn && compatibleSize && smoothSize && !prevIsShort) {
        prev.lines.push(line);
        prev.box = unionBox(prev.box, line.bbox);
        prev.text = joinLines(prev.text, line.text, direction);
        prev.confidence = avgConfidence(prev.lines);
        // Running median keeps the reference stable across a long paragraph.
        const hs = prev.lines.map((l) => l.bbox.h).sort((a, b) => a - b);
        blockLineHeight[blockLineHeight.length - 1] = hs[Math.floor(hs.length / 2)];
        continue;
      }
    }
    blocks.push({ lines: [line], box: { ...line.bbox }, text: line.text, confidence: line.confidence });
    blockClass.push(cls);
    blockLineHeight.push(line.bbox.h);
  }
  return blocks;
}

/**
 * Join two physical lines.
 * Arabic and English both get a space; a trailing hyphen in Latin text that is
 * followed by a lower-case letter is treated as a soft hyphen and removed.
 */
export function joinLines(a: string, b: string, _direction: TextDirection): string {
  const left = a.replace(/\s+$/, '');
  const right = b.replace(/^\s+/, '');
  if (!left) return right;
  if (!right) return left;
  // Physical line boundaries are part of the transcription. Never remove a
  // printed end-of-line hyphen or join a word across lines during recognition.
  return `${left}\n${right}`;
}

function avgConfidence(lines: OcrObservation[]): number {
  if (!lines.length) return 0;
  const total = lines.reduce((sum, l) => sum + l.confidence, 0);
  return Math.round(total / lines.length);
}

/* ------------------------------------------------------------------ */
/* Reading order                                                       */
/* ------------------------------------------------------------------ */

/**
 * Order lines the way a human reads the page.
 *
 * The algorithm is a practical approximation, not full XY-cut:
 *  1. Split lines into rows by vertical overlap.
 *  2. Within a row, order by x (LTR: left→right, RTL: right→left).
 *  3. Rows are emitted top→bottom, except that footnote rows (below a large
 *     gap / separated by a rule) are pushed to the end.
 */
export function readingOrder(
  lines: OcrObservation[],
  direction: TextDirection,
  _pageAspect = 0.7,
): OcrObservation[] {
  if (lines.length <= 1) return [...lines];

  const medianLineHeight =
    [...lines].map((l) => l.bbox.h).sort((a, b) => a - b)[Math.floor(lines.length / 2)] || 0.02;

  /**
   * 1. Detect page columns.
   *
   * A per-row analysis cannot do this: on a two-column page the first line of
   * each column shares a baseline, but if the columns are staggered (or one is
   * shorter) the information is spread across rows. Instead we project all lines
   * onto the x axis and look for a *gutter* — a band with no ink — that splits
   * the page into two substantial columns.
   */
  const gutter = findColumnGutter(lines, medianLineHeight);

  /**
   * 2. Order the lines.
   *
   * - Two-column page: read one column fully, then the other (right column first
   *   on an RTL page).
   * - Single column: read rows top-to-bottom, except that a footnote band
   *   separated by a large vertical gap is moved to the end.
   */
  if (gutter) {
    const right = lines.filter((l) => l.bbox.x >= gutter);
    const left = lines.filter((l) => l.bbox.x < gutter);
    const byRows = (set: OcrObservation[]) => rowOrder(set, direction, medianLineHeight);
    const first = direction === 'rtl' ? right : left;
    const second = direction === 'rtl' ? left : right;
    return [...byRows(first), ...byRows(second)];
  }

  const rows = rowOrder(lines, direction, medianLineHeight);

  /* Footnote separation: biggest gap in the bottom half of the page. */
  let splitAt = rows.length;
  if (rows.length > 3) {
    let maxGap = 0;
    let maxIndex = -1;
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1].bbox;
      const gap = rows[i].bbox.y - (prev.y + prev.h);
      if (boxCenterY(rows[i].bbox) > 0.55 && gap > maxGap) {
        maxGap = gap;
        maxIndex = i;
      }
    }
    if (maxIndex > 0 && maxGap > medianLineHeight * 1.2) splitAt = maxIndex;
  }
  return [...rows.slice(0, splitAt), ...rows.slice(splitAt)];
}

/**
 * Find the x position of a column gutter, or null for a single-column page.
 *
 * Uses a coarse occupancy histogram of the lines' x extents: a column page has a
 * wide empty band between two occupied bands, each holding at least 25 % of the
 * text. This is deliberately conservative — mis-detecting columns scrambles the
 * reading order, which is worse than missing a genuine two-column page.
 */
export function findColumnGutter(lines: OcrObservation[], medianLineHeight: number): number | null {
  if (lines.length < 4) return null;
  const BINS = 100;
  const occupied = new Array<number>(BINS).fill(0);
  for (const l of lines) {
    const from = Math.max(0, Math.floor(l.bbox.x * BINS));
    const to = Math.min(BINS - 1, Math.ceil((l.bbox.x + l.bbox.w) * BINS) - 1);
    for (let b = from; b <= to; b++) occupied[b] += 1;
  }
  const total = lines.length;
  let best: { bin: number; runLength: number } | null = null;
  let runStart = -1;
  for (let b = 0; b <= BINS; b++) {
    const empty = b < BINS && occupied[b] === 0;
    if (empty && runStart < 0) runStart = b;
    if ((!empty || b === BINS) && runStart >= 0) {
      const runLength = b - runStart;
      // A gutter must be a real gap, not the margin before the first line.
      const leftLines = lines.filter((l) => l.bbox.x + l.bbox.w <= runStart / BINS).length;
      const rightLines = lines.filter((l) => l.bbox.x >= b / BINS).length;
      if (
        runStart > 0 &&
        leftLines >= total * 0.25 &&
        rightLines >= total * 0.25 &&
        runLength >= Math.max(2, Math.round((medianLineHeight * 0.75) * BINS)) &&
        (!best || runLength > best.runLength)
      ) {
        best = { bin: Math.round((runStart + b) / 2), runLength };
      }
      runStart = -1;
    }
  }
  if (!best) return null;
  return best.bin / BINS;
}

/** Group lines into rows and order each row left/right per direction. */
function rowOrder(lines: OcrObservation[], direction: TextDirection, medianLineHeight: number): OcrObservation[] {
  const sorted = [...lines].sort((a, b) => boxCenterY(a.bbox) - boxCenterY(b.bbox));
  const rows: OcrObservation[][] = [];
  for (const line of sorted) {
    const row = rows[rows.length - 1];
    if (row) {
      const rowMid = row.reduce((sum, l) => sum + boxCenterY(l.bbox), 0) / row.length;
      if (Math.abs(boxCenterY(line.bbox) - rowMid) <= medianLineHeight * 0.5) {
        row.push(line);
        continue;
      }
    }
    rows.push([line]);
  }
  for (const row of rows) {
    row.sort((a, b) => (direction === 'rtl' ? b.bbox.x - a.bbox.x : a.bbox.x - b.bbox.x));
  }
  return rows.flat();
}

/* ------------------------------------------------------------------ */
/* Block → PageBlock conversion                                        */
/* ------------------------------------------------------------------ */

export function detectDirection(text: string, fallback: TextDirection): TextDirection {
  const hasAr = hasArabicScript(text);
  const latin = /[A-Za-z\u00C0-\u024F]/.test(text);
  if (hasAr && !latin) return 'rtl';
  if (latin && !hasAr) return 'ltr';
  return fallback;
}

/** Estimate alignment from a block box relative to the body column. */
export function estimateAlign(
  box: NormBox,
  bodyBox: NormBox,
  direction: TextDirection,
): TextAlign {
  const leftGap = Math.abs(box.x - bodyBox.x);
  const rightGap = Math.abs(bodyBox.x + bodyBox.w - (box.x + box.w));
  const tolerance = Math.max(bodyBox.w * 0.06, 0.01);
  const nearlyFull = box.w > bodyBox.w * 0.88;

  if (nearlyFull) return 'justify';
  const centered = Math.abs(boxCenterX(box) - boxCenterX(bodyBox)) < tolerance && leftGap > tolerance && rightGap > tolerance;
  if (centered) return 'center';
  // "start" and "end" are direction-relative, so CSS handles the flip.
  if (leftGap + tolerance < rightGap) return direction === 'rtl' ? 'end' : 'start';
  if (rightGap + tolerance < leftGap) return direction === 'rtl' ? 'start' : 'end';
  return 'start';
}

/**
 * Line spacing as a CSS `line-height` multiplier, fitted to the *measured*
 * block height: N lines must occupy the box the original text occupied.
 *
 * This is more reliable than baseline deltas when lines were merged from
 * separate OCR rows (a heading that wrapped, or a paragraph split by a column
 * gap), because the box height is directly observed.
 */
export function fitLineHeight(blockHeight: number, lineCount: number, fontSizeNorm: number): number {
  if (lineCount < 2 || !(fontSizeNorm > 0) || !(blockHeight > 0)) return 1.4;
  const perLine = blockHeight / lineCount;
  const ratio = perLine / fontSizeNorm;
  return Math.min(2.6, Math.max(1.05, Number(ratio.toFixed(2))));
}

/**
 * Line spacing as a CSS `line-height` multiplier.
 *
 * Measured on the page, the baseline-to-baseline distance is what we can see;
 * CSS applies `line-height` to the em box. Comparing the measured advance with
 * the ink height (cap-height ≈ 0.72 em) gives the multiplier directly, so the
 * paragraph occupies the same vertical space as the original text.
 */
export function estimateLineHeight(lines: OcrObservation[], fontSizeNorm: number): number {
  if (lines.length < 2) return 1.5;
  const sorted = [...lines].sort((a, b) => a.bbox.y - b.bbox.y);
  const deltas: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i].bbox.y - sorted[i - 1].bbox.y;
    if (d > 0) deltas.push(d);
  }
  if (!deltas.length) return 1.5;
  deltas.sort((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)];
  const ratio = median / (fontSizeNorm || 0.02);
  return Math.min(2.4, Math.max(1.05, Number(ratio.toFixed(2))));
}

/* ------------------------------------------------------------------ */
/* Glyph width measurement                                            */
/* ------------------------------------------------------------------ */

/** Average advance width of one character, as a fraction of the em. */
const AVG_CHAR_WIDTH: Record<'arabic' | 'latin', number> = {
  arabic: 0.52,
  latin: 0.48,
};

export interface GlyphMetrics {
  /** Measured widths (normalised page width per character) for Latin text. */
  latin?: number;
  /** Measured widths (normalised page width per character) for Arabic text. */
  arabic?: number;
  /** Fallback idea of the page's aspect ratio. */
  aspectRatio?: number;
}

/** Remember a measured per-character width (median of a block, in page units). */
export function measureGlyphWidth(lines: OcrObservation[], script: 'arabic' | 'latin'): number | null {
  const samples: number[] = [];
  for (const line of lines) {
    const chars = line.text.replace(/\s+/g, '').length;
    if (chars < 8) continue; // too short to be a stable estimate
    const w = line.bbox.w / chars;
    if (w > 0.0005 && w < 0.06) samples.push(w);
  }
  if (!samples.length) return null;
  samples.sort((a, b) => a - b);
  void script;
  return samples[Math.floor(samples.length / 2)];
}

/**
 * Font size (in em) that makes the block's text occupy its measured width.
 *
 * Height-based sizing is unreliable across scripts and faces: Amiri's ink box is
 * much taller than its cap-height, Tesseract's line box for Arabic includes
 * ascenders and diacritics, and a paragraph's first line may have none of them.
 * Width is far more stable: we know how many characters the line holds and how
 * wide the line is, so `fontSize ≈ lineWidth / (chars × avgAdvance)` reproduces
 * the original fit. We then keep it within a sane band around the height-based
 * estimate to avoid absurd values on very short lines.
 */
export function fitFontSize(
  line: OcrObservation,
  script: 'arabic' | 'latin',
  aspectRatio: number,
): number {
  const chars = line.text.replace(/\s+/g, '').length;
  // Page-relative width → em-relative width requires the aspect ratio, because
  // `font-size` is expressed against the page height in our renderer.
  const widthEm = chars > 0 ? (line.bbox.w * aspectRatio) / chars : 0;
  const avg = AVG_CHAR_WIDTH[script];
  if (!(widthEm > 0) || chars < 4) return 0;
  return widthEm / avg;
}

/* ------------------------------------------------------------------ */
/* Main builder                                                        */
/* ------------------------------------------------------------------ */

/**
 * Build a complete PageModel from OCR observations.
 * Deterministic: same input → same output (ids derive from pageId + index).
 */
export function buildPageModel(lines: OcrObservation[], opts: BuildOptions): PageModel {
  const {
    pageId, sequence, pixelWidth, pixelHeight, paperColor, inkColor, languages,
    arabicFont = DEFAULT_ARABIC_FONT, latinFont = DEFAULT_LATIN_FONT,
    blockReviewThreshold = 70, illustrations = [], engine, engineVersion, profile,
  } = opts;

  const aspectRatio = pixelWidth > 0 && pixelHeight > 0 ? pixelWidth / pixelHeight : 0.72;

  // Filter out empty/insignificant lines (OCR returns junk boxes sometimes).
  const cleaned = lines
    .filter((l) => l.text.trim().length > 0 && l.bbox.w > 0.001 && l.bbox.h > 0.001)
    .map((l) => ({
      ...l,
      text: l.text.trim(),
      bbox: {
        x: clamp01(l.bbox.x),
        y: clamp01(l.bbox.y),
        w: clamp01(Math.min(l.bbox.w, 1 - l.bbox.x)),
        h: clamp01(Math.min(l.bbox.h, 1 - l.bbox.y)),
      },
    }));

  const heights = cleaned.map((l) => l.bbox.h).sort((a, b) => a - b);
  const medianHeight = heights.length ? heights[Math.floor(heights.length / 2)] : 0.02;

  // Page direction: majority vote over lines.
  const arCount = cleaned.filter((l) => hasArabicScript(l.text)).length;
  const direction: TextDirection = arCount > cleaned.length / 2 ? 'rtl' : cleanDirectionFallback(languages, direction0(cleaned));

  // Reading order & merging
  const merged = mergeLinesIntoBlocks(cleaned, direction, aspectRatio);

  // Body box = union of blocks in the middle band (excluding headers/footers).
  const coreBlocks = merged.filter((b) => boxCenterY(b.box) > 0.08 && boxCenterY(b.box) < 0.92);
  const bodyBox = coreBlocks.length
    ? coreBlocks.reduce((acc, b) => unionBox(acc, b.box), coreBlocks[0].box)
    : { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };

  const blocks: PageBlock[] = [];
  let order = 0;

  for (const [index, mb] of merged.entries()) {
    const text = mb.text.trim();
    if (!text) continue;
    // Font size: prefer the median line height of the block (more robust than
    // the union box for multi-line paragraphs).
    const blockLineHeights = mb.lines.map((l) => l.bbox.h).sort((a, b) => a - b);
    const representativeHeight = blockLineHeights[Math.floor(blockLineHeights.length / 2)];
    const type = classifyBlock(mb.box, text, medianHeight, bodyBox, representativeHeight);

    // Skip the union block that would duplicate illustrations.
    const overlapsArt = illustrations.some((ill) => boxesOverlap(ill.bbox, mb.box) && ill.confidence !== undefined && ill.confidence > 0.6);

    const script: 'arabic' | 'latin' = hasArabicScript(text) ? 'arabic' : 'latin';
    const blockDirection = detectDirection(text, direction);
    const lang = guessLanguage(text);
    const fontCategory = inferFontCategory(undefined, script);
    const fontFamily = script === 'arabic' ? arabicFont : latinFont;

    /**
     * Font size in em units (fraction of the page height, see PageBlock docs).
     *
     * Two independent estimates are combined: the ink height of a typical line
     * (cap-height ≈ 0.75 em) and, more importantly, the width the text must fill.
     * Width wins because a paragraph that overflows its column destroys the
     * replica, while a couple of pixels of size error is invisible.
     */
    const heightEstimate = representativeHeight / 0.75;
    const widestLines = [...mb.lines].sort((a, b) => b.bbox.w - a.bbox.w).slice(0, 3);
    const widthEstimates = widestLines
      .map((l) => fitFontSize(l, script, aspectRatio))
      .filter((v) => v > 0)
      .sort((a, b) => a - b);
    const widthEstimate = widthEstimates.length ? widthEstimates[Math.floor(widthEstimates.length / 2)] : 0;
    const fontSize = Math.max(
      0.008,
      Math.min(
        0.14,
        widthEstimate > 0
          ? Math.min(heightEstimate * 2.5, Math.max(heightEstimate * 0.4, widthEstimate))
          : heightEstimate,
      ),
    );

    const confidence = Math.round(mb.confidence);
    const lowWords = mb.lines.some((l) => (l.wordConfidences ?? []).some((c) => c < 55));

    const isHeading = type === 'heading';
    const weight: 400 | 600 | 700 = isHeading && fontSize > medianHeight * 1.6 ? 700 : isHeading ? 600 : 400;

    const bodyBlock: PageBlock = {
      id: `${pageId}-b${order}`,
      type,
      bbox: mb.box,
      order,
      direction: blockDirection,
      language: lang.language === 'und' ? (languages[0] ?? 'ar') : lang.language,
      fontFamily,
      fontCategory,
      fontSize: Number(fontSize.toFixed(4)),
      fontWeight: weight,
      italic: false,
      color: inkColor,
      align: type === 'heading'
        ? (Math.abs(boxCenterX(mb.box) - boxCenterX(bodyBox)) < bodyBox.w * 0.08 ? 'center' : estimateAlign(mb.box, bodyBox, blockDirection))
        : estimateAlign(mb.box, bodyBox, blockDirection),
      lineHeight: mb.lines.length > 1
        ? fitLineHeight(mb.box.h, mb.lines.length, fontSize)
        : 1.25,
      lines: [...mb.lines]
        .sort((a, b) => a.bbox.y - b.bbox.y || b.bbox.x - a.bbox.x)
        .map((l) => ({
          text: l.text,
          bbox: l.bbox,
          confidence: l.wordConfidences?.length ? Math.min(l.confidence, ...l.wordConfidences) : l.confidence,
        })),
      text,
      confidence,
      uncertain: confidence < blockReviewThreshold || lowWords || overlapsArt,
      edited: false,
    };
    blocks.push(bodyBlock);
    order++;
  }

  // Illustrations become image blocks so non-text content is preserved.
  for (const [i, ill] of illustrations.entries()) {
    if (!ill.imageUrl) continue;
    blocks.push({
      id: `${pageId}-art${i}`,
      type: 'illustration',
      bbox: ill.bbox,
      order: Math.max(0, illustrations.length ? 0 : order),
      direction,
      language: languages[0] ?? 'ar',
      fontFamily: latinFont,
      fontCategory: 'serif',
      fontSize: 0.02,
      fontWeight: 400,
      italic: false,
      color: inkColor,
      align: 'center',
      lineHeight: 1.2,
      text: '',
      confidence: Math.round((ill.confidence ?? 0.8) * 100),
      imageUrl: ill.imageUrl,
    });
  }

  // Re-assign reading order: blocks sorted by their geometric order then
  // illustrations inserted at their vertical position.
  blocks.sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
  blocks.forEach((b, i) => { b.order = i; });

  // Printed page number detection
  const pageNumberBlock = blocks.find((b) => b.type === 'pageNumber');
  const printedNumber = opts.printedNumber ?? pageNumberBlock?.text.trim();

  // Page-level warnings so review is honest about uncertainty.
  const warnings: string[] = [];
  if (!blocks.some((b) => b.type !== 'pageNumber' && b.type !== 'header' && b.type !== 'footer' && b.text.trim().length > 0)) {
    warnings.push('empty-recognition');
  }
  if (blocks.some((b) => b.uncertain)) warnings.push('low-confidence-blocks');
  const overlapping = findOverlaps(blocks);
  if (overlapping.length) warnings.push('overlapping-blocks');

  return {
    schemaVersion: 2,
    pageId,
    sequence,
    printedNumber,
    aspectRatio: Number(aspectRatio.toFixed(4)),
    paperColor,
    inkColor,
    direction,
    language: languages[0] ?? 'ar',
    orientation: 0,
    bodyFontSize: Number(medianHeight.toFixed(4)),
    blocks,
    provenance: {
      engine,
      engineVersion,
      languages,
      processedAt: opts.now ?? new Date().toISOString(),
      profile,
    },
    warnings,
  };
}

function direction0(lines: OcrObservation[]): TextDirection {
  const latin = lines.filter((l) => /[A-Za-z]/.test(l.text)).length;
  return latin > lines.length / 2 ? 'ltr' : 'rtl';
}

function cleanDirectionFallback(languages: string[], fallback: TextDirection): TextDirection {
  if (languages.some((l) => ['ar', 'fa', 'ur'].includes(l))) return 'rtl';
  return fallback;
}

/** Return id pairs of blocks whose boxes overlap noticeably. */
export function findOverlaps(blocks: PageBlock[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const textBlocks = blocks.filter((b) => b.type !== 'illustration');
  for (let i = 0; i < textBlocks.length; i++) {
    for (let j = i + 1; j < textBlocks.length; j++) {
      if (boxesOverlap(textBlocks[i].bbox, textBlocks[j].bbox)) {
        out.push([textBlocks[i].id, textBlocks[j].id]);
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Derived text + validation                                           */
/* ------------------------------------------------------------------ */

/** Plain display text in reading order (used for search + comfortable view). */
export function modelPlainText(model: PageModel): string {
  return [...model.blocks]
    .sort((a, b) => a.order - b.order)
    .filter((b) => b.type !== 'illustration')
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join('\n');
}

/** Average confidence of text blocks (0..100). Illustration blocks excluded. */
export function modelConfidence(model: PageModel): number {
  const textBlocks = model.blocks.filter((b) => b.type !== 'illustration' && b.text.trim());
  if (!textBlocks.length) return 0;
  return Math.round(textBlocks.reduce((s, b) => s + b.confidence, 0) / textBlocks.length);
}

export interface ValidationIssue {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

/** Structural validation — used by tests and by the review UI. */
export function validatePageModel(model: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const m = model as PageModel;
  if (!m || typeof m !== 'object') {
    return [{ path: '', message: 'model is not an object', severity: 'error' }];
  }
  if (m.schemaVersion !== 1 && m.schemaVersion !== 2) issues.push({ path: 'schemaVersion', message: 'unsupported schema version', severity: 'error' });
  if (!m.pageId) issues.push({ path: 'pageId', message: 'missing pageId', severity: 'error' });
  if (typeof m.sequence !== 'number' || m.sequence < 1) issues.push({ path: 'sequence', message: 'sequence must be >= 1', severity: 'error' });
  if (!(m.aspectRatio > 0.2 && m.aspectRatio < 5)) issues.push({ path: 'aspectRatio', message: 'implausible aspect ratio', severity: 'warning' });
  if (!/^#[0-9a-f]{6}$/i.test(m.paperColor ?? '')) issues.push({ path: 'paperColor', message: 'paperColor must be #rrggbb', severity: 'error' });
  if (!/^#[0-9a-f]{6}$/i.test(m.inkColor ?? '')) issues.push({ path: 'inkColor', message: 'inkColor must be #rrggbb', severity: 'error' });
  if (!Array.isArray(m.blocks)) {
    issues.push({ path: 'blocks', message: 'blocks must be an array', severity: 'error' });
    return issues;
  }
  m.blocks.forEach((b, i) => {
    const p = `blocks[${i}]`;
    if (!b.id) issues.push({ path: `${p}.id`, message: 'missing id', severity: 'error' });
    if (!(b.bbox && b.bbox.w > 0 && b.bbox.h > 0)) issues.push({ path: `${p}.bbox`, message: 'invalid bbox', severity: 'error' });
    if (b.bbox && (b.bbox.x < 0 || b.bbox.y < 0 || b.bbox.x + b.bbox.w > 1.001 || b.bbox.y + b.bbox.h > 1.001)) {
      issues.push({ path: `${p}.bbox`, message: 'bbox outside page', severity: 'warning' });
    }
    if (b.direction !== 'rtl' && b.direction !== 'ltr') issues.push({ path: `${p}.direction`, message: 'invalid direction', severity: 'error' });
    if (b.type !== 'illustration' && typeof b.text !== 'string') issues.push({ path: `${p}.text`, message: 'text must be a string', severity: 'error' });
    if (typeof b.confidence !== 'number' || b.confidence < 0 || b.confidence > 100) issues.push({ path: `${p}.confidence`, message: 'confidence out of range', severity: 'warning' });
  });
  const seen = new Set<string>();
  for (const b of m.blocks) {
    if (seen.has(b.id)) issues.push({ path: `blocks.${b.id}`, message: 'duplicate block id', severity: 'error' });
    seen.add(b.id);
  }
  return issues;
}
