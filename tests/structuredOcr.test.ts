import { describe, expect, it } from 'vitest';
import { toStructuredOcrJson } from '@/lib/ocr/structuredOutput';
import type { PageModel } from '@/lib/types';

function model(overrides: Partial<PageModel> = {}): PageModel {
  return {
    schemaVersion: 2,
    pageId: 'page-1',
    sequence: 1,
    aspectRatio: 0.72,
    paperColor: '#f4e9cb',
    inkColor: '#272522',
    direction: 'ltr',
    language: 'en',
    orientation: 0,
    bodyFontSize: 0.02,
    blocks: [{
      id: 'page-1-b0',
      type: 'paragraph',
      bbox: { x: 0.1, y: 0.2, w: 0.8, h: 0.06 },
      order: 0,
      direction: 'ltr',
      language: 'en',
      fontFamily: "'EB Garamond', serif",
      fontCategory: 'serif',
      fontSize: 0.02,
      fontWeight: 400,
      italic: false,
      color: '#272522',
      align: 'start',
      lineHeight: 1.25,
      text: 'inter-\nnational',
      confidence: 95,
      lines: [
        { text: 'inter-', bbox: { x: 0.1, y: 0.2, w: 0.2, h: 0.02 }, confidence: 95 },
        { text: 'national', bbox: { x: 0.1, y: 0.24, w: 0.3, h: 0.02 }, confidence: 92 },
      ],
    }],
    provenance: {
      engine: 'tesseract',
      languages: ['eng'],
      processedAt: '2026-01-01T00:00:00.000Z',
    },
    ...overrides,
  };
}

describe('structured OCR JSON', () => {
  it('keeps physical line breaks, hyphens, normalized boxes and per-line confidence', () => {
    const result = toStructuredOcrJson(model());
    expect(result.full_text).toBe('inter-\nnational');
    expect(result.blocks[0].lines.map((line) => line.text)).toEqual(['inter-', 'national']);
    expect(result.blocks[0].lines.map((line) => line.confidence)).toEqual(['high', 'high']);
    expect(result.blocks[0].bbox).toEqual([0.1, 0.2, 0.8, 0.06]);
    expect(result.page.needs_review).toBe(false);
  });

  it('marks uncertain text for review rather than inventing a correction', () => {
    const source = model({
      blocks: [{
        ...model().blocks[0],
        text: 'word [?]',
        confidence: 42,
        lines: [{ text: 'word [?]', bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.02 }, confidence: 42 }],
      }],
    });
    const result = toStructuredOcrJson(source);
    expect(result.blocks[0].lines[0]).toMatchObject({ text: 'word [?]', confidence: 'low' });
    expect(result.page.needs_review).toBe(true);
    expect(result.full_text).toBe('word [?]');
  });

  it('adds spans only when a line mixes Arabic and Latin scripts', () => {
    const base = model();
    const source = model({
      direction: 'rtl',
      language: 'ar',
      provenance: { ...base.provenance, languages: ['ara', 'eng'] },
      blocks: [{
        ...base.blocks[0],
        language: 'ar',
        direction: 'rtl',
        text: 'القانون Article 12',
        lines: [{ text: 'القانون Article 12', bbox: base.blocks[0].bbox, confidence: 93 }],
      }],
    });
    const line = toStructuredOcrJson(source).blocks[0].lines[0];
    expect(line.spans?.map((span) => span.lang)).toContain('ar');
    expect(line.spans?.map((span) => span.lang)).toContain('en');
    expect(line.spans?.map((span) => span.text).join('')).toBe(line.text);
  });
});
