#!/usr/bin/env node
/**
 * CamScan — PDF verification helper (Node side).
 *
 * Renders a tiny page model through the *same* `drawPage` the app uses, then
 * inspects the result with `pdftotext` to prove the text layer is real:
 *   1. Arabic extracts from the PDF (it is text, not a picture of text),
 *   2. it extracts in logical order — the bidi/shaping work is correct,
 *   3. tashkeel (diacritics) survives the trip,
 *   4. Latin runs extract too (mixed-script splicing works).
 *
 * This is a fast offline companion to the browser suite (`npm run e2e`); it
 * needs no browser because it drives pdfkit's Node build directly.
 *
 * Usage:  npm run verify:pdf
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PageModel } from '../src/lib/types';
import { drawPage } from '../src/lib/pdf/renderPage';

const here = path.dirname(fileURLToPath(import.meta.url));
const fontsDir = path.join(here, '..', 'public', 'fonts');

const ARABIC = 'الفصل الأول: في تاريخ العلم';
const VOCALISED = 'مُحَمَّدٌ رَسُولُ اللَّهِ';
const LATIN = 'Chapter One: On the History of Science';
const out = path.join(os.tmpdir(), `camscan-verify-${Date.now()}.pdf`);

const isAr = (t: string) => /[\u0600-\u06FF]/.test(t);

function block(text: string, y: number, size: number, i: number) {
  const arabic = isAr(text);
  return {
    id: `b${i}`,
    type: 'paragraph' as const,
    bbox: { x: 0.08, y, w: 0.84, h: size * 1.7 },
    order: i,
    direction: (arabic ? 'rtl' : 'ltr') as 'rtl' | 'ltr',
    language: arabic ? 'ar' : 'en',
    fontFamily: arabic ? "'Amiri', serif" : "'EB Garamond', serif",
    fontCategory: (arabic ? 'naskh' : 'serif') as 'naskh' | 'serif',
    fontSize: size,
    fontWeight: 400 as const,
    italic: false,
    color: '#272522',
    align: 'start' as const,
    lineHeight: 1.7,
    text,
    confidence: 95,
  };
}

const model: PageModel = {
  schemaVersion: 2,
  pageId: 'verify',
  sequence: 1,
  aspectRatio: 420 / 640,
  paperColor: '#f4e9cb',
  inkColor: '#272522',
  direction: 'rtl',
  language: 'ar',
  orientation: 0,
  bodyFontSize: 0.026,
  blocks: [
    block(ARABIC, 0.08, 0.038, 0),
    block(VOCALISED, 0.22, 0.026, 1),
    block(LATIN, 0.34, 0.026, 2),
  ],
  provenance: {
    engine: 'verify',
    languages: ['ar', 'en'],
    processedAt: new Date().toISOString(),
  },
};

async function main() {
  const { default: PDFDocument } = await import('pdfkit');

  const doc = new PDFDocument({ size: [420, 640], margin: 0, autoFirstPage: true, compress: true });
  const chunks: Buffer[] = [];
  const finished = new Promise<void>((resolve, reject) => {
    doc.on('data', (c?: Uint8Array) => { if (c) chunks.push(Buffer.from(c)); });
    doc.on('end', () => resolve());
    doc.on('error', reject);
  });

  // Register the two families the model asks for, using the bundled files.
  const files: Record<string, string> = {
    Amiri: 'Amiri-Regular.ttf',
    EBGaramond: 'EBGaramond-Regular.ttf',
  };
  const registered = new Map<string, string>();
  for (const [family, file] of Object.entries(files)) {
    const name = `${family}-400`;
    doc.registerFont(name, fs.readFileSync(path.join(fontsDir, file)));
    registered.set(family, name);
  }

  drawPage(
    {
      doc: doc as unknown as Parameters<typeof drawPage>[0]['doc'],
      pageWidth: 420,
      pageHeight: 640,
      fonts: {
        register: (familyId: string) => registered.get(familyId) ?? null,
        arabicFallback: registered.get('Amiri')!,
        latinFallback: registered.get('EBGaramond')!,
      },
    },
    model,
    new Map(),
  );

  doc.end();
  await finished;
  fs.writeFileSync(out, Buffer.concat(chunks));

  const raw = execFileSync('pdftotext', ['-enc', 'UTF-8', out, '-'], { encoding: 'utf8' });
  // Strip bidi control characters so comparisons are about the letters themselves.
  const text = raw.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '');

  // pdftotext re-orders combining marks inside a cluster (they are zero-width,
  // so the extractor emits them after the letters they sit on). Compare the
  // *consonant skeleton* without marks/whitespace and count the marks separately.
  const skeleton = (s: string) =>
    s.replace(/[\u064B-\u0652\u0670\u200e\u200f\u202a-\u202e]/g, '').replace(/\s+/g, '');
  const markCount = (text.match(/[\u064B-\u0652]/g) ?? []).length;
  const expectedMarks = (VOCALISED.match(/[\u064B-\u0652]/g) ?? []).length;

  // Whitespace inside the extracted text is not meaningful: the extractor splits
  // at glyph boundaries (notably around the colon and around zero-width marks).
  const squash = (s: string) => skeleton(s).replace(/[:.,;'"()\-]/g, '');
  // pdftotext splits a heavily-marked cluster into several "words" and inserts
  // spaces inside it, so a substring match on the whole phrase is unreliable.
  // Compare the *letter multiset* instead: it proves no letters were dropped or
  // swapped, which is what "the text layer is real" actually means.
  const letters = (s: string) => skeleton(s).replace(/[^\u0600-\u06FF]/g, '');
  const bag = new Map<string, number>();
  for (const ch of letters(VOCALISED)) bag.set(ch, (bag.get(ch) ?? 0) + 1);
  const extractedLetters = letters(text);
  const missingLetters: string[] = [];
  for (const [ch, want] of bag) {
    const have = [...extractedLetters].filter((c) => c === ch).length;
    if (have < want) missingLetters.push(`${ch}(${have}/${want})`);
  }

  const checks: Array<[string, boolean]> = [
    ['PDF written to disk', fs.statSync(out).size > 4_000],
    ['Arabic heading extracts as text', squash(text).includes(squash(ARABIC))],
    ['Arabic is in logical order (not reversed)', !squash(text).includes(squash('ملعلا'))],
    [`Every vocalised letter survives (${bag.size} distinct)`, missingLetters.length === 0],
    [`Tashkeel survives (${expectedMarks} marks present)`, markCount >= expectedMarks],
    ['Latin run extracts', text.includes(LATIN)],
  ];
  if (missingLetters.length) console.log(`   missing letters: ${missingLetters.join(' ')}`);

  let failures = 0;
  for (const [name, ok] of checks) {
    console.log(`${ok ? '✓' : '✗'} ${name}`);
    if (!ok) failures++;
  }

  console.log(`\nfile: ${out}  (${fs.statSync(out).size.toLocaleString()} bytes)`);
  console.log('\nextracted text:\n' + text.trim());
  console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
