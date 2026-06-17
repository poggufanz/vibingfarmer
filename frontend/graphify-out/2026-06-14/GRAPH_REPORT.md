# Graph Report - frontend  (2026-06-13)

## Corpus Check
- 95 files · ~79,164 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 793 nodes · 1606 edges · 37 communities (35 shown, 2 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 44 edges (avg confidence: 0.87)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `7af8443c`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 35|Community 35]]
- [[_COMMUNITY_Community 36|Community 36]]

## God Nodes (most connected - your core abstractions)
1. `App()` - 61 edges
2. `Default Vault Advisor System Prompt with MDP` - 24 edges
3. `loadSettings()` - 22 edges
4. `DeFi Vault Advisor System Prompt` - 22 edges
5. `generateStrategy()` - 16 edges
6. `getReadProvider()` - 15 edges
7. `handler()` - 14 edges
8. `rateLimit()` - 12 edges
9. `t()` - 12 edges
10. `API Proxies (ai, search, relay)` - 12 edges

## Surprising Connections (you probably didn't know these)
- `allowedOrigins()` --conceptually_related_to--> `API Proxies (ai, search, relay)`  [INFERRED]
  api/_guard.js → DEPLOY-CLOUDFLARE.md
- `formatTime()` --calls--> `loadSettings()`  [EXTRACTED]
  src/components/HistoryPanel.jsx → src/settingsStore.js
- `generateStrategy()` --calls--> `validateVeniceResponse Function`  [EXTRACTED]
  src/venice.js → src/skills/vault-advisor.md
- `Default Vault Advisor (MDP Framing)` --conceptually_related_to--> `DeFi Vault Advisor — Venice AI System Prompt Skill`  [INFERRED]
  src/skills/default/vault-advisor.md → src/skills/vault-advisor.md
- `Default Vault Advisor System Prompt with MDP` --references--> `Venice AI`  [INFERRED]
  src/skills/default/vault-advisor.md → src/skills/vault-advisor.md

## Import Cycles
- 1-file cycle: `functions/api/ai.js -> functions/api/ai.js`
- 1-file cycle: `functions/api/search.js -> functions/api/search.js`
- 1-file cycle: `functions/api/relay.js -> functions/api/relay.js`

## Communities (37 total, 2 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.05
Nodes (70): emergencyWithdraw(), emit(), handleWorkerMessage(), listeners, onAgentEvent(), startBackgroundAgent(), stopBackgroundAgent(), updateAgentConfig() (+62 more)

### Community 1 - "Community 1"
Cohesion: 0.09
Nodes (32): buildLesson(), createEntry(), loadAllMemory(), readMemory(), writeMemory(), broadcastFallback(), computeExecId(), DEPOSIT_DOMAIN() (+24 more)

### Community 2 - "Community 2"
Cohesion: 0.06
Nodes (38): fetchTotalDeposits(), DEPOSITOR_ABI, REGISTRY_ABI, VAULT_ABI, detectMetaMaskVersion(), requireFlask(), OrchestratorAgent, getReadProvider() (+30 more)

### Community 3 - "Community 3"
Cohesion: 0.09
Nodes (39): avgConf(), clampConf(), councilVerdict(), firstNonDeposit(), marketSpecialist(), result(), riskSpecialist(), ROLE_LABEL (+31 more)

### Community 4 - "Community 4"
Cohesion: 0.11
Nodes (33): ALLOWED_MODELS, handler(), onRequest, readBody(), applyCors(), _buckets, clientIp(), DEV_ORIGINS (+25 more)

### Community 5 - "Community 5"
Cohesion: 0.06
Nodes (13): PARTNERS, STANDARDS, groupV, lineV, SCENE_2, SCENE_3, SCENE_VIDEO, fmtSeed() (+5 more)

### Community 6 - "Community 6"
Cohesion: 0.09
Nodes (38): Default Vault Advisor (MDP Framing), Live Market Context Usage, Markov Decision Process Framing, Default Vault Advisor System Prompt with MDP, VAULT DATA SOURCE NOTE, DeFi Vault Advisor — Venice AI System Prompt Skill, Judging Defensibility, Runtime Integration — venice.js (+30 more)

