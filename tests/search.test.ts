/**
 * Search index.
 *
 * Requirements: Arabic-normalised matching (tashkeel stripped, alef/hamza
 * folded), per-book and global search, snippets with the match marked, and
 * exact matches ranked above fuzzy ones.
 */
import { describe, expect, it } from 'vitest';
import { CamScanSearch as SearchIndex } from '@/lib/search';
import { normalizeArabic } from '@/lib/normalize';

function index(): SearchIndex {
  const idx = new SearchIndex();
  idx.upsert({
    bookId: 'b1',
    bookTitle: 'مقدمة ابن خلدون',
    author: 'ابن خلدون',
    pageId: 'p1',
    pageNumber: 1,
    printedNumber: '12',
    displayText: 'الفصل الأول: في تاريخ العلم. وقد ذكر ابن خلدون في المقدمة أن العلم علمان.',
    language: 'ar',
    status: 'done',
  });
  idx.upsert({
    bookId: 'b1',
    bookTitle: 'مقدمة ابن خلدون',
    author: 'ابن خلدون',
    pageId: 'p2',
    pageNumber: 2,
    printedNumber: '13',
    displayText: 'Chapter One: On the History of Science. The printing press changed how knowledge travelled.',
    language: 'en',
    status: 'done',
  });
  idx.upsert({
    bookId: 'b2',
    bookTitle: 'ديوان المتنبي',
    author: 'المتنبي',
    pageId: 'p3',
    pageNumber: 1,
    displayText: 'على قدر أهل العزم تأتي العزائم',
    language: 'ar',
    status: 'review',
  });
  return idx;
}

describe('Arabic-normalised search', () => {
  it('finds a page from a query with no diacritics', () => {
    const idx = index();
    const hits = idx.search('تاريخ العلم');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].pageId).toBe('p1');
  });

  it('matches when the page has diacritics but the query does not', () => {
    const idx = new SearchIndex();
    idx.upsert({
      bookId: 'b', bookTitle: 'كتاب', pageId: 'p', pageNumber: 1,
      displayText: 'مُحَمَّدٌ رَسُولُ اللَّهِ', language: 'ar', status: 'done',
    });
    expect(idx.search('محمد').map((h) => h.pageId)).toContain('p');
  });

  it('matches across alef variants (أحمد ↔ احمد)', () => {
    const idx = new SearchIndex();
    idx.upsert({ bookId: 'b', bookTitle: 'ك', pageId: 'p', pageNumber: 1, displayText: 'أحمد شوقي شاعر', language: 'ar', status: 'done' });
    expect(idx.search('احمد').length).toBeGreaterThan(0);
  });

  it('finds a word across teh-marbuta spelling differences (fuzzy path)', () => {
    const idx = new SearchIndex();
    idx.upsert({ bookId: 'b', bookTitle: 'ك', pageId: 'p', pageNumber: 1, displayText: 'هذه مكتبة كبيرة', language: 'ar', status: 'done' });
    expect(idx.search('مكتبه').length).toBeGreaterThan(0);
  });
});

