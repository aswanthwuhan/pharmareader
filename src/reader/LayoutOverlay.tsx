/**
 * Reading-order overlay over one rendered PDF page.
 *
 * Page view paints the page as an image and puts the sentence rectangles on it
 * at `pdfRect * scale`; this draws one outline per block in the same box, and in
 * fix mode lets the reader tap the blocks in the order they should be read.
 *
 * It is passive until it is asked for: view mode's outlines let every touch
 * through to the page, so pinching, swiping and tapping still work.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Block } from '../core/types';
import type { PageBlock } from './blockOrder';
import styles from './LayoutOverlay.module.css';

type BlockGroup = 'body' | 'heading' | 'media' | 'other';

const GROUP_LABEL: Record<BlockGroup, string> = {
  body: 'Body text',
  heading: 'Heading',
  media: 'Figure, table or caption',
  other: 'Other',
};

/**
 * Four colours for a dozen block kinds. What the reader has to tell apart on a
 * page is running text, a heading, a figure or table, and the furniture around
 * them — not each of the importer's kinds.
 */
export function blockGroup(kind: Block['kind']): BlockGroup {
  switch (kind) {
    case 'p':
    case 'li':
      return 'body';
    case 'h':
      return 'heading';
    case 'table':
    case 'figure':
    case 'caption':
      return 'media';
    default:
      return 'other';
  }
}

export interface LayoutOverlayProps {
  /** This page's blocks, in the order the document holds now. */
  blocks: PageBlock[];
  /** The rendered page scale: PDF units × this = CSS pixels, exactly as PdfView uses it. */
  scale: number;
  /**
   * Save these block ids as the page's reading order. A rejection keeps fix
   * mode open with the message, so nothing the reader tapped is lost.
   */
  onSave(blockIdsInNewOrder: string[]): Promise<void>;
  /**
   * Where the control bar goes when the page box cannot hold it, as on a phone
   * where the page is the whole box: PdfView puts a host under the page, so the
   * bar never covers words that still have to be tapped.
   */
  panelHost?: HTMLElement | null;
}

export default function LayoutOverlay({ blocks, scale, onSave, panelHost }: LayoutOverlayProps) {
  const [mode, setMode] = useState<'view' | 'fix'>('view');
  /** Block ids in the order they were tapped. */
  const [picked, setPicked] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const layer = useRef<HTMLDivElement>(null);
  const fixButton = useRef<HTMLButtonElement>(null);
  const wasFixing = useRef(false);

  // "Fix order" is replaced by the fix-mode controls when it is pressed, so the
  // button that had focus unmounts and focus drops to the document. Send it to
  // the first block instead, and back to "Fix order" on the way out: otherwise
  // a keyboard user has to tab through the whole page to reach what they just
  // asked for, and loses their place again when they leave.
  useEffect(() => {
    if (mode === 'fix' && !wasFixing.current) {
      wasFixing.current = true;
      layer.current?.querySelector<HTMLButtonElement>('button')?.focus();
    } else if (mode === 'view' && wasFixing.current) {
      wasFixing.current = false;
      fixButton.current?.focus();
    }
  }, [mode]);

  // Another page, or the reload that follows a save: the taps belonged to a
  // page that is no longer on screen.
  useEffect(() => {
    setMode('view');
    setPicked([]);
    setError(null);
  }, [blocks]);

  /** The number on a block: its stored position, or its place in the new order. */
  function numberFor(block: PageBlock): number | null {
    if (mode === 'view') return block.order;
    const at = picked.indexOf(block.blockId);
    return at < 0 ? null : at + 1;
  }

  function tap(blockId: string): void {
    if (saving) return;
    // A second tap on the same block is the same instruction, not a new one.
    setPicked((current) => (current.includes(blockId) ? current : [...current, blockId]));
  }

  function cancel(): void {
    setMode('view');
    setPicked([]);
    setError(null);
  }

  async function save(): Promise<void> {
    if (picked.length === 0 || saving) return;
    // Untapped blocks keep their order and follow the tapped ones.
    const rest = blocks.map((block) => block.blockId).filter((id) => !picked.includes(id));
    setSaving(true);
    setError(null);
    try {
      await onSave([...picked, ...rest]);
      setMode('view');
      setPicked([]);
    } catch {
      setError('Could not save the order. Nothing was changed.');
    } finally {
      setSaving(false);
    }
  }

  const panel = (
    <div className={styles.panel}>
      <div className={styles.head}>
        <p className={styles.note}>Re-analysing this book replaces manual order.</p>
        {mode === 'view' && blocks.length > 0 ? (
          <button
            ref={fixButton}
            type="button"
            className="btn btn-secondary"
            onClick={() => setMode('fix')}
          >
            Fix order
          </button>
        ) : null}
      </div>

      {mode === 'view' ? (
        blocks.length === 0 ? <p className={styles.hint}>No text blocks detected on this page.</p> : null
      ) : (
        <>
          <p className={styles.hint} role="status">
            {picked.length === 0
              ? 'Tap the blocks in the order they should be read.'
              : `${picked.length} of ${blocks.length} tapped — the rest follow in their current order.`}
          </p>
          <div className={styles.row}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setPicked((current) => current.slice(0, -1))}
              disabled={picked.length === 0 || saving}
            >
              Undo last
            </button>
            <button type="button" className="btn btn-ghost" onClick={cancel} disabled={saving}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void save()}
              disabled={picked.length === 0 || saving}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
        </>
      )}
    </div>
  );

  return (
    <div className={styles.overlay}>
      <div ref={layer} className={styles.layer}>
        {blocks.map((block) => {
          const group = blockGroup(block.kind);
          const number = numberFor(block);
          const box = {
            left: `${block.box.x * scale}px`,
            top: `${block.box.y * scale}px`,
            width: `${Math.max(block.box.w * scale, 2)}px`,
            height: `${Math.max(block.box.h * scale, 2)}px`,
          };
          const className = [styles.box, styles[group], number === null ? styles.idle : '']
            .filter(Boolean)
            .join(' ');
          const badge =
            number === null ? null : (
              <span className={styles.badge} aria-hidden="true">
                {number}
              </span>
            );

          // View mode is a picture of the order: it must not eat a swipe or a
          // tap that belongs to the page underneath.
          if (mode === 'view') {
            return (
              <div
                key={block.blockId}
                className={className}
                style={box}
                data-block-id={block.blockId}
                data-order={String(number)}
                aria-hidden="true"
              >
                {badge}
              </div>
            );
          }

          return (
            <button
              key={block.blockId}
              type="button"
              className={`${className} ${styles.tappable}`}
              style={box}
              data-block-id={block.blockId}
              data-order={number === null ? undefined : String(number)}
              aria-label={
                number === null
                  ? `${GROUP_LABEL[group]} block, not tapped yet`
                  : `${GROUP_LABEL[group]} block, position ${number} in the new order`
              }
              onClick={() => tap(block.blockId)}
            >
              {badge}
            </button>
          );
        })}
      </div>

      {/* The bar goes under the page when PdfView offers a host: a bar over the
          page would cover the very blocks the reader still has to tap. */}
      {panelHost ? createPortal(panel, panelHost) : panel}
    </div>
  );
}
