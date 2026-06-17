# Security & Privacy — Vibing Farmer

> **Skill Reference:** security-review + data-privacy-compliance
> **Version:** 2.0 | **Date:** May 27, 2026
> **Purpose:** Technical documentation of the threat model, security controls, data privacy, and compliance frameworks

---

## 1. Security & Privacy Overview

Vibing Farmer is engineered around the principle of **per-agent permission-bounded execution** — each agent is strictly confined to a specific vault with a predefined allocation. No single agent ever receives full access to the user's wallet. All execution is strictly bounded by ERC-7715 scoped permissions per `agentId`, which the user specifies and controls directly.

**Core security principles:**
- No admin keys or privileged roles exist in the smart contract
- Permission scopes are enforced on-chain per `agentId` (reverts on violation, never failing silently)
- A single worker agent failure cannot compromise other agents or execute actions outside its defined permission scope
- Venice AI does not retain user data (no data retention policy)
- Skill files can only be read after user approval — they cannot be modified mid-execution
- Memory files are append-only — they cannot be overwritten or deleted by agents
- No backend server stores credentials or private keys

---

## 2. Data Classification

| Data Type | Classification | Location | Sensitive? |
|-----------|----------------|----------|------------|
| Wallet address | Public (on-chain) | Blockchain | No |
| Per-agent permission context (ERC-7715) | Semi-private | Browser session + 1Shot relay | Yes |
| USDC amount + risk preference | User input | Venice AI API (ephemeral) | Low |
| AgentId + vault target | Operational | Local skill file + on-chain | Low |
| Skill files (agent parameters) | Operational | Local (`agents/session-{id}/`) | Low |
| Memory files (execution logs) | Operational | Local (`agents/memory/`) | Low |
| Private key / seed phrase | Secret | Never accessed by the application | Extremely sensitive |
| Venice AI conversation | N/A | Not retained by Venice AI | N/A |

---

## 3. Threat Model

### Threat 1: Agent Exceeding Permission

**Description:** A Worker Agent attempts to swap or deposit an amount exceeding the limit specified by the user for its `agentId`.

**Mitigation:**
- `require(amount <= agentPermissions[user][agentId].maxAmount - usedAmount)` — reverts on violation
- `require(vault == agentPermissions[user][agentId].allowedVault)` — reverts if the vault is different
- `require(block.timestamp < agentPermissions[user][agentId].expiresAt)` — reverts if expired
- `require(agentPermissions[user][agentId].isActive)` — reverts if the permission is inactive
- No silent failures — any scope violation triggers a contract revert and emits the `AgentFailed(agentId, user, reason)` event
- `usedAmount` is tracked on-chain per `agentId` — cumulative limits are strictly enforced

---

### Threat 2: Agent 1 Accessing Agent 2's Vault

**Description:** Worker Agent 1 attempts to deposit into the vault designated for Worker Agent 2 (a different vault).

**Mitigation:**
- `agentPermissions[user][agentId].allowedVault` is uniquely mapped per `agentId`
- Smart contract reverts: `require(vault == agentPermissions[user][agentId].allowedVault)`
- Per-agent permissions offer per-vault isolation — Agent 1 cannot access Agent 2's vault

---

### Threat 3: Permission Context Leak

**Description:** An ERC-7715 permission context per `agentId` is stolen and used by a third party.

**Mitigation:**
- The permission context for each `agentId` is stored exclusively in `sessionStorage` (automatically cleared when the tab is closed)
- The `sessionStorage` keys are namespaced and non-trivial (e.g., `vf_permission_context_agent{n}`)
- The context is never transmitted to the developer's server
- Users can revoke permissions at any time via `revokeAgentPermission(agentId)`
- An expiry timestamp in the ERC-7715 scope narrows the window of exposure

---

### Threat 4: Smart Contract Reentrancy

**Description:** A vault deposit callback triggers re-entry into the `AgentVaultDepositor` contract.

**Mitigation:**
- The CEI pattern (Checks → Effects → Interactions) is strictly applied in `executeAgentDeposit`:
  - CHECKS: validate all permission constraints
  - EFFECTS: `usedAmount += amount` (state updated before any external contract call)
  - INTERACTIONS: swap → approve → MockVault.deposit()
- The `nonReentrant` modifier from OpenZeppelin's `ReentrancyGuard` is applied

---

### Threat 5: Frontend Injection / XSS

**Description:** A script injection attack attempts to steal permission contexts from `sessionStorage` or modify skill files.

**Mitigation:**
- No user-generated content is ever rendered directly as raw HTML
- Venice AI responses are parsed strictly as JSON (avoiding `eval`/`innerHTML`)
- Skill file content is validated against a schema prior to usage
- Memory file contents are sanitized before being displayed in the vis.js node details panel

---

### Threat 6: Skill File Tampering (After Approval)

**Description:** A third party modifies the local skill file after user approval to alter execution parameters.

**Mitigation:**
- The skill file is hashed upon approval — the Worker Agent validates this hash before reading the parameters
- The skill file is locked: once approved, editing via the UI is disabled
- Skill parameters are also verified by the smart contract (vault and amount limits are enforced on-chain)

---

### Threat 7: Orchestrator Abuse (One Worker Overriding Others)

**Description:** A compromised Worker Agent attempts to cancel or interfere with other concurrent Worker Agents.

