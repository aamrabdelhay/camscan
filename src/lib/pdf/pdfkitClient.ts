/**
 * CamScan — pdfkit, purely client-side.
 *
 * Why this file exists: `pdfkit` publishes two builds behind conditional
 * exports. The **browser** build (`js/pdfkit.browser.mjs`) drops the 14 standard
 * PDF fonts and exposes `registerStdFonts`, while the **Node** build
 * (`js/pdfkit.node.mjs`) bundles them. Next.js also compiles every client
 * component once for SSR, where the Node build wins — so a static
 * `import { registerStdFonts } from 'pdfkit'` fails to compile with
 * "Export registerStdFonts doesn't exist in target module".
 *
 * The exporter is only ever used from the browser, so we load pdfkit lazily at
 * call time, after the page has hydrated. That keeps pdfkit out of the server
 * graph entirely and out of the initial bundle.
 */
import type PDFDocument from 'pdfkit';

type PdfkitModule = {
  default: typeof PDFDocument;
  registerStdFonts?: (...fonts: Array<{ name: string }>) => void;
};

let cached: Promise<{ PDF: typeof PDFDocument; registerStdFonts: PdfkitModule['registerStdFonts'] }> | null = null;

export function loadPdfkit(): Promise<{ PDF: typeof PDFDocument; registerStdFonts: PdfkitModule['registerStdFonts'] }> {
  if (cached) return cached;
  cached = (async () => {
    const mod = (await import('pdfkit')) as unknown as PdfkitModule;
    return { PDF: mod.default, registerStdFonts: mod.registerStdFonts };
  })();
  return cached;
}

/**
 * Register the standard fonts the browser build omits. Without this, any
 * fallback to Helvetica throws in the middle of export — which is what made
 * exports hang silently during development.
 */
let stdFontsRegistered = false;
export async function ensureStdFonts(registerStdFonts: PdfkitModule['registerStdFonts']): Promise<void> {
  if (stdFontsRegistered || !registerStdFonts) return;
  const [helvetica, bold, oblique, courier, times] = await Promise.all([
    import('pdfkit/standard-fonts/Helvetica').then((m) => m.default),
    import('pdfkit/standard-fonts/HelveticaBold').then((m) => m.default),
    import('pdfkit/standard-fonts/HelveticaOblique').then((m) => m.default),
    import('pdfkit/standard-fonts/Courier').then((m) => m.default),
    import('pdfkit/standard-fonts/TimesRoman').then((m) => m.default),
  ]);
  registerStdFonts(helvetica, bold, oblique, courier, times);
  stdFontsRegistered = true;
}
