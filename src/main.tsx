import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Cleanly ignore only the specific benign Google AI Studio / Vite preview WebSocket closure message
// ("WebSocket closed without opened") without suppressing legitimate application runtime errors.
if (typeof window !== 'undefined') {
  const isBenignPreviewClosure = (text: string) => {
    return text.includes('WebSocket closed without opened');
  };

  window.addEventListener('unhandledrejection', (event) => {
    const reasonStr = String(event.reason?.message || event.reason || '');
    if (isBenignPreviewClosure(reasonStr)) {
      event.preventDefault();
      event.stopPropagation();
    }
  });

  window.addEventListener('error', (event) => {
    const msg = String(event.message || '');
    if (isBenignPreviewClosure(msg)) {
      event.preventDefault();
      event.stopPropagation();
    }
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
