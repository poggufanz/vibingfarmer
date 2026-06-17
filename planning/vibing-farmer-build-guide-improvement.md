# Vibing Farmer — Complete Build Guide

> Dokumen ini menjabarkan cara implementasi setiap komponen sistem Vibing Farmer secara berurutan, lengkap dengan narasi konsep, kode, dan referensi project/paper yang menginspirasi tiap bagian.

---

## Step 1 — Formalize State/Action/Reward

**Inspired by**: FinRL (AI4Finance Foundation)

### Narasi

FinRL mendefinisikan trading sebagai RL problem dengan tiga elemen: State (apa yang diamati), Action (apa yang bisa dilakukan), Reward (bagaimana mengukur sukses). Vibing Farmer butuh formalisasi yang sama supaya agent punya bahasa yang jelas — bukan sekadar "fetch data → tanya AI".

State harus mencakup semua yang dibutuhkan untuk membuat keputusan. Action harus terdefinisi jelas. Reward harus measurable dan tidak ambigu.

### Code — `frontend/src/core/state.js`

```javascript
// State definition — semua yang agent "lihat" sebelum decide
const createState = (raw) => ({
  // Portfolio state
  positions: raw.positions.map(p => ({
    pool: p.poolId,
    protocol: p.protocol,
    amount: p.amountUSD,
    entryAPY: p.entryAPY,
    currentAPY: p.currentAPY,
    entryTimestamp: p.entryTimestamp,
    daysHeld: (Date.now() - p.entryTimestamp) / 86400000
  })),
  walletBalance: raw.walletBalanceUSD,

  // Market state
  pools: raw.pools.map(p => ({
    id: p.pool,
    protocol: p.project,
    chain: p.chain,
    apy: p.apy,
    apyBase: p.apyBase,
    apyReward: p.apyReward,
    tvl: p.tvlUsd,
    tvlDelta24h: p.tvlDelta24h ?? 0,
    ilRisk: p.ilRisk ?? 'low',
    audited: p.audited ?? false
  })),
  gasPrice: raw.gasPrice,        // gwei
  ethPriceUSD: raw.ethPrice,

  // Technical indicators (computed, bukan raw)
  marketVolatility: raw.marketVolatility,
  turbulenceIndex: raw.turbulenceIndex,   // 0–1, dari FinRL pattern
  timeSinceLastRebalance: raw.hoursSinceLastRebalance,

  timestamp: Date.now()
})

// Action space — hanya dua jenis action
const ACTIONS = {
  HOLD: (reason) => ({ type: 'HOLD', reason }),
  REBALANCE: (fromPool, toPool, amountUSD) => ({
    type: 'REBALANCE',
    fromPool,
    toPool,
    amountUSD
  })
}

// Reward function — dipanggil SETELAH 7 hari (delayed evaluation)
// Ini yang Reflector pakai sebagai ground truth
const calculateReward = ({ actualYieldUSD, gasCostUSD, ilLossUSD = 0 }) => {
  return actualYieldUSD - gasCostUSD - ilLossUSD
}

module.exports = { createState, ACTIONS, calculateReward }
```

---

## Step 2 — Autonomous Monitor Loop

**Inspired by**: autoresearch (Andrej Karpathy) — prinsip "NEVER STOP"

### Narasi

autoresearch menjalankan loop tak terbatas: modifikasi kode → train → evaluasi → keep/discard → ulangi. Loop ini jalan semalam penuh tanpa intervensi manusia.

Di Vibing Farmer, loop-nya: fetch state → run gates → simulate → council → execute → sleep → ulangi. Yang penting: loop TIDAK boleh crash karena satu error. Setiap error dicatat dan loop lanjut ke cycle berikutnya — persis seperti autoresearch yang punya "crash recovery" di `program.md`.

### Code — `frontend/src/core/loop.js`

```javascript
const { fetchCurrentState } = require('./fetcher')
const { runFastFailGates } = require('./gates')
const { runSimulation } = require('../simulation/simulator')
const { runCouncil } = require('../council/council')
const { evaluateConsensus } = require('../council/consensus')
const { executeRebalance } = require('../execution/executor')
const { loadPlaybook } = require('../memory/playbook')
const { loadStrategyConfig } = require('../config')
const veniceClient = require('../clients/venice')

const LOOP_INTERVAL_MS = 30 * 60 * 1000 // 30 menit

async function startAutonomousLoop() {
  console.log('   Vibing Farmer autonomous loop started')
  console.log(`   Interval: ${LOOP_INTERVAL_MS / 60000} minutes`)

  while (true) { // NEVER STOP — autoresearch principle
    try {
      await runOneCycle()
    } catch (err) {
      // Crash recovery — log tapi jangan stop loop
      console.error(`❌ Cycle error: ${err.message}`)
      console.error(err.stack)
      // Lanjut — cycle berikutnya mungkin berhasil
    }

    await sleep(LOOP_INTERVAL_MS)
  }
}

async function runOneCycle() {
  const cycleId = `cycle-${Date.now()}`
  console.log(`\n🔄 [${cycleId}] Starting cycle`)

  const strategyConfig = await loadStrategyConfig()
  const playbook = await loadPlaybook()

  // Step 3: Parallel fetch
  const state = await fetchCurrentState(strategyConfig)

  // Step 4: Fast-fail gates (math only, no AI)
  const gateResult = runFastFailGates(state, strategyConfig)
  if (!gateResult.pass) {
    console.log(`⏸️ [${cycleId}] Gate blocked: ${gateResult.reason}`)
    return
  }

  const candidates = gateResult.candidates

  // Step 5: Simulation
  const simResult = await runSimulation(candidates, state, veniceClient)
  if (simResult.expectedValue < strategyConfig.minExpectedValueUSD) {
    console.log(`⏸️ [${cycleId}] Sim rejected: E[value]=$${simResult.expectedValue.toFixed(2)}`)
    return
  }

  // Step 6: Council
  const verdicts = await runCouncil(simResult, state, strategyConfig, playbook, veniceClient)

  // Step 7: Consensus
  const consensus = evaluateConsensus(verdicts)
  console.log(`🏛️ [${cycleId}] Consensus: ${consensus.finalDecision} (${consensus.executeVotes}/3 votes)`)

  // Step 9: Execute or hold
  await executeRebalance(consensus, simResult, state, strategyConfig)
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

module.exports = { startAutonomousLoop }
```

---

## Step 3 — Parallel Data Fetch

**Inspired by**: EvoAgentX (DAG workflow — nodes run concurrently)

### Narasi

EvoAgentX menggunakan DAG (Directed Acyclic Graph) di mana nodes yang tidak saling bergantung berjalan secara paralel. Di Vibing Farmer, fetch pools, fetch gas price, fetch positions, dan fetch on-chain signals TIDAK saling bergantung — jadi bisa semua jalan serentak via `Promise.all`.

Kalau sequential: 4 × 500ms = 2 detik. Kalau parallel: max(500ms) = 500ms. Dengan DeFi timing yang penting, ini non-trivial.

### Code — `frontend/src/core/fetcher.js`

```javascript
const { createState } = require('./state')

async function fetchCurrentState(strategyConfig) {
  console.log('📡 Fetching state (parallel)...')
  const start = Date.now()

  // Semua fetch jalan concurrent — EvoAgentX DAG pattern
  const [positions, pools, gasPrice, ethPrice, onChainSignals] = await Promise.all([
    fetchPositions(strategyConfig.walletAddress),
    fetchPoolsFromDeFiLlama(strategyConfig.whitelist),
    fetchGasPrice(),
    fetchEthPrice(),
    fetchOnChainSignals(strategyConfig.watchedPools)
  ])

  const marketVolatility = calculateVolatility(pools)
  const turbulenceIndex = calculateTurbulenceIndex(pools, onChainSignals)
  const hoursSinceLastRebalance = await getHoursSinceLastRebalance()

  console.log(`   Fetched in ${Date.now() - start}ms`)

  return createState({
    positions,
    pools,
    walletBalanceUSD: await fetchWalletBalance(strategyConfig.walletAddress),
    gasPrice,
    ethPrice,
    marketVolatility,
    turbulenceIndex,
    hoursSinceLastRebalance
  })
}

async function fetchPositions(walletAddress) {
  // Fetch dari smart account / on-chain
  // Return: [{ poolId, protocol, amountUSD, entryAPY, currentAPY, entryTimestamp }]
  const response = await fetch(`https://api.1inch.dev/portfolio/v4/portfolio/overview?addresses=${walletAddress}`)
  const data = await response.json()
  return data.result?.map(pos => ({
    poolId: pos.protocol_name,
    protocol: pos.protocol_name,
    amountUSD: pos.value_usd,
    entryAPY: pos.apy ?? 0,
    currentAPY: pos.apy ?? 0,
    entryTimestamp: pos.open_date * 1000
  })) ?? []
}

