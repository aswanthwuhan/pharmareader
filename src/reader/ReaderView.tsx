/**
 * The reading screen: one chapter of text (or the PDF page) plus the player.
 *
 * The cursor — one position in the document — is the single source of truth for
 * everything here: which chapter is shown, which sentence is highlighted, where
 * playback starts and what `lastPos` stores.
 */
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../core/db';
import { getSetting, setSetting, useSetting } from '../core/settings';
import type { BookRecord, Highlight } from '../core/types';
import { createPlayer, type Player } from '../tts/player';
import { describeEngine, ENGINE_SETTING, type EngineInfo } from '../tts/registry';
import { prerenderChapter } from '../tts/neural/prerender';
import { addBookmark, addHighlight, cardFromHighlight, createCard, listHighlights } from '../study/api';
import HighlightList from '../study/HighlightList';
import AiActions from '../ai/AiActions';
import TopicPicker from '../syllabus/TopicPicker';
import PlayerBar, { type PlayState } from './PlayerBar';
import SelectionBar, { type HighlightColor } from './SelectionBar';
import ReflowView from './ReflowView';
import {
  highlightBySentence,
  indexBook,
  posForSaved,
  sentenceAt,
  stepPos,
  type FlatSentence,
  type Pos,
} from './sentences';
import './reader.css';

// pdfjs is only needed for a PDF book in page mode; never load it sooner.
const PdfView = lazy(() => import('./PdfView'));

const FONT_KEY = 'reader.fontSize';
const LINE_KEY = 'reader.lineHeight';
const RATE_KEY = 'tts.rate';
const VOICE_KEY = 'tts.voice.system';
const DEFAULT_FONT = 18;
const FONT_MIN = 14;
const FONT_MAX = 32;
const LINE_HEIGHTS = [1.5, 1.7, 1.9];
const SAVE_POS_MS = 700;
const RATE_RESTART_MS = 350;

/**
 * Reading position lives in settings, not in the book record: a book carries
 * its parsed document (tens of MB on a textbook) and rewriting it every few
 * seconds while playing would re-serialise that whole record. `books.lastPos`
 * is still kept up to date — the library needs it — but only when the reader
 * leaves a chapter or the screen.
 */
function lastPosKey(bookId: string): string {
  return `reader.lastPos.${bookId}`;
}

interface SavedPos {
  chapterId: string;
  sentenceId: string;
}

interface Picked {
  ids: string[];
  text: string;
}

