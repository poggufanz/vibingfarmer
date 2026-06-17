# Implementation Plan — Frontend Conversion to Vite + React & NVL Graph Restoration

This plan details the steps to convert the "no-build" HTML + Babel Standalone frontend of Yield Vibing into a modern, robust **Vite + React** single-page application. This transition will permanently resolve CDN race conditions, enable native Web Workers for the Neo4j Visualization Library (NVL), and optimize load times and development tooling.

---

## Crucial Context & Issue History (Must Read for AI Executor)

> [!IMPORTANT]
> **To the executing AI Agent:** Do NOT attempt to rewrite the graph renderer from scratch or get stuck trying to debug the dynamic script tags in the existing `index.html`. Read the following context carefully to understand why NVL failed previously and how to restore it correctly under Vite.

### Why NVL Failed in the No-Build Architecture
During Phase 5, the previous agent attempted to integrate NVL via dynamic ESM CDNs, which triggered several nested failure points:
1. **Dynamic Import Race Conditions:** React tried to mount the `<AgentGraph>` component before `window._nvl` was resolved from `esm.sh`. This resulted in `_nvl is undefined` errors and rendered a blank graph screen.
2. **Cross-Origin Web Worker Failures (CORS):** NVL delegates heavy graph layout calculations to Web Workers. Under the old no-build setup, the browser blocked Web Workers from loading across origins (from `esm.sh`), causing the NVL constructor to crash silently.
3. **Viewport Scale & Layout Fit Failures:** Because NVL failed to calculate its layout asynchronously due to worker crashes, calling `nvl.fit([])` immediately inside the layout callback caused container-size dimension calculation crashes (width/height evaluated as `0px`).
4. **The Canvas Fallback Solution:** As a temporary patch, the agent added a pure-canvas fallback (`820ed1d`) and then completely stripped out NVL in favor of a canvas-based manual drawing component (`2b4316e`) to guarantee a stable demo presentation.

### Where to Find the Original NVL Code
The original, fully-formed NVL React component structure and configuration are preserved in your Git history. 
* To view the complete NVL setup with node style configurations, layout options, and relationships mapping, inspect the file `frontend/src/agents.jsx` at commit **`820ed1d`**:
  ```bash
  git show 820ed1d:frontend/src/agents.jsx
  ```
* **Your Goal:** You will **restore** this NVL configuration inside the new Vite architecture, replacing the canvas fallback entirely. Because Vite bundles dependencies locally, all CORS, Web Worker, and CDN race conditions will be naturally resolved!

---

## Rationale & Backlog (Why Convert?)

1. **NVL Loading Reliability:** Local installation via `npm install @neo4j-nvl/base` guarantees 100% offline reliability. No CDN latency, no external network dependencies.
2. **Native Web Worker Support:** Vite bundles Web Workers natively, eliminating all CORS issues and allowing NVL's force layout to calculate smoothly.
3. **Pre-Compiled JSX:** Removing Babel Standalone speeds up page load from ~3 seconds to mere milliseconds, creating a premium first impression.
4. **Clean Web3 Dependency Bundling:** Packages like `viem` and MetaMask Smart Accounts Kit compile correctly with type checking.

---

## Proposed Changes

We will restructure the application by converting the `frontend` folder into a standard Vite + React project.

```
frontend/ (New Vite Structure)
├── package.json               # [NEW] Local dependencies (React, Viem, NVL, etc.)
├── vite.config.js             # [NEW] Vite configuration (enabling web workers & plugins)
├── index.html                 # [MODIFY] Simplified app shell, imports bundled JS
├── src/                       # [NEW] All ported components and logic
│   ├── main.jsx               # [NEW] ReactDOM entry point
│   ├── app.jsx                # [MODIFY] Ported main state machine & layouts
│   ├── components.jsx         # [MODIFY] Sidebar, TopBar, StepRail
│   ├── screens.jsx            # [MODIFY] Connection and flow screens
│   ├── agents.jsx             # [MODIFY] Re-integrate NVL graph natively from npm
│   ├── wallet.js              # [MODIFY] Ported MetaMask Flask interaction
│   ├── relay.js               # [MODIFY] Ported 1Shot Relayer integration
│   ├── venice.js              # [MODIFY] Ported Venice AI strategy/skill generation
│   ├── skills.js              # [MODIFY] Ported LocalStorage skill helpers
│   ├── memory.js              # [MODIFY] Ported LocalStorage memory helpers
│   └── ui.js                  # [MODIFY] Helper DOM utility functions
└── style.css                  # [MODIFY] Design tokens and component styling
```

---

## Detailed Step-by-Step Task Breakdown

### Task 1 — Initialize Vite + React Project
- [ ] Create `package.json` with React 18, `@neo4j-nvl/base`, `viem`, `@metamask/smart-accounts-kit`, and build tooling.
- [ ] Create `vite.config.js` to handle dynamic imports and assets.
- [ ] Run `npm install` inside the `frontend` folder to lock dependencies locally.

### Task 2 — Port Web3 & Agent Logic to Bundled Modules
- [ ] Move JSX and JS files from `frontend/` to the new `src/` directory.
- [ ] Convert `wallet.js`, `relay.js`, `venice.js`, `skills.js`, `memory.js`, and `ui.js` to standard ES module imports (replacing absolute paths or global object bridges with standard `import/export` statements).
- [ ] Verify that environment variables (`VENICE_API_KEY`, etc.) are resolved securely through Vite's `import.meta.env` and loaded from `.env`.

### Task 3 — Restore NVL Graph Natively
- [ ] In `src/agents.jsx`, import NVL directly from the npm package: `import { NVL } from '@neo4j-nvl/base'`.
- [ ] Restore the hierarchical layout logic, node styling, click handlers, and pulse states in `AgentGraph` using the code from commit `820ed1d` as reference.
- [ ] Verify that Web Workers calculate the layout cleanly, resolving the dynamic layout `fit` problems.

### Task 4 — Simplify index.html
- [ ] Clean out Babel Standalone, the old ES importmap, and any external scripts from `index.html`.
- [ ] Inject the entry script `<script type="module" src="/src/main.jsx"></script>`.

---

## Verification Plan

### Automated Tests
- Run `npm run build` to verify that all modules are resolved and compiled into a single production-ready bundle.

### Manual Verification
- Run `npm run dev` to start the local Vite development server.
- Connect MetaMask Flask, input strategy variables, and verify that the strategy generates successfully via Venice AI.
- Visually confirm that the **NVL Graph** renders beautifully with nodes, relations, correct labels, and pulsing glows, clicking on nodes to view active memory entries.