async function fetchPoolsFromDeFiLlama(whitelist) {
  const resp = await fetch('https://yields.llama.fi/pools')
  const { data } = await resp.json()

  return data
    .filter(p => whitelist.includes(p.project))
    .filter(p => p.tvlUsd > 5_000_000)          // min $5M TVL
    .filter(p => p.apy != null && p.apy > 0)
    .sort((a, b) => b.apy - a.apy)
    .slice(0, 20)
    .map(p => ({
      pool: p.pool,
      project: p.project,
      chain: p.chain,
      apy: p.apy,
      apyBase: p.apyBase,
      apyReward: p.apyReward,
      tvlUsd: p.tvlUsd,
      tvlDelta24h: p.change_1d ?? 0,
      ilRisk: p.ilRisk ?? 'low',
      audited: p.audits !== '0'
    }))
}

async function fetchGasPrice() {
  // Pakai ethers.js atau direct API
  const resp = await fetch('https://api.etherscan.io/api?module=gastracker&action=gasoracle&apikey=YourAPIKey')
  const { result } = await resp.json()
  return parseFloat(result.ProposeGasPrice) // gwei
}

async function fetchEthPrice() {
  const resp = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd')
  const data = await resp.json()
  return data.ethereum.usd
}

async function fetchOnChainSignals(watchedPools) {
  // Deteksi whale movements, protocol events, anomalies
  // Simplified: check TVL delta dan large transactions
  return { whaleAlerts: [], protocolAlerts: [], unusualTVLMovements: [] }
}

function calculateVolatility(pools) {
  const apys = pools.map(p => p.apy)
  const mean = apys.reduce((s, v) => s + v, 0) / apys.length
  const variance = apys.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / apys.length
  return Math.min(Math.sqrt(variance) / 100, 1.0) // normalize 0-1
}

function calculateTurbulenceIndex(pools, signals) {
  // FinRL Mahalanobis distance — simplified version
  const apyVariance = calculateVariance(pools.map(p => p.apy))
  const tvlVariance = calculateVariance(pools.map(p => p.tvlDelta24h ?? 0))
  const alertPenalty = (signals.protocolAlerts?.length ?? 0) * 0.1

  const turbulence = (apyVariance * 0.4 + tvlVariance * 0.4 + alertPenalty * 0.2) / 50
  return Math.min(Math.max(turbulence, 0), 1.0)
}

function calculateVariance(values) {
  if (values.length === 0) return 0
  const mean = values.reduce((s, v) => s + v, 0) / values.length
  return values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / values.length
}

module.exports = { fetchCurrentState }
```

---

## Step 4 — Fast-fail Gates

**Inspired by**: FinRL (Turbulence Index + risk constraints)

### Narasi

FinRL punya konsep Turbulence Index: kalau market chaos, hanya izinkan sell action. Selain itu, FinRL mendefinisikan constraint keras di environment — kalau state tertentu terdeteksi, agent otomatis di-restrict.

Di Vibing Farmer, gates ini adalah GARIS PERTAHANAN PERTAMA. Semuanya pure math — tidak ada AI call, tidak ada network request. Kalau gate gagal, loop langsung sleep tanpa membuang Venice AI credit.

Gates harus di-code sebagai pure functions: input → boolean. Mudah ditest, mudah di-debug.

### Code — `frontend/src/core/gates.js`

```javascript
// PURE FUNCTIONS ONLY — no async, no AI, no network
// Fast, instant, zero cost

const DEFAULTS = {
  TURBULENCE_CRITICAL: 0.75,
  MIN_APY_DELTA_PERCENT: 2.0,     // minimum 2% APY improvement to bother
  MIN_TVL_USD: 5_000_000,
  MAX_GAS_USD: 25,
  MAX_BREAKEVEN_DAYS: 45,
  MIN_COOLDOWN_HOURS: 12,
  MAX_EXPOSURE_PER_PROTOCOL: 0.8  // max 80% in one protocol
}

function runFastFailGates(state, config) {
  const thresholds = { ...DEFAULTS, ...config.thresholds }

  const gates = [
    checkTurbulence(state, thresholds),
    checkCooldown(state, thresholds),
    checkGasBudget(state, thresholds),
    checkCandidatesExist(state, thresholds),
  ]

  const failed = gates.find(g => !g.pass)

  if (failed) {
    return { pass: false, reason: failed.reason, gate: failed.name }
  }

  // Collect candidates dari checkCandidatesExist (satu-satunya gate yang produce output)
  const candidates = gates.find(g => g.candidates)?.candidates ?? []

  return { pass: true, candidates }
}

function checkTurbulence(state, thresholds) {
  if (state.turbulenceIndex >= thresholds.TURBULENCE_CRITICAL) {
    return {
      pass: false,
      name: 'turbulence',
      reason: `Market turbulence too high: ${(state.turbulenceIndex * 100).toFixed(1)}% (max: ${thresholds.TURBULENCE_CRITICAL * 100}%)`
    }
  }
  return { pass: true, name: 'turbulence' }
}

function checkCooldown(state, thresholds) {
  if (state.timeSinceLastRebalance < thresholds.MIN_COOLDOWN_HOURS) {
    return {
      pass: false,
      name: 'cooldown',
      reason: `Cooldown active: ${state.timeSinceLastRebalance.toFixed(1)}h since last rebalance (min: ${thresholds.MIN_COOLDOWN_HOURS}h)`
    }
  }
  return { pass: true, name: 'cooldown' }
}

function checkGasBudget(state, thresholds) {
  // Estimate gas cost: typical DeFi tx ~300,000 gas units
  const gasCostETH = (state.gasPrice * 300000) / 1e9
  const gasCostUSD = gasCostETH * state.ethPriceUSD

  if (gasCostUSD > thresholds.MAX_GAS_USD) {
    return {
      pass: false,
      name: 'gas',
      reason: `Gas too expensive: $${gasCostUSD.toFixed(2)} (max: $${thresholds.MAX_GAS_USD})`
    }
  }
  return { pass: true, name: 'gas', estimatedGasUSD: gasCostUSD }
}

function checkCandidatesExist(state, thresholds) {
  const currentAPY = getCurrentPortfolioAPY(state)

  const candidates = state.pools.filter(pool => {
    const isCurrentPool = state.positions.some(p => p.pool === pool.id)
    const apyDelta = pool.apy - currentAPY

    return (
      !isCurrentPool &&
      apyDelta >= thresholds.MIN_APY_DELTA_PERCENT &&
      pool.tvl >= thresholds.MIN_TVL_USD
    )
  }).slice(0, 5) // max 5 candidates ke simulation

  if (candidates.length === 0) {
    return {
      pass: false,
      name: 'candidates',
      reason: `No pools with APY > current (${currentAPY.toFixed(2)}%) + ${thresholds.MIN_APY_DELTA_PERCENT}% delta`
    }
  }

  return { pass: true, name: 'candidates', candidates }
}

function getCurrentPortfolioAPY(state) {
  if (state.positions.length === 0) return 0
  const totalValue = state.positions.reduce((s, p) => s + p.amount, 0)
  return state.positions.reduce((s, p) => s + (p.currentAPY * p.amount / totalValue), 0)
}

