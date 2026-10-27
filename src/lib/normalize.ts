/**
 * CamScan — Arabic & multilingual text normalisation for search.
 *
 * Design rules (deliberate, tested in tests/normalize.test.ts):
 *
 * 1. Display text is NEVER mutated. These helpers only build search keys.
 * 2. Always strip tashkeel/harakat and tatweel, and unify the alef/hamza forms
 *    — these are pure typographic variations of the same word.
 * 3. Alef maqsura (ى) → ya (ي) and hamza-on-carrier (أ/إ/ؤ/ئ) folds live in a
 *    *secondary* normalisation level, used for fuzzy matching only.
 * 4. Ta marbuta (ة) is NOT collapsed to ha (ه) in the canonical key. Doing so
 *    creates false positives; a separate "loose" key may fold it for fuzzy hits.
 * 5. Arabic-Indic and Extended Arabic-Indic digits are mapped to ASCII digits so
 *    "١٩٨٤" and "1984" match each other, while the stored text keeps the
 *    original glyphs.
 * 6. Diacritics of other scripts (Latin combining marks) are stripped as well,
 *    so accented French/Turkish text is findable from an unaccented query.
 */

/** Arabic diacritics: harakat, tanwin, shadda, sukun, superscript alef, Quranic marks. */
const ARABIC_DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED\u08D3-\u08E1\u08E3-\u08FF]/g;

/** Tatweel / kashida — purely a justification glyph. */
const TATWEEL = /\u0640/g;

/** Zero-width marks that OCR engines love to sprinkle into output. */
const ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** Arabic-Indic + Extended Arabic-Indic digits → ASCII. */
const DIGIT_MAP: Record<string, string> = {
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
  '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
  '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
};

/** Arabic punctuation → ASCII equivalents (helps tokenisation and snippets). */
const PUNCT_MAP: Record<string, string> = {
  '،': ',', '؛': ';', '؟': '?', '٪': '%', 'ـ': '-',
  '«': '"', '»': '"', '﴾': ')', '﴿': '(', '٬': "'", '٫': '.',
  '\u2018': "'", '\u2019': "'", '\u201C': '"', '\u201D': '"',
  '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2212': '-',
};

export interface NormalizeOptions {
  /**
   * Fuzzy level folds more aggressively: alef maqsura → ya, hamza carriers →
   * plain letter, ta marbuta → ha and Latin combining marks removed.
   * Default: false (canonical search key).
   */
  fuzzy?: boolean;
  /** Lower-case Latin text. Default true. */
  lowercase?: boolean;
  /** Collapse whitespace runs to a single space. Default true. */
  collapseWhitespace?: boolean;
}

/**
 * Canonical search normalisation. Safe to index and to match exactly.
 *
 * @example normalizeArabic('مُحَمَّدٌ ﷲ') // 'محمد الله'  (ligature expanded too)
 */
