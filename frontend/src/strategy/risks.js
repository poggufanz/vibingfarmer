// frontend/src/strategy/risks.js
// P1 G7 (defi-gap-analysis §4.2 G11 / §5 item 7): the ONE risks page the deposit flow was
// missing. Scattered honest lines already exist (ExplorerPage's "Unaudited (hackathon scope)",
// ReplayPage's "does not predict future outcomes", the testnet/APR notes) — this module gathers
// the six risks a depositor must see BEFORE the first grant into a single data table, each with
// its already-shipped mitigation (lifeboat, timelock+multisig, revoke, finite withdraw,
// persistent relayer jobs). Copy sources: prd.md "Critical Failure Modes" for the risk list,
// the cited code for each mitigation.
//
// Data only, no React: RisksContent/RisksPage/RisksGateModal render this; risksAck.js owns the
// once-per-wallet acknowledgement. UI copy is plain English, no em/en dashes (the route-wide
// a11y ban), two risk sentences plus one mitigation sentence each.
export const RISKS = Object.freeze([
  {
    id: 'smart-contract',
    title: 'Smart-contract risk',
    body: 'The vault, router, strategy, and agent contracts are unaudited hackathon code. A bug could lock funds or move them somewhere unrecoverable.',
    mitigation:
      'Vault upgrades wait 3 days behind a 2-of-3 multisig, redeem is never blocked, and you can revoke the grant at any time.',
  },
  {
    id: 'oracle',
    title: 'Oracle risk',
    body: 'Lending pools price collateral through oracles, and a stale or manipulated price misvalues what the strategy holds. The display could look healthy while the position is not.',
    mitigation:
      'Every run rechecks oracle reliability in the eligibility gate, and the lifeboat radar keeps watching pool health after deposit.',
  },
  {
    id: 'liquidity',
    title: 'Liquidity risk',
    body: 'Withdrawals need free pool liquidity to settle. At extreme utilization a withdrawal can queue and arrive late instead of all at once.',
    mitigation:
      'Withdrawals are finite and drain strategies in order, and a live lifeboat mandate can de-risk the vault to idle cash.',
  },
  {
    id: 'testnet-reset',
    title: 'Testnet reset risk',
    body: 'Stellar testnet resets wipe all chain state: grants, positions, and history disappear. Anything you see here can vanish on reset day.',
    mitigation:
      'Use testnet funds only. The app re-derives state from chain and treats local receipts as hints, never proof.',
  },
  {
    id: 'bridge-delay',
    title: 'Bridge delay risk',
    body: 'The Base leg settles only after Circle attests the burn, which takes minutes on a good day. An attestation can also stall and leave funds visibly in flight.',
    mitigation:
      'The relayer tracks every transfer with persistent, resumable jobs, and the app polls status with a timeout instead of guessing.',
  },
  {
    id: 'grant-scope',
    title: 'Grant scope risk',
    body: 'A grant lets agents move funds within its cap and expiry without asking you again. A leaked session key could be abused inside that scope until it expires.',
    mitigation:
      'Every grant is capped, expiring, and pinned to one vault; the Active grant card shows the remainder live and Revoke kills it in one signature.',
  },
])

// P1 G8: the audit-plan line rendered under the six risks on /risks. Status is honestly
// unaudited; the scope names what a mainnet audit WOULD cover (router, vault, strategy,
// agent auth) with no "audited" claim anywhere. risks.test.js pins the wording.
export const AUDIT_PLAN =
  'Not audited yet (hackathon scope). A mainnet audit would cover the router, the vault, the strategy, and agent auth. No audit is claimed until a third party signs one.'