module.exports = { runFastFailGates, getCurrentPortfolioAPY }
```

---

## Step 5 — Simulation Engine

**Inspired by**: Konsep ZX (alternate timeline simulation) — lightweight DeFi adaptation

### Narasi

ZX original bayangkan ribuan agents berinteraksi selama jam/hari. Di Vibing Farmer, "simulation" bukan full agent-based — tapi tetap bisa menangkap spirit-nya: jalankan beberapa "alternate futures" dengan asumsi berbeda, lihat distribusi outcome, ambil expected value.

Kuncinya: 3 parallel Venice AI calls dengan market assumptions yang berbeda. Bukan sequential (3× lambat), tapi `Promise.all` (1× lambat). Seluruh simulasi selesai dalam ~1-2 detik karena berjalan concurrent.

Yang bikin output ini powerful bukan jumlah scenarios-nya, tapi richness context yang dikirim ke setiap scenario — TVL trend, news sentiment, on-chain signals, historical APY.

### Code — `frontend/src/simulation/simulator.js`

```javascript
const { fetchCachedSentiment } = require('../clients/sentiment')

const MIN_EXPECTED_VALUE_USD = 10 // harus profit minimal $10 untuk lanjut

async function runSimulation(candidates, state, veniceClient) {
  console.log('🔮 Running simulation (3 parallel scenarios)...')
  const start = Date.now()

  // Enrich context dengan data real sebelum call AI
  // Ini yang bikin simulation "feel real" — bukan AI yang halu data ini
  const enrichedContext = await buildSimulationContext(candidates, state)

  // Assign scenario probabilities based on current signals
  const weights = assignScenarioProbabilities(enrichedContext)

  // 3 parallel AI calls — the ZX "alternate timeline" spirit
  const [bull, base, bear] = await Promise.all([
    simulateScenario('bull', enrichedContext, veniceClient),
    simulateScenario('base', enrichedContext, veniceClient),
    simulateScenario('bear', enrichedContext, veniceClient),
  ])

  const expectedValue =
    (bull.projectedNetYieldUSD ?? 0) * weights.bull +
    (base.projectedNetYieldUSD ?? 0) * weights.base +
    (bear.projectedNetYieldUSD ?? 0) * weights.bear

  console.log(`   Simulation done in ${Date.now() - start}ms`)
  console.log(`   Bull: $${bull.projectedNetYieldUSD?.toFixed(2)} (p=${weights.bull.toFixed(2)})`)
  console.log(`   Base: $${base.projectedNetYieldUSD?.toFixed(2)} (p=${weights.base.toFixed(2)})`)
  console.log(`   Bear: $${bear.projectedNetYieldUSD?.toFixed(2)} (p=${weights.bear.toFixed(2)})`)
  console.log(`   E[value]: $${expectedValue.toFixed(2)}`)

  return { bull, base, bear, weights, expectedValue, context: enrichedContext }
}

async function buildSimulationContext(candidates, state) {
  const newsSentiment = await fetchCachedSentiment() // pre-cached hourly, non-blocking

  return {
    candidates: candidates.slice(0, 5).map(p => ({
      id: p.id,
      protocol: p.protocol,
      apy: p.apy,
      tvl: p.tvl,
      tvlTrend3d: p.tvlDelta24h * 3, // rough 3-day estimate
      ilRisk: p.ilRisk,
      audited: p.audited
    })),
    currentPositions: state.positions,
    portfolioValueUSD: state.positions.reduce((s, p) => s + p.amount, 0),
    gasPrice: state.gasPrice,
    ethPrice: state.ethPriceUSD,
    turbulenceIndex: state.turbulenceIndex,
    marketVolatility: state.marketVolatility,
    newsSentiment,           // 'positive' | 'neutral' | 'negative'
    marketTrend: calculateMarketTrend(state.pools),
  }
}

async function simulateScenario(scenario, context, veniceClient) {
  const SCENARIO_ASSUMPTIONS = {
    bull: 'DeFi market rallying. TVL growing. APYs stable. Gas affordable. Low IL risk.',
    base: 'DeFi market flat. TVL stable. APYs as reported. Gas normal. Moderate IL risk.',
    bear: 'DeFi market declining. TVL shrinking 10–20%. APYs may compress. Gas elevated. High IL risk.'
  }

  const prompt = `
You are a DeFi yield simulation engine.

Market scenario: ${scenario.toUpperCase()}
Assumptions: ${SCENARIO_ASSUMPTIONS[scenario]}

Portfolio: $${context.portfolioValueUSD.toFixed(0)} USD
Current gas: ${context.gasPrice} gwei (~$${(context.gasPrice * 300000 * context.ethPrice / 1e9).toFixed(2)} per tx)
News sentiment: ${context.newsSentiment}
Market trend: ${context.marketTrend}
Turbulence: ${(context.turbulenceIndex * 100).toFixed(0)}%

Top candidates:
${context.candidates.map(p =>
  `- ${p.protocol}: APY ${p.apy.toFixed(2)}%, TVL $${(p.tvl / 1e6).toFixed(1)}M, IL risk: ${p.ilRisk}, audited: ${p.audited}`
).join('\n')}

Given this ${scenario} scenario, what is the realistic outcome if we rebalance to the best candidate?
Estimate projected net yield (after gas and IL) over 7 days.

Respond ONLY in valid JSON:
{
  "recommendedPool": "protocol-name",
  "projectedNetYieldUSD": 0.00,
  "projectedILPercent": 0.00,
  "estimatedGasCostUSD": 0.00,
  "confidence": 0.00,
  "keyRisk": "one sentence max"
}
`

  try {
    const response = await veniceClient.complete({
      systemPrompt: 'You are a DeFi simulation engine. Output ONLY valid JSON. No explanation.',
      userPrompt: prompt,
      maxTokens: 200,
      temperature: 0.3
    })

    return { scenario, ...JSON.parse(response) }
  } catch (err) {
    console.error(`Simulation ${scenario} failed: ${err.message}`)
    return { scenario, projectedNetYieldUSD: 0, confidence: 0, keyRisk: 'simulation failed' }
  }
}

function assignScenarioProbabilities(context) {
  let bull = 0.33, base = 0.34, bear = 0.33

  // Adjust based on signals
  if (context.turbulenceIndex > 0.5) { bear += 0.15; bull -= 0.15 }
  if (context.newsSentiment === 'positive') { bull += 0.10; bear -= 0.10 }
  if (context.newsSentiment === 'negative') { bear += 0.10; bull -= 0.10 }
  if (context.marketTrend === 'uptrend') { bull += 0.07; bear -= 0.07 }
  if (context.marketTrend === 'downtrend') { bear += 0.07; bull -= 0.07 }

  // Normalize
  const total = bull + base + bear
  return {
    bull: bull / total,
    base: base / total,
    bear: bear / total
  }
}

function calculateMarketTrend(pools) {
  const avgTvlDelta = pools.reduce((s, p) => s + (p.tvlDelta24h ?? 0), 0) / pools.length
  if (avgTvlDelta > 0.03) return 'uptrend'
  if (avgTvlDelta < -0.03) return 'downtrend'
  return 'sideways'
}

module.exports = { runSimulation }
```

---

## Step 6 — AI Council

**Inspired by**: TradingAgents (TauricResearch) — Bull/Bear researcher debate pattern

### Narasi

TradingAgents mensimulasikan firma trading nyata: ada fundamental analyst, sentiment analyst, technical analyst, risk manager, portfolio manager. Setiap agent punya role spesifik, dan mereka berkolaborasi — termasuk Bull/Bear researchers yang berdebat.

Di Vibing Farmer: tiga specialist agents jalan parallel, setiap satu punya system prompt dan data yang benar-benar berbeda. Yang bikin ini bukan sekedar "nanya hal yang sama 3 kali" adalah karena:
1. Setiap agent lihat dimensi berbeda
2. Setiap agent punya subset playbook yang relevan untuk role-nya
3. Output-nya compressed verdict, bukan free-text

Setiap verdict harus include `citedRules` — rules playbook mana yang dipakai untuk decide. Ini yang memungkinkan Reflector mengupdate counters-nya nanti.

### Code — `frontend/src/council/council.js`

```javascript
const { formatPlaybookForCouncil } = require('../memory/playbook')

