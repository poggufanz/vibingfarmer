# ERC-7715 Advanced-Permissions Redeemed Funding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MetaMask Smart Accounts Kit load-bearing in the main flow by funding every vault deposit through a *real* ERC-7715 `erc20-token-periodic` Advanced Permission that the 1Shot relayer redeems on Base Sepolia — replacing the mocked grant and the `approve()`+`transferFrom` funding path.

**Architecture:** User grants ONE real AP (cap = total, grantee = 1Shot server wallet). For each worker the 1Shot server wallet (= the grantee, so it is the valid redeemer) redeems the AP — `USDC.transfer(AgentVaultDepositor, slice)` — pushing the user's USDC into the depositor. A new `depositHeld()` on the depositor then deposits from the contract's **own** balance (NOT `transferFrom(owner)`), still authorized by the worker's EIP-712 signature + AgentRegistry scope. Both sponsors (MetaMask SAK grant/redeem + 1Shot relay) and both scopes (AP period cap + AgentRegistry per-agent scope) are load-bearing; user pays zero gas.

**Tech Stack:** Solidity 0.8.24 + Foundry (WSL only), `@metamask/smart-accounts-kit` 1.6.0 (`erc7715ProviderActions`, `DelegationManager.encode.redeemDelegations`, `createExecution`, `ExecutionMode`), `@uxly/1shot-client` Managed API, viem, ethers v6, React 18 + Vite, Vitest.

---

## Verified facts (research 2026-06-14 — do not re-litigate)

1. **Grant works on Base Sepolia (84532).** `getSupportedExecutionPermissions()` returns `erc20-token-periodic` including 84532. `requestExecutionPermissions(...)` returned a real `delegationManager 0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3` + real `context`. The `ERC7715_CHAIN_HEX`/"Eth-Sepolia-only" guard in `wallet.js` is **stale and wrong**.
2. **Redeem = `token.transfer` ONLY.** SAK doc step 7: redeem `to: tokenAddress, data: <erc20 transfer calldata>`. The `ERC20PeriodTransferEnforcer` caps **token + `transfer` selector + amount/period**. It does **NOT** constrain the transfer recipient → redeem may `transfer` straight to `AgentVaultDepositor`.
3. **Redeem encoding (relayer path):** `DelegationManager.encode.redeemDelegations({ delegations:[[signed]], modes:[ExecutionMode.SingleDefault], executions:[[createExecution({target:USDC, callData:transfer(depositor,amount)})]] })` → calldata sent **to the `delegationManager`**. The ERC-7715 `context` is the encoded permission chain.
4. **Redeemer must be the grantee.** `redeemDelegations` checks `msg.sender == leaf delegate`. So the AP `to:` (grantee) MUST equal whoever broadcasts the redeem. For path ii that is the **1Shot server wallet** (`getRelayerAddress()` / `POST /api/relay {action:'wallet'}`).
5. **1Shot relayer scope:** permissionless/keyless 7710 relayer is **mainnet-only** (Base 8453 / ETH 1). On Base Sepolia we use the **Managed API** (server-wallet relayer, already wired in `frontend/api/relay.js`). The redeem is relayed by that same server wallet.
6. **Depositor today** pulls `safeTransferFrom(s.owner, this, amount)` (needs user `approve()`), then `IERC4626(vault).deposit(received, owner)`. A pushed-in `transfer` makes that double-pull — hence the new `depositHeld()`.

## Open risk — resolved by Task 1 (spike) BEFORE the grant grantee is fixed

`redeemDelegations(bytes[],bytes32[],bytes[])` needs **array-typed params**. The current Managed-API relay only registers scalar-typed methods. Task 1 decides:
- **(a)** Managed API supports array params (`bytes[]`/`bytes32[]`) on a registered contract method → register `redeemDelegations`, grantee = server wallet (path **ii**).
- **(b)** Managed API supports a raw pre-encoded-calldata tx send → send SAK-built calldata to `delegationManager`, grantee = server wallet (path **ii**).
- **(c)** Neither → **fallback path i**: grantee = an in-browser session EOA (`strategy/session.js`), which self-pays testnet ETH and calls `sendTransactionWithDelegation`; 1Shot stays in the `depositHeld` step only. Re-point the grant `to:` to the session EOA address.

Tasks 4–6 read the spike outcome from `docs/superpowers/plans/SPIKE-7715-redeem-result.md` (written by Task 1).

---

## File structure (created / modified)

