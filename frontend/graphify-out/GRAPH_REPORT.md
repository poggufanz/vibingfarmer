# Graph Report - C:\SharredData\project\competition\vibing-farmer\frontend  (2026-06-17)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 764 nodes · 1557 edges · 39 communities (37 shown, 2 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 29 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `2cde2869`
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
- [[_COMMUNITY_Community 38|Community 38]]

## God Nodes (most connected - your core abstractions)
1. `App()` - 67 edges
2. `Default Vault Advisor System Prompt with MDP` - 24 edges
3. `loadSettings()` - 23 edges
4. `DeFi Vault Advisor System Prompt` - 22 edges
5. `ExplorerPage` - 21 edges
6. `AgentDashboard` - 19 edges
7. `generateStrategy()` - 16 edges
8. `getReadProvider()` - 15 edges
9. `handler()` - 13 edges
10. `t()` - 12 edges

## Surprising Connections (you probably didn't know these)
- `generateStrategy()` --calls--> `validateVeniceResponse Function`  [EXTRACTED]
  src/venice.js → src/skills/vault-advisor.md
- `formatTime()` --calls--> `loadSettings()`  [EXTRACTED]
  src/components/HistoryPanel.jsx → src/settingsStore.js
- `Default Vault Advisor (MDP Framing)` --conceptually_related_to--> `DeFi Vault Advisor — Venice AI System Prompt Skill`  [INFERRED]
  src/skills/default/vault-advisor.md → src/skills/vault-advisor.md
- `Default Vault Advisor System Prompt with MDP` --references--> `Venice AI`  [INFERRED]
  src/skills/default/vault-advisor.md → src/skills/vault-advisor.md
- `handler()` --calls--> `applyCors()`  [INFERRED]
  api/relay.js → api/_guard.js

## Import Cycles
- 1-file cycle: `src/app.jsx -> src/app.jsx`
- 2-file cycle: `src/app.jsx -> src/components/NotificationCenter.jsx -> src/app.jsx`

## Communities (39 total, 2 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.06
Nodes (45): buildLesson(), createEntry(), loadAllMemory(), readMemory(), writeMemory(), OrchestratorAgent, createOrchestratorAccount(), createWorkerRedelegations() (+37 more)

### Community 1 - "Community 1"
Cohesion: 0.05
Nodes (41): card, cardPad, dot(), eyebrow, fmtAmt(), formatTime(), getTrendingVaults(), HomePage() (+33 more)

### Community 2 - "Community 2"
Cohesion: 0.08
Nodes (49): buildStrategy(), attestStrategyOnChain(), formatAttestation(), hashStrategy(), saveStrategy(), askVeniceJson(), buildFallbackForParams(), callChatCompletions() (+41 more)

### Community 3 - "Community 3"
Cohesion: 0.08
Nodes (43): avgConf(), clampConf(), councilVerdict(), firstNonDeposit(), marketSpecialist(), result(), riskSpecialist(), ROLE_LABEL (+35 more)

### Community 4 - "Community 4"
Cohesion: 0.08
Nodes (34): ALLOWED_MODELS, handler(), onRequest, readBody(), allowedOrigins(), applyCors(), _buckets, clientIp() (+26 more)

### Community 5 - "Community 5"
Cohesion: 0.08
Nodes (42): Default Vault Advisor (MDP Framing), Live Market Context Usage, Markov Decision Process Framing, Default Vault Advisor System Prompt with MDP, VAULT DATA SOURCE NOTE, DeFi Vault Advisor — Venice AI System Prompt Skill, Judging Defensibility, Runtime Integration — venice.js (+34 more)

### Community 6 - "Community 6"
Cohesion: 0.06
Nodes (11): PARTNERS, STANDARDS, groupV, lineV, SCENE_2, SCENE_3, SCENE_VIDEO, fmtWeth() (+3 more)

### Community 7 - "Community 7"
Cohesion: 0.08
Nodes (25): AGENT_PROTOCOLS, agoLabel(), computeOrchestratorState(), COUNCIL_RESOLVED_LABEL, COUNCIL_ROLE_META, COUNCIL_SIGNAL_TONE, DecisionLogPanel(), ExecuteCard() (+17 more)

### Community 8 - "Community 8"
Cohesion: 0.10
Nodes (15): AGENT_SETTINGS_DEFAULTS, LandingHero, SPEED_MS, TWEAK_DEFAULTS, WORKER_STEP_MAP, DEPOSITOR_ABI, REGISTRY_ABI, VAULT_ABI (+7 more)

### Community 9 - "Community 9"
Cohesion: 0.09
Nodes (12): card, ContractRow(), dangerBtn, eyebrow, inputStyle, miniBtn, SettingsPage(), short() (+4 more)

### Community 10 - "Community 10"
Cohesion: 0.13
Nodes (16): ALERT_META, alertLine(), fmt(), mono, sectionLabel, textBtn(), u(), whyText() (+8 more)

### Community 11 - "Community 11"
Cohesion: 0.12
Nodes (17): detectMetaMaskVersion(), requireFlask(), BASE_SEPOLIA_PARAMS, connectWallet(), getAccountsSilent(), getProvider(), onAccountsChanged(), onContractEvent() (+9 more)

### Community 12 - "Community 12"
Cohesion: 0.12
Nodes (16): ActivityPanel(), EVENT_STYLES, PalettePicker(), PALETTES, PermissionPanel(), SkillPanel(), WalletPanel(), MemoryModal() (+8 more)

### Community 13 - "Community 13"
Cohesion: 0.24
Nodes (11): fetchTotalDeposits(), App(), applyChainPositions(), keyFor(), loadPersistedPositions(), mergePositions(), persistPositions(), reconcilePositionsFromChain() (+3 more)

