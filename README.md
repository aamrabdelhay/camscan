# CamScan

**Turn old, fragile paper books into searchable, editable digital replicas — locally, in the browser.**

CamScan is a local-first PWA: you point a camera at a page, it finds the page, waits for it to be
steady, captures it, recognises the text (Arabic and Latin, including mixed-script pages), and
rebuilds the page as **real HTML text** — not a picture of a page. Every page keeps its own
typography, sampled paper colour and ink colour, and can be edited, searched and exported to a PDF
with a genuine text layer.

By default, nothing is uploaded: camera frames, recognised text and reconstructed pages stay in IndexedDB on the device. The optional AI assistant is separate: only after explicit consent and submission, the selected OCR text (never page images) is sent to OpenRouter through a request-only CamScan endpoint. The endpoint pins every request to OpenRouter's $0 `openrouter/free` router and never supplies a paid fallback. The user enters their own free OpenRouter API key; the app does not persist it.

---

## Quick start

```bash
npm install          # installs deps (also fetches fonts/tessdata/OpenCV/Tesseract on first run)
npm run dev          # http://localhost:3000
```

`predev`/`prebuild` run `npm run assets` (downloads the free fonts, OCR language packs and
Tesseract/OpenCV builds into `public/`) and `npm run build:workers` (bundles the Web Workers).
Both are idempotent — already-present files are skipped.

### All commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server on `0.0.0.0:3000` (assets + workers first) |
| `npm run build` | Production build (assets + workers first) |
| `npm start` | Serve the production build on `0.0.0.0:3000` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | `eslint .` (flat config, Next 16 presets) |
| `npm test` | Vitest unit suite (96 tests) |
| `npm run e2e` | Full browser acceptance suite (needs `npm run dev` running) |
| `npm run verify:pdf` | Node-side check that Arabic shaping/bidi survive PDF export |
| `npm run assets` | Re-fetch fonts / OCR packs / vendor builds |
| `npm run build:workers` | Rebuild `public/workers/*` from `src/workers/*` |

---

## What it does

### Scanning
- **Automatic capture.** The camera runs continuously. A page quad is detected with a pure-TS
  detector (adaptive threshold → morphology → extreme-corner extraction), the frame is monitored
  for stability, and it captures itself after **~0.5 s of steadiness**. No shutter press per page.
- **The camera never waits for OCR.** A capture is persisted as a Blob immediately; OCR runs in a
  worker pool (up to 3 workers) and the live preview returns to full speed at once.
- **Page order = capture order.** Order is assigned at capture time and never depends on which page
  finishes OCR first.
- **Upload fallback.** Whole folders of photos can be imported instead of using the camera.
- **Guidance, not enforcement.** On-screen hints for blur, glare, shadows, a page cut off, or
  "move closer", plus a first-use tips screen. Fragile books: the tips explicitly say not to press
  the spine flat and not to use direct flash.

### Recognition
- **Tesseract.js in a Web Worker**, behind an `OcrProvider` interface
  (`src/lib/ocr/provider.ts`) — swapping in another engine does not touch the UI.
- **Language packs**: `ara`, `eng`, `fra`, `deu`, `fas`, `urd`, `tur` (Arabic + English on by
  default). Adding a pack is a one-line change in `scripts/fetch-assets.mjs`.
- **Mixed Arabic/Latin pages.** A single `ara+eng` pass forces both models on every line and
  produces garbage. CamScan instead runs the primary language, marks rows it is unsure about,
  re-reads the page with the secondary model, and splices in a replacement **only** when the new
  line is both clearly more confident *and* actually in the right script. On the test fixture this
  lifted a Latin paragraph from `Chapter One…`-grade garbage to 96 % confidence and the page from
  50.6 → 74.8 overall.
- **Adaptive segmentation.** If the first pass stops before the bottom of the printed area (a real
  failure mode on mixed pages), it re-runs with uniform-block segmentation and keeps the fuller read.
