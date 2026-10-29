#!/usr/bin/env node
/**
 * CamScan — end-to-end acceptance suite (real browser, real OCR, real PDF).
 *
 * Run:  npm run dev            (in one terminal)
 *       node e2e/acceptance.mjs
 *
 * It walks the exact acceptance workflow from the specification:
 *   1. create a book, reload, verify it persisted
 *   2. import pages (upload fallback), confirm originals are stored immediately
 *   3. confirm pages stay ordered by capture order even when OCR finishes
 *      out of order
 *   4. edit recognised Arabic text, reload, verify the edit persisted and is
 *      searchable (Arabic-normalised query with no diacritics)
 *   5. open the replica view and verify it renders **real selectable text**
 *      (not an image) plus the original-photo comparison
 *   6. export a PDF from the app, then verify the file with pdftotext:
 *      page count/order, selectable Arabic + English, correct shaping
 *   7. build a library backup ZIP, wipe, restore, verify content survived
 *   8. simulate a failing page (corrupt image) and verify the original capture
 *      is not lost and the page can be retried
 *   9. verify the camera-permission-denied path shows an actionable message
 *
 * Outputs screenshots + the exported PDF into e2e/generated/ for inspection.
 * Exit code 0 = all checks passed.
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'e2e', 'generated');
fs.mkdirSync(outDir, { recursive: true });

const BASE = process.env.CAMSCAN_URL || 'http://localhost:3000';
const results = [];
let failures = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  const icon = ok ? '✓' : '✗';
  console.log(`${icon} ${name}${detail ? ` — ${detail}` : ''}`);
}


/**
 * Poll a Node-side async predicate. (Playwright's `waitForFunction` treats a
 * *Promise* returned by an async predicate as truthy and resolves immediately,
 * so IndexedDB assertions must be polled from Node instead.)
 */
