/**
 * CamScan — job state machine (pure).
 *
 * Processing jobs are persisted in IndexedDB so a page is never lost when the
 * tab closes. This module holds the transition rules on their own so they can be
 * tested, and so `pipeline.ts` cannot quietly drift away from them.
 *
 * Honest scope: while the tab is closed nothing runs. On reopen the pool calls
 * `planResume()` and continues where it stopped.
 */

export type JobStateLike = {
  id: string;
  state: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  attempts: number;
  maxAttempts: number;
  pageId: string;
  bookId: string;
};

export function isOpen(job: Pick<JobStateLike, 'state'>): boolean {
  return job.state === 'pending' || job.state === 'running';
}

const TRANSITIONS: Record<JobStateLike['state'], JobStateLike['state'][]> = {
  pending: ['running', 'cancelled', 'failed'],
  running: ['completed', 'pending', 'failed', 'cancelled'],
  // A finally-failed job can be retried manually; a completed one never restarts.
  failed: ['pending'],
  completed: [],
  cancelled: ['pending'],
};

export function canTransition(from: JobStateLike['state'], to: JobStateLike['state']): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export type FailureKind = 'retryable' | 'permanent';

/**
 * The state a failed attempt should move to. Retryable failures (a crashed
 * worker, a timeout) are retried until `maxAttempts`; permanent ones (a corrupt
 * image) stop immediately so the user is not kept waiting for nothing.
 */
export function nextState(
  job: Pick<JobStateLike, 'attempts' | 'maxAttempts'>,
  kind: FailureKind,
): JobStateLike['state'] {
  if (kind === 'permanent') return 'failed';
  return job.attempts < job.maxAttempts ? 'pending' : 'failed';
}

/** Exponential backoff for retries, capped so the UI stays responsive. */
export function backoffMs(attempts: number): number {
  return Math.min(8000, 800 * 2 ** Math.max(0, attempts));
}

/**
 * Which persisted jobs should be re-queued when the app reopens.
 *
 * A `running` job means the tab died mid-OCR: it is re-armed as `pending`
 * **with its attempt count intact**, otherwise a page that reliably crashes the
 * worker would retry forever.
 */
export function planResume<T extends JobStateLike>(jobs: readonly T[]): Array<T & { state: 'pending' }> {
  return jobs
    .filter(isOpen)
    .map((job) => ({ ...job, state: 'pending' as const }));
}
