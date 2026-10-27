/**
 * CamScan — client-side full-text search.
 *
 * Built on MiniSearch, with an Arabic-aware normalisation layer:
 *  - documents are indexed with `normalizeArabic(text)` (tashkeel stripped,
 *    alef forms unified, digits folded) so a query matches regardless of
 *    diacritics in either the query or the stored text;
 *  - the *display* text is kept untouched for snippets/highlighting;
 *  - a second, looser key (`fuzzy: true`, folds ى→ي and ة→ه) is used only as a
 *    lower-priority fuzzy path, so exact matches always rank first;
 *  - the whole index is rebuildable from persisted rows at any time.
 *
 * The index is a pure data structure — it can run on the main thread for
 * hundreds of pages (MiniSearch is fast) and can also be moved into a worker
 * without changing call sites.
 */
import MiniSearch, { type SearchResult } from 'minisearch';
import { makeSnippet, normalizeArabic, highlightSegments, tokenize, type HighlightSegment } from './normalize';

export interface SearchDoc {
  /** `${bookId}:${pageId}` */
  id: string;
  bookId: string;
  pageId: string;
  bookTitle: string;
  author: string;
  /** Page order (1-based) inside the book — what the reader shows. */
  pageNumber: number;
  printedNumber: string;
  /** Normalised page text (search key). */
  text: string;
  /** Normalised loose text (fuzzy fallback). */
  looseText: string;
  language: string;
  status: string;
}

export interface SearchHit {
  bookId: string;
  bookTitle: string;
  author: string;
  pageId: string;
  pageNumber: number;
  printedNumber: string;
  /** Snippet cut from the ORIGINAL display text. */
  snippet: string;
  score: number;
  /** Matched terms as they appear in the query. */
  terms: string[];
  /** True when the hit came only from the fuzzy pass. */
  fuzzy: boolean;
}

export interface SearchOptions {
  bookId?: string;
  limit?: number;
  fuzzy?: boolean;
}

const STOPWORDS_AR = new Set(['في', 'من', 'على', 'إلى', 'عن', 'أن', 'إن', 'التي', 'الذي', 'هذا', 'هذه']);
const STOPWORDS_EN = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'to', 'and', 'or', 'is', 'are', 'for']);

export function isStopword(token: string): boolean {
  return STOPWORDS_AR.has(token) || STOPWORDS_EN.has(token);
}

/**
 * Manages the MiniSearch index plus a map of display text so snippets can be
 * produced from the original (unnormalised) page text.
 */
/**
 * Query terms for the index.
 *
 * Two problems with a naive query in Arabic:
 *  1. `prefix: true` only helps when the *query* is shorter than the indexed
 *     term ("تار" → "تاريخ"). It cannot help when the query is longer
 *     ("العلمان" against the indexed "علمان"), which is common because Arabic
 *     attaches the article and suffixes.
 *  2. A fixed fuzzy distance of 0.18 is tiny on a 7-letter word (0.18 × 7 ≈ 1.3).
 *
 * So each query term is searched twice: as typed, and without a leading
 * definite article (ال / وال / بال / كال / لل). The stripped form is what
 * actually catches "العلمان" → "علمان".
 */
export function queryVariants(query: string): { exact: string[]; stripped: string[] } {
  const terms = tokenize(query);
  const exact = terms.map((t) => normalizeArabic(t)).filter(Boolean);
  const stripped = exact
    .map((t) => t.replace(/^(?:وال|بال|كال|فال|لل|ال)/u, ''))
    .filter((t) => t.length >= 3 && !exact.includes(t));
  return { exact: [...new Set(exact)], stripped: [...new Set(stripped)] };
}

export class CamScanSearch {
  private index: MiniSearch<SearchDoc>;
  private display = new Map<string, { text: string; doc: SearchDoc }>();

