/**
 * Page model: block merging, classification, style sampling and line placement.
 *
 * These tests encode the layout bugs found while building the reader, so they
 * cannot regress:
 *  - multi-line paragraphs must merge; a heading must not swallow the paragraph
 *  - a short line must not absorb the paragraph below it
 *  - font size is fitted to the measured line *width* (height alone inflates it)
 *  - every merged line keeps its own box so the replica never re-wraps text
 */
import { describe, expect, it } from 'vitest';
import {
  buildPageModel,
  classifyBlock,
  detectDirection,
  estimateAlign,
  fitFontSize,
  fitLineHeight,
  mergeLinesIntoBlocks,
  type BuildOptions,
} from '@/lib/pageModel';
import type { OcrObservation } from '@/lib/pageModel';

const PAPER = '#f4e9cb';
const INK = '#272522';

function line(text: string, y: number, opts: Partial<OcrObservation> = {}): OcrObservation {
  return {
    text,
    bbox: { x: 0.1, y, w: 0.8, h: 0.022 },
    confidence: 92,
    ...opts,
  };
}

function opts(overrides: Partial<BuildOptions> = {}): BuildOptions {
  return {
    pageId: 'pg_test',
    sequence: 1,
    pixelWidth: 1300,
    pixelHeight: 1900,
    paperColor: PAPER,
    inkColor: INK,
    languages: ['ara', 'eng'],
    blockReviewThreshold: 70,
    engine: 'tesseract',
    ...overrides,
  } as BuildOptions;
}

describe('detectDirection', () => {
  it('uses the text itself, not the page default', () => {
    expect(detectDirection('الفصل الأول في تاريخ العلم', 'ltr')).toBe('rtl');
    expect(detectDirection('Chapter One: On the History of Science', 'rtl')).toBe('ltr');
  });

  it('keeps a short Latin run LTR inside an Arabic page', () => {
    expect(detectDirection('p. 45', 'rtl')).toBe('ltr');
  });
});

describe('estimateAlign', () => {
  const body = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };

  it('marks a line pushed to the right edge as start in RTL', () => {
    expect(estimateAlign({ x: 0.55, y: 0.2, w: 0.35, h: 0.02 }, body, 'rtl')).toBe('start');
  });

  it('marks a line pushed to the left edge as start in LTR', () => {
    expect(estimateAlign({ x: 0.1, y: 0.2, w: 0.35, h: 0.02 }, body, 'ltr')).toBe('start');
  });
});