export default function ReaderView() {
  const { bookId } = useParams<{ bookId: string }>();

  // Loaded once, not live: the record includes `parsed` (and the original
  // file), so a live query would re-read the whole book on every position save.
  const [book, setBook] = useState<BookRecord | null | undefined>(undefined);
  const [topicIds, setTopicIds] = useState<string[]>([]);

  const fontSize = useSetting<number>(FONT_KEY, DEFAULT_FONT);
  const lineHeight = useSetting<number>(LINE_KEY, LINE_HEIGHTS[0] ?? 1.5);
  const rate = useSetting<number>(RATE_KEY, 1);
  const voiceId = useSetting<string>(VOICE_KEY, '');
  const engineChoice = useSetting<string>(ENGINE_SETTING, 'auto');

  const [cursor, setCursor] = useState<Pos | null>(null);
  const [mode, setMode] = useState<'text' | 'page'>('text');
  const [pdfPage, setPdfPage] = useState(1);
  const [drawer, setDrawer] = useState<'none' | 'toc' | 'notes'>('none');
  const [selection, setSelection] = useState<Picked | null>(null);
  const [aiText, setAiText] = useState<string | null>(null);
  const [topicOpen, setTopicOpen] = useState(false);
  const [playState, setPlayState] = useState<PlayState>('idle');
  const [engineInfo, setEngineInfo] = useState<EngineInfo | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [cachedChapter, setCachedChapter] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const index = useMemo(() => (book ? indexBook(book.parsed) : null), [book?.parsed]);
  const highlightsFor = useLiveQuery(async () => (bookId ? listHighlights(bookId) : []), [bookId]);
  const highlights = useMemo(() => highlightBySentence(highlightsFor ?? []), [highlightsFor]);

  const playerRef = useRef<Player | null>(null);
  const generation = useRef(0);
  const engineRef = useRef<EngineInfo | null>(null);
  // `rateRef` is the authoritative rate for the next player. It must not be
  // re-read from the (asynchronously persisted) setting on every render: a
  // release right after a slider move would then start at the stale rate.
  const rateRef = useRef(rate);
  useEffect(() => {
    rateRef.current = rate;
  }, [rate]);
  const voiceRef = useRef(voiceId);
  voiceRef.current = voiceId;
  const cursorRef = useRef<Pos | null>(cursor);
  cursorRef.current = cursor;
  const playStateRef = useRef<PlayState>(playState);
  playStateRef.current = playState;
  const abortRef = useRef<AbortController | null>(null);
  const restored = useRef(false);
  const lastSavedKey = useRef('');
  const pendingPos = useRef<{ bookId: string; pos: SavedPos } | null>(null);
  const rateTimer = useRef<number | null>(null);
  const sheetBody = useRef<HTMLDivElement>(null);

  const chapterIndex = cursor?.chapterIndex ?? 0;
  const chapter = book?.parsed.chapters[chapterIndex];
  const reading = index ? sentenceAt(index, cursor) : null;
  const readingId = reading?.id ?? null;

  // -- position ------------------------------------------------------------

  /** Hand the latest reading position back to the library (one write, not one per sentence). */
  function flushBookPos(): void {
    const pending = pendingPos.current;
    if (!pending) return;
    pendingPos.current = null;
    void db.books.update(pending.bookId, { lastPos: pending.pos }).catch(() => {
      // The position is a convenience; a failed write must never break reading.
    });
  }

  useEffect(() => {
    let alive = true;
    restored.current = false;
    lastSavedKey.current = '';
    setBook(undefined);
    setCursor(null);
    setTopicIds([]);
    releasePlayer();
    if (!bookId) {
      setBook(null);
      return () => {
        alive = false;
      };
    }
    void db.books
      .get(bookId)
      .then((record) => {
        if (!alive) return;
        setBook(record ?? null);
        setTopicIds(record?.topicIds ?? []);
      })
      .catch(() => {
        if (alive) setBook(null);
      });
    return () => {
      alive = false;
    };
    // releasePlayer is stable enough for this purpose (refs + setState only).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  useEffect(() => {
    if (!book || !index || restored.current) return;
    restored.current = true;
    const parsed = book.parsed;
    const fallback = book.lastPos;
    let alive = true;

    void getSetting<SavedPos | undefined>(lastPosKey(book.id), undefined)
      .catch(() => undefined)
      .then((stored) => {
        if (!alive) return;
        const pos = posForSaved(parsed, index, stored ?? fallback);
        const sentence = sentenceAt(index, pos);
        if (sentence) lastSavedKey.current = `${parsed.chapters[pos.chapterIndex]?.id ?? ''}:${sentence.id}`;
        setCursor(pos);
      });

    return () => {
      alive = false;
    };
  }, [book, index]);

  useEffect(() => {
    if (!book || !cursor || !index) return;
    const sentence = sentenceAt(index, cursor);
    if (!sentence) return;
    const chapterId = book.parsed.chapters[cursor.chapterIndex]?.id ?? '';
    const key = `${chapterId}:${sentence.id}`;
    if (lastSavedKey.current === key) return;

    const id = book.id;
    const pos: SavedPos = { chapterId, sentenceId: sentence.id };
    const timer = window.setTimeout(() => {
      lastSavedKey.current = key;
      pendingPos.current = { bookId: id, pos };
      void setSetting(lastPosKey(id), pos);
    }, SAVE_POS_MS);
    return () => window.clearTimeout(timer);
  }, [book, index, cursor]);

  // Crossing a chapter boundary is the natural moment to persist the heavier
  // `books.lastPos` for the library progress bar.
  useEffect(() => {
    flushBookPos();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterIndex]);

  useEffect(() => {
    window.scrollTo?.({ top: 0 });
  }, [chapterIndex]);

  // Resolve the engine before the first tap for two reasons: the Play handler
  // must call player.play() synchronously (autoplay gesture), and a slow model
  // probe must not delay it. Re-resolve when the user changes the engine.
  useEffect(() => {
    let alive = true;
    releasePlayer();
    engineRef.current = null;
    setEngineInfo(null);
    void describeEngine()
      .then((info) => {
        if (!alive) return;
        engineRef.current = info;
        setEngineInfo(info);
      })
      .catch(() => {
        // describeEngine already falls back to system; a throw here means no TTS.
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, engineChoice]);

  // Auto-turn the PDF page when the spoken sentence lives on another page.
  useEffect(() => {
    const first = reading?.pdfRects?.[0];
    if (first && mode === 'page') setPdfPage(Math.max(1, first.page));
  }, [readingId, mode]);

  // -- playback ------------------------------------------------------------

  async function engineForPlay(): Promise<EngineInfo> {
    if (engineRef.current) return engineRef.current;
    const info = await describeEngine();
    engineRef.current = info;
    setEngineInfo(info);
    return info;
  }

  /** Stop whatever is queued; any in-flight callback becomes stale. */
  function releasePlayer(): void {
    generation.current += 1;
    const player = playerRef.current;
    playerRef.current = null;
    player?.stop();
    setPlayState('idle');
  }

  function chapterItems(ci: number): { id: string; text: string }[] {
    return (index?.chapters[ci] ?? []).map((sentence) => ({ id: sentence.id, text: sentence.text }));
  }

  /**
   * Start speaking, synchronously. Called straight from the tap handler so the
   * element's first `play()` happens inside the user gesture; everything slow
   * (engine probe, voice list) has already been resolved.
   */
  function beginPlayback(info: EngineInfo, ci: number, at: number): void {
    if (!book || !index) return;
    releasePlayer();
    const mine = ++generation.current;

    // Skip empty chapters (an import can produce one) rather than stall.
    let chapterIdx = ci;
    let startIndex = at;
    while (chapterIdx < index.chapters.length && (index.chapters[chapterIdx]?.length ?? 0) === 0) {
      chapterIdx += 1;
      startIndex = 0;
    }
    if (chapterIdx >= index.chapters.length) return;

    const items = chapterItems(chapterIdx);
    if (!items.length) return;
    const firstIndex = Math.min(Math.max(0, startIndex), items.length - 1);

    setError(null);
    const player = createPlayer({
      engine: info.engine,
      items,
      startIndex: firstIndex,
      voiceId: voiceRef.current || undefined,
      rate: rateRef.current,
      onSentence: (id) => {
        if (mine !== generation.current) return;
        const pos = index.byId.get(id);
        if (pos) setCursor(pos);
      },
      onDone: () => {
        if (mine !== generation.current) return;
        const nextInfo = engineRef.current ?? info;
        if (chapterIdx + 1 < index.chapters.length) {
          beginPlayback(nextInfo, chapterIdx + 1, 0);
          return;
        }
        setPlayState('idle');
      },
      onError: (err) => {
        if (mine !== generation.current) return;
        setPlayState('idle');
        setError(err.message);
      },
    });
    playerRef.current = player;
    setPlayState('playing');
    // Move the page to what is being spoken now, not when the first clip is
    // ready: auto-advance into the next chapter must show that chapter at once.
    setCursor({ chapterIndex: chapterIdx, index: firstIndex });
    player.play();
  }

  /** Async entry point for paths that are not a tap (or a tap before resolution). */
  async function startFrom(ci: number, at: number): Promise<void> {
    const mine = generation.current;
    const info = await engineForPlay();
    if (mine !== generation.current) return;
    beginPlayback(info, ci, at);
  }

  function pauseOnly(): void {
    if (playStateRef.current !== 'playing') return;
    playerRef.current?.pause();
    setPlayState('paused');
  }

  function startOrResume(): void {
    const pos = cursorRef.current;
    if (!pos) return;
    if (playStateRef.current === 'playing') return;
    if (playStateRef.current === 'paused' && playerRef.current) {
      playerRef.current.resume();
      setPlayState('playing');
      return;
    }
    const info = engineRef.current;
    if (info) beginPlayback(info, pos.chapterIndex, pos.index);
    else void startFrom(pos.chapterIndex, pos.index);
  }

  function togglePlay(): void {
    if (playStateRef.current === 'playing') pauseOnly();
    else startOrResume();
  }

  function stopPlayback(): void {
    releasePlayer();
    flushBookPos();
  }

  function step(delta: number): void {
    if (!index || !cursor) return;
    const target = stepPos(index, cursor, delta);
    if (!target) return;
    if (playStateRef.current === 'playing') {
      const info = engineRef.current;
      if (info) beginPlayback(info, target.chapterIndex, target.index);
      else void startFrom(target.chapterIndex, target.index);
      return;
    }
    if (playStateRef.current === 'paused') releasePlayer();
    setCursor(target);
  }

  function goToChapter(ci: number): void {
    if (!index || ci < 0 || ci >= index.chapters.length) return;
    if (playStateRef.current !== 'idle') releasePlayer();
    flushBookPos();
    setCursor({ chapterIndex: ci, index: 0 });
  }

  function changeRate(next: number): void {
    rateRef.current = next;
    void setSetting(RATE_KEY, next);
    // The player's rate is fixed at creation. A paused clip would ignore the
    // new rate on resume, so drop it and let Play start fresh with this rate.
    if (playStateRef.current === 'paused') {
      releasePlayer();
      return;
    }
    // A slider drag fires many updates; restart once it settles.
    if (rateTimer.current !== null) window.clearTimeout(rateTimer.current);
    if (playStateRef.current !== 'playing') return;
    rateTimer.current = window.setTimeout(() => {
      rateTimer.current = null;
      const info = engineRef.current;
      const pos = cursorRef.current;
      if (!info || !pos || playStateRef.current !== 'playing') return;
      beginPlayback(info, pos.chapterIndex, pos.index);
    }, RATE_RESTART_MS);
  }

  function changeFont(delta: number): void {
    const next = Math.min(Math.max(Math.round(fontSize) + delta, FONT_MIN), FONT_MAX);
    void setSetting(FONT_KEY, next);
  }

  function cycleLineHeight(): void {
    const current = LINE_HEIGHTS.indexOf(lineHeight);
    const next = LINE_HEIGHTS[(current + 1) % LINE_HEIGHTS.length] ?? LINE_HEIGHTS[0] ?? 1.5;
    void setSetting(LINE_KEY, next);
  }

  async function preRender(): Promise<void> {
    if (!index || !cursor) return;
    const items = chapterItems(cursor.chapterIndex);
    if (!items.length) return;
    const info = await engineForPlay();
    if (!info.engine.synthesize) {
      setError(`${info.engine.label} cannot store audio; it speaks directly.`);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    setProgress({ done: 0, total: items.length });
    try {
      const report = await prerenderChapter(
        info.engine,
        items,
        { voiceId: voiceRef.current || undefined, rate: rateRef.current, signal: controller.signal },
        (p) => setProgress({ done: p.done, total: p.total })
      );
      if (!report.aborted) {
        setCachedChapter(chapter?.id ?? null);
        if (report.failed > 0) setError(`${report.failed} sentence(s) could not be pre-rendered.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      abortRef.current = null;
      setProgress(null);
    }
  }

  // -- selection actions ---------------------------------------------------

  function textsOf(ids: string[]): string {
    if (!index) return '';
    return ids
      .map((id) => sentenceAt(index, index.byId.get(id) ?? null)?.text ?? '')
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  function clearSelection(): void {
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  }

  /** Grow a long-press selection one sentence further. */
  function extendSelection(): void {
    if (!selection || !index) return;
    const last = selection.ids[selection.ids.length - 1];
    const pos = last ? index.byId.get(last) : undefined;
    if (!pos) return;
    const next = stepPos(index, pos, 1);
    const sentence = sentenceAt(index, next);
    if (!sentence || selection.ids.includes(sentence.id)) return;
    setSelection({
      ids: [...selection.ids, sentence.id],
      text: `${selection.text} ${sentence.text}`.trim(),
    });
  }

  async function highlightSelection(color: HighlightColor, note?: string): Promise<Highlight | null> {
    if (!book || !selection) return null;
    try {
      const highlight = await addHighlight({
        bookId: book.id,
        sentenceIds: selection.ids,
        text: selection.text,
        color,
        topicIds,
        ...(note ? { note } : {}),
      });
      clearSelection();
      return highlight;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  async function bookmarkHere(): Promise<void> {
    if (!book || !reading || !chapter) return;
    try {
      await addBookmark({
        bookId: book.id,
        chapterId: chapter.id,
        sentenceId: reading.id,
        label: reading.text.slice(0, 80),
      });
      clearSelection();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function makeCard(kind: 'qa' | 'cloze'): Promise<void> {
    const highlight = await highlightSelection('yellow');
    if (!highlight) return;
    try {
      await createCard(cardFromHighlight(highlight, kind));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function jumpTo(sentenceId: string): void {
    const pos = index?.byId.get(sentenceId);
    if (!pos) return;
    if (playStateRef.current !== 'idle') releasePlayer();
    flushBookPos();
    setCursor(pos);
    setMode('text');
    setDrawer('none');
  }

  // -- lock-screen controls ------------------------------------------------

  const actions = useRef({ play: startOrResume, pause: pauseOnly, step, stop: stopPlayback });
  actions.current = { play: startOrResume, pause: pauseOnly, step, stop: stopPlayback };

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator) || !book) return;
    const session = navigator.mediaSession;
    const handlers: [MediaSessionAction, (() => void) | null][] = [
      ['play', () => actions.current.play()],
      ['pause', () => actions.current.pause()],
      ['stop', () => actions.current.stop()],
      ['nexttrack', () => actions.current.step(1)],
      ['previoustrack', () => actions.current.step(-1)],
    ];
    try {
      session.metadata = new MediaMetadata({
        title: book.title,
        artist: book.author ?? 'PharmaReader',
        album: chapter?.title ?? '',
      });
    } catch {
      // Some Android webviews expose mediaSession but no MediaMetadata.
    }
    try {
      for (const [action, handler] of handlers) session.setActionHandler(action, handler);
    } catch {
      // An unsupported action must not cost us the others.
    }
    return () => {
      try {
        for (const [action] of handlers) session.setActionHandler(action, null);
      } catch {
        // Nothing to clear on a session that never accepted the handlers.
      }
    };
  }, [book?.id, chapter?.id, book?.title, book?.author]);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.playbackState = playState === 'playing' ? 'playing' : playState === 'paused' ? 'paused' : 'none';
    } catch {
      // Unsupported playbackState is harmless.
    }
  }, [playState]);

  // -- sheets: Escape + focus ----------------------------------------------

  useEffect(() => {
    const open = drawer !== 'none' || topicOpen || aiText !== null;
    if (!open) return;
    sheetBody.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (aiText !== null) setAiText(null);
      else if (topicOpen) setTopicOpen(false);
      else setDrawer('none');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer, topicOpen, aiText]);

  // -- unmount / app hidden ------------------------------------------------

  useEffect(() => {
    const flush = () => flushBookPos();
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', flush);
      flushBookPos();
      if (rateTimer.current !== null) window.clearTimeout(rateTimer.current);
      generation.current += 1;
      abortRef.current?.abort();
      playerRef.current?.stop();
      playerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -- render --------------------------------------------------------------

  if (book === undefined) {
    return (
      <section className="page rd-page">
        <p className="muted">Opening book…</p>
      </section>
    );
  }

  if (!book || !index) {
    return (
      <section className="page rd-page">
        <h1>Book not found</h1>
        <p className="muted">It may have been deleted.</p>
        <Link to="/" className="rd-btn">
          Back to library
        </Link>
      </section>
    );
  }

  const isPdf = book.format === 'pdf';
  const showPage = isPdf && mode === 'page';

  return (
    <section className="page rd-page">
      <header className="rd-head">
        <div className="rd-head-row">
          <Link to="/" className="rd-btn" aria-label="Back to library">
            ‹
          </Link>
          <h1 className="rd-title" title={book.title}>
            {book.title}
          </h1>
          <button type="button" className="rd-btn" onClick={() => setDrawer('toc')}>
            Chapters
          </button>
        </div>
        <div className="rd-tools">
          <button type="button" className="rd-btn" aria-label="Smaller text" onClick={() => changeFont(-1)}>
            A−
          </button>
          <button type="button" className="rd-btn" aria-label="Larger text" onClick={() => changeFont(1)}>
            A+
          </button>
          <button type="button" className="rd-btn" onClick={cycleLineHeight} aria-label="Change line spacing">
            Spacing
          </button>
          {isPdf ? (
            <button type="button" className="rd-btn" onClick={() => setMode(showPage ? 'text' : 'page')}>
              {showPage ? 'Text view' : 'Page view'}
            </button>
          ) : null}
          <button type="button" className="rd-btn" onClick={() => setTopicOpen(true)}>
            Topics{topicIds.length ? ` (${topicIds.length})` : ''}
          </button>
        </div>
      </header>

      {error ? (
        <p className="rd-error" role="alert">
          {error}
          <button type="button" className="rd-link" onClick={() => setError(null)}>
            Dismiss
          </button>
        </p>
      ) : null}

      {showPage ? (
        <Suspense fallback={<p className="muted">Loading page…</p>}>
          <PdfView
            docKey={book.id}
            file={book.fileBlob}
            page={pdfPage}
            rects={reading?.pdfRects ?? []}
            onPageChange={(page) => setPdfPage(Math.max(1, page))}
          />
        </Suspense>
      ) : chapter ? (
        <ReflowView
          key={chapter.id}
          chapter={chapter}
          sentences={index.chapters[chapterIndex] ?? []}
          readingId={readingId}
          highlights={highlights}
          selected={selection?.ids ?? []}
          fontSize={fontSize}
          lineHeight={lineHeight}
          onTap={(sentence: FlatSentence) => {
            setSelection(null);
            if (playStateRef.current === 'playing') {
              void startFrom(sentence.chapterIndex, sentence.index);
              return;
            }
            if (playStateRef.current === 'paused') releasePlayer();
            setCursor({ chapterIndex: sentence.chapterIndex, index: sentence.index });
          }}
          onSelect={(ids, text) => setSelection({ ids, text: text || textsOf(ids) })}
        />
      ) : (
        <p className="muted">This book has no readable text.</p>
      )}

      <nav className="rd-chapter-nav" aria-label="Chapter navigation">
        <button type="button" className="rd-btn" disabled={chapterIndex <= 0} onClick={() => goToChapter(chapterIndex - 1)}>
          ‹ Previous chapter
        </button>
        <button
          type="button"
          className="rd-btn"
          disabled={chapterIndex >= index.chapters.length - 1}
          onClick={() => goToChapter(chapterIndex + 1)}
        >
          Next chapter ›
        </button>
      </nav>

      <PlayerBar
        state={playState}
        engineLabel={engineInfo?.engine.label ?? 'Resolving voice…'}
        fallback={engineInfo ? !engineInfo.preferred : false}
        rate={rate}
        canPrerender={Boolean(engineInfo?.engine.capabilities.prerender)}
        progress={progress}
        cached={Boolean(cachedChapter && cachedChapter === chapter?.id)}
        onToggle={togglePlay}
        onStop={stopPlayback}
        onPrev={() => step(-1)}
        onNext={() => step(1)}
        onRate={changeRate}
        onPrerender={() => void preRender()}
        onCancelPrerender={() => abortRef.current?.abort()}
      />

      {selection ? (
        <SelectionBar
          text={selection.text}
          count={selection.ids.length}
          onHighlight={(color) => void highlightSelection(color)}
          onNote={(note) => void highlightSelection('yellow', note)}
          onBookmark={() => void bookmarkHere()}
          onCard={(kind) => void makeCard(kind)}
          onAi={() => {
            setAiText(selection.text);
            setSelection(null);
          }}
          onExtend={extendSelection}
          onClose={clearSelection}
        />
      ) : null}

      {aiText !== null ? (
        <div
          className="rd-sheet"
          role="dialog"
          aria-modal="true"
          aria-label="AI actions"
          onClick={(event) => {
            if (event.target === event.currentTarget) setAiText(null);
          }}
        >
          <div className="rd-sheet-body" ref={sheetBody} tabIndex={-1}>
            <AiActions
              text={aiText}
              bookId={book.id}
              topicIds={topicIds}
              onClose={() => setAiText(null)}
            />
          </div>
        </div>
      ) : null}

      {topicOpen ? (
        <div
          className="rd-sheet"
          role="dialog"
          aria-modal="true"
          aria-label="Book topics"
          onClick={(event) => {
            if (event.target === event.currentTarget) setTopicOpen(false);
          }}
        >
          <div className="rd-sheet-body" ref={sheetBody} tabIndex={-1}>
            <TopicPicker
              label="Topics for this book"
              value={topicIds}
              onChange={(ids) => {
                setTopicIds(ids);
                void db.books.update(book.id, { topicIds: ids });
              }}
            />
            <button type="button" className="rd-btn" onClick={() => setTopicOpen(false)}>
              Done
            </button>
          </div>
        </div>
      ) : null}

      {drawer !== 'none' ? (
        <div
          className="rd-sheet"
          role="dialog"
          aria-modal="true"
          aria-label="Chapters and notes"
          onClick={(event) => {
            if (event.target === event.currentTarget) setDrawer('none');
          }}
        >
          <div className="rd-sheet-body" ref={sheetBody} tabIndex={-1}>
            <div className="rd-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={drawer === 'toc'}
                className={drawer === 'toc' ? 'rd-tab active' : 'rd-tab'}
                onClick={() => setDrawer('toc')}
              >
                Chapters
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={drawer === 'notes'}
                className={drawer === 'notes' ? 'rd-tab active' : 'rd-tab'}
                onClick={() => setDrawer('notes')}
              >
                Notes
              </button>
              <button type="button" className="rd-btn rd-tab-close" aria-label="Close" onClick={() => setDrawer('none')}>
                ✕
              </button>
            </div>
            {drawer === 'toc' ? (
              <ol className="rd-toc">
                {book.parsed.chapters.map((entry, i) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className={i === chapterIndex ? 'rd-toc-link active' : 'rd-toc-link'}
                      onClick={() => goToChapter(i)}
                    >
                      {entry.title}
                    </button>
                  </li>
                ))}
              </ol>
            ) : (
              <HighlightList bookId={book.id} onJump={jumpTo} />
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
