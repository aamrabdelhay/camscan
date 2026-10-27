/**
 * CamScan — canonical domain types.
 *
 * These types are the contract between the UI, the persistence layer and the
 * worker pipeline. They are intentionally framework-free so the same models
 * can be serialised to IndexedDB today and to PostgreSQL/Supabase later.
 */

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

/** Axis-aligned bounding box in **normalised page coordinates** (0..1). */
export interface NormBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Corner point in normalised page coordinates. */
export interface Point {
  x: number;
  y: number;
}

/** A width/height pair in pixels or points. */
export interface Size {
  width: number;
  height: number;
}

/* ------------------------------------------------------------------ */
/* Page model                                                          */
/* ------------------------------------------------------------------ */

export type BlockType =
  | 'heading'
  | 'paragraph'
  | 'footnote'
  | 'pageNumber'
  | 'header'
  | 'footer'
  | 'caption'
  | 'marginalNote'
  | 'illustration'
  | 'table'
  | 'other';

export type TextDirection = 'rtl' | 'ltr';

/** Font *category* inferred from the photograph (never an exact match). */
export type FontCategory =
  | 'naskh'
  | 'kufi'
  | 'ruqaa'
  | 'thuluth'
  | 'serif'
  | 'sans'
  | 'mono';

export type TextAlign = 'start' | 'center' | 'end' | 'justify';

/**
 * One recognised (or manually added) region on a page.
 * `text` is always the *display* text exactly as stored; search normalisation
 * happens in a separate layer so we never mutate what the reader sees.
 */
export interface PageBlock {
  id: string;
  type: BlockType;
  bbox: NormBox;
  /** Reading order within the page, 0-based. */
  order: number;
  direction: TextDirection;
  /** BCP-47-ish primary language of the block, e.g. "ar", "en", "ar+en". */
  language: string;
  /** CSS font-family stack chosen for this block (approximate match). */
  fontFamily: string;
  /** Estimated font category before mapping to a concrete family. */
  fontCategory: FontCategory;
  /** Font size expressed as a fraction of page height (0..1). */
  fontSize: number;
  fontWeight: 400 | 600 | 700;
  italic: boolean;
  underline?: boolean;
  /** CSS colour of the ink, sampled from the source image. */
  color: string;
  align: TextAlign;
  /** Multiplier of font size. */
  lineHeight: number;
  text: string;
  /** 0..100, from the OCR engine when available. */
  confidence: number;
  /** True when this block was typed/edited by the user. */
  edited?: boolean;
  /** True for low-confidence blocks that deserve review. */
  uncertain?: boolean;
  /**
   * The measured box and text of each source line, in page coordinates.
   *
   * Why: a heading Tesseract split into two rows (or a paragraph whose lines sit
   * in a narrow column) is merged into ONE block, but the merged union box is
   * wider/taller than any single line. Rendering the whole block inside that box
   * re-wraps it with the browser's metrics and can add lines the original never
   * had, which then collide with the neighbouring blocks. With per-line data the
   * replica places every line exactly where its ink was, so the layout matches
   * the photograph even when a block spans columns.
   *
   * `block.text` stays the joined, authoritative text (search, edit, export).
   */
  lines?: PageBlockLine[];
  /** A cropped illustration stored as an image rather than text. */
  imageUrl?: string;
  /** Reference marker linking a body marker to a footnote, when detected. */
  refMarker?: string;
}

export interface PageBlockLine {
  text: string;
  bbox: NormBox;
}

export type PageStatus =
  | 'queued'
  | 'processing'
  | 'done'
  | 'review'
  | 'failed'
  | 'blank';

export type PageStage =
  | 'queued'
  | 'preprocess'
  | 'layout'
  | 'ocr'
  | 'build'
  | 'done'
  | 'failed';

/** Versioned structured document — the thing that gets rendered & exported. */
export interface PageModel {
  /** Increases when the model schema changes. */
  schemaVersion: 1 | 2;
  pageId: string;
  /** Digital sequence within the book (1-based). */
  sequence: number;
  /** Printed page number as read from the page, when recognised. */
  printedNumber?: string;
  /** Page aspect ratio = width / height of the *rectified* page. */
  aspectRatio: number;
  /** Dominant sampled paper colour (CSS hex). */
  paperColor: string;
  /** Sampled ink colour for the body of the page (CSS hex). */
  inkColor: string;
  /** Primary direction of the page. */
  direction: TextDirection;
  /** Dominant language detected/selected for the page. */
  language: string;
  orientation: 0 | 90 | 180 | 270;
  /** Estimated body font size relative to page height. */
  bodyFontSize: number;
  blocks: PageBlock[];
  /** Provenance of the model. */
  provenance: {
    engine: string;
    engineVersion?: string;
    languages: string[];
    processedAt: string;
    /** Options that influenced the run (for reproducible reprocessing). */
    profile?: string;
  };
  /** Non-fatal problems worth surfacing in the review UI. */
  warnings?: string[];
}

/* ------------------------------------------------------------------ */
/* Book / page / job / revision records                                */
/* ------------------------------------------------------------------ */

