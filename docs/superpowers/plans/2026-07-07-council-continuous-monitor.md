# Council Continuous Monitor

**Date:** 2026-07-07
**Status:** Implemented ✅
**Author:** Vibing Farmer team

## Masalah

Council cuma jalan sekali pas setup (manual "Run Council Review"). Padahal kondisi pasar berubah terus. User plan butuh re-evaluasi otomatis.

## Solusi: Efficiency Pyramid (4 Level)

```
Level 0 — RPC/API reads (gratis) — tiap 5-15m lewat background worker
  ↓ cuma lanjut kalo ada perubahan > threshold
Level 1 — Diff terhadap council snapshot terakhir (gratis)
  ↓ cuma lanjut kalo skor perubahan > threshold
Level 2 — Fast re-eval: Risk/Compliance + Validator (2 AI calls, ~$0.0005)
  ↓ cuma lanjut kalo Risk/Compliance bilang violation
Level 3 — Full debate (3-11 AI calls, ~$0.001-0.003)
```

## Cost Estimate

Perhitungan pake model `deepseek-v4-flash` (~$0.27/M input, ~$1.10/M output):

| Skenario | AI Calls | Biaya |
|----------|----------|-------|
| Level 0 + 1 (pre-check + diff) | 0 | **$0** |
| Level 2 (fast re-eval) | 2 | **~$0.0005** |
| Level 3 typical (2 iterasi) | 5 | **~$0.0013** |
| Level 3 worst (5 iterasi) | 11 | **~$0.0030** |
| **Harian normal** | ~2-8 | **~$0.005-0.01/hari** |
| **Bulanan typical** | — | **~$0.15-0.30/bulan** |

## Files Changed

### New file: `frontend/src/strategy/councilMonitor.js`

Core engine for continuous re-evaluation:

- `saveSnapshot(result, marketData)` — stores council result + market snapshot to localStorage (keeps last 20 entries)
- `loadSnapshot()` / `loadLatestSnapshot()` / `loadSnapshotHistory()` — read back
- `clearSnapshot()` — reset
- `diffMarket(currentData, snapshot, thresholds)` — compare current market vs snapshot. Returns `{ score: 0-100, level: 'skip'|'fast'|'full', reasons: [] }`
  - APY drift > threshold (default 5%): up to 40 points
  - VaR change > threshold (default 10%): up to 50 points
  - Turbulence change: 20 points
  - Gas spike >2x: 15 points
  - Risk news detected: 30 points
  - Level thresholds: skip (<20), fast (20-49), full (50+)
- `fastReeval(strategy, input, currentData, deps)` — runs Risk/Compliance (1 call) + Validator (1 call). Skips Proposer because strategy already approved. Returns `{ passed, level, riskCompliance, validator, permissionSentence, confidence }`

### Modified: `frontend/src/settingsStore.js`

4 new keys:

| Key | Default | Range |
|-----|---------|-------|
| `monitorEnabled` | false | bool |
| `autoApprove` | false | bool |
| `apyDriftThreshold` | 5 | 1-20 |
| `varBreachThreshold` | 10 | 5-50 |

### Modified: `frontend/src/agents/backgroundAgent.worker.js`

Added `MARKET_SIGNAL` event: after each APY check cycle (every 10 min), posts current `{ apyByVault, timestamp }` regardless of whether drift was detected. Cost: **$0** (reuses existing DeFiLlama fetch).

### Modified: `frontend/src/agents/agentController.js`

Added `case 'MARKET_SIGNAL'` — forwards to main thread listeners as `{ kind: 'market_signal', apyByVault, timestamp }`.

### Modified: `frontend/src/app.jsx`

- Import `diffMarket, fastReeval, loadLatestSnapshot, saveSnapshot` from councilMonitor
- New state: `monitorStatus { lastCheck, level, score, reason, result, error }`
- In `handleAgentEvent`: when `ev.kind === 'market_signal'` and `monitorEnabled`, calls `runCouncilMonitorCheck`
- New function `runCouncilMonitorCheck(settings, apyByVault)`:
  - Builds currentData from worker signal + strategy state
  - Runs diffMarket → updates monitorStatus
  - Level 'skip': nothing
  - Level 'fast': runs fastReeval → if pass, saveSnapshot (silent if autoApprove)
  - Level 'full': runs full councilDebate
  - Logs all events to activity log
- Passes `monitorStatus` to AgentDashboard

### Modified: `frontend/src/components/SettingsPage.jsx`

New "Council Monitor" section in Agent tab:
- Toggle: monitorEnabled (on/off)
- Threshold inputs: APY drift %, VaR breach %
- Toggle: autoApprove (on/off with disclaimer)

### Modified: `frontend/src/components/AgentDashboard.jsx`

New prop: `monitorStatus`. Renders status badge in the dashboard showing:
- Dot color: green (ok/skip), yellow (re-evaluating), red (violation)
- Status text + reason
- Timestamp of last check

## Key Design Decisions

1. **Skip Proposer di fast re-eval** — karena strategi udah disetujui, bukan lagi proposal. Cuma validasi apakah masih aman.
2. **Silent update kalo fast eval pass** — snapshot diupdate, user ga diganggu.
3. **User must opt-in** — `monitorEnabled` default false.
4. **autoApprove** — kalo user trusted, Level 2 pass = auto-approved tanpa notif.
5. **Worker-based pre-check** — andalkan worker yang sudah ada daripada bikin scheduler baru.
6. **DeFiLlama data gratis** — MARKET_SIGNAL reuses existing fetch, $0 extra.

## Excluded from Scope

- Event-driven triggers langsung dari DeFiLlama/Tavily — nanti, andalkan worker dulu.
- Server-side RAG OJK/SEC — masih nunggu diskusi teman.
- Multi-strategy comparison — monitor cuma evaluate 1 plan aktif.
- Full history timeline UI — snapshot history tersimpan, UI-nya bisa ditambah nanti.

## Evaluation Questions (Check After Usage)

1. Apakah Level 2 cukup akurat, atau sering false positive?
2. Apakah user paham sama status badge?
3. Apakah biaya sesuai prediksi?
4. Apakah interval 10 menit cukup responsif?
5. Apakah autoApprove bikin user merasa kehilangan kontrol?
