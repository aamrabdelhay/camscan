#!/usr/bin/env node
/**
 * Verify the live camera auto-capture loop with Chromium's fake camera source.
 * The Y4M file is a still page followed by a different page with the same
 * camera geometry. This catches missed auto-capture and geometry-only dedupe.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.CAMSCAN_URL || 'http://127.0.0.1:3000';
const VIDEO = process.env.CAMSCAN_CAMERA_FILE;
if (!VIDEO || !fs.existsSync(VIDEO)) {
  console.error('CAMSCAN_CAMERA_FILE must point to a prepared Y4M test video.');
  process.exit(2);
}

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function readPages(page, bookId) {
  return page.evaluate(async (id) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('camscan');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('pages', 'readonly');
      const request = tx.objectStore('pages').getAll();
      request.onsuccess = () => resolve(request.result.filter((row) => row.bookId === id).sort((a, b) => a.order - b.order));
      request.onerror = () => reject(request.error);
    });
  }, bookId);
}

async function waitForPages(page, bookId, minimum, timeoutMs) {
  const start = Date.now();
  let last = [];
  while (Date.now() - start < timeoutMs) {
    last = await readPages(page, bookId);
    if (last.length >= minimum) return last;
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for ${minimum} camera-captured page(s); got ${last.length}. UI: ${(await page.locator('body').innerText()).slice(0, 500)}`);
}

async function main() {
  const browser = await chromium.launch({
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-video-capture=${VIDEO}`,
    ],
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      permissions: ['camera'],
    });
    const page = await context.newPage();

    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /إضافة كتاب/ }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/العنوان/).fill('اختبار التصوير التلقائي');
    await dialog.getByRole('button', { name: /إنشاء/ }).click();
    await page.waitForURL(/\/book\/[^/]+\/scan/, { timeout: 20000 });
    const bookId = page.url().match(/book\/([^/]+)\/scan/)[1];

    const tips = page.getByRole('dialog');
    await tips.waitFor({ state: 'visible', timeout: 12000 }).catch(() => undefined);
    if (await tips.isVisible().catch(() => false)) {
      await tips.getByRole('button', { name: /فهمت/ }).click();
      await tips.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => undefined);
    }

    await page.getByRole('button', { name: /ابدأ التصوير/ }).click();
    await page.waitForFunction(() => {
      const video = document.querySelector('video');
      return Boolean(video && video.videoWidth > 0 && video.videoHeight > 0 && video.readyState >= 2);
    }, null, { timeout: 12000 });

    let first;
    try {
      first = await waitForPages(page, bookId, 1, 15000);
      check('first stable camera page was auto-captured without pressing shutter', first.length >= 1, `${first.length} page(s)`);
    } catch (error) {
      check('first stable camera page was auto-captured without pressing shutter', false, error.message);
      throw error;
    }

    // The first image is held steady for five seconds in the fixture. It must
    // not be captured repeatedly while the next leaf has not arrived.
    await page.waitForTimeout(2200);
    const whileHeld = await readPages(page, bookId);
    check('a held page is captured once, not repeatedly', whileHeld.length === 1, `${whileHeld.length} page(s) while page A is still visible`);

    // At t=5s the fixture swaps to page B without changing the camera or
    // page-boundary geometry. A quad-only dedupe implementation stays blocked.
    const second = await waitForPages(page, bookId, 2, 17000);
    check('a different page at the same camera angle is auto-captured', second.length >= 2, `${second.length} pages`);

    await page.waitForTimeout(2000);
    const finalPages = await readPages(page, bookId);
    check('the second held page is not duplicated', finalPages.length === 2, `${finalPages.length} total pages`);

    await page.screenshot({ path: '/tmp/camscan-camera-auto-capture.png', fullPage: false });
    await context.close();
  } finally {
    await browser.close();
  }

  const failures = checks.filter((item) => !item.ok);
  console.log(`\\nCamera auto-capture: ${checks.length - failures.length}/${checks.length} checks passed`);
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