  constructor() {
    this.index = new MiniSearch<SearchDoc>({
      fields: ['text', 'looseText', 'bookTitle', 'author'],
      storeFields: ['bookId', 'pageId', 'bookTitle', 'author', 'pageNumber', 'printedNumber', 'language', 'status'],
      idField: 'id',
      tokenize: (text) => text.split(/[^\p{L}\p{N}\u0600-\u06FF]+/u).filter(Boolean),
      processTerm: (term) => normalizeArabic(term),
      searchOptions: {
        boost: { bookTitle: 2.2, author: 1.4, text: 1 },
        prefix: true,
        fuzzy: 0.18,
        combineWith: 'AND',
      },
    });
  }

  get size(): number {
    return this.display.size;
  }

  /** Add or replace one page document. */
  upsert(doc: {
    bookId: string;
    bookTitle: string;
    author?: string;
    pageId: string;
    pageNumber: number;
    printedNumber?: string;
    displayText: string;
    language?: string;
    status?: string;
  }): void {
    const id = `${doc.bookId}:${doc.pageId}`;
    const searchDoc: SearchDoc = {
      id,
      bookId: doc.bookId,
      pageId: doc.pageId,
      bookTitle: doc.bookTitle,
      author: doc.author ?? '',
      pageNumber: doc.pageNumber,
      printedNumber: doc.printedNumber ?? '',
      text: normalizeArabic(doc.displayText),
      looseText: normalizeArabic(doc.displayText, { fuzzy: true }),
      language: doc.language ?? '',
      status: doc.status ?? '',
    };
    // Remove-then-add keeps reindexing idempotent.
    if (this.index.has(id)) this.index.discard(id);
    this.index.add(searchDoc);
    this.display.set(id, { text: doc.displayText, doc: searchDoc });
  }

  remove(pageId: string): void {
    for (const [id, entry] of this.display) {
      if (entry.doc.pageId === pageId) {
        if (this.index.has(id)) this.index.discard(id);
        this.display.delete(id);
      }
    }
  }

  removeBook(bookId: string): void {
    for (const [id, entry] of this.display) {
      if (entry.doc.bookId === bookId) {
        if (this.index.has(id)) this.index.discard(id);
        this.display.delete(id);
      }
    }
  }

  has(pageId: string): boolean {
    for (const entry of this.display.values()) if (entry.doc.pageId === pageId) return true;
    return false;
  }

  /**
   * Query the index. Exact matches are returned first; if `fuzzy` is enabled a
   * second pass over the loose key adds near matches at lower scores.
   */
  search(query: string, options: SearchOptions = {}): SearchHit[] {
    const { bookId, limit = 60, fuzzy = true } = options;
    const q = normalizeArabic(query);
    if (!q.trim()) return [];
    const variants = queryVariants(query);

    const filter = bookId
      ? (result: SearchResult) => (result as unknown as SearchDoc).bookId === bookId
      : undefined;

    let results: SearchResult[] = [];
    try {
      results = this.index.search(q, {
        combineWith: 'AND',
        prefix: true,
        fuzzy: 0.18,
        filter,
      });
    } catch {
      results = [];
    }

    // Fallback: MiniSearch's AND may be too strict for a partial multi-word
    // query; retry with OR so users see something useful while typing.
    if (!results.length) {
      try {
        results = this.index.search(q, {
          combineWith: 'OR',
          prefix: true,
          fuzzy: 0.18,
          filter,
        });
      } catch {
        results = [];
      }
    }

    // Stemmed pass: drop the Arabic definite article so "العلمان" matches the
    // indexed "علمان" (prefix matching cannot do that — it only helps shorter
    // queries).
    if (!results.length && variants.stripped.length) {
      try {
        const byId = new Map<string, SearchResult>();
        for (const term of variants.stripped) {
          for (const r of this.index.search(term, { combineWith: 'OR', prefix: true, fuzzy: 0.2, filter })) {
            const prev = byId.get(String(r.id));
            if (!prev || r.score > prev.score) byId.set(String(r.id), r);
          }
        }
        results = [...byId.values()];
      } catch {
        results = [];
      }
    }

    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    for (const r of results) {
      const entry = this.display.get(String(r.id));
      if (!entry) continue;
      const { snippet } = makeSnippet(entry.text, query);
      hits.push(hitFromResult(r, entry, snippet, options.bookId, false));
      seen.add(String(r.id));
    }

    if (fuzzy) {
      // Loose pass: ta marbuta/ha and alef-maqsura folds. Only used to surface
      // pages the strict pass missed — never to outrank exact hits.
      const looseQuery = normalizeArabic(query, { fuzzy: true });
      if (looseQuery && looseQuery !== q) {
        try {
          const loose = this.index.search(looseQuery, {
            fields: ['looseText'],
            combineWith: 'OR',
            prefix: true,
            fuzzy: 0.2,
            filter,
          });
          for (const r of loose) {
            const id = String(r.id);
            if (seen.has(id)) continue;
            const entry = this.display.get(id);
            if (!entry) continue;
            const { snippet } = makeSnippet(entry.text, query);
            const hit = hitFromResult(r, entry, snippet, options.bookId, true);
            hit.score *= 0.5;
            hits.push(hit);
            seen.add(id);
          }
        } catch {
          /* ignore loose-pass failures */
        }
      }
    }

    return hits
      .sort((a, b) => Number(a.fuzzy) - Number(b.fuzzy) || b.score - a.score)
      .slice(0, limit);
  }

