'use client';

/**
 * CamScan — shared presentational primitives.
 * Small, dependency-free, accessible building blocks used across screens.
 */
import { forwardRef, useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';

/* ------------------------------------------------------------------ */
/* Button                                                              */
/* ------------------------------------------------------------------ */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'xl';

const base =
  'inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed select-none';

const variants: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--camscan-text)] text-[var(--camscan-bg)] hover:opacity-90 active:opacity-80',
  accent:
    'bg-[var(--camscan-accent)] text-[var(--camscan-accent-contrast)] hover:brightness-105 active:brightness-95',
  secondary:
    'bg-[var(--camscan-surface)] text-[var(--camscan-text)] border border-[var(--camscan-border)] hover:bg-[var(--camscan-surface-2)]',
  ghost:
    'bg-transparent text-[var(--camscan-text)] hover:bg-[var(--camscan-surface-2)]',
  danger:
    'bg-[var(--color-danger-500)] text-white hover:bg-[var(--color-danger-600)]',
};

const sizes: Record<ButtonSize, string> = {
  sm: 'h-9 px-3 text-sm',
  md: 'h-11 px-4 text-[15px]',
  lg: 'h-12 px-5 text-base',
  xl: 'h-14 px-7 text-lg',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', className = '', loading, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <Spinner size={16} />}
      {children}
    </button>
  );
});