| File | Change |
|------|--------|
| `contracts/AgentVaultDepositor.sol` | **Modify** — add `HELD_DEPOSIT_TYPEHASH`, `hashHeldDeposit`, `depositHeld`, `sweepStranded` (guardian) |
| `test/AgentVaultDepositor.t.sol` | **Modify** — tests for `depositHeld` happy path, double-spend guard, scope/replay, `sweepStranded` |
| `test/ZeroCustody.t.sol` | **Modify** — invariant now allows *transient* custody between redeem and deposit; assert no *permanent* custody after `depositHeld`/`sweepStranded` |
| `deployments/base-sepolia.json` | **Modify** — new depositor address after redeploy |
| `frontend/src/config.js` | **Modify** — `AGENT_VAULT_DEPOSITOR_ADDRESS`; fix stale `DEPOSITOR_ABI` (add `minShares` + `depositHeld`) |
| `frontend/src/wallet.js` | **Modify** — un-mock `requestERC7715Permission`; real SAK grant on Base Sepolia; grantee from spike; delete `ERC7715_CHAIN_HEX` mock guard + stale comment |
| `frontend/api/relay.js` | **Modify** — add `redeem` + `depositHeld` POST actions (server-side redeem + held deposit relay) |
| `frontend/src/relay.js` | **Modify** — add `relayRedeem`, `signHeldDeposit`, `relayDepositHeld`, `HELD_DEPOSIT_TYPES`, `encodeRedeemDelegations` helper |
| `frontend/src/orchestrator.js` | **Modify** — replace `approve` batch with real AP grant; pass `permissionContext`/`delegationManager`/`recipient` to workers |
| `frontend/src/worker.js` | **Modify** — `execute()` runs redeem → `depositHeld` instead of `relayDeposit` |
| `frontend/src/redeem.js` | **Create** — `buildRedeemCalldata({permissionContext, delegationManager, token, recipient, amount})` SAK encoder (shared by relay client + session fallback) |
| `frontend/src/*.test.js` | **Create/Modify** — Vitest for grant, redeem encode, worker flow |
| `PITCH-VIDEO-DECK.md`, `docs/product-demo-scenario.md` | **Modify** — feature the SAK grant/redeem honestly |

---

### Task 1: Spike — 1Shot Managed-API redeem capability (DECISION GATE)

**Files:**
- Create: `scripts/spike-7715-redeem.mjs`
- Create (output): `docs/superpowers/plans/SPIKE-7715-redeem-result.md`

- [ ] **Step 1: Inspect the client surface**

Run: `node -e "const c=require('@uxly/1shot-client');console.log(Object.keys(c));console.log(Object.keys(c.OneShotClient.prototype||{}))"` (from `frontend/`)
Inspect `frontend/node_modules/@uxly/1shot-client/dist/*.d.ts` for: (a) `contractMethods.create` input param shape — does `inputs[].type` accept an array/`isArray` flag or a `bytes[]` base type? (b) any `transactions.create`/`send` accepting raw `data`+`to`.

- [ ] **Step 2: Probe registration of an array-param method**

```js
// scripts/spike-7715-redeem.mjs — run with creds in env: ONESHOT_KEY/SECRET/BIZ_ID
import { OneShotClient } from '@uxly/1shot-client'
const c = new OneShotClient({ apiKey: process.env.ONESHOT_KEY, apiSecret: process.env.ONESHOT_SECRET })
const bizId = process.env.ONESHOT_BIZ_ID
const list = await c.wallets.list(bizId, { chainId: 84532 })
const wallet = (list?.response || list?.data || list)?.[0]
const DM = '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3'
try {
  const m = await c.contractMethods.create(bizId, {
    chainId: 84532, contractAddress: DM, walletId: wallet.id,
    name: 'DelegationManager.redeemDelegations (spike)', description: 'array-param probe',
    functionName: 'redeemDelegations', stateMutability: 'nonpayable',
    inputs: [
      { name: 'permissionContexts', type: 'bytes', isArray: true, index: 0 },
      { name: 'modes', type: 'bytes', typeSize: 32, isArray: true, index: 1 },
      { name: 'executionCallDatas', type: 'bytes', isArray: true, index: 2 },
    ],
    outputs: [],
  })
  console.log('ARRAY_PARAMS_OK', m.id)
} catch (e) { console.log('ARRAY_PARAMS_FAIL', e?.message, e?.issues || '') }
```

Run: `node scripts/spike-7715-redeem.mjs`
Expected: prints `ARRAY_PARAMS_OK <id>` (→ outcome **a**) or `ARRAY_PARAMS_FAIL ...` (try raw-tx in next step).

- [ ] **Step 3: If array params fail, probe raw-calldata send**

Check `.d.ts` for `c.transactions.create`/`c.transactions.send` accepting `{ chainId, to, data, walletId }`. If present, that is outcome **b**. If neither, outcome **c**.

- [ ] **Step 4: Record the decision**

Write `docs/superpowers/plans/SPIKE-7715-redeem-result.md` with one line: `OUTCOME: a|b|c` plus the chosen grantee (`a`/`b` → server wallet; `c` → session EOA) and the exact API call shape that worked. Tasks 4–6 read this file.

- [ ] **Step 5: Commit**

```bash
git add scripts/spike-7715-redeem.mjs docs/superpowers/plans/SPIKE-7715-redeem-result.md
git commit -m "chore: spike 1Shot Managed-API redeemDelegations capability"
```

> Note: `docs/superpowers/` is gitignored per CLAUDE.md — the result file stays local. Keep `scripts/spike-7715-redeem.mjs` local too (do not commit secrets / one-off probes); if the working tree blocks the commit, just leave both untracked and proceed.

---

### Task 2: Contract — `depositHeld` + `sweepStranded`

**Files:**
- Modify: `contracts/AgentVaultDepositor.sol`
- Test: `test/AgentVaultDepositor.t.sol`

- [ ] **Step 1: Write the failing test (happy path)**

Add to `test/AgentVaultDepositor.t.sol` (mirror the existing `executeAgentDeposit` test setup — same registry scope + worker key; the difference is funds are pre-sent, not approved):

