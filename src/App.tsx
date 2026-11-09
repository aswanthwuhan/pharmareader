import type { ReactNode } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import LibraryPage from './pages/LibraryPage';
import ReaderPage from './pages/ReaderPage';
import ReviewPage from './pages/ReviewPage';
import SettingsPage from './pages/SettingsPage';
import SyllabusPage from './pages/SyllabusPage';

/**
 * Navigation icons are inline SVG on purpose: no icon font, no sprite fetch, so
 * the shell renders identically offline and in every wrapper (PWA, Android,
 * Windows). 24px grid, 1.7 stroke, round joins — one drawing hand throughout.
 */
const ICONS: Record<string, ReactNode> = {
  // Open book: two pages meeting at a spine.
  library: (
    <>
      <path d="M12 6.6C10.4 5.2 8.3 4.5 6 4.5H4v12.9h2c2.3 0 4.4.7 6 2.1 1.6-1.4 3.7-2.1 6-2.1h2V4.5h-2c-2.3 0-4.4.7-6 2.1Z" />
      <path d="M12 6.6v12.9" />
    </>
  ),
  // Two stacked cards: the review deck.
  review: (
    <>
      <path d="M7.5 7.5h10.6a2 2 0 0 1 2 2v9.9a2 2 0 0 1-2 2H7.5a2 2 0 0 1-2-2V9.5a2 2 0 0 1 2-2Z" />
      <path d="M8 4.5h8.6" />
    </>
  ),
  // A topic tree: three nodes on one trunk.
  syllabus: (
    <>
      <path d="M6 6h4.5M6 12h4.5M6 18h4.5" />
      <path d="M13.5 6h4.5M13.5 12h4.5M13.5 18h4.5" />
      <path d="M6 4v16" />
    </>
  ),
  // Sliders: settings.
  settings: (
    <>
      <path d="M4 7h5.5M14.5 7H20M4 17h8.5M17.5 17H20" />
      <circle cx="12" cy="7" r="2.2" />
      <circle cx="15" cy="17" r="2.2" />
    </>
  ),
};

const NAV: { to: string; label: string; end: boolean; icon: string }[] = [
  { to: '/', label: 'Library', end: true, icon: 'library' },
  { to: '/review', label: 'Review', end: false, icon: 'review' },
  { to: '/syllabus', label: 'Syllabus', end: false, icon: 'syllabus' },
  { to: '/settings', label: 'Settings', end: false, icon: 'settings' },
];

function NavIcon({ name }: { name: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {ICONS[name]}
    </svg>
  );
}

export default function App() {
  // Reading is a focused surface: on a wide screen the global rail steps aside
  // so the text column and the player own the full width.
  const reading = useLocation().pathname.startsWith('/read/');

  return (
    <div className={reading ? 'app app--reading' : 'app'}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <main className="app-main" id="main">
        <Routes>
          <Route path="/" element={<LibraryPage />} />
          <Route path="/read/:bookId" element={<ReaderPage />} />
          <Route path="/review" element={<ReviewPage />} />
          <Route path="/syllabus" element={<SyllabusPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route
            path="*"
            element={
              <section className="page">
                <h1>Not found</h1>
                <div className="empty-state">
                  <h2>That page does not exist</h2>
                  <p>It may have moved, or the link may have a typo in it.</p>
                  <div className="empty-state-actions">
                    <NavLink to="/" className="btn btn-secondary">
                      Back to Library
                    </NavLink>
                  </div>
                </div>
              </section>
            }
          />
        </Routes>
      </main>

      {/* Reading owns the whole screen: the reader's app bar is the way back, and
          its player sheet sits where the tab bar would be. */}
      {reading ? null : (
        <nav className="app-nav" aria-label="Main">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
            >
              <NavIcon name={item.icon} />
              <span className="nav-label">{item.label}</span>
            </NavLink>
          ))}
        </nav>
      )}
    </div>
  );
}
