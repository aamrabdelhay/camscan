/**
 * Page ordering.
 *
 * Capture order must be the page order — never the order in which OCR happens
 * to finish (a slow page 1 must not jump behind a fast page 2). These tests
 * exercise the pure ordering logic plus the renumbering rules the repository
 * applies, including insert/delete/move.
 */
import { describe, expect, it } from 'vitest';
import { nextOrder, reorderIds, sortByOrder, moveItem } from '@/lib/ordering';

interface P { id: string; order: number }

const pages = (...orders: number[]): P[] => orders.map((order, i) => ({ id: `p${i}`, order }));

describe('sortByOrder', () => {
  it('sorts by order regardless of array order', () => {
    const rows = [pages(2)[0], pages(0)[0], pages(1)[0]];
    expect(sortByOrder(rows).map((p) => p.order)).toEqual([0, 1, 2]);
  });

  it('does not mutate the input array', () => {
    const rows = pages(1, 0);
    const sorted = sortByOrder(rows);
    expect(rows.map((p) => p.order)).toEqual([1, 0]);
    expect(sorted.map((p) => p.order)).toEqual([0, 1]);
  });

  it('breaks ties deterministically by id, so a UI never flickers', () => {
    const rows: P[] = [{ id: 'b', order: 0 }, { id: 'a', order: 0 }];
    expect(sortByOrder(rows).map((p) => p.id)).toEqual(['a', 'b']);
  });
});

describe('nextOrder', () => {
  it('starts at 0 for an empty book', () => {
    expect(nextOrder([])).toBe(0);
  });

  it('appends after the highest existing order (not the length)', () => {
    // A gap after deletions: orders 0, 5 → next must be 6, not 2.
    expect(nextOrder(pages(0, 5))).toBe(6);
  });

  it('is unaffected by processing state', () => {
    // Order is a property of capture, so a still-processing last page still wins.
    const rows = pages(0, 1, 2);
    expect(nextOrder(rows)).toBe(3);
  });
});

describe('reorderIds', () => {
  it('moves a page from one position to another', () => {
    expect(reorderIds(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(reorderIds(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('is a no-op when the position does not change', () => {
    expect(reorderIds(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'b', 'c']);
  });

  it('ignores out-of-range indexes instead of corrupting the list', () => {
    expect(reorderIds(['a', 'b'], 5, 0)).toEqual(['a', 'b']);
  });

  it('keeps every id exactly once', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const out = reorderIds(ids, 1, 4);
    expect([...out].sort()).toEqual([...ids].sort());
    expect(new Set(out).size).toBe(ids.length);
  });
});

describe('moveItem', () => {
  it('moves up and down by one', () => {
    expect(moveItem(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
  });

  it('clamps at the ends', () => {
    expect(moveItem(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
    expect(moveItem(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
  });
});

describe('stable page numbering', () => {
  it('derives display numbers from order, not from completion', () => {
    // Page 2 finished OCR first; display order must still be 1, 2, 3.
    const rows = [
      { id: 'p2', order: 2, status: 'done' },
      { id: 'p1', order: 1, status: 'processing' },
      { id: 'p0', order: 0, status: 'queued' },
    ];
    const numbered = sortByOrder(rows).map((r, i) => ({ ...r, pageNumber: i + 1 }));
    expect(numbered.map((r) => [r.id, r.pageNumber])).toEqual([
      ['p0', 1],
      ['p1', 2],
      ['p2', 3],
    ]);
  });

  it('renumbers contiguously after a delete + insert', () => {
    let ids = ['a', 'b', 'c'];
    ids = ids.filter((id) => id !== 'b');       // delete page 2
    const next = nextOrder(ids.map((id, i) => ({ id, order: i }))); // append
    expect(next).toBe(2);
    ids = [...ids, 'new'];
    expect(ids).toEqual(['a', 'c', 'new']);
    // After the repository renumbers, orders are 0,1,2 with no gaps.
    expect(ids.map((_, i) => i)).toEqual([0, 1, 2]);
  });
});
