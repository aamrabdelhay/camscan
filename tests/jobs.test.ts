/**
 * Job state machine.
 *
 * The rules that keep the scanner trustworthy:
 *  - a job is idempotent per (page, type): re-enqueuing must not create a second
 *    open job for the same page
 *  - a failed job is retried with backoff but never duplicates the page
 *  - a "running" job left behind by a closed tab is re-armed, not silently lost
 *  - the original capture is never touched by any transition
 */
import { describe, expect, it } from 'vitest';
import {
  backoffMs,
  canTransition,
  isOpen,
  nextState,
  planResume,
  type JobStateLike,
} from '@/lib/jobs';

function job(state: JobStateLike['state'], attempts = 1, maxAttempts = 3): JobStateLike {
  return { id: `j_${state}_${attempts}`, state, attempts, maxAttempts, pageId: 'p1', bookId: 'b1' };
}

describe('job states', () => {
  it('treats pending and running as open', () => {
    expect(isOpen(job('pending'))).toBe(true);
    expect(isOpen(job('running'))).toBe(true);
    expect(isOpen(job('completed'))).toBe(false);
    expect(isOpen(job('failed'))).toBe(false);
    expect(isOpen(job('cancelled'))).toBe(false);
  });

  it('allows only sensible transitions', () => {
    expect(canTransition('pending', 'running')).toBe(true);
    expect(canTransition('running', 'completed')).toBe(true);
    expect(canTransition('running', 'pending')).toBe(true);   // retry
    expect(canTransition('running', 'failed')).toBe(true);
    expect(canTransition('failed', 'pending')).toBe(true);    // manual retry
    expect(canTransition('completed', 'running')).toBe(false); // never resurrect
    expect(canTransition('cancelled', 'running')).toBe(false);
  });
});

describe('retry policy', () => {
  it('retries until maxAttempts, then gives up', () => {
    expect(nextState(job('running', 1, 3), 'retryable')).toBe('pending');
    expect(nextState(job('running', 2, 3), 'retryable')).toBe('pending');
    expect(nextState(job('running', 3, 3), 'retryable')).toBe('failed');
  });

  it('does not retry a permanent error', () => {
    expect(nextState(job('running', 1, 3), 'permanent')).toBe('failed');
  });

  it('backs off exponentially but caps the delay', () => {
    expect(backoffMs(1)).toBeLessThan(backoffMs(2));
    expect(backoffMs(2)).toBeLessThan(backoffMs(3));
    expect(backoffMs(20)).toBeLessThanOrEqual(8000);
  });
});

describe('resume after a closed tab', () => {
  it('re-arms running jobs (they were interrupted) and keeps pending ones', () => {
    const jobs = [job('running', 1), job('pending', 1), job('completed', 1), job('failed', 3)];
    const plan = planResume(jobs);
    expect(plan.map((p) => p.id).sort()).toEqual([jobs[0].id, jobs[1].id].sort());
    // An interrupted job keeps its attempt count — a crash must not reset it,
    // otherwise a page that kills the worker would loop forever.
    expect(plan.find((p) => p.id === jobs[0].id)?.state).toBe('pending');
    expect(plan.find((p) => p.id === jobs[0].id)?.attempts).toBe(1);
  });

  it('does not resurrect completed or finally-failed jobs', () => {
    const plan = planResume([job('completed', 1), job('failed', 3)]);
    expect(plan).toHaveLength(0);
  });

  it('is idempotent: resuming twice yields the same plan', () => {
    const jobs = [job('running', 1)];
    expect(planResume(jobs)).toEqual(planResume(jobs));
  });
});
