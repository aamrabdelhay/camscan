'use client';
/**
 * CamScan — background processing runtime.
 *
 * Design goals (all verifiable):
 *  - capture NEVER waits for OCR: the scanner persists the Blob + a `Job`
 *    row, then returns to ready state. This module picks the job up.
 *  - bounded parallelism: `min(hardwareConcurrency - 1, 3)` workers, never
 *    more, because each OCR worker holds ~150 MB of WASM memory.
 *  - persists job state, so a refresh/reopen resumes pending work
 *    automatically (browsers may kill workers when a tab closes; we do not
 *    pretend otherwise — we resume).
 *  - idempotent: one open job per (page, type, options). A retry updates the
 *    existing row, never creating a duplicate page.
 *  - ordering is never derived from completion: pages keep their capture
 *    `order`; only the *page row* receives results.
 *  - user edits are protected: a page with `userEdited=true` is not silently
 *    overwritten; the caller must choose (see `savePageModel({keepEdit})`).
 */
import type { JobRecord, PageModel, PageStatus } from './types';
import type { Repository } from './repository';
import { normalizeSearchText } from './repository';
import { getSearchIndex } from './search';
import { modelPlainText } from './pageModel';

export interface WorkerPoolOptions {
  repo: Repository;
  /** Hard cap on concurrent processing workers. */
  maxWorkers?: number;
  /** Injected for tests; defaults to a worker on /workers/processing.worker.js */
  workerFactory?: () => Worker;
  onEvent?: (event: PipelineEvent) => void;
}

export type PipelineEvent =
  | { type: 'job-progress'; jobId: string; pageId: string; value: number; stage: string }
  | { type: 'job-done'; jobId: string; pageId: string; status: PageStatus; confidence: number; ms: number }
  | { type: 'job-failed'; jobId: string; pageId: string; error: string; attempts: number }
  | { type: 'queue-empty' }
  | { type: 'worker-error'; error: string };

interface PendingJob {
  job: JobRecord;
  resolve: (ok: boolean) => void;
}

interface WorkerJobMessage {
  type: 'process';
  id: number;
  blob: Blob;
  options: {
    pageId: string;
    sequence: number;
    languages: string[];
    profile: string;
    arabicFont?: string;
    latinFont?: string;
    reviewThreshold: number;
    maxLongEdge?: number;
  };
}

interface WorkerDone {
  type: 'done';
  id: number;
  result: {
    model: PageModel;
    processed: { buffer: ArrayBuffer; type: string };
    thumb: string;
    width: number;
    height: number;
    avgConfidence: number;
    metrics: Record<string, number>;
    warnings: string[];
  };
}

interface WorkerProgress {
  type: 'progress';
  id: number;
  value: number;
  stage: string;
}

interface WorkerError {
  type: 'error';
  id: number;
  error: string;
}

type WorkerOut = WorkerDone | WorkerProgress | WorkerError;

/**
 * Hard ceiling for one page job. A page normally takes 2–8 s on a laptop and
 * under a minute on a phone, so two minutes means something is genuinely stuck.
 */
export const JOB_TIMEOUT_MS = 120_000;

export class ProcessingPool {
  private repo: Repository;
  private maxWorkers: number;
  private workerFactory: () => Worker;
  private workers: Worker[] = [];
  private busy = new Set<number>();
  private queue: PendingJob[] = [];
  private running = false;
  private currentBookId: string | null = null;
  private listeners = new Set<(e: PipelineEvent) => void>();
  private nextMsgId = 1;
  private pendingByMsgId = new Map<number, {
    job: JobRecord;
    startedAt: number;
    workerIndex: number;
    /** Fires if the worker never answers (a hung WASM call, OOM, …). */
    watchdog: ReturnType<typeof setTimeout>;
  }>();
  /** Job ids currently queued or running here, so `resume()` never duplicates. */
  private knownJobIds = new Set<string>();
  private stopped = false;

  constructor(opts: WorkerPoolOptions) {
    this.repo = opts.repo;
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
    this.maxWorkers = opts.maxWorkers ?? Math.max(1, Math.min(3, cores - 1));
    this.workerFactory = opts.workerFactory ?? (() => new Worker('/workers/processing.worker.js', { type: 'module' }));
    if (opts.onEvent) this.listeners.add(opts.onEvent);
  }

  get concurrency(): number {
    return this.maxWorkers;
  }

  get queueLength(): number {
    return this.queue.length + this.busy.size;
  }

