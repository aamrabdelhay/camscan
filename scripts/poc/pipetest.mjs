import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const logs = [];
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
await page.goto('http://localhost:3000/health');
const buf = (await import('node:fs')).readFileSync('/home/user/camscan/tests/fixtures/page-photo.jpg');
const b64 = buf.toString('base64');
const result = await page.evaluate(async (b64) => {
  const res = await fetch('data:image/jpeg;base64,' + b64);
  const blob = await res.blob();
  const worker = new Worker('/workers/processing.worker.js', { type: 'module' });
  const t0 = performance.now();
  return await new Promise((resolve) => {
    worker.onmessage = (e) => {
      if (e.data.type === 'progress') return;
      if (e.data.type === 'done') resolve({ ok: true, ms: Math.round(performance.now()-t0), result: {
        blocks: e.data.result.model.blocks.map(b => ({ type: b.type, text: b.text, conf: b.confidence, dir: b.direction, fs: b.fontSize, font: b.fontFamily })),
        paper: e.data.result.model.paperColor, ink: e.data.result.model.inkColor,
        conf: e.data.result.avgConfidence, warnings: e.data.result.warnings, ocrError: e.data.result.ocrError, modelWarnings: e.data.result.model.warnings, metrics: e.data.result.metrics,
        w: e.data.result.width, h: e.data.result.height,
        plain: e.data.result.model.blocks.map(b=>b.text).join(' | '),
      }});
      if (e.data.type === 'error') resolve({ ok: false, error: e.data.error });
    };
    worker.onerror = (err) => resolve({ ok: false, error: 'worker error: ' + err.message });
    worker.postMessage({ type: 'process', id: 1, blob, options: { pageId: 'p1', sequence: 1, languages: ['ara','eng'], profile: 'standard', reviewThreshold: 70, maxLongEdge: 2000 } });
    setTimeout(() => resolve({ ok: false, error: 'timeout 180s' }), 180000);
  });
}, b64);
console.log(JSON.stringify(result, null, 1).slice(0, 4000));
console.log('--- console ---'); console.log(logs.slice(0,40).join('\n'));
await browser.close();
