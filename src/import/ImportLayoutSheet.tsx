/**
 * The question a PDF import opens with: a textbook whose columns, tables and
 * boxes need the layout model, or a simple book that reads fine as text?
 *
 * It is a bottom sheet like the library's other sheets, and it owns the one
 * thing that has to happen before a textbook is parsed: downloading the model,
 * with progress, when it is not on the device yet. A failed download never
 * blocks the import — the answer still comes back, with the reason attached for
 * the library's warning banner.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { pushBackHandler } from '../core/backButton';
import { LAYOUT_MODEL, downloadLayoutModel } from './layout/model';

const SIZE_MB = Math.round(LAYOUT_MODEL.bytes / (1024 * 1024));

export interface ImportLayoutSheetProps {
  /** How many picked PDFs the answer applies to. */
  count: number;
  /** Whether the model is already on this device. */
  modelReady: boolean;
  /**
   * The reader's answer. `note` is set when a textbook download failed: the
   * import goes ahead with the text layout and the library shows the reason.
   */
  onAnswer(choice: 'textbook' | 'simple', remember: boolean, note?: string): void;
  /** The sheet was dismissed: nothing is imported. */
  onCancel(): void;
}

export default function ImportLayoutSheet({ count, modelReady, onAnswer, onCancel }: ImportLayoutSheetProps) {
  const titleId = useId();
  const descId = useId();
  const sheetRef = useRef<HTMLDivElement>(null);
  const textbookRef = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  const [remember, setRemember] = useState(false);
  /** Null until a textbook download starts; then it is the fraction received. */
  const [progress, setProgress] = useState<number | null>(null);

  const busy = progress !== null;
  const closeRef = useRef<() => void>(() => undefined);
  closeRef.current = () => {
    if (!busy) onCancel();
  };
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    alive.current = true;
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    textbookRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      // Tab wraps inside the sheet instead of walking into the Library behind it.
      if (event.key !== 'Tab') return;
      const sheet = sheetRef.current;
      if (!sheet) return;
      const focusable = [
        ...sheet.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)'),
      ];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const current = document.activeElement;
      if (event.shiftKey && (current === first || !sheet.contains(current))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || !sheet.contains(current))) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    // Android back closes the question instead of leaving the Library under it.
    const dispose = pushBackHandler(() => {
      closeRef.current();
      return true;
    });

    return () => {
      alive.current = false;
      document.removeEventListener('keydown', onKeyDown);
      dispose();
      if (returnTo && document.contains(returnTo)) returnTo.focus();
    };
  }, []);

  async function choose(choice: 'textbook' | 'simple'): Promise<void> {
    if (busy) return;

    if (choice === 'textbook' && !modelReady) {
      setProgress(0);
      try {
        await downloadLayoutModel((fraction) => {
          if (alive.current) setProgress(fraction);
        });
      } catch (error) {
        if (!alive.current) return;
        onAnswer(
          'textbook',
          remember,
          `The layout model could not be downloaded, so the text layout was used instead. ${messageOf(error)}`,
        );
        return;
      }
      if (!alive.current) return;
    }

    onAnswer(choice, remember);
  }

  return (
    <>
      <div className="sheet-backdrop" onClick={() => closeRef.current()} />
      <div
        ref={sheetRef}
        className="sheet import-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
      >
        <h2 id={titleId} className="sheet-title lib-sheet-title">
          {count === 1 ? 'What kind of PDF is this?' : 'What kind of PDFs are these?'}
        </h2>
        <p className="muted import-sheet-lead" id={descId}>
          {count === 1
            ? 'PharmaReader can read the page layout before it reads the text.'
            : `The same answer is used for all ${count} PDFs you picked.`}
        </p>

        <div className="import-choices">
          <button
            ref={textbookRef}
            type="button"
            className="import-choice import-choice-primary"
            onClick={() => void choose('textbook')}
            disabled={busy}
          >
            <span className="import-choice-head">
              <span className="import-choice-title">Textbook or complex pages</span>
              <span className="import-choice-badge">Recommended</span>
            </span>
            <span className="import-choice-note">
              Two columns, tables, figures and boxes. Layout detection reads them in the right order.
            </span>
          </button>

          <button
            type="button"
            className="import-choice"
            onClick={() => void choose('simple')}
            disabled={busy}
          >
            <span className="import-choice-head">
              <span className="import-choice-title">Simple book</span>
            </span>
            <span className="import-choice-note">
              One column of running text, like a novel. Skips detection, so the import is faster; you can run it
              later in Settings → PDF layout.
            </span>
          </button>
        </div>

        {!modelReady && !busy && (
          <p className="field-hint import-sheet-model">
            Layout detection uses {LAYOUT_MODEL.label}, about {SIZE_MB} MB. It downloads once, then works offline.
          </p>
        )}

        {busy && (
          <div className="import-sheet-progress">
            <div className="progress" aria-hidden="true">
              <span style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
            </div>
            <p className="import-sheet-status" role="status" aria-live="polite">
              Downloading the layout model — {Math.round((progress ?? 0) * SIZE_MB)} of {SIZE_MB} MB…
            </p>
          </div>
        )}

        <label className="import-remember">
          <input
            type="checkbox"
            checked={remember}
            disabled={busy}
            onChange={(event) => setRemember(event.target.checked)}
          />
          <span className="import-remember-text">
            <span className="import-remember-label">Don’t ask again</span>
            <span className="field-hint">Your answer is remembered. Change it in Settings → PDF layout.</span>
          </span>
        </label>

        <div className="sheet-actions">
          <button type="button" className="btn btn-ghost" onClick={() => closeRef.current()} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </>
  );
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim();
}