### Community 7 - "Community 7"
Cohesion: 0.08
Nodes (26): AGENT_PROTOCOLS, agoLabel(), computeOrchestratorState(), COUNCIL_RESOLVED_LABEL, COUNCIL_ROLE_META, COUNCIL_SIGNAL_TONE, DecisionLogPanel(), ExecuteCard() (+18 more)

### Community 8 - "Community 8"
Cohesion: 0.09
Nodes (24): allowedOrigins(), AGENT_VAULT_DEPOSITOR_ADDRESS, API Handlers (api/*.js), API Proxies (ai, search, relay), Cloudflare Pages, DEEPSEEK_API_KEY, dist/ directory, _headers (+16 more)

### Community 9 - "Community 9"
Cohesion: 0.05
Nodes (44): card, cardPad, dot(), eyebrow, fmtAmt(), formatTime(), getTrendingVaults(), HomePage() (+36 more)

### Community 10 - "Community 10"
Cohesion: 0.10
Nodes (10): card, ContractRow(), dangerBtn, eyebrow, inputStyle, miniBtn, SettingsPage(), short() (+2 more)

### Community 11 - "Community 11"
Cohesion: 0.08
Nodes (28): AgentDashboard(), ALERT_META, AlertCard(), alertLine(), fmt(), formatTime(), mono, sectionLabel (+20 more)

### Community 12 - "Community 12"
Cohesion: 0.13
Nodes (14): Aave v3 (USDC), AVAILABLE VAULTS FOR THIS SESSION, Fluid Protocol (USDC), HOW TO USE LIVE MARKET CONTEXT, Morpho Blue (USDC), OUTPUT REQUIREMENTS, Pendle Finance (PT-USDC), PROTOCOL KNOWLEDGE BASE (+6 more)

### Community 13 - "Community 13"
Cohesion: 0.15
Nodes (6): CONTRACTS, ExplorerPage(), SECURITY, MOCK_VAULT_C_ADDRESS, MOCK_VAULT_D_ADDRESS, getStrategies()

### Community 14 - "Community 14"
Cohesion: 0.14
Nodes (8): AGENT_SETTINGS_DEFAULTS, SPEED_MS, TWEAK_DEFAULTS, WORKER_STEP_MAP, isDevMode(), createMonitorLoop(), councilOutcome(), reflect()

### Community 15 - "Community 15"
Cohesion: 0.25
Nodes (10): backBtn, divider, extLink, formatAbs(), formatRel(), ghostBtn, sectionLabel, shortHash() (+2 more)

### Community 16 - "Community 16"
Cohesion: 0.17
Nodes (9): shortAddr(), SkillDetailModal(), STEP_LABELS, formatProtocol(), PROTOCOL_NAMES, SkillCard(), SkillReviewCard(), translateSkill() (+1 more)

### Community 17 - "Community 17"
Cohesion: 0.33
Nodes (9): addEntry(), clearStrategies(), getHistorySummary(), getReasoningLog(), KEYS, positionsFromHistory(), readStore(), saveReasoning() (+1 more)

### Community 18 - "Community 18"
Cohesion: 0.22
Nodes (13): gaussian(), makeRng(), allocationsFromStrategy(), blendApy(), deriveScenarioParams(), distribution(), gasToUsdc(), runScenario() (+5 more)

### Community 19 - "Community 19"
Cohesion: 0.28
Nodes (6): STEPS, Icon(), Sidebar(), STEPS, TopBar(), getSidebarPath()

### Community 20 - "Community 20"
Cohesion: 0.13
Nodes (4): TweakRadio(), TweakSection(), TweaksPanel(), useTweaks()

### Community 21 - "Community 21"
Cohesion: 0.46
Nodes (6): clearGrant(), hasValidGrant(), loadGrant(), saveGrant(), rehydrateSession(), initSession()

### Community 22 - "Community 22"
Cohesion: 0.26
Nodes (9): buildDecisionRecord(), getDecisions(), getDecisionSummary(), majority(), POSITIVE, read(), recordDecision(), ROLES (+1 more)

### Community 23 - "Community 23"
Cohesion: 0.24
Nodes (10): ActivityPanel(), EVENT_STYLES, PalettePicker(), PALETTES, PermissionPanel(), SkillPanel(), WalletPanel(), MemoryModal() (+2 more)

### Community 24 - "Community 24"
Cohesion: 0.24
Nodes (11): proposeRule(), slug(), VALID_ROLES, combine(), MERGE_CFG, mergePass(), trigramCosine(), trigrams() (+3 more)

### Community 25 - "Community 25"
Cohesion: 0.25
Nodes (7): Cloudflare Pages project settings (Git integration), Deploy to Cloudflare Pages, Deploy (your call — pick one), Environment variables (Pages → Settings → Variables and Secrets), How it's wired, Test locally before you deploy, Verify-on-deploy checklist (Functions are the risk surface)

### Community 26 - "Community 26"
Cohesion: 0.18
Nodes (7): ConnectCard(), PermissionCard(), RISK_OPTIONS, SuccessCard(), THINK_MSGS, THINK_STEPS, ThinkingCard()

### Community 27 - "Community 27"
Cohesion: 0.22
Nodes (6): esc(), logActivity(), MARKER, MARKER_CLASS, showAgentDetail(), STEP_IDS

### Community 28 - "Community 28"
Cohesion: 0.31
Nodes (9): ethCall(), INTERVALS, runApyCheck(), runPositionCheck(), runRiskCheck(), SELECTORS, startMonitoring(), stopMonitoring() (+1 more)

### Community 29 - "Community 29"
Cohesion: 0.31
Nodes (6): approveSkill(), esc(), loadAllSkills(), loadSkill(), renderSkillEditor(), saveSkill()

### Community 30 - "Community 30"
Cohesion: 0.16
Nodes (7): formatTime(), HistoryPanel(), TABS, TxList(), clearAllHistory(), ROUTES, useNavigateTo()

### Community 31 - "Community 31"
Cohesion: 0.48
Nodes (5): getCycles(), getJournalSummary(), read(), saveCycle(), write()

### Community 32 - "Community 32"
Cohesion: 0.80
Nodes (4): assertScope(), maxAtRisk(), toAuthorizeArgs(), toSummary()

### Community 33 - "Community 33"
Cohesion: 0.67
Nodes (3): /api/relay proxy, @uxly/1shot-client, viem

### Community 36 - "Community 36"
Cohesion: 0.73
Nodes (4): SkillDrawer(), clearUserSkill(), loadVaultSkill(), saveUserSkill()

## Knowledge Gaps
- **166 isolated node(s):** `DEV_ORIGINS`, `_buckets`, `TRUST_PROXY_HOPS`, `onRequest`, `cdp` (+161 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `venice.js Integration Code` connect `Community 0` to `Community 6`?**
  _High betweenness centrality (0.111) - this node is a cross-community bridge._
- **Why does `DeFi Vault Advisor System Prompt` connect `Community 6` to `Community 0`?**
  _High betweenness centrality (0.110) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `Default Vault Advisor System Prompt with MDP` (e.g. with `DeFi Vault Advisor System Prompt` and `Venice AI`) actually correct?**
  _`Default Vault Advisor System Prompt with MDP` has 2 INFERRED edges - model-reasoned connections that need verification._
- **Are the 2 inferred relationships involving `DeFi Vault Advisor System Prompt` (e.g. with `Default Vault Advisor System Prompt with MDP` and `Venice AI`) actually correct?**
  _`DeFi Vault Advisor System Prompt` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `DEV_ORIGINS`, `_buckets`, `TRUST_PROXY_HOPS` to the rest of the system?**
  _166 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.05225576111652061 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.08897959183673469 - nodes in this community are weakly interconnected._