// Setiap specialist punya system prompt yang genuinely berbeda
const SPECIALIST_PROMPTS = {
  riskAuditor: `You are a DeFi Risk Auditor. Your SOLE job: assess protocol safety and IL risk.
Evaluate: smart contract audit recency, TVL stability (3-day trend), impermanent loss exposure, protocol track record.
Be conservative. When in doubt, vote HOLD. Protect the portfolio from rug pulls and IL traps.
Output ONLY valid JSON. Never explain outside the JSON.`,

  gasChecker: `You are a DeFi Gas Efficiency Analyst. Your SOLE job: determine if gas cost is economically justified.
Calculate: gas cost in USD, APY delta, daily yield improvement, breakeven period (gas_cost / daily_yield_delta).
Rule: if breakeven > 30 days, vote HOLD regardless of other factors.
Output ONLY valid JSON. Never explain outside the JSON.`,

  strategyGuard: `You are a DeFi Strategy Compliance Officer. Your SOLE job: enforce user's declared strategy parameters.
Check: is the proposed action within risk tolerance? Does the target protocol appear on the whitelist? Is diversification maintained?
No exceptions. If it violates the user's strategy, vote HOLD.
Output ONLY valid JSON. Never explain outside the JSON.`
}

async function runCouncil(simResult, state, strategyConfig, playbook, veniceClient) {
  console.log('🏛️ Council convening (3 parallel specialists)...')

  // Filter playbook per kategori untuk setiap specialist
  const playbookByRole = {
    riskAuditor: playbook.filter(r => r.category === 'risk'),
    gasChecker: playbook.filter(r => r.category === 'gas'),
    strategyGuard: playbook.filter(r => r.category === 'strategy')
  }

  const sharedContext = buildCouncilContext(simResult, state, strategyConfig)

  // 3 parallel specialist calls — TradingAgents pattern
  const [riskVerdict, gasVerdict, strategyVerdict] = await Promise.all([
    consultSpecialist('riskAuditor', sharedContext, playbookByRole.riskAuditor, veniceClient),
    consultSpecialist('gasChecker', sharedContext, playbookByRole.gasChecker, veniceClient),
    consultSpecialist('strategyGuard', sharedContext, playbookByRole.strategyGuard, veniceClient),
  ])

  console.log(`   Risk Auditor: ${riskVerdict.decision} (${(riskVerdict.confidence * 100).toFixed(0)}%)`)
  console.log(`   Gas Checker: ${gasVerdict.decision} (${(gasVerdict.confidence * 100).toFixed(0)}%)`)
  console.log(`   Strategy Guard: ${strategyVerdict.decision} (${(strategyVerdict.confidence * 100).toFixed(0)}%)`)

  return [riskVerdict, gasVerdict, strategyVerdict]
}

function buildCouncilContext(simResult, state, strategyConfig) {
  const estimatedGasUSD = (state.gasPrice * 300000 * state.ethPriceUSD) / 1e9
  const portfolioValue = state.positions.reduce((s, p) => s + p.amount, 0)
  const dailyYieldDelta = (simResult.base.projectedNetYieldUSD ?? 0) / 7

  return {
    proposedPool: simResult.base.recommendedPool,
    proposedPoolAPY: state.pools.find(p => p.id === simResult.base.recommendedPool)?.apy ?? 0,
    currentAPY: state.positions[0]?.currentAPY ?? 0,
    portfolioValueUSD: portfolioValue,
    estimatedGasCostUSD: estimatedGasUSD,
    breakevenDays: dailyYieldDelta > 0 ? (estimatedGasUSD / dailyYieldDelta).toFixed(1) : 999,
    expectedValue7d: simResult.expectedValue,
    simulationScenarios: {
      bull: { yield: simResult.bull.projectedNetYieldUSD, probability: simResult.weights.bull },
      base: { yield: simResult.base.projectedNetYieldUSD, probability: simResult.weights.base },
      bear: { yield: simResult.bear.projectedNetYieldUSD, probability: simResult.weights.bear }
    },
    poolDetails: state.pools.find(p => p.id === simResult.base.recommendedPool) ?? {},
    strategyConfig: {
      riskTolerance: strategyConfig.riskTolerance,
      whitelist: strategyConfig.whitelist,
      maxGasUSD: strategyConfig.thresholds?.MAX_GAS_USD ?? 25
    },
    turbulenceIndex: state.turbulenceIndex
  }
}

async function consultSpecialist(role, context, playbookForRole, veniceClient) {
  const playbookText = formatPlaybookForCouncil(playbookForRole)

  const prompt = `
Relevant rules from your playbook:
${playbookText || '(no rules yet — use your expertise)'}

Decision context:
${JSON.stringify(context, null, 2)}

Provide your specialist verdict.

Respond ONLY in valid JSON:
{
  "decision": "EXECUTE" or "HOLD",
  "confidence": 0.00,
  "keyReason": "max 15 words",
  "citedRules": ["defi-001", "defi-003"],
  "newInsight": "a new rule worth adding, or null"
}
`

  try {
    const response = await veniceClient.complete({
      systemPrompt: SPECIALIST_PROMPTS[role],
      userPrompt: prompt,
      maxTokens: 300,
      temperature: 0.2
    })

    return { role, ...JSON.parse(response) }
  } catch (err) {
    console.error(`Council specialist ${role} failed: ${err.message}`)
    // Default ke HOLD kalau specialist error — protective default
    return { role, decision: 'HOLD', confidence: 0, keyReason: 'specialist unavailable', citedRules: [] }
  }
}

module.exports = { runCouncil }
```

---

## Step 7 — Consensus Gate + Decision Logging

**Inspired by**: EvoDS (ACC pattern — compressed verdicts → manager decision)

### Narasi

EvoDS menggunakan ACC (Adaptive Context Compression): sub-agents mengkompresi output mereka sebelum dikirim ke Manager Agent. Manager tidak menerima raw log panjang — hanya compressed verdict.

Di Vibing Farmer, consensus gate adalah "manager" yang menerima 3 compressed verdicts dan memutuskan. Logic-nya sederhana dan deterministic: butuh 2/3 majority DAN minimum confidence. Kalau salah satu tidak terpenuhi → HOLD.

### Code — `frontend/src/council/consensus.js`

```javascript
const { appendDecisionLog } = require('../tracking/logger')

const CONSENSUS_THRESHOLDS = {
  REQUIRED_MAJORITY: 2,   // out of 3 specialists
  MIN_CONFIDENCE: 0.60,   // minimum average confidence to execute
}

function evaluateConsensus(verdicts) {
  const executeVotes = verdicts.filter(v => v.decision === 'EXECUTE')
  const holdVotes = verdicts.filter(v => v.decision === 'HOLD')
  const avgConfidence = verdicts.reduce((s, v) => s + (v.confidence ?? 0), 0) / verdicts.length

  const majorityVotedExecute = executeVotes.length >= CONSENSUS_THRESHOLDS.REQUIRED_MAJORITY
  const confidentEnough = avgConfidence >= CONSENSUS_THRESHOLDS.MIN_CONFIDENCE

  let finalDecision, rejectionReason

  if (majorityVotedExecute && confidentEnough) {
    finalDecision = 'EXECUTE'
    rejectionReason = null
  } else if (!majorityVotedExecute) {
    finalDecision = 'HOLD'
    rejectionReason = `Majority voted HOLD (${holdVotes.length}/3): ${holdVotes.map(v => v.keyReason).join('; ')}`
  } else {
    finalDecision = 'HOLD'
    rejectionReason = `Confidence too low: ${(avgConfidence * 100).toFixed(0)}% < ${CONSENSUS_THRESHOLDS.MIN_CONFIDENCE * 100}%`
  }

  return {
    finalDecision,
    executeVotes: executeVotes.length,
    holdVotes: holdVotes.length,
    avgConfidence,
    verdicts,
    rejectionReason
  }
}

