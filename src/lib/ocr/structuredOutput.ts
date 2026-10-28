/**
 * Convert CamScan's persisted page model into the strict, portable OCR JSON
 * contract used by external tools. This is a serialization layer only: it
 * never rewrites recognised characters or invents text for missing regions.
 */
import type { PageBlock, PageModel, TextDirection } from '../types';

export type OcrConfidence = 'high' | 'medium' | 'low';
export type StructuredBlockType =
  | 'title' | 'heading' | 'paragraph' | 'list' | 'table' | 'header' | 'footer'
  | 'caption' | 'footnote' | 'stamp' | 'signature' | 'image' | 'other';

export interface StructuredOcrDocument {
  page: {
    dominant_direction: 'rtl' | 'ltr';
    languages: string[];
    rotation_applied: 0 | 90 | 180 | 270;
    needs_review: boolean;
  };
  blocks: Array<{
    id: number;
    type: StructuredBlockType;
    bbox: [number, number, number, number];
    lang: string;
    dir: 'rtl' | 'ltr';
    align: 'right' | 'left' | 'center' | 'justify';
    font: {
      size: 'small' | 'normal' | 'large' | 'xlarge';
      bold: boolean;
      italic: boolean;
      underline: boolean;
      color: string;
      family: 'serif' | 'sans' | 'mono' | 'handwriting' | 'naskh' | 'kufi' | 'unknown';
    };
    handwritten: boolean;
    lines: Array<{
      text: string;
      indent: number;
      confidence: OcrConfidence;
      spans?: Array<{ text: string; lang: string; dir: 'rtl' | 'ltr'; bold: boolean }>;
    }>;
    table: null | { rows: Array<Array<{ text: string; colspan: number; rowspan: number; bold: boolean }>> };
  }>;
  full_text: string;
}

const LANGUAGE_CODES: Record<string, string> = {
  ara: 'ar', arabic: 'ar', ar: 'ar',
  eng: 'en', english: 'en', en: 'en',
  fra: 'fr', fre: 'fr', french: 'fr', fr: 'fr',
  deu: 'de', ger: 'de', german: 'de', de: 'de',
  fas: 'fa', per: 'fa', persian: 'fa', fa: 'fa',
  urd: 'ur', urdu: 'ur', ur: 'ur',
  tur: 'tr', turkish: 'tr', tr: 'tr',
  heb: 'he', hebrew: 'he', he: 'he',
  rus: 'ru', russian: 'ru', ru: 'ru',
  chi: 'zh', zho: 'zh', chinese: 'zh', zh: 'zh',
  spa: 'es', spanish: 'es', es: 'es',
  ita: 'it', italian: 'it', it: 'it',
};

const RTL_LANGUAGES = new Set(['ar', 'fa', 'ur', 'he']);

function languageCode(raw: string | undefined, fallback = 'und'): string {
  const key = (raw ?? '').trim().toLowerCase();
  if (!key) return fallback;
  const parts = key.split(/[+,;]/).map((part) => part.trim()).filter(Boolean);
  const code = LANGUAGE_CODES[parts[0]] ?? parts[0];
  return code === 'und' ? fallback : code;
}

function confidenceLabel(text: string, score: number | undefined): OcrConfidence {
  if (text.includes('[?]') || typeof score !== 'number' || score < 70) return 'low';
  if (score < 90) return 'medium';
  return 'high';
}

function fontSizeCategory(size: number): 'small' | 'normal' | 'large' | 'xlarge' {
  if (size < 0.016) return 'small';
  if (size < 0.03) return 'normal';
  if (size < 0.055) return 'large';
  return 'xlarge';
}

function fontFamilyCategory(block: PageBlock): StructuredOcrDocument['blocks'][number]['font']['family'] {
  if (['serif', 'sans', 'mono', 'naskh', 'kufi'].includes(block.fontCategory)) {
    return block.fontCategory as StructuredOcrDocument['blocks'][number]['font']['family'];
  }
  // Ruqaa/thuluth are not the same as handwriting; the app cannot identify an
  // exact typeface, so unknown is more honest than a fabricated classification.
  return 'unknown';
}

function exportedType(block: PageBlock, size: StructuredOcrDocument['blocks'][number]['font']['size']): StructuredBlockType {
  if (block.type === 'illustration') return 'image';
  if (block.type === 'pageNumber' || block.type === 'footer') return 'footer';
  if (block.type === 'header') return 'header';
  if (block.type === 'caption') return 'caption';
  if (block.type === 'footnote') return 'footnote';
  if (block.type === 'table') return 'table';
  if (block.type === 'heading') return size === 'xlarge' ? 'title' : 'heading';
  if (/^\s*(?:[•◦▪‣⁃]|[-–—]|\d+[.)]|[٠-٩]+[.)]|[۰-۹]+[.)])\s/u.test(block.text)) return 'list';
  if (block.type === 'paragraph') return 'paragraph';
  return 'other';
}

function exportAlignment(block: PageBlock): 'right' | 'left' | 'center' | 'justify' {
  if (block.align === 'center') return 'center';
  if (block.align === 'justify') return 'justify';
  if (block.align === 'start') return block.direction === 'rtl' ? 'right' : 'left';
  return block.direction === 'rtl' ? 'left' : 'right';
}