- **Preprocessing** on a rectified copy: integral-image illumination flattening (fixes phone-camera
  shadows), ink/paper percentile stretch, optional gamma, colour preserved via luminance ratio.
  Five profiles: `standard`, `fragile`, `smallPrint`, `fadedInk`, `historical`.
- **Quality is measured on the rectified original**, never on the enhanced image (measuring the
  enhanced one produced false "too bright"/"glare" warnings).

### The replica
- Every block is a **real DOM text node** at its measured position and size — selectable,
  searchable, editable. Only illustrations are images.
- Font size is fitted to the measured **line width** (height alone inflates Arabic text badly),
  line height to the measured block height, and each source line keeps its own box, so a page with
  staggered columns reproduces line-for-line instead of re-wrapping.
- Fonts are mapped per block between an Arabic stack (Amiri, Scheherazade New, Noto Naskh, Noto
  Kufi, Cairo) and a Latin stack (EB Garamond, Merriweather, Inter, JetBrains Mono) — all OFL.
- Paper and ink colours are sampled from the photograph (interior sampling, ink hue derived from
  the paper when the sample is unreliable), so an old yellowed page looks old rather than white.

### Reader
Four views: **Replica** (real text), **Original** (the rectified image, with a one-tap toggle to the
untouched capture), **Side-by-side** (proofreading), **Comfortable** (single reflowed column at a
readable size). Per-book search with highlighted matches, zoom, page navigation, and an editor for
block text plus font/type/alignment/size/colour.

### Optional AI assistant (cloud, opt-in)

From the book reader, users can ask the assistant to summarise, explain, translate, review likely OCR errors, or answer a question about recognised text. This is separate from transcription: the assistant never silently corrects, overwrites or reprocesses saved OCR text.

- Local Tesseract remains the default OCR engine and works without any AI API key.
- The optional AI assistant requires a user's own OpenRouter API key from [OpenRouter API Keys](https://openrouter.ai/settings/keys); it is not stored in localStorage or a database and is cleared from the dialog when closed.
- By default, only the current page is sent; the user may choose book text, capped at 12,000 characters. Page images are never sent to the assistant.
- The server-side endpoint hard-codes the zero-priced `openrouter/free` router, sends no paid-model fallback list, and never accepts a model ID from the browser. A missing key, exhausted free quota, or unavailable free model returns an error instead of trying a paid service.
- OpenRouter's free router is rate-limited and model availability can vary; see the [official free-model docs](https://openrouter.ai/collections/free-models).
- Do not send confidential, privileged, or restricted text unless you are authorised to share it with the provider.

### Editing and review
- Edits create **revisions**; the original OCR text is kept, and reprocessing **does not overwrite
  user edits** — it preserves them and says so in the job record.
- Low-confidence blocks and pages are flagged **Needs review**; a page can be marked reviewed.
- Page actions: retake, reorder (▲/▼ and drag), insert, delete — all with confirmation and
  transaction-safe renumbering.

### Search
One MiniSearch index over the whole library, with an Arabic-normalised key (tashkeel stripped,
alef/hamza folded, tatweel removed) **plus** a looser key (teh marbuta, alef maqsura) used only as a
lower-priority fallback, so exact matches always rank first. Long Arabic queries work too: the
definite article is stripped when matching, which is what lets `العلمان` find an indexed `علمان`.
Results show snippets with the match marked and jump to the highlighted block in the reader.

### Export
- **PDF with real, selectable text** — drawn as vector text from the stored page model, with a
  genuine Unicode text layer, correct Arabic shaping (HarfBuzz via fontkit) and RTL run ordering.
  An optional title page and a page range are supported.
- **Photo-only PDF** is available but is explicitly labelled as an image file that cannot be
  searched.
- **Backup/restore** as a ZIP containing the manifest, every original photograph and the page
  models, with validation on import.
- Storage usage is reported against the browser quota, with a warning to keep backups.

### PWA
Installable (manifest + maskable icons), offline shell, and a service worker that cache-first serves
the heavy assets (fonts, language packs, Tesseract/OpenCV) and falls back to the app shell offline.
Arabic-first UI with full RTL/LTR switching (the whole layout mirrors), and light/dark themes.