module.exports = { evaluateConsensus }
```

```javascript
// frontend/src/tracking/logger.js
const fs = require('fs').promises
const path = require('path')

const LOG_PATH = path.join(__dirname, '../../data/decisions.jsonl')

async function appendDecisionLog(entry) {
  const line = JSON.stringify(entry) + '\n'
  await fs.appendFile(LOG_PATH, line)
}

async function getPendingDecisions(olderThanDays) {
  const cutoff = Date.now() - (olderThanDays * 86400000)

  try {
    const content = await fs.readFile(LOG_PATH, 'utf8')
    return content
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
      .filter(d => d.status === 'pending_evaluation' && d.timestamp < cutoff)
  } catch {
    return []
  }
}

async function updateDecisionLog(decisionId, updates) {
  // Read all, update matching, write back
  const content = await fs.readFile(LOG_PATH, 'utf8')
  const decisions = content.trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
  const updated = decisions.map(d => d.id === decisionId ? { ...d, ...updates } : d)
  await fs.writeFile(LOG_PATH, updated.map(d => JSON.stringify(d)).join('\n') + '\n')
}

function generateDecisionId() {
  return `dec-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

module.exports = { appendDecisionLog, getPendingDecisions, updateDecisionLog, generateDecisionId }
```

---

## Step 8 — Playbook Storage

**Inspired by**: ACE Stanford (Evolving Playbook — Generator/Reflector/Curator pattern, ICLR 2026)

### Narasi

ACE paper memperkenalkan konsep "playbook sebagai living document" — bukan static prompt, tapi collection of rules yang tumbuh, di-refine, dan di-prune berdasarkan empirical evidence.

Setiap rule punya:
- ID unik (`defi-001`)
- Category (`risk | gas | strategy`)
- Counters `helpful` dan `harmful` — diupdate setiap kali rule dipakai dan outcome diketahui
- Text — the actual rule

Rules dengan `harmful >> helpful` setelah minimum evaluations di-prune otomatis. Ini yang bikin playbook makin akurat seiring waktu tanpa human intervention.

### Code — `frontend/src/memory/playbook.js`

```javascript
const fs = require('fs').promises
const path = require('path')

const PLAYBOOK_PATH = path.join(__dirname, '../../data/playbook.json')

// Default rules — apa yang diketahui di hari pertama
const DEFAULT_PLAYBOOK = [
  {
    id: 'defi-001', category: 'risk', helpful: 0, harmful: 0,
    text: 'TVL drop >20% in 3 days = high exit risk. Avoid entering pool under these conditions.',
    createdAt: Date.now()
  },
  {
    id: 'defi-002', category: 'gas', helpful: 0, harmful: 0,
    text: 'Breakeven period must be under 30 days: gas_usd_cost / daily_yield_improvement < 30',
    createdAt: Date.now()
  },
  {
    id: 'defi-003', category: 'risk', helpful: 0, harmful: 0,
    text: 'Protocols without audit in past 6 months require minimum $50M TVL as safety buffer.',
    createdAt: Date.now()
  },
  {
    id: 'defi-004', category: 'strategy', helpful: 0, harmful: 0,
    text: 'Non-stable asset pairs have significantly higher IL risk during market volatility > 50%.',
    createdAt: Date.now()
  },
  {
    id: 'defi-005', category: 'gas', helpful: 0, harmful: 0,
    text: 'Rebalance only when APY delta > 2% AND position > $500. Smaller positions rarely justify gas.',
    createdAt: Date.now()
  }
]

async function loadPlaybook() {
  try {
    const data = await fs.readFile(PLAYBOOK_PATH, 'utf8')
    return JSON.parse(data)
  } catch {
    await savePlaybook(DEFAULT_PLAYBOOK)
    return DEFAULT_PLAYBOOK
  }
}

async function savePlaybook(rules) {
  await fs.writeFile(PLAYBOOK_PATH, JSON.stringify(rules, null, 2))
}

// Increment helpful or harmful counter untuk satu rule
function incrementCounter(playbook, ruleId, type) {
  return playbook.map(rule =>
    rule.id === ruleId
      ? { ...rule, [type]: rule[type] + 1 }
      : rule
  )
}

// Prune rules yang consistently harmful (ACE pruning pattern)
function pruneHarmfulRules(playbook, minEvals = 5) {
  const before = playbook.length
  const pruned = playbook.filter(rule => {
    const totalEvals = rule.helpful + rule.harmful
    if (totalEvals < minEvals) return true // not enough data yet, keep
    return !(rule.harmful > rule.helpful * 2) // prune if harmful >> helpful
  })

  if (pruned.length < before) {
    console.log(`🗑️ Pruned ${before - pruned.length} harmful rules`)
  }

  return pruned
}

// Format playbook untuk dikirim ke council agent
function formatPlaybookForCouncil(rules) {
  if (rules.length === 0) return '(no rules yet)'
  return rules
    .sort((a, b) => (b.helpful - b.harmful) - (a.helpful - a.harmful)) // sort by net helpfulness
    .map(r => `[${r.id}] helpful=${r.helpful} harmful=${r.harmful} :: ${r.text}`)
    .join('\n')
}

// Generate next available ID
function generateRuleId(existingRules) {
  const nums = existingRules
    .map(r => parseInt(r.id.split('-')[1]))
    .filter(n => !isNaN(n))
  const maxNum = nums.length > 0 ? Math.max(...nums) : 0
  return `defi-${String(maxNum + 1).padStart(3, '0')}`
}

module.exports = {
  loadPlaybook, savePlaybook, incrementCounter,
  pruneHarmfulRules, formatPlaybookForCouncil, generateRuleId
}
```

---

## Step 9 — Execution Layer

**Inspired by**: MetaMask Smart Accounts Kit + 1Shot API

### Narasi

Yang membedakan "autonomous agent" dari "assistant yang butuh konfirmasi" adalah kemampuan execute tanpa human approval per-transaksi.

MetaMask Smart Accounts (ERC-4337) memungkinkan pre-authorized session keys: user sign SEKALI di awal untuk authorize agent execute dalam batas tertentu (max gas, whitelist protocol, max amount per tx). Setelah itu, agent bisa execute tanpa popup MetaMask.

1Shot API adalah middleware yang abstract complexity on-chain transaction — agent cukup bilang "move 100% dari pool A ke pool B" dan 1Shot handle routing, approval, execution.

### Code — `frontend/src/execution/executor.js`

```javascript
const { appendDecisionLog, generateDecisionId } = require('../tracking/logger')

async function executeRebalance(consensus, simResult, state, strategyConfig) {
  if (consensus.finalDecision !== 'EXECUTE') {
    console.log(`⏸️ HOLD: ${consensus.rejectionReason}`)
    await logHoldDecision(consensus, simResult, state)
    return { executed: false, reason: consensus.rejectionReason }
  }

  const proposedPool = simResult.base.recommendedPool
  const currentPool = state.positions[0]?.pool
  const amountUSD = state.positions.reduce((s, p) => s + p.amount, 0)

  console.log(`⚡ Executing rebalance: ${currentPool} → ${proposedPool}`)

  try {
    // 1Shot API call — pre-authorized via session key
    const txResult = await oneShotExecute({
      fromPool: currentPool,
      toPool: proposedPool,
      amountUSD,
      sessionKey: strategyConfig.sessionKey,
      maxSlippageBps: strategyConfig.maxSlippageBps ?? 50, // 0.5%
      deadlineSeconds: 300 // 5 menit untuk tx included
    })

    const decisionEntry = {
      id: generateDecisionId(),
      timestamp: Date.now(),
      type: 'rebalance',
      fromPool: currentPool,
      toPool: proposedPool,
      amountUSD,
      txHash: txResult.hash,
      gasCostUSD: txResult.gasCostUSD,
      simResult: {
        expectedValue: simResult.expectedValue,
        weights: simResult.weights,
        bull: simResult.bull,
        base: simResult.base,
        bear: simResult.bear
      },
      councilVerdicts: consensus.verdicts,
      citedRules: consensus.verdicts.flatMap(v => v.citedRules ?? []),
      councilInsights: consensus.verdicts.map(v => v.newInsight).filter(Boolean),
      status: 'pending_evaluation',
      actualYield7dUSD: null,
      evaluatedAt: null
    }

    await appendDecisionLog(decisionEntry)

    console.log(`✅ Executed! TX: ${txResult.hash}`)
    console.log(`   Gas cost: $${txResult.gasCostUSD.toFixed(2)}`)
    console.log(`   Decision ID: ${decisionEntry.id} (will be evaluated in 7 days)`)

    return { executed: true, txHash: txResult.hash, decisionId: decisionEntry.id }

  } catch (err) {
    console.error(`❌ Execution failed: ${err.message}`)
    return { executed: false, error: err.message }
  }
}

async function oneShotExecute({ fromPool, toPool, amountUSD, sessionKey, maxSlippageBps, deadlineSeconds }) {
  // TODO: Replace with actual 1Shot API call
  // Docs: https://docs.1shot.finance

  const response = await fetch('https://api.1shot.finance/v1/execute', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.ONE_SHOT_API_KEY}`
    },
    body: JSON.stringify({
      from_protocol: fromPool,
      to_protocol: toPool,
      amount_usd: amountUSD,
      session_key: sessionKey,
      max_slippage_bps: maxSlippageBps,
      deadline: Math.floor(Date.now() / 1000) + deadlineSeconds
    })
  })

  if (!response.ok) {
    throw new Error(`1Shot API error: ${response.status} ${await response.text()}`)
  }

  return response.json()
}

