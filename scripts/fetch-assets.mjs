#!/usr/bin/env node
/**
 * CamScan — asset vendoring script
 * ------------------------------------------------------------------
 * Downloads and prepares every *runtime* asset the local-first app needs so
 * that after the first page load nothing has to leave the browser:
 *
 *  public/fonts/*.ttf           – full TTF (PDF export embedding, OFL licensed)
 *  public/fonts/webfonts/*.woff2 – subset WOFF2 used by HTML/CSS replica view
 *  public/fonts/LICENSES.md     – licence notes for every bundled family
 *  public/tessdata/*.traineddata – OCR language packs (Apache-2.0, tessdata_fast)
 *  public/vendor/opencv.js      – OpenCV.js build used for CV in a Web Worker
 *  public/vendor/tesseract/*    – tesseract.js worker script + core wasm builds
 *
 * The script is idempotent: existing files with the right checksum/size are
 * skipped, so `npm run assets` is cheap on subsequent runs.
 *
 * Every asset is free / open-source. No keys, no accounts, no paid services.
 */
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = (...p) => path.join(root, 'public', ...p);

/* ------------------------------------------------------------------ */
/* Manifest                                                            */
/* ------------------------------------------------------------------ */

// Font families bundled with CamScan. `pdf` files are used by the PDF
// exporter (pdfkit needs real TTFs); `subset` is the Unicode range kept in the
// web subset — Arabic-script fonts must keep the Arabic blocks + Latin basics.
const ARABIC_UNICODES =
  'U+0000-00FF,U+0600-06FF,U+0750-077F,U+0870-08FF,U+200C-200F,U+2010-2027,U+2030-2040,U+FB50-FDFF,U+FE70-FEFF,U+20AA,U+2212';
const LATIN_UNICODES =
  'U+0000-00FF,U+0100-017F,U+2000-206F,U+20A0-20BF,U+2212,U+2190-21BB';

