# SPIKE RESULT — 1Shot Managed-API redeemDelegations capability

**Run:** 2026-06-14 via `scripts/spike-7715-redeem.mjs` against the live 1Shot Managed API (Base Sepolia, biz wallet).

## OUTCOME: a

The 1Shot Managed API **accepts array-typed params** (`bytes[]` / `bytes32[]`) on a registered
contract method. `contractMethods.create` for `DelegationManager.redeemDelegations(bytes[],bytes32[],bytes[])`
returned a real method id (`ARRAY_PARAMS_OK`). Outcome **b** (raw pre-encoded calldata send) is
**impossible** in `@uxly/1shot-client` ^1.3.2 — its `transactions` resource exposes only `get`/`list`,
no raw `{to,data}` send. Outcome **c** (session EOA) is therefore the fallback only if **a** regresses.

## Chosen grantee (the redeemer that broadcasts the redeem)

**1Shot server wallet = `0xaF0A1b73DC616b54Fc3110EbEc03bB05731E34cd`** (Base Sepolia, chainId 84532).

`redeemDelegations` checks `msg.sender == leaf delegate`, so the ERC-7715 grant `to:` (grantee)
MUST equal this address. Task 4 (`requestERC7715Permission`) grants to it via `getRelayerAddress()`
(`POST /api/relay {action:'wallet'}` → `.address`). This is path **ii**.

## Verified API call shape (Task 5 — `frontend/api/relay.js` `redeem` action)

Register the DelegationManager method bound to the server wallet, then `execute` with the three arrays:

```js
const DM_ADDRESS = '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3' // DelegationManager (Base Sepolia)
const REDEEM_INPUTS = [
  { name: 'permissionContexts', type: 'bytes', isArray: true, index: 0 }, // bytes[]
  { name: 'modes',              type: 'bytes', typeSize: 32, isArray: true, index: 1 }, // bytes32[]
  { name: 'executionCallDatas', type: 'bytes', isArray: true, index: 2 }, // bytes[]
]
// contractMethods.create({ chainId:84532, contractAddress:DM_ADDRESS, walletId, functionName:'redeemDelegations',
//   stateMutability:'nonpayable', inputs:REDEEM_INPUTS, outputs:[] })  → VERIFIED OK
// contractMethods.execute(methodId, { permissionContexts:[ctx], modes:[SINGLE_DEFAULT_MODE], executionCallDatas:[exec] })
```

`resolveContractMethod` matches by `functionName + contractAddress` → it will reuse any existing
`redeemDelegations@DM` method (incl. the spike's, if its delete 204 didn't land — harmless).

## Pinned encodings (Task 5)

- **SINGLE_DEFAULT_MODE** (ERC-7579, single call + default execType) = 32 zero bytes:
  `0x0000000000000000000000000000000000000000000000000000000000000000`.
  Confirm at build time `=== ExecutionMode.SingleDefault` from `@metamask/smart-accounts-kit`.
- **executionCallData** for ONE execution = `encodePacked(['address','uint256','bytes'], [token, 0n, transferCalldata])`
  (ERC-7579 single-execution packing). `transferCalldata` = `transfer(depositor, amount)` (selector `0xa9059cbb`).
- **permissionContexts** = `[permissionContext]` — the raw ERC-7715 grant `context` bytes (the encoded
  delegation chain), passed through verbatim. Do NOT re-decode.

## Notes / risks carried forward

- SDK `contractMethods.delete` throws "Unexpected end of JSON input" on the 204 No Content response —
  delete still happens server-side; ignore the parse error (Task 5 relay does not call delete).
- The Managed redeem must be broadcast by the SAME server wallet the grant was issued to. If
  `getRelayerAddress()` ever returns a different wallet than at grant time, the redeem reverts
  (`msg.sender != delegate`). Task 4 saves `grantee` in the session grant for this reason.
