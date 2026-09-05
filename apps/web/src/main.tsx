import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { AlertApp } from './AlertApp';
import './tokens.css';

/**
 * Entry routing (issue #72): `/alert` is the WeCom alert H5 page - a separate
 * surface with its own credential (the link token) - everything else is the
 * cookie-authenticated workbench. The single SPA bundle keeps the reverse
 * proxy's `try_files ... /index.html` fallback and the Vite dev server
 * unchanged; no client-side router is introduced for one extra entry.
 */
const pathname = window.location.pathname;
const isAlertEntry = pathname === '/alert' || pathname.startsWith('/alert/');

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>{isAlertEntry ? <AlertApp /> : <App />}</React.StrictMode>,
);