const FONT_FAMILIES = [
  {
    family: 'Amiri',
    cssName: 'Amiri',
    script: 'arabic',
    files: [
      { file: 'Amiri-Regular.ttf', weight: 400, style: 'normal', url: 'https://github.com/google/fonts/raw/main/ofl/amiri/Amiri-Regular.ttf' },
      { file: 'Amiri-Bold.ttf', weight: 700, style: 'normal', url: 'https://github.com/google/fonts/raw/main/ofl/amiri/Amiri-Bold.ttf' },
    ],
  },
  {
    family: 'ScheherazadeNew',
    cssName: 'Scheherazade New',
    script: 'arabic',
    files: [
      { file: 'ScheherazadeNew-Regular.ttf', weight: 400, style: 'normal', url: 'https://github.com/google/fonts/raw/main/ofl/scheherazadenew/ScheherazadeNew-Regular.ttf' },
      { file: 'ScheherazadeNew-Bold.ttf', weight: 700, style: 'normal', url: 'https://github.com/google/fonts/raw/main/ofl/scheherazadenew/ScheherazadeNew-Bold.ttf' },
    ],
  },
  {
    // Noto Naskh ships as a variable font only; we pin the Regular (400)
    // instance so both the web subset and the PDF embed are small & static.
    family: 'NotoNaskhArabic',
    cssName: 'Noto Naskh Arabic',
    script: 'arabic',
    files: [
      { file: 'NotoNaskhArabic-Regular.ttf', weight: 400, style: 'normal', variable: { wght: 400 }, url: 'https://github.com/google/fonts/raw/main/ofl/notonaskharabic/NotoNaskhArabic%5Bwght%5D.ttf' },
    ],
  },
  {
    family: 'NotoKufiArabic',
    cssName: 'Noto Kufi Arabic',
    script: 'arabic',
    files: [
      { file: 'NotoKufiArabic-Regular.ttf', weight: 400, style: 'normal', variable: { wght: 400 }, url: 'https://github.com/google/fonts/raw/main/ofl/notokufiarabic/NotoKufiArabic%5Bwght%5D.ttf' },
    ],
  },
  {
    family: 'Cairo',
    cssName: 'Cairo',
    script: 'arabic',
    files: [
      { file: 'Cairo-Regular.ttf', weight: 400, style: 'normal', variable: { wght: 400 }, url: 'https://github.com/google/fonts/raw/main/ofl/cairo/Cairo%5Bslnt,wght%5D.ttf' },
      { file: 'Cairo-Bold.ttf', weight: 700, style: 'normal', variable: { wght: 700 }, url: 'https://github.com/google/fonts/raw/main/ofl/cairo/Cairo%5Bslnt,wght%5D.ttf' },
    ],
  },
  {
    family: 'EBGaramond',
    cssName: 'EB Garamond',
    script: 'latin',
    files: [
      { file: 'EBGaramond-Regular.ttf', weight: 400, style: 'normal', variable: { wght: 400 }, url: 'https://github.com/google/fonts/raw/main/ofl/ebgaramond/EBGaramond%5Bwght%5D.ttf' },
      { file: 'EBGaramond-Bold.ttf', weight: 700, style: 'normal', variable: { wght: 700 }, url: 'https://github.com/google/fonts/raw/main/ofl/ebgaramond/EBGaramond%5Bwght%5D.ttf' },
      { file: 'EBGaramond-Italic.ttf', weight: 400, style: 'italic', variable: { wght: 400 }, url: 'https://github.com/google/fonts/raw/main/ofl/ebgaramond/EBGaramond-Italic%5Bwght%5D.ttf' },
    ],
  },
  {
    family: 'Merriweather',
    cssName: 'Merriweather',
    script: 'latin',
    files: [
      { file: 'Merriweather-Regular.ttf', weight: 400, style: 'normal', variable: { wght: 400, opsz: 14, wdth: 100 }, url: 'https://github.com/google/fonts/raw/main/ofl/merriweather/Merriweather%5Bopsz,wdth,wght%5D.ttf' },
      { file: 'Merriweather-Bold.ttf', weight: 700, style: 'normal', variable: { wght: 700, opsz: 14, wdth: 100 }, url: 'https://github.com/google/fonts/raw/main/ofl/merriweather/Merriweather%5Bopsz,wdth,wght%5D.ttf' },
    ],
  },
  {
    family: 'Inter',
    cssName: 'Inter',
    script: 'latin',
    files: [
      { file: 'Inter-Regular.ttf', weight: 400, style: 'normal', variable: { wght: 400, opsz: 14 }, url: 'https://github.com/google/fonts/raw/main/ofl/inter/Inter%5Bopsz,wght%5D.ttf' },
      { file: 'Inter-Bold.ttf', weight: 700, style: 'normal', variable: { wght: 700, opsz: 14 }, url: 'https://github.com/google/fonts/raw/main/ofl/inter/Inter%5Bopsz,wght%5D.ttf' },
    ],
  },
  {
    family: 'JetBrainsMono',
    cssName: 'JetBrains Mono',
    script: 'latin',
    files: [
      { file: 'JetBrainsMono-Regular.ttf', weight: 400, style: 'normal', variable: { wght: 400 }, url: 'https://github.com/google/fonts/raw/main/ofl/jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf' },
    ],
  },
];

// OCR language packs (tessdata_fast from the official tesseract-ocr repo).
const OCR_LANGS = [
  ['ara', 'Arabic', 'العربية', 1.4],
  ['eng', 'English', 'الإنجليزية', 4.1],
  ['fra', 'French', 'الفرنسية', 1.1],
  ['deu', 'German', 'الألمانية', 1.5],
  ['fas', 'Persian', 'الفارسية', 0.43],
  ['urd', 'Urdu', 'الأردية', 1.4],
  ['tur', 'Turkish', 'التركية', 4.6],
];

const TESSDATA_BASE = 'https://github.com/tesseract-ocr/tessdata_fast/raw/main/';
const OPENCV_URL = 'https://docs.opencv.org/4.x/opencv.js';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