describe('classifyBlock', () => {
  it('calls a large line near the top a header, and one in the body a heading', () => {
    const body = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
    // Running head at the very top of the page.
    expect(classifyBlock({ x: 0.3, y: 0.04, w: 0.6, h: 0.05 }, 'الفصل الأول', 0.02, body, 0.05)).toBe('header');
    // Same size, but in the text block → a chapter heading.
    expect(classifyBlock({ x: 0.3, y: 0.3, w: 0.6, h: 0.05 }, 'الفصل الأول', 0.02, body, 0.05)).toBe('heading');
  });

  it('calls a wide multi-line body a paragraph', () => {
    const box = { x: 0.1, y: 0.3, w: 0.8, h: 0.2 };
    expect(classifyBlock(box, 'نص عادي طويل يمتد على عدة أسطر', 0.02, { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, 0.02)).toBe('paragraph');
  });

  it('calls a numeric short line at the bottom a page number', () => {
    const box = { x: 0.45, y: 0.95, w: 0.05, h: 0.02 };
    expect(classifyBlock(box, '12', 0.02, { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, 0.02)).toBe('pageNumber');
  });
});

describe('mergeLinesIntoBlocks', () => {
  it('merges consecutive body lines into one paragraph', () => {
    const lines = [line('السطر الأول من الفقرة', 0.3), line('والسطر الثاني يكملها', 0.33), line('وهذا سطر ثالث طويل أيضًا', 0.36)];
    const blocks = mergeLinesIntoBlocks(lines, 'rtl', 0.684);
    expect(blocks).toHaveLength(1);
    // Joined with spaces for the flowing text...
    expect(blocks[0].text).toBe('السطر الأول من الفقرة والسطر الثاني يكملها وهذا سطر ثالث طويل أيضًا');
    // ...but every source line is kept separately for exact placement.
    expect(blocks[0].lines).toHaveLength(3);
    expect(blocks[0].lines!.map((l) => l.bbox.y)).toEqual([0.3, 0.33, 0.36]);
  });

  it('never merges lines that are far apart vertically', () => {
    const lines = [line('سطر في الأعلى', 0.1), line('سطر بعيد جدًا في الأسفل', 0.7)];
    expect(mergeLinesIntoBlocks(lines, 'rtl', 0.684)).toHaveLength(2);
  });

  it('does not let a short line swallow the paragraph below it', () => {
    // A one-line heading followed immediately by a paragraph: same font size,
    // but the first line is short and the next is long — merging them produced a
    // heading that contained half the page.
    const lines = [
      line('العنوان:', 0.2, { bbox: { x: 0.62, y: 0.2, w: 0.28, h: 0.022 } }),
      line('وهذه فقرة كاملة تبدأ بعد العنوان وتستمر', 0.23, { bbox: { x: 0.1, y: 0.23, w: 0.8, h: 0.022 } }),
      line('ثم تكمل في سطر ثانٍ طويل أيضًا', 0.26, { bbox: { x: 0.1, y: 0.26, w: 0.78, h: 0.022 } }),
    ];
    const blocks = mergeLinesIntoBlocks(lines, 'rtl', 0.684);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toContain('العنوان');
    expect(blocks[0].text).not.toContain('فقرة');
  });
});

describe('fitFontSize / fitLineHeight', () => {
  it('fits text to the measured width rather than the ink height', () => {
    // 40 characters across 60 % of an 0.684-aspect page.
    const l: OcrObservation = {
      text: 'x'.repeat(40),
      bbox: { x: 0.1, y: 0.3, w: 0.6, h: 0.02 },
      confidence: 90,
    };
    const byWidth = fitFontSize(l, 'latin', 0.684);
    // ~0.6 * 0.684 / 40 / 0.48 ≈ 0.021
    expect(byWidth).toBeGreaterThan(0.015);
    expect(byWidth).toBeLessThan(0.03);
    // A naive "ink height is the em" estimate would be ≥ 0.02 here, which is
    // why the width fit exists at all.
    expect(fitFontSize(l, 'arabic', 0.684)).toBeGreaterThan(0);
  });

  it('returns 0 when there is nothing to measure', () => {
    expect(fitFontSize({ text: 'ab', bbox: { x: 0, y: 0, w: 0.1, h: 0.02 }, confidence: 90 }, 'latin', 0.684)).toBe(0);
  });

  it('fits line height so N lines fill the measured block height', () => {
    // 3 lines over 0.09 of a page with 0.02 font → 0.03 per line → 1.5
    expect(fitLineHeight(0.09, 3, 0.02)).toBeCloseTo(1.5, 1);
  });

  it('clamps line height to a sane range', () => {
    expect(fitLineHeight(0.9, 2, 0.01)).toBeLessThanOrEqual(2.6);
    expect(fitLineHeight(0.001, 5, 0.05)).toBeGreaterThanOrEqual(1.05);
  });
});

describe('buildPageModel', () => {
  const observations: OcrObservation[] = [
    line('الفصل الأول: في تاريخ العلم', 0.06, { bbox: { x: 0.52, y: 0.06, w: 0.38, h: 0.03 }, confidence: 91 }),
    line('بسم الله الرحمن الرحيم هذا كتاب في تاريخ العلم', 0.12, { bbox: { x: 0.4, y: 0.12, w: 0.5, h: 0.026 }, confidence: 91 }),
    line('وقد ذكر ابن خلدون في المقدمة أن العلم علمان', 0.16, { bbox: { x: 0.36, y: 0.16, w: 0.54, h: 0.026 }, confidence: 62 }),
  ];

  it('produces deterministic block ids', () => {
    const a = buildPageModel(observations, opts());
    const b = buildPageModel(observations, opts());
    expect(a.blocks.map((x) => x.id)).toEqual(b.blocks.map((x) => x.id));
  });

  it('keeps the sampled paper and ink colours', () => {
    const model = buildPageModel(observations, opts());
    expect(model.paperColor).toBe(PAPER);
    expect(model.blocks.every((b) => b.color === INK)).toBe(true);
  });

  it('marks low-confidence blocks for review', () => {
    const model = buildPageModel(observations, opts({ blockReviewThreshold: 80 }));
    const low = model.blocks.filter((b) => b.confidence < 80);
    expect(low.length).toBeGreaterThan(0);
    expect(low.every((b) => b.uncertain)).toBe(true);
  });

  it('assigns an Arabic font to Arabic blocks and a Latin font to Latin ones', () => {
    const model = buildPageModel(
      [...observations, line('Chapter One: On the History of Science', 0.5, { bbox: { x: 0.08, y: 0.5, w: 0.7, h: 0.03 } })],
      opts({ arabicFont: 'Amiri', latinFont: 'EB Garamond' }),
    );
    const arabic = model.blocks.filter((b) => /[\u0600-\u06FF]/.test(b.text));
    const latin = model.blocks.filter((b) => !/[\u0600-\u06FF]/.test(b.text));
    expect(arabic.length).toBeGreaterThan(0);
    expect(latin.length).toBeGreaterThan(0);
    expect(arabic.every((b) => b.fontFamily.includes('Amiri'))).toBe(true);
    expect(latin.every((b) => b.fontFamily.includes('EB Garamond'))).toBe(true);
  });

  it('records per-line boxes so the replica can place each line exactly', () => {
    const model = buildPageModel(observations, opts());
    const multi = model.blocks.find((b) => (b.lines?.length ?? 0) > 1);
    expect(multi).toBeDefined();
    for (const l of multi!.lines!) {
      expect(l.bbox.w).toBeGreaterThan(0);
      expect(l.bbox.h).toBeGreaterThan(0);
      expect(l.text.length).toBeGreaterThan(0);
    }
  });

  it('infers RTL and a printed page number', () => {
    const model = buildPageModel(
      [...observations, line('12', 0.96, { bbox: { x: 0.47, y: 0.96, w: 0.05, h: 0.02 } })],
      opts(),
    );
    expect(model.direction).toBe('rtl');
    expect(model.printedNumber).toBe('12');
  });

  it('never emits an empty page model for real text', () => {
    const model = buildPageModel(observations, opts());
    expect(model.blocks.length).toBeGreaterThan(0);
    expect(model.blocks.every((b) => b.text.trim().length > 0)).toBe(true);
  });

  it('is JSON-serialisable (it lives in IndexedDB)', () => {
    const model = buildPageModel(observations, opts());
    const round = JSON.parse(JSON.stringify(model));
    expect(round.blocks.length).toBe(model.blocks.length);
    expect(round.blocks[0].bbox).toEqual(model.blocks[0].bbox);
  });
});