async function logHoldDecision(consensus, simResult, state) {
  await appendDecisionLog({
    id: generateDecisionId(),
    timestamp: Date.now(),
    type: 'hold',
    reason: consensus.rejectionReason,
    executeVotes: consensus.executeVotes,
    holdVotes: consensus.holdVotes,
    avgConfidence: consensus.avgConfidence,
    expectedValueUSD: simResult?.expectedValue ?? null,
    status: 'completed'
  })
}

module.exports = { executeRebalance }
```

---

## Step 10 — Outcome Tracker

**Inspired by**: autoresearch (results.tsv — track every experiment outcome) + FinRL (backtesting evaluation)

### Narasi

autoresearch mencatat setiap eksperimen di `results.tsv`: commit hash, val_bpb, status (keep/discard/crash). Agent tahu apa yang berhasil dan apa yang tidak karena ada historical record.

Di Vibing Farmer, outcome tracker adalah komponen TERPISAH yang jalan async — bukan di main loop. Dia evaluate keputusan yang sudah dibuat 7 hari lalu: apakah benar-benar profitable setelah gas dan IL?

Hasil evaluasi ini yang menjadi "ground truth" untuk ACE Reflector. Tanpa outcome tracker, Reflector buta — tidak tahu mana keputusan yang bagus dan mana yang buruk.

**Perbedaan kritis dari ACE original**: ACE evaluate secara immediate (tahu langsung benar/salah). DeFi evaluate secara delayed (butuh 7 hari untuk tahu yield actual). Ini kenapa outcome tracker jalan di cron job terpisah, bukan di dalam main loop.

### Code — `frontend/src/tracking/outcomeTracker.js`

```javascript
const { getPendingDecisions, updateDecisionLog } = require('./logger')
const { runReflector } = require('../memory/reflector')

const EVALUATION_DELAY_DAYS = 7

async function runOutcomeEvaluator() {
  console.log('\n📊 Outcome evaluator running...')

  const pendingDecisions = await getPendingDecisions(EVALUATION_DELAY_DAYS)
  console.log(`   Found ${pendingDecisions.length} decisions ready for evaluation`)

  for (const decision of pendingDecisions) {
    if (decision.type === 'hold') continue // hold decisions tidak ada yang dievaluasi

    try {
      await evaluateDecision(decision)
    } catch (err) {
      console.error(`Failed to evaluate decision ${decision.id}: ${err.message}`)
    }
  }
}

async function evaluateDecision(decision) {
  console.log(`\n🔍 Evaluating decision ${decision.id}`)
  console.log(`   Pool: ${decision.toPool}, Amount: $${decision.amountUSD?.toFixed(0)}`)

  // Calculate actual realized yield setelah 7 hari
  const evalPeriodDays = Math.min(
    (Date.now() - decision.timestamp) / 86400000,
    14 // cap evaluasi di 14 hari
  )

  const actualYield = await calculateRealizedYield({
    poolId: decision.toPool,
    amountUSD: decision.amountUSD,
    startTime: decision.timestamp,
    endTime: Date.now(),
    days: evalPeriodDays
  })

  const gasCost = decision.gasCostUSD ?? 0
  const netResult = actualYield - gasCost
  const wasProfit = netResult > 0

  // Compare dengan simulasi
  const simPrediction = decision.simResult?.expectedValue ?? 0
  const predictionError = Math.abs(simPrediction - netResult)
  const predictionAccuracyPct = simPrediction !== 0
    ? Math.max(0, 100 - (predictionError / Math.abs(simPrediction) * 100))
    : 0

  console.log(`   Actual net: $${netResult.toFixed(2)} (${wasProfit ? '✅ PROFIT' : '❌ LOSS'})`)
  console.log(`   Sim predicted: $${simPrediction.toFixed(2)} | Accuracy: ${predictionAccuracyPct.toFixed(0)}%`)

  // Update decision log
  await updateDecisionLog(decision.id, {
    actualYield7dUSD: actualYield,
    gasCostUSD: gasCost,
    netResultUSD: netResult,
    wasProfit,
    predictionAccuracyPct,
    evalPeriodDays,
    status: 'evaluated',
    evaluatedAt: Date.now()
  })

  // Trigger ACE Reflector dengan outcome ini
  await runReflector(decision, {
    actualYieldUSD: actualYield,
    netResultUSD: netResult,
    wasProfit,
    predictionAccuracyPct
  })
}

async function calculateRealizedYield({ poolId, amountUSD, startTime, endTime, days }) {
  // Fetch historical APY dari DeFiLlama untuk pool ini
  // Hitung: amountUSD × avg_apy × (days/365) - impermanent_loss

  try {
    const historicalAPY = await fetchHistoricalAPY(poolId, startTime, endTime)
    const grossYield = amountUSD * (historicalAPY / 100) * (days / 365)
    const ilLoss = await estimateImpermanentLoss(poolId, startTime, endTime, amountUSD)
    return grossYield - ilLoss
  } catch (err) {
    console.error(`Could not calculate yield for ${poolId}: ${err.message}`)
    return 0
  }
}

async function fetchHistoricalAPY(poolId, startTime, endTime) {
  // DeFiLlama historical chart endpoint
  const resp = await fetch(`https://yields.llama.fi/chart/${poolId}`)
  const { data } = await resp.json()

  // Filter ke range yang relevan dan average
  const relevant = data.filter(d => {
    const ts = new Date(d.timestamp).getTime()
    return ts >= startTime && ts <= endTime
  })

  if (relevant.length === 0) return 0
  return relevant.reduce((s, d) => s + d.apy, 0) / relevant.length
}

async function estimateImpermanentLoss(poolId, startTime, endTime, amountUSD) {
  // Simplified IL estimation
  // Real implementation: compare price ratio at entry vs exit
  return 0 // TODO: implement with price oracle data
}