export function Spinner({ size = 18, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      className={`animate-spin ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Cards & surfaces                                                    */
/* ------------------------------------------------------------------ */

export function Card({ className = '', children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={`rounded-2xl border border-[var(--camscan-border)] bg-[var(--camscan-surface)] shadow-[0_1px_2px_rgba(36,29,18,0.04)] ${className}`}
    >
      {children}
    </div>
  );
}

export function SectionTitle({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3">
      <h2 className="text-lg font-semibold tracking-tight">{children}</h2>
      {hint ? <div className="text-sm text-[var(--camscan-text-muted)]">{hint}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Badges                                                              */
/* ------------------------------------------------------------------ */

export type Tone = 'neutral' | 'success' | 'warn' | 'danger' | 'info';

const tones: Record<Tone, string> = {
  neutral: 'bg-[var(--camscan-surface-2)] text-[var(--camscan-text-muted)] border-[var(--camscan-border)]',
  success: 'bg-[var(--color-accent-50)] text-[var(--color-accent-700)] border-[var(--color-accent-300)]',
  warn: 'bg-[var(--color-warn-100)] text-[var(--color-warn-500)] border-[#e8cf9a]',
  danger: 'bg-[#fbe9e6] text-[var(--color-danger-600)] border-[#f0c3bb]',
  info: 'bg-[#eef2fb] text-[#3c548f] border-[#c8d4ef]',
};

export function Badge({
  tone = 'neutral',
  children,
  className = '',
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

export interface FieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string;
  /** Hide the label visually but keep it for screen readers. */
  srOnlyLabel?: boolean;
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, hint, error, srOnlyLabel, className = '', id, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <div className="w-full">
      <label
        htmlFor={inputId}
        className={srOnlyLabel ? 'sr-only' : 'mb-1.5 block text-sm font-medium text-[var(--camscan-text)]'}
      >
        {label}
      </label>
      <input
        ref={ref}
        id={inputId}
        aria-describedby={hint || error ? `${inputId}-desc` : undefined}
        aria-invalid={error ? true : undefined}
        className={`h-11 w-full rounded-xl border bg-[var(--camscan-surface)] px-3 text-[15px] text-[var(--camscan-text)] placeholder:text-[var(--camscan-text-muted)]/70 ${
          error ? 'border-[var(--color-danger-500)]' : 'border-[var(--camscan-border)]'
        } ${className}`}
        {...rest}
      />
      {(hint || error) && (
        <p
          id={`${inputId}-desc`}
          className={`mt-1 text-xs ${error ? 'text-[var(--color-danger-600)]' : 'text-[var(--camscan-text-muted)]'}`}
        >
          {error ?? hint}
        </p>
      )}
    </div>
  );
});

export function Select({
  label,
  children,
  className = '',
  id,
  hint,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement> & { label?: string; hint?: string }) {
  const autoId = useId();
  const selectId = id ?? autoId;
  return (
    <div className="w-full">
      {label ? (
        <label htmlFor={selectId} className="mb-1.5 block text-sm font-medium">
          {label}
        </label>
      ) : null}
      <select
        id={selectId}
        className={`h-11 w-full rounded-xl border border-[var(--camscan-border)] bg-[var(--camscan-surface)] px-3 text-[15px] ${className}`}
        {...rest}
      >
        {children}
      </select>
      {hint ? <p className="mt-1 text-xs text-[var(--camscan-text-muted)]">{hint}</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Modal / dialog                                                      */
/* ------------------------------------------------------------------ */

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
  labelledBy,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  labelledBy?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // Move focus into the dialog for keyboard/screen-reader users.
    const t = setTimeout(() => {
      const first = ref.current?.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      first?.focus();
    }, 30);
    return () => {
      document.removeEventListener('keydown', onKey);
      clearTimeout(t);
    };
  }, [open, onClose]);

  if (!open) return null;
  const widths = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-0 sm:items-center sm:p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="presentation"
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy ?? titleId}
        className={`w-full ${widths[size]} rounded-t-3xl border border-[var(--camscan-border)] bg-[var(--camscan-surface)] p-5 shadow-2xl sm:rounded-2xl`}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق / Close"
            className="rounded-lg p-2 text-[var(--camscan-text-muted)] hover:bg-[var(--camscan-surface-2)]"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="max-h-[70dvh] overflow-y-auto camscan-scroll">{children}</div>
        {footer ? <div className="mt-5 flex flex-wrap justify-end gap-2">{footer}</div> : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Progress                                                            */
/* ------------------------------------------------------------------ */

export function Progress({
  value,
  label,
  tone = 'accent',
  className = '',
}: {
  value: number;
  label?: string;
  tone?: 'accent' | 'warn' | 'danger';
  className?: string;
}) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  const colors = {
    accent: 'bg-[var(--camscan-accent)]',
    warn: 'bg-[var(--color-warn-500)]',
    danger: 'bg-[var(--color-danger-500)]',
  };
  return (
    <div className={className}>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label={label}
        className="h-2 w-full overflow-hidden rounded-full bg-[var(--camscan-border)]/60"
      >
        <div className={`h-full rounded-full transition-[width] duration-300 ${colors[tone]}`} style={{ width: `${pct}%` }} />
      </div>
      {label ? (
        <div className="mt-1 flex justify-between text-xs text-[var(--camscan-text-muted)]">
          <span>{label}</span>
          <span>{pct}%</span>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Empty state                                                         */
/* ------------------------------------------------------------------ */

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-[var(--camscan-border)] bg-[var(--camscan-surface)]/50 px-6 py-14 text-center">
      {icon ? <div className="mb-3 text-[var(--camscan-text-muted)]">{icon}</div> : null}
      <h3 className="text-base font-semibold">{title}</h3>
      {description ? (
        <p className="mt-1.5 max-w-md text-sm text-[var(--camscan-text-muted)]">{description}</p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Status pill for pages                                               */
/* ------------------------------------------------------------------ */

export function StatusPill({
  status,
  labels,
  reviewed,
}: {
  status: string;
  labels: { done: string; review: string; processing: string; queued: string; failed: string; blank: string };
  reviewed?: boolean;
}) {
  if (status === 'done' && reviewed) return <Badge tone="success">✓ {labels.done}</Badge>;
  if (status === 'done') return <Badge tone="success">{labels.done}</Badge>;
  if (status === 'review') return <Badge tone="warn">⚠ {labels.review}</Badge>;
  if (status === 'failed') return <Badge tone="danger">✕ {labels.failed}</Badge>;
  if (status === 'blank') return <Badge tone="neutral">{labels.blank}</Badge>;
  if (status === 'processing') return <Badge tone="info">● {labels.processing}</Badge>;
  return <Badge tone="neutral">○ {labels.queued}</Badge>;
}
