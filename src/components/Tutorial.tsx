/**
 * The guided tour: one real control at a time, lit by a spotlight, explained by
 * a card that sits next to it.
 *
 * App renders it once, outside the routes, so it survives the page changes it
 * makes itself (Library → Reader → Settings). Settings → About starts the same
 * tour through `startTutorial()`. Every way of closing records it as seen and
 * returns to the route the tour started on.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import './Tutorial.css';
import { pushBackHandler } from '../core/backButton';
import { db } from '../core/db';
import { setSetting } from '../core/settings';
import type { BookRecord } from '../core/types';

export const TUTORIAL_SEEN_KEY = 'tutorialSeen';

/** Fired on `window` to open the tour from anywhere (Settings → About). */
export const TUTORIAL_START_EVENT = 'pharmareader:start-tutorial';

export function startTutorial(): void {
  window.dispatchEvent(new Event(TUTORIAL_START_EVENT));
}

export interface TutorialStep {
  id: string;
  /** Page the step lives on; `{id}` is replaced with the open book's id. */
  route?: string;
  /** CSS selector. A bare name is shorthand for `[data-tour="…"]`. */
  target?: string;
  /** Only shown once a book exists (the Reader steps and the book row). */
  needsBook?: boolean;
  /** Only shown for PDF books (the Text / Page switch). */
  pdfOnly?: boolean;
  title: string;
  body: string;
}

/**
 * The full tour. `TUTORIAL_STEPS` is the authored list; the component drops the
 * steps that need a book when the Library is empty.
 */