module.exports = { runOutcomeEvaluator }
```

---

## Step 11 — Reflector

**Inspired by**: ACE Stanford — Reflector Agent (tag rules helpful/harmful, extract insights)

### Narasi

ACE Reflector punya dua tugas: (1) tag setiap playbook rule yang dipakai sebagai helpful atau harmful berdasarkan outcome, (2) extract insight baru dari kegagalan.

Di Vibing Farmer, Reflector jalan async setelah Outcome Tracker selesai evaluasi. Dia menerima `decision` (dengan `citedRules`) dan `outcome` (wasProfit, netResultUSD).

Kalau profitable → semua cited rules dapat `helpful++`. Kalau loss → semua cited rules dapat `harmful++`. Plus Reflector mencoba extract rule baru dari kegagalan — apa yang harusnya diketahui agent sebelum keputusan itu dibuat?

**Key difference dari ACE original**: Di ACE, ground truth immediate (benar/salah langsung diketahui). Di Vibing Farmer, ground truth delayed 7 hari. Tapi mechanism-nya sama.

### Code — `frontend/src/memory/reflector.js`

```javascript
const {
  loadPlaybook, savePlaybook, incrementCounter,
  pruneHarmfulRules, generateRuleId
} = require('./playbook')
const { runCurator } = require('./curator')

async function runReflector(decision, outcome, veniceClient) {
  console.log(`\n🔍 Reflector processing decision ${decision.id}`)
  console.log(`   Outcome: ${outcome.wasProfit ? 'PROFIT' : 'LOSS'} $${outcome.netResultUSD.toFixed(2)}`)

  let playbook = await loadPlaybook()

  // 1. Update counters untuk setiap cited rule — ACE counter layer
  const citedRules = [...new Set(decision.citedRules ?? [])] // deduplicate

  for (const ruleId of citedRules) {
    const tag = outcome.wasProfit ? 'helpful' : 'harmful'
    playbook = incrementCounter(playbook, ruleId, tag)
    console.log(`   Rule [${ruleId}] → ${tag}`)
  }

  // 2. Process council insights yang di-flag saat deliberasi
  if (decision.councilInsights?.length > 0) {
    for (const insight of decision.councilInsights) {
      if (insight) {
        playbook = await runCurator(
          { ruleText: insight, category: 'strategy', reason: 'council flagged during deliberation' },
          decision,
          playbook,
          veniceClient
        )
      }
    }
  }

  // 3. Extract new rule dari failure atau bad prediction
  const simulationWasBad = outcome.predictionAccuracyPct < 40 // prediction off by >60%
  const shouldLearnFromThis = !outcome.wasProfit || simulationWasBad

  if (shouldLearnFromThis) {
    const insight = await extractInsightFromFailure(decision, outcome, veniceClient)
    if (insight?.shouldAddRule) {
      playbook = await runCurator(insight, decision, playbook, veniceClient)
    }
  }

  // 4. Prune consistently harmful rules
  playbook = pruneHarmfulRules(playbook)

  await savePlaybook(playbook)

  console.log(`✅ Reflector done. Playbook: ${playbook.length} rules`)
  return playbook
}

async function extractInsightFromFailure(decision, outcome, veniceClient) {
  const prompt = `
A DeFi yield farming decision was made and evaluated after 7 days.

Decision details:
- Pool chosen: ${decision.toPool}
- Council verdicts: ${JSON.stringify(decision.councilVerdicts?.map(v => ({ role: v.role, decision: v.decision, reason: v.keyReason })))}
- Rules cited: ${decision.citedRules?.join(', ')}

Outcome after 7 days:
- Expected: $${decision.simResult?.expectedValue?.toFixed(2)}
- Actual: $${outcome.netResultUSD.toFixed(2)}
- Result: ${outcome.wasProfit ? 'PROFITABLE' : 'LOSS'}
- Prediction accuracy: ${outcome.predictionAccuracyPct?.toFixed(0)}%

Based on this ${outcome.wasProfit ? 'success' : 'failure'}, what concrete DeFi rule should be added to the playbook?
The rule should be actionable, specific, and help avoid this mistake (or repeat this success) in the future.

Respond ONLY in valid JSON:
{
  "shouldAddRule": true or false,
  "ruleText": "the specific actionable rule",
  "category": "risk" or "gas" or "strategy",
  "reason": "why this rule would help"
}
`

  try {
    const response = await veniceClient.complete({
      systemPrompt: 'You are a DeFi strategy learning system. Extract concrete, actionable rules from decision outcomes. Output ONLY valid JSON.',
      userPrompt: prompt,
      maxTokens: 250,
      temperature: 0.4
    })

    return JSON.parse(response)
  } catch (err) {
    console.error(`Insight extraction failed: ${err.message}`)
    return null
  }
}

module.exports = { runReflector }
```

---

## Step 12 — Curator

**Inspired by**: ACE Stanford — Curator Agent (ADD new rules, prevent context collapse)

### Narasi

ACE Curator menambahkan rules secara incremental — tidak rewrite seluruh playbook (itu yang menyebabkan "context collapse" di pendekatan naif). Setiap ADD operation kecil dan targeted.

Sebelum ADD, Curator check duplikat menggunakan Jaccard similarity sederhana. Kalau rule yang sangat mirip sudah ada, increment counter-nya daripada tambah rule baru yang redundant.

### Code — `frontend/src/memory/curator.js`

```javascript
const { generateRuleId, savePlaybook } = require('./playbook')
const { runBulletpointAnalyzer } = require('./analyzer')

const MAX_PLAYBOOK_SIZE = 50 // trigger dedup kalau lebih dari ini

async function runCurator(insight, decision, playbook, veniceClient) {
  if (!insight?.ruleText || insight.ruleText.trim().length < 10) {
    return playbook
  }

  console.log(`📝 Curator processing insight: "${insight.ruleText.slice(0, 60)}..."`)

  // Check for similar existing rules
  const existingRule = findSimilarRule(insight.ruleText, playbook)

  if (existingRule) {
    console.log(`   Similar rule exists [${existingRule.id}] — skipping duplicate`)
    // Reinforce existing rule instead
    return playbook.map(r =>
      r.id === existingRule.id
        ? { ...r, helpful: r.helpful + 1 }
        : r
    )
  }

  // ADD new rule (ACE ADD operation)
  const newRule = {
    id: generateRuleId(playbook),
    category: insight.category ?? 'strategy',
    helpful: 0,
    harmful: 0,
    text: insight.ruleText,
    createdAt: Date.now(),
    sourceDecision: decision.id,
    addedReason: insight.reason
  }

  playbook = [...playbook, newRule]
  console.log(`✅ Added rule [${newRule.id}]: ${newRule.text}`)

  // Trigger BulletpointAnalyzer kalau playbook terlalu besar
  if (playbook.length > MAX_PLAYBOOK_SIZE) {
    console.log(`📚 Playbook size (${playbook.length}) > ${MAX_PLAYBOOK_SIZE} — running dedup...`)
    playbook = await runBulletpointAnalyzer(playbook, veniceClient)
  }

  await savePlaybook(playbook)
  return playbook
}

function findSimilarRule(newText, playbook, threshold = 0.65) {
  const newWords = tokenize(newText)

  for (const rule of playbook) {
    const existingWords = tokenize(rule.text)
    const similarity = jaccardSimilarity(newWords, existingWords)
    if (similarity >= threshold) return rule
  }

  return null
}

function tokenize(text) {
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 3) // ignore short words
  )
}

function jaccardSimilarity(setA, setB) {
  const intersection = new Set([...setA].filter(w => setB.has(w)))
  const union = new Set([...setA, ...setB])
  return union.size === 0 ? 0 : intersection.size / union.size
}

