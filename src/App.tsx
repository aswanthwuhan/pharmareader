import { NavLink, Route, Routes } from 'react-router-dom';
import LibraryPage from './pages/LibraryPage';
import ReaderPage from './pages/ReaderPage';
import ReviewPage from './pages/ReviewPage';
import SettingsPage from './pages/SettingsPage';
import SyllabusPage from './pages/SyllabusPage';

const NAV = [
  { to: '/', label: 'Library', end: true },
  { to: '/review', label: 'Review', end: false },
  { to: '/syllabus', label: 'Syllabus', end: false },
  { to: '/settings', label: 'Settings', end: false },
];

export default function App() {
  return (
    <div className="app">
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
                <p className="muted">That page does not exist.</p>
              </section>
            }
          />
        </Routes>
      </main>

      <nav className="bottom-nav" aria-label="Main">
        {NAV.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
            {item.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
