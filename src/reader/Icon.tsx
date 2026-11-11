/**
 * The reader's icon set: drawn on a 24px grid, 1.7 stroke, round caps, never
 * filled. Icons here stand in for text glyphs so buttons look the same on every
 * platform and scale cleanly.
 */
import type { ReactNode } from 'react';

export function Glyph({ children, size }: { children: ReactNode; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const icons = {
  back: <path d="M14.5 5.5 8 12l6.5 6.5" />,
  forward: <path d="M9.5 5.5 16 12l-6.5 6.5" />,
  chapters: (
    <>
      <path d="M4.5 7h11" />
      <path d="M4.5 12h11" />
      <path d="M4.5 17h7" />
      <path d="M19 8.5v7" />
    </>
  ),
  close: (
    <>
      <path d="M6.5 6.5 17.5 17.5" />
      <path d="M17.5 6.5 6.5 17.5" />
    </>
  ),
  /** More options: the same three dots everywhere, filled so they read at 16px. */
  more: (
    <>
      <circle cx="6" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="18" cy="12" r="1.3" fill="currentColor" stroke="none" />
    </>
  ),
  alert: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.6v5.2" />
      <path d="M12 16.2h.01" />
    </>
  ),
  prev: (
    <>
      <path d="M18 6.5v11L9 12l9-5.5Z" />
      <path d="M6 6.5v11" />
    </>
  ),
  next: (
    <>
      <path d="M6 6.5v11L15 12 6 6.5Z" />
      <path d="M18 6.5v11" />
    </>
  ),
  play: <path d="M8.5 5.5 19 12 8.5 18.5V5.5Z" />,
  pause: (
    <>
      <path d="M9.5 5.5v13" />
      <path d="M14.5 5.5v13" />
    </>
  ),
  stop: <rect x="7" y="7" width="10" height="10" rx="1.5" />,
  /** Play it again: a full turn back into the same passage. */
  replay: (
    <>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
      <path d="M19.5 4.7v4.3h-4.3" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5.5v13" />
      <path d="M5.5 12h13" />
    </>
  ),
  note: (
    <>
      <path d="M6 4.5h9l3.5 3.5v11.5H6V4.5Z" />
      <path d="M9 9.5h6" />
      <path d="M9 13h6" />
      <path d="M9 16.5h3.5" />
    </>
  ),
  bookmark: <path d="M7 4.5h10v15l-5-3.6-5 3.6v-15Z" />,
  card: (
    <>
      <rect x="3.5" y="6" width="17" height="12" rx="2" />
      <path d="M7 10h5" />
      <path d="M7 14h9" />
    </>
  ),
  sparkle: (
    <>
      <path d="M12 4.5 13.7 10 19 11.7 13.7 13.4 12 19l-1.7-5.6L5 11.7 10.3 10 12 4.5Z" />
    </>
  ),
  zoomIn: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
      <path d="M11 8.5v5" />
      <path d="M8.5 11h5" />
    </>
  ),
  zoomOut: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
      <path d="M8.5 11h5" />
    </>
  ),
  fit: (
    <>
      <path d="M4.5 9V5.5H8" />
      <path d="M16 5.5h3.5V9" />
      <path d="M19.5 15v3.5H16" />
      <path d="M8 18.5H4.5V15" />
    </>
  ),
  // Width between two margins: not the four corners of `fit`, which is the full-screen button.
  fitWidth: (
    <>
      <path d="M4.5 5.5v13M19.5 5.5v13" />
      <path d="M8 12h8" />
      <path d="m10.2 9.8-2.2 2.2 2.2 2.2M13.8 9.8l2.2 2.2-2.2 2.2" />
    </>
  ),
  textSmall: (
    <>
      <path d="M3.5 17.5 7.2 7.5l3.7 10" />
      <path d="M5 14h4.4" />
      <path d="M14.5 14h6" />
    </>
  ),
  textLarge: (
    <>
      <path d="M3.5 17.5 7.2 7.5l3.7 10" />
      <path d="M5 14h4.4" />
      <path d="M17.5 11v6" />
      <path d="M14.5 14h6" />
    </>
  ),
  page: (
    <>
      <path d="M6.5 3.5h8l3.5 3.5v13.5h-11.5v-17Z" />
      <path d="M14 3.5V7.5h3.5" />
    </>
  ),
  spacing: (
    <>
      <path d="M4.5 6.5h15" />
      <path d="M4.5 17.5h15" />
      <path d="M12 9v6" />
      <path d="M9.7 11 12 9l2.3 2" />
      <path d="M9.7 13 12 15l2.3-2" />
    </>
  ),
} satisfies Record<string, ReactNode>;