```solidity
function test_depositHeld_depositsFromContractBalance() public {
    // scope already authorized for `agent` over (vault, USDC) in setUp/helper
    uint256 amount = 100e6;
    // simulate the ERC-7715 redeem: push USDC straight into the depositor
    usdc.mint(address(depositor), amount);

    bytes32 execId = keccak256("held-1");
    bytes32 digest = depositor.hashHeldDeposit(amount, amount, 0, execId);
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, digest);
    bytes memory sig = abi.encodePacked(r, s, v);

    uint256 sharesBefore = vault.balanceOf(user);
    uint256 shares = depositor.depositHeld(amount, amount, 0, execId, sig);

    assertGt(shares, 0);
    assertEq(vault.balanceOf(user), sharesBefore + shares);
    assertEq(usdc.balanceOf(address(depositor)), 0); // no permanent custody
}
```

- [ ] **Step 2: Run it — expect FAIL (no such function)**

Run: `wsl -e bash -c "cd /mnt/c/SharredData/project/competition/yield-vibing && forge test --match-test test_depositHeld_depositsFromContractBalance -vvv"`
Expected: FAIL — `depositHeld`/`hashHeldDeposit` not found.

- [ ] **Step 3: Implement on `AgentVaultDepositor.sol`**

Add the typehash next to `DEPOSIT_TYPEHASH`:

```solidity
    // Distinct typehash so a depositHeld signature can never be replayed as an
    // executeAgentDeposit (and vice-versa). Same fields, different struct name.
    bytes32 public constant HELD_DEPOSIT_TYPEHASH =
        keccak256("AgentHeldDeposit(uint256 amount,uint256 minAmount,uint256 minShares,bytes32 execId)");

    error NotStranded();
```

Add after `hashDeposit`:

```solidity
    function hashHeldDeposit(uint256 amount, uint256 minAmount, uint256 minShares, bytes32 execId) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(HELD_DEPOSIT_TYPEHASH, amount, minAmount, minShares, execId)));
    }

    /// @notice Deposit USDC already held by this contract (pushed in by an ERC-7715
    ///         erc20-token-periodic redeem: USDC.transfer → this). Authorization is the
    ///         worker EIP-712 signature + AgentRegistry scope; msg.sender is the relayer.
    ///         Funds come from the contract's OWN unreserved balance — never transferFrom.
    function depositHeld(uint256 amount, uint256 minAmount, uint256 minShares, bytes32 execId, bytes calldata sig)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 shares)
    {
        address agent = ECDSA.recover(hashHeldDeposit(amount, minAmount, minShares, execId), sig);
        AgentRegistry.AgentScope memory s = registry.scopeOf(agent);
        if (s.owner == address(0) || s.revoked || block.timestamp >= s.expiry) revert ScopeInactive();
        if (executed[execId]) revert AlreadyExecuted(execId);
        executed[execId] = true;

        IERC20 token = IERC20(s.token);
        // Only spend funds NOT already reserved by a concurrent in-flight deposit.
        uint256 available = token.balanceOf(address(this)) - reserves[s.token];
        if (amount == 0 || available < amount || available < minAmount) revert InsufficientReceived(available, minAmount);

        registry.rollAndSpend(agent, amount);

        reserves[s.token] += amount;
        token.forceApprove(s.vault, amount);
        shares = IERC4626(s.vault).deposit(amount, s.owner);
        if (shares == 0) revert ZeroShares();
        if (shares < minShares) revert InsufficientShares(shares, minShares);
        reserves[s.token] -= amount;
        token.forceApprove(s.vault, 0);

        emit AgentDepositExecuted(agent, s.owner, s.vault, s.token, amount, shares, execId);
    }

    /// @notice Guardian escape hatch: sweep funds stranded by a redeem whose depositHeld
    ///         never landed (so transient custody can never become permanent custody).
    ///         Only the unreserved surplus is movable.
    function sweepStranded(address token_, address to) external {
        if (msg.sender != guardian) revert NotGuardian();
        uint256 surplus = IERC20(token_).balanceOf(address(this)) - reserves[token_];
        if (surplus == 0) revert NotStranded();
        IERC20(token_).safeTransfer(to, surplus);
    }
```

- [ ] **Step 4: Run test — expect PASS**

Run: `wsl -e bash -c "cd /mnt/c/SharredData/project/competition/yield-vibing && forge test --match-test test_depositHeld_depositsFromContractBalance -vvv"`
Expected: PASS.

- [ ] **Step 5: Add guard tests**

```solidity
function test_depositHeld_revertsWhenUnderfunded() public {
    uint256 amount = 100e6;
    usdc.mint(address(depositor), amount - 1); // 1 wei short
    bytes32 execId = keccak256("held-short");
    bytes32 d = depositor.hashHeldDeposit(amount, amount, 0, execId);
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, d);
    vm.expectRevert();
    depositor.depositHeld(amount, amount, 0, execId, abi.encodePacked(r, s, v));
}

function test_depositHeld_replayGuard() public {
    uint256 amount = 50e6;
    usdc.mint(address(depositor), 2 * amount);
    bytes32 execId = keccak256("held-replay");
    bytes32 d = depositor.hashHeldDeposit(amount, amount, 0, execId);
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, d);
    bytes memory sig = abi.encodePacked(r, s, v);
    depositor.depositHeld(amount, amount, 0, execId, sig);
    vm.expectRevert(abi.encodeWithSelector(AgentVaultDepositor.AlreadyExecuted.selector, execId));
    depositor.depositHeld(amount, amount, 0, execId, sig);
}

function test_sweepStranded_onlyGuardian() public {
    usdc.mint(address(depositor), 10e6);
    vm.prank(address(0xBEEF));
    vm.expectRevert(AgentVaultDepositor.NotGuardian.selector);
    depositor.sweepStranded(address(usdc), address(0xBEEF));
}
```