---

## PDF export proof

The claim "selectable text with correct Arabic shaping" is checked by an actual test, not asserted.
`npm run e2e` exports a PDF from the running app in a real browser and then inspects it with
`pdftotext` and `pdfimages`:

```
✓ PDF produced from the app — 29 KB
✓ PDF page count matches book (+ title page) — 3 pages
✓ PDF text is selectable/extractable (not an image) — 969 chars
✓ PDF contains the edited Arabic text
✓ PDF contains Arabic body text
✓ PDF contains Latin text
✓ Arabic words extract in correct logical order
✓ replica PDF contains no page photographs — 0 embedded image(s)
```

The same was verified against the **production build** (`next build` + `next start`): a 25 KB PDF
whose text layer extracts `الفصل الأول: في تاريخ العلم` and the Latin paragraph, with zero embedded
images. Arabic also survives `pdftotext` as *logical* order (`تاريخ العلم` comes back joined and in
order, not reversed).

The engine choice came from a measured comparison, not a guess:

| Candidate | Result |
|---|---|
| **pdf-lib** | Shapes Arabic, but loses glyph positioning (marks detach) → rejected |
| **pdfkit 0.20** | HarfBuzz shaping, correct advances, correct tashkeel, searchable text layer → **chosen** |

---

## Implemented vs. extension

Everything in the required-scope column was built and exercised. The extension column is
deliberately not built — those are the honest edges of this project.

| Required scope | Status | Where |
|---|---|---|
| Camera auto-capture, quads, ~0.5 s stability, no shutter per page | ✅ implemented | `useCamera.ts`, `imageAnalysis.ts`, `CameraView.tsx` |
| Camera never blocked by OCR; order = capture order | ✅ implemented | `pipeline.ts` (worker pool), `repository.addPage` |
| IndexedDB (Dexie) behind a repository interface | ✅ implemented | `db.ts`, `repository.ts` |
| OpenCV.js preprocessing | ⚠️ **vendored but not on the runtime path** | `public/vendor/opencv.js` |
| Tesseract.js real OCR behind `OcrProvider` | ✅ implemented | `ocr/tesseractProvider.ts` |
| ar/en (+ more packs), mixed-script handling | ✅ implemented | `processing.worker.ts` |
| MiniSearch with Arabic normalisation | ✅ implemented | `search.ts`, `normalize.ts` |
| Structured, versioned page model | ✅ implemented | `types.ts` (`PageModel`, `version`) |
| Real-text HTML/CSS replica (never photo-as-page) | ✅ implemented | `ReplicaPage.tsx` |
| Per-block font/colour sampling → free fonts | ✅ implemented | `pageModel.ts`, `public/fonts` |
| Reader: Replica / Original / Side-by-side / Comfortable | ✅ implemented | `app/book/[id]/page.tsx` |
| Inline editing + revisions, no silent overwrite | ✅ implemented | `repository.savePageModel`, revisions store |
| Review flags | ✅ implemented | `uncertain`, `status: 'review'` |
| Reorder / insert / delete / retake, safe renumbering | ✅ implemented | `ordering.ts`, `repository.reorderPages` |
| Global + in-book search with snippets and jump-to | ✅ implemented | `search.ts`, home + reader |
| PDF export with real selectable text + Arabic shaping | ✅ implemented **and tested** | `pdf/browserExport.ts`, `pdf/renderPage.ts` |
| Backup / restore ZIP | ✅ implemented | `backup.ts` |
| PWA / offline | ✅ implemented | `manifest.webmanifest`, `sw.js` |
| Arabic-default i18n, RTL/LTR, dark mode | ✅ implemented | `i18n.ts`, `AppProviders.tsx` |
| Tests + README + honest limitations | ✅ implemented | `tests/`, this file |
| **Cloud sync backend** | ❌ extension | repository interface is the seam |
| **Auth / accounts** | ❌ extension (no fake auth is shipped) | — |
| **Server-side PDF rendering** | ❌ extension (removed; not needed) | — |
| **Full layout analysis (columns, floats, tables)** | ⚠️ partial | heuristic row/column/gutter detection |
| **Automatic font *identification*** | ❌ extension (category guess only) | `inferFontCategory` |
| **Handwriting / manuscript recognition** | ❌ out of scope | — |

