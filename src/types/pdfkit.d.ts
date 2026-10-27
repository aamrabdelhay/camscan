/**
 * Minimal ambient types for pdfkit's browser build.
 * We only use a small surface (addPage, registerFont, font, text, image,
 * rect, clip, widthOfString, …); typing it here keeps the exporter fully typed
 * without pulling in the Node-only @types package.
 */
declare module 'pdfkit' {
  interface PDFDocumentOptions {
    size?: [number, number] | string;
    margin?: number;
    autoFirstPage?: boolean;
    compress?: boolean;
    info?: Record<string, string>;
    layout?: 'portrait' | 'landscape';
  }

  interface TextOptions {
    width?: number;
    height?: number;
    align?: 'left' | 'center' | 'right' | 'justify';
    lineBreak?: boolean;
    continued?: boolean;
    baseline?: 'top' | 'bottom' | 'middle';
    features?: string[];
    indent?: number;
    paragraphGap?: number;
  }

  interface ImageOptions {
    fit?: [number, number];
    width?: number;
    height?: number;
    align?: 'left' | 'center' | 'right';
    valign?: 'top' | 'center' | 'bottom';
  }

  class PDFDocument {
    constructor(options?: PDFDocumentOptions);
    on(event: 'data' | 'end' | 'error', cb: (chunk?: Uint8Array) => void): this;
    addPage(options?: { size?: [number, number]; margin?: number }): this;
    registerFont(name: string, src: Uint8Array | string): this;
    font(name: string | Uint8Array): this;
    fontSize(size: number): this;
    fillColor(color: string): this;
    strokeColor(color: string): this;
    lineWidth(width: number): this;
    moveTo(x: number, y: number): this;
    lineTo(x: number, y: number): this;
    stroke(): this;
    lineJoin(value: string): this;
    text(text: string, x?: number, y?: number, options?: TextOptions): this;
    text(text: string, options?: TextOptions): this;
    widthOfString(text: string, options?: TextOptions): number;
    heightOfString(text: string, options?: TextOptions): number;
    rect(x: number, y: number, w: number, h: number): this;
    fill(color?: string): this;
    clip(): this;
    save(): this;
    restore(): this;
    image(src: Uint8Array, x?: number, y?: number, options?: ImageOptions): this;
    end(): void;
    pages: Array<unknown>;
  }

  export default PDFDocument;

  /**
   * The browser build ships the 14 standard PDF fonts as opt-in modules; they
   * must be handed to pdfkit before a document uses a fallback like Helvetica.
   */
  export function registerStdFonts(...fonts: StandardFontData[]): void;

  interface StandardFontData {
    name: string;
  }
}

declare module 'pdfkit/standard-fonts/Helvetica' {
  const font: import('pdfkit').StandardFontData;
  export default font;
}
declare module 'pdfkit/standard-fonts/HelveticaBold' {
  const font: import('pdfkit').StandardFontData;
  export default font;
}
declare module 'pdfkit/standard-fonts/HelveticaOblique' {
  const font: import('pdfkit').StandardFontData;
  export default font;
}
declare module 'pdfkit/standard-fonts/Courier' {
  const font: import('pdfkit').StandardFontData;
  export default font;
}
declare module 'pdfkit/standard-fonts/TimesRoman' {
  const font: import('pdfkit').StandardFontData;
  export default font;
}
