/**
 * CamScan — persistence layer.
 *
 * `CamScanDb` is a thin Dexie wrapper. All UI code goes through the
 * `Repository` interface below, never through Dexie directly, so a future
 * Supabase/PostgreSQL backend can be dropped in by implementing the same
 * interface (see `createLocalRepository`).
 *
 * Storage strategy
 *  - Book/Page *metadata* is kept in compact records so the library grid can
 *    render hundreds of books without reading a single full-resolution image.
 *  - Full-resolution captures live in their own table (`blobs`) addressed by
 *    id, so listing pages never loads megabytes of JPEG data.
 *  - Page models, plain text, revisions, jobs and exports are separate tables.
 */
import Dexie, { type Table } from 'dexie';
import type {
  AppSettings,
  Book,
  ExportRecord,
  JobRecord,
  PageModel,
  PageRecord,
  RevisionRecord,
} from './types';

/** A binary payload stored outside the hot metadata tables. */
export interface BlobRecord {
  id: string;
  blob: Blob;
  kind: 'original' | 'processed' | 'cover' | 'illustration';
  size: number;
  createdAt: number;
}

/**
 * Page record as stored in IndexedDB — same as `PageRecord` but with blob ids
 * instead of inline Blobs. `PageRecord` (with Blobs) is what the app consumes.
 */
export type PageRow = Omit<PageRecord, 'originalImage' | 'processedImage' | 'thumb'> & {
  originalBlobId: string;
  processedBlobId?: string;
  /** Small inline data URL (≤ ~40 KB) so grids/strips render without blob reads. */
  thumb?: string;
};

export class CamScanDb extends Dexie {
  books!: Table<Book, string>;
  pages!: Table<PageRow, string>;
  blobs!: Table<BlobRecord, string>;
  jobs!: Table<JobRecord, string>;
  revisions!: Table<RevisionRecord, string>;
  settings!: Table<AppSettings, string>;
  exports!: Table<ExportRecord, string>;

  constructor(name = 'camscan') {
    super(name);
    this.version(1).stores({
      books: 'id, title, createdAt, updatedAt, language',
      pages: 'id, bookId, [bookId+order], order, status, updatedAt',
      blobs: 'id, kind, createdAt',
      jobs: 'id, pageId, bookId, state, type, [state+type], createdAt',
      revisions: 'id, pageId, bookId, createdAt',
      settings: 'id',
      exports: 'id, bookId, state, createdAt',
    });
    // Version 2 example migration hook — kept so the pattern is obvious.
    this.version(2).stores({
      books: 'id, title, createdAt, updatedAt, language',
      pages: 'id, bookId, [bookId+order], order, status, updatedAt',
      blobs: 'id, kind, createdAt',
      jobs: 'id, pageId, bookId, state, type, [state+type], createdAt',
      revisions: 'id, pageId, bookId, createdAt',
      settings: 'id',
      exports: 'id, bookId, state, createdAt',
    }).upgrade(async (tx) => {
      // Backfill `reviewed` for rows created before the flag existed.
      await tx.table('pages').toCollection().modify((p: Partial<PageRow>) => {
        if (typeof p.reviewed !== 'boolean') p.reviewed = false;
      });
    });
  }
}

let _db: CamScanDb | null = null;
export function getDb(): CamScanDb {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB is not available in this environment');
  }
  if (!_db) _db = new CamScanDb();
  return _db;
}

/** Test helper / "reset library" support. */
export async function deleteDb(): Promise<void> {
  if (_db) {
    _db.close();
    _db = null;
  }
  await Dexie.delete('camscan');
}
