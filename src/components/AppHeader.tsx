'use client';

/**
 * Global header: identity, language toggle, theme, settings, storage health.
 * Used by the library and the reader; the scanner has its own minimal chrome.
 */
import Link from 'next/link';
import { useApp } from './AppProviders';
import { t } from '@/lib/i18n';
import { Badge, Button } from './ui';
import { useState } from 'react';
import { SettingsDialog } from './SettingsDialog';
import { Logo } from './Logo';

export function AppHeader({ compact = false }: { compact?: boolean }) {
  const { settings, setUiLanguage, setTheme, storageRatio } = useApp();
  const lang = settings.uiLanguage;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const storageWarn = storageRatio !== null && storageRatio > 0.85;

  return (
    <header className="sticky top-0 z-30 border-b border-[var(--camscan-border)] bg-[var(--camscan-bg)]/92 backdrop-blur no-print">
      <div className="mx-auto flex w-full max-w-7xl items-center gap-2 px-3 py-2.5 sm:gap-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2" aria-label="CamScan">
          <Logo size={compact ? 28 : 32} />
          <span className="font-[family-name:var(--font-arabic-display)] text-lg font-bold tracking-tight">
            {lang === 'ar' ? 'كام سكان' : 'CamScan'}
          </span>
        </Link>

        <div className="ms-auto flex items-center gap-1.5">
          {storageWarn ? (
            <Badge tone="warn" title={t(lang, 'storageWarning')} className="hidden sm:inline-flex">
              ● {t(lang, 'storage')}
            </Badge>
          ) : null}

          <div
            className="flex overflow-hidden rounded-lg border border-[var(--camscan-border)]"
            role="group"
            aria-label={t(lang, 'interfaceLanguage')}
          >
            <button
              type="button"
              onClick={() => void setUiLanguage('ar')}
              aria-pressed={lang === 'ar'}
              className={`px-2.5 py-1.5 text-sm ${lang === 'ar' ? 'bg-[var(--camscan-text)] text-[var(--camscan-bg)]' : 'bg-transparent'}`}
            >
              ع
            </button>
            <button
              type="button"
              onClick={() => void setUiLanguage('en')}
              aria-pressed={lang === 'en'}
              className={`px-2.5 py-1.5 text-sm ${lang === 'en' ? 'bg-[var(--camscan-text)] text-[var(--camscan-bg)]' : 'bg-transparent'}`}
            >
              EN
            </button>
          </div>

          <button
            type="button"
            onClick={() => void setTheme(settings.theme === 'dark' ? 'light' : 'dark')}
            className="rounded-lg border border-[var(--camscan-border)] p-2"
            aria-label={`${t(lang, 'theme')}: ${t(lang, settings.theme === 'dark' ? 'themeDark' : 'themeLight')}`}
          >
            {settings.theme === 'dark' ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="12" cy="12" r="4.5" stroke="currentColor" strokeWidth="1.8" />
                <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
              </svg>
            )}
          </button>

          <Button variant="ghost" size="sm" onClick={() => setSettingsOpen(true)} aria-label={t(lang, 'settings')}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z" stroke="currentColor" strokeWidth="1.7" />
              <path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l1.7-1.2-1.8-3.1-2 .7a7.5 7.5 0 0 0-2.6-1.5L14.4 3h-3.6l-.3 2.4A7.5 7.5 0 0 0 7.9 6.9l-2-.7L4 9.3l1.7 1.2a7.6 7.6 0 0 0 0 3L4 14.7l1.8 3.1 2-.7a7.5 7.5 0 0 0 2.6 1.5l.3 2.4h3.6l.3-2.4a7.5 7.5 0 0 0 2.6-1.5l2 .7 1.8-3.1-1.6-1.2Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
          </Button>
        </div>
      </div>
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </header>
  );
}
