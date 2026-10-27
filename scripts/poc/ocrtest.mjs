import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage();
const msgs = [];
page.on('console', m => msgs.push(`[${m.type()}] ${m.text().slice(0,300)}`));
page.on('pageerror', e => msgs.push(`[pageerror] ${e.message.slice(0,300)}`));
page.on('requestfailed', r => msgs.push(`[reqfail] ${r.url()} ${r.failure()?.errorText}`));
page.on('response', r => { if (r.status() >= 400) msgs.push(`[http ${r.status()}] ${r.url()}`); });
await page.goto('http://localhost:3000/health');
const res = await page.evaluate(async () => {
  const out = { steps: [] };
  try {
    out.steps.push('importing');
    const mod = await import('/vendor/tesseract/tesseract.esm.min.js');
    out.steps.push('imported: ' + typeof mod.createWorker);
    const worker = await mod.createWorker(['ara','eng'], 1, {
      workerPath: '/vendor/tesseract/worker.min.js',
      langPath: '/tessdata',
      corePath: '/vendor/tesseract',
      workerBlobURL: false,
      gzip: false,
      logger: (m) => out.steps.push('log:' + m.status + ' ' + Math.round((m.progress||0)*100)),
      errorHandler: (e) => out.steps.push('ERR:' + String(e).slice(0,200)),
    });
    out.steps.push('worker created');
    await worker.setParameters({ tessedit_pageseg_mode: '3', preserve_interword_spaces: '1' });
    const img = await fetch('/icons/icon-192.png');
    const blob = await img.blob();
    const r = await worker.recognize(blob, {}, { blocks: true, text: true });
    out.steps.push('recognized: conf=' + r.data.confidence + ' text=' + JSON.stringify((r.data.text||'').slice(0,60)));
    await worker.terminate();
  } catch (e) {
    out.error = e.message || String(e);
  }
  return out;
});
console.log(JSON.stringify(res, null, 1));
console.log('---');
console.log(msgs.slice(0, 40).join('\n'));
await browser.close();
