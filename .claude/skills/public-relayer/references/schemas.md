# Public Relayer Reference

Detailed JSON-RPC method, schema, status, error, and webhook reference. Read this when you need exact parameter shapes, the full error catalog, or the on-the-wire webhook payload format.

All requests are JSON-RPC 2.0 over `POST` with `Content-Type: application/json`. Endpoint:

- Production: `https://relayer.1shotapi.com/relayers`
- Dev: `https://relayer.1shotapi.dev/relayers`

The full machine-readable spec is in `openrpc.json` at the root of the relayer repository.

## Table of contents

- [Methods covered](#methods-covered)
- [`relayer_getCapabilities`](#relayer_getcapabilities)
- [`relayer_getFeeData`](#relayer_getfeedata)
- [`relayer_estimate7710Transaction`](#relayer_estimate7710transaction)
- [`relayer_estimate7710TransactionMultichain`](#relayer_estimate7710transactionmultichain)
- [`relayer_send7710Transaction`](#relayer_send7710transaction)
- [`relayer_send7710TransactionMultichain`](#relayer_send7710transactionmultichain)
- [`relayer_getStatus`](#relayer_getstatus)
- [Error catalog](#error-catalog)
- [Webhook payload (when `destinationUrl` is set)](#webhook-payload-when-destinationurl-is-set)
  - [`type` values](#type-values)
  - [`data` shape](#data-shape)
  - [Verification protocol](#verification-protocol)
  - [Idempotency](#idempotency)
- [Production tips](#production-tips)

---

## Methods covered

| Method                                   | Purpose                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| `relayer_getCapabilities`                | Discover supported chains, payment tokens, `feeCollector`, `targetAddress`. |
| `relayer_getFeeData`                     | Fetch a signed price-lock context, `gasPrice`, `rate`, `minFee`, `expiry` (rough quote before bundle exists). |
| `relayer_estimate7710Transaction`        | Synchronous fee quote for a single-chain 7710 bundle; validates + simulates without creating a task. |
| `relayer_estimate7710TransactionMultichain` | Same for multichain bundles; returns combined fee + per-chain `contextByChainId`. |
| `relayer_send7710Transaction`            | Submit one ERC-7710 delegated bundle on a single chain.                  |
| `relayer_send7710TransactionMultichain`  | Submit per-chain ERC-7710 bundles atomically (fee on chain A, work on chain B). |
| `relayer_getStatus`                      | Poll the status of a submitted task by `TaskId`.                         |

The legacy `relayer_sendTransaction` and `relayer_sendTransactionMultichain` (OKX gasless flow) are intentionally **not** covered here.

---

## `relayer_getCapabilities`

### Params

`string[]` — array of chain IDs as decimal strings (e.g. `["8453", "84532"]`).

### Result

```ts
type GetCapabilitiesResult = Record<string /* chainId */, {
  feeCollector: `0x${string}`;       // address fee transfers must target
  targetAddress: `0x${string}`;      // address the client must delegate `to`
  tokens: Array<{
    address: `0x${string}`;
    symbol?: string;
    name?: string;
    decimals: number | string;       // may arrive as a numeric string
  }>;
}>;
```

### Notes

- Cache the response per session.
- `targetAddress` is the relayer's redemption account on that chain — the **only** valid `to` field for `createDelegation` when targeting that relayer.

---

## `relayer_getFeeData`

### Params

```ts
type GetFeeDataParams = {
  chainId: string;     // decimal chainId
  token: `0x${string}`; // ERC-20 payment token address (must be in capabilities.tokens)
};
```

### Result

```ts
type GetFeeDataResult = {
  chainId: string;
  token: { address: `0x${string}`; decimals: number; symbol?: string; name?: string };
  rate: number;            // exchange rate: native gas units → payment-token atoms
  minFee: string;          // floor fee in token atoms (≈ $0.01 worth)
  expiry: number;          // unix seconds; quote unusable after this
  gasPrice: `0x${string}`; // current gas price in wei (hex)
  feeCollector: `0x${string}`;
  targetAddress?: `0x${string}`;
  context?: string;        // signed price-lock; pass verbatim to send7710Transaction.context
};
```

### Computing the fee amount

```ts
const nativeFeeWei = BigInt(feeData.gasPrice) * BigInt(estimatedGasUsed);
// Convert to payment-token atoms; rate already accounts for token decimals
const tokenAtoms = scaleNativeToToken(nativeFeeWei, feeData.rate, feeData.token.decimals);
const feeAmount = tokenAtoms < BigInt(feeData.minFee) ? BigInt(feeData.minFee) : tokenAtoms;
```

**Always floor at `minFee`.** It represents $0.01 in the payment token; the relayer rejects payment below it with `4200 InsufficientPayment`.

### Quote lifetime

Treat the quote as valid for the smaller of `(expiry - now)` and **45 seconds**. Fetch fresh quotes between retries.

**Prefer `relayer_estimate7710Transaction`** when the signed bundle exists — estimate returns `requiredPaymentAmount` and signed `context` from a server-side 1Shot gas simulation.

---

## `relayer_estimate7710Transaction`

### Params

Same object as [`relayer_send7710Transaction`](#relayer_send7710transaction) (`Send7710TransactionParams`). Do **not** pass `context` on input. `taskId`, `destinationUrl`, and `memo` are optional and ignored for pricing.

### Result

```ts
type Estimate7710TransactionResult = {
  success: boolean;
  /** First parsed relayer payment token (when success). */
  paymentTokenAddress?: `0x${string}`;
  /** Chain id of paymentTokenAddress (when success). */
  paymentChain?: number;
  /** Per-chain sum of 1Shot gas units (decimal strings), keyed by chain id string. */
  gasUsed: Record<string, string>;
  /** Required fee in paymentTokenAddress smallest units (when success); floored to chain/token minFee. */
  requiredPaymentAmount?: string;
  /** Signed price quote for the first payment chain; pass as params.context on send7710. */
  context?: string;
  /** Per-chain signed quotes; for multichain send, set each params[i].context from this map. */
  contextByChainId?: Record<string, string>;
  /** Present when success is false. */
  error?: string;
};
```

### Behavior

- Validates delegations, executions, and optional `authorizationList` without persisting a task or DB row.
- Parses the **first mock payment** from executions: an ERC-20 `transfer` to `feeCollector` (from `getCapabilities`).
- Mock fee amount must be **≥ chain/token `minFee`** (from `getFeeData` or capabilities).
- Runs 1Shot gas simulation on the encoded `redeemDelegations` calldata.
- Returns `success: false` with `error` for validation/simulation failures — these are returned in `result`, not always as JSON-RPC errors.

### Wiring to send

Pass `result.context` as `params.context` on `relayer_send7710Transaction` to lock gas price / TWAP to this estimate (~45 seconds).

---

## `relayer_estimate7710TransactionMultichain`

### Params

Same array as [`relayer_send7710TransactionMultichain`](#relayer_send7710transactionmultichain): `Send7710TransactionParams[]` (one entry per chain). Omit `context` on each entry.

### Result

Same `Estimate7710TransactionResult` as single-chain estimate. `requiredPaymentAmount` is the combined fee in the **first mock payment token**. `gasUsed` and `contextByChainId` cover all chains in the request.

### Notes

- Only the **fee-chain** param needs a fee payment execution to `feeCollector`; work-chain params may omit the fee leg.
- On send, set each `params[i].context = result.contextByChainId![params[i].chainId]`.
- Typical order: fee chain first, work chain second (application-defined; task IDs match submit order).

---

## `relayer_send7710Transaction`

### Params

```ts
type Send7710TransactionParams = {
  chainId: string;
  transactions: DelegatedTransaction7710[]; // see below; merged into one redeemDelegations batch
  authorizationList?: AuthorizationListEntry[]; // ≤1 entry; for in-flight EIP-7702 upgrade
  context?: string;            // signed price-lock from estimate or getFeeData
  taskId?: `0x${string}`;      // optional client-provided id; 32-byte hex; must be unique
  destinationUrl?: string;     // ≤256 chars; webhook URL for status events
  memo?: string;               // ≤256 chars; optional opaque label; echoed in status/webhooks when set
};

type DelegatedTransaction7710 = {
  permissionContext: Delegation7710[]; // delegation chain (length 1 for direct delegation)
  executions: Execution7710[];
};

type Delegation7710 = {
  delegate: `0x${string}`;     // = targetAddress
  delegator: `0x${string}`;    // = signer's smart account address
  authority: string;           // bytes32; "0x000…0" for root authority
  caveats: Array<{ enforcer: `0x${string}`; terms: string; args: string }>;
  salt: string;                // 32-byte hex; fresh per delegation
  signature: string;           // hex; from smartAccount.signDelegation
};

type Execution7710 = {
  target: `0x${string}`;       // contract to call
  value: string;               // wei as decimal or 0x-hex string
  data: `0x${string}`;         // calldata
};

type AuthorizationListEntry = {
  address: `0x${string}`;      // implementation contract (e.g. 7702StatelessDelegator)
  chainId: number | string;
  nonce: number | string;
  r: `0x${string}`;
  s: `0x${string}`;
  yParity: number | string;
};
```

### Result

`TaskId` (`0x` + 64 hex chars).

### Behavior

- All entries in `transactions[]` are merged server-side into a **single** `redeemDelegations` batch on-chain. Each entry carries its own `permissionContext`, so you can mix sponsor and delegator delegations in one call.
- `authorizationList` may contain at most **one** entry. Sending more returns `4210 Invalid Authorization List`.
- Pass `context` from the matching [`relayer_estimate7710Transaction`](#relayer_estimate7710transaction) response (`result.context`) to honor the estimate.
- If `destinationUrl` is set, the relayer POSTs Ed25519-signed JSON to it on each status change.
- Optional `memo` is stored server-side and returned on `relayer_getStatus` and in webhook `data`; it does not affect relay logic or on-chain execution.

---

## `relayer_send7710TransactionMultichain`

### Params

```ts
type Send7710TransactionMultichainParams = Send7710TransactionParams[]; // one entry per chain
```

The first entry is typically the **fee** chain and the second is the **work** chain, but ordering is application-defined; the relayer returns task IDs in the same order.

### Result

`TaskId[]` — one per chain entry, in submitted order.

### Notes

- Each chain entry has its own `authorizationList`, `context`, `transactions`, `taskId`, `destinationUrl`, and `memo`.
- Pass per-chain `context` from [`relayer_estimate7710TransactionMultichain`](#relayer_estimate7710transactionmultichain) (`result.contextByChainId[chainId]`).
- Returns `4212 MultichainNotSupported` if the relayer instance does not enable multichain.

---

## `relayer_getStatus`

### Params

```ts
type GetStatusParams = { id: `0x${string}`; logs: boolean };
```

`logs: true` includes EVM event logs in the receipt for confirmed txs.

### Result (discriminated by `status`)

| `status` | Label     | Required extra fields            |
| -------- | --------- | -------------------------------- |
| 100      | Pending   | —                                |
| 110      | Submitted | `hash` (tx hash)                 |
| 200      | Confirmed | `receipt` (`{ blockHash, blockNumber, gasUsed, transactionHash, logs? }`) |
| 400      | Rejected  | `message`                        |
| 500      | Reverted  | `data` (revert data); optional `message` |

```ts
type BaseStatus = {
  id: `0x${string}`;
  chainId: string;
  createdAt: number;
  status: 100|110|200|400|500;
  memo?: string;  // present only when send included memo; never null
};
```

Always handle `100`, `110`, `200`, `400`, `500` explicitly. Stop polling on any of `200/400/500`.

---

## Error catalog

| Code   | Message                       | Notes                                                                        |
| ------ | ----------------------------- | ---------------------------------------------------------------------------- |
| -32600 | Invalid Request               | JSON-RPC envelope malformed.                                                 |
| -32601 | Method not found              | Misspelled method or unsupported on this chain.                              |
| -32602 | Invalid params                | Schema mismatch; check `params` against this reference.                      |
| -32603 | Internal error                | Generic JSON-RPC internal error.                                             |
| -1     | Internal error                | Server-side error; safe to retry with backoff.                               |
| 4001   | User Rejected Request         | Surfaced from upstream user-driven flows.                                    |
| 4100   | Unauthorized                  | Missing/invalid auth on protected methods.                                   |
| 4200   | Insufficient Payment          | `feeAmount` below `minFee` or computed quote; floor at `minFee`.             |
| 4201   | Invalid Signature             | Re-sign delegation with fresh `salt`; verify signer matches `delegator`.     |
| 4202   | Unsupported Payment Token     | Token not in `relayer_getCapabilities.tokens` for this chain.                |
| 4203   | Rate Limit Exceeded           | Backoff and retry; consider batching.                                        |
| 4204   | Quote Expired                 | Re-run estimate or refetch `relayer_getFeeData`; resubmit within ≤45 seconds. |
| 4205   | Insufficient Balance          | Delegator/sponsor lacks token balance for the planned transfers.             |
| 4206   | Unsupported Chain             | `chainId` not in capabilities.                                               |
| 4207   | Transaction Too Large         | Reduce `executions[]` count or split into multiple bundles.                  |
| 4208   | Unknown Transaction ID        | `relayer_getStatus` task ID not recognized.                                  |
| 4209   | Unsupported Capability        | Caveat/scope combo not supported; switch `ScopeType` or simplify caveats.    |
| 4210   | Invalid Authorization List    | More than one entry, or entry doesn't recover to `delegator`/`sponsor`.      |
| 4211   | Simulation Failed             | Inspect `data` for the inner revert reason; fix calldata or scope.           |
| 4212   | Multichain Not Supported      | Fall back to per-chain `relayer_send7710Transaction`.                        |
| 4213   | Invalid Task ID               | If supplying `taskId`, must be 32-byte 0x-hex.                               |
| 4214   | Duplicate Task ID             | Omit `taskId` (server generates) or use a fresh random 32 bytes.             |

---

## Webhook payload (when `destinationUrl` is set)

The relayer POSTs `application/json` bodies to your URL on status changes (Submitted, Confirmed, Reverted). Each body is an Ed25519-signed envelope:

```ts
type OutboundWebhook = {
  apiVersion: 0;
  type: 0 | 1 | 4;           // 4=Submitted, 0=Success, 1=Failure
  data: GetStatusResponse;   // same discriminated union as relayer_getStatus
  timestamp: number;         // unix seconds
  keyId: string;             // matches a `kid` in /.well-known/jwks.json
  signature: string;         // base64 Ed25519; verify over body without signature
};
```

### `type` values

| `type` | Meaning |
| ------ | ------- |
| `4` | Submitted — `data.status` is `110`; `data.hash` is the on-chain tx hash |
| `0` | Confirmed — `data.status` is `200`; `data.receipt` is populated |
| `1` | Failure — `data.status` is `500`; `data.data` holds revert data |

### `data` shape

`data` is identical to the [`relayer_getStatus`](#relayer_getstatus) response for that task at the time of the event. When the client sent `params.memo` on submit, **`data.memo`** is present on every webhook for that task; when omitted at send, the field is absent (never `null`).

Use `data.memo` to correlate webhook events with your application state without maintaining a separate taskId→orderId map.

### Verification protocol

1. Fetch and cache `/.well-known/jwks.json`. Body shape:

   ```json
   {
     "keys": [
       { "kty": "OKP", "crv": "Ed25519", "kid": "<key-id>", "x": "<base64url public key>" }
     ]
   }
   ```

2. On receive, look up the public key by `kid === body.keyId`.
3. **Strip `signature`** from the body (set to `undefined` or delete the property).
4. Serialize the remaining object using **stable, sorted-key JSON** (e.g. `safe-stable-stringify`). The relayer signs the canonical form, so any reordering or whitespace change breaks verification.
5. Decode the public key (base64url → 32 bytes) and the `signature` (base64 → 64 bytes).
6. Verify with Ed25519 over the UTF-8 bytes of the serialized message.
7. Reject and 4xx the request if verification fails.
8. Respond `200` quickly; the relayer treats non-2xx as a delivery failure and retries with backoff.

### Idempotency

Webhook deliveries can repeat (network failures, retries). De-duplicate on `(data.id, type)` and treat handlers as idempotent.

---

## Production tips

- **Client delegations**: use `@metamask/smart-accounts-kit` (not the deprecated `@metamask/delegation-toolkit`) for delegation construction and browser EIP-7715 flows.
- **Cache JWKS** with a short TTL (e.g. 10 minutes); rotate on signature-verification failure.
- **Cache capabilities** per session; refetch on `4202`/`4206`.
- **Prefer estimate for fee quotes** when the signed bundle exists; use `getFeeData` only for rough pre-bundle quotes.
- **Refresh quotes** on every submit; never reuse a `context` across submits. Re-estimate if the bundle changes.
- **Random `salt`**: 32 bytes from a CSPRNG per delegation.
- **Convert bigints**: serialize delegation `bigint` fields to `0x`-prefixed hex before JSON-RPC; the kit produces native `bigint` values that JSON cannot encode.
