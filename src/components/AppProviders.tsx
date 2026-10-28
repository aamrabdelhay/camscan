'use client';

/**
 * App-wide client providers: settings (theme, UI language), repository handle,
 * search index bootstrap and service-worker registration.
 *
 * The layout is a server component; everything stateful lives here so the app
 * still works with `output: export`-style static hosting later.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createLocalRepository, type Repository } from '@/lib/repository';
import type { AppSettings, ThemePreference, UiLanguage } from '@/lib/types';
import { getSearchIndex, rebuildIndex } from '@/lib/search';
import { DEFAULT_APP_SETTINGS } from '@/lib/repository';

interface AppContextValue {
  repo: Repository;
  settings: AppSettings;
  ready: boolean;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  setUiLanguage: (lang: UiLanguage) => Promise<void>;
  setTheme: (theme: ThemePreference) => Promise<void>;
  /** 0..1 storage usage, or null when the API is unavailable. */
  storageRatio: number | null;
  /** Rebuilds the search index from IndexedDB (called on start/restore). */
  refreshSearchIndex: (force?: boolean) => Promise<number>;
  /** Set when IndexedDB is unavailable (private mode, etc.). */
  fatalError: string | null;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside <AppProviders>');
  return ctx;
}

function applyTheme(theme: ThemePreference): void {
  if (typeof document === 'undefined') return;
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  const resolved = theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}

function applyLanguage(lang: UiLanguage): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
}

export function AppProviders({ children }: { children: React.ReactNode }) {
  const repo = useMemo(() => {
    try {
      return createLocalRepository();
    } catch {
      // Extremely old browsers / sandboxed iframes without IndexedDB.
      return null as unknown as Repository;
    }
  }, []);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [ready, setReady] = useState(false);
  const [storageRatio, setStorageRatio] = useState<number | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const indexedRef = useRef(false);

  /* ---- bootstrap settings, index, theme ---- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!repo) throw new Error('IndexedDB unavailable');
        const s = await repo.getSettings();
        if (cancelled) return;
        setSettings(s);
        applyTheme(s.theme);
        applyLanguage(s.uiLanguage);
        setReady(true);
      } catch (err) {
        if (cancelled) return;
        setFatalError((err as Error).message || 'Storage unavailable');
        setReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, [repo]);

  /* ---- system theme changes ---- */
  useEffect(() => {
    if (settings.theme !== 'system' || typeof window === 'undefined') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => applyTheme('system');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [settings.theme]);

  /* ---- storage estimate refresh ---- */
  const refreshStorage = useCallback(async () => {
    if (!repo) return;
    const est = await repo.storageEstimate();
    if (est && est.quota > 0) setStorageRatio(est.usage / est.quota);
  }, [repo]);

  useEffect(() => {
    if (!ready) return;
    void refreshStorage();
    const id = setInterval(() => void refreshStorage(), 60_000);
    return () => clearInterval(id);
  }, [ready, refreshStorage]);

  const refreshSearchIndex = useCallback(async (force = false): Promise<number> => {
    if (!repo) return 0;
    if (indexedRef.current && !force) return getSearchIndex().size;
    const books = await repo.listBooks();
    const rows: Array<{
      bookId: string; bookTitle: string; author?: string; pageId: string;
      pageNumber: number; printedNumber?: string; displayText: string;
      language?: string; status?: string;
    }> = [];
    for (const book of books) {
      const pages = await repo.listPageRows(book.id);
      pages.forEach((p, i) => {
        if (!p.plainText?.trim() && !p.pageModel) return;
        rows.push({
          bookId: book.id,
          bookTitle: book.title,
          author: book.author,
          pageId: p.id,
          pageNumber: i + 1,
          printedNumber: p.printedPageNumber,
          displayText: p.plainText ?? '',
          language: p.language,
          status: p.status,
        });
      });
    }
    await rebuildIndex(rows);
    indexedRef.current = true;
    return rows.length;
  }, [repo]);

  /* ---- build index once after boot ---- */
  useEffect(() => {
    if (!ready || fatalError) return;
    void refreshSearchIndex();
  }, [ready, fatalError, refreshSearchIndex]);

  /* ---- service worker (PWA / offline) ---- */
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    if (process.env.NODE_ENV !== 'production') return; // avoid dev caching confusion
    const timer = setTimeout(() => {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        console.warn('Service worker registration failed:', err);
      });
    }, 1200);
    return () => clearTimeout(timer);
  }, []);

  const updateSettings = useCallback(async (patch: Partial<AppSettings>) => {
    if (!repo) return;
    const next = await repo.saveSettings(patch);
    setSettings(next);
    if (patch.theme) applyTheme(next.theme);
    if (patch.uiLanguage) applyLanguage(next.uiLanguage);
  }, [repo]);

  const setUiLanguage = useCallback((lang: UiLanguage) => updateSettings({ uiLanguage: lang }), [updateSettings]);
  const setTheme = useCallback((theme: ThemePreference) => updateSettings({ theme }), [updateSettings]);

  const value: AppContextValue = {
    repo,
    settings,
    ready,
    updateSettings,
    setUiLanguage,
    setTheme,
    storageRatio,
    refreshSearchIndex,
    fatalError,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
