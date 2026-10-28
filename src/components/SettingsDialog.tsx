'use client';

/**
 * Global settings: interface language, theme, OCR languages, capture profile,
 * auto-capture, backup/restore, storage health, privacy + known limitations.
 * Everything here is ephemeral local preference data except backup/restore,
 * which reads and writes the library.
 */
import { useEffect, useRef, useState } from 'react';
import { useApp } from './AppProviders';
import { useToast } from './Toast';
import { Button, Modal, Progress, Select } from './ui';
import { OCR_LANGUAGE_OPTIONS, t } from '@/lib/i18n';
import { exportLibraryToZip, importLibraryFromZip } from '@/lib/backup';
import { downloadBlob } from '@/lib/pdf/browserExport';
import type { CaptureProfileId } from '@/lib/types';
import { getSearchIndex } from '@/lib/search';

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { settings, updateSettings, repo, storageRatio, refreshSearchIndex } = useApp();
  const { push } = useToast();
  const lang = settings.uiLanguage;
  const [backupBusy, setBackupBusy] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreProgress, setRestoreProgress] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const [indexSize, setIndexSize] = useState(0);

  useEffect(() => {
    if (open) setIndexSize(getSearchIndex().size);
  }, [open]);

  const handleBackup = async () => {
    setBackupBusy(true);
    try {
      const blob = await exportLibraryToZip(repo, (done, total) => {
        if (total && done % 10 === 0) push(`${done}/${total}`, 'info', 1200);
      });
      // The exporter returns the ZIP; starting the download is the caller's job
      // (it owns the user gesture). Forgetting this made Settings show
      // "backup created" while nothing was ever saved.
      const stamp = new Date().toISOString().slice(0, 10);
      downloadBlob(blob, `camscan-backup-${stamp}.zip`);
      push(t(lang, 'backupDone'), 'success');
    } catch (err) {
      push((err as Error).message, 'error');
    } finally {
      setBackupBusy(false);
    }
  };

  const handleRestore = async (file: File) => {
    setRestoreBusy(true);
    setRestoreProgress(0);
    try {
      const summary = await importLibraryFromZip(repo, file, (p) => setRestoreProgress(p));
      if (summary.settings) await updateSettings(summary.settings);
      // Restore runs after initial app boot, when the search index is already
      // marked initialized. Force rebuilding so restored text is searchable
      // immediately without asking the user to reload the page.
      await refreshSearchIndex(true);
      push(`${t(lang, 'backupRestoreDone')} — ${summary.books} ${t(lang, 'books')} · ${summary.pages} ${t(lang, 'pages')}`, 'success', 6000);
      onClose();
    } catch (err) {
      push(`${t(lang, 'backupInvalid')}: ${(err as Error).message}`, 'error', 8000);
    } finally {
      setRestoreBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t(lang, 'settings')}
      size="lg"
      footer={<Button variant="primary" onClick={onClose}>{t(lang, 'close')}</Button>}
    >
      <div className="space-y-6">
        {/* Language + theme */}
        <section className="grid gap-4 sm:grid-cols-2">
          <Select
            label={t(lang, 'interfaceLanguage')}
            value={settings.uiLanguage}
            onChange={(e) => void updateSettings({ uiLanguage: e.target.value as 'ar' | 'en' })}
          >
            <option value="ar">العربية</option>
            <option value="en">English</option>
          </Select>
          <Select
            label={t(lang, 'theme')}
            value={settings.theme}
            onChange={(e) => void updateSettings({ theme: e.target.value as 'light' | 'dark' | 'system' })}
          >
            <option value="system">{t(lang, 'themeSystem')}</option>
            <option value="light">{t(lang, 'themeLight')}</option>
            <option value="dark">{t(lang, 'themeDark')}</option>
          </Select>
        </section>

        {/* OCR languages */}
        <section>
          <h3 className="mb-1 text-sm font-semibold">{t(lang, 'ocrLanguage')}</h3>
          <p className="mb-2 text-xs text-[var(--camscan-text-muted)]">{t(lang, 'ocrLanguageHint')}</p>
          <div className="flex flex-wrap gap-2">
            {OCR_LANGUAGE_OPTIONS.map((opt) => {
              const checked = settings.ocrLanguages.includes(opt.code);
              return (
                <label
                  key={opt.code}
                  className={`inline-flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-sm ${
                    checked ? 'border-[var(--camscan-accent)] bg-[var(--color-accent-50)] text-[var(--color-accent-700)]' : 'border-[var(--camscan-border)]'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={checked}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...settings.ocrLanguages, opt.code]
                        : settings.ocrLanguages.filter((c) => c !== opt.code);
                      void updateSettings({ ocrLanguages: next.length ? next : ['eng'] });
                    }}
                  />
                  <span aria-hidden="true">{checked ? '✓' : '○'}</span>
                  {opt.label}
                  <span className="text-[10px] opacity-70">{opt.sizeMB}MB</span>
                </label>
              );
            })}
          </div>
        </section>

        {/* Capture profile + auto-capture */}
        <section className="grid gap-4 sm:grid-cols-2">
          <Select
            label={t(lang, 'captureProfile')}
            value={settings.captureProfile}
            onChange={(e) => void updateSettings({ captureProfile: e.target.value as CaptureProfileId })}
          >
            <option value="standard">{t(lang, 'profileStandard')}</option>
            <option value="fragile">{t(lang, 'profileFragile')}</option>
            <option value="smallPrint">{t(lang, 'profileSmallPrint')}</option>
            <option value="fadedInk">{t(lang, 'profileFadedInk')}</option>
            <option value="historical">{t(lang, 'profileHistorical')}</option>
          </Select>
          <label className="flex items-center justify-between gap-3 self-end rounded-xl border border-[var(--camscan-border)] px-3 py-2.5">
            <span className="text-sm">{t(lang, 'autoCapture')}</span>
            <input
              type="checkbox"
              checked={settings.autoCapture}
              onChange={(e) => void updateSettings({ autoCapture: e.target.checked })}
              className="h-5 w-5 accent-[var(--camscan-accent)]"
            />
          </label>
        </section>

        {/* Storage */}
        <section>
          <h3 className="mb-1 text-sm font-semibold">{t(lang, 'storage')}</h3>
          {storageRatio !== null ? (
            <>
              <Progress value={storageRatio} label={`${Math.round(storageRatio * 100)}%`} tone={storageRatio > 0.85 ? 'warn' : 'accent'} />
              <p className="mt-1 text-xs text-[var(--camscan-text-muted)]">{t(lang, 'limitation5')}</p>
            </>
          ) : (
            <p className="text-xs text-[var(--camscan-text-muted)]">—</p>
          )}
          <p className="mt-2 text-xs text-[var(--camscan-text-muted)]">
            index: {indexSize} docs
          </p>
        </section>

        {/* Backup / restore */}
        <section>
          <h3 className="mb-1 text-sm font-semibold">{t(lang, 'backupTitle')}</h3>
          <p className="mb-3 text-xs text-[var(--camscan-text-muted)]">{t(lang, 'backupHelp')}</p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void handleBackup()} loading={backupBusy} variant="secondary">
              {t(lang, 'backupCreate')}
            </Button>
            <Button onClick={() => fileRef.current?.click()} loading={restoreBusy} variant="secondary">
              {t(lang, 'backupRestore')}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleRestore(file);
                e.target.value = '';
              }}
            />
          </div>
          {restoreBusy ? (
            <Progress className="mt-3" value={restoreProgress} label={t(lang, 'backupRestoring')} />
          ) : null}
        </section>

        {/* Privacy + limitations */}
        <section className="rounded-xl border border-[var(--camscan-border)] bg-[var(--camscan-surface-2)] p-3">
          <h3 className="mb-1 text-sm font-semibold">🔒 {t(lang, 'privacyNote')}</h3>
          <h4 className="mt-3 text-xs font-semibold uppercase tracking-wide text-[var(--camscan-text-muted)]">
            {t(lang, 'limitations')}
          </h4>
          <ul className="mt-1 space-y-1 text-xs text-[var(--camscan-text-muted)]">
            <li>• {t(lang, 'limitation1')}</li>
            <li>• {t(lang, 'limitation2')}</li>
            <li>• {t(lang, 'limitation3')}</li>
            <li>• {t(lang, 'limitation4')}</li>
            <li>• {t(lang, 'limitation5')}</li>
          </ul>
        </section>
      </div>
    </Modal>
  );
}