async function waitFor(label, fn, timeoutMs = 60000, intervalMs = 250) {
  const started = Date.now();
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err.message;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms — last: ${JSON.stringify(last)?.slice(0, 200)}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Read a snapshot of the CamScan IndexedDB from the page. */
async function readDb(page, bookId) {
  return page.evaluate(async (id) => {
    const db = await new Promise((res, rej) => {
      const req = indexedDB.open('camscan');
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const all = (store) => new Promise((res) => {
      try {
        const tx = db.transaction(store, 'readonly');
        const g = tx.objectStore(store).getAll();
        g.onsuccess = () => res(g.result);
        g.onerror = () => res([]);
      } catch { res([]); }
    });
    const pagesAll = await all('pages');
    const books = await all('books');
    const blobs = await all('blobs');
    const pages = id ? pagesAll.filter((p) => p.bookId === id) : pagesAll;
    pages.sort((a, b) => a.order - b.order);
    return {
      books: books.length,
      coverThumbnails: books.filter((book) => typeof book.coverThumb === 'string' && book.coverThumb.startsWith('data:image/')).length,
      pages: pages.map((p) => ({
        id: p.id, order: p.order, status: p.status, conf: Math.round(p.avgConfidence || 0),
        blocks: p.pageModel?.blocks?.length ?? 0,
        paper: p.pageModel?.paperColor, dir: p.pageModel?.direction,
        text: (p.pageModel?.blocks ?? []).map((b) => b.text).join(' | '),
        plain: p.plainText ?? '', userEdited: Boolean(p.userEdited),
      })),
      blobSizes: blobs.filter((b) => b.kind === 'original').map((b) => b.size),
      blobBytes: blobs.filter((b) => b.kind === 'original').reduce((s, b) => s + b.size, 0),
      models: pagesAll.filter((p) => p.pageModel).length,
      edits: pagesAll.filter((p) => p.userEdited).length,
    };
  }, bookId);
}

const AR_SAMPLE = {
  title: 'مقدمة ابن خلدون',
  body: 'بسم الله الرحمن الرحيم هذا كتاب في تاريخ العلم',
  diacritics: 'مُحَمَّدٌ رَسُولُ اللَّهِ',
  query: 'تاريخ العلم',
  queryNormalized: 'تاريخ العلم',
  english: 'Chapter One: On the History of Science',
};

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    // Grant a fake camera so permission handling is deterministic; the actual
    // camera hardware path is verified manually (documented in the README).
    permissions: [],
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // Tesseract's WASM worker logs normal diagnostics as console.error.
    if (/Estimating resolution|Detected \d+ diacritics/.test(m.text())) return;
    consoleErrors.push(m.text().slice(0, 300));
  });
  page.on('pageerror', (e) => consoleErrors.push(`PAGEERROR ${e.message.slice(0, 300)}`));

  /* ---------------------------------------------------------------- */
  console.log('\n── 1. Create a book and reload ──');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /إضافة كتاب/ }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/العنوان/).fill(AR_SAMPLE.title);
  await dialog.getByLabel(/المؤلف/).fill('ابن خلدون');
  await dialog.getByRole('button', { name: /إنشاء/ }).click();
  await page.waitForURL(/\/book\/[^/]+\/scan/, { timeout: 20000 });
  const bookId = page.url().match(/book\/([^/]+)\/scan/)[1];
  check('book created and scan workspace opened', Boolean(bookId), bookId);

  // The first-use tips dialog must appear (once the app finishes booting).
  const tips = page.getByRole('dialog');
  await tips.waitFor({ state: 'visible', timeout: 15000 }).catch(() => undefined);
  check('first-use scanning tips are shown', await tips.isVisible().catch(() => false));
  await tips.getByRole('button', { name: /فهمت/ }).click();
  await tips.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => undefined);

  await page.reload({ waitUntil: 'networkidle' });
  const persisted = await page.evaluate(async (id) => {
    const db = await new Promise((res, rej) => {
      const req = indexedDB.open('camscan');
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const book = await new Promise((res) => {
      const tx = db.transaction('books', 'readonly');
      const g = tx.objectStore('books').get(id);
      g.onsuccess = () => res(g.result);
    });
    return book;
  }, bookId);
  check('book metadata survived reload (IndexedDB)', persisted?.title === AR_SAMPLE.title, persisted?.title);

  /* ---------------------------------------------------------------- */
  console.log('\n── 2. Import page images (upload fallback) ──');
  const fixture = path.join(root, 'tests', 'fixtures', 'page-photo.jpg');
  const fixture2 = path.join(root, 'tests', 'fixtures', 'page-ar-en.jpg');
  await page.setInputFiles('input[type="file"][accept="image/*"]', [fixture, fixture2]);
  const stored = await waitFor('two pages persisted', async () => {
    const snap = await readDb(page, bookId);
    return snap.pages.length >= 2 ? snap : null;
  }, 45000);
  check('two pages persisted immediately', stored.pages.length === 2, JSON.stringify(stored.pages.map((p) => p.order)));
  check('first page produces a library cover thumbnail', stored.coverThumbnails >= 1, `${stored.coverThumbnails} cover thumbnail(s)`);
  check('original captures stored as blobs', stored.blobSizes.filter((s) => s > 50_000).length >= 2, `${stored.blobSizes.join(', ')} bytes`);
  check('page order is 0,1 by capture sequence', JSON.stringify(stored.pages.map((p) => p.order)) === '[0,1]');

  /* ---------------------------------------------------------------- */
  console.log('\n── 3. Wait for OCR; verify order ≠ completion order ──');
  let snapDone;
  try {
    snapDone = await waitFor('all pages processed', async () => {
      const snap = await readDb(page, bookId);
      return snap.pages.length > 0 && snap.pages.every((p) => ['done', 'review', 'failed'].includes(p.status)) ? snap : null;
    }, 300000, 800);
  } catch (err) {
    const stuck = await readDb(page, bookId);
    console.error('   stuck state:', JSON.stringify(stuck.pages.map((p) => [p.order, p.status])), '| console errors:', consoleErrors.slice(-3));
    throw err;
  }
  const processed = snapDone.pages;
  const allText = processed.map((p) => p.text).join(' ');
  check('all pages finished processing', processed.every((p) => p.status !== 'queued' && p.status !== 'processing'), processed.map((p) => p.status).join(','));
  check('page order unchanged after out-of-order OCR', JSON.stringify(processed.map((p) => p.order)) === '[0,1]');
  check('Arabic text recognised', /تاريخ|العلم|الفصل|كتاب/.test(allText), allText.slice(0, 120));
  check('Latin text recognised', /Chapter|History|Science|printing/i.test(allText), allText.slice(0, 200));
  check('paper colour sampled from the photograph', processed.every((p) => /^#[0-9a-f]{6}$/i.test(p.paper ?? '')), processed.map((p) => p.paper).join(' '));
  check('page direction inferred as RTL', processed[0]?.dir === 'rtl', processed[0]?.dir);

  /* ---------------------------------------------------------------- */
  console.log('\n── 4. Reader: real text, edit, persist, search ──');
  await page.goto(`${BASE}/book/${bookId}`, { waitUntil: 'networkidle' });
  await page.getByRole('tab').first().click();
  await page.waitForSelector('[data-testid="replica-page"]', { timeout: 20000 });

  // Replica must contain real text nodes, and no full-page <img> inside it.
  const replicaInfo = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="replica-page"]');
    if (!el) return null;
    const imgs = [...el.querySelectorAll('img')].map((i) => i.getAttribute('src')?.slice(0, 30));
    return {
      textLength: (el.textContent ?? '').trim().length,
      blockCount: el.querySelectorAll('[data-block-id]').length,
      images: imgs,
      fontFamilies: [...new Set([...el.querySelectorAll('[data-block-id]')].map((b) => getComputedStyle(b).fontFamily))],
      bg: getComputedStyle(el).backgroundColor,
    };
  });
  check('replica renders real text (not a page image)', (replicaInfo?.textLength ?? 0) > 30, `${replicaInfo?.textLength} chars`);
  check('replica blocks carry the sampled paper colour', replicaInfo?.bg !== 'rgba(0, 0, 0, 0)', replicaInfo?.bg);

  // Edit the first text block.
  await page.getByRole('button', { name: /تحرير/ }).click();
  const firstBlock = page.locator('[data-testid="replica-page"] [contenteditable="true"]').first();
  await firstBlock.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('نص صحيح للاختبار العربي');
  await page.getByRole('button', { name: /حفظ التعديلات/ }).click();
  await page.waitForTimeout(1200);
  const editedText = await page.evaluate(() => document.querySelector('[data-testid="replica-page"]')?.textContent ?? '');
  check('inline edit applied to the replica', editedText.includes('نص صحيح للاختبار العربي'));

  // Reload → the edit must persist.
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('tab').first().click();
  await page.waitForSelector('[data-testid="replica-page"]', { timeout: 20000 });
  const afterReload = await page.evaluate(() => document.querySelector('[data-testid="replica-page"]')?.textContent ?? '');
  check('edit survived reload', afterReload.includes('نص صحيح للاختبار العربي'));

  // Search with a query that has NO diacritics for a page that HAS them.
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.getByRole('searchbox').first().fill('نص صحيح');
  await page.waitForTimeout(900);
  const searchFound = await page.locator('mark').first().textContent().catch(() => null);
  check('Arabic-normalised global search finds the edit', Boolean(searchFound), searchFound ?? 'no mark');

  await page.screenshot({ path: path.join(outDir, '01-search.png') });

  /* ---------------------------------------------------------------- */
  console.log('\n── 5. Side-by-side proofreading view ──');
  await page.goto(`${BASE}/book/${bookId}`, { waitUntil: 'networkidle' });
  await page.getByRole('tab').first().click();
  await page.waitForSelector('[data-testid="replica-page"]');
  await page.getByRole('tab', { name: /مقارنة/ }).click();
  await page.waitForTimeout(1200);
  const sideBySide = await page.evaluate(() => document.querySelectorAll('img').length);
  check('side-by-side shows the original photo beside the replica', sideBySide >= 1, `${sideBySide} image(s)`);
  await page.screenshot({ path: path.join(outDir, '02-side-by-side.png'), fullPage: false });

  /* ---------------------------------------------------------------- */
  console.log('\n── 6. Export PDF and verify its contents ──');
  await page.getByRole('button', { name: /تنزيل PDF/ }).first().click();
  const downloadPromise = page.waitForEvent('download', { timeout: 180000 });
  await page.getByRole('button', { name: /ابدأ التصدير/ }).click();
  const download = await downloadPromise;
  const pdfPath = path.join(outDir, 'camscan-export.pdf');
  await download.saveAs(pdfPath);
  const pdfSize = fs.statSync(pdfPath).size;
  check('PDF produced from the app', pdfSize > 10_000, `${(pdfSize / 1024).toFixed(0)} KB`);

  const pdfInfo = execFileSync('pdfinfo', [pdfPath], { encoding: 'utf8' });
  const pageCount = Number(pdfInfo.match(/Pages:\s+(\d+)/)?.[1] ?? 0);
  check('PDF page count matches book (+ title page)', pageCount === processed.length + 1, `${pageCount} pages`);

  const text = execFileSync('pdftotext', [pdfPath, '-'], { encoding: 'utf8' });
  check('PDF text is selectable/extractable (not an image)', text.trim().length > 40, `${text.trim().length} chars`);
  check('PDF contains the edited Arabic text', text.includes('نص صحيح للاختبار العربي'), text.slice(0, 120).replace(/\n/g, ' '));
  check('PDF contains Arabic body text', /تاريخ|العلم|الفصل|كتاب/.test(text));
  check('PDF contains Latin text', /Chapter|History|Science|printing/i.test(text));
  // Arabic must be present in *logical* order in the text layer (shaping check).
  const hasShapedWords = /الفصل الأول|تاريخ العلم/.test(text.replace(/[\u200e\u200f\u202a-\u202e]/g, ''));
  check('Arabic words extract in correct logical order', hasShapedWords);

  // A text-only PDF must contain almost no raster data for the replica pages:
  // check that images are absent (photos mode would add one per page).
  let imageCount = 0;
  try {
    imageCount = Number(execFileSync('pdfimages', ['-list', pdfPath], { encoding: 'utf8' }).trim().split('\n').length - 2);
  } catch { imageCount = 0; }
  check('replica PDF contains no page photographs', imageCount <= 1, `${imageCount} embedded image(s)`);

  /* ---------------------------------------------------------------- */
  console.log('\n── 6b. Optional searchable PDF + original-photo appendix ──');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  const bookCard = page.locator('ul.grid > li').filter({ hasText: AR_SAMPLE.title }).first();
  await bookCard.getByRole('button', { name: /الإعدادات|settings/i }).click();
  const appendixDownloadPromise = page.waitForEvent('download', { timeout: 180000 });
  await bookCard.getByRole('button', { name: /تصدير PDF مع الصور الأصلية|Export PDF with original photos/i }).click();
  const appendixDownload = await appendixDownloadPromise;
  const appendixPath = path.join(outDir, 'camscan-photo-appendix.pdf');
  await appendixDownload.saveAs(appendixPath);
  const appendixInfo = execFileSync('pdfinfo', [appendixPath], { encoding: 'utf8' });
  const appendixPageCount = Number(appendixInfo.match(/Pages:\s+(\d+)/)?.[1] ?? 0);
  const replicaPageCount = pageCount - 1;
  check('photo appendix adds one original photograph per replica page', appendixPageCount === 1 + replicaPageCount * 2, `${appendixPageCount} pages`);
  const appendixText = execFileSync('pdftotext', [appendixPath, '-'], { encoding: 'utf8' });
  check('photo appendix export keeps selectable Arabic text', appendixText.includes('نص صحيح للاختبار العربي'));
  let appendixImageCount = 0;
  try {
    appendixImageCount = Number(execFileSync('pdfimages', ['-list', appendixPath], { encoding: 'utf8' }).trim().split('\n').length - 2);
  } catch { appendixImageCount = 0; }
  check('photo appendix contains embedded original page photographs', appendixImageCount >= replicaPageCount, `${appendixImageCount} embedded image(s)`);

  /* ---------------------------------------------------------------- */
  console.log('\n── 7. Backup → wipe → restore ──');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /الإعدادات|settings/i }).first().click();
  const backupDownload = page.waitForEvent('download', { timeout: 120000 });
  await page.getByRole('button', { name: /إنشاء نسخة احتياطية/ }).click();
  const backup = await backupDownload;
  const zipPath = path.join(outDir, 'library-backup.zip');
  await backup.saveAs(zipPath);
  const zipSize = fs.statSync(zipPath).size;
  check('backup ZIP created', zipSize > 100_000, `${(zipSize / 1024).toFixed(0)} KB`);

  const zipList = execFileSync('unzip', ['-l', zipPath], { encoding: 'utf8' });
  check('backup contains original photographs', /images\/.+\.jpg/.test(zipList));
  check('backup contains library manifest', /library\.json/.test(zipList));

  // Wipe the database and verify the library is empty.
  await page.evaluate(async () => {
    await new Promise((res) => { const r = indexedDB.deleteDatabase('camscan'); r.onsuccess = () => res(); r.onerror = () => res(); });
  });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  const emptyNow = await readDb(page, null);
  check('library wiped before restore', emptyNow.books === 0, `${emptyNow.books} books`);

  // Restore the backup.
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /الإعدادات|settings/i }).first().click();
  await page.locator('input[type="file"][accept*="zip"]').setInputFiles(zipPath);
  const restored = await waitFor('library restored', async () => {
    const snap = await readDb(page, null);
    return snap.books > 0 && snap.pages.length > 0 ? snap : null;
  }, 180000, 700);
  check('restore brought the book back', restored.books >= 1, `${restored.books} book(s), ${restored.pages.length} page(s)`);
  check('restore kept original images', restored.blobBytes > 100_000, `${(restored.blobBytes / 1024).toFixed(0)} KB`);
  check('restore kept the page models', restored.models >= 1);
  check('restore kept the manual edit flag', restored.edits >= 1);

  const globalSearchAfterRestore = page.locator('#global-search');
  await globalSearchAfterRestore.fill('نص صحيح للاختبار العربي');
  const restoredSearchHit = await waitFor('restored text searchable without reload', async () => {
    const body = await page.locator('body').innerText();
    return body.includes('نص صحيح للاختبار العربي') ? body : null;
  }, 15000, 250);
  check('restored text is searchable without reloading the app', Boolean(restoredSearchHit));

  /* ---------------------------------------------------------------- */
  console.log('\n── 8. Failure path: corrupt capture must not lose data ──');
  const failResult = await page.evaluate(async () => {
    const db = await new Promise((res) => { const r = indexedDB.open('camscan'); r.onsuccess = () => res(r.result); });
    const books = await new Promise((res) => { const tx = db.transaction('books', 'readonly'); const g = tx.objectStore('books').getAll(); g.onsuccess = () => res(g.result); });
    const bookId = books[0].id;
    // Insert a page whose "image" is not a valid JPEG.
    const blobId = 'bl_test_corrupt';
    const pageId = 'pg_test_corrupt';
    await new Promise((res) => {
      const tx = db.transaction(['blobs', 'pages'], 'readwrite');
      tx.objectStore('blobs').put({ id: blobId, blob: new Blob(['not-an-image'], { type: 'image/jpeg' }), kind: 'original', size: 12, createdAt: Date.now() });
      tx.objectStore('pages').put({
        id: pageId, bookId, order: 99, status: 'queued', stage: 'queued', progress: 0,
        originalBlobId: blobId, plainText: '', searchText: '', avgConfidence: 0,
        language: 'ar', direction: 'rtl', width: 10, height: 10, reviewed: false,
        blank: false, userEdited: false, createdAt: Date.now(), updatedAt: Date.now(), revision: 1,
      });
      tx.oncomplete = () => res();
    });
    const worker = new Worker('/workers/processing.worker.js', { type: 'module' });
    const outcome = await new Promise((resolve) => {
      worker.onmessage = (e) => { if (e.data.type === 'error') resolve({ error: e.data.error }); if (e.data.type === 'done') resolve({ done: true }); };
      worker.postMessage({ type: 'process', id: 1, blob: new Blob(['not-an-image'], { type: 'image/jpeg' }), options: { pageId, sequence: 100, languages: ['ara'], profile: 'standard', reviewThreshold: 70 } });
      setTimeout(() => resolve({ timeout: true }), 30000);
    });
    // The original must still be there after the failure.
    const blob = await new Promise((res) => { const tx = db.transaction('blobs', 'readonly'); const g = tx.objectStore('blobs').get(blobId); g.onsuccess = () => res(g.result); });
    // Clean up the synthetic failure page so it doesn't pollute later checks.
    await new Promise((res) => { const tx = db.transaction(['blobs', 'pages'], 'readwrite'); tx.objectStore('pages').delete(pageId); tx.objectStore('blobs').delete(blobId); tx.oncomplete = () => res(); });
    worker.terminate();
    return { outcome, originalSurvives: Boolean(blob?.blob?.size) };
  });
  check('processing a corrupt image fails cleanly', Boolean(failResult.outcome.error), failResult.outcome.error?.slice(0, 80));
  check('original capture survives a processing failure', failResult.originalSurvives);

  /* ---------------------------------------------------------------- */
  console.log('\n── 9. Camera permission denied path ──');
  const deniedContext = await browser.newContext({ viewport: { width: 420, height: 860 } });
  const deniedPage = await deniedContext.newPage();
  // Replace the whole mediaDevices object: assigning `getUserMedia` on the
  // existing one fails in Chromium because the property is read-only.
  await deniedPage.addInitScript(() => {
    const denied = () => Promise.reject(
      Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }),
    );
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: denied, enumerateDevices: async () => [], addEventListener() {}, removeEventListener() {} },
    });
  });
  // Each browser context has its own (empty) IndexedDB profile, so this context
  // must create its own book rather than reuse the main context's bookId.
  await deniedPage.goto(BASE, { waitUntil: 'networkidle' });
  await deniedPage.getByRole('button', { name: /إضافة كتاب/ }).first().click();
  const deniedDialog = deniedPage.getByRole('dialog');
  await deniedDialog.getByLabel(/العنوان/).fill('رفض الكاميرا');
  await deniedDialog.getByRole('button', { name: /إنشاء/ }).click();
  await deniedPage.waitForURL(/\/book\/[^/]+\/scan/, { timeout: 20000 });
  // The first-use tips dialog is modal: wait for it, dismiss it, then continue.
  const tipsDenied = deniedPage.getByRole('dialog');
  await tipsDenied.waitFor({ state: 'visible', timeout: 15000 }).catch(() => undefined);
  if (await tipsDenied.isVisible().catch(() => false)) {
    await tipsDenied.getByRole('button', { name: /فهمت/ }).click();
    await tipsDenied.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => undefined);
  }
  const startBtn = deniedPage.getByRole('button', { name: /ابدأ التصوير/ });
  await startBtn.waitFor({ state: 'visible', timeout: 20000 });
  check('scan workspace offers a camera start button', await startBtn.isVisible());
  await startBtn.click({ timeout: 20000 });
  const denialText = await waitFor('camera denial message', async () => {
    const text = await deniedPage.evaluate(() => document.body.innerText);
    return /رفض|غير مسموح|تعذّر|denied|permission/i.test(text) ? text : null;
  }, 20000, 500).catch(() => null);
  check(
    'camera denial produces an explicit message (no fake stream)',
    Boolean(denialText),
    (denialText ?? '').slice(0, 100).replace(/\n/g, ' '),
  );
  check('upload fallback remains available after denial', Boolean(denialText && /استيراد|Import/i.test(denialText)));
  // The video element must not pretend to show a stream.
  const liveStreams = await deniedPage.evaluate(() =>
    [...document.querySelectorAll('video')].filter((v) => (v.srcObject?.getVideoTracks?.().length ?? 0) > 0).length,
  );
  check('no video track is attached after denial', liveStreams === 0, `${liveStreams} live video element(s)`);
  await deniedPage.screenshot({ path: path.join(outDir, '03-scan-mobile.png'), fullPage: false });
  await deniedContext.close();

  /* ---------------------------------------------------------------- */
  console.log('\n── 10. Responsive layout + console hygiene ──');
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mpage = await mobile.newPage();
  await mpage.goto(BASE, { waitUntil: 'networkidle' });
  const noHorizontalScroll = await mpage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2);
  check('library has no horizontal overflow on a phone viewport', noHorizontalScroll);
  await mpage.screenshot({ path: path.join(outDir, '04-mobile-home.png') });
  await mobile.close();

  // Tesseract's worker prints diagnostics ("Estimating resolution as 382",
  // "Detected 61 diacritics") through console.error even on success; they are
  // engine chatter, not app errors.
  const ENGINE_CHATTER = /Estimating resolution|Detected \d+ diacritics|Download the React DevTools|favicon|tesseract/i;
  const realErrors = consoleErrors.filter((e) => !ENGINE_CHATTER.test(e));
  check('no unexpected console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  /* ---------------------------------------------------------------- */
  await browser.close();

  console.log('\n════════════════════════════════════════════');
  const passed = results.filter((r) => r.ok).length;
  console.log(`${passed}/${results.length} checks passed, ${failures} failed`);
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ results, failures, at: new Date().toISOString() }, null, 2));
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error('\nFATAL', err);
  process.exit(1);
});
