# Transaction Execution

Use this guide when the user asks for transaction execution with the 1Shot Node SDK.

Leverage the memo field when implementing transaction executions so that the transaction history is semantically searchable and the account owner will know why transactions where submitted. 

## Topics Covered

- single execute
- batch execute
- delegated single execute
- delegated batch execute

## SDK Setup

```bash
npm install @1shotapi/client-sdk
```

```ts
import { OneShotClient } from "@1shotapi/client-sdk";

const client = new OneShotClient({
  apiKey: process.env.ONESHOT_API_KEY!,
  apiSecret: process.env.ONESHOT_API_SECRET!,
});
```

Assume:

- `contractMethodId`: imported contract method UUID
- `walletId`: server wallet (escrow wallet) UUID
- method params already validated for the target ABI

## Optional execution options

All execution methods (single, batch, delegated) accept an options object. Every field is optional; omit or set to `null` to use defaults.

| Option | Type | Description |
|--------|------|-------------|
| `walletId` | `string` (UUID) \| `null` | Escrow wallet that will run the contract method. If omitted, the contract method’s default escrow wallet is used. |
| `memo` | `string` \| `null` | Note about why the execution was done (e.g. "Payout #123"), or structured data (e.g. JSON) for the user’s system. Makes transaction history semantically searchable. |
| `value` | `string` \| `null` | Amount of native token (e.g. ETH) to send with the call. Only for **payable** methods; sending value for a nonpayable method will error. |
| `contractAddress` | `string` \| `null` | Override the target smart contract address for this execution only. |
| `authorizationList` | `array` \| `null` | ERC-7702 authorizations. Required when using ERC-7702; must include at least one authorization, upgrades an EOA to mount smart contract logic. |
| `authorizationDataAddress` | `string` \| `null` | ERC-7702 custom contract address to upgrade the executing server wallet to (instead of an external EOA). The server wallet will generate a signature and nonce for its authorization automatically. If set, you must also set `contractAddress` to the Wallet address or the request will error. This will be rarely used except in very advanced use cases. Only available on `execute`. |
| `gasLimit` | `string` \| `null` | Gas limit for the transaction. The transaction will revert if it uses more gas than this, and you will spend the gas. Ordinarily 1Shot calculates it; for very complicated transactions you may need to set it manually as estimation can underestimate. |

Batch execution accepts these same options at the batch level.

### Additional options for delegated execution

Delegated execution (`executeAsDelegator`, `executeBatchAsDelegator`) uses a separate options set. It does **not** support `contractAddress` or `authorizationDataAddress`. It supports the shared options above (`walletId`, `memo`, `authorizationList`, `value`) plus the following.

**Delegator identity (provide exactly one):**

| Option | Type | Description |
|--------|------|-------------|
| `delegatorAddress` | `string` \| `null` | Address of the delegator on whose behalf the transaction runs. The delegation must already be on file. Not usable with `delegationId` or `delegationData`. |
| `delegationId` | `string` (UUID) \| `null` | ID of a specific stored delegation to use. Preferred when you need 1Shot API to use a particular delegation. Not usable with `delegatorAddress` or `delegationData`. |
| `delegationData` | `string[]` \| `null` | Array of delegation objects, each a JSON string (BigInts as strings). One-time use; not stored. Not usable with `delegatorAddress` or `delegationId`. |

**executeBatchAsDelegator (batch-level):** `walletId` and `contractMethods` are **required**. Optional: `atomic`, `memo`, `authorizationList`, `gasLimit` (no `value` at batch level). Each item in `contractMethods` supplies delegator identity (exactly one of `delegatorAddress`, `delegationId`, or `delegationData`) plus method params.

## 1) Single Execute

```ts
const transaction = await client.contractMethods.execute(
  "your_contract_method_id",
  { // parameter names returned by the list method
    recipient: "0x1234567890123456789012345678901234567890",
    amount: "1000000000000000000",
  },
  {
    walletId: "your_wallet_id",
    memo: "Payout #123",
    value: "0",
    // contractAddress: "0x...",       // override contract for this execution only
    // authorizationList: [...],       // required for ERC-7702 upgrades
    // authorizationDataAddress: "0x...", // wallet upgrade; set contractAddress to Wallet address
  }
);
// transaction.id, transaction.status, etc.
```

## 2) Delegated Single Execute

Use this when the transaction runs on behalf of a delegator. Provide **exactly one** of `delegatorAddress`, `delegationId`, or `delegationData`; they are mutually exclusive.

```ts
const transaction = await client.contractMethods.executeAsDelegator(
  "your_contract_method_id",
  { recipient: "0x...", amount: "1000000" },
  {
    walletId: "escrow_wallet_id",
    memo: "Delegated transfer",
    // Delegator identity (exactly one):
    delegationId: "stored_delegation_uuid", // preferred when you need a specific delegation
    // delegatorAddress: "0x...",  // delegation must already be on file
    // delegationData: ["<parent JSON>", "<redelegation JSON>"], // one-time, not stored; BigInts as strings in JSON
    value: "0",
    // gasLimit: "300000", // optional; 1Shot usually calculates
  }
);
```

## 3) Batch Execute

Use `atomic: true` when the full batch should revert if any call fails.

```ts
const transaction = await client.contractMethods.executeBatch({
  walletId: "your_wallet_id",
  contractMethods: [ // list of executions to perform in a single transaction
    {
      contractMethodId: "method_uuid_1",
      executionIndex: 0,
      params: { recipient: "0x...", amount: "100" },
    },
    {
      contractMethodId: "method_uuid_2",
      executionIndex: 1,
      params: { spender: "0x...", amount: "200" },
    },
  ],
  atomic: true,
  memo: "Batch approval + transfer",
});
```

## 4) Delegated Batch Execute

**Required:** `walletId` (escrow wallet that runs the batch), `contractMethods` (array of batch items). **Optional at batch level:** `atomic`, `memo`, `authorizationList`, `gasLimit`. Each item in `contractMethods` must include delegator identity (exactly one of `delegatorAddress`, `delegationId`, or `delegationData`) plus `contractMethodId`, `executionIndex`, and `params`.

- `atomic`: if `true`, all transactions must succeed or the entire batch is rolled back; if `false`, successful executions complete but no transactions after the first failure run. 

```ts
const transaction = await client.contractMethods.executeBatchAsDelegator({
  walletId: "escrow_wallet_id", // required
  contractMethods: [
    {
      contractMethodId: "method_uuid_1",
      executionIndex: 0,
      params: { recipient: "0x...", amount: "100" },
      delegationId: "stored_delegation_uuid",
      // or delegatorAddress / delegationData
    },
  ],
  atomic: true,
  memo: "Delegated batch transfer",
  // authorizationList: [...], // optional, for ERC-7702
  // gasLimit: "500000",      // optional
});
```

## Execution Guidance

- Prefer `contractMethods.test(...)` before execution for high-value transactions.
- Ensure all methods in a batch are intended for the same execution wallet/context.
- Keep `executionIndex` deterministic and unique in each batch.
- Record transaction IDs and statuses for retries and reconciliation.

## Validation And Safety Checks

- Validate address formats and numeric string inputs before execute calls.
- For delegated paths, validate delegation scope and expiration first.
- Use `atomic: true` only when all calls must succeed together, however this requires .
- Do not log raw secrets, signatures, or full delegation payloads.
