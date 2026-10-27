import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://localhost:3000/health');
const b64 = (await import('node:fs')).readFileSync('tests/fixtures/page-photo.jpg').toString('base64');
const out = await page.evaluate(async (b64) => {
  const blob = await (await fetch('data:image/jpeg;base64,'+b64)).blob();
  const w = new Worker('/workers/processing.worker.js', {type:'module'});
  // Ask the worker only for the rectified+enhanced image by using skipOcr
  const res = await new Promise((resolve) => {
    w.onmessage = (e) => { if (e.data.type === 'done') resolve(e.data.result); if (e.data.type === 'error') resolve({error: e.data.error}); };
    w.postMessage({type:'process', id:1, blob, options:{ pageId:'x', sequence:1, languages:['ara','eng'], profile:'standard', reviewThreshold:70, skipOcr:true }});
  });
  if (!res.processed) return { error: 'no processed', res: JSON.stringify(res).slice(0,300) };
  const processedBlob = new Blob([res.processed.buffer], { type: 'image/jpeg' });
  const t = await import('/vendor/tesseract/tesseract.esm.min.js?v=2');
  const { createWorker } = t.default || t;
  const results = {};
  for (const lang of ['eng','ara']) {
    const worker = await createWorker([lang], 1, { workerPath:'/vendor/tesseract/worker.min.js', langPath:'/tessdata', corePath:'/vendor/tesseract', workerBlobURL:false, gzip:false });
    await worker.setParameters({ tessedit_pageseg_mode: '3', preserve_interword_spaces: '1' });
    const r = await worker.recognize(processedBlob, {}, { text: true });
    results[lang] = { text: r.data.text.slice(0, 700), conf: r.data.confidence };
    await worker.terminate();
  }
  return results;
}, b64);
console.log(JSON.stringify(out, null, 1).slice(0, 3000));
await browser.close();