function blockLines(block: PageBlock): Array<{ text: string; confidence: number; bbox: PageBlock['bbox'] }> {
  // Manual edits supersede OCR line fragments. Do not export stale OCR text
  // alongside the user's latest text.
  if (block.edited) {
    return block.text.split(/\r?\n/).map((text) => ({
      text,
      confidence: block.confidence,
      bbox: block.bbox,
    }));
  }
  if (block.lines?.length) {
    return block.lines.map((line) => ({
      text: line.text,
      confidence: line.confidence ?? block.confidence,
      bbox: line.bbox,
    }));
  }
  return block.text.split(/\r?\n/).map((text) => ({
    text,
    confidence: block.confidence,
    bbox: block.bbox,
  }));
}

function scriptLanguage(char: string, blockLanguage: string): string | null {
  if (/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/u.test(char)) {
    if (['fa', 'ur'].includes(blockLanguage)) return blockLanguage;
    return 'ar';
  }
  if (/[A-Za-z\u00C0-\u024F]/u.test(char)) {
    return ['fr', 'de', 'tr', 'it', 'es', 'en'].includes(blockLanguage) ? blockLanguage : 'en';
  }
  if (/[\u0590-\u05FF]/u.test(char)) return 'he';
  if (/[\u0400-\u052F]/u.test(char)) return 'ru';
  if (/[\u4E00-\u9FFF]/u.test(char)) return 'zh';
  if (/[\u0370-\u03FF]/u.test(char)) return 'el';
  return null;
}

function mixedScriptSpans(
  text: string,
  blockLanguage: string,
  bold: boolean,
): Array<{ text: string; lang: string; dir: 'rtl' | 'ltr'; bold: boolean }> | undefined {
  const chars = Array.from(text);
  const kinds = chars.map((char) => scriptLanguage(char, blockLanguage));
  // Attach punctuation/spacing to a neighboring script without dropping or
  // changing any character in the original line.
  for (let i = 0; i < kinds.length; i++) {
    if (kinds[i]) continue;
    let next: string | null = null;
    for (let j = i + 1; j < kinds.length; j++) {
      if (kinds[j]) { next = kinds[j]; break; }
    }
    let previous: string | null = null;
    for (let j = i - 1; j >= 0; j--) {
      if (kinds[j]) { previous = kinds[j]; break; }
    }
    kinds[i] = previous ?? next ?? languageCode(blockLanguage, 'en');
  }

  const unique = new Set(kinds.filter((kind): kind is string => Boolean(kind)));
  if (unique.size < 2) return undefined;

  const spans: Array<{ text: string; lang: string; dir: 'rtl' | 'ltr'; bold: boolean }> = [];
  chars.forEach((char, i) => {
    const lang = kinds[i] ?? languageCode(blockLanguage, 'en');
    const last = spans[spans.length - 1];
    if (last?.lang === lang) last.text += char;
    else spans.push({ text: char, lang, dir: RTL_LANGUAGES.has(lang) ? 'rtl' : 'ltr', bold });
  });
  return spans;
}

function pageLanguages(model: PageModel, blocks: StructuredOcrDocument['blocks']): string[] {
  const input = [
    ...model.provenance.languages,
    ...blocks.map((block) => block.lang),
  ];
  const output = [...new Set(input.map((code) => languageCode(code)).filter((code) => code !== 'und'))];
  if (output.length) return output;
  const fallback = languageCode(model.language);
  return fallback === 'und' ? [] : [fallback];
}

/**
 * Serialize the current stored model. Bboxes stay normalized against the
 * processed page canvas; orientation is reported exactly as stored (not guessed).
 */
export function toStructuredOcrJson(model: PageModel): StructuredOcrDocument {
  const orderedBlocks = [...model.blocks].sort((a, b) => a.order - b.order);
  const needsReview = orderedBlocks.some((block) =>
    block.uncertain || blockLines(block).some((line) => confidenceLabel(line.text, line.confidence) === 'low'),
  );

  const blocks: StructuredOcrDocument['blocks'] = orderedBlocks.map((block, index) => {
    const lang = languageCode(block.language, languageCode(model.language, 'en'));
    const size = fontSizeCategory(block.fontSize);
    const bold = block.fontWeight >= 600;
    const lines = block.type === 'illustration' ? [] : blockLines(block).map((line) => {
      const width = Math.max(block.bbox.w, 0.000001);
      const rawIndent = block.direction === 'rtl'
        ? (block.bbox.x + block.bbox.w - (line.bbox.x + line.bbox.w)) / width
        : (line.bbox.x - block.bbox.x) / width;
      const indent = Math.max(0, Math.min(1, rawIndent));
      const spans = mixedScriptSpans(line.text, lang, bold);
      return {
        text: line.text,
        indent: Number(indent.toFixed(4)),
        confidence: confidenceLabel(line.text, line.confidence),
        ...(spans ? { spans } : {}),
      };
    });

    return {
      id: index + 1,
      type: exportedType(block, size),
      bbox: [block.bbox.x, block.bbox.y, block.bbox.w, block.bbox.h],
      lang,
      dir: block.direction,
      align: exportAlignment(block),
      font: {
        size,
        bold,
        italic: block.italic,
        underline: Boolean(block.underline),
        color: block.color,
        family: fontFamilyCategory(block),
      },
      handwritten: false,
      lines,
      table: null,
    };
  });

  const fullText = blocks.flatMap((block) => block.lines.map((line) => line.text)).join('\n');
  return {
    page: {
      dominant_direction: model.direction,
      languages: pageLanguages(model, blocks),
      rotation_applied: model.orientation,
      needs_review: needsReview,
    },
    blocks,
    full_text: fullText,
  };
}