  /** Highlight helper for the reader: returns segments to render as <mark>. */
  static highlight(text: string, query: string): HighlightSegment[] {
    return highlightSegments(text, query);
  }

  /**
   * Replace display text for a page after a user edit (re-index).
   * Returns false if the page is not in the index.
   */
  reindex(pageId: string, displayText: string): boolean {
    const entry = [...this.display.values()].find((e) => e.doc.pageId === pageId);
    if (!entry) return false;
    this.upsert({
      bookId: entry.doc.bookId,
      bookTitle: entry.doc.bookTitle,
      author: entry.doc.author,
      pageId,
      pageNumber: entry.doc.pageNumber,
      printedNumber: entry.doc.printedNumber,
      displayText,
      language: entry.doc.language,
      status: entry.doc.status,
    });
    return true;
  }

  /** Serialise the index for persistence/rebuild caching (optional). */
  toJSON(): { docs: SearchDoc[] } {
    return { docs: [...this.display.values()].map((e) => e.doc) };
  }

  static fromJSON(data: { docs: SearchDoc[] }): CamScanSearch {
    const s = new CamScanSearch();
    for (const doc of data.docs) {
      s.index.add(doc);
      s.display.set(doc.id, { text: doc.text, doc });
    }
    return s;
  }
}

function hitFromResult(
  r: SearchResult,
  entry: { text: string; doc: SearchDoc },
  snippet: string,
  bookIdFilter: string | undefined,
  fuzzy: boolean,
): SearchHit {
  void bookIdFilter;
  return {
    bookId: entry.doc.bookId,
    bookTitle: entry.doc.bookTitle,
    author: entry.doc.author,
    pageId: entry.doc.pageId,
    pageNumber: entry.doc.pageNumber,
    printedNumber: entry.doc.printedNumber,
    snippet,
    score: r.score,
    terms: r.terms ?? [],
    fuzzy,
  };
}

/* ------------------------------------------------------------------ */
/* Module-level singleton used by the UI                               */
/* ------------------------------------------------------------------ */

let singleton: CamScanSearch | null = null;
export function getSearchIndex(): CamScanSearch {
  if (!singleton) singleton = new CamScanSearch();
  return singleton;
}
export function resetSearchIndex(): void {
  singleton = null;
}

/**
 * Rebuild the entire index from persisted rows. Called on app start (cheap for
 * hundreds of pages) and after backup restore so the index can never drift.
 */
export async function rebuildIndex(rows: Array<{
  bookId: string;
  bookTitle: string;
  author?: string;
  pageId: string;
  pageNumber: number;
  printedNumber?: string;
  displayText: string;
  language?: string;
  status?: string;
}>): Promise<CamScanSearch> {
  const idx = new CamScanSearch();
  for (const row of rows) idx.upsert(row);
  singleton = idx;
  return idx;
}
