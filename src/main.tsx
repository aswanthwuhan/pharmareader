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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