module.exports = { runCurator }
```

---

## Step 13 — BulletpointAnalyzer (Simplified)

**Inspired by**: ACE Stanford — BulletpointAnalyzer (FAISS + sentence-transformers → simplified ke Jaccard + Venice AI)

### Narasi

ACE menggunakan FAISS + sentence-transformers untuk detect semantically similar rules, lalu merge mereka via LLM. Untuk Vibing Farmer, kita simplify: Jaccard similarity untuk detect candidates, Venice AI untuk merge.

Yang penting dari ACE pattern: saat merge, **sum the counters**. Rule A dengan `helpful=3` dan rule B dengan `helpful=2` yang di-merge jadi satu rule dengan `helpful=5`. Empirical evidence-nya dipertahankan, tidak hilang.

### Code — `frontend/src/memory/analyzer.js`

```javascript
async function runBulletpointAnalyzer(playbook, veniceClient, threshold = 0.60) {
  console.log(`\n🧹 BulletpointAnalyzer running (${playbook.length} rules)`)

  const byCategory = groupBy(playbook, 'category')
  const result = []

  for (const [category, rules] of Object.entries(byCategory)) {
    const clusters = findSimilarClusters(rules, threshold)
    console.log(`   [${category}]: ${rules.length} rules → ${clusters.length} clusters`)

    for (const cluster of clusters) {
      if (cluster.length === 1) {
        result.push(cluster[0])
        continue
      }

      // Merge similar rules — Venice AI does the synthesis
      const merged = await mergeRuleCluster(cluster, veniceClient)
      result.push(merged)
      console.log(`   Merged ${cluster.length} rules: [${cluster.map(r => r.id).join(', ')}] → [${merged.id}]`)
    }
  }

  console.log(`   Result: ${playbook.length} → ${result.length} rules`)
  return result
}

async function mergeRuleCluster(cluster, veniceClient) {
  const prompt = `
These DeFi strategy rules cover similar ground and should be merged into one comprehensive rule:

${cluster.map(r => `[${r.id}] helpful=${r.helpful} harmful=${r.harmful} :: ${r.text}`).join('\n')}

Merge them into a single, precise, actionable rule that captures all key insights.
Keep it under 30 words. Be specific.

Respond ONLY in valid JSON:
{
  "mergedRule": "the merged rule text"
}
`

  try {
    const response = await veniceClient.complete({
      systemPrompt: 'You are a DeFi rule consolidator. Merge similar rules. Output ONLY valid JSON.',
      userPrompt: prompt,
      maxTokens: 150,
      temperature: 0.2
    })

    const { mergedRule } = JSON.parse(response)

    // Sum counters — ACE pattern: preserve empirical evidence
    return {
      id: cluster[0].id, // keep oldest ID
      category: cluster[0].category,
      helpful: cluster.reduce((s, r) => s + r.helpful, 0),
      harmful: cluster.reduce((s, r) => s + r.harmful, 0),
      text: mergedRule,
      createdAt: cluster[0].createdAt,
      mergedFrom: cluster.map(r => r.id),
      mergedAt: Date.now()
    }
  } catch (err) {
    // Fallback: keep the rule with highest net helpfulness
    console.error(`Merge failed: ${err.message} — keeping best rule`)
    return cluster.sort((a, b) => (b.helpful - b.harmful) - (a.helpful - a.harmful))[0]
  }
}

function findSimilarClusters(rules, threshold) {
  const used = new Set()
  const clusters = []

  for (let i = 0; i < rules.length; i++) {
    if (used.has(i)) continue
    const cluster = [rules[i]]
    used.add(i)

    for (let j = i + 1; j < rules.length; j++) {
      if (used.has(j)) continue
      const sim = jaccardSimilarity(tokenize(rules[i].text), tokenize(rules[j].text))
      if (sim >= threshold) {
        cluster.push(rules[j])
        used.add(j)
      }
    }

    clusters.push(cluster)
  }

  return clusters
}

function tokenize(text) {
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 3)
  )
}

function jaccardSimilarity(setA, setB) {
  const intersection = new Set([...setA].filter(w => setB.has(w)))
  const union = new Set([...setA, ...setB])
  return union.size === 0 ? 0 : intersection.size / union.size
}

function groupBy(arr, key) {
  return arr.reduce((acc, item) => {
    const k = item[key]
    if (!acc[k]) acc[k] = []
    acc[k].push(item)
    return acc
  }, {})
}

module.exports = { runBulletpointAnalyzer }
```

---

## Step 14 — Wiring Semua Komponen

### Code — `frontend/src/main.js`

```javascript
const { startAutonomousLoop } = require('./core/loop')
const { runOutcomeEvaluator } = require('./tracking/outcomeTracker')

async function main() {
  console.log('🌾 ============================================')
  console.log('   Vibing Farmer — Autonomous DeFi Agent')
  console.log('   Loop + Council + Simulation + ACE Memory')
  console.log('🌾 ============================================\n')

  // Validate strategy config
  const config = await loadAndValidateConfig()
  console.log(`✅ Strategy config loaded`)
  console.log(`   Risk tolerance: ${config.riskTolerance}`)
  console.log(`   Whitelist: ${config.whitelist.join(', ')}`)
  console.log(`   Cooldown: ${config.cooldownHours}h\n`)

  // Run outcome evaluator once at startup (catch up on any pending evaluations)
  await runOutcomeEvaluator()

  // Schedule outcome evaluator to run every 24 hours
  setInterval(async () => {
    try {
      await runOutcomeEvaluator()
    } catch (err) {
      console.error('Outcome evaluator error:', err.message)
    }
  }, 24 * 60 * 60 * 1000)

  // Start the main autonomous loop — blocks forever
  await startAutonomousLoop()
}

async function loadAndValidateConfig() {
  const fs = require('fs').promises
  const path = require('path')

  try {
    const raw = await fs.readFile(path.join(__dirname, '../config/strategy.json'), 'utf8')
    return JSON.parse(raw)
  } catch {
    throw new Error('strategy.json not found. Copy config/strategy.example.json and fill in your values.')
  }
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
```

---

## Strategy Config Schema

File: `config/strategy.json`

```json
{
  "walletAddress": "0xYourSmartAccountAddress",
  "sessionKey": "0xYourPreAuthorizedSessionKey",

  "riskTolerance": "moderate",

  "whitelist": [
    "aave-v3",
    "compound-v3",
    "curve",
    "convex",
    "lido"
  ],

  "thresholds": {
    "TURBULENCE_CRITICAL": 0.75,
    "MIN_APY_DELTA_PERCENT": 2.0,
    "MIN_TVL_USD": 5000000,
    "MAX_GAS_USD": 25,
    "MAX_BREAKEVEN_DAYS": 45,
    "MIN_COOLDOWN_HOURS": 12
  },

  "minExpectedValueUSD": 15,

  "maxSlippageBps": 50,

  "loopIntervalMinutes": 30,

  "evaluation": {
    "delayDays": 7,
    "runScheduleHours": 24
  }
}
```

---

## Summary: Urutan Build vs Research Source

| Step | Komponen | Inspired By | Output |
|------|----------|-------------|--------|
| 1 | State/Action/Reward | FinRL | `state.js` — formalized data model |
| 2 | Autonomous Loop | autoresearch (Karpathy) | `loop.js` — never-stop cycle |
| 3 | Parallel Fetch | EvoAgentX (DAG) | `fetcher.js` — Promise.all fetch |
| 4 | Fast-fail Gates | FinRL (Turbulence Index) | `gates.js` — math-only guards |
| 5 | Simulation Engine | ZX / MiroFish (lightweight) | `simulator.js` — 3 parallel scenarios |
| 6 | AI Council | TradingAgents | `council.js` — 3 specialist agents |
| 7 | Consensus + Logging | EvoDS (ACC) | `consensus.js` — 2/3 majority gate |
| 8 | Playbook Storage | ACE Stanford | `playbook.js` — evolving rules |
| 9 | Execution | 1Shot + MetaMask | `executor.js` — session key tx |
| 10 | Outcome Tracker | autoresearch results.tsv | `outcomeTracker.js` — 7-day eval |
| 11 | Reflector | ACE Stanford | `reflector.js` — tag rules |
| 12 | Curator | ACE Stanford | `curator.js` — ADD rules |
| 13 | BulletpointAnalyzer | ACE Stanford | `analyzer.js` — dedup + merge |
| 14 | Main Orchestrator | — | `main.js` — wire everything |

---

*Build guide ini mencerminkan sistem Vibing Farmer versi penuh. Setiap komponen bisa di-develop dan di-test secara independen sebelum di-integrate.*
