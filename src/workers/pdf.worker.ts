/// <reference lib="webworker" />
/**
 * CamScan — PDF export worker (optional path).
 *
 * PDF generation currently runs on the main thread in `lib/pdf/browserExport.ts`
 * because pdfkit's browser build needs DOM-ish shims and canvas buffers. This
 * worker exists so a future/alternative engine (e.g. a WASM PDF writer) can be
 * dropped in without changing the UI contract:
 *
 *   in : { type:'export', id, pages, book, mode }
 *   out: { type:'progress' | 'done' | 'error', id, ... }
 *
 * It deliberately does NOT use tesseract or touch IndexedDB.
 */
export {};

self.onmessage = (event: MessageEvent<{ type: string; id: number }>) => {
  if (event.data?.type === 'ping') {
    self.postMessage({ type: 'pong', id: event.data.id });
  }
};
