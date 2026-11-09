/**
 * The reflow (text) view: one chapter, every sentence tappable.
 *
 * Sentences are inline spans rather than blocks so a paragraph keeps its
 * natural shape while each sentence stays individually addressable by the
 * player, the highlights and the selection toolbar.
 *
 * Long chapters (a PDF fallback page can be ~1500 sentences) render a window
 * around the cursor — see `windowRange` — and grow it as the reader moves.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Chapter, Highlight } from '../core/types';
import { windowRange, type FlatSentence } from './sentences';

interface Props {
  chapter: Chapter;
  /** Where this chapter sits in the book: the quiet line above its title. */
  eyebrow: string;
  sentences: FlatSentence[];
  readingId: string | null;
  highlights: Map<string, Highlight>;
  selected: string[];
  fontSize: number;
  lineHeight: number;
  onTap(sentence: FlatSentence): void;
  onSelect(sentenceIds: string[], text: string): void;
}

/** Long-press duration that selects a sentence instead of starting playback. */
const LONG_PRESS_MS = 450;
/** A pointer that travels further than this is scrolling, not pressing. */
const PRESS_SLOP_PX = 10;
/** Render this many sentences on either side of the reading position. */
const WINDOW_RADIUS = 200;
/** Grow the window before the reader actually reaches its edge. */
const GROW_AHEAD = 20;

