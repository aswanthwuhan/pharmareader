/**
 * The reading screen: one chapter of text (or the PDF page) plus the player.
 *
 * The cursor — one position in the document — is the single source of truth for
 * everything here: which chapter is shown, which sentence is highlighted, where
 * playback starts and what `lastPos` stores.
 */
import { Suspense, lazy, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../core/db';
import { pushBackHandler } from '../core/backButton';
import { getSetting, setSetting, useSetting } from '../core/settings';
import type { BookRecord, Highlight, PdfRect } from '../core/types';
import { nativePlayback } from '../tts/native/playbackPlugin';
import { setImmersive } from '../tts/native/systemUi';
import { createPlayer, type ItemState, type Player } from '../tts/player';
import { describeEngine, ENGINE_SETTING, warmEngine, type EngineInfo } from '../tts/registry';
import { prerenderChapter } from '../tts/neural/prerender';
import {
  addBookmark,
  addHighlight,
  cardFromHighlight,
  createCard,
  findRangeHighlight,
  listHighlights,
  rangeHighlightPatch,
  updateHighlight,
} from '../study/api';
import HighlightList from '../study/HighlightList';
import AiActions from '../ai/AiActions';
import TopicPicker from '../syllabus/TopicPicker';
import ModelStatusBanner from '../tts/ModelStatusBanner';
import PlayerBar, { type PageNav, type PlayState } from './PlayerBar';
import SelectionBar, { type HighlightColor } from './SelectionBar';
import { Glyph, icons } from './Icon';
import ReflowView from './ReflowView';
import { LAST_BOOK_KEY } from './lastBook';
import {
  DEFAULT_PAUSE_MS,
  PAUSE_KEY,
  planChapter,
  planSelection,
  skippedLabel,
  usePrefetchAhead,
  useSkipOptions,
  WORD_HIGHLIGHT_KEY,
  type ChapterPlan,
} from './reading';
import {
  firstPosOnPages,
  highlightBySentence,
  indexBook,
  lastPage,
  pageWithSentence,
  posForSaved,
  sentenceAt,
  stepPos,
  type FlatSentence,
  type Pos,
} from './sentences';
import { pageBlocks, pageOrderChanged, saveReorderedPage } from './blockOrder';
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
const LINE_LABELS = ['Tight', 'Normal', 'Relaxed'];
const SAVE_POS_MS = 700;
const RATE_RESTART_MS = 350;
/** How long the floating exit control stays visible after entering or a tap. */
const IMMERSIVE_HINT_MS = 3000;
const FULLSCREEN_KEY = 'reader.fullscreen';

/**
 * A sentence without page rectangles. Module level on purpose: a fresh `[]` on
 * every render is a new prop identity, which would re-run the page overlay and
 * its scroll-follow effect while the voice is not even reading.
 */
const NO_PDF_RECTS: PdfRect[] = [];

/**
 * What the player calls the voice in her ear. Engine ids and class names mean
 * nothing to a reader, and "System voices · fallback" reads like an error she
 * has to fix before she can listen — so a fallback is simply the phone voice,
 * told apart by its dot and fixed (if she wants) in Settings.
 */
function engineName(info: EngineInfo | null): string {
  if (!info) return 'Resolving voice…';
  if (!info.preferred || info.engine.id === 'system') return 'Phone voice';
  if (info.engine.id === 'kokoro') return 'Kokoro';
  if (info.engine.id === 'pocket') return 'Pocket TTS';
  return 'Phone voice';
}

/**
 * The voice to ask the engine for. The phone-voice setting belongs to the system engine
 * alone: Kokoro and Pocket keep their own choice in their own setting, so handing them a
 * phone voice only made them fall back to their first voice — and keyed their cached
 * audio by a voice they were not speaking in.
 */
function engineVoiceId(info: EngineInfo, systemVoice: string): string | undefined {
  return info.engine.id === 'system' ? systemVoice || undefined : undefined;
}

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

/** A hand-picked passage being read: it stops at its end instead of continuing. */
interface SelectionPlay {
  /** Sentence ids in the order they were picked (already deduplicated). */
  ids: string[];
  chapterIndex: number;
  total: number;
  /** 1-based sentence inside the selection. */
  at: number;
  done: boolean;
}

export default function ReaderView() {
  const { bookId } = useParams<{ bookId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  // The library opens a book at /read/<id>?play=1 ("Continue listening").
  const wantsAutoPlay = searchParams.get('play') === '1';
  const autoPlayed = useRef(false);

  // Loaded once, not live: the record includes `parsed` (and the original
  // file), so a live query would re-read the whole book on every position save.
  const [book, setBook] = useState<BookRecord | null | undefined>(undefined);
  const [topicIds, setTopicIds] = useState<string[]>([]);

  const fontSize = useSetting<number>(FONT_KEY, DEFAULT_FONT);
  const lineHeight = useSetting<number>(LINE_KEY, 1.7); // DESIGN.md reading rhythm; 1.5 felt cramped in Literata
  const rate = useSetting<number>(RATE_KEY, 1);
  const voiceId = useSetting<string>(VOICE_KEY, '');
  const engineChoice = useSetting<string>(ENGINE_SETTING, 'auto');
  const skip = useSkipOptions();
  const wordHighlight = useSetting<boolean>(WORD_HIGHLIGHT_KEY, true);
  const pauseMs = useSetting<number>(PAUSE_KEY, DEFAULT_PAUSE_MS);
  const prefetchAhead = usePrefetchAhead();

  const [cursor, setCursor] = useState<Pos | null>(null);
  const [mode, setMode] = useState<'text' | 'page'>('text');
  const [pdfPage, setPdfPage] = useState(1);
  const [drawer, setDrawer] = useState<'none' | 'toc' | 'notes' | 'topics'>('none');
  const [typeOpen, setTypeOpen] = useState(false);
  const [selection, setSelection] = useState<Picked | null>(null);
  /** Non-null from "Play selection" until the passage ends or playback restarts. */
  const [selectionPlay, setSelectionPlay] = useState<SelectionPlay | null>(null);
  const [aiText, setAiText] = useState<string | null>(null);
  const [playState, setPlayState] = useState<PlayState>('idle');
  const [engineInfo, setEngineInfo] = useState<EngineInfo | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [cachedChapter, setCachedChapter] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** A start the browser refused; a tap on Play is the only way past it. */
  const [notice, setNotice] = useState<string | null>(null);
  /** Per-sentence generation state, straight from the player (F1). */
  const [itemStates, setItemStates] = useState<Map<string, ItemState>>(() => new Map());
  const [readyAhead, setReadyAhead] = useState(0);
  /** Spoken word inside the reading sentence, as an offset into its text (F3). */
  const [word, setWord] = useState<{ id: string; charIndex: number } | null>(null);
  /** The sentence that failed, so the banner can offer a retry. */
  const [failed, setFailed] = useState<{ id: string; message: string } | null>(null);
  /** False when the reader scrolled away from the cursor: Play starts at the top. */
  const [cursorOnScreen, setCursorOnScreen] = useState(true);
  /** Which screen of text is showing, for the page buttons label. */
  const [screen, setScreen] = useState({ at: 1, total: 1 });
  /** Full screen hides the reader's own chrome and asks Android to hide its bars. */
  const [fullscreen, setFullscreen] = useState(false);
  /** In full screen the bar, dock and chapter nav can be summoned by a tap. */
  const [chromeVisible, setChromeVisible] = useState(true);
  /** The floating exit control, shown for a moment after entering or a tap. */
  const [exitHint, setExitHint] = useState(false);

  const index = useMemo(() => (book ? indexBook(book.parsed) : null), [book?.parsed]);
  const highlightsFor = useLiveQuery(async () => (bookId ? listHighlights(bookId) : []), [bookId]);
  const highlights = useMemo(() => highlightBySentence(highlightsFor ?? []), [highlightsFor]);

  const playerRef = useRef<Player | null>(null);
  const generation = useRef(0);
  /**
   * The player sits on the sentence but was stopped by a refused start
   * (NotAllowedError), not by the reader: its own state is idle, so Play must
   * restart it with `play()` instead of `resume()`.
   */
  const resumeBlocked = useRef(false);
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
  const cursorOnScreenRef = useRef(cursorOnScreen);
  cursorOnScreenRef.current = cursorOnScreen;
  const playStateRef = useRef<PlayState>(playState);
  playStateRef.current = playState;
  const fullscreenRef = useRef(fullscreen);
  fullscreenRef.current = fullscreen;
  /** The saved choice is re-applied once per open, not on every render. */
  const fullscreenRestored = useRef(false);
  const hintTimer = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const restored = useRef(false);
  const lastSavedKey = useRef('');
  const pendingPos = useRef<{ bookId: string; pos: SavedPos } | null>(null);
  const rateTimer = useRef<number | null>(null);
  const sheetBody = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLElement>(null);
  // Latest skip/pause/word settings, for callbacks created once per player.
  const skipRef = useRef(skip);
  skipRef.current = skip;
  const pauseRef = useRef(pauseMs);
  pauseRef.current = pauseMs;
  const wordRef = useRef(wordHighlight);
  wordRef.current = wordHighlight;
  // The look-ahead size is read when a player is created, like rate/voice.
  const prefetchRef = useRef(prefetchAhead);
  prefetchRef.current = prefetchAhead;
  /** Plans are pure and cheap-ish; a chapter is planned once per settings change. */
  const planCache = useRef(new Map<string, ChapterPlan>());
  /** True while the page number came from the spoken sentence, not from a tap. */
  const pageFromCursor = useRef(false);
  /** The sleep timer's "End of chapter": stop instead of auto-advancing. */
  const sleepAtChapterEnd = useRef(false);

  const chapterIndex = cursor?.chapterIndex ?? 0;
  const chapter = book?.parsed.chapters[chapterIndex];
  const reading = index ? sentenceAt(index, cursor) : null;
  const readingId = reading?.id ?? null;

  const plan = useMemo(
    () => (chapter ? planChapter(chapter, skip, pauseMs) : null),
    [chapter, skip, pauseMs]
  );
  useEffect(() => {
    planCache.current.clear();
  }, [skip, pauseMs]);

  /** The first sentence printed on each PDF page, for page-button stepping. */
  const pages = useMemo(() => (index ? firstPosOnPages(index) : new Map<number, Pos>()), [index]);
  /**
   * The blocks printed on the page in view, in the order the document reads
   * them now: what page view shows, and what the reader can rearrange by hand.
   */
  const layoutBlocks = useMemo(() => (book ? pageBlocks(book.parsed, pdfPage) : []), [book, pdfPage]);
  const isPdf = book?.parsed.format === 'pdf';
  const pageOfCursor = reading?.pdfRects?.[0]?.page ?? pdfPage;

  function planFor(ci: number): ChapterPlan | null {
    const target = book?.parsed.chapters[ci];
    if (!target) return null;
    const cached = planCache.current.get(target.id);
    if (cached) return cached;
    const built = planChapter(target, skipRef.current, pauseRef.current);
    planCache.current.set(target.id, built);
    return built;
  }

  // -- position ------------------------------------------------------------

  /**
   * Hand the latest reading position back to the library (one write, not one
   * per sentence) and make sure the settings copy is on its way too. Both are
   * started here, synchronously: `pagehide` may never give a timer its turn.
   */
  function flushBookPos(): void {
    const pending = pendingPos.current;
    if (!pending) return;
    pendingPos.current = null;
    void setSetting(lastPosKey(pending.bookId), pending.pos).catch(() => {
      // A convenience only: never fail closing a book over it.
    });
    void db.books.update(pending.bookId, { lastPos: pending.pos }).catch(() => {
      // The position is a convenience; a failed write must never break reading.
    });
  }

  useEffect(() => {
    let alive = true;
    restored.current = false;
    fullscreenRestored.current = false;
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
        // The library's "Continue listening" button needs one cheap pointer to
        // the last book. Written here, after the position read has resolved, so
        // the write never races the restore (the read stays first and immediate).
        void setSetting(LAST_BOOK_KEY, { bookId: book.id, at: Date.now() }).catch(() => {
          // A convenience only: never fail opening a book over it.
        });
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
    const id = book.id;
    const pos: SavedPos = { chapterId, sentenceId: sentence.id };
    // Remember the move at once, not after the debounce: a reader who leaves
    // within SAVE_POS_MS must still come back to where they stopped, and the
    // unmount/pagehide flush reads this ref. This happens even for a sentence
    // settings already holds: the ref is what the close flush writes.
    pendingPos.current = { bookId: id, pos };
    if (lastSavedKey.current === key) return;
    const timer = window.setTimeout(() => {
      lastSavedKey.current = key;
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

  // -- full screen ---------------------------------------------------------

  /** Keep the floating exit control on screen for a moment. */
  function showExitHint(): void {
    if (!fullscreenRef.current) return;
    setExitHint(true);
    if (hintTimer.current !== null) window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => {
      hintTimer.current = null;
      setExitHint(false);
    }, IMMERSIVE_HINT_MS);
  }

  function exitFullscreen(): void {
    setFullscreen(false);
    void setSetting(FULLSCREEN_KEY, false).catch(() => {});
  }

  function toggleFullscreen(): void {
    if (fullscreenRef.current) {
      exitFullscreen();
      return;
    }
    setFullscreen(true);
    void setSetting(FULLSCREEN_KEY, true).catch(() => {});
  }

  // Re-enter the mode the reader left in, once per open. Applied after the book
  // loads (and after the first paint), so a browser that refuses the request
  // still shows the reader normally.
  useEffect(() => {
    if (!book || fullscreenRestored.current) return;
    fullscreenRestored.current = true;
    let alive = true;
    void getSetting<boolean>(FULLSCREEN_KEY, false)
      .catch(() => false)
      .then((on) => {
        if (alive && on) setFullscreen(true);
      });
    return () => {
      alive = false;
    };
  }, [book]);

  useEffect(() => {
    if (!fullscreen) {
      setChromeVisible(true);
      setExitHint(false);
      return;
    }
    // The platform bars go away with the reader's own: ask Android (or the
    // Fullscreen API on the web), and show the exit pill before the first tap.
    // setImmersive never throws, but a broken WebView must not break reading —
    // and a refusal must not leave the reader chrome-less with no way back, so
    // an explicit "no" puts the reader back to normal instead.
    void setImmersive(true).then((ok) => {
      if (ok === false) exitFullscreen();
    });
    setChromeVisible(false);
    showExitHint();
    return () => {
      if (hintTimer.current !== null) {
        window.clearTimeout(hintTimer.current);
        hintTimer.current = null;
      }
      // Leaving the reader or leaving full screen: give the bars back.
      void setImmersive(false).catch(() => {});
    };
    // showExitHint only reads refs and sets state; re-running on its identity
    // would re-request immersion on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullscreen]);

  // The browser can leave full screen on its own: Escape, a swipe from the screen
  // edge, the system handing the screen to another window. Follow it, or the reader
  // would stay chromeless with the toggle still lit and the mode still remembered.
  useEffect(() => {
    if (!fullscreen) return;
    function sync(): void {
      if (document.fullscreenElement) return;
      exitFullscreen();
    }
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
    // exitFullscreen only touches refs and state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullscreen]);

  // Back leaves full screen before it leaves the reader. A sheet that is open
  // still closes first: its handler is registered later, so it runs first.
  useEffect(() => {
    if (!fullscreen) return;
    return pushBackHandler(() => {
      if (aiText !== null || typeOpen || drawer !== 'none' || selection) return false;
      exitFullscreen();
      return true;
    });
    // exitFullscreen only touches refs and state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullscreen, aiText, typeOpen, drawer, selection]);

  /**
   * In full screen the bar, dock and chapter nav are gone; a tap on blank space
   * brings them back (a second tap puts them away). A tap on a sentence or a
   * control does what it always did.
   */
  function onImmersiveClick(event: ReactMouseEvent<HTMLElement>): void {
    if (!fullscreenRef.current) return;
    const target = event.target as HTMLElement;
    // Any tap re-surfaces the way out, even when it is a sentence tap.
    showExitHint();
    // Tapping the chrome or a sentence is not a request to toggle the chrome.
    if (
      target.closest(
        '.rd-s, button, a, input, label, select, textarea, .rd-sheet, .rd-select, .rd-bar, .rd-dock, .rd-chapter-nav'
      )
    ) {
      return;
    }
    setChromeVisible((visible) => !visible);
  }

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
        warmEngine(info.engine);
      })
      .catch(() => {
        // describeEngine already falls back to system; a throw here means no TTS.
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, engineChoice]);

  // Auto-turn the PDF page when the spoken sentence lives on another page. The
  // flag keeps the page callback from moving the cursor back to the page start.
  useEffect(() => {
    const first = reading?.pdfRects?.[0];
    if (first && mode === 'page') {
      pageFromCursor.current = true;
      setPdfPage(Math.max(1, first.page));
    }
  }, [readingId, mode]);

  // B2: is the cursor still on screen? After a long scroll it is not, and Play
  // should then start at the top of the viewport instead of somewhere above it.
  useEffect(() => {
    if (mode !== 'text' || !readingId) {
      setCursorOnScreen(true);
      return;
    }
    const check = () => {
      const node = document.querySelector<HTMLElement>(`[data-sid="${readingId}"]`);
      if (!node) {
        setCursorOnScreen(false);
        return;
      }
      const box = node.getBoundingClientRect();
      // The real dock height: a fixed 180 px guess hid the cursor in a 320 px landscape window.
      const dock = document.querySelector('.rd-dock');
      const playerH = dock ? dock.getBoundingClientRect().height : 180;
      setCursorOnScreen(box.bottom > 96 && box.top < window.innerHeight - Math.min(180, playerH + 40));
    };
    check();
    window.addEventListener('scroll', check, { passive: true });
    return () => window.removeEventListener('scroll', check);
  }, [readingId, mode, fontSize, lineHeight]);

  // Which screen of text is showing — the label between the page buttons.
  useEffect(() => {
    if (mode !== 'text') return;
    const measure = () => {
      const height = Math.max(1, window.innerHeight);
      const total = Math.max(1, Math.ceil(document.documentElement.scrollHeight / height));
      const at = Math.min(total, Math.round(window.scrollY / height) + 1);
      // Scrolling fires this on every frame; a new object would re-render the
      // whole reader (and the chapter) for a label that did not change.
      setScreen((prev) => (prev.at === at && prev.total === total ? prev : { at, total }));
    };
    measure();
    window.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, [mode, chapterIndex, plan]);

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
    resumeBlocked.current = false;
    setNotice(null);
    const player = playerRef.current;
    playerRef.current = null;
    player?.stop();
    setPlayState('idle');
    setItemStates(new Map());
    setReadyAhead(0);
    setWord(null);
    setSelectionPlay(null);
  }

  /** What pre-rendering should cache: the spoken form the player will ask for. */
  function prerenderItems(ci: number): { id: string; text: string }[] {
    const target = planFor(ci);
    if (!target) return [];
    return target.items.map((item) => ({ id: item.id, text: item.spoken ?? item.text }));
  }

  /**
   * The player wiring both playback modes share: engine, voice, rate, and every
   * callback. `mine` is the generation that created the player, so a released
   * one can never write into the screen. Callers add only what makes their mode
   * different: where the cursor follows, and what happens at the end.
   */
  function startPlayer(
    info: EngineInfo,
    items: ChapterPlan['items'],
    startIndex: number,
    mine: number,
    onSentence: (id: string) => void,
    onDone: () => void,
  ): Player {
    return createPlayer({
      engine: info.engine,
      items,
      startIndex,
      voiceId: engineVoiceId(info, voiceRef.current),
      rate: rateRef.current,
      prefetchAhead: prefetchRef.current,
      // Highlight off: no Whisper pass and no word clock behind a word nobody sees.
      wordHighlight: wordRef.current,
      // Fires only when this sentence's audio actually starts (B1).
      onSentence: (id) => {
        if (mine !== generation.current) return;
        setWord(null);
        onSentence(id);
      },
      onItemState: (id, state) => {
        if (mine !== generation.current) return;
        setItemStates((current) => {
          const next = new Map(current);
          next.set(id, state);
          return next;
        });
      },
      onBuffer: (count) => {
        if (mine !== generation.current) return;
        setReadyAhead(count);
      },
      onWord: (id, charIndex) => {
        if (mine !== generation.current || !wordRef.current) return;
        setWord({ id, charIndex });
      },
      onDone: () => {
        if (mine !== generation.current) return;
        onDone();
      },
      onError: (err, id) => {
        if (mine !== generation.current) return;
        // A browser that blocks a start outside a gesture ("Continue listening"
        // on the lock screen, a resumed audio session) is not an error to shout
        // about. Keep the player where it stopped — its queue, its clip and its
        // sentence — and let the next tap on Play (Resume) start it from there.
        if (/notallowederror|not allowed/i.test(err.message)) {
          resumeBlocked.current = true;
          setPlayState('paused');
          setNotice('Tap Play to continue');
          return;
        }
        setPlayState('idle');
        setError(err.message);
        if (id) setFailed({ id, message: err.message });
      },
    });
  }

  /**
   * Start speaking, synchronously. Called straight from the tap handler so the
   * element's first `play()` happens inside the user gesture; everything slow
   * (engine probe, voice list) has already been resolved.
   *
   * `at` is a sentence position in the chapter, but the queue only holds what
   * is read aloud (a skipped table leaves a hole), so it is mapped onto the
   * queue here.
   */
  function beginPlayback(info: EngineInfo, ci: number, at: number): void {
    if (!book || !index) return;
    releasePlayer();
    const mine = ++generation.current;

    // Skip empty chapters and chapters with nothing left to read (an import can
    // produce either) rather than stall on a silent player.
    let chapterIdx = ci;
    let startAt = at;
    let target: ChapterPlan | null = null;
    while (chapterIdx < index.chapters.length) {
      const candidate = planFor(chapterIdx);
      if (candidate && candidate.items.length > 0) {
        target = candidate;
        break;
      }
      chapterIdx += 1;
      startAt = 0;
    }
    if (!target) return;

    const sentences = index.chapters[chapterIdx] ?? [];
    let queueIndex = 0;
    for (let offset = 0; offset < Math.max(1, sentences.length); offset += 1) {
      const sentence = sentences[Math.min(startAt + offset, sentences.length - 1)];
      const found = sentence ? target.orderById.get(sentence.id) : undefined;
      if (found !== undefined) {
        queueIndex = found;
        break;
      }
    }

    setError(null);
    setFailed(null);
    setItemStates(new Map());
    setReadyAhead(0);
    setWord(null);

    const player = startPlayer(
      info,
      target.items,
      queueIndex,
      mine,
      (id) => {
        const pos = index.byId.get(id);
        if (pos) setCursor(pos);
      },
      () => {
        const nextInfo = engineRef.current ?? info;
        // The sleep timer's "End of chapter" stops here instead of carrying on
        // into the next chapter.
        if (chapterIdx + 1 < index.chapters.length && !sleepAtChapterEnd.current) {
          beginPlayback(nextInfo, chapterIdx + 1, 0);
          return;
        }
        setPlayState('idle');
      }
    );
    playerRef.current = player;
    setPlayState('playing');
    // Move the page to what is being spoken now, not when the first clip is
    // ready: auto-advance into the next chapter must show that chapter at once.
    const firstItem = target.items[queueIndex];
    const firstPos = firstItem ? index.byId.get(firstItem.id) : undefined;
    setCursor(firstPos ?? { chapterIndex: chapterIdx, index: startAt });
    player.play();
  }

  /** Async entry point for paths that are not a tap (or a tap before resolution). */
  async function startFrom(ci: number, at: number): Promise<void> {
    const mine = generation.current;
    const info = await engineForPlay();
    if (mine !== generation.current) return;
    beginPlayback(info, ci, at);
  }

  /**
   * Speak only the picked sentences, in the order they were picked, and stop at
   * the end instead of continuing through the chapter. A selection is an
   * explicit request, so it wins over the skip switches: a sentence from a
   * skipped table is read here too.
   */
  function beginSelectionPlayback(info: EngineInfo, ids: string[], ci: number): void {
    if (!book || !index) return;
    const target = book.parsed.chapters[ci];
    if (!target) return;
    const items = planSelection(target, ids, skipRef.current, pauseRef.current);
    if (items.length === 0) return;

    releasePlayer();
    const mine = ++generation.current;
    const positions = new Map(items.map((item, position) => [item.id, position]));

    setError(null);
    setFailed(null);
    setItemStates(new Map());
    setReadyAhead(0);
    setWord(null);

    const player = startPlayer(
      info,
      items,
      0,
      mine,
      (id) => {
        const pos = index.byId.get(id);
        if (pos) setCursor(pos);
        const at = positions.get(id);
        if (at === undefined) return;
        setSelectionPlay((current) => (current ? { ...current, at: at + 1 } : current));
      },
      () => {
        // The end of the passage, not the end of the chapter: stay put and offer
        // the two ways on.
        setPlayState('idle');
        setWord(null);
        setSelectionPlay((current) => (current ? { ...current, at: current.total, done: true } : current));
      }
    );
    playerRef.current = player;
    setPlayState('playing');
    setSelectionPlay({ ids: [...ids], chapterIndex: ci, total: items.length, at: 1, done: false });
    const firstPos = index.byId.get(items[0]!.id);
    if (firstPos) setCursor(firstPos);
    player.play();
  }

  /** Play picked sentences now if the engine is resolved, else once it is. */
  function startSelection(ids: string[], ci: number): void {
    const info = engineRef.current;
    if (info) {
      beginSelectionPlayback(info, ids, ci);
      return;
    }
    const mine = generation.current;
    void engineForPlay().then((loaded) => {
      if (mine !== generation.current) return;
      beginSelectionPlayback(loaded, ids, ci);
    });
  }

  function playSelection(): void {
    if (!selection || !index) return;
    const ids = selection.ids.filter((id) => index.byId.has(id));
    const first = ids[0] !== undefined ? index.byId.get(ids[0]) : undefined;
    if (!first || ids.length === 0) return;
    clearSelection();
    startSelection(ids, first.chapterIndex);
  }

  /** After a selection finishes: carry on in the chapter from the next sentence. */
  function continueAfterSelection(): void {
    const picked = selectionPlay;
    if (!picked) return;
    const lastId = picked.ids[picked.ids.length - 1];
    const last = lastId && index ? index.byId.get(lastId) : undefined;
    const next = last ? (neighbour(last, 1) ?? last) : cursorRef.current;
    setSelectionPlay(null);
    if (!next) return;
    const info = engineRef.current;
    if (info) beginPlayback(info, next.chapterIndex, next.index);
    else void startFrom(next.chapterIndex, next.index);
  }

  function replaySelection(): void {
    const picked = selectionPlay;
    if (!picked) return;
    startSelection(picked.ids, picked.chapterIndex);
  }

  function pauseOnly(): void {
    if (playStateRef.current !== 'playing') return;
    playerRef.current?.pause();
    setPlayState('paused');
  }

  /** The first sentence whose box is still below the sticky bar. */
  function firstVisibleSentence(): Pos | null {
    if (!index) return null;
    for (const node of document.querySelectorAll<HTMLElement>('.rd-s[data-sid]')) {
      if (node.getBoundingClientRect().bottom < 96) continue;
      const id = node.dataset.sid;
      const pos = id ? index.byId.get(id) : undefined;
      if (pos) return pos;
    }
    return null;
  }

  /** Move the cursor there — and the player too, when it is already speaking. */
  function goToPos(pos: Pos): void {
    if (playStateRef.current === 'playing') {
      const info = engineRef.current;
      if (info) beginPlayback(info, pos.chapterIndex, pos.index);
      else void startFrom(pos.chapterIndex, pos.index);
      return;
    }
    if (playStateRef.current === 'paused') releasePlayer();
    setCursor(pos);
  }

  function startOrResume(): void {
    const pos = cursorRef.current;
    if (!pos) return;
    if (playStateRef.current === 'playing') return;
    if (playStateRef.current === 'paused' && playerRef.current) {
      if (resumeBlocked.current) {
        // The player is idle on the sentence it was refused on; play() restarts
        // it there, inside this tap, which is exactly what the browser wanted.
        resumeBlocked.current = false;
        playerRef.current.play();
      } else {
        playerRef.current.resume();
      }
      setNotice(null);
      setPlayState('playing');
      return;
    }
    // B2: after scrolling away from the cursor, Play starts at the top of what
    // is on screen rather than at a sentence she can no longer see.
    const fromTop = mode === 'text' && !cursorOnScreenRef.current ? firstVisibleSentence() : null;
    const start = fromTop ?? pos;
    const info = engineRef.current;
    if (info) beginPlayback(info, start.chapterIndex, start.index);
    else void startFrom(start.chapterIndex, start.index);
  }

  /** The small "Play from here" pill: always the visible top of the text. */
  function playFromHere(): void {
    const start = firstVisibleSentence() ?? cursorRef.current;
    if (!start) return;
    const info = engineRef.current;
    if (info) beginPlayback(info, start.chapterIndex, start.index);
    else void startFrom(start.chapterIndex, start.index);
  }

  /** Retry the sentence whose generation failed, from that sentence. */
  function retryFailed(): void {
    if (!index || !failed) return;
    const pos = index.byId.get(failed.id);
    if (!pos) return;
    setFailed(null);
    setError(null);
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

  /** Next sentence that is actually read aloud: skipped blocks are stepped over. */
  function neighbour(pos: Pos, delta: 1 | -1): Pos | null {
    if (!index) return null;
    let at = pos;
    const plans = new Map<number, ChapterPlan | null>();
    for (let guard = 0; guard < 200; guard += 1) {
      const next = stepPos(index, at, delta);
      if (!next) return null;
      const sentence = sentenceAt(index, next);
      if (!sentence) return null;
      if (!plans.has(next.chapterIndex)) plans.set(next.chapterIndex, planFor(next.chapterIndex));
      if (plans.get(next.chapterIndex)?.orderById.has(sentence.id)) return next;
      at = next;
    }
    return null;
  }

  function step(delta: 1 | -1): void {
    if (!index || !cursor) return;
    const target = neighbour(cursor, delta);
    if (!target) return;
    // The notification's Next/Previous while paused steps the marker and keeps
    // the paused state — and so the notification — instead of dropping to idle.
    // The paused player belongs to the old sentence, so it goes; Play then
    // starts at the neighbour.
    if (playStateRef.current === 'paused') {
      generation.current += 1;
      playerRef.current?.stop();
      playerRef.current = null;
      setItemStates(new Map());
      setReadyAhead(0);
      setWord(null);
      setSelectionPlay(null);
      setCursor(target);
      return;
    }
    goToPos(target);
  }

  /** A page whose first sentence was skipped borrows the nearest one. */
  function pageStartNear(page: number): Pos | null {
    const forward = pageWithSentence(pages, page - 1, 1);
    const backward = pageWithSentence(pages, page, -1);
    const chosen =
      forward !== null && (backward === null || forward - page <= page - backward) ? forward : backward;
    return chosen === null ? null : pages.get(chosen) ?? null;
  }

  /** Jump to the first readable sentence of a PDF page, playing stays playing. */
  function goToPage(page: number): void {
    if (!index || page < 1) return;
    setPdfPage(page);
    const pos = pages.get(page) ?? pageStartNear(page);
    if (pos) goToPos(pos);
  }

  /**
   * Store a new reading order for the page in view.
   *
   * `books.parsed` is the one copy the page, the player and the page numbers
   * read, so the document the saver hands back goes straight into the loaded
   * book — a stale copy would show, and play, the old order again. Sentences
   * only move between block slots: their ids stay, so the cursor follows its own
   * id and the reader stays on the words they were reading.
   */
  async function savePageOrder(ids: string[]): Promise<void> {
    if (!book) return;
    const parsed = await saveReorderedPage(book.id, pdfPage, ids);
    if (!parsed) throw new Error('This book is no longer in the library.');
    setBook((previous) => (previous ? { ...previous, parsed } : previous));
    const moved = readingId ? indexBook(parsed).byId.get(readingId) : undefined;
    if (moved) setCursor(moved);
    // Plans are built per chapter and cached: the cached one would spell out the
    // old order for the rest of this chapter.
    planCache.current.clear();
    // A player that is already running holds the old queue, so it would go on
    // reading the sentences in the order just corrected. Stop it instead (as a
    // page turn does): Play then starts again from the cursor, from a plan built
    // out of this document. Only when the page's order really moved — a Save
    // that leaves it as it was must not interrupt what is playing.
    if (pageOrderChanged(book.parsed, parsed, pdfPage) && playStateRef.current !== 'idle') releasePlayer();
  }

  /**
   * B3: one page (PDF) or one screen (text) at a time. In text view the cursor
   * and any playback move to the first sentence of the new screen.
   */
  function turnPage(direction: 1 | -1): void {
    if (!index || !book) return;
    if (book.parsed.format === 'pdf') {
      const target = pageWithSentence(pages, pageOfCursor, direction);
      if (target !== null) goToPage(target);
      return;
    }
    const nodes = document.querySelectorAll<HTMLElement>('.rd-s[data-sid]');
    const goal = window.scrollY + direction * window.innerHeight * 0.85 + 96;
    let pos: Pos | null = null;
    for (const node of nodes) {
      const top = node.getBoundingClientRect().top + window.scrollY;
      if (top < goal) continue;
      const id = node.dataset.sid;
      pos = id ? index.byId.get(id) ?? null : null;
      if (pos) break;
    }
    if (!pos) return;
    window.scrollTo?.({ top: Math.max(0, goal - 96), behavior: 'smooth' });
    goToPos(pos);
  }

  function goToChapter(ci: number): void {
    if (!index || ci < 0 || ci >= index.chapters.length) return;
    if (playStateRef.current !== 'idle') releasePlayer();
    setSelectionPlay(null);
    // A chapter jump is not a change of mind about the picked sentences: the
    // selection bar belongs to the chapter it was made in.
    clearSelection();
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

  async function preRender(): Promise<void> {
    if (!index || !cursor) return;
    const items = prerenderItems(cursor.chapterIndex);
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
        { voiceId: engineVoiceId(info, voiceRef.current), rate: rateRef.current, signal: controller.signal },
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

  // The action sheet covers the lower half of the page, so a selection that
  // grows downwards must bring its newest sentence back into view.
  useEffect(() => {
    const last = selection?.ids[selection.ids.length - 1];
    const page = pageRef.current;
    if (!last || !page) return;
    const el = page.querySelector<HTMLElement>(`[data-sid="${CSS.escape(last)}"]`);
    if (!el) return;
    const sheetTop = page.querySelector<HTMLElement>('.rd-select')?.getBoundingClientRect().top;
    const limit = (sheetTop ?? window.innerHeight - 320) - 16;
    const rect = el.getBoundingClientRect();
    const delta = rect.bottom > limit ? rect.bottom - limit : rect.top < 96 ? rect.top - 96 : 0;
    if (delta !== 0) {
      try {
        window.scrollBy({ top: delta, behavior: 'smooth' });
      } catch {
        window.scrollTo(0, window.scrollY + delta);
      }
    }
  }, [selection]);

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
      // One row per sentence range: noting, recolouring or carding a sentence
      // that already has a highlight must change it, not duplicate it.
      const existing = findRangeHighlight(highlightsFor ?? [], selection.ids);
      if (existing) {
        const patch = rangeHighlightPatch(existing, color, note);
        if (Object.keys(patch).length > 0) await updateHighlight(existing.id, patch);
        clearSelection();
        return { ...existing, ...patch };
      }
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
    setSelectionPlay(null);
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

  // -- native media service (Android foreground service) --------------------

  // While playing, the service keeps synthesis alive with the screen locked and
  // puts the book and chapter on the notification and lock screen. It is
  // refreshed when the chapter changes mid-playback (auto-advance, a chapter
  // tap). Outside the Android app every call is a resolved no-op.
  useEffect(() => {
    if (playState === 'playing') {
      void nativePlayback.start({ title: book?.title ?? 'PharmaReader', subtitle: chapter?.title });
      return;
    }
    if (playState === 'paused') {
      void nativePlayback.setState('paused');
      return;
    }
    void nativePlayback.stop();
  }, [playState, book?.title, chapter?.title]);

  // One subscription for the notification, lock screen and headset buttons,
  // mapped onto the same actions the browser's mediaSession uses.
  useEffect(
    () =>
      nativePlayback.onAction((action) => {
        if (action === 'play') actions.current.play();
        else if (action === 'pause') actions.current.pause();
        else if (action === 'next') actions.current.step(1);
        else if (action === 'previous') actions.current.step(-1);
        else actions.current.stop();
      }),
    []
  );

  // "Continue listening": the library opens the book with ?play=1. Wait until
  // the saved position is restored and the engine is resolved, start once, and
  // drop the parameter so a reload does not start talking on its own.
  useEffect(() => {
    if (!wantsAutoPlay || autoPlayed.current) return;
    if (!book || !index || !cursor || !engineInfo) return;
    autoPlayed.current = true;
    setSearchParams({}, { replace: true });
    beginPlayback(engineInfo, cursor.chapterIndex, cursor.index);
    // beginPlayback only touches refs and state setters; re-running it on its
    // own identity would restart playback on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsAutoPlay, book, index, cursor, engineInfo, setSearchParams]);

  // The Android back key unwinds this screen one layer at a time: the AI sheet,
  // the type sheet, the drawer, then the selection. Only when nothing is open
  // does the press fall through to the library (the bridge in App.tsx).
  useEffect(() => {
    if (aiText === null && !typeOpen && drawer === 'none' && !selection) return;
    return pushBackHandler(() => {
      if (aiText !== null) {
        setAiText(null);
        return true;
      }
      if (typeOpen) {
        setTypeOpen(false);
        return true;
      }
      if (drawer !== 'none') {
        setDrawer('none');
        return true;
      }
      if (selection) {
        setSelection(null);
        return true;
      }
      return false;
    });
  }, [aiText, typeOpen, drawer, selection]);

  // -- sheets: Escape + focus ----------------------------------------------

  useEffect(() => {
    const open = drawer !== 'none' || typeOpen || aiText !== null;
    if (!open) return;
    sheetBody.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (aiText !== null) setAiText(null);
      else if (typeOpen) setTypeOpen(false);
      else setDrawer('none');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer, typeOpen, aiText]);

  // -- unmount / app hidden ------------------------------------------------

  useEffect(() => {
    const flush = () => flushBookPos();
    // Going away writes the heavy `books.lastPos`; coming back must not: the position
    // has not moved, and the record carries the whole file blob.
    const flushIfHidden = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', flushIfHidden);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', flushIfHidden);
      flushBookPos();
      if (rateTimer.current !== null) window.clearTimeout(rateTimer.current);
      generation.current += 1;
      abortRef.current?.abort();
      playerRef.current?.stop();
      playerRef.current = null;
      // Nothing is playing after the reader closes: take the notification and
      // the foreground service down with it.
      void nativePlayback.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The player decides how much room the page needs to reserve at the bottom:
  // its caption row grows a status line and the "Play from here" pill comes and
  // goes, so a fixed 120 px would let the last line of a chapter slide behind it.
  useEffect(() => {
    const page = pageRef.current;
    const dock = document.querySelector<HTMLElement>('.rd-dock');
    if (!page || !dock) return;
    const apply = () => {
      page.style.setProperty('--rd-player-h', `${Math.ceil(dock.getBoundingClientRect().height)}px`);
    };
    apply();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(apply);
    observer.observe(dock);
    return () => observer.disconnect();
  }, [playState, cursorOnScreen, mode, book]);

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
        <Link to="/" className="btn btn-secondary">
          Back to library
        </Link>
      </section>
    );
  }

  const showPage = isPdf && mode === 'page';
  // Full screen starts clean (no bar, dock or chapter nav) until the reader asks
  // for them with a tap on blank space.
  const showChrome = !fullscreen || chromeVisible;
  // The floating way out is for the chromeless screen only: once the bar is back it
  // has its own exit button, and two on top of each other would put the text-size
  // button next to it out of reach.
  const pillShown = fullscreen && exitHint && !chromeVisible;

  // F1: which sentence is being synthesized right now (and its chapter number).
  // Plain computation, not a hook: this sits below the loading return.
  let generatingId: string | null = null;
  if (playerRef.current) {
    for (const item of plan?.items ?? []) {
      if (itemStates.get(item.id) === 'generating') {
        generatingId = item.id;
        break;
      }
    }
  }
  const generatingNumber = generatingId ? (index.byId.get(generatingId)?.index ?? 0) + 1 : null;

  const skippedLabels = new Map<string, string>();
  if (plan) for (const id of plan.skippedBlocks) skippedLabels.set(id, skippedLabel(plan.blockKinds.get(id) ?? 'p'));

  const pageNav: PageNav | null = isPdf
    ? {
        label: `Page ${pageOfCursor} of ${lastPage(index)}`,
        onPrev: () => turnPage(-1),
        onNext: () => turnPage(1),
      }
    : { label: `${screen.at} / ${screen.total}`, onPrev: () => turnPage(-1), onNext: () => turnPage(1) };

  return (
    <section
      className={`page rd-page${showPage ? ' rd-page--page' : ''}${fullscreen ? ' rd-page--fullscreen' : ''}`}
      ref={pageRef}
      onClick={onImmersiveClick}
    >
      {showChrome ? (
        <header className="rd-bar">
          <Link to="/" className="rd-bar-btn" aria-label="Back to library">
            <Glyph>{icons.back}</Glyph>
          </Link>
          <h1 className="rd-bar-title" title={book.title}>
            {book.title}
          </h1>
          {isPdf ? (
            <div className="rd-seg" role="group" aria-label="View mode">
              <button
                type="button"
                className="rd-seg-btn"
                aria-pressed={!showPage}
                onClick={() => setMode('text')}
              >
                Text
              </button>
              <button type="button" className="rd-seg-btn" aria-pressed={showPage} onClick={() => setMode('page')}>
                Page
              </button>
            </div>
          ) : null}
          <button
            type="button"
            className="rd-bar-btn"
            aria-label="Contents"
            aria-expanded={drawer !== 'none'}
            onClick={() => {
              setTypeOpen(false);
              setDrawer(drawer === 'none' ? 'toc' : 'none');
            }}
          >
            <Glyph>{icons.chapters}</Glyph>
          </button>
          <button
            type="button"
            className="rd-bar-text"
            aria-label="Text size and spacing"
            aria-expanded={typeOpen}
            onClick={() => {
              setDrawer('none');
              setTypeOpen(!typeOpen);
            }}
          >
            Aa
          </button>
          <button
            type="button"
            className="rd-bar-btn"
            aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
            aria-pressed={fullscreen}
            onClick={toggleFullscreen}
          >
            <Glyph>{icons.fit}</Glyph>
          </button>
        </header>
      ) : null}

      <ModelStatusBanner context="reader" />

      {error ? (
        <div className="banner banner-error rd-error" role="alert">
          <Glyph>{icons.alert}</Glyph>
          <div>
            <p>{error}</p>
          </div>
          {failed && index.byId.has(failed.id) ? (
            <button type="button" className="btn btn-ghost" onClick={retryFailed}>
              Try again
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-ghost rd-error-dismiss"
            onClick={() => {
              setError(null);
              setFailed(null);
            }}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {notice ? (
        <div className="banner banner-info rd-notice" role="status">
          <Glyph>{icons.alert}</Glyph>
          <div>
            <p>{notice}</p>
          </div>
          <button
            type="button"
            className="btn btn-ghost rd-error-dismiss"
            onClick={() => setNotice(null)}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {showPage ? (
        <Suspense fallback={<p className="muted">Loading page…</p>}>
          <PdfView
            docKey={book.id}
            file={book.fileBlob}
            page={pdfPage}
            rects={reading?.pdfRects ?? NO_PDF_RECTS}
            fullscreen={fullscreen}
            layoutBlocks={layoutBlocks}
            onSaveOrder={savePageOrder}
            onPageChange={(page) => {
              const next = Math.max(1, page);
              setPdfPage(next);
              // The page turned because the voice moved on: keep the cursor.
              if (pageFromCursor.current) {
                pageFromCursor.current = false;
                return;
              }
              goToPage(next);
            }}
          />
        </Suspense>
      ) : chapter ? (
        <ReflowView
          key={chapter.id}
          chapter={chapter}
          eyebrow={`Chapter ${chapterIndex + 1} of ${index.chapters.length}`}
          sentences={index.chapters[chapterIndex] ?? []}
          readingId={readingId}
          highlights={highlights}
          selected={selection?.ids ?? []}
          fontSize={fontSize}
          lineHeight={lineHeight}
          skipped={plan?.skippedBlocks}
          skippedLabels={skippedLabels}
          generatingId={generatingId}
          wordChar={wordHighlight ? word : null}
          wordHighlight={wordHighlight}
          onTap={(sentence: FlatSentence) => {
            setSelection(null);
            setSelectionPlay(null);
            const playable = !plan || plan.orderById.has(sentence.id);
            if (playStateRef.current === 'playing' && playable) {
              const info = engineRef.current;
              if (info) beginPlayback(info, sentence.chapterIndex, sentence.index);
              else void startFrom(sentence.chapterIndex, sentence.index);
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

      {showChrome ? (
        <nav className="rd-chapter-nav" aria-label="Chapter navigation">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={chapterIndex <= 0}
            onClick={() => goToChapter(chapterIndex - 1)}
          >
            <Glyph>{icons.back}</Glyph>
            <span>Previous chapter</span>
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={chapterIndex >= index.chapters.length - 1}
            onClick={() => goToChapter(chapterIndex + 1)}
          >
            <span>Next chapter</span>
            <Glyph>{icons.forward}</Glyph>
          </button>
        </nav>
      ) : null}

      {showChrome ? (
        <PlayerBar
          state={playState}
          engineName={engineName(engineInfo)}
          fallback={Boolean(engineInfo && !engineInfo.preferred && engineChoice !== 'auto')} // auto on the phone voice is expected, not a failure
          rate={rate}
          canPrerender={Boolean(engineInfo?.engine.capabilities.prerender)}
          progress={progress}
          cached={Boolean(cachedChapter && cachedChapter === chapter?.id)}
          sentenceNumber={reading ? reading.index + 1 : 0}
          sentenceTotal={index.chapters[chapterIndex]?.length ?? 0}
          generating={generatingNumber}
          readyAhead={readyAhead}
          pages={showPage ? null : pageNav}
          fromHere={mode === 'text' && !cursorOnScreen && playState !== 'playing'}
          selection={
            selectionPlay
              ? {
                  at: selectionPlay.at,
                  total: selectionPlay.total,
                  done: selectionPlay.done,
                  onContinue: continueAfterSelection,
                  onReplay: replaySelection,
                }
              : null
          }
          onToggle={togglePlay}
          onStop={stopPlayback}
          onPrev={() => step(-1)}
          onNext={() => step(1)}
          onRate={changeRate}
          onPrerender={() => void preRender()}
          onCancelPrerender={() => abortRef.current?.abort()}
          onPlayFromHere={playFromHere}
          onSleepEnd={pauseOnly}
          onSleepAtChapterEndChange={(atEnd) => {
            sleepAtChapterEnd.current = atEnd;
          }}
        />
      ) : null}

      {/* The way out stays reachable even while the bars are hidden: it fades
          but keeps its place in the tab order (focus brings it back). Top
          corner, so it never sits on the page controls at the bottom. */}
      {fullscreen ? (
        <button
          type="button"
          className={`btn btn-primary rd-immersive-exit${pillShown ? ' is-shown' : ''}`}
          aria-label="Exit full screen"
          title="Exit full screen"
          onClick={exitFullscreen}
        >
          <Glyph>{icons.close}</Glyph>
          <span>Exit</span>
        </button>
      ) : null}

      {selection ? (
        <SelectionBar
          text={selection.text}
          count={selection.ids.length}
          onPlay={playSelection}
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
          <div className="rd-sheet-body sheet" ref={sheetBody} tabIndex={-1}>
            <AiActions
              text={aiText}
              bookId={book.id}
              topicIds={topicIds}
              onClose={() => setAiText(null)}
            />
          </div>
        </div>
      ) : null}

      {typeOpen ? (
        <div
          className="rd-sheet"
          role="dialog"
          aria-modal="true"
          aria-label="Text size and spacing"
          onClick={(event) => {
            if (event.target === event.currentTarget) setTypeOpen(false);
          }}
        >
          <div className="rd-sheet-body sheet rd-type" ref={sheetBody} tabIndex={-1}>
            <div className="rd-type-row">
              <span className="field-label" id="rd-size-label">
                Text size
              </span>
              <div className="rd-stepper" role="group" aria-labelledby="rd-size-label">
                <button
                  type="button"
                  className="rd-icon-btn"
                  aria-label="Smaller text"
                  disabled={fontSize <= FONT_MIN}
                  onClick={() => changeFont(-1)}
                >
                  <Glyph>{icons.textSmall}</Glyph>
                </button>
                <output className="rd-type-value">{Math.round(fontSize)}px</output>
                <button
                  type="button"
                  className="rd-icon-btn"
                  aria-label="Larger text"
                  disabled={fontSize >= FONT_MAX}
                  onClick={() => changeFont(1)}
                >
                  <Glyph>{icons.textLarge}</Glyph>
                </button>
              </div>
            </div>

            <div className="rd-type-row">
              <span className="field-label" id="rd-spacing-label">
                Line spacing
              </span>
              <div className="rd-seg rd-seg-wide" role="group" aria-labelledby="rd-spacing-label">
                {LINE_HEIGHTS.map((value, i) => (
                  <button
                    key={value}
                    type="button"
                    className="rd-seg-btn"
                    aria-pressed={Math.abs(lineHeight - value) < 0.01}
                    onClick={() => void setSetting(LINE_KEY, value)}
                  >
                    {LINE_LABELS[i]}
                  </button>
                ))}
              </div>
            </div>

            <button type="button" className="btn btn-primary btn-block" onClick={() => setTypeOpen(false)}>
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
          aria-label="Chapters, notes and topics"
          onClick={(event) => {
            if (event.target === event.currentTarget) setDrawer('none');
          }}
        >
          <div className="rd-sheet-body sheet" ref={sheetBody} tabIndex={-1}>
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
              <button
                type="button"
                role="tab"
                aria-selected={drawer === 'topics'}
                className={drawer === 'topics' ? 'rd-tab active' : 'rd-tab'}
                onClick={() => setDrawer('topics')}
              >
                Topics{topicIds.length ? ` (${topicIds.length})` : ''}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-icon rd-tab-close"
                aria-label="Close"
                onClick={() => setDrawer('none')}
              >
                <Glyph>{icons.close}</Glyph>
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
            ) : drawer === 'notes' ? (
              <HighlightList bookId={book.id} onJump={jumpTo} />
            ) : (
              <>
                <TopicPicker
                  label="Topics for this book"
                  value={topicIds}
                  onChange={(ids) => {
                    setTopicIds(ids);
                    void db.books.update(book.id, { topicIds: ids });
                  }}
                />
                <button type="button" className="btn btn-primary btn-block" onClick={() => setDrawer('none')}>
                  Done
                </button>
              </>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