### One deliberate deviation, stated plainly

**OpenCV.js is downloaded and served but the working CV path is pure TypeScript.** The detector and
preprocessor in `src/lib/imageAnalysis.ts` (integral-image flattening, adaptive threshold,
morphology, extreme-corner extraction) run inside a worker without a 11 MB WASM load and are fully
unit- and e2e-tested. The OpenCV build stays vendored so an alternate detector can be dropped in
behind the same interface; it is not claimed to be in use.

---

## Honest limitations

Recognition is **not** perfect, and the app is built assuming that:

- **Old, stained or low-contrast pages lose accuracy.** Tesseract is a ~2019-era LSTM engine. On
  the synthetic Arabic/Latin fixture the page averages **74.8 %** confidence; individual lines in
  the dirtiest band can drop to 24–43 % and stay wrong. Low-confidence blocks are flagged
  **"Needs review"** rather than silently accepted, and the reader highlights uncertain blocks with
  a dashed outline.
- **Mixed-script band replacement is a heuristic.** It fixes whole rows that belong to the other
  script. A *single line* mixing scripts (an Arabic sentence with a Latin citation inside it) is
  still recognised by one model and can come out wrong.
- **Reading order is an approximation.** Rows, a column gutter and footnote separation are
  detected; complex layouts (tables, floats, multi-column with a full-width heading) can still be
  ordered wrongly.
- **Font identification is by category** (naskh / kufi / serif / sans), not by identifying the
  actual typeface. No font-recognition engine is used, and none is claimed.
- **Diacritic stacking is imperfect in the PDF replica.** Letters, ligatures, joining forms and
  bidi order are correct, and a single mark sits where the font's anchors put it. But a cluster
  with *two* marks on one letter (shadda + vowel, as in مُحَمَّد) draws the marks side by side
  instead of stacked: the bundled pdfkit/fontkit pair skips the font's mark-composition step and
  emits the marks in logical order, which reverses in an RTL run. This is an upstream fontkit
  limitation, documented here rather than papered over — the HTML replica renders it correctly,
  and `npm run verify:pdf` asserts letters, tashkeel presence and logical order (not mark
  stacking). Run `node scripts/verify-pdf.ts` output through `pdftoppm` if you want to see it.
- **Illustrations are not extracted automatically** — an illustration is represented as a
  placeholder unless a block is marked as one.
- **Camera auto-capture logic is covered in CI with a deterministic fake-camera video.** The test
  verifies one capture for a held page and a second capture after page content changes while the
  outer page boundary stays fixed. Real-device exposure changes, torch controls and rear-camera
  selection still need a physical phone test.
- **No background processing after the tab closes.** Jobs are persisted and resumed when the app is
  reopened; nothing runs while it is closed.
- **IndexedDB is not archival storage.** Browsers evict it (especially on iOS). The app warns near
  quota and offers backup/restore — keep ZIP backups of anything you care about.
- **One tab at a time.** Two tabs open on the same library will both work, but processing and stats
  are not coordinated between them.

---

## Privacy

- No account, no key, no server round-trip for core work. `npm install` and `npm run assets` need
  the network **once** to download fonts and language packs; after that it runs offline.
- Page images and recognised text never leave the device. There is no telemetry.
- The only server route is `/health`, used by the tests.
- The PDF and ZIP are generated **in the browser** and downloaded directly.

---

## Deploying (Vercel, or any static-friendly host)

```bash
npm run build      # prebuild fetches assets + builds workers
npm start          # or: vercel deploy
```

- Everything is client-side, so Vercel's default settings work as-is.
- `public/vendor` (~35 MB) and `public/tessdata` (~14 MB) are served as static files with a long
  `Cache-Control` (`next.config.ts`); the service worker caches them after first use.