export type BookLanguage = 'ar' | 'en' | 'fr' | 'fa' | 'ur' | 'de' | 'tr' | 'mixed';

export interface BookDefaults {
  /** CSS family used for Arabic-script body text. */
  arabicFont: string;
  /** CSS family used for Latin body text. */
  latinFont: string;
  /** Base font size as fraction of page height. */
  bodyFontSize: number;
  /** Whether replica blocks use absolute bbox geometry. */
  layout: 'absolute' | 'flow';
}

export interface BookSettings {
  ocrLanguages: string[];
  captureProfile: CaptureProfileId;
  autoCapture: boolean;
  /** Confidence below this marks the page "Needs review". */
  reviewThreshold: number;
  /** Comfortable-reading column width in px. */
  readingWidth: number;
}

export type CaptureProfileId =
  | 'standard'
  | 'fragile'
  | 'smallPrint'
  | 'fadedInk'
  | 'historical';

export interface Book {
  id: string;
  title: string;
  author?: string;
  subtitle?: string;
  publisher?: string;
  publicationYear?: string;
  edition?: string;
  isbn?: string;
  /** Primary language of the book content. */
  language: BookLanguage;
  /** Additional languages present in the book. */
  additionalLanguages?: string[];
  category?: string;
  description?: string;
  notes?: string;
  createdAt: number;
  updatedAt: number;
  /** Page record id used for the cover thumbnail. */
  coverPageId?: string;
  defaultFonts: BookDefaults;
  settings: BookSettings;
  /** Denormalised counters so the library grid never touches page images. */
  pageCount: number;
  doneCount: number;
  reviewCount: number;
  failedCount: number;
  /** Small JPEG data URL / blob of the cover for fast grid rendering. */
  coverThumb?: Blob;
}

/** A page as persisted. Images are separate columns so they can be skipped. */
export interface PageRecord {
  id: string;
  bookId: string;
  /** Capture order — authoritative, independent of processing completion. */
  order: number;
  /** Optional printed page number (string keeps Roman numerals etc.). */
  printedPageNumber?: string;
  status: PageStatus;
  stage: PageStage;
  /** 0..1 progress of the current stage. */
  progress: number;
  originalImage: Blob;
  processedImage?: Blob;
  /** Small thumbnail (data URL) for the capture strip / pagination. */
  thumb?: string;
  pageModel?: PageModel;
  /** Plain display text (derived from pageModel, but stored for search). */
  plainText: string;
  /** Normalised text used by the search index. */
  searchText: string;
  avgConfidence: number;
  language: string;
  direction: TextDirection;
  width: number;
  height: number;
  /** True once a human marked the page reviewed. */
  reviewed: boolean;
  /** True when the page is intentionally blank. */
  blank: boolean;
  /** True when the user edited text (protects from silent reprocessing). */
  userEdited: boolean;
  /** Metrics captured during processing (for diagnostics). */
  metrics?: PageMetrics;
  createdAt: number;
  updatedAt: number;
  revision: number;
}

export interface PageMetrics {
  captureToPersistMs?: number;
  processingMs?: number;
  preprocessMs?: number;
  ocrMs?: number;
  /** 0..1 sharpness estimate (variance of Laplacian, normalised). */
  sharpness?: number;
  /** 0..1 brightness estimate. */
  brightness?: number;
  /** Detected quadrilateral coverage of the frame. */
  coverage?: number;
  /** Detection confidence 0..1. */
  detectionConfidence?: number;
  /** JPEG quality chosen for the rectified image. */
  jpegQuality?: number;
}

export type JobState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type JobType = 'process' | 'reprocess' | 'thumbnail' | 'export';

export interface JobRecord {
  id: string;
  bookId: string;
  pageId: string;
  type: JobType;
  state: JobState;
  attempts: number;
  maxAttempts: number;
  progress: number;
  stage?: PageStage;
  lastError?: string;
  /** Options used for the run; ensures retries are idempotent. */
  options?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface RevisionRecord {
  id: string;
  pageId: string;
  bookId: string;
  /** Full snapshot of the previous model (compact JSON). */
  previousModel: PageModel;
  previousPlainText: string;
  summary: string;
  createdAt: number;
  /** 'edit' | 'reprocess' | 'reorder' | 'restore' */
  kind: 'edit' | 'reprocess' | 'reorder' | 'restore';
}

export type ThemePreference = 'light' | 'dark' | 'system';
export type UiLanguage = 'ar' | 'en';

export interface AppSettings {
  /** Always one row with id = 'app'. */
  id: 'app';
  uiLanguage: UiLanguage;
  theme: ThemePreference;
  ocrLanguages: string[];
  captureProfile: CaptureProfileId;
  autoCapture: boolean;
  reviewThreshold: number;
  /** Persist [docId, pageId] for "last opened" convenience. */
  lastBookId?: string;
  hasSeenTips: boolean;
  updatedAt: number;
}

export interface ExportRecord {
  id: string;
  bookId: string;
  format: 'pdf-replica' | 'pdf-photos' | 'backup';
  state: 'running' | 'done' | 'failed';
  options?: Record<string, unknown>;
  pageCount?: number;
  error?: string;
  createdAt: number;
  completedAt?: number;
}
