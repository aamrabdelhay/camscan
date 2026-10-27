'use client';

/**
 * First-use guidance: safe handling for fragile books + how to get sharp scans.
 * Shown once (tracked in settings.hasSeenTips) and re-openable from the scanner.
 */
import { useApp } from './AppProviders';
import { Button, Modal } from './ui';
import { t } from '@/lib/i18n';

export function TipsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { settings } = useApp();
  const lang = settings.uiLanguage;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t(lang, 'tipsTitle')}
      footer={<Button variant="accent" onClick={onClose}>{t(lang, 'gotIt')}</Button>}
    >
      <div className="space-y-3 text-sm leading-relaxed">
        <Tip icon="🛡️" title={lang === 'ar' ? 'حماية الكتاب' : 'Protect the book'}>
          {t(lang, 'tips1')}
        </Tip>
        <Tip icon="📐" title={lang === 'ar' ? 'ثبّت الكاميرا' : 'Steady the camera'}>
          {t(lang, 'tips2')}
        </Tip>
        <Tip icon="💡" title={lang === 'ar' ? 'الإضاءة' : 'Lighting'}>
          {t(lang, 'tips3')}
        </Tip>
        <Tip icon="⚡" title={lang === 'ar' ? 'التصوير التلقائي' : 'Auto-capture'}>
          {t(lang, 'tips4')}
        </Tip>
        <Tip icon="📜" title={lang === 'ar' ? 'الورق القديم' : 'Old paper'}>
          {t(lang, 'tips5')}
        </Tip>
        <p className="rounded-lg bg-[var(--camscan-surface-2)] p-3 text-xs text-[var(--camscan-text-muted)]">
          {t(lang, 'confidenceNote')}
        </p>
      </div>
    </Modal>
  );
}

function Tip({ icon, title, children }: { icon: string; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span aria-hidden="true" className="text-xl">{icon}</span>
      <div>
        <p className="font-semibold">{title}</p>
        <p className="text-[var(--camscan-text-muted)]">{children}</p>
      </div>
    </div>
  );
}
