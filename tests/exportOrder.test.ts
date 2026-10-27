/**
 * Export ordering + the bidi/shaping layer used by the PDF writer.
 *
 * The PDF itself is verified end-to-end in `e2e/acceptance.mjs` (which runs the
 * real exporter in a browser and asserts with `pdftotext` that Arabic comes back
 * as selectable, correctly ordered text). These unit tests cover the pieces that
 * can be checked without a browser: page ordering, the reading-order walk, and
 * the bidi run splitting that decides what order glyphs are *drawn* in.
 */
import { describe, expect, it } from 'vitest';
import { sortByOrder } from '@/lib/ordering';
import { readingOrder, findColumnGutter } from '@/lib/pageModel';
import { visualRuns } from '@/lib/pdf/renderPage';
import type { PageModel } from '@/lib/types';

function model(blocks: Array<{ id: string; order: number; y: number; x: number; text: string }>): PageModel {
  return {
    pageId: 'p',
    sequence: 1,
    width: 1300,
    height: 1900,
    aspectRatio: 1300 / 1900,
    direction: 'rtl',
    language: 'ar',
    paperColor: '#f4e9cb',
    inkColor: '#272522',
    blocks: blocks.map((b) => ({
      id: b.id,
      type: 'paragraph' as const,
      bbox: { x: b.x, y: b.y, w: 0.4, h: 0.03 },
      order: b.order,
      direction: 'rtl' as const,
      language: 'ar',
      fontFamily: 'Amiri, serif',
      fontCategory: 'naskh' as const,
      fontSize: 0.02,
      fontWeight: 400 as const,
      italic: false,
      color: '#272522',
      align: 'start' as const,
      lineHeight: 1.5,
      text: b.text,
      confidence: 90,
    })),
    engine: 'tesseract',
    version: 1,
    direction_: undefined,
  } as unknown as PageModel;
}

