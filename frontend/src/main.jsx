import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '../style.css';
import App from './app.jsx';

// DEV-only escape hatch for scripts/smoke-mandate.mjs (out-of-policy dispatch scenarios) — see
// src/dev/devDispatch.js. `import.meta.env.DEV` is a build-time constant, so Rollup dead-code
// eliminates this whole branch (and the dynamic import target) from production output; verified
// by scripts/assert-no-dev-dispatch.mjs, wired as the `postbuild` npm hook.
if (import.meta.env.DEV) {
  import('./dev/devDispatch.js').catch(() => {});
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
