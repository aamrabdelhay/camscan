/**
 * CamScan — OCR provider interface.
 *
 * The UI and pipeline only ever talk to this interface, so a stronger engine
 * (a vision-language model API, PaddleOCR, Surya, …) can be added later without
 * touching the scanner, reader or exporter.
 *
 * A provider must:
 *  - recognise a page image (Blob/ImageBitmap/OffscreenCanvas/HTMLCanvas)
 *  - return line-level boxes with confidences, in *normalised* page coordinates
 *  - preserve the recognised text verbatim (diacritics included) — no rewriting
 *  - report the engine name/version for provenance
 *  - stream progress through the `onProgress` callback
 *  - be cancellable (`terminate`)
 */
import type { NormBox } from '../types';

export interface OcrRequest {
  /** Image to recognise. Any of these types is accepted by the Tesseract provider. */
  image: Blob | ImageBitmap | OffscreenCanvas | HTMLCanvasElement | ArrayBuffer;
  /** Language codes in priority order, e.g. ['ara','eng']. */
  languages: string[];
  /** Called with 0..1 progress and a human-readable stage. */
  onProgress?: (progress: number, stage?: string) => void;
  /** Abort signal so a cancelled job stops feeding the worker. */
  signal?: AbortSignal;
  /**
   * Optional region of interest in normalised coordinates — providers that can
   * crop cheaply (all of them) should only recognise this area.
   */
  region?: NormBox;
  /** Page-level hint used by some engines to pick a script model. */
  directionHint?: 'rtl' | 'ltr';
  /** Tesseract page-segmentation mode (as a string, e.g. '3', '6'). */
  psm?: string;
  /** Upscale a cropped region to at least this pixel width before OCR. */
  minWidth?: number;
  /**
   * Normalised bottom edge (0..1) of the page's expected printed area, as
   * measured from ink density. Providers compare it with the recognised text
   * extent to detect a truncated page segmentation pass.
   */
  expectedContentBottom?: number;
}

export interface OcrWord {
  text: string;
  confidence: number;
  bbox: NormBox;
}

export interface OcrLine {
  text: string;
  confidence: number;
  bbox: NormBox;
  words?: OcrWord[];
  /** Per-line language when the engine can tell; otherwise undefined. */
  language?: string;
}

export interface OcrPageResult {
  lines: OcrLine[];
  /** Full recognised text (engine order). */
  text: string;
  /** 0..100 average confidence. */
  confidence: number;
  engine: string;
  engineVersion?: string;
  languages: string[];
  durationMs: number;
  /** Non-fatal warnings (e.g. a language pack failed to load). */
  warnings?: string[];
}

export interface OcrProvider {
  readonly id: string;
  readonly name: string;
  /** Human note shown in settings, e.g. "Runs locally in your browser". */
  readonly description: string;
  /** True when the provider can run right now (network/asset availability). */
  isAvailable(): Promise<boolean>;
  recognize(request: OcrRequest): Promise<OcrPageResult>;
  /** Release workers/WASM memory. Safe to call repeatedly. */
  terminate(): Promise<void>;
}

/** Registry so additional providers can be plugged in at runtime. */
const providers = new Map<string, () => OcrProvider>();

export function registerOcrProvider(id: string, factory: () => OcrProvider): void {
  providers.set(id, factory);
}

export function getOcrProvider(id: string): OcrProvider {
  const factory = providers.get(id);
  if (!factory) throw new Error(`Unknown OCR provider: ${id}`);
  return factory();
}

export function listOcrProviders(): Array<{ id: string; name: string }> {
  return [...providers.keys()].map((id) => {
    const p = providers.get(id)!();
    return { id, name: p.name };
  });
}
