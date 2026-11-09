/**
 * The reflow (text) view: one chapter, every sentence tappable.
 *
 * Sentences are inline spans rather than blocks so a paragraph keeps its
 * natural shape while each sentence stays individually addressable by the
 * player, the highlights and the selection toolbar.
 */
import { useEffect, useMemo, useRef } from 'react';
import type { Chapter, Highlight } from '../core/types';
import type { FlatSentence } from './sentences';

interface Props {
  chapter: Chapter;
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

export default function ReflowView({
  chapter,
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
  const longFired = useRef(false);
  const byId = useMemo(() => new Map(sentences.map((sentence) => [sentence.id, sentence])), [sentences]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  // Follow the spoken sentence, but only when it is actually out of view —
  // scrolling on every sentence would fight the reader who is looking ahead.
  useEffect(() => {
    if (!readingId) return;
    const element = host.current?.querySelector<HTMLElement>(`[data-sid="${readingId}"]`);
    if (!element) return;
    const box = element.getBoundingClientRect();
    const top = 72;
    const bottom = window.innerHeight - 200;
    if (box.top < top || box.bottom > bottom) {
      element.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    }
  }, [readingId]);

  function sentenceIdOf(target: EventTarget | null): string | null {
    if (!(target instanceof Element)) return null;
    return (target.closest('[data-sid]') as HTMLElement | null)?.dataset.sid ?? null;
  }

  function clearPress(): void {
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
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null;
      longFired.current = true;
      onSelect([id], (byId.get(id)?.text ?? '').trim());
    }, LONG_PRESS_MS);
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

  function spans(block: Chapter['blocks'][number]) {
    return block.sentences.map((sentence) => {
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

  return (
    <div
      ref={host}
      className="rd-text"
      style={{ fontSize: `${fontSize}px`, lineHeight }}
      onPointerDown={handlePointerDown}
      onPointerUp={clearPress}
      onPointerCancel={clearPress}
      onPointerLeave={clearPress}
      onClick={handleClick}
      onMouseUp={handleSelection}
      onTouchEnd={handleSelection}
    >
      <h2 className="rd-chapter-title">{chapter.title}</h2>
      {chapter.blocks.map((block) => {
        const content = spans(block);
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
    </div>
  );
}
