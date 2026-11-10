/**
 * The "What's new" sheet: what this version changed, read from the CHANGELOG
 * that ships inside the app. Offline, no markdown rendering — the parsed
 * section is plain strings, so nothing in the changelog can inject markup.
 *
 * It is mounted by App on launch (when the version moved) and by Settings →
 * About. Every way of closing it records the version as seen, so a sheet the
 * reader swiped away does not come back on the next start.
 */
import { useEffect, useId, useRef, useState } from 'react';
import './WhatsNew.css';
import { pushBackHandler } from '../core/backButton';
import { setSetting, useSetting } from '../core/settings';
import { UPDATE_CHECK_KEY } from '../core/updateCheck';
import { changelogSection, LAST_SEEN_VERSION_KEY } from '../core/version';

export interface WhatsNewProps {
  /** The version to describe; the sheet records it as seen when it closes. */
  version: string;
  /** Removes the sheet; focus returns to whatever opened it. */
  onClose: () => void;
}

export default function WhatsNew({ version, onClose }: WhatsNewProps) {
  const titleId = useId();
  const gotItRef = useRef<HTMLButtonElement>(null);
  const tellMeRef = useRef<HTMLButtonElement>(null);
  const updatesOn = useSetting<boolean>(UPDATE_CHECK_KEY, false);
  const [justEnabled, setJustEnabled] = useState(false);

  const section = changelogSection(version);
  // Latest callbacks without re-running the focus/keyboard effect on each render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const close = () => {
    // Every close path counts as "seen": Got it, Escape, the back key, the
    // backdrop. The write is fire-and-forget; a failure only means the sheet
    // may greet the reader once more, never that closing is blocked.
    void setSetting(LAST_SEEN_VERSION_KEY, version).catch(() => undefined);
    onCloseRef.current();
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    gotItRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      // Two or three buttons: Tab wraps inside the sheet instead of walking
      // into the page behind it.
      if (event.key !== 'Tab') return;
      const first = (tellMeRef.current ?? gotItRef.current) as HTMLButtonElement | null;
      const last = gotItRef.current;
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    // Android back closes the sheet instead of leaving the screen under it.
    const dispose = pushBackHandler(() => {
      closeRef.current();
      return true;
    });

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      dispose();
      // Focus goes back where it came from: the Settings link, or whatever had
      // it when the sheet opened itself on launch.
      if (returnTo && document.contains(returnTo)) returnTo.focus();
    };
  }, []);

  const tellMeAboutUpdates = () => {
    setJustEnabled(true);
    void setSetting(UPDATE_CHECK_KEY, true).catch(() => undefined);
  };

  return (
    <>
      <div className="sheet-backdrop" onClick={close} />
      <div className="sheet whatsnew" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} className="sheet-title">
          What’s new in {version}
        </h2>

        {section ? (
          <div className="whatsnew-body">
            {section.intro.map((paragraph) => (
              <p key={paragraph} className="whatsnew-intro muted">
                {paragraph}
              </p>
            ))}
            {section.groups.map((group, index) => (
              <section key={group.title ?? `group-${index}`} className="whatsnew-group">
                {group.title ? <h3 className="whatsnew-group-title">{group.title}</h3> : null}
                <ul className="whatsnew-list">
                  {group.bullets.map((bullet) => (
                    <li key={bullet}>{bullet}</li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        ) : (
          <p className="whatsnew-intro muted">This build does not carry notes for {version}.</p>
        )}

        <div className="sheet-actions whatsnew-actions">
          {updatesOn ? (
            justEnabled ? (
              <p className="whatsnew-note muted" role="status">
                Update checks are on. You can turn them off in Settings → About.
              </p>
            ) : null
          ) : (
            <button ref={tellMeRef} type="button" className="btn btn-secondary" onClick={tellMeAboutUpdates}>
              Tell me about updates
            </button>
          )}
          <button ref={gotItRef} type="button" className="btn btn-primary" onClick={close}>
            Got it
          </button>
        </div>
      </div>
    </>
  );
}
