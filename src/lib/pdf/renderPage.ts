/**
 * CamScan — PDF page renderer (real, searchable, shaped text).
 *
 * Chosen after an actual proof-of-concept run (see README "PDF export proof"):
 *
 *   pdf-lib      → Arabic shaping ok but glyph *positioning* is lost
 *                  (mark attachment, advances) → rejected
 *   pdfkit 0.20  → uses fontkit's HarfBuzz layout: correct shaping, correct
 *                  advances, correct tashkeel placement, real text layer that
 *                  `pdftotext` extracts and searches → **chosen**
 *
 * The renderer draws **vector text**, not screenshots, from the stored
 * `PageModel`. Layout uses the normalised block boxes scaled to the PDF page,
 * so the output keeps the measured page proportions and layout.
 */
import bidiFactory from 'bidi-js';
import type { PageBlock, PageModel } from '../types';

export interface PdfFontSet {
  /** Register a font file path/id → pdfkit font name; returns the name to use. */
  register: (familyId: string, weight: 400 | 700, italic: boolean) => string | null;
  /** Fallback family for Arabic and Latin when a block's family is missing. */
  arabicFallback: string;
  latinFallback: string;
}

import type PDFDocument from 'pdfkit';

export interface DrawContext {
  doc: PDFDocument;
  fonts: PdfFontSet;
  /** Page width in PDF points. */
  pageWidth: number;
  /** Page height in PDF points. */
  pageHeight: number;
}

const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

export function hasArabic(text: string): boolean {
  return ARABIC_RE.test(text);
}

