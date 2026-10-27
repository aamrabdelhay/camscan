'use client';

/**
 * ReplicaPage — renders a PageModel as REAL HTML/CSS text.
 *
 *  - absolute positioning from normalised bboxes, scaled to the page width
 *  - the sampled paper colour is the page background
 *  - every block is a text node (selectable, searchable, editable) — never an
 *    image of the page
 *  - illustrations are the only <img> elements
 *  - Arabic blocks get dir="rtl" + lang="ar" independently of the UI direction
 *  - in edit mode each block becomes a contentEditable region with a live
 *    confidence indicator
 */
import { useEffect, useMemo, useRef } from 'react';
import type { PageBlock, PageModel } from '@/lib/types';
import type { HighlightSegment } from '@/lib/normalize';
import { highlightSegments } from '@/lib/normalize';

export interface ReplicaPageProps {
  model: PageModel;
  /** Rendered width in px; height derives from model.aspectRatio. */
  width: number;
  editing?: boolean;
  /** Query used to highlight matches inside blocks. */
  query?: string;
  /** Called when a block's text is edited (debounced by the parent). */
  onBlockChange?: (blockId: string, text: string) => void;
  /** Called when a block is selected (for the style inspector). */
  onSelectBlock?: (blockId: string | null) => void;
  selectedBlockId?: string | null;
  /** Show dashed outlines around every block (review aid). */
  showOutlines?: boolean;
  className?: string;
}

export function ReplicaPage({
  model, width, editing, query, onBlockChange, onSelectBlock, selectedBlockId, showOutlines, className = '',
}: ReplicaPageProps) {
  const height = Math.round(width / (model.aspectRatio || 0.72));
  const blocks = useMemo(() => [...model.blocks].sort((a, b) => a.order - b.order), [model.blocks]);

  return (
    <div
      className={`relative overflow-hidden rounded-sm shadow-[0_2px_18px_rgba(36,29,18,0.18)] ${className}`}
      style={{
        width,
        height,
        backgroundColor: model.paperColor,
        // A hint of the paper's tooth, without faking stains we can't reproduce.
        backgroundImage: 'radial-gradient(circle at 30% 20%, rgba(255,255,255,0.10), transparent 60%)',
        direction: model.direction,
      }}
      data-page-id={model.pageId}
      data-testid="replica-page"
    >
      {blocks.map((block) => (
        <BlockView
          key={block.id}
          block={block}
          pageWidth={width}
          pageHeight={height}
          model={model}
          editing={editing}
          query={query}
          onBlockChange={onBlockChange}
          onSelectBlock={onSelectBlock}
          selected={selectedBlockId === block.id}
          showOutlines={showOutlines}
        />
      ))}
    </div>
  );
}

