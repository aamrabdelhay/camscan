import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { exportLibraryToZip, importLibraryFromZip } from '@/lib/backup';
import type { Repository } from '@/lib/repository';
import type { Book, PageRecord } from '@/lib/types';

const book = {
  id: 'book-1',
  title: 'Archive test',
  language: 'en',
  createdAt: 1,
  updatedAt: 1,
  defaultFonts: { arabicFont: 'Amiri', latinFont: 'EB Garamond', bodyFontSize: 0.02, layout: 'absolute' },
  settings: { ocrLanguages: ['eng'], captureProfile: 'standard', autoCapture: true, reviewThreshold: 70, readingWidth: 720 },
  pageCount: 1,
  doneCount: 1,
  reviewCount: 0,
  failedCount: 0,
} as unknown as Book;

const page = {
  id: 'page-1',
  bookId: book.id,
  order: 0,
  status: 'done',
  stage: 'done',
  progress: 1,
  originalImage: new Blob(['original-photo'], { type: 'image/jpeg' }),
  processedImage: new Blob(['processed-photo'], { type: 'image/jpeg' }),
  thumb: undefined,
  plainText: 'recognised text',
  searchText: 'recognised text',
  avgConfidence: 0.98,
  language: 'eng',
  direction: 'ltr',
  width: 1200,
  height: 1600,
  reviewed: true,
  blank: false,
  userEdited: false,
  createdAt: 1,
  updatedAt: 1,
  revision: 1,
} as unknown as PageRecord;

describe('library backup restoration', () => {
  it('restores the processed page image as well as the original capture', async () => {
    const sourceRepo = {
      listBooks: async () => [book],
      listPages: async () => [page],
      getSettings: async () => ({}),
    } as unknown as Repository;

    const archive = await exportLibraryToZip(sourceRepo);
    const zip = await JSZip.loadAsync(archive);
    const manifest = JSON.parse(await zip.file('library.json')!.async('string'));
    expect(manifest.manifest.books[0].pages[0].processedPath).toBeTruthy();

    const patches: Array<Partial<PageRecord>> = [];
    const restoreRepo = {
      getBook: async () => undefined,
      createBook: async (input: Partial<Book> & { title: string }) => ({ ...book, ...input, id: input.id ?? book.id }) as Book,
      addPage: async (input: { bookId: string; order: number; originalImage: Blob; thumb?: string; width: number; height: number; language?: string; direction?: 'rtl' | 'ltr' }) => ({
        ...page,
        ...input,
        id: 'restored-page',
        originalImage: input.originalImage,
      }) as PageRecord,
      updatePage: async (_pageId: string, patch: Partial<PageRecord>) => { patches.push(patch); },
      recomputeBookStats: async () => ({ pageCount: 1, doneCount: 1, reviewCount: 0, failedCount: 0 }),
    } as unknown as Repository;

    const restored = await importLibraryFromZip(restoreRepo, archive);
    expect(restored.pages).toBe(1);
    const imagePatch = patches.find((patch) => patch.processedImage);
    expect(imagePatch?.processedImage).toBeInstanceOf(Blob);
    expect(await imagePatch!.processedImage!.text()).toBe('processed-photo');
  });

  it('continues to restore older archives without a processed image path', async () => {
    const sourceRepo = {
      listBooks: async () => [book],
      listPages: async () => [{ ...page, processedImage: undefined }],
      getSettings: async () => ({}),
    } as unknown as Repository;
    const archive = await exportLibraryToZip(sourceRepo);
    const patches: Array<Partial<PageRecord>> = [];
    const restoreRepo = {
      getBook: async () => undefined,
      createBook: async (input: Partial<Book> & { title: string }) => ({ ...book, ...input, id: input.id ?? book.id }) as Book,
      addPage: async (input: { bookId: string; order: number; originalImage: Blob; thumb?: string; width: number; height: number; language?: string; direction?: 'rtl' | 'ltr' }) => ({
        ...page, ...input, id: 'restored-page', originalImage: input.originalImage,
      }) as PageRecord,
      updatePage: async (_pageId: string, patch: Partial<PageRecord>) => { patches.push(patch); },
      recomputeBookStats: async () => ({ pageCount: 1, doneCount: 1, reviewCount: 0, failedCount: 0 }),
    } as unknown as Repository;

    const restored = await importLibraryFromZip(restoreRepo, archive);
    expect(restored.pages).toBe(1);
    expect(patches.some((patch) => patch.processedImage)).toBe(false);
  });
});