/** Map a CSS font stack like "'Amiri', serif" to the bundled family id. */
export function familyIdFromCss(css: string): string | null {
  const first = css.split(',')[0]?.trim().replace(/^['"]|['"]$/g, '');
  if (!first) return null;
  const map: Record<string, string> = {
    'Amiri': 'Amiri',
    'Scheherazade New': 'ScheherazadeNew',
    'Noto Naskh Arabic': 'NotoNaskhArabic',
    'Noto Kufi Arabic': 'NotoKufiArabic',
    'Cairo': 'Cairo',
    'EB Garamond': 'EBGaramond',
    'Merriweather': 'Merriweather',
    'Inter': 'Inter',
    'JetBrains Mono': 'JetBrainsMono',
  };
  return map[first] ?? null;
}

/* ------------------------------------------------------------------ */
/* Bidi-aware line drawing                                             */
/* ------------------------------------------------------------------ */

const bidi = bidiFactory();

interface VisualRun {
  text: string;
  rtl: boolean;
}

/**
 * Split a logical paragraph into visual-order runs.
 *
 * fontkit (inside pdfkit) already returns glyphs in *visual* order for RTL
 * runs, so we must NOT reverse characters — we only need to reverse the
 * *order of runs* per the Unicode Bidirectional Algorithm (UAX #9, rule L2).
 */
export function visualRuns(text: string, baseDirection: 'rtl' | 'ltr'): VisualRun[] {
  const chars = Array.from(text);
  const { levels } = bidi.getEmbeddingLevels(text, baseDirection);
  const runs: VisualRun[] = [];
  for (let i = 0; i < chars.length; i++) {
    const rtl = (levels[i] & 1) === 1;
    const last = runs[runs.length - 1];
    if (last && last.rtl === rtl) last.text += chars[i];
    else runs.push({ text: chars[i], rtl });
  }
  // UAX#9 L2: reverse contiguous sequences from the highest level down to the
  // lowest odd level.
  let maxLevel = 0;
  let lowestOdd = Infinity;
  for (const level of levels) {
    if (level > maxLevel) maxLevel = level;
    if (level & 1 && level < lowestOdd) lowestOdd = level;
  }
  for (let l = maxLevel; l >= lowestOdd && lowestOdd !== Infinity; l--) {
    let i = 0;
    while (i < runs.length) {
      const isRtlAtLevel = (levels[charIndexForRun(runs, i)] ?? 0) >= l;
      if (isRtlAtLevel) {
        let j = i;
        while (j < runs.length && (levels[charIndexForRun(runs, j)] ?? 0) >= l) j++;
        for (let a = i, b = j - 1; a < b; a++, b--) {
          const t = runs[a];
          runs[a] = runs[b];
          runs[b] = t;
        }
        i = j;
      } else i++;
    }
  }
  return runs;
}

/** Index of the first character of the i-th run. */
function charIndexForRun(runs: VisualRun[], runIndex: number): number {
  let n = 0;
  for (let i = 0; i < runIndex; i++) n += Array.from(runs[i].text).length;
  return n;
}

/**
 * Width of a string in the given font/size, computed by fontkit inside pdfkit.
 * pdfkit exposes `doc.widthOfString` for the *current* font, so we switch font
 * around the measurement (cheap, no layout side effects).
 */
function measure(doc: PDFDocument, text: string, fontName: string, size: number): number {
  doc.font(fontName).fontSize(size);
  return doc.widthOfString(text, { lineBreak: false } as never);
}

/**
 * Draw one logical line of text, preserving mixed Arabic/Latin order.
 * `x` is the anchor: for RTL base direction the line is right-aligned to x,
 * for LTR it is left-aligned. Returns the drawn width.
 */
export function drawBidiLine(
  ctx: DrawContext,
  text: string,
  x: number,
  y: number,
  size: number,
  color: string,
  baseDirection: 'rtl' | 'ltr',
  fontName: string,
  latinFontName: string,
): number {
  const runs = visualRuns(text, baseDirection);
  if (!runs.length) return 0;

  const measured = runs.map((r) => ({
    ...r,
    width: measure(ctx.doc, r.text, r.rtl ? fontName : latinFontName, size),
    font: r.rtl ? fontName : latinFontName,
  }));
  const total = measured.reduce((s, r) => s + r.width, 0);

  let cursor = baseDirection === 'rtl' ? x - total : x;
  for (const run of measured) {
    ctx.doc
      .font(run.font)
      .fontSize(size)
      .fillColor(color)
      .text(run.text, cursor, y, {
        lineBreak: false,
        continued: false,
        baseline: 'top',
        // Explicit direction stops pdfkit from applying its own bidi pass.
        features: run.rtl ? ['kern', 'liga', 'rlig', 'calt', 'mark', 'mkmk', 'ccmp', 'init', 'medi', 'fina', 'isol'] : ['kern', 'liga'],
      });
    cursor += run.width;
  }
  return total;
}

/* ------------------------------------------------------------------ */
/* Word wrapping in logical order                                      */
/* ------------------------------------------------------------------ */

/**
 * Wrap a paragraph to `maxWidth` points.
 * Wrapping happens in *logical* order (word by word), then each resulting line
 * is drawn through the bidi run splitter — this keeps shaping intact and gives
 * correct mixed-direction behaviour.
 */
export function wrapText(
  ctx: DrawContext,
  text: string,
  maxWidth: number,
  size: number,
  arabicFont: string,
  latinFont: string,
): string[] {
  const paragraphs = text.split(/\n/);
  const out: string[] = [];
  for (const para of paragraphs) {
    const words = para.split(/(\s+)/).filter((w) => w.length > 0);
    let line = '';
    for (const word of words) {
      const candidate = line + word;
      const width = measureBidiWidth(ctx, candidate.trim(), size, arabicFont, latinFont);
      if (width > maxWidth && line.trim()) {
        out.push(line.trim());
        line = /^\s+$/.test(word) ? '' : word;
      } else {
        line = candidate;
      }
    }
    if (line.trim()) out.push(line.trim());
  }
  return out.length ? out : [''];
}

function measureBidiWidth(ctx: DrawContext, text: string, size: number, arabicFont: string, latinFont: string): number {
  const runs = visualRuns(text, hasArabic(text) ? 'rtl' : 'ltr');
  let total = 0;
  for (const run of runs) {
    total += measure(ctx.doc, run.text, run.rtl ? arabicFont : latinFont, size);
  }
  return total;
}

/* ------------------------------------------------------------------ */
/* Block drawing                                                       */
/* ------------------------------------------------------------------ */

export interface DrawBlockOptions {
  /** When true, blocks are laid out in reading order and flowed (comfortable PDF). */
  flow?: boolean;
  /** Y cursor for flow mode. */
  cursorY?: number;
  /** Left/right margin for flow mode. */
  margin?: number;
}

/**
 * Draw a single block at its stored geometry (replica mode).
 * Illustrations are drawn as embedded images; everything else is real text.
 */
export function drawBlock(
  ctx: DrawContext,
  block: PageBlock,
  model: PageModel,
  images: Map<string, Uint8Array>,
): void {
  const { doc, pageWidth, pageHeight } = ctx;
  const x = block.bbox.x * pageWidth;
  const y = block.bbox.y * pageHeight;
  const w = block.bbox.w * pageWidth;
  const h = block.bbox.h * pageHeight;

  if (block.type === 'illustration') {
    const data = block.imageUrl ? images.get(block.imageUrl) : undefined;
    if (data) {
      try {
        doc.image(Buffer.from(data), x, y, { fit: [w, h], align: 'center', valign: 'center' });
      } catch {
        // A corrupt/unsupported illustration must not abort the export.
        doc.rect(x, y, w, h).strokeColor('#b9a98a').lineWidth(0.4).stroke();
      }
    }
    return;
  }

  const text = block.text?.trim();
  if (!text) return;

  // Font selection: bundled family for the block, with script-correct fallback.
  const familyId = familyIdFromCss(block.fontFamily);
  const scriptIsArabic = hasArabic(text);
  const requested = familyId
    ? ctx.fonts.register(familyId, block.fontWeight === 700 ? 700 : 400, block.italic)
    : null;
  const arabicFont = scriptIsArabic
    ? (requested ?? ctx.fonts.arabicFallback)
    : ctx.fonts.arabicFallback;
  const latinFont = !scriptIsArabic && requested ? requested : ctx.fonts.latinFallback;

  const size = Math.max(4, block.fontSize * pageHeight);
  const lineHeight = size * (block.lineHeight || 1.5);
  const direction = block.direction ?? model.direction;

  doc.save();
  // Clip to the block box so a slightly-too-large estimate never bleeds into a
  // neighbouring block.
  doc.rect(x - 2, y - 2, w + 4, h + size * 0.6).clip();

  const lines = wrapText(ctx, text, Math.max(12, w), size, arabicFont, latinFont);
  const align = block.align;
  const anchorX = align === 'center'
    ? x + w / 2
    : align === 'end'
      ? (direction === 'rtl' ? x : x + w)
      : align === 'start'
        ? (direction === 'rtl' ? x + w : x)
        : (direction === 'rtl' ? x + w : x); // justify → fall back to start edge

  let lineY = y;
  for (const line of lines) {
    if (lineY > y + h + size * 0.8) break; // never overflow the block
    if (align === 'center') {
      const width = measureBidiWidth(ctx, line, size, arabicFont, latinFont);
      drawBidiLine(ctx, line, anchorX + width / 2, lineY, size, block.color, direction, arabicFont, latinFont);
    } else {
      drawBidiLine(ctx, line, anchorX, lineY, size, block.color, direction, arabicFont, latinFont);
    }
    lineY += lineHeight;
  }
  doc.restore();
}

/** Draw the whole page background + blocks. */
export function drawPage(
  ctx: DrawContext,
  model: PageModel,
  images: Map<string, Uint8Array>,
  options: { includeOriginal?: Uint8Array } = {},
): void {
  const { doc, pageWidth, pageHeight } = ctx;

  // Paper colour sampled from the photograph — the replica keeps the original warmth.
  doc.rect(0, 0, pageWidth, pageHeight).fill(model.paperColor || '#fbf7ee');

  if (options.includeOriginal) {
    try {
      doc.image(Buffer.from(options.includeOriginal), 0, 0, { width: pageWidth, height: pageHeight });
    } catch {
      /* ignore invalid JPEG */
    }
  }

  const ordered = [...model.blocks].sort((a, b) => a.order - b.order);
  for (const block of ordered) drawBlock(ctx, block, model, images);
}