- If you prefer not to ship the vendored bytes, run `npm run assets` in the build step instead and
  add `public/fonts`, `public/tessdata`, `public/vendor` to `.gitignore`.

---

## Architecture

```
src/app/                     App Router pages: library (/), reader (/book/[id]), scanner (/book/[id]/scan)
src/components/
  scanner/CameraView.tsx     live preview, quad overlay, hints, capture strip
  reader/ReplicaPage.tsx     the real-text page renderer (per-line placement)
  reader/ReplicaPage.tsx::ComfortablePage   reflowed single-column view
src/lib/
  useCamera.ts               camera lifecycle, stability gate, capture
  imageAnalysis.ts           quad detection, rectification, enhancement, colour/quality sampling
  pageModel.ts               lines → blocks, reading order, fonts, per-line boxes
  ocr/{provider,tesseractProvider}.ts   the OCR seam + the Tesseract implementation
  pipeline.ts                worker pool, retries, watchdog, resume
  db.ts / repository.ts      Dexie schema + the storage interface
  search.ts / normalize.ts   MiniSearch index + Arabic normalisation
  pdf/{renderPage,browserExport,pdfkitClient}.ts   vector PDF with shaped text
  backup.ts                  ZIP backup / validated restore
  jobs.ts / ordering.ts      pure state-machine and ordering helpers (unit-tested)
src/workers/*                cv / processing / pdf workers (bundled into public/workers)
tests/                       Vitest suites (normalisation, page model, ordering, jobs, search, export)
e2e/acceptance.mjs           the end-to-end browser acceptance suite
```

**Data flow.** `CameraView` → `useCamera` (stability + capture) → `repository.addPage()` (Blob saved
immediately) → `ProcessingPool` → `processing.worker` (rectify → enhance → OCR → page model) →
`repository.savePageModel()` → search index + reader.

### PDF export implementation note

`pdfkit` publishes two builds behind conditional exports. The **browser** build omits the 14
standard PDF fonts and exposes `registerStdFonts`; the **Node** build bundles them. Next compiles
client components for SSR too, where the Node build wins — so a static
`import { registerStdFonts } from 'pdfkit'` fails the build, and in the browser an unregistered
Helvetica throws mid-export (which is exactly what made export hang silently during development).
`src/lib/pdf/pdfkitClient.ts` loads pdfkit lazily on the client and registers the standard fonts
once before the first document. That is why export works in both `next dev` and `next start`.

---

## Testing

```bash
npm run typecheck     # clean
npm run lint          # 0 errors
npm test              # 96 unit tests, 6 files
npm run verify:pdf    # Arabic shaping/bidi survive the PDF export path (Node, no browser)
npm run dev &         # then:
npm run e2e           # 42 browser checks
```

The acceptance suite (`e2e/acceptance.mjs`) walks the whole workflow in a real Chromium and writes
`e2e/generated/` with screenshots, the exported PDF and a JSON report:

1. create a book, reload, confirm it survived
2. import pages, confirm the **originals are stored immediately**
3. confirm page order is capture order while OCR finishes out of order
4. edit recognised Arabic text, reload, confirm it persisted and is findable with a diacritic-free query
5. confirm the replica renders real text (not an image) with the sampled paper colour
6. export a PDF and verify it with `pdftotext` / `pdfimages` (selectable Arabic + Latin, no page photos)
7. backup → wipe the database → restore → confirm books, originals, models and edit flags returned
8. feed a corrupt image and confirm the job fails cleanly **and the original capture survives**
9. deny camera permission and confirm an explicit message, no fake stream, upload still offered
10. phone viewport has no horizontal overflow; no unexpected console errors

---

## Licences

Application code: MIT. Bundled assets: fonts under OFL 1.1
(`public/fonts/LICENSES.md`), Tesseract language packs and `tesseract.js`/OpenCV.js under
Apache-2.0. See the licence file shipped with each downloaded asset.