### Community 14 - "Community 14"
Cohesion: 0.17
Nodes (7): STEP_LABELS, formatProtocol(), PROTOCOL_NAMES, SkillCard(), SkillReviewCard(), translateSkill(), VAULT_LETTERS

### Community 15 - "Community 15"
Cohesion: 0.13
Nodes (14): Aave v3 (USDC), AVAILABLE VAULTS FOR THIS SESSION, Fluid Protocol (USDC), HOW TO USE LIVE MARKET CONTEXT, Morpho Blue (USDC), OUTPUT REQUIREMENTS, Pendle Finance (PT-USDC), PROTOCOL KNOWLEDGE BASE (+6 more)

### Community 16 - "Community 16"
Cohesion: 0.22
Nodes (13): gaussian(), makeRng(), allocationsFromStrategy(), blendApy(), deriveScenarioParams(), distribution(), gasToUsdc(), runScenario() (+5 more)

### Community 17 - "Community 17"
Cohesion: 0.14
Nodes (3): TweakRadio(), TweakSection(), useTweaks()

### Community 18 - "Community 18"
Cohesion: 0.23
Nodes (9): clearGrant(), hasValidGrant(), loadGrant(), saveGrant(), rehydrateSession(), clearSession(), hasSession(), initSession() (+1 more)

### Community 19 - "Community 19"
Cohesion: 0.23
Nodes (11): formatTime(), fetchMarketContext(), formatMarketContext(), I18N, loadSettings(), parse(), saveSetting(), SECRET_KEYS (+3 more)

### Community 20 - "Community 20"
Cohesion: 0.19
Nodes (7): STEPS, Icon(), Sidebar(), STEPS, TopBar(), getSidebarPath(), ROUTES

### Community 21 - "Community 21"
Cohesion: 0.24
Nodes (11): emergencyWithdraw(), emit(), handleWorkerMessage(), listeners, onAgentEvent(), startBackgroundAgent(), stopBackgroundAgent(), updateAgentConfig() (+3 more)

### Community 22 - "Community 22"
Cohesion: 0.26
Nodes (9): buildDecisionRecord(), getDecisions(), getDecisionSummary(), majority(), POSITIVE, read(), recordDecision(), ROLES (+1 more)

### Community 23 - "Community 23"
Cohesion: 0.18
Nodes (4): CONTRACTS, SECURITY, ExplorerPage, MOCK_VAULT_C_ADDRESS

### Community 24 - "Community 24"
Cohesion: 0.33
Nodes (10): addEntry(), getHistorySummary(), getReasoningLog(), getStrategies(), getTransactions(), KEYS, positionsFromHistory(), readStore() (+2 more)

### Community 25 - "Community 25"
Cohesion: 0.18
Nodes (7): ConnectCard(), PermissionCard(), RISK_OPTIONS, SuccessCard(), THINK_MSGS, THINK_STEPS, ThinkingCard()

### Community 26 - "Community 26"
Cohesion: 0.31
Nodes (9): ethCall(), INTERVALS, runApyCheck(), runPositionCheck(), runRiskCheck(), SELECTORS, startMonitoring(), stopMonitoring() (+1 more)

### Community 27 - "Community 27"
Cohesion: 0.22
Nodes (5): formatTime(), TABS, TxList(), clearAllHistory(), useNavigateTo()

### Community 28 - "Community 28"
Cohesion: 0.24
Nodes (7): fmtDur(), pctBtn, WithdrawModal(), StepRail(), InputScreen(), t(), readVaultDepositTimestamp()

### Community 29 - "Community 29"
Cohesion: 0.31
Nodes (6): approveSkill(), esc(), loadAllSkills(), loadSkill(), renderSkillEditor(), saveSkill()

### Community 30 - "Community 30"
Cohesion: 0.22
Nodes (5): backBtn, divider, extLink, ghostBtn, sectionLabel

### Community 31 - "Community 31"
Cohesion: 0.33
Nodes (5): buildCouncilInput(), buildSpecialistPrompt(), ROLE_LABEL, ROLE_SYSTEM, runSpecialist()

### Community 32 - "Community 32"
Cohesion: 0.48
Nodes (5): getCycles(), getJournalSummary(), read(), saveCycle(), write()

### Community 33 - "Community 33"
Cohesion: 0.67
Nodes (5): clearResume(), hasAgents(), keyFor(), loadResume(), saveResume()

### Community 34 - "Community 34"
Cohesion: 0.70
Nodes (3): clearUserSkill(), loadVaultSkill(), saveUserSkill()

### Community 35 - "Community 35"
Cohesion: 0.80
Nodes (4): assertScope(), maxAtRisk(), toAuthorizeArgs(), toSummary()

## Knowledge Gaps
- **153 isolated node(s):** `DEV_ORIGINS`, `_buckets`, `TRUST_PROXY_HOPS`, `ALLOWED_MODELS`, `DEPOSIT_INPUTS` (+148 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `validateVeniceResponse Function` connect `Community 5` to `Community 2`?**
  _High betweenness centrality (0.126) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `Default Vault Advisor System Prompt with MDP` (e.g. with `DeFi Vault Advisor System Prompt` and `Venice AI`) actually correct?**
  _`Default Vault Advisor System Prompt with MDP` has 2 INFERRED edges - model-reasoned connections that need verification._
- **Are the 2 inferred relationships involving `DeFi Vault Advisor System Prompt` (e.g. with `Default Vault Advisor System Prompt with MDP` and `Venice AI`) actually correct?**
  _`DeFi Vault Advisor System Prompt` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `DEV_ORIGINS`, `_buckets`, `TRUST_PROXY_HOPS` to the rest of the system?**
  _153 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.06409130816505706 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.05254237288135593 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.07676767676767676 - nodes in this community are weakly interconnected._