- [ ] **Step 6: Run all depositor tests — expect PASS**

Run: `wsl -e bash -c "cd /mnt/c/SharredData/project/competition/yield-vibing && forge test --match-contract AgentVaultDepositor -vvv"`
Expected: PASS.

- [ ] **Step 7: Update ZeroCustody invariant**

In `test/ZeroCustody.t.sol`, change the invariant to allow transient custody but assert no permanent custody: after any `depositHeld`, `usdc.balanceOf(depositor) == reserves[usdc]` (i.e. only in-flight reserves, which net to 0 outside a call). Add a `sweepStranded` handler so the fuzzer can drain surplus and the invariant `balanceOf == 0` holds at rest.

Run: `wsl -e bash -c "cd /mnt/c/SharredData/project/competition/yield-vibing && forge test --match-contract ZeroCustody -vvv"`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add contracts/AgentVaultDepositor.sol test/AgentVaultDepositor.t.sol test/ZeroCustody.t.sol
git commit -m "feat(contract): add depositHeld for ERC-7715-redeemed funding + guardian sweep"
```

---

### Task 3: Redeploy to Base Sepolia + sync addresses/ABI

**Files:**
- Modify: `deployments/base-sepolia.json`
- Modify: `frontend/src/config.js`

The constructor is unchanged (`registry_`, `guardian_`), so `script/Deploy.s.sol` needs no edit — a rebuild + rerun produces a new depositor address bound to the existing `AgentRegistry`.

- [ ] **Step 1: Build + deploy**

Run: `wsl -e bash -c "cd /mnt/c/SharredData/project/competition/yield-vibing && forge build && forge script script/Deploy.s.sol --rpc-url \$BASE_SEPOLIA_RPC --broadcast --verify"`
Expected: prints new `AgentVaultDepositor` address. (Reuse the existing `AgentRegistry 0x1f5eb2…` + `MockVault 0xDff362…` — only the depositor changes.)

- [ ] **Step 2: Record the new address**

Update `deployments/base-sepolia.json` depositor field to the new address.

- [ ] **Step 3: Sync frontend config + fix the stale ABI**

In `frontend/src/config.js`: set `AGENT_VAULT_DEPOSITOR_ADDRESS` to the new address, and replace the stale `DEPOSITOR_ABI` (it omits `minShares`) with the live shape + `depositHeld`:

```javascript
export const DEPOSITOR_ABI = [
  'function executeAgentDeposit(uint256 amount, uint256 minAmount, uint256 minShares, bytes32 execId, bytes sig) external returns (uint256 shares)',
  'function depositHeld(uint256 amount, uint256 minAmount, uint256 minShares, bytes32 execId, bytes sig) external returns (uint256 shares)',
  'function hashDeposit(uint256 amount, uint256 minAmount, uint256 minShares, bytes32 execId) external view returns (bytes32)',
  'function hashHeldDeposit(uint256 amount, uint256 minAmount, uint256 minShares, bytes32 execId) external view returns (bytes32)',
  'function registry() external view returns (address)',
  'function executed(bytes32 execId) external view returns (bool)',
  'function reserves(address token) external view returns (uint256)',
  'event AgentDepositExecuted(address indexed agent, address indexed owner, address indexed vault, address token, uint256 assetsIn, uint256 sharesOut, bytes32 execId)',
]
```

- [ ] **Step 4: Set the server env var + re-register**

Set `AGENT_VAULT_DEPOSITOR_ADDRESS` (Cloudflare/dev env) to the new address so `frontend/api/relay.js` `depositorAddress()` resolves it. The relay caches `contractMethod` by address, so the new address forces a fresh registration on next call — no manual purge needed.

- [ ] **Step 5: Commit**

```bash
git add deployments/base-sepolia.json frontend/src/config.js
git commit -m "chore(deploy): redeploy depositor with depositHeld; sync address + ABI"
```

---

### Task 4: Frontend — un-mock the real ERC-7715 grant

**Files:**
- Modify: `frontend/src/wallet.js`
- Test: `frontend/src/wallet.test.js` (or existing wallet test)

Read `docs/superpowers/plans/SPIKE-7715-redeem-result.md`: grantee = server wallet (`getRelayerAddress()`) for outcome a/b, or the session EOA (`prepareSessionAccount()` address) for outcome c.

- [ ] **Step 1: Write the failing test**

```js
// frontend/src/wallet.test.js
import { describe, it, expect, vi } from 'vitest'
import { parseGrantResult } from './wallet.js'