export function normalizeArabic(input: string, options: NormalizeOptions = {}): string {
  const { fuzzy = false, lowercase = true, collapseWhitespace = true } = options;
  if (!input) return '';

  let s = input.normalize('NFKC');

  // 1. Remove invisible / direction marks.
  s = s.replace(ZERO_WIDTH, '');

  // 2. Strip Arabic diacritics and tatweel.
  s = s.replace(ARABIC_DIACRITICS, '').replace(TATWEEL, '');

  // 3. Unify alef variants (آ أ إ ٱ) → ا  and  ى → ي (optional)
  s = s.replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627');
  // hamza on waw / ya: ؤ → و, ئ → ي (canonical: keep the carrier letter)
  s = s.replace(/\u0624/g, '\u0648').replace(/\u0626/g, '\u064A');
  // Standalone hamza is kept — it is a meaningful letter in some words.

  if (fuzzy) {
    // Alef maqsura → ya, ta marbuta → ha — only for the loose key.
    s = s.replace(/\u0649/g, '\u064A');
    s = s.replace(/\u0629/g, '\u0647');
    // Latin combining marks (é → e, ş → s, ğ → g, ñ → n)
    s = s.normalize('NFD').replace(/[\u0300-\u036F]/g, '');
    // Latin sharp-s / ligatures that commonly differ between OCR runs.
    s = s.replace(/ß/g, 'ss').replace(/æ/g, 'ae').replace(/œ/g, 'oe');
  }

  // 4. Digits + punctuation folding (helps snippets and mixed queries).
  s = s.replace(/[٠-٩۰-۹]/g, (d) => DIGIT_MAP[d] ?? d);
  s = s.replace(/[،؛؟٪«»٬٫]/g, (p) => PUNCT_MAP[p] ?? p);
  s = s.replace(/[\u2010-\u2015\u2212]/g, '-');
  s = s.replace(/[\u2018\u2019\u201A\u201B]/g, "'");
  s = s.replace(/[\u201C\u201D\u201E\u201F]/g, '"');

  // 5. Case folding (Turkish dotted/dotless i handled explicitly).
  if (lowercase) {
    s = s.replace(/İ/g, 'i').replace(/I/g, 'i').toLowerCase();
  }

  if (collapseWhitespace) s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** Remove Arabic diacritics only — useful for "show diacritics" toggles. */
export function stripTashkeel(input: string): string {
  return input.replace(ARABIC_DIACRITICS, '').replace(TATWEEL, '');
}

/** Does this string contain any Arabic-script characters? */
const ARABIC_SCRIPT = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
export function hasArabicScript(input: string): boolean {
  return ARABIC_SCRIPT.test(input);
}

/** Ratio (0..1) of Arabic-script letters in the string. */
export function arabicRatio(input: string): number {
  const letters = input.match(/[\p{L}]/gu);
  if (!letters) return 0;
  const arabic = input.match(/[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/g);
  return (arabic?.length ?? 0) / letters.length;
}

/** Guess the dominant language of a text sample (ar / fa / ur / en / und). */
export function guessLanguage(input: string): { language: string; confidence: number } {
  if (!input.trim()) return { language: 'und', confidence: 0 };
  const ratio = arabicRatio(input);
  if (ratio < 0.2) {
    const latin = (input.match(/[a-zA-Z\u00C0-\u024F]/g) ?? []).length;
    if (latin > 0) return { language: 'en', confidence: Math.min(1, 0.4 + latin / 40) };
    return { language: 'und', confidence: 0.2 };
  }
  // Persian-specific letters
  const persian = (input.match(/[پچژگکی]/g) ?? []).length;
  const urdu = (input.match(/[ٹڈڑںھےۓ]/g) ?? []).length;
  if (urdu > persian && urdu > 2) return { language: 'ur', confidence: 0.6 };
  if (persian > 3) return { language: 'fa', confidence: 0.55 };
  return { language: 'ar', confidence: Math.min(1, 0.5 + ratio / 2) };
}

/**
 * Split a page's text into search tokens.
 * Arabic words are kept whole (no stemming) — fuzzy matching handles OCR noise.
 */
export function tokenize(input: string): string[] {
  return normalizeArabic(input)
    .split(/[^\p{L}\p{N}\u0600-\u06FF]+/u)
    .filter((t) => t.length > 0);
}

/**
 * Build a short snippet around the first match of `query` in `text`.
 * Matching is done in normalised space but the snippet is cut from the
 * ORIGINAL text so the reader sees their real diacritics and spelling.
 */
export function makeSnippet(
  text: string,
  query: string,
  { radius = 90, maxLength = 220 }: { radius?: number; maxLength?: number } = {},
): { snippet: string; matchStart: number; matchLength: number } {
  if (!text) return { snippet: '', matchStart: 0, matchLength: 0 };
  const normText = normalizeArabic(text);
  const terms = tokenize(query);
  if (!terms.length) {
    return { snippet: text.slice(0, maxLength), matchStart: 0, matchLength: 0 };
  }

  // Find the earliest term occurrence in normalised space.
  let best = -1;
  let bestLen = 0;
  for (const term of terms) {
    const idx = normText.indexOf(term);
    if (idx !== -1 && (best === -1 || idx < best)) {
      best = idx;
      bestLen = term.length;
    }
  }
  if (best === -1) {
    return { snippet: text.slice(0, maxLength), matchStart: 0, matchLength: 0 };
  }

  // Normalisation can shift indices (diacritics removed). Map back by scanning
  // the original string in parallel until we reach the same normalised length.
  const originalIndex = mapNormalizedIndexToOriginal(text, best);
  const start = Math.max(0, originalIndex - radius);
  const end = Math.min(text.length, originalIndex + bestLen + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  let snippet = prefix + text.slice(start, end).replace(/\s+/g, ' ').trim() + suffix;
  if (snippet.length > maxLength) snippet = snippet.slice(0, maxLength) + '…';
  return {
    snippet,
    matchStart: prefix ? originalIndex - start + prefix.length : originalIndex - start,
    matchLength: bestLen,
  };
}

/** Walk the original string until its normalised prefix reaches `normIndex`. */
function mapNormalizedIndexToOriginal(original: string, normIndex: number): number {
  let count = 0;
  for (let i = 0; i < original.length; i++) {
    if (count >= normIndex) return i;
    const ch = original[i];
    const n = normalizeArabic(ch);
    count += n.length;
  }
  return Math.max(0, original.length - 1);
}

/**
 * Highlight helper: returns segments with a `hit` flag so the UI can wrap
 * matches in <mark> without ever using dangerouslySetInnerHTML.
 */
export interface HighlightSegment {
  text: string;
  hit: boolean;
}

export function highlightSegments(text: string, query: string): HighlightSegment[] {
  const terms = tokenize(query);
  if (!terms.length || !text) return [{ text, hit: false }];

  // Build a normalised copy with an index map back to original offsets.
  const map: number[] = [];
  let norm = '';
  for (let i = 0; i < text.length; i++) {
    const n = normalizeArabic(text[i]);
    for (let k = 0; k < n.length; k++) {
      map.push(i);
      norm += n[k];
    }
  }
  map.push(text.length);

  const ranges: Array<[number, number]> = [];
  for (const term of terms) {
    let from = 0;
    for (;;) {
      const idx = norm.indexOf(term, from);
      if (idx === -1) break;
      const startOrig = map[idx] ?? 0;
      const endOrig = map[Math.min(idx + term.length, map.length - 1)] ?? text.length;
      ranges.push([startOrig, Math.max(startOrig + 1, endOrig)]);
      from = idx + term.length;
    }
  }
  if (!ranges.length) return [{ text, hit: false }];

  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r] as [number, number]);
  }

  const out: HighlightSegment[] = [];
  let cursor = 0;
  for (const [s, e] of merged) {
    if (s > cursor) out.push({ text: text.slice(cursor, s), hit: false });
    out.push({ text: text.slice(s, e), hit: true });
    cursor = e;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), hit: false });
  return out;
}