export const TUTORIAL_STEPS: TutorialStep[] = [
  {
    id: 'library-import',
    route: '/',
    target: 'import',
    title: 'Import a book',
    body: 'Tap Import and choose a PDF, EPUB, DOCX, TXT, Markdown or HTML file. It stays on this device and nothing is uploaded. A scanned PDF has no text layer, so it opens empty and cannot be read aloud.',
  },
  {
    id: 'library-pdf-kind',
    route: '/',
    target: 'import',
    title: 'Say what kind of PDF it is',
    body: 'When you pick a PDF, PharmaReader asks what kind of book it is. Textbook or complex pages uses layout detection to read two columns, tables and figures in the right order; a simple book skips detection and imports faster. You can change the answer, or run detection later, in Settings → PDF layout.',
  },
  {
    id: 'library-add-other',
    route: '/',
    target: 'add-other',
    title: 'Add from the web, or paste text',
    body: 'Add from web fetches a page from its address. Paste text takes a chapter you already have. Some sites block the fetch; pasting the text gets around that.',
  },
  {
    id: 'library-book-row',
    route: '/',
    target: 'book-row',
    needsBook: true,
    title: 'Open a book',
    body: 'Tap a book to open it and carry on where you left off. The three dots beside it hold that book’s own actions, including Delete book.',
  },
  {
    id: 'library-nav',
    route: '/',
    target: 'nav',
    title: 'The four places in the app',
    body: 'Library is your shelf. Review brings back the cards that are due. Syllabus tracks the topics you tag books and cards with. Settings holds voices, models, backups and this tour.',
  },
  {
    id: 'reader-play',
    route: '/read/{id}',
    target: 'play',
    needsBook: true,
    title: 'Play or pause',
    body: 'Play reads from where you are. Tap it again to pause; Play carries on from the same sentence.',
  },
  {
    id: 'reader-speed',
    route: '/read/{id}',
    target: 'speed',
    needsBook: true,
    title: 'Change the speed',
    body: 'The speed button shows the current pace and opens the slider. 1.0× is normal. Pocket TTS is limited to 0.80×–1.25×; Kokoro and the system voices go from 0.5× to 2×.',
  },
  {
    id: 'reader-step',
    route: '/read/{id}',
    target: 'step',
    needsBook: true,
    title: 'Move one sentence',
    body: 'The arrows either side of Play step back or forward by one sentence, so a single line can be replayed without losing your place.',
  },
  {
    id: 'reader-start-anywhere',
    route: '/read/{id}',
    needsBook: true,
    title: 'Start from any place',
    body: 'Tap a sentence to move the reading position there; Play reads from it. Once you have scrolled away from the mark, Play from here starts at the first sentence in view instead. A tap while it is playing moves the voice to that sentence. In Page view, turn to a page, then Play starts from that page.',
  },
  {
    id: 'reader-more',
    route: '/read/{id}',
    target: 'more',
    needsBook: true,
    title: 'Playback options',
    body: 'The three dots open Stop and save my place, a sleep timer for 10, 20 or 30 minutes or the end of the chapter, and Save chapter audio when the voice can pre-render it. A saved chapter plays with no waiting and works offline.',
  },
  {
    id: 'reader-ready-ahead',
    route: '/read/{id}',
    target: 'more',
    needsBook: true,
    title: 'Keep audio ready ahead',
    body: 'Save chapter audio renders this chapter once, so it plays with no waiting and works offline. Save audio for more… in the same menu queues several chapters, or a page range in a PDF; it keeps saving while you read and playback carries on. The player also counts the sentences ready ahead while it is buffering.',
  },
  {
    id: 'reader-contents',
    route: '/read/{id}',
    target: 'contents',
    needsBook: true,
    title: 'Jump to a chapter',
    body: 'Contents lists the chapters, and the notes and topics you have saved in this book. Tap one to go there.',
  },
  {
    id: 'reader-type',
    route: '/read/{id}',
    target: 'type',
    needsBook: true,
    title: 'Text size and spacing',
    body: 'Aa opens the text size stepper and the line spacing choices. They apply to the Text view; the Page view has its own zoom under the page. Aa also holds the read-along highlight: the sentence being read is washed in a colour, and the word being spoken is marked more strongly on top of it. Colour, mark and strength for both are set there.',
  },
  {
    id: 'reader-view-switch',
    route: '/read/{id}',
    target: 'view-switch',
    needsBook: true,
    pdfOnly: true,
    title: 'Text or Page',
    body: 'A PDF opens on the printed page; Text reflows it so Aa can resize it and the voice can read it. In Page view, pinch to zoom, use Fit width or Fit page, and turn pages with the arrows under it.',
  },
  {
    id: 'reader-page-layout',
    route: '/read/{id}',
    target: '.rd-pdf-controls',
    needsBook: true,
    pdfOnly: true,
    title: 'Fix the reading order',
    body: 'Layout, under the page, outlines the blocks detection found and numbers them in reading order. If the voice reads a column or a box in the wrong order, tap Fix order, then tap the blocks in the order they should be read and save. That order is for this page; re-analysing the book replaces it.',
  },
  {
    id: 'reader-selection',
    route: '/read/{id}',
    needsBook: true,
    title: 'Highlight, note or make a card',
    body: 'Press and hold a sentence, or drag across a few, and let go. The bar that opens has a highlight colour, Play, Sentence to extend the selection, Note, Bookmark, Q&A card, Cloze card and AI.',
  },
  {
    id: 'settings-voice-models',
    route: '/settings#voice-models',
    target: '#voice-models .disc-head',
    title: 'Download a voice',
    body: 'Kokoro-82M is the higher quality, more natural sounding voice and the recommended one: 28 voices, 320 MB on the web and 334 MB in the Android app. Pocket TTS is smaller — 8 voices, about 180 MB. Download sits in each card’s header: it happens once, then that voice works offline, and Delete frees the space. The reader’s voice button offers the same download without leaving the book.',
  },
  {
    id: 'settings-pdf-layout',
    route: '/settings#pdf-layout',
    target: '#pdf-layout .disc-head',
    title: 'PDF layout detection',
    body: 'Download the layout model, then read any PDF already in the Library again with detection, so textbook columns, tables and figures come out in the right reading order. Re-reading keeps highlights and bookmarks with the same text where it is still there, and leaves cards alone. The answer to the import question is saved here too.',
  },
  {
    id: 'settings-voice',
    route: '/settings#voice',
    target: '#voice .disc-head',
    title: 'Choose the voice and speed',
    body: 'Engine decides who reads. Auto uses a downloaded model when one is ready, and the system voice otherwise. System voices are free and offline because they are already on the phone. System voice picks the exact one, and Speed covers 0.5× to 2× for every engine; Pocket TTS stops at 0.80×–1.25×.',
  },
  {
    id: 'settings-backup',
    route: '/settings#backup',
    target: '#backup .disc-head',
    title: 'Keep a copy outside the phone',
    body: 'Export (with books) writes one file with your books, highlights, bookmarks, cards, reviews, topics, pronunciations and settings. Export (notes & cards only) leaves the books out. Import restores the file here or on another device. It is the only copy that survives a lost or reset phone.',
  },
];