describe('export page order', () => {
  it('exports pages in capture order, not completion order', () => {
    const rows = [
      { id: 'p3', order: 2, status: 'done' },
      { id: 'p1', order: 0, status: 'review' },
      { id: 'p2', order: 1, status: 'done' },
    ];
    expect(sortByOrder(rows).map((r) => r.id)).toEqual(['p1', 'p2', 'p3']);
  });

  it('honours a user reorder before export', () => {
    // The user moved the (originally first) page to the end.
    const rows = [
      { id: 'a', order: 0 },
      { id: 'b', order: 1 },
      { id: 'c', order: 2 },
    ].map((r) => (r.id === 'a' ? { ...r, order: 3 } : r));
    expect(sortByOrder(rows).map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('is stable for a page range export (slice after sorting)', () => {
    const rows = [
      { id: 'p4', order: 3 },
      { id: 'p2', order: 1 },
      { id: 'p3', order: 2 },
      { id: 'p1', order: 0 },
    ];
    const sorted = sortByOrder(rows);
    expect(sorted.slice(1, 3).map((r) => r.id)).toEqual(['p2', 'p3']);
  });
});

describe('reading order inside a page', () => {
  it('walks top-to-bottom for a single column', () => {
    const b = [
      { id: 'c', order: 2, y: 0.3, x: 0.1, text: 'الثالث' },
      { id: 'a', order: 0, y: 0.1, x: 0.1, text: 'الأول' },
      { id: 'b', order: 1, y: 0.2, x: 0.1, text: 'الثاني' },
    ];
    const ordered = readingOrder(
      b.map((x) => ({ bbox: { x: x.x, y: x.y, w: 0.4, h: 0.03 }, text: x.text, confidence: 90 })),
      'rtl',
    );
    expect(ordered.map((x) => x.text)).toEqual(['الأول', 'الثاني', 'الثالث']);
  });

  it('reads right-to-left across two columns on an RTL page', () => {
    // Right column (x≈0.55) must come before the left column (x≈0.08).
    const lines = [
      { bbox: { x: 0.08, y: 0.10, w: 0.34, h: 0.03 }, text: 'left-1' },
      { bbox: { x: 0.55, y: 0.10, w: 0.34, h: 0.03 }, text: 'right-1' },
      { bbox: { x: 0.08, y: 0.20, w: 0.34, h: 0.03 }, text: 'left-2' },
      { bbox: { x: 0.55, y: 0.20, w: 0.34, h: 0.03 }, text: 'right-2' },
    ].map((l) => ({ ...l, confidence: 90 }));
    const order = readingOrder(lines, 'rtl').map((l) => l.text);
    expect(order.indexOf('right-1')).toBeLessThan(order.indexOf('right-2'));
    expect(order.indexOf('right-2')).toBeLessThan(order.indexOf('left-1'));
  });
});

describe('column gutter detection', () => {
  const col = (x: number, y: number) => ({
    bbox: { x, y, w: 0.34, h: 0.03 },
    text: `x${x}y${y}`,
    confidence: 90,
  });

  it('finds the gutter of a genuine two-column page', () => {
    const lines = [
      col(0.08, 0.10), col(0.08, 0.15), col(0.08, 0.20), col(0.08, 0.25), col(0.08, 0.30),
      col(0.55, 0.10), col(0.55, 0.15), col(0.55, 0.20), col(0.55, 0.25), col(0.55, 0.30),
    ];
    const g = findColumnGutter(lines, 0.03);
    expect(g).not.toBeNull();
    expect(g!).toBeGreaterThan(0.42);
    expect(g!).toBeLessThan(0.55);
  });

  it('returns null for a single-column page', () => {
    const lines = Array.from({ length: 10 }, (_, i) => col(0.1, 0.1 + i * 0.05));
    expect(findColumnGutter(lines, 0.03)).toBeNull();
  });

  it('returns null when one side holds almost nothing (a wide first line)', () => {
    const lines = [
      { bbox: { x: 0.05, y: 0.05, w: 0.9, h: 0.04 }, text: 'wide heading', confidence: 90 },
      ...Array.from({ length: 8 }, (_, i) => col(0.1, 0.15 + i * 0.05)),
    ];
    // The full-width heading bridges the page, so there is no clean gutter.
    expect(findColumnGutter(lines, 0.03)).toBeNull();
  });
});

describe('comfortable (flowing) export order', () => {
  it('emits blocks in reading order, not in raw OCR order', () => {
    const lines = [
      { bbox: { x: 0.1, y: 0.30, w: 0.8, h: 0.03 }, text: 'الثالث', confidence: 90 },
      { bbox: { x: 0.1, y: 0.10, w: 0.8, h: 0.03 }, text: 'الأول', confidence: 90 },
      { bbox: { x: 0.1, y: 0.20, w: 0.8, h: 0.03 }, text: 'الثاني', confidence: 90 },
    ];
    expect(readingOrder(lines, 'rtl').map((l) => l.text)).toEqual(['الأول', 'الثاني', 'الثالث']);
  });
});

describe('bidi visual runs (what the PDF draws)', () => {
  it('keeps pure Arabic as a single RTL run', () => {
    const runs = visualRuns('تاريخ العلم', 'rtl');
    expect(runs).toHaveLength(1);
    expect(runs[0].rtl).toBe(true);
    expect(runs[0].text).toBe('تاريخ العلم');
  });

  it('keeps pure Latin as a single LTR run', () => {
    const runs = visualRuns('Chapter One', 'ltr');
    expect(runs).toHaveLength(1);
    expect(runs[0].rtl).toBe(false);
  });

  it('splits a mixed line into runs, keeping every character', () => {
    const text = 'صفحة 12 من Chapter One';
    const runs = visualRuns(text, 'rtl');
    expect(runs.length).toBeGreaterThan(1);
    // Nothing may be lost or invented: the multiset of characters is identical.
    const chars = (xs: string) => [...xs].sort().join('');
    expect(chars(runs.map((r) => r.text).join(''))).toBe(chars(text));
    // Both directions must be present.
    expect(runs.some((r) => r.rtl)).toBe(true);
    expect(runs.some((r) => !r.rtl)).toBe(true);
  });

  it('never rewrites Arabic characters (shaping happens in the font engine)', () => {
    const text = 'بسم الله';
    const runs = visualRuns(text, 'rtl');
    expect(runs.map((r) => r.text).join('')).toBe(text);
  });

  it('preserves tashkeel through run splitting', () => {
    const text = 'مُحَمَّدٌ رَسُولُ اللَّهِ';
    expect(visualRuns(text, 'rtl').map((r) => r.text).join('')).toBe(text);
  });
});