  subscribe(fn: (e: PipelineEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(event: PipelineEvent) {
    for (const fn of this.listeners) fn(event);
  }

  private ensureWorker(index: number): Worker {
    if (this.workers[index]) return this.workers[index];
    const worker = this.workerFactory();
    worker.onmessage = (ev: MessageEvent<WorkerOut>) => this.handleWorkerMessage(index, ev.data);
    worker.onerror = (ev) => {
      this.emit({ type: 'worker-error', error: ev.message || 'worker crashed' });
      // Fail the in-flight job so it can be retried rather than vanishing.
      const entry = [...this.pendingByMsgId.entries()][0];
      if (entry) {
        const [msgId, { job, watchdog }] = entry;
        clearTimeout(watchdog);
        this.pendingByMsgId.delete(msgId);
        void this.failJob(job, 'worker crashed');
        this.busy.delete(index);
        this.pump();
      }
      worker.terminate();
      this.workers[index] = undefined as unknown as Worker;
    };
    this.workers[index] = worker;
    return worker;
  }

  /**
   * Enqueue a page for processing. Returns a promise that resolves when the
   * job finishes (or false on failure) — the scanner does not await it.
   */
  async enqueue(pageId: string, bookId: string, options: {
    languages: string[];
    profile: string;
    arabicFont?: string;
    latinFont?: string;
    reviewThreshold: number;
    reprocess?: boolean;
  }): Promise<JobRecord> {
    const job = await this.repo.enqueueJob({
      pageId,
      bookId,
      type: options.reprocess ? 'reprocess' : 'process',
      maxAttempts: 3,
      options: {
        languages: options.languages,
        profile: options.profile,
        arabicFont: options.arabicFont,
        latinFont: options.latinFont,
        reviewThreshold: options.reviewThreshold,
      },
      state: 'pending',
    });
    await this.repo.updatePageStatus(pageId, 'queued');
    this.knownJobIds.add(job.id);
    this.queue.push({ job, resolve: () => undefined });
    this.pump();
    return job;
  }

  /** Resume everything that was pending when the tab closed. */
  async resume(bookId?: string): Promise<number> {
    const jobs = await this.repo.listJobs();
    const open = jobs.filter((j) => j.state === 'pending' || j.state === 'running');
    for (const job of open) {
      if (bookId && job.bookId !== bookId) continue;
      // Never re-queue something this pool already has in hand — otherwise a
      // second `resume()` call duplicating work is indistinguishable from a
      // genuine crash recovery.
      if (this.knownJobIds.has(job.id)) continue;
      // Re-arm crashed "running" jobs as pending (attempt counted in failJob).
      if (job.state === 'running') await this.repo.updateJob(job.id, { state: 'pending' });
      this.knownJobIds.add(job.id);
      this.queue.push({ job: { ...job, state: 'pending' }, resolve: () => undefined });
    }
    this.pump();
    return open.length;
  }

  private pump() {
    if (this.stopped) return;
    while (this.queue.length > 0 && this.busy.size < this.maxWorkers) {
      const next = this.queue.shift();
      if (!next) break;
      void this.runJob(next.job);
    }
    if (this.queue.length === 0 && this.busy.size === 0) {
      this.emit({ type: 'queue-empty' });
    }
  }

  private async runJob(job: JobRecord) {
    const { job: fresh } = { job };
    // Re-read the job to avoid double-processing after a resume race.
    const stored = await this.repo.getJob(job.id);
    if (!stored || stored.state === 'completed' || stored.state === 'cancelled') return;

    const page = await this.repo.getPage(fresh.pageId);
    if (!page) {
      await this.repo.updateJob(fresh.id, { state: 'failed', lastError: 'page missing' });
      return;
    }
    // A page already marked done with a model is skipped unless it's a reprocess.
    if (fresh.type === 'process' && page.status === 'done' && page.pageModel) {
      await this.repo.updateJob(fresh.id, { state: 'completed' });
      return;
    }

    await this.repo.updateJob(fresh.id, { state: 'running', attempts: stored.attempts + 1 });
    await this.repo.updatePageStatus(page.id, 'processing', { stage: 'preprocess', progress: 0.05 });

    const workerIndex = this.findFreeWorkerIndex();
    const worker = this.ensureWorker(workerIndex);
    this.busy.add(workerIndex);
    const msgId = this.nextMsgId++;
    /**
     * Watchdog. A worker can stop answering without firing `onerror` — a WASM
     * allocation failure inside Tesseract does exactly that, leaving the page
     * "processing" forever with no way for the UI to recover. A hard timeout
     * turns that into a normal, retryable failure.
     */
    const watchdog = setTimeout(() => {
      const pending = this.pendingByMsgId.get(msgId);
      if (!pending) return;
      this.pendingByMsgId.delete(msgId);
      this.busy.delete(pending.workerIndex);
      try {
        this.workers[pending.workerIndex]?.terminate();
      } catch {
        /* ignore */
      }
      this.workers[pending.workerIndex] = undefined as unknown as Worker;
      this.emit({ type: 'worker-error', error: 'worker timed out' });
      void this.failJob(pending.job, 'processing timed out — the page can be retried');
      this.pump();
    }, JOB_TIMEOUT_MS);
    this.pendingByMsgId.set(msgId, { job: fresh, startedAt: Date.now(), workerIndex, watchdog });

    const opts = (fresh.options ?? {}) as {
      languages?: string[];
      profile?: string;
      arabicFont?: string;
      latinFont?: string;
      reviewThreshold?: number;
    };

    const message: WorkerJobMessage = {
      type: 'process',
      id: msgId,
      blob: page.originalImage,
      options: {
        pageId: page.id,
        sequence: page.order + 1,
        languages: opts.languages?.length ? opts.languages : ['ara', 'eng'],
        profile: opts.profile ?? 'standard',
        arabicFont: opts.arabicFont,
        latinFont: opts.latinFont,
        reviewThreshold: opts.reviewThreshold ?? 70,
        maxLongEdge: 2000,
      },
    };

    try {
      // Transferable blob isn't possible; structured clone of Blob is cheap.
      worker.postMessage(message);
    } catch (err) {
      clearTimeout(watchdog);
      this.pendingByMsgId.delete(msgId);
      this.busy.delete(workerIndex);
      await this.failJob(fresh, (err as Error).message);
      this.pump();
    }
  }

  private findFreeWorkerIndex(): number {
    for (let i = 0; i < this.maxWorkers; i++) {
      if (!this.busy.has(i)) return i;
    }
    return 0;
  }

  private handleWorkerMessage(workerIndex: number, msg: WorkerOut) {
    const pending = this.pendingByMsgId.get(msg.id);
    if (!pending) return;

    if (msg.type === 'progress') {
      void this.repo.updateJob(pending.job.id, { progress: msg.value, stage: msg.stage as never });
      void this.repo.updatePage(pending.job.pageId, {
        progress: msg.value,
        stage: msg.stage as never,
      });
      this.emit({
        type: 'job-progress',
        jobId: pending.job.id,
        pageId: pending.job.pageId,
        value: msg.value,
        stage: msg.stage,
      });
      return;
    }

    if (msg.type === 'error') {
      clearTimeout(pending.watchdog);
      this.pendingByMsgId.delete(msg.id);
      this.busy.delete(workerIndex);
      void this.failJob(pending.job, msg.error);
      this.pump();
      return;
    }

    if (msg.type === 'done') {
      clearTimeout(pending.watchdog);
      this.pendingByMsgId.delete(msg.id);
      this.busy.delete(workerIndex);
      void this.completeJob(pending.job, msg.result, Date.now() - pending.startedAt);
      this.pump();
    }
  }

  private async completeJob(
    job: JobRecord,
    result: WorkerDone['result'],
    ms: number,
  ): Promise<void> {
    const page = await this.repo.getPage(job.pageId);
    if (!page) {
      await this.repo.updateJob(job.id, { state: 'failed', lastError: 'page disappeared' });
      return;
    }

    const reviewThreshold = Number((job.options as { reviewThreshold?: number })?.reviewThreshold ?? 70);
    const hasText = result.model.blocks.some((b) => b.type !== 'illustration' && b.text.trim().length > 0);
    const warnings = result.warnings ?? [];
    const ocrFailed = warnings.includes('ocr-failed');

    let status: PageStatus;
    if (page.blank) status = 'blank';
    else if (ocrFailed && !hasText) status = 'failed';
    else if (!hasText) status = 'review';
    else if (result.avgConfidence < reviewThreshold) status = 'review';
    else status = 'done';

    // Protect manual edits: keep the user's text/model unless the job was
    // explicitly allowed to replace it.
    const allowReplace = Boolean((job.options as { allowReplaceEdits?: boolean })?.allowReplaceEdits);
    if (page.userEdited && page.pageModel && !allowReplace) {
      await this.repo.savePageModel({
        pageId: page.id,
        model: page.pageModel,
        avgConfidence: page.avgConfidence,
        status: page.reviewed ? 'done' : 'review',
        metricsPatch: { ...result.metrics, processingMs: ms },
      });
      await this.repo.updateJob(job.id, {
        state: 'completed',
        progress: 1,
        lastError: 'user edits preserved (auto-reprocess skipped)',
      });
      this.emit({ type: 'job-done', jobId: job.id, pageId: page.id, status, confidence: page.avgConfidence, ms });
      return;
    }

    const processedBlob = new Blob([result.processed.buffer], { type: result.processed.type });
    await this.repo.savePageModel({
      pageId: page.id,
      model: result.model,
      processedImage: processedBlob,
      avgConfidence: result.avgConfidence,
      status,
      keepEdit: true,
      metricsPatch: {
        processingMs: ms,
        preprocessMs: result.metrics.preprocessMs,
        ocrMs: result.metrics.ocrMs,
        sharpness: result.metrics.sharpness,
        brightness: result.metrics.brightness,
        coverage: result.metrics.coverage,
        detectionConfidence: result.metrics.detectionConfidence,
      },
    });
    await this.repo.updatePage(job.pageId, {
      thumb: result.thumb || page.thumb,
      width: result.width,
      height: result.height,
      language: result.model.language,
      direction: result.model.direction,
      printedPageNumber: result.model.printedNumber,
      status,
      stage: 'done',
      progress: 1,
    });
    await this.repo.updateJob(job.id, { state: 'completed', progress: 1, stage: 'done' });

    // Update the search index incrementally.
    const book = await this.repo.getBook(job.bookId);
    if (book) {
      const rows = await this.repo.listPageRows(job.bookId);
      const index = rows.findIndex((r) => r.id === page.id);
      getSearchIndex().upsert({
        bookId: book.id,
        bookTitle: book.title,
        author: book.author,
        pageId: page.id,
        pageNumber: index + 1,
        printedNumber: result.model.printedNumber,
        displayText: modelPlainText(result.model),
        language: result.model.language,
        status,
      });
      await this.repo.recomputeBookStats(book.id);
    }

    this.emit({
      type: 'job-done',
      jobId: job.id,
      pageId: page.id,
      status,
      confidence: result.avgConfidence,
      ms,
    });
  }

  private async failJob(job: JobRecord, error: string): Promise<void> {
    const stored = await this.repo.getJob(job.id);
    const attempts = stored?.attempts ?? 1;
    const maxAttempts = stored?.maxAttempts ?? 3;
    const shouldRetry = attempts < maxAttempts;

    await this.repo.updateJob(job.id, {
      state: shouldRetry ? 'pending' : 'failed',
      lastError: error.slice(0, 500),
    });

    if (shouldRetry) {
      // Exponential backoff, then re-queue (the original capture is untouched).
      const delay = Math.min(8000, 800 * 2 ** attempts);
      this.emit({ type: 'job-failed', jobId: job.id, pageId: job.pageId, error, attempts });
      setTimeout(() => {
        this.queue.push({ job: { ...job, state: 'pending' }, resolve: () => undefined });
        this.pump();
      }, delay);
      return;
    }

    // Final failure: keep the page + original image, mark for manual retry.
    await this.repo.updatePageStatus(job.pageId, 'failed', { stage: 'failed', progress: 0 });
    this.emit({ type: 'job-failed', jobId: job.id, pageId: job.pageId, error, attempts });
  }

  /** Retry a page whose job finally failed (never creates a duplicate page). */
  async retry(pageId: string, bookId: string): Promise<void> {
    const jobs = await this.repo.listJobs({ bookId });
    const failed = jobs.filter((j) => j.pageId === pageId && (j.state === 'failed' || j.state === 'pending'));
    for (const j of failed) {
      await this.repo.updateJob(j.id, { state: 'cancelled' });
    }
    const page = await this.repo.getPage(pageId);
    const book = await this.repo.getBook(bookId);
    if (!page || !book) return;
    await this.enqueue(pageId, bookId, {
      languages: book.settings.ocrLanguages,
      profile: book.settings.captureProfile,
      arabicFont: book.defaultFonts.arabicFont,
      latinFont: book.defaultFonts.latinFont,
      reviewThreshold: book.settings.reviewThreshold,
      reprocess: true,
    });
  }

  /** Toggle the review flag once a human has checked the page. */
  async markReviewed(pageId: string, bookId: string, reviewed: boolean): Promise<void> {
    await this.repo.updatePage(pageId, {
      reviewed,
      status: reviewed ? 'done' : 'review',
    });
    await this.repo.recomputeBookStats(bookId);
  }

  stop(): void {
    this.stopped = true;
    for (const entry of this.pendingByMsgId.values()) clearTimeout(entry.watchdog);
    for (const w of this.workers) w?.terminate();
    this.workers = [];
    this.busy.clear();
    this.pendingByMsgId.clear();
    this.knownJobIds.clear();
    this.queue = [];
  }

  get activeBookId(): string | null {
    return this.currentBookId;
  }

  setActiveBook(bookId: string | null): void {
    this.currentBookId = bookId;
  }
}

/* ------------------------------------------------------------------ */
/* Singleton (one pool per tab)                                        */
/* ------------------------------------------------------------------ */

let pool: ProcessingPool | null = null;

export function getProcessingPool(repo: Repository): ProcessingPool {
  if (!pool) pool = new ProcessingPool({ repo });
  return pool;
}

export function resetProcessingPool(): void {
  pool?.stop();
  pool = null;
}