async function exists(p) {
  try {
    const st = await fs.stat(p);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

async function download(url, dest, { minSize = 1024 } = {}) {
  if (await exists(dest)) {
    const st = await fs.stat(dest);
    if (st.size >= minSize) return { skipped: true, size: st.size };
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const tmp = `${dest}.part`;
  await new Promise(async (resolve, reject) => {
    const out = createWriteStream(tmp);
    try {
      const buf = Buffer.from(await res.arrayBuffer());
      out.write(buf);
      out.end();
      out.on('finish', resolve);
      out.on('error', reject);
    } catch (e) {
      reject(e);
    }
  });
  const st = await fs.stat(tmp);
  if (st.size < minSize) {
    await fs.unlink(tmp).catch(() => {});
    throw new Error(`Downloaded ${url} is suspiciously small (${st.size} B)`);
  }
  await fs.rename(tmp, dest);
  return { skipped: false, size: st.size };
}

function haveFonttools() {
  try {
    execFileSync('python3', ['-c', 'import fontTools, brotli'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Pin a variable font to a static instance so pdfkit/PDF embed + sizing are predictable. */
async function instantiate(src, dest, axes) {
  if (!axes) {
    await fs.copyFile(src, dest);
    return;
  }
  const axisArgs = Object.entries(axes).flatMap(([k, v]) => [`${k}=${v}`]);
  execFileSync('python3', [
    '-c',
    [
      'import sys',
      'from fontTools.ttLib import TTFont',
      'from fontTools.varLib import instancer',
      'src, dst, *axes = sys.argv[1:]',
      'kwargs = {a.split("=")[0]: float(a.split("=")[1]) for a in axes}',
      'f = TTFont(src)',
      'f2 = instancer.instantiateVariableFont(f, kwargs, inplace=False, updateFontNames=False)',
      'f2.save(dst)',
    ].join('\n'),
    src,
    dest,
    ...axisArgs,
  ], { stdio: 'inherit' });
}

/** Build a compact WOFF2 subset for the browser from a static TTF. */
async function subsetWoff2(src, dest, unicodes) {
  execFileSync('python3', [
    '-c',
    [
      'import sys',
      'from fontTools import subset',
      'src, dst, unicodes = sys.argv[1:]',
      'args = [src, f"--output-file={dst}", f"--unicodes={unicodes}",',
      '        "--layout-features=*", "--flavor=woff2", "--no-hinting",',
      '        "--desubroutinize", "--name-IDs=*", "--drop-tables+=DSIG"]',
      'subset.main(args)',
    ].join('\n'),
    src,
    dest,
    unicodes,
  ], { stdio: 'inherit' });
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  const t0 = Date.now();
  const report = { fonts: 0, webfonts: 0, ocr: 0, skipped: 0, failed: [] };

  console.log('CamScan asset fetch');
  console.log('-------------------');

  const canSubset = haveFonttools();
  if (!canSubset) {
    console.warn('! fonttools/brotli not available — web WOFF2 subsets will be skipped.');
    console.warn('  Install with: pip install fonttools brotli');
  }

  await fs.mkdir(pub('fonts', 'webfonts'), { recursive: true });
  const rawDir = pub('fonts', '.raw');
  await fs.mkdir(rawDir, { recursive: true });

  const cssRules = [];
  const licenceLines = [
    '# Bundled font licences',
    '',
    'All font families below are distributed under the SIL Open Font License 1.1',
    '(https://openfontlicense.org/) and are redistributed unmodified except for',
    'instancing variable axes and subsetting for the web build.',
    '',
  ];

  for (const fam of FONT_FAMILIES) {
    console.log(`\nFont: ${fam.family}`);
    licenceLines.push(`- **${fam.family}** — SIL OFL 1.1 — https://github.com/google/fonts/tree/main/ofl/${fam.family.toLowerCase()}`);

    for (const f of fam.files) {
      const rawPath = path.join(rawDir, `${fam.family}-raw-${f.weight}${f.style === 'italic' ? 'i' : ''}.ttf`);
      const outPath = pub('fonts', f.file);
      const woffPath = pub('fonts', 'webfonts', f.file.replace(/\.ttf$/, '.woff2'));
      try {
        const dl = await download(f.url, rawPath, { minSize: 20_000 });
        if (dl.skipped) report.skipped++;
        const wantStatic = f.variable || !(await exists(outPath));
        if (wantStatic) {
          if (f.variable) await instantiate(rawPath, outPath, f.variable);
          else await fs.copyFile(rawPath, outPath);
        }
        report.fonts++;

        if (canSubset && !(await exists(woffPath))) {
          await subsetWoff2(outPath, woffPath, fam.script === 'arabic' ? ARABIC_UNICODES : LATIN_UNICODES);
          report.webfonts++;
        }
        const sizeTtf = (await fs.stat(outPath)).size;
        cssRules.push(
          `@font-face{font-family:'${fam.cssName}';src:url('/fonts/webfonts/${f.file.replace(/\.ttf$/, '.woff2')}') format('woff2');font-weight:${f.weight};font-style:${f.style};font-display:swap;}`,
        );
        console.log(`  ✓ ${f.file} (${(sizeTtf / 1024).toFixed(0)} KB)`);
      } catch (err) {
        report.failed.push(`font:${fam.family}:${f.file}`);
        console.error(`  ✗ ${f.file}: ${err.message}`);
      }
    }
  }

  await fs.writeFile(pub('fonts', 'fonts.css'), `/* generated by scripts/fetch-assets.mjs */\n${cssRules.join('\n')}\n`);
  await fs.writeFile(pub('fonts', 'LICENSES.md'), `${licenceLines.join('\n')}\n`);
  await fs.writeFile(pub('fonts', 'families.json'), JSON.stringify({
    families: FONT_FAMILIES.map((f) => ({
      id: f.family,
      cssName: f.cssName,
      script: f.script,
      faces: f.files.map((x) => ({ file: x.file, weight: x.weight, style: x.style })),
    })),
  }, null, 2));

  // ---- OCR language packs ------------------------------------------------
  console.log('\nOCR language packs (tessdata_fast, Apache-2.0)');
  await fs.mkdir(pub('tessdata'), { recursive: true });
  const ocrManifest = [];
  for (const [code, en, ar, mb] of OCR_LANGS) {
    const dest = pub('tessdata', `${code}.traineddata`);
    try {
      const dl = await download(`${TESSDATA_BASE}${code}.traineddata`, dest, { minSize: 200_000 });
      if (dl.skipped) report.skipped++;
      report.ocr++;
      ocrManifest.push({ code, en, ar, sizeMB: mb, sizeBytes: dl.size });
      console.log(`  ✓ ${code}.traineddata (${(dl.size / 1024 / 1024).toFixed(1)} MB)`);
    } catch (err) {
      report.failed.push(`ocr:${code}`);
      console.error(`  ✗ ${code}: ${err.message}`);
    }
  }
  await fs.writeFile(pub('tessdata', 'manifest.json'), JSON.stringify({ generatedAt: new Date().toISOString(), langs: ocrManifest }, null, 2));

  // ---- OpenCV.js ---------------------------------------------------------
  console.log('\nOpenCV.js');
  try {
    await download(OPENCV_URL, pub('vendor', 'opencv.js'), { minSize: 5_000_000 });
    const st = await fs.stat(pub('vendor', 'opencv.js'));
    console.log(`  ✓ opencv.js (${(st.size / 1024 / 1024).toFixed(1)} MB)`);
  } catch (err) {
    report.failed.push('opencv');
    console.error(`  ✗ opencv.js: ${err.message}`);
  }

  // ---- Tesseract worker + core ------------------------------------------
  console.log('\nTesseract.js worker + WASM core');
  const tessOut = pub('vendor', 'tesseract');
  await fs.mkdir(tessOut, { recursive: true });
  // tesseract.js picks a core build at runtime (relaxedsimd → simd → plain)
  // and `importScripts` the `.wasm.js` glue, which then streams the sibling
  // `.wasm`. ALL variants must exist or the chosen one 404s at OCR time.
  const cores = ['relaxedsimd-lstm', 'simd-lstm', 'lstm'];
  const copies = [
    ['node_modules/tesseract.js/dist/worker.min.js', 'worker.min.js'],
    ['node_modules/tesseract.js-core/tesseract-core.wasm.js', 'tesseract-core.wasm.js'],
    ...cores.flatMap((core) => [
      [`node_modules/tesseract.js-core/tesseract-core-${core}.wasm.js`, `tesseract-core-${core}.wasm.js`],
      [`node_modules/tesseract.js-core/tesseract-core-${core}.wasm`, `tesseract-core-${core}.wasm`],
      [`node_modules/tesseract.js-core/tesseract-core-${core}.js`, `tesseract-core-${core}.js`],
    ]),
  ];
  for (const [from, to] of copies) {
    try {
      await fs.copyFile(path.join(root, from), path.join(tessOut, to));
      console.log(`  ✓ ${to}`);
    } catch (err) {
      report.failed.push(`tesseract:${to}`);
      console.error(`  ✗ ${to}: ${err.message} (run npm install first)`);
    }
  }

  // ---- Clean up raw downloads (not shipped) ------------------------------
  await fs.rm(rawDir, { recursive: true, force: true });

  console.log('\n-------------------');
  console.log(`fonts: ${report.fonts} · webfonts: ${report.webfonts} · ocr packs: ${report.ocr} · skipped: ${report.skipped} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (report.failed.length) {
    console.error(`FAILED: ${report.failed.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('All assets ready.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
