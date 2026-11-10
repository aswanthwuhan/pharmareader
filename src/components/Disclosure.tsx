/**
 * One press-to-show row of the Settings index.
 *
 * The heading contains the button (the standard accordion pattern), so the row
 * stays a real heading in the document outline while the whole row is the tap
 * target. The body is never unmounted: when the row is closed it keeps the
 * `hidden` attribute instead. A model download or a running timer inside a
 * closed row must keep going, and a closed panel's state must survive.
 *
 * The second level of press-to-show, inside a panel, is native
 * `<details class="disc-sub">` — see the shared styles in `src/styles.css`.
 * Native `<details name>` is not used here: the minimum Android WebView is 110
 * and only groups `<details>` from 120 onward.
 */
import type { ReactNode } from 'react';

export interface DisclosureProps {
  id: string;
  title: string;
  /** One cheap, live value shown under the title, e.g. "Kokoro · 1.0×". */
  summary?: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}

export default function Disclosure({ id, title, summary, open, onToggle, children }: DisclosureProps) {
  const headingId = `${id}-h2`;
  const bodyId = `${id}-body`;

  return (
    <section id={id} className="disc" aria-labelledby={headingId}>
      <h2 id={headingId} className="settings-h2 disc-h">
        <button
          type="button"
          className="disc-head"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          <span className="disc-text">
            <span className="disc-title">{title}</span>
            {summary ? <span className="disc-summary">{summary}</span> : null}
          </span>
          <svg
            className="disc-chevron"
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M9.5 6 15.5 12 9.5 18" />
          </svg>
        </button>
      </h2>
      <div className="disc-body" id={bodyId} hidden={!open}>
        {children}
      </div>
    </section>
  );
}