**Mitigation:**
- Workers run independently using `Promise.allSettled()` — there is no cross-worker communication channel
- Each Worker is isolated and only has access to its own unique `permissionContext`
- The failure or compromise of one worker cannot trigger revocation of other workers' permissions

---

## 4. Security Controls

### Smart Contract

| Control | Implementation |
|---------|----------------|
| Per-agent permission validation | `agentPermissions[user][agentId]` — nested mapping |
| Vault scope check | `require(vault == agentPermissions[user][agentId].allowedVault)` |
| Amount check (cumulative) | `require(amount <= maxAmount - usedAmount)` |
| Expiry check | `require(block.timestamp < expiresAt)` |
| Active check | `require(agentPermissions[user][agentId].isActive)` |
| Reentrancy guard | `nonReentrant` — OpenZeppelin ReentrancyGuard |
| No admin key | No `onlyOwner` modifiers on critical functions |
| CEI pattern | Checks → Effects → Interactions in `executeAgentDeposit` |
| Event logging | All critical actions emit events (including `AgentFailed`) |

### Frontend

| Control | Implementation |
|---------|----------------|
| Input sanitization | Venice AI responses are parsed strictly as JSON, avoiding `eval` |
| Skill schema validation | Validates JSON schema before writing to files and prior to execution |
| Memory XSS prevention | Sanitizes memory entries before rendering them to the DOM |
| No private key handling | The application never requests or handles private keys or seed phrases |
| Network check | Verifies that the user is connected to Sepolia before initiating execution |
| Permission review | Renders detailed scope parameters per agent before the user approves |
| Worker isolation | Workers do not share state and run in completely isolated environments |
| permissionContext namespacing | Uses unique keys (`vf_permission_context_agent{n}`) to avoid collision |

### API Security

| Control | Implementation |
|---------|----------------|
| Venice AI API key | Stored as an environment variable — never hardcoded |
| HTTPS only | All API calls are executed strictly over HTTPS |
| Input validation | Validates amount parameters (must be positive and ≤ balance) prior to contract invocation |
| Skill parameter validation | Restricts `maxSlippage` (0–2%), `maxAmount` (≤ strategy allocation), and `expiresAt` (must be in the future) |

---

## 5. Compliance

| Aspect | Status |
|--------|--------|
| Personal data (PII) | No PII is collected or stored by the developer |
| GDPR & Privacy | Venice AI's no-retention policy aligns with data minimization. Skill and memory files remain purely local. |
| KYC/AML | N/A — testnet only, not a mainnet financial product |
| Smart contract audit | Unaudited — indie prototype scope, not suitable for mainnet |
| Agent memory privacy | Memory files are stored locally — never uploaded to external servers |

**Warning:** This project is an open-source prototype running on the Sepolia testnet. It is not suitable for deployment with real assets on mainnet without:
1. A comprehensive, independent smart contract audit.
2. Formal verification of the permission and logic scope.
3. A production-grade security review of the agent systems.

---

## 6. Pre-Deployment Security Checklist

**Smart Contract**
- [ ] No private keys or API keys are hardcoded in the codebase.
- [ ] All state-changing functions apply the CEI pattern.
- [ ] Vital `require` validation checks are fully implemented (vault, cumulative amount, expiry, isActive).
- [ ] The `nonReentrant` modifier is applied to `executeAgentDeposit`.
- [ ] No admin keys or `onlyOwner` modifiers exist on critical functions.
- [ ] All `forge test` suites pass successfully, with coverage ≥ 80%.

**Frontend + API**
- [ ] The Venice AI API key is safely configured in `.env`.
- [ ] Venice AI responses are parsed strictly as JSON (avoiding eval/innerHTML).
- [ ] The skill schema is validated before writing files and prior to execution.
- [ ] Memory logs are sanitized before rendering to the DOM.
- [ ] The permissionContext for each agent is stored in `sessionStorage` (never in `localStorage`).
- [ ] Worker agents operate in complete isolation (never sharing permissionContexts).

**Live Testing Sandbox Environment**
- [ ] The demo wallet contains only testnet USDC (no real mainnet assets).
- [ ] Permission revocation flows work flawlessly.
- [ ] MetaMask Flask (rather than regular MetaMask) is actively used.
- [ ] The browser runs in a clean profile (no extensions that might interfere).

---

## Key lifecycle (worker / session keys)

1. One private key per worker, generated at plan time (`keyVault.generateWorkerKey`, ethers v6), never a master key.
2. Scoped on-chain via `AgentRegistry.authorizeSessionKey`; the key can do nothing outside its scope.
3. Stored encrypted at rest in `keyStore` (IndexedDB in browser) as a libsodium sealed box under a **KDF-derived** secret (`deriveSecret` → `crypto_pwhash`). The derived secret is re-computed from the session passphrase on demand and is **never persisted next to the blob** — an attacker reading storage cannot decrypt.
4. Decrypted to memory only at the EIP-712 sign site. The opened key is an immutable hex string and **cannot be zeroized** — we minimize the exposure window instead (open → sign → drop reference). Byte buffers are zeroized.
5. Rotation = `authorizeSessionKey(newKey, scope)` + `revokeAgent(oldKey)`. The old key is dead permanently by design (one agent = one scope, forever).
6. Production roadmap: move the sealing secret — ideally the whole sign operation — to a KMS so the plaintext key never enters JS.
