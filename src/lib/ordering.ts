/**
 * CamScan — page ordering helpers (pure, no DOM, no DB).
 *
 * Page order is a property of **capture**, never of processing. Every helper
 * here works on plain id lists so it can be unit-tested without IndexedDB and
 * reused by the repository, the reader and the exporter.
 */

/** Sort rows by `order`, breaking ties by id so the UI never flickers. */
export function sortByOrder<T extends { id: string; order: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * The `order` for a newly captured page: one past the highest existing order.
 *
 * Uses max+1 rather than `length`, so a book with gaps (after deleting a page)
 * still appends at the end instead of colliding with an existing order.
 */
export function nextOrder(rows: readonly { order: number }[]): number {
  if (!rows.length) return 0;
  return Math.max(...rows.map((r) => r.order)) + 1;
}

/**
 * Move the id at `from` so that it sits at index `to`.
 * Out-of-range indexes are ignored (the value is returned unchanged).
 */
export function reorderIds(ids: readonly string[], from: number, to: number): string[] {
  if (from === to) return [...ids];
  if (from < 0 || from >= ids.length || to < 0 || to >= ids.length) return [...ids];
  const out = [...ids];
  const [moved] = out.splice(from, 1);
  out.splice(to, 0, moved);
  return out;
}

/** Move one item by `delta` positions (used by the ▲/▼ buttons), clamped. */
export function moveItem(ids: readonly string[], index: number, delta: number): string[] {
  const to = Math.max(0, Math.min(ids.length - 1, index + delta));
  return reorderIds(ids, index, to);
}
