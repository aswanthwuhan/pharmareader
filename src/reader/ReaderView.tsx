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
import { setSetting, useSetting } from '../core/settings';
import type { Highlight } from '../core/types';
import { createPlayer, type Player } from '../tts/player';
import { describeEngine, type EngineInfo } from '../tts/registry';
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

interface Picked {
  ids: string[];
  text: string;
}

export default function ReaderView() {
  const { bookId } = useParams<{ bookId: string }>();
  const book = useLiveQuery(async () => (bookId ? ((await db.books.get(bookId)) ?? null) : null), [bookId]);

  const fontSize = useSetting<number>(FONT_KEY, DEFAULT_FONT);
  const lineHeight = useSetting<number>(LINE_KEY, LINE_HEIGHTS[0] ?? 1.5);
  const rate = useSetting<number>(RATE_KEY, 1);
  const voiceId = useSetting<string>(VOICE_KEY, '');

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
  const rateRef = useRef(rate);
  rateRef.current = rate;
  const abortRef = useRef<AbortController | null>(null);
  const restored = useRef(false);

  const chapterIndex = cursor?.chapterIndex ?? 0;
  const chapter = book?.parsed.chapters[chapterIndex];
  const reading = index ? sentenceAt(index, cursor) : null;
  const readingId = reading?.id ?? null;

  // -- position ------------------------------------------------------------

  useEffect(() => {
    if (!book || !index || restored.current) return;
    restored.current = true;
    setCursor(posForSaved(book.parsed, index, book.lastPos));
  }, [book, index]);

  useEffect(() => {
    if (!book || !cursor) return;
    const sentence = index ? sentenceAt(index, cursor) : null;
    if (!sentence) return;
    const chapterId = book.parsed.chapters[cursor.chapterIndex]?.id ?? '';
    const timer = setTimeout(() => {
      void db.books.update(book.id, { lastPos: { chapterId, sentenceId: sentence.id } });
    }, SAVE_POS_MS);
    return () => clearTimeout(timer);
  }, [book?.id, cursor?.chapterIndex, cursor?.index]);

  useEffect(() => {
    window.scrollTo?.({ top: 0 });
  }, [chapterIndex]);

  // Show the engine that will actually speak before the first tap.
  useEffect(() => {
    if (book && !engineRef.current) void engineForPlay();
  }, [book?.id]);

  // Auto-turn the PDF page when the spoken sentence lives on another page.
  useEffect(() => {
    const first = reading?.pdfRects?.[0];
    if (first && mode === 'page') setPdfPage(first.page);
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

  async function startFrom(ci: number, at: number): Promise<void> {
    if (!book || !index) return;
    releasePlayer();
    const mine = ++generation.current;
    const info = await engineForPlay();
    if (mine !== generation.current) return;
    setEngineInfo(info);

    const items = chapterItems(ci);
    if (!items.length) return;
    const player = createPlayer({
      engine: info.engine,
      items,
      startIndex: at,
      voiceId: voiceId || undefined,
      rate: rateRef.current,
      onSentence: (id) => {
        if (mine !== generation.current) return;
        const pos = index.byId.get(id);
        if (pos) setCursor(pos);
      },
      onDone: () => {
        if (mine !== generation.current) return;
        const next = ci + 1;
        if (next < index.chapters.length) void startFrom(next, 0);
        else setPlayState('idle');
      },
      onError: (err) => {
        if (mine !== generation.current) return;
        setPlayState('idle');
        setError(err.message);
      },
    });
    playerRef.current = player;
    setPlayState('playing');
    player.play();
  }

  function togglePlay(): void {
    if (!cursor) return;
    if (playState === 'playing') {
      playerRef.current?.pause();
      setPlayState('paused');
      return;
    }
    if (playState === 'paused') {
      playerRef.current?.resume();
      setPlayState('playing');
      return;
    }
    void startFrom(cursor.chapterIndex, cursor.index);
  }

  function stopPlayback(): void {
    releasePlayer();
  }

  function step(delta: number): void {
    if (!index || !cursor) return;
    const target = stepPos(index, cursor, delta);
    if (!target) return;
    if (playState === 'playing') {
      void startFrom(target.chapterIndex, target.index);
      return;
    }
    if (playState === 'paused') releasePlayer();
    setCursor(target);
  }

  function changeRate(next: number): void {
    rateRef.current = next;
    void setSetting(RATE_KEY, next);
    if (playState === 'playing' && cursor) void startFrom(cursor.chapterIndex, cursor.index);
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
        { voiceId: voiceId || undefined, rate: rateRef.current, signal: controller.signal },
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
        topicIds: book.topicIds,
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
    if (playState !== 'idle') releasePlayer();
    setCursor(pos);
    setMode('text');
    setDrawer('none');
  }

  // -- lock-screen controls ------------------------------------------------

  const actions = useRef({ togglePlay, step, stopPlayback });
  actions.current = { togglePlay, step, stopPlayback };

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator) || !book) return;
    const session = navigator.mediaSession;
    try {
      session.metadata = new MediaMetadata({
        title: book.title,
        artist: book.author ?? 'PharmaReader',
        album: chapter?.title ?? '',
      });
      session.setActionHandler('play', () => actions.current.togglePlay());
      session.setActionHandler('pause', () => actions.current.togglePlay());
      session.setActionHandler('nexttrack', () => actions.current.step(1));
      session.setActionHandler('previoustrack', () => actions.current.step(-1));
      session.setActionHandler('stop', () => actions.current.stopPlayback());
    } catch {
      // Some Android webviews expose mediaSession but no MediaMetadata.
    }
  }, [book?.id, chapter?.id, book?.title, book?.author]);

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
            Topics{book.topicIds.length ? ` (${book.topicIds.length})` : ''}
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
            if (playState === 'playing') {
              void startFrom(sentence.chapterIndex, sentence.index);
              return;
            }
            if (playState === 'paused') releasePlayer();
            setCursor({ chapterIndex: sentence.chapterIndex, index: sentence.index });
          }}
          onSelect={(ids, text) => setSelection({ ids, text: text || textsOf(ids) })}
        />
      ) : (
        <p className="muted">This book has no readable text.</p>
      )}

      <nav className="rd-chapter-nav" aria-label="Chapter navigation">
        <button type="button" className="rd-btn" disabled={chapterIndex <= 0} onClick={() => setCursor({ chapterIndex: chapterIndex - 1, index: 0 })}>
          ‹ Previous chapter
        </button>
        <button
          type="button"
          className="rd-btn"
          disabled={chapterIndex >= index.chapters.length - 1}
          onClick={() => setCursor({ chapterIndex: chapterIndex + 1, index: 0 })}
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
        <div className="rd-sheet" role="dialog" aria-modal="true" aria-label="AI actions">
          <div className="rd-sheet-body">
            <AiActions text={aiText} bookId={book.id} topicIds={book.topicIds} onClose={() => setAiText(null)} />
          </div>
        </div>
      ) : null}

      {topicOpen ? (
        <div className="rd-sheet" role="dialog" aria-modal="true" aria-label="Book topics">
          <div className="rd-sheet-body">
            <TopicPicker
              label="Topics for this book"
              value={book.topicIds}
              onChange={(ids) => void db.books.update(book.id, { topicIds: ids })}
            />
            <button type="button" className="rd-btn" onClick={() => setTopicOpen(false)}>
              Done
            </button>
          </div>
        </div>
      ) : null}

      {drawer !== 'none' ? (
        <div className="rd-sheet" role="dialog" aria-modal="true" aria-label="Chapters and notes">
          <div className="rd-sheet-body">
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
                      onClick={() => {
                        setCursor({ chapterIndex: i, index: 0 });
                        setDrawer('none');
                      }}
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
