---
name: public-relayer
description: Integrate a client app with the 1Shot public relayer JSON-RPC API to submit gas-abstracted EIP-7710 delegated transactions on EVM chains. Use this skill whenever a developer mentions the 1Shot relayer, gasless or gas-abstracted EVM transactions, ERC-7710 delegations, `relayer_send7710Transaction`, `relayer_send7710TransactionMultichain`, `relayer_estimate7710Transaction`, `relayer_estimate7710TransactionMultichain`, `relayer_getCapabilities`, `relayer_getFeeData`, or `relayer_getStatus`; wants to estimate or quote the cost of a relayer transaction; wants to upgrade an EOA to a `7702StatelessDelegator` smart account; sign delegations with `@metamask/smart-accounts-kit`; integrate a browser wallet flow with `window.ethereum`, `requestExecutionPermissions`, `decodeDelegations`, or EIP-7715; pay relayer fees in ERC-20 tokens; lock in a gas-price quote; build a webhook receiver for relayer status events; or verify Ed25519 webhook signatures from `/.well-known/jwks.json`. Trigger this skill even when the user does not name the relayer explicitly but is clearly trying to send a gas-abstracted EVM transaction through a third-party relay using EIP-7710 / EIP-7702.
---

# 1Shot Public Relayer (EIP-7710) Integration

This skill teaches a client-side coding agent how to integrate with the **1Shot public relayer** JSON-RPC API to submit gas-abstracted ERC-7710 delegated transactions.

The relayer accepts a signed MetaMask delegation from a `7702StatelessDelegator` smart account, redeems it on-chain through a target wallet, and accepts payment in an ERC-20 token on the same chain (single-chain) or a different chain (multichain).

## When to use this skill

- Building a client app/SDK/wallet/agent that submits transactions through the 1Shot relayer
- Upgrading an EOA to a MetaMask `7702StatelessDelegator` smart account via EIP-7702
- Creating, signing, and submitting ERC-7710 delegations
- Estimating or quoting the relayer fee for a transaction before submit
- Locking in a relayer gas price for a quote window
- Receiving and verifying signed webhook events from the relayer

## Endpoints and packages

- **Relayer JSON-RPC URL**: choose endpoint by chain before calling `relayer_getCapabilities`, `relayer_getFeeData`, `relayer_estimate7710Transaction`, `relayer_estimate7710TransactionMultichain`, `relayer_send7710Transaction`, `relayer_send7710TransactionMultichain`, or `relayer_getStatus`:
  - Mainnets: `https://relayer.1shotapi.com/relayers`
  - Sepolia (`11155111`) and Base Sepolia (`84532`): `https://relayer.1shotapi.dev/relayers`
- **JWKS for webhook verification**: `GET https://relayer.1shotapi.com/.well-known/jwks.json` (Ed25519, `kty: "OKP"`, `crv: "Ed25519"`).
- **Client packages**:
  - `@metamask/smart-accounts-kit` (recommend `^1.3.0`) — single package for all delegation and smart-account flows:
    - Main export: `toMetaMaskSmartAccount`, `createDelegation`, `ScopeType`, `Implementation.Stateless7702`, `getSmartAccountsEnvironment`.
    - `@metamask/smart-accounts-kit/actions`: `erc7715ProviderActions` for browser EIP-7715 flows.
    - `@metamask/smart-accounts-kit/utils`: `decodeDelegations` to decode permission context from the wallet.
  - `viem` for `createPublicClient`, `encodeFunctionData`, `signAuthorization`, `privateKeyToAccount`.
  - `@noble/ed25519` (or any Ed25519 verifier) for webhook signature verification.

**Method naming:** multichain variants append `Multichain` directly to the base method name (no underscore), e.g. `relayer_send7710Transaction` → `relayer_send7710TransactionMultichain`.

**Migration note:** `@metamask/delegation-toolkit` is deprecated. Remove it from client `package.json` and use `@metamask/smart-accounts-kit` with the subpath imports above.