describe('parseGrantResult', () => {
  it('keeps a real delegationManager (no mock)', () => {
    const r = parseGrantResult([{ context: '0xabc', delegationManager: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3' }])
    expect(r.delegationManager).toBe('0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3')
    expect(r.permissionContext).toBe('0xabc')
  })
})
```

Run: `cd frontend && npx vitest run src/wallet.test.js`
Expected: PASS already (parseGrantResult is fine) — this test pins the contract while we delete the mock path.

- [ ] **Step 2: Replace `requestERC7715Permission`**

Delete the `ERC7715_CHAIN_HEX` constant + the stale comment block above it, and the chain-mock branch (lines ~234–251). Replace the body with the real SAK grant on Base Sepolia, granting to the spike-chosen grantee, capped at `capUnits`:

```javascript
import { createWalletClient, custom } from 'viem'
import { erc7715ProviderActions } from '@metamask/smart-accounts-kit/actions'
import { baseSepolia } from 'viem/chains'
import { getRelayerAddress } from './relay.js'

/**
 * Request a REAL ERC-7715 erc20-token-periodic permission on Base Sepolia.
 * Grantee = the redeemer that will broadcast the redeem (1Shot server wallet for
 * managed redeem; the in-browser session EOA for the self-gas fallback).
 * @param {bigint} capUnits  period cap in USDC units (>= total deposit)
 * @param {number} expirySeconds
 * @returns {Promise<{permissionContext: string, delegationManager: string|null, grantee: string, grantedPermissions: Array}>}
 */
export async function requestERC7715Permission(capUnits, expirySeconds = 86400) {
  if (!window.ethereum) throw new Error('MetaMask Flask not found.')
  if (!account) throw new Error('Wallet not connected. Call connectWallet() first.')
  try { await requireFlask() } catch (err) {
    if (err.message?.startsWith('FLASK_REQUIRED')) throw new Error(err.message)
    throw err
  }
  prepareSessionAccount()

  // Grantee from the spike decision. Default to the 1Shot server wallet; if it is
  // unavailable (relay unconfigured), fall back to the in-browser session EOA.
  const grantee = (await getRelayerAddress()) || getSessionAddress() || prepareSessionAccount()

  const walletClient = createWalletClient({ transport: custom(window.ethereum) })
    .extend(erc7715ProviderActions())

  const result = await runWallet(() => walletClient.requestExecutionPermissions([{
    chainId: baseSepolia.id,
    expiry: Math.floor(Date.now() / 1000) + expirySeconds,
    to: grantee,
    permission: {
      type: 'erc20-token-periodic',
      data: {
        tokenAddress: USDC_SEPOLIA,
        periodAmount: BigInt(capUnits),   // bigint — NOT the stale hex shape
        periodDuration: 86400,
        justification: 'Vibing Farmer: fund multi-vault yield deposits',
      },
      isAdjustmentAllowed: true,
    },
  }]))

  if (!result) throw new Error('No permission result returned from MetaMask')
  const grantData = { ...parseGrantResult(result), grantee }
  saveSessionGrant(grantData)
  return grantData
}
```

Add the missing import of `getSessionAddress` from `./strategy/session.js` (alongside `prepareSessionAccount`, `saveSessionGrant`). Keep `runWallet` wrapping the grant so the post-grant MetaMask "in process" window is serialized (the -32002 defense).

- [ ] **Step 3: Run the wallet test + lint**

Run: `cd frontend && npx vitest run src/wallet.test.js && npx eslint src/wallet.js`
Expected: PASS, 0 errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/wallet.js frontend/src/wallet.test.js
git commit -m "feat(wallet): real ERC-7715 grant on Base Sepolia, remove mock chain guard"
```

---

### Task 5: Redeem path — encoder + relay action/client

**Files:**
- Create: `frontend/src/redeem.js`
- Modify: `frontend/api/relay.js`
- Modify: `frontend/src/relay.js`
- Test: `frontend/src/redeem.test.js`

- [ ] **Step 1: Write the failing encoder test**

```js
// frontend/src/redeem.test.js
import { describe, it, expect } from 'vitest'
import { buildTransferCalldata } from './redeem.js'

describe('buildTransferCalldata', () => {
  it('encodes erc20 transfer(recipient, amount)', () => {
    const data = buildTransferCalldata({ recipient: '0x0000000000000000000000000000000000000001', amount: 1000000n })
    expect(data.startsWith('0xa9059cbb')).toBe(true) // transfer selector
  })
})
```

Run: `cd frontend && npx vitest run src/redeem.test.js`
Expected: FAIL — module not found.

- [ ] **Step 2: Create `frontend/src/redeem.js`**

```javascript
// redeem.js — encode the ERC-7715 erc20-token-periodic redeem.
// The redeem moves USDC from the user's MetaMask smart account into AgentVaultDepositor
// via token.transfer (the only execution the periodic enforcer allows). The recipient is
// unconstrained by the enforcer, so we transfer straight to the depositor.
import { encodeFunctionData } from 'viem'
import { createExecution, ExecutionMode } from '@metamask/smart-accounts-kit'
import { DelegationManager } from '@metamask/smart-accounts-kit/contracts'
import { USDC_SEPOLIA } from './config.js'

const ERC20_TRANSFER_ABI = [{
  type: 'function', name: 'transfer', stateMutability: 'nonpayable',
  inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
  outputs: [{ name: '', type: 'bool' }],
}]

/** erc20 transfer(recipient, amount) calldata — the only action the AP enforcer permits. */
export function buildTransferCalldata({ recipient, amount }) {
  return encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: 'transfer', args: [recipient, BigInt(amount)] })
}

/**
 * Encode DelegationManager.redeemDelegations calldata for a SINGLE transfer execution.
 * `permissionContext` is the raw ERC-7715 grant context (the encoded delegation chain).
 * @returns {{ to: string, data: `0x${string}` }} tx to the delegationManager
 */
export function buildRedeemDelegations({ permissionContext, delegationManager, recipient, amount, token = USDC_SEPOLIA }) {
  const execution = createExecution({ target: token, value: 0n, callData: buildTransferCalldata({ recipient, amount }) })
  const data = DelegationManager.encode.redeemDelegations({
    delegations: [permissionContext],          // raw context chain (leaf→root)
    modes: [ExecutionMode.SingleDefault],
    executions: [[execution]],
  })
  return { to: delegationManager, data }
}
```

> If the spike found `DelegationManager.encode.redeemDelegations` rejects a raw bytes `permissionContext` (it expects decoded `Delegation[][]`), decode first with `decodeDelegations` from `@metamask/smart-accounts-kit/utils`, or hand-encode the on-chain ABI `redeemDelegations(bytes[],bytes32[],bytes[])` with `permissionContexts:[permissionContext]`, `modes:[SINGLE_DEFAULT_MODE]`, `executionCallDatas:[<packed target|value|calldata>]`. Pin whichever the spike validated.

- [ ] **Step 3: Run encoder test — expect PASS**

Run: `cd frontend && npx vitest run src/redeem.test.js`
Expected: PASS.

- [ ] **Step 4: Add the `redeem` action to `frontend/api/relay.js`**

For spike outcome **a** (array params), add a registered `redeemDelegations` method bound to the server wallet + a `redeem` action. Reuse the existing `resolveServerWallet` + `_contractMethodIds` machinery:

```javascript
const DM_ADDRESS = '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3' // DelegationManager (Base Sepolia)
const REDEEM_FN = 'redeemDelegations'
const REDEEM_INPUTS = [
  { name: 'permissionContexts', type: 'bytes', isArray: true, index: 0 },
  { name: 'modes', type: 'bytes', typeSize: 32, isArray: true, index: 1 },
  { name: 'executionCallDatas', type: 'bytes', isArray: true, index: 2 },
]
// FN_META[REDEEM_FN] = { inputs: REDEEM_INPUTS, name: 'DelegationManager.redeemDelegations', desc: 'ERC-7710 redeem of an ERC-7715 AP (USDC transfer → depositor)' }

// inside handler(), new branch:
if (action === 'redeem') {
  const { permissionContexts, modes, executionCallDatas } = body
  if (!Array.isArray(permissionContexts) || !permissionContexts.every(x => BYTES_RE.test(x))) return bad(res, 'Invalid permissionContexts')
  if (!Array.isArray(modes) || !modes.every(x => BYTES32_RE.test(x))) return bad(res, 'Invalid modes')
  if (!Array.isArray(executionCallDatas) || !executionCallDatas.every(x => BYTES_RE.test(x))) return bad(res, 'Invalid executionCallDatas')
  const wallet = await resolveServerWallet(client, bizId)
  const methodId = await resolveContractMethod(client, bizId, DM_ADDRESS, wallet.id, REDEEM_FN)
  const tx = await client.contractMethods.execute(methodId, { permissionContexts, modes, executionCallDatas })
  const result = await pollForHash(client, tx.id)
  return res.end(JSON.stringify({ ...result, relayer: wallet.accountAddress }))
}
```

`resolveContractMethod` already targets an arbitrary `contractAddress` (pass `DM_ADDRESS`) and caches by `${address}:${fn}`. For outcome **b** use the raw-tx send the spike validated instead; for outcome **c** this action is unused (session EOA redeems client-side).

- [ ] **Step 5: Add `relayRedeem` to `frontend/src/relay.js`**

```javascript
import { buildRedeemDelegations } from './redeem.js'
import { ExecutionMode } from '@metamask/smart-accounts-kit'
// SINGLE_DEFAULT mode as bytes32 (ERC-7579). Pin the value the spike confirmed.
const SINGLE_DEFAULT_MODE = '0x0000000000000000000000000000000000000000000000000000000000000000'

/**
 * Redeem the ERC-7715 AP for one slice: USDC.transfer(depositor, amount), relayed by the
 * 1Shot server wallet (= the grantee). Returns null on failure so the caller can fall back.
 * @returns {Promise<{txHash:string,status:string,relayer?:string}|null>}
 */
export async function relayRedeem({ permissionContext, delegationManager, recipient, amount }) {
  // Build the SINGLE execution calldata (transfer) the same way the encoder does, then
  // submit the three on-chain arrays to the managed relay. modes is a fixed single-default.
  const { data: _dmCalldata } = buildRedeemDelegations({ permissionContext, delegationManager, recipient, amount })
  // For the managed array-param path we pass the on-chain args directly:
  const execution = encodeSingleExecution({ target: USDC_SEPOLIA, value: 0n, callData: buildTransferCalldata({ recipient, amount }) })
  try {
    const res = await fetch(RELAY_PROXY_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'redeem',
        permissionContexts: [permissionContext],
        modes: [SINGLE_DEFAULT_MODE],
        executionCallDatas: [execution],
      }),
    })
    if (!res.ok) return null
    const d = await res.json()
    if (d.error) return null
    return { txHash: d.txHash || 'pending', status: d.txHash ? 'redeemed' : 'submitted', relayer: d.relayer }
  } catch { return null }
}
```

Add `encodeSingleExecution` + `buildTransferCalldata` imports from `./redeem.js` (export `encodeSingleExecution` there using `abi.encodePacked`-equivalent: `viem.encodePacked(['address','uint256','bytes'], [target, value, callData])`). Pin `SINGLE_DEFAULT_MODE` to the spike-validated bytes32 from `ExecutionMode.SingleDefault`.

- [ ] **Step 6: Test the client builder + commit**

Run: `cd frontend && npx vitest run src/redeem.test.js && npx eslint src/redeem.js frontend/src/relay.js frontend/api/relay.js`
Expected: PASS, 0 errors.

```bash
git add frontend/src/redeem.js frontend/src/redeem.test.js frontend/api/relay.js frontend/src/relay.js
git commit -m "feat(relay): ERC-7710 redeem of the ERC-7715 AP via 1Shot managed relayer"
```

---

### Task 6: depositHeld relay + worker/orchestrator wiring (main flow)

**Files:**
- Modify: `frontend/api/relay.js` (add `depositHeld` action)
- Modify: `frontend/src/relay.js` (add `HELD_DEPOSIT_TYPES`, `signHeldDeposit`, `relayDepositHeld`)
- Modify: `frontend/src/worker.js` (`execute()` redeem → depositHeld)
- Modify: `frontend/src/orchestrator.js` (real AP grant instead of approve batch)
- Test: `frontend/src/worker.test.js`, `frontend/src/orchestrator.test.js`

- [ ] **Step 1: Add the `depositHeld` action to `frontend/api/relay.js`**

Clone the existing `deposit` branch but register/execute `depositHeld` (same 5 scalar inputs as `executeAgentDeposit`). Reuse `hasCode`, the replay short-circuit, and `pollForHash`:

```javascript
const HELD_FN = 'depositHeld'
// FN_META[HELD_FN] = { inputs: DEPOSIT_INPUTS, name: 'AgentVaultDepositor.depositHeld', desc: 'Deposit contract-held USDC (ERC-7715 redeemed) authorized by worker EIP-712 sig' }
// inside handler(): branch identical to action==='deposit' but methodId = resolveContractMethod(..., HELD_FN)
```

- [ ] **Step 2: Add held-deposit signing + relay to `frontend/src/relay.js`**

```javascript
export const HELD_DEPOSIT_TYPES = {
  AgentHeldDeposit: [
    { name: 'amount', type: 'uint256' },
    { name: 'minAmount', type: 'uint256' },
    { name: 'minShares', type: 'uint256' },
    { name: 'execId', type: 'bytes32' },
  ],
}

export async function signHeldDeposit(workerSigner, { chainId, depositor, amount, minAmount, minShares = 0, execId }) {
  return workerSigner.signTypedData({
    domain: DEPOSIT_DOMAIN(chainId, depositor),
    types: HELD_DEPOSIT_TYPES, primaryType: 'AgentHeldDeposit',
    message: { amount: BigInt(amount), minAmount: BigInt(minAmount), minShares: BigInt(minShares), execId },
  })
}

/** Relay depositHeld via 1Shot managed proxy. Returns null on failure (caller falls back). */
export async function relayDepositHeld({ amount, minAmount, minShares = 0, execId, sig }) {
  try {
    const res = await fetch(RELAY_PROXY_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'depositHeld', amount: String(amount), minAmount: String(minAmount), minShares: String(minShares), execId, sig }),
    })
    if (!res.ok) return null
    const d = await res.json()
    if (d.configured === false || d.error) return null
    return { txHash: d.txHash || 'pending', status: d.txHash ? 'relayed' : 'submitted', relayer: d.relayer }
  } catch { return null }
}
```

- [ ] **Step 3: Rewire `WorkerAgent.execute()`**

The worker now (a) redeems its slice of the AP into the depositor, then (b) signs `AgentHeldDeposit` and relays `depositHeld`. Replace the Step-4 deposit block in `worker.js`. The worker needs `permissionContext`, `delegationManager`, and `depositor` (recipient) — add them to the constructor config (passed by the orchestrator). Sign with `signAtSubmitSite` switched to `HELD_DEPOSIT_TYPES`:

```javascript
// constructor: this.permissionContext = permissionContext; this.delegationManager = delegationManager
// signAtSubmitSite(execId): swap DEPOSIT_TYPES → HELD_DEPOSIT_TYPES, primaryType 'AgentHeldDeposit'.

// in execute(), replacing the relayDeposit call:
const baselineShares = await this.readShares()

// (a) redeem the AP slice → USDC into the depositor (1Shot server wallet = grantee broadcasts)
this.emit('step', { agentId: this.agentId, step: 'redeem-permission', status: 'pending' })
const redeem = await relayRedeem({
  permissionContext: this.permissionContext,
  delegationManager: this.delegationManager,
  recipient: AGENT_VAULT_DEPOSITOR_ADDRESS,
  amount: this.amount,
})
if (!redeem) throw new Error('ERC-7715 redeem failed (1Shot relay) — cannot fund deposit')
this.memoryEntries.push(createEntry('redeem-permission', 'success', { txHash: redeem.txHash, amount: this.amount.toString() }))
this.emit('step', { agentId: this.agentId, step: 'redeem-permission', status: 'done', txHash: redeem.txHash })

// (b) deposit the now-held USDC (EIP-712 AgentHeldDeposit; scope still enforced)
const sig = await this.signAtSubmitSite(execId)
const depositResult = await relayDepositHeld({ amount: this.amount, minAmount: this.minAmount, minShares: this.minShares, execId, sig })
if (!depositResult) throw new Error('depositHeld relay failed')
```

Keep the existing `verifyDepositMined(baselineShares)` confirmation — it is still the honest success signal.

- [ ] **Step 4: Orchestrator — real AP grant instead of the approve batch**

In `orchestrator.js dispatch()`: remove `buildApproveCall` from the batch (depositHeld no longer needs an allowance). Before the worker loop, request the real AP once and feed `permissionContext`/`delegationManager` to every worker:

```javascript
import { requestERC7715Permission } from './wallet.js'
// ...after computing totalUnits and BEFORE building workers:
this.onEvent('orchestrator-step', { step: 'granting-permission', status: 'pending' })
const grant = await requestERC7715Permission(totalUnits, SCOPE_TTL_SECONDS)
this.onEvent('orchestrator-step', { step: 'granting-permission', status: 'done', delegationManager: grant.delegationManager, grantee: grant.grantee })
// pass grant.permissionContext + grant.delegationManager into each new WorkerAgent({...})
// scope batch now contains ONLY authorizeSessionKey calls (no approve):
const calls = workers.map((w) => buildAuthorizeSessionKeyCall({
  agent: w.keyAddress, vault: w.vault, token: USDC_SEPOLIA,
  capPerPeriod: w.capPerPeriod, periodDuration: PERIOD_DURATION, expiry,
}))
```

- [ ] **Step 5: Update tests**

Update `frontend/src/worker.test.js` to mock `relayRedeem` + `relayDepositHeld` (both resolve `{txHash:'0x..',status:'relayed'}`) and assert the worker emits `redeem-permission` then `deposit` done. Update `frontend/src/orchestrator.test.js` to mock `requestERC7715Permission` → `{permissionContext:'0xctx', delegationManager:'0xdb9B…', grantee:'0xrelayer'}` and assert no `buildApproveCall` is in the batch.

Run: `cd frontend && npx vitest run`
Expected: all PASS.

- [ ] **Step 6: Lint + commit**

Run: `cd frontend && npx eslint src/worker.js src/orchestrator.js src/relay.js frontend/api/relay.js`

```bash
git add frontend/src/worker.js frontend/src/orchestrator.js frontend/src/relay.js frontend/api/relay.js frontend/src/worker.test.js frontend/src/orchestrator.test.js
git commit -m "feat(flow): fund deposits via ERC-7715 redeem + depositHeld (SAK load-bearing)"
```

---

### Task 7: Docs + pitch honesty pass

**Files:**
- Modify: `PITCH-VIDEO-DECK.md`
- Modify: `docs/product-demo-scenario.md`
- Modify: `docs/technical-blockchain-usage.md`

- [ ] **Step 1: Update the demo/pitch narrative**

Document the real main flow: (1) user grants ONE MetaMask Advanced Permission (`erc20-token-periodic`, capped, expiring) to the 1Shot relayer; (2) the relayer redeems it per vault — USDC moves under the AP cap; (3) `depositHeld` deposits to the ERC-4626 vault under the AgentRegistry scope; (4) zero gas for the user. State plainly that BOTH MetaMask SAK and 1Shot are load-bearing in the fund-moving path. Remove any claim that omitted/decorated 7715.

- [ ] **Step 2: Commit**

```bash
git add PITCH-VIDEO-DECK.md docs/product-demo-scenario.md docs/technical-blockchain-usage.md
git commit -m "docs: feature the ERC-7715 AP + 1Shot redeem main flow honestly"
```

---

## Self-Review

**Spec coverage:**
- Real AP grant on Base Sepolia → Task 4 ✓
- Redeem = transfer-only into depositor → Task 5 ✓ (recipient unconstrained — verified)
- Grantee = redeemer (server wallet / session EOA) → Task 1 decides, Task 4 applies ✓
- New `depositHeld` from contract balance + scope/replay/EIP-712 → Task 2 ✓
- Transient-custody safety (sweep + ZeroCustody invariant) → Task 2 ✓
- Redeploy + address/ABI sync → Task 3 ✓
- 1Shot array-param risk → Task 1 spike with a/b/c fallback ✓
- Main-flow wiring (orchestrator grant + worker redeem→depositHeld) → Task 6 ✓
- Pitch/docs honesty → Task 7 ✓

**Placeholder scan:** Task 5/6 relay-array shape + `SINGLE_DEFAULT_MODE` bytes32 + `redeemDelegations` context-vs-Delegation[] form are pinned to the Task 1 spike outcome — flagged inline, not vague. No "TBD"/"handle errors"/"similar to" left.

**Type consistency:** `depositHeld(amount,minAmount,minShares,execId,sig)` matches `DEPOSIT_INPUTS` (relay) and `HELD_DEPOSIT_TYPES` (sign). `hashHeldDeposit` fields == `HELD_DEPOSIT_TYPEHASH` == `AgentHeldDeposit` EIP-712 struct. `requestERC7715Permission(capUnits, expirySeconds)` new signature is updated at its only caller (orchestrator Task 6) — **breaking-change note:** grep for other `requestERC7715Permission(` callers (e.g. `app.jsx`, screens) during Task 6 and update them to pass `capUnits`.

**Carry-forward:** `config.js DEPOSITOR_ABI` was stale (missing `minShares`) — fixed in Task 3. Update memory `[[hackathon-7715-qualification]]` to record decision A+ii + the verified redeem mechanics after execution.
```