export default function ReflowView({
  chapter,
  eyebrow,
  sentences,
  readingId,
  highlights,
  selected,
  fontSize,
  lineHeight,
  onTap,
  onSelect,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const pressTimer = useRef<number | null>(null);
  const pressAt = useRef<{ x: number; y: number } | null>(null);
  const longFired = useRef(false);
  const selectionTimer = useRef<number | null>(null);
  const moreRef = useRef<HTMLButtonElement>(null);

  const orderOf = useMemo(() => new Map(sentences.map((sentence, i) => [sentence.id, i])), [sentences]);
  const byId = useMemo(() => new Map(sentences.map((sentence) => [sentence.id, sentence])), [sentences]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const [win, setWin] = useState(() =>
    windowRange(sentences.length, readingId ? (orderOf.get(readingId) ?? 0) : 0, WINDOW_RADIUS)
  );

  // Follow the spoken sentence and keep the rendered window around it.
  useEffect(() => {
    const at = readingId ? orderOf.get(readingId) : undefined;
    if (at === undefined) return;
    setWin((current) => {
      if (at < current.start || at >= current.end) return windowRange(sentences.length, at, WINDOW_RADIUS);
      if (at >= current.end - GROW_AHEAD && current.end < sentences.length) {
        return { start: current.start, end: Math.min(sentences.length, current.end + WINDOW_RADIUS) };
      }
      return current;
    });
    const element = host.current?.querySelector<HTMLElement>(`[data-sid="${readingId}"]`);
    if (!element) return;
    const box = element.getBoundingClientRect();
    const top = 72;
    const bottom = window.innerHeight - 200;
    if (box.top < top || box.bottom > bottom) {
      element.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    }
    // onSentence fires often with the same id; the window check is cheap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readingId, orderOf, sentences.length]);

  useEffect(() => {
    return () => {
      if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
      if (selectionTimer.current !== null) window.clearTimeout(selectionTimer.current);
    };
  }, []);

  function sentenceIdOf(target: EventTarget | null): string | null {
    if (!(target instanceof Element)) return null;
    return (target.closest('[data-sid]') as HTMLElement | null)?.dataset.sid ?? null;
  }

  function clearPress(): void {
    pressAt.current = null;
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    const id = sentenceIdOf(event.target);
    if (!id) return;
    longFired.current = false;
    clearPress();
    pressAt.current = { x: event.clientX, y: event.clientY };
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null;
      pressAt.current = null;
      longFired.current = true;
      onSelect([id], (byId.get(id)?.text ?? '').trim());
    }, LONG_PRESS_MS);
  }

  // A finger that moves is scrolling; the long-press must not fire mid-scroll.
  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    const start = pressAt.current;
    if (!start || pressTimer.current === null) return;
    if (Math.abs(event.clientX - start.x) > PRESS_SLOP_PX || Math.abs(event.clientY - start.y) > PRESS_SLOP_PX) {
      clearPress();
    }
  }

  function handleClick(event: React.MouseEvent<HTMLDivElement>): void {
    clearPress();
    if (longFired.current) {
      longFired.current = false;
      return;
    }
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return; // a drag-select, not a tap
    const id = sentenceIdOf(event.target);
    const sentence = id ? byId.get(id) : undefined;
    if (sentence) onTap(sentence);
  }

  /** Turn the browser's drag selection into the sentence ids it covers. */
  function handleSelection(): void {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const root = host.current;
    if (!root || !root.contains(range.commonAncestorContainer)) return;

    const ids: string[] = [];
    for (const element of root.querySelectorAll<HTMLElement>('[data-sid]')) {
      if (!range.intersectsNode(element)) continue;
      const id = element.dataset.sid;
      if (id) ids.push(id);
    }
    if (!ids.length) return;
    onSelect(ids, selection.toString().replace(/\s+/g, ' ').trim());
  }

  // Dragging a native selection fires selectionchange continuously; collapse
  // it to one update per pause instead of re-rendering the chapter per word.
  function scheduleSelection(): void {
    if (selectionTimer.current !== null) window.clearTimeout(selectionTimer.current);
    selectionTimer.current = window.setTimeout(() => {
      selectionTimer.current = null;
      handleSelection();
    }, 120);
  }

  useEffect(() => {
    document.addEventListener('selectionchange', scheduleSelection);
    return () => document.removeEventListener('selectionchange', scheduleSelection);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function spans(block: Chapter['blocks'][number]) {
    return block.sentences
      .filter((sentence) => {
        const at = orderOf.get(sentence.id);
        return at !== undefined && at >= win.start && at < win.end;
      })
      .map((sentence) => {
        const highlight = highlights.get(sentence.id);
        const classes = ['rd-s'];
        if (sentence.id === readingId) classes.push('reading');
        if (selectedSet.has(sentence.id)) classes.push('selected');
        return (
          <span key={sentence.id} className={classes.join(' ')} data-sid={sentence.id} data-hl={highlight?.color}>
            {sentence.text}{' '}
          </span>
        );
      });
  }

  const before = win.start > 0;
  const after = win.end < sentences.length;

  // Reading down the page should keep going without a tap: grow the window when
  // the end of the rendered range comes near the viewport.
  useEffect(() => {
    if (!after) return;
    const onScroll = () => {
      const box = moreRef.current?.getBoundingClientRect();
      if (!box || box.top > window.innerHeight + 200) return;
      setWin((current) =>
        current.end >= sentences.length
          ? current
          : { start: current.start, end: Math.min(sentences.length, current.end + WINDOW_RADIUS) }
      );
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [after, sentences.length]);

  return (
    <div
      ref={host}
      className="rd-text"
      style={{ fontSize: `${fontSize}px`, lineHeight }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={clearPress}
      onPointerCancel={clearPress}
      onPointerLeave={clearPress}
      onClick={handleClick}
      onMouseUp={handleSelection}
      onTouchEnd={handleSelection}
      onContextMenu={(event) => event.preventDefault()}
    >
      <p className="rd-eyebrow">{eyebrow}</p>
      <h2 className="rd-chapter-title">{chapter.title}</h2>
      {before ? (
        <button
          type="button"
          className="btn btn-secondary rd-more"
          onClick={() => setWin((current) => ({ start: Math.max(0, current.start - WINDOW_RADIUS), end: current.end }))}
        >
          Show earlier
        </button>
      ) : null}
      {chapter.blocks.map((block) => {
        const content = spans(block);
        if (!content.length) return null;
        switch (block.kind) {
          case 'h':
            return (
              <h3 key={block.id} className="rd-block-h">
                {content}
              </h3>
            );
          case 'li':
            return (
              <p key={block.id} className="rd-block-li">
                <span aria-hidden="true" className="rd-bullet">
                  •
                </span>
                {content}
              </p>
            );
          case 'table':
            return (
              <div key={block.id} className="rd-block-table" role="group">
                {content}
              </div>
            );
          case 'figure':
            return (
              <p key={block.id} className="rd-block-figure">
                {content}
              </p>
            );
          default:
            return <p key={block.id}>{content}</p>;
        }
      })}
      {after ? (
        <button
          ref={moreRef}
          type="button"
          className="btn btn-secondary rd-more"
          onClick={() =>
            setWin((current) => ({
              start: current.start,
              end: Math.min(sentences.length, current.end + WINDOW_RADIUS),
            }))
          }
        >
          Show more ({win.end} of {sentences.length})
        </button>
      ) : null}
    </div>
  );
}