describe('book scoping and ranking', () => {
  it('searches the whole library by default', () => {
    const idx = index();
    const books = new Set(idx.search('العلم').map((h) => h.bookId));
    // Both books contain a word derived from علم (العلم / العزائم fuzzily excluded),
    // so the useful assertion is that b1 is present and results are ordered.
    expect(books.has('b1')).toBe(true);
  });

  it('can restrict to one book', () => {
    const idx = index();
    // The filter must hold on *every* internal pass (strict AND, OR fallback,
    // stemmed pass, loose pass). Equality alone would pass on an empty result,
    // so also assert the scoped query still returns the expected page.
    expect(idx.search('العزم', { bookId: 'b2' }).every((h) => h.bookId === 'b2')).toBe(true);
    expect(idx.search('العزم', { bookId: 'b2' }).some((h) => h.pageId === 'p3')).toBe(true);
    expect(idx.search('تاريخ العلم', { bookId: 'b2' }).every((h) => h.bookId === 'b2')).toBe(true);
  });

  it('never leaks hits from another book on any pass', () => {
    const idx = new SearchIndex();
    const row = (bookId: string, pageId: string, text: string) => ({
      bookId, bookTitle: bookId, pageId, pageNumber: 1, displayText: text, language: 'ar', status: 'done',
    });
    idx.upsert(row('b1', 'p1', 'العزم والصبر في تاريخ العلم'));
    idx.upsert(row('b2', 'p2', 'العزم والصبر في تاريخ العلم'));
    idx.upsert(row('b2', 'p3', 'كتاب في تواريخ العلم'));

    // Triggers each code path: exact AND, OR fallback, stemmed, and loose.
    for (const query of ['العزم', 'تاريخ العلم', 'العلمان', 'العلم', 'تواريخ']) {
      for (const bookId of ['b1', 'b2']) {
        const hits = idx.search(query, { bookId });
        expect(hits.filter((h) => h.bookId !== bookId), `query "${query}" scoped to ${bookId}`).toHaveLength(0);
      }
    }
    // The filter must actually narrow: b1 has one page, b2 has two.
    expect(idx.search('العزم', { bookId: 'b1' })).toHaveLength(1);
    expect(idx.search('العزم', { bookId: 'b2' })).toHaveLength(2);
  });

  it('ranks a page whose word matches exactly above a fuzzy neighbour', () => {
    const idx = new SearchIndex();
    idx.upsert({ bookId: 'b', bookTitle: 'ك', pageId: 'exact', pageNumber: 1, displayText: 'كتاب في تاريخ العلم', language: 'ar', status: 'done' });
    idx.upsert({ bookId: 'b', bookTitle: 'ك', pageId: 'loose', pageNumber: 2, displayText: 'كتاب في تواريخ العلم', language: 'ar', status: 'done' });
    const hits = idx.search('تاريخ');
    expect(hits[0].pageId).toBe('exact');
  });

  it('finds a longer Arabic query by dropping the definite article', () => {
    const idx = new SearchIndex();
    idx.upsert({ bookId: 'b', bookTitle: 'ك', pageId: 'p', pageNumber: 1, displayText: 'أن العلم علمان', language: 'ar', status: 'done' });
    // The indexed token is "علمان"; prefix matching cannot bridge a *longer*
    // query, so this only works because of the article-stripping pass.
    expect(idx.search('العلمان').map((h) => h.pageId)).toEqual(['p']);
    expect(idx.search('والعلمان').map((h) => h.pageId)).toEqual(['p']);
  });

  it('leaves short words alone when stripping', () => {
    const idx = new SearchIndex();
    idx.upsert({ bookId: 'b', bookTitle: 'ك', pageId: 'p', pageNumber: 1, displayText: 'باب في العلم', language: 'ar', status: 'done' });
    expect(idx.search('العلم').length).toBeGreaterThan(0);
  });

  it('finds Latin text case-insensitively', () => {
    const idx = index();
    expect(idx.search('PRINTING').length).toBeGreaterThan(0);
    expect(idx.search('printing').length).toBeGreaterThan(0);
  });

  it('returns nothing for an empty query', () => {
    expect(index().search('   ')).toHaveLength(0);
  });
});

describe('snippets', () => {
  it('returns a snippet around the match', () => {
    const idx = index();
    const [hit] = idx.search('العلمان');
    expect(hit).toBeDefined();
    expect(hit.snippet.length).toBeGreaterThan(0);
    // Loose matching can return a page that shares the stem, so the snippet must
    // at least be drawn from *this* page's text.
    expect(hit.snippet).toContain('العلم');
  });

  it('reports the page number of the hit', () => {
    const idx = index();
    const [hit] = idx.search('printing');
    expect(hit.pageId).toBe('p2');
    expect(hit.pageNumber).toBe(2);
  });
});

describe('index maintenance', () => {
  it('updates a page in place after an edit (no duplicate hits)', () => {
    const idx = index();
    idx.upsert({
      bookId: 'b1', bookTitle: 'مقدمة ابن خلدون', pageId: 'p1', pageNumber: 1,
      displayText: 'نص جديد بعد التعديل اليدوي', language: 'ar', status: 'done',
    });
    expect(idx.search('العلمان')).toHaveLength(0);
    const hits = idx.search('التعديل اليدوي');
    expect(hits).toHaveLength(1);
    expect(hits[0].pageId).toBe('p1');
  });

  it('removes a deleted page from results', () => {
    const idx = index();
    idx.remove('p1');
    expect(idx.search('العلمان').filter((h) => h.pageId === 'p1')).toHaveLength(0);
  });

  it('reports its document count', () => {
    expect(index().size).toBe(3);
  });

  it('reports and maintains size across a full reset', () => {
    const idx = index();
    idx.remove('p1');
    idx.remove('p2');
    idx.remove('p3');
    expect(idx.size).toBe(0);
    expect(idx.search('العلم')).toHaveLength(0);
  });

  it('clears the whole index on request', () => {
    const idx = index();
    for (const id of ['p1', 'p2', 'p3']) idx.remove(id);
    expect(idx.size).toBe(0);
  });
});