/** Shown last when the Library is empty: the Reader steps had no book to point at. */
const EMPTY_LIBRARY_STEP: TutorialStep = {
  id: 'empty-library',
  route: '/',
  title: 'Add a book to go further',
  body: 'The Reader part of the tour needs a book. Import one on the Library, then open Settings, About, and tap How to use PharmaReader to take the tour again.',
};

/** A bare target name means a `data-tour` attribute; `#id`/`.class`/`[…]` are selectors. */
function selectorFor(target: string): string {
  return /^[#.[]/.test(target) ? target : `[data-tour="${target}"]`;
}

function stepsFor(book: BookRecord | null): TutorialStep[] {
  const steps = TUTORIAL_STEPS.filter(
    (step) => (!step.needsBook || book !== null) && (!step.pdfOnly || book?.format === 'pdf'),
  ).map((step) =>
    book && step.route?.includes('{id}') ? { ...step, route: step.route.replace('{id}', encodeURIComponent(book.id)) } : step,
  );
  return book ? steps : [...steps, EMPTY_LIBRARY_STEP];
}

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface TutorialProps {
  /** Removes the tour; focus returns to whatever opened it. */
  onClose: () => void;
}

export default function Tutorial({ onClose }: TutorialProps) {
  const navigate = useNavigate();
  const titleId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const openerNameRef = useRef<string>('');
  const openerSectionRef = useRef<string>('');
  const startRouteRef = useRef<string>(window.location.pathname);

  const [book, setBook] = useState<BookRecord | null | undefined>(undefined);
  const [index, setIndex] = useState(0);
  const [box, setBox] = useState<Box | null>(null);
  const [resolved, setResolved] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const steps = useMemo(() => (book === undefined ? null : stepsFor(book)), [book]);
  const step = steps ? steps[Math.min(index, steps.length - 1)] : null;
  const last = steps ? index >= steps.length - 1 : false;

  // Drop the old spotlight before the new step paints, so no ring is ever left
  // over a control that the next step will not point at.
  const goTo = (next: number) => {
    setBox(null);
    setPos(null);
    setResolved(false);
    setIndex(next);
  };

  // Which book the Reader steps point at: the most recent one, as the Library
  // shows it. No book means those steps are dropped below.
  useEffect(() => {
    let alive = true;
    db.books
      .orderBy('addedAt')
      .reverse()
      .first()
      .then((found) => {
        if (alive) setBook(found ?? null);
      })
      .catch(() => {
        if (alive) setBook(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  const closeRef = useRef<() => void>(() => undefined);
  closeRef.current = () => {
    // Fire-and-forget: a failed write only means the tour may greet once more.
    void setSetting(TUTORIAL_SEEN_KEY, true).catch(() => undefined);

    const opener = openerRef.current;
    const openerName = openerNameRef.current;
    const openerSection = openerSectionRef.current;
    const startRoute = startRouteRef.current;

    if (window.location.pathname !== startRoute) navigate(startRoute);
    onClose();

    // The page can remount on the way back (Settings loses its open row), so the
    // opener may be gone: fall back to its row, then to a control with its name.
    window.setTimeout(() => {
      if (opener && isFocusable(opener)) {
        opener.focus();
        return;
      }
      const head = openerSection ? document.getElementById(openerSection)?.querySelector<HTMLElement>('.disc-head') : null;
      if (head && isFocusable(head)) {
        head.focus();
        return;
      }
      if (!openerName) return;
      const match = [...document.querySelectorAll<HTMLElement>('button, a[href]')].find(
        (candidate) =>
          isFocusable(candidate) &&
          (candidate.getAttribute('aria-label') ?? candidate.textContent?.trim()) === openerName,
      );
      match?.focus();
    }, 0);
  };

  useEffect(() => {
    const active = document.activeElement;
    const opener = active instanceof HTMLElement && active !== document.body ? active : null;
    openerRef.current = opener;
    if (opener) {
      openerNameRef.current = opener.getAttribute('aria-label') ?? opener.textContent?.trim() ?? '';
      openerSectionRef.current = opener.closest('section[id]')?.id ?? '';
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      // Tab stays inside the card instead of walking into the page behind it.
      if (event.key !== 'Tab') return;
      const card = cardRef.current;
      if (!card) return;
      const focusable = [...card.querySelectorAll<HTMLElement>('button:not(:disabled), [href]')];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const lastFocusable = focusable[focusable.length - 1];
      const current = document.activeElement;
      if (event.shiftKey && (current === first || !card.contains(current))) {
        event.preventDefault();
        lastFocusable.focus();
      } else if (!event.shiftKey && (current === lastFocusable || !card.contains(current))) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    // Android back closes the tour instead of leaving the page under it.
    const dispose = pushBackHandler(() => {
      closeRef.current();
      return true;
    });

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      dispose();
    };
  }, []);

  // Moving to a step: go to its page, then find, scroll to and measure the
  // control. Pages mount asynchronously, so the lookup retries for about a
  // second before the card falls back to the bottom of the screen.
  useEffect(() => {
    if (!steps || !step) return;
    setBox(null);
    setResolved(false);
    setPos(null);

    let cancelled = false;
    let retry = 0;
    let frame = 0;
    let observer: ResizeObserver | null = null;
    let element: HTMLElement | null = null;

    function measure() {
      if (cancelled || !element) return;
      const found = element.getBoundingClientRect();
      setBox({ top: found.top, left: found.left, width: found.width, height: found.height });
    }

    function nextFrame(callback: () => void): number {
      if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
      return window.setTimeout(callback, 0);
    }

    function cancelFrame(id: number) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
      else window.clearTimeout(id);
    }

    function watch(found: HTMLElement) {
      element = found;
      if (typeof found.scrollIntoView === 'function') found.scrollIntoView({ block: 'center' });
      measure();
      if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(() => measure());
        observer.observe(found);
      }
      window.addEventListener('scroll', measure, true);
      window.addEventListener('resize', measure);
      setResolved(true);
      // A row that opens from the hash changes height a frame later.
      frame = nextFrame(() => {
        if (!cancelled) measure();
      });
    }

    function query(): HTMLElement | null {
      try {
        const candidate = step?.target ? document.querySelector<HTMLElement>(selectorFor(step.target)) : null;
        return candidate && visible(candidate) ? candidate : null;
      } catch {
        return null;
      }
    }

    function find(until: number) {
      if (cancelled) return;
      if (!step?.target) {
        setResolved(true);
        return;
      }
      const found = query();
      if (found) {
        watch(found);
        return;
      }
      if (Date.now() >= until) {
        // A conditional step whose control is not there (the Text / Page switch
        // on a book that has no pages) is dropped rather than shown empty.
        if (step.pdfOnly && steps && index < steps.length - 1) {
          // The setters inside `goTo` are stable, so the captured index is the
          // step this lookup was started for.
          goTo(index + 1);
          return;
        }
        setResolved(true);
        // Show the card now, but keep looking: the Reader builds its player
        // after parsing the book, which can take a moment.
        keepLooking(Date.now() + 8000);
        return;
      }
      retry = window.setTimeout(() => find(until), 40);
    }

    function keepLooking(deadline: number) {
      if (cancelled) return;
      const found = query();
      if (found) {
        watch(found);
        return;
      }
      if (Date.now() >= deadline) return;
      retry = window.setTimeout(() => keepLooking(deadline), 250);
    }

    if (step.route) {
      const here = window.location.pathname + window.location.search + window.location.hash;
      if (step.route !== here) {
        const path = window.location.pathname;
        navigate(step.route);
        // A router push changes the hash without firing `hashchange`, which is
        // what Settings listens for to open a row. Only same-page moves need it.
        if (step.route.includes('#') && window.location.pathname === path) {
          window.dispatchEvent(new Event('hashchange'));
        }
      }
    }

    // Wait one frame so the new route can paint before the first lookup.
    frame = nextFrame(() => {
      if (!cancelled) find(Date.now() + 1000);
    });

    return () => {
      cancelled = true;
      window.clearTimeout(retry);
      if (frame) cancelFrame(frame);
      observer?.disconnect();
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [index, steps, step, navigate]);

  // Focus goes to the tour's Next button on every step.
  useEffect(() => {
    if (resolved) nextRef.current?.focus();
  }, [index, resolved]);

  // Place the card next to the spotlight: below when there is room, else above,
  // always 16px inside the window. CSS adds the safe-area insets on top.
  useLayoutEffect(() => {
    if (!resolved || !box) {
      setPos(null);
      return;
    }
    const card = cardRef.current;
    if (!card) return;
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    const width = card.offsetWidth || Math.min(352, Math.max(0, vw - 32));
    const height = card.offsetHeight;    const gap = 12;
    const margin = 16;
    let top = box.top + box.height + gap;
    if (top + height > vh - margin) top = box.top - height - gap;
    // A long card fits neither side of a centred target on a short phone: bring
    // the target to the top so the card clears it. The scroll re-measures the box.
    if (top < margin && box.top > margin + 8 && typeof window.scrollBy === 'function') {
      window.scrollBy(0, box.top - margin - 6);
    }
    top = Math.max(margin, Math.min(top, vh - height - margin));
    let left = box.left + box.width / 2 - width / 2;
    left = Math.max(margin, Math.min(left, vw - width - margin));
    setPos({ top, left });
  }, [resolved, box, index]);

  if (!resolved || !steps || !step) {
    return <div className="tour-catch" aria-hidden="true" />;
  }

  const spot = box
    ? {
        top: box.top - 6,
        left: box.left - 6,
        width: Math.max(0, box.width + 12),
        height: Math.max(0, box.height + 12),
      }
    : null;
  const cardStyle = pos
    ? ({ '--tour-top': `${pos.top}px`, '--tour-left': `${pos.left}px` } as CSSProperties)
    : undefined;

  return (
    <>
      <div className="tour-catch" aria-hidden="true" />
      {spot ? (
        <div
          className="tour-spot"
          aria-hidden="true"
          style={{ top: spot.top, left: spot.left, width: spot.width, height: spot.height }}
        />
      ) : (
        <div className="tour-scrim" aria-hidden="true" />
      )}

      <div
        ref={cardRef}
        className={spot ? 'tour tour-card' : 'tour tour-card tour-card--centre'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={cardStyle}
      >
        <h2 id={titleId} className="tour-title">
          {step.title}
        </h2>
        <p className="tour-body">{step.body}</p>

        <div className="tour-actions">
          <button type="button" className="btn btn-ghost" onClick={() => closeRef.current()}>
            Skip
          </button>
          <span className="tour-count muted tnum">
            {index + 1} of {steps.length}
          </span>
          <span className="tour-gap" aria-hidden="true" />
          {index > 0 ? (
            <button type="button" className="btn btn-secondary" onClick={() => goTo(index - 1)}>
              Back
            </button>
          ) : null}
          <button
            ref={nextRef}
            type="button"
            className="btn btn-primary"
            onClick={() => (last ? closeRef.current() : goTo(index + 1))}
          >
            {last ? 'Done' : 'Next'}
          </button>
        </div>
      </div>
    </>
  );
}

/** A control inside a closed row still exists in the DOM; `checkVisibility` sees that. */
function visible(element: HTMLElement): boolean {
  const check = (element as HTMLElement & { checkVisibility?: () => boolean }).checkVisibility;
  if (typeof check === 'function') return check.call(element);
  // No layout engine (jsdom): trust the selector.
  return true;
}

function isFocusable(element: HTMLElement): boolean {
  if (!element.isConnected) return false;
  const check = (element as HTMLElement & { checkVisibility?: () => boolean }).checkVisibility;
  if (typeof check === 'function') return check.call(element);
  return true;
}
