#!/usr/bin/env node
/**
 * CamScan — worker bundler.
 *
 * Web Workers cannot import TypeScript modules directly, and bundling them
 * through Next.js' webpack is fragile across versions. esbuild gives us a
 * deterministic, fast build of the two workers we need:
 *
 *   public/workers/cv.worker.js        – page detection + rectification + quality
 *   public/workers/processing.worker.js – full pipeline (CV + OCR + page model)
 *
 * They are served as static assets (same origin) so no CDN/CORS/offline issues.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const shared = {
  bundle: true,
  format: 'esm',
  target: ['es2020'],
  platform: 'browser',
  sourcemap: true,
  minify: false,
  logLevel: 'info',
  legalComments: 'none',
  // tesseract.js pulls in Node-only branches; they are dead code in the browser.
  external: ['node:fs', 'node:path', 'fs', 'path', 'worker_threads', 'os'],
  define: {
    'process.env.NODE_ENV': '"production"',
    global: 'globalThis',
  },
};

async function main() {
  const jobs = [
    { entry: 'src/workers/cv.worker.ts', out: 'public/workers/cv.worker.js' },
    { entry: 'src/workers/processing.worker.ts', out: 'public/workers/processing.worker.js' },
    { entry: 'src/workers/pdf.worker.ts', out: 'public/workers/pdf.worker.js' },
  ];

  for (const job of jobs) {
    await build({
      ...shared,
      entryPoints: [path.join(root, job.entry)],
      outfile: path.join(root, job.out),
    });
    console.log(`✓ ${job.out}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