### Browser extension integration (recommended for UI apps)

When the user is signing in a browser with MetaMask (or another extension wallet), prefer an extension-first flow:

1. Create a wallet client from `window.ethereum` with `createWalletClient({ transport: custom(window.ethereum) })`.
2. Extend it with `erc7715ProviderActions()` from `@metamask/smart-accounts-kit/actions`.
3. (Optional) Call `getSupportedExecutionPermissions()` to verify the wallet supports the permission type you need.
4. Request permissions through the extension via `requestExecutionPermissions(...)`. Set `to` to the relayer's **`targetAddress`** from Step 1 — not a dapp session account. The relayer redeems delegations granted directly to its redemption wallet.
5. Decode `context` with `decodeDelegations(context)` from `@metamask/smart-accounts-kit/utils`, run each delegation through `toRelayerJson`, and pass the result as `permissionContext` in `relayer_send7710Transaction`.

**Wallet prerequisites** (see [execute on a MetaMask user's behalf](https://docs.metamask.io/smart-accounts-kit/guides/advanced-permissions/execute-on-metamask-users-behalf/)):

- ERC-20 periodic permissions require MetaMask Flask ≥13.5 or MetaMask production ≥13.23.
- The user must be upgraded to a MetaMask Smart Account (EIP-7702). Check with `publicClient.getCode(address)` — if code is present, compare the delegator address (strip the `0xef0100` prefix) against `getSmartAccountsEnvironment(chainId).implementations.EIP7702StatelessDeleGatorImpl`. Prompt the user to upgrade if needed.

Why this path matters: extension wallets own the keys and permission UX. Local/internal signing helpers like `signDelegation` are the right fit for backend or script-driven signers, but they can fail or mislead in extension flows.

If `requestExecutionPermissions` is unavailable, surface this clearly: the connected wallet likely does not support EIP-7715 and the app should prompt the user to switch wallets.

## Order of operations

Follow these steps **in order** for any new integration.

### Step 1 — `relayer_getCapabilities`: discover the chain, accepted tokens, and `targetAddress`

Call once per chain you want to support. The response tells you:

- Which `chainId`s are supported.
- The list of **accepted ERC-20 payment tokens** (`address`, `symbol`, `decimals`) per chain.
- The `feeCollector` address (where the fee transfer must go).
- The `targetAddress` — **this is the address the client must sign the delegation `to`**. It is the relayer's redemption account on that chain. Without delegating to this exact address, the relayer cannot redeem.

Cache the result for the session; it changes rarely.

```jsonc
// Request
{ "jsonrpc": "2.0", "id": 1, "method": "relayer_getCapabilities", "params": ["8453", "84532"] }

// Response (excerpt)
{ "result": {
  "8453": {
    "feeCollector": "0x1111...",
    "targetAddress": "0x2222...",     // ← delegate `to` this address
    "tokens": [{ "address": "0x036C...", "symbol": "USDC", "decimals": "6" }]
  }
}}
```

### Step 2 — Build and sign the bundle (client-side)

Before quoting or submitting, assemble the full ERC-7710 bundle:

1. **Initialize the smart account** with `toMetaMaskSmartAccount({ implementation: Implementation.Stateless7702, address: <delegator EOA address>, signer })`.
2. **(If first use)** sign an EIP-7702 `authorizationList` entry with `account.signAuthorization({ chainId, contractAddress: getSmartAccountsEnvironment(chainId).implementations.EIP7702StatelessDeleGatorImpl, nonce })` — include it on estimate and send.
3. **Generate permission context**:
   - Browser extension path: call `requestExecutionPermissions` (with `to: targetAddress`), decode `granted[0].context` with `decodeDelegations`, and serialize with `toRelayerJson`.
   - Local signer path: create a delegation with `createDelegation({ to: targetAddress (from Step 1), from: smartAccount.address, environment: smartAccount.environment, salt, scope: { type: ScopeType.Erc20TransferAmount | ScopeType.FunctionCall, ... maxAmount: feeAmount + workAmount } })` and sign with `smartAccount.signDelegation({ delegation })`.
4. **Encode each execution's calldata** (`encodeFunctionData` for the fee `transfer` to `feeCollector` and for the user's primary work).

Include a **mock fee payment** execution: an ERC-20 `transfer` to `feeCollector` with amount **≥ `minFee`** for that token (use `relayer_getFeeData` or a conservative placeholder such as `0.01` USDC). The relayer parses this leg to determine the payment token. For multichain, only the fee-chain param needs the fee leg; the work-chain param can omit it.

For user-entered token amounts, parse decimal strings with token decimals first (for example, `parseUnits("0.01", 6)` for USDC). Never pass decimal strings directly to `BigInt`, because `"0.01"` is invalid and leads to runtime failures.

### Step 3 — `relayer_estimate7710Transaction` or `relayer_estimate7710TransactionMultichain`: quote the fee (preferred)

Once the signed bundle exists, call the matching estimate method with the **same `params` shape** as send (omit `context`; `taskId`, `destinationUrl`, and `memo` are optional and ignored for pricing):

| You need …                                                                               | Use this method                              |
| ---------------------------------------------------------------------------------------- | -------------------------------------------- |
| Pay fee and execute work on the **same** chain                                           | `relayer_estimate7710Transaction`            |
| Pay fee on chain A and execute work on chain B (or batch multiple chains atomically)     | `relayer_estimate7710TransactionMultichain`  |

The relayer validates delegations, runs 1Shot gas simulation, and returns synchronously (no task is created):

- `success` (boolean) — `false` when validation or simulation fails; read `error` in the result (not always a JSON-RPC error).
- `requiredPaymentAmount` (string, token atoms) — fee to pay in the mock payment token, floored at chain/token `minFee`.
- `gasUsed` — map of chain id → summed gas units (decimal strings).
- `context` — signed price-lock quote for the first payment chain; pass as `params.context` on single-chain send.
- `contextByChainId` — per-chain signed quotes; for multichain send, set each `params[i].context = contextByChainId[params[i].chainId]`.

**Production loop**:

1. POST estimate with the current bundle (mock fee ≥ `minFee`).
2. If `success === false`, fix the bundle from `error` (missing payment, below minFee, simulation revert, invalid delegation).
3. If `requiredPaymentAmount` differs from your mock fee, update the fee execution amount and delegation `maxAmount`, then **re-sign** the delegation.
4. Immediately send with the `context` / `contextByChainId` from the estimate response to lock the quote (~45 seconds).

This supersedes client-side `eth_estimateGas` + manual fee math when the full bundle is ready.

### Step 2b (fallback) — `relayer_getFeeData`: rough quote before the bundle exists

Use when the bundle is **not** built yet — for example, browser permission UX that needs a rough fee before the user signs, or a quick price display. Call once per `(chainId, paymentToken)`. The response contains:

- `gasPrice` (hex wei) — current relayer gas price in native gas units.
- `rate` (number) — exchange rate to convert native gas cost into the payment token amount.
- `minFee` (string, in token atoms) — **the floor fee, equivalent to $0.01 in the payment token**.
- `expiry` (unix seconds) — quote validity (~45 seconds; treat anything past `expiry` as stale).
- `context` (string) — signed price-lock context (prefer the `context` returned from estimate when the bundle exists).

**Manual fee math** (when estimate is unavailable):

1. Estimate `gasUsed` for the work transaction(s) (use `eth_estimateGas` or a known upper bound).
2. `nativeFee = gasPrice * gasUsed` (wei).
3. Convert to payment-token atoms using `rate`.
4. **Floor**: `feeAmount = max(converted, minFee)`.

The delegation's caveat scope must allow at least `feeAmount` to be transferred to `feeCollector`. Under-paying causes `InsufficientPayment` (4200).

### Step 4 — `relayer_send7710Transaction` or `relayer_send7710TransactionMultichain`: submit the bundle

Choose a signing path first:

- **Browser extension path (recommended for UI apps):** request permissions with `requestExecutionPermissions`, decode with `decodeDelegations`, and send decoded delegations in `permissionContext`.
- **Local signer path (backend/scripts):** build and sign delegations with `createDelegation` + `smartAccount.signDelegation` (see Step 2).

POST the JSON-RPC body built in Steps 2–3. The `params.context` field must be the **signed price-lock `context`** from the matching estimate response (`result.context` for single-chain; `result.contextByChainId[chainId]` per param for multichain), not a free-form string.

Choose the right method:

| You need …                                                                               | Use this method                              |
| ---------------------------------------------------------------------------------------- | -------------------------------------------- |
| Pay fee and execute work on the **same** chain                                           | `relayer_send7710Transaction`                |
| Pay fee on chain A and execute work on chain B (or batch multiple chains atomically)     | `relayer_send7710TransactionMultichain`      |

Both methods accept an optional **`destinationUrl`** (≤256 chars). When set, the relayer POSTs **signed Ed25519 webhook events** to that URL on every status change. **Encourage `destinationUrl` over polling** — it scales better and gives sub-second updates.

Both methods also accept an optional **`memo`** (≤256 chars): an opaque client correlation string (order ID, internal ref, etc.). It does not affect execution, pricing, or on-chain calldata — the relayer stores it and echoes it back in `relayer_getStatus` and webhook payloads when set. Omit on estimate (same param type is accepted but ignored for pricing, like `taskId` / `destinationUrl`). For multichain, each array entry may carry its own `memo` (each becomes a separate task).

The result is a `TaskId` (single) or `TaskId[]` (multichain, in submitted order).

### Step 5 — `relayer_getStatus`: check status (or use webhooks)

If `destinationUrl` is set, **prefer the webhook** — the relayer POSTs signed JSON on each status change. Outbound webhook bodies use a numeric **`type`** field (not a string event name):

| `type` | Meaning |
| ------ | ------- |
| `4` | Submitted (on-chain tx hash available) |
| `0` | Confirmed success |
| `1` | Reverted / execution failure |

The **`data`** field is the same object shape as `relayer_getStatus` for that task — including optional **`memo`** at `data.memo` when you sent `params.memo` on submit (omitted otherwise, never `null`).

To verify each webhook:

1. Fetch and cache `GET https://relayer.1shotapi.com/.well-known/jwks.json` (rotates infrequently).
2. Look up the public key by `kid` from the webhook body's `keyId`.
3. Reconstruct the signed payload by removing the `signature` field, then serialize with **stable, sorted-key JSON** (use `safe-stable-stringify` or equivalent — the relayer signs the canonical form).
4. Verify with Ed25519 over UTF-8 bytes; treat the base64 `signature` as the 64-byte detached signature.

If polling is unavoidable, call `relayer_getStatus` with `{ id: <TaskId>, logs: true|false }` every 2–3 seconds and stop on a terminal status. When you sent `params.memo`, the status object includes **`memo`** at every status code; when omitted at send, the field is absent (not `null`). Status codes:

| Code | Label     | Terminal? |
| ---- | --------- | --------- |
| 100  | Pending   | no        |
| 110  | Submitted | no (has `hash`) |
| 200  | Confirmed | yes (has `receipt`) |
| 400  | Rejected  | yes (has `message`) |
| 500  | Reverted  | yes (has `data`) |

## Decisions cheat sheet

- **Quote fee how?**: when the signed bundle exists, prefer **`relayer_estimate7710Transaction`** (single-chain) or **`relayer_estimate7710TransactionMultichain`** (multichain) — the relayer simulates gas and returns `requiredPaymentAmount` plus signed `context`. Use **`relayer_getFeeData`** only for rough quotes before the bundle is built (e.g. browser permission UX) or when estimate is unavailable.
- **Self-sponsored vs. sponsored**: if the same account pays the fee and executes the work, sign **one delegation** that scopes `feeAmount + workAmount` and bundle two `executions` (fee transfer + work). If a separate sponsor pays the fee, sign **two delegations** (one each from sponsor and delegator) and submit two `transactions[]` entries with their own `permissionContext`. The relayer merges them into a single `redeemDelegations` batch.
- **`ScopeType` choice**: `ScopeType.Erc20TransferAmount` is simplest and works for fee + work transfers. Use `ScopeType.FunctionCall` (token + selector) when you need broader function coverage in one batch — the `Erc20TransferAmount` enforcer can revert with `CaveatEnforcer:invalid-call-type` for some batched call patterns.
- **EIP-7702 authorization**: only one `authorizationList` entry is allowed per request. If both delegator and sponsor need an upgrade, do them in two separate calls (or upgrade one out-of-band first).
- **Salt**: always pass a fresh random 32-byte hex `salt` to `createDelegation` to avoid replay collisions.
- **`memo` vs `context` vs `taskId`**: `context` locks the fee quote from estimate; `taskId` is the relayer-assigned (or client-supplied) task identifier; `memo` is your opaque label echoed back in status and webhooks for correlation.
- **BigInts to JSON**: relayer JSON-RPC requires plain JSON. Convert `bigint` values in the signed delegation struct to `0x`-prefixed hex strings before sending. Convert `Uint8Array` with `bytesToHex` from `viem/utils`.

## Minimal end-to-end shape

```ts
// 1. capabilities
const caps = await rpc("relayer_getCapabilities", [chainId]);
const { targetAddress, feeCollector, tokens } = caps[chainId];
const paymentToken = tokens.find((t) => t.symbol === "USDC")!;

// 2. build + sign bundle (mock fee ≥ minFee; see examples.md)
const sendParams = {
  chainId,
  transactions: [{ permissionContext: [signedDelegation], executions: [feeTransfer, workCall] }],
};

// 3. estimate (same params as send, no context)
const estimate = await rpc<Estimate7710Result>(
  "relayer_estimate7710Transaction",
  sendParams,
);
if (!estimate.success) throw new Error(estimate.error);
const feeAmount = BigInt(estimate.requiredPaymentAmount!);
// if feeAmount changed: rebuild fee execution + delegation scope, re-sign, re-estimate

// 4. submit with price lock from estimate
const taskId = await rpc("relayer_send7710Transaction", {
  ...sendParams,
  context: estimate.context,
  destinationUrl: "https://my-app.example.com/relayer-webhook", // optional, recommended
  memo: "order-abc123", // optional; echoed in relayer_getStatus and webhooks
});

// Multichain: estimate with params array, then send each entry with
// context: estimate.contextByChainId![param.chainId]

// 5. either consume webhooks or poll relayer_getStatus
```

## Common error codes

**Estimate responses**: `relayer_estimate7710Transaction` and `relayer_estimate7710TransactionMultichain` return `result.success: false` with an `error` string for validation and simulation failures (missing mock payment, fee below `minFee`, gas estimation revert). These are not always JSON-RPC errors — check `result.success` before send.

| Code | Meaning                       | Typical fix                                                                 |
| ---- | ----------------------------- | --------------------------------------------------------------------------- |
| 4200 | Insufficient Payment          | Increase `feeAmount` to at least `requiredPaymentAmount` / `minFee`; re-sign. |
| 4201 | Invalid Signature             | Re-sign the delegation; ensure `salt` is fresh and `signer` matches `from`. |
| 4202 | Unsupported Payment Token     | Pick a token from `relayer_getCapabilities` for the chain.                  |
| 4204 | Quote Expired                 | Re-run estimate (or re-fetch `relayer_getFeeData`) and resubmit within ~45s. |
| 4206 | Unsupported Chain             | Confirm the `chainId` appears in `relayer_getCapabilities`.                 |
| 4209 | Unsupported Capability        | Adjust delegation scope/caveats; check the relayer supports the call type.  |
| 4210 | Invalid Authorization List    | At most one `authorizationList` entry; verify `nonce` is current.           |
| 4211 | Simulation Failed             | The relayer pre-simulates; inspect `data` for the revert reason.            |
| 4212 | Multichain Not Supported      | Fall back to `relayer_send7710Transaction` per chain.                       |
| 4214 | Duplicate Task ID             | Omit `taskId` and let the relayer assign one, or send a fresh random hex.   |

## Browser-flow pitfalls and fixes

- `"wallet_requestExecutionPermissions does not exist"`: wallet does not support EIP-7715. Prompt the user to switch to a compatible wallet.
- `"External signature requests cannot sign delegations for internal accounts"`: wrong signing path. Use extension permission requests, not internal-account delegation signing.
- `"Account does not support signMessage"`: signer/account mismatch. In extension mode, avoid local-account assumptions.
- `"Cannot convert 0.01 to a BigInt"`: parse decimal inputs with token decimals first, then convert.

See [references/schemas.md](references/schemas.md) for the complete error catalog and full request/response schemas.

## Composing with `webauthn-prf-wallet` for a fully non-custodial app

The public relayer pairs naturally with the **`webauthn-prf-wallet`** skill (separately installed) to build a **fully non-custodial web3 application with no vendor lock-in and no business account required**:

- `webauthn-prf-wallet` derives an EVM private key from the user's passkey via the WebAuthn PRF extension and keeps it inside an isolated iframe — the key never reaches the parent page or any server.
- That passkey-derived account is the natural **delegator** in this skill's flow: have the iframe sign the EIP-7702 authorization, the `7702StatelessDelegator` upgrade, and each `createDelegation` payload.
- The public relayer is an open JSON-RPC service (no API key, no Bearer token) that the user pays per-transaction in stablecoins. There is no relationship to lock in — anyone can stand up an alternate relayer that speaks the same `relayer_*` methods, and the client can switch by changing `RELAYER_URL`.

End-to-end, the user owns their key (passkey), pays only the per-tx fee (ERC-20), and the application owns no custodial surface and no business credentials. Reach for this combo when a developer asks for a "passkey wallet that can transact without holding ETH" or "non-custodial app with no API keys to manage." Read `webauthn-prf-wallet/SKILL.md` for the client-side wallet pattern and use this skill for the relayer JSON-RPC flow.

## Additional resources

- [references/schemas.md](references/schemas.md) — full JSON-RPC method signatures, schemas, status/error codes, JWKS body shape. Read this when you need exact parameter shapes, the complete error catalog, or the on-the-wire webhook payload format.
- [references/examples.md](references/examples.md) — runnable TypeScript patterns: browser extension (MetaMask + viem + EIP-7715 permissions), estimate-first single-chain and multichain flows, self-sponsored, sponsored, webhook receiver with Ed25519 verification. Read this when you're about to write client code or want to copy a known-good integration shape.
- `webauthn-prf-wallet` skill — companion skill for client-side passkey-derived EVM keys held in an isolated iframe. Use together with this skill for a fully non-custodial setup.
- MetaMask Smart Accounts Kit — [install](https://docs.metamask.io/smart-accounts-kit/get-started/install/), [browser / EIP-7715 flow](https://docs.metamask.io/smart-accounts-kit/guides/advanced-permissions/execute-on-metamask-users-behalf/), [local signer / delegation flow](https://docs.metamask.io/smart-accounts-kit/guides/delegation/execute-on-smart-accounts-behalf/), [Advanced Permissions wallet-client reference](https://docs.metamask.io/smart-accounts-kit/reference/advanced-permissions/wallet-client/).
