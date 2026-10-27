'use client';

/**
 * Accessible toast notifications.
 * Uses role="status"/aria-live so screen readers announce progress and errors
 * without stealing focus.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

export type ToastTone = 'info' | 'success' | 'warn' | 'error';

export interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
  /** ms; 0 keeps it until dismissed. */
  duration?: number;
}

interface ToastContextValue {
  push: (message: string, tone?: ToastTone, duration?: number) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((message: string, tone: ToastTone = 'info', duration = 4200) => {
    const id = ++counter.current;
    setItems((prev) => [...prev.slice(-3), { id, message, tone, duration }]);
    if (duration > 0) setTimeout(() => dismiss(id), duration);
    return id;
  }, [dismiss]);

  const value = useMemo(() => ({ push, dismiss }), [push, dismiss]);

  const tones: Record<ToastTone, string> = {
    info: 'border-[var(--camscan-border)] bg-[var(--camscan-surface)]',
    success: 'border-[var(--color-accent-300)] bg-[var(--color-accent-50)] text-[var(--color-accent-700)]',
    warn: 'border-[#e8cf9a] bg-[var(--color-warn-100)] text-[var(--color-warn-500)]',
    error: 'border-[#f0c3bb] bg-[#fbe9e6] text-[var(--color-danger-600)]',
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-4 z-[100] flex flex-col items-center gap-2 px-4 no-print"
        role="status"
        aria-live="polite"
      >
        {items.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-lg ${tones[t.tone]}`}
          >
            <span className="flex-1 leading-relaxed">{t.message}</span>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              className="rounded p-0.5 opacity-60 hover:opacity-100"
              aria-label="إغلاق / Dismiss"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
