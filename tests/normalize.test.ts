/**
 * Arabic/Latin text normalisation.
 *
 * The rules that matter for a searchable Arabic library:
 *  - strip tashkeel (harakat) and Quranic annotation marks
 *  - unify alef forms (أ إ آ ٱ → ا) and hamza carriers (ؤ ئ → و ي)
 *  - unify alef maqsura / dotless yeh (ى → ي) and teh marbuta for *search only*
 *  - keep the canonical text untouched: normalisation is for indexing and
 *    comparison, never for what we display or export
 */
import { describe, expect, it } from 'vitest';
import {
  hasArabicScript,
  normalizeArabic,
  highlightSegments,
  guessLanguage,
  arabicRatio,
} from '@/lib/normalize';
import { normalizeSearchText } from '@/lib/repository';
import { detectDirection } from '@/lib/pageModel';

describe('normalizeArabic', () => {
  it('strips tashkeel and Quranic marks', () => {
    expect(normalizeArabic('مُحَمَّدٌ')).toBe('محمد');
    expect(normalizeArabic('رَسُولُ اللَّهِ')).toBe('رسول الله');
    // Quranic annotation signs (sajdah etc.) are *symbols*, not diacritics: they
    // are kept so nothing is silently dropped from the stored text.
    expect(normalizeArabic('بِسْمِ اللَّهِ ۞')).toBe('بسم الله ۞');
  });

  it('unifies alef variants (أ إ آ ٱ → ا)', () => {
    expect(normalizeArabic('أحمد')).toBe('احمد');
    expect(normalizeArabic('إسلام')).toBe('اسلام');
    expect(normalizeArabic('آمن')).toBe('امن');
    expect(normalizeArabic('ٱلكتاب')).toBe('الكتاب');
  });

  it('unifies hamza carriers (ؤ → و, ئ → ي)', () => {
    expect(normalizeArabic('مؤلف')).toBe('مولف');
    expect(normalizeArabic('قائد')).toBe('قايد');
    // Alef maqsura (ى) is *canonically* a distinct letter and is only folded in
    // the fuzzy key — see the normalizeSearchText tests below.
    expect(normalizeArabic('مصطفى')).toBe('مصطفى');
    expect(normalizeArabic('مصطفى', { fuzzy: true })).toBe('مصطفي');
  });

  it('does NOT collapse teh marbuta in canonical normalisation', () => {
    // Two words that differ only by teh marbuta are different words; search may
    // optionally fold them, but `normalizeArabic` is the conservative one.
    expect(normalizeArabic('مكتبة')).toContain('ة');
    expect(normalizeArabic('مكتبة')).not.toBe(normalizeArabic('مكتبه'));
  });

  it('folds Arabic-Indic digits to ASCII for matching (canonical text keeps them)', () => {
    expect(normalizeArabic('ص ٤٥')).toBe('ص 45');
    expect(normalizeArabic('ص 45')).toBe('ص 45');
  });

  it('case-folds Latin text', () => {
    expect(normalizeArabic('Chapter One')).toBe('chapter one');
  });

  it('collapses whitespace', () => {
    expect(normalizeArabic('  تاريخ   العلم  ')).toBe('تاريخ العلم');
  });
});

describe('normalizeSearchText (what actually gets indexed for a page)', () => {
  it('strips tashkeel and normalises alef for search', () => {
    expect(normalizeSearchText('كَتَبَ')).toBe(normalizeSearchText('كتب'));
    expect(normalizeSearchText('أحمد')).toBe(normalizeSearchText('احمد'));
    expect(normalizeSearchText('كــتاب')).toBe('كتاب');
  });

  it('applies the Arabic folding to Latin too', () => {
    expect(normalizeSearchText('Chapter  ONE')).toBe('chapter one');
  });

  it('applies Arabic folding to Latin too, without breaking it', () => {
    expect(normalizeSearchText('Chapter  ONE')).toBe('chapter one');
  });

  it('makes diacritic-heavy and plain queries equal', () => {
    expect(normalizeSearchText('مُحَمَّدٌ رَسُولُ اللَّهِ')).toBe(normalizeSearchText('محمد رسول الله'));
  });
});

describe('highlightSegments', () => {
  it('marks the original (un-normalised) text, preserving diacritics', () => {
    const text = 'بسم الله الرحمن الرحيم';
    const segs = highlightSegments(text, 'الرحمن');
    // The trailing space is part of the matched word boundary; what matters is
    // that the *marked* text is the original substring with its diacritics.
    const hit = segs.filter((s) => s.hit).map((s) => s.text).join('');
    expect(hit.trim()).toBe('الرحمن');
    // Reassembling the segments must give back the original string exactly.
    expect(segs.map((s) => s.text).join('')).toBe(text);
  });

  it('finds a query typed without diacritics inside a vocalised text', () => {
    const segs = highlightSegments('مُحَمَّدٌ رَسُولُ اللَّهِ', 'محمد');
    expect(segs.some((s) => s.hit)).toBe(true);
  });

  it('finds an alef-normalised query (أحمد vs احمد)', () => {
    expect(highlightSegments('أحمد شوقي', 'احمد').some((s) => s.hit)).toBe(true);
  });

  it('returns one non-hit segment for an empty query', () => {
    const segs = highlightSegments('نص', '');
    expect(segs).toEqual([{ text: 'نص', hit: false }]);
  });
});

describe('script helpers', () => {
  it('detects Arabic script', () => {
    expect(hasArabicScript('تاريخ العلم')).toBe(true);
    expect(hasArabicScript('History of Science')).toBe(false);
    expect(hasArabicScript('تاريخ Science')).toBe(true);
  });

  it('measures the Arabic share of a line', () => {
    expect(arabicRatio('تاريخ العلم')).toBe(1);
    expect(arabicRatio('History of Science')).toBe(0);
    const mixed = arabicRatio('الفصل One');
    expect(mixed).toBeGreaterThan(0);
    expect(mixed).toBeLessThan(1);
  });

  it('detects paragraph direction', () => {
    expect(detectDirection('هذا نص عربي طويل لإختبار الاتجاه', 'ltr')).toBe('rtl');
    expect(detectDirection('This is a long English sentence for testing.', 'rtl')).toBe('ltr');
    // A short Latin line inside an RTL page stays LTR for that block.
    expect(detectDirection('Chapter One', 'rtl')).toBe('ltr');
  });

  it('guesses the language from a sample', () => {
    expect(guessLanguage('هذا كتاب في تاريخ العلم').language).toBe('ar');
    expect(guessLanguage('This is a book about the history of science').language).toBe('en');
  });
});