function BlockView({
  block, pageWidth, pageHeight, model, editing, query, onBlockChange, onSelectBlock, selected, showOutlines,
}: {
  block: PageBlock;
  pageWidth: number;
  pageHeight: number;
  model: PageModel;
  editing?: boolean;
  query?: string;
  onBlockChange?: (id: string, text: string) => void;
  onSelectBlock?: (id: string | null) => void;
  selected?: boolean;
  showOutlines?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const fontSize = Math.max(6, block.fontSize * pageHeight);
  const left = block.bbox.x * pageWidth;
  const top = block.bbox.y * pageHeight;
  const w = block.bbox.w * pageWidth;
  const h = block.bbox.h * pageHeight;

  // Keep the DOM in sync on external changes without clobbering the caret.
  useEffect(() => {
    if (!editing || !ref.current) return;
    if (ref.current.innerText !== block.text) ref.current.innerText = block.text;
  }, [block.text, editing]);

  if (block.type === 'illustration') {
    return (
      <div
        className="absolute"
        style={{ left, top, width: w, height: h }}
        onClick={() => onSelectBlock?.(block.id)}
        role={onSelectBlock ? 'button' : undefined}
        tabIndex={onSelectBlock ? 0 : undefined}
      >
        {block.imageUrl ? (
           
          <img src={block.imageUrl} alt="" className="h-full w-full object-contain" />
        ) : (
          <div className="grid h-full w-full place-items-center border border-dashed border-[#b9a077]/60 text-[10px] text-[#8a7a5c]">
            illustration
          </div>
        )}
      </div>
    );
  }

  const alignMap: Record<string, string> = {
    start: 'text-start',
    end: 'text-end',
    center: 'text-center',
    justify: 'text-justify',
  };

  const commonStyle: React.CSSProperties = {
    left,
    top,
    width: w,
    minHeight: h,
    fontFamily: block.fontFamily,
    fontSize,
    fontWeight: block.fontWeight,
    fontStyle: block.italic ? 'italic' : 'normal',
    textDecoration: block.underline ? 'underline' : undefined,
    color: block.color,
    lineHeight: block.lineHeight,
    direction: block.direction,
    textAlign: (block.align === 'start' || block.align === 'end' ? block.align : block.align) as React.CSSProperties['textAlign'],
    // Arabic never wants letter-spacing; Latin benefits from subtle kerning only.
    letterSpacing: 0,
    textShadow: '0 0 0.4px currentColor', // keeps faint old ink legible at small zoom
  };

  const isRtl = block.direction === 'rtl';

  if (editing) {
    return (
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={`${block.type} — ${isRtl ? 'نص عربي' : 'text'}`}
        dir={block.direction}
        lang={block.language}
        data-block-id={block.id}
        onInput={(e) => onBlockChange?.(block.id, (e.currentTarget as HTMLElement).innerText)}
        onFocus={() => onSelectBlock?.(block.id)}
        className={`absolute cursor-text whitespace-pre-wrap break-words rounded-sm outline-offset-2 ${alignMap[block.align] ?? 'text-start'} ${
          selected ? 'outline outline-2 outline-[var(--camscan-accent)]' : ''
        } ${block.uncertain ? 'bg-[color:var(--color-warn-100)]/40 outline-dashed outline-1 outline-[var(--color-warn-500)]/60' : ''}`}
        style={commonStyle}
      />
    );
  }

  /**
   * Per-line rendering.
   *
   * A block's text may span several measured lines (a wrapped heading, or a
   * paragraph whose rows Tesseract emitted separately). Placing the joined text
   * in the *union* box re-wraps it with the browser's metrics and can add lines
   * the original never had, which then collide with neighbouring blocks. When the
   * model carries per-line text + boxes we place each line exactly where its ink
   * was and never let it wrap, so the replica matches the photograph line by line.
   */
  if (block.lines && block.lines.length > 1) {
    return (
      <>
        {block.lines.map((line, i) => {
          const lh = Math.max(6, line.bbox.h * pageHeight);
          const fsz = Math.max(6, Math.min(fontSize, lh / 0.95));
          const segs: HighlightSegment[] = query
            ? highlightSegments(line.text, query)
            : [{ text: line.text, hit: false }];
          return (
            <div
              key={`${block.id}-l${i}`}
              data-block-line={i}
              data-block-id={`${block.id}-l${i}`}
              className="absolute whitespace-pre"
              style={{
                ...commonStyle,
                left: line.bbox.x * pageWidth,
                top: line.bbox.y * pageHeight,
                width: line.bbox.w * pageWidth + 2,
                minHeight: 0,
                height: lh * 1.12,
                fontSize: fsz,
                lineHeight: 1.15,
                overflow: 'visible',
              }}
              dir={block.direction}
              lang={block.language}
            >
              {segs.map((seg, j) =>
                seg.hit ? (
                  <mark key={j} className="rounded-sm bg-[var(--color-warn-200)] text-inherit">{seg.text}</mark>
                ) : (
                  <span key={j}>{seg.text}</span>
                ),
              )}
            </div>
          );
        })}
        {showOutlines && (
          <div
            className="pointer-events-none absolute outline outline-1 outline-dashed outline-[#2f8d7c]/40"
            style={{ left, top, width: w, height: h }}
          />
        )}
      </>
    );
  }

  const segments: HighlightSegment[] = query
    ? highlightSegments(block.text, query)
    : [{ text: block.text, hit: false }];

  return (
    <div
      role={onSelectBlock ? 'button' : undefined}
      tabIndex={onSelectBlock ? 0 : undefined}
      onClick={() => onSelectBlock?.(block.id)}
      onKeyDown={(e) => {
        if (onSelectBlock && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onSelectBlock(block.id);
        }
      }}
      className={`absolute whitespace-pre-wrap break-words ${alignMap[block.align] ?? 'text-start'} ${
        selected ? 'outline outline-2 outline-[var(--camscan-accent)]' : ''
      } ${showOutlines ? 'outline outline-1 outline-dashed outline-[#2f8d7c]/35' : ''} ${
        block.uncertain && showOutlines ? 'bg-[color:var(--color-warn-100)]/30' : ''
      }`}
      style={commonStyle}
      dir={block.direction}
      lang={block.language}
      data-block-id={block.id}
      data-block-type={block.type}
      title={block.uncertain ? `⚠ ${Math.round(block.confidence)}%` : undefined}
    >
      {segments.map((seg, i) =>
        seg.hit ? (
          <mark key={i} className="rounded bg-[var(--color-warn-100)] text-[var(--color-warn-500)]">{seg.text}</mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
      {model.direction !== block.direction ? (
        <span dir={model.direction} className="hidden" aria-hidden="true" />
      ) : null}
    </div>
  );
}

/**
 * "Comfortable reading" view: reflows the SAME stored text into a readable
 * column. It is explicitly not a facsimile — the replica and the original photo
 * remain one tab away.
 */
export function ComfortablePage({
  model,
  query,
  onBlockChange,
}: {
  model: PageModel;
  query?: string;
  onBlockChange?: (id: string, text: string) => void;
}) {
  const blocks = [...model.blocks].sort((a, b) => a.order - b.order).filter((b) => b.text.trim() || b.type === 'illustration');

  return (
    <article
      dir={model.direction}
      lang={model.language}
      className="mx-auto max-w-[42rem] px-5 py-8 font-[family-name:var(--font-arabic)] text-[var(--camscan-text)]"
      style={{ fontFamily: undefined }}
    >
      {blocks.map((block) => {
        if (block.type === 'illustration') {
          return block.imageUrl ? (
             
            <img key={block.id} src={block.imageUrl} alt="" className="my-5 w-full rounded" />
          ) : null;
        }
        const segments = query ? highlightSegments(block.text, query) : [{ text: block.text, hit: false }];
        const content = segments.map((seg, i) =>
          seg.hit ? <mark key={i} className="rounded bg-[var(--color-warn-100)]">{seg.text}</mark> : <span key={i}>{seg.text}</span>,
        );
        const style: React.CSSProperties = {
          fontFamily: block.fontFamily,
          fontWeight: block.fontWeight,
          fontStyle: block.italic ? 'italic' : 'normal',
          color: block.color,
          direction: block.direction,
        };
        if (onBlockChange) {
          return (
            <p
              key={block.id}
              contentEditable
              suppressContentEditableWarning
              dir={block.direction}
              onInput={(e) => onBlockChange(block.id, (e.currentTarget as HTMLElement).innerText)}
              style={{ ...style, fontSize: block.type === 'heading' ? '1.6em' : '1.08em' }}
              className={`mb-4 rounded leading-loose outline-offset-2 focus:outline focus:outline-2 focus:outline-[var(--camscan-accent)] ${
                block.type === 'footnote' ? 'border-t pt-3 text-[0.86em] opacity-85' : ''
              } ${block.type === 'heading' ? 'mt-6 font-semibold' : ''}`}
            >
              {content}
            </p>
          );
        }
        return (
          <p
            key={block.id}
            dir={block.direction}
            style={{ ...style, fontSize: block.type === 'heading' ? '1.6em' : '1.08em' }}
            className={`mb-4 leading-loose ${block.type === 'footnote' ? 'border-t pt-3 text-[0.86em] opacity-85' : ''} ${
              block.type === 'heading' ? 'mt-6 font-semibold' : ''
            }`}
          >
            {content}
          </p>
        );
      })}
      {blocks.every((b) => !b.text.trim()) ? (
        <p className="text-center text-sm text-[var(--camscan-text-muted)]">—</p>
      ) : null}
    </article>
  );
}
