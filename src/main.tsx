import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles.css';
import { ensureSyllabusSeeded } from './syllabus/seed';

// Ask the browser to keep IndexedDB (books, audio cache) from being evicted.
void navigator.storage?.persist?.();
// Topic pickers anywhere in the app need the default syllabus present.
void ensureSyllabusSeeded();

// BASE_URL carries the deploy sub-path (e.g. /pharmareader/ on GitHub Pages) and is '/'
// for dev, Android and Windows. react-router wants no trailing slash.
const basename = import.meta.env.BASE_URL.replace(/\/+$/, '') || '/';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={basename}>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
