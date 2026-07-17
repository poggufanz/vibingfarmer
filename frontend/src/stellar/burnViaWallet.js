// frontend/src/stellar/burnViaWallet.js
// CCTP burn for the MERGED flow: signed by whatever wallet is connected through the Wallet Kit
// (Freighter/xBull/Albedo/VF Wallet) — NOT the /farm passkey kit (that path is cctpBurn.js's
// signAndSubmitStellarBurn). Two user-signed, user-paid txs (approve -> deposit_for_burn): the
// fee-bump relay's allowlist rightly refuses both, same posture as funding_router.grant (see
// grant.js). Return shape mirrors signAndSubmitStellarBurn so this drops into runFarmFlow's
// deps.burn seam unchanged.
//
// Arg encodings + the deposit_for_burn parameter order are copied from the live-proven
// relayer/src/cctp/forward.mjs (`approveAndBurnStellar`, smoke-tested on testnet 2026-07-17),
// NOT invented — see the arg-by-arg trace in task-6-report.md.
import { rpcServer, buildInvokeTx, submitUserTx } from './client.js'
import {
  STELLAR_TOKEN_MESSENGER_MINTER,
  STELLAR_USDC_SAC,
  CCTP_BASE_DOMAIN,
  CCTP_MIN_FINALITY_STANDARD,
  CCTP_MAX_FEE,
  evmAddrToBytes32,
  ZERO32,
} from './cctpBurn.js'

// grant.js:39 verbatim (ledger-rate constant the SEP-41 allowance expiry converts through).
const SECONDS_PER_LEDGER = 5
// ~6 days — same real-world headroom forward.mjs/cctpBurn.js hardcode as a flat 100_000-ledger
// bump; expressed here via grant.js's seconds->ledger formula instead of a bare ledger count.
const APPROVE_DURATION_SECONDS = 6 * 24 * 60 * 60

async function defaultBuildAndSubmit({ server, source, contract, method, args, signTx }) {
  // The approve expiry needs the CURRENT ledger, which needs a live server — resolved here (not
  // in burnViaWallet) so the deps.buildAndSubmit override used by both unit tests never touches
  // the network. `server` itself is passed through unresolved everywhere else so buildInvokeTx /
  // submitUserTx keep defaulting it exactly like every other caller in this module (grant.js).
  let finalArgs = args
  if (method === 'approve') {
    const s = server || (await rpcServer())
    const latest = await s.getLatestLedger()
    const expLedger = latest.sequence + Math.ceil(APPROVE_DURATION_SECONDS / SECONDS_PER_LEDGER)
    finalArgs = [...args, { u32: expLedger }]
  }
  const { xdr: unsignedXdr } = await buildInvokeTx({
    source,
    contract,
    method,
    args: finalArgs,
    server,
  })
  const signedXdr = await signTx(unsignedXdr)
  try {
    const res = await submitUserTx({ signedXdr, server })
    return { hash: res.hash }
  } catch (e) {
    throw new Error(`${method}: ${e.message}`)
  }
}

/**
 * Wallet-kit-signed CCTP burn: USDC_SAC.approve(TokenMessengerMinter) then deposit_for_burn, both
 * signed by the connected wallet via the `signTx` adapter (2 popups).
 * @param {{
 *   contractId: string,           // the connected wallet's G... address (source + owner)
 *   amountUnits: bigint,          // 7dp Stellar units to burn
 *   baseRecipientAddress: string, // 0x... Base recipient — validated BEFORE any tx is built
 *   signTx: (xdr: string) => Promise<string>, // wallet-kit sign adapter, base64 in/out
 *   server?: object,
 *   deps?: { buildAndSubmit?: Function },
 * }} p
 * @returns {Promise<{ approveHash: string, burnHash: string }>}
 */
export async function burnViaWallet({
  contractId,
  amountUnits,
  baseRecipientAddress,
  signTx,
  server,
  deps = {},
}) {
  const { buildAndSubmit = defaultBuildAndSubmit } = deps
  // Throws on a malformed recipient BEFORE either tx is built/submitted.
  const recipient32 = evmAddrToBytes32(baseRecipientAddress)

  const approve = await buildAndSubmit({
    server,
    source: contractId,
    contract: STELLAR_USDC_SAC,
    method: 'approve',
    // forward.mjs approveAndBurnStellar: (owner, spender, amount, expiration_ledger). The 4th
    // arg (expiration_ledger) is appended by defaultBuildAndSubmit once it has a live ledger.
    args: [{ addr: contractId }, { addr: STELLAR_TOKEN_MESSENGER_MINTER }, { i128: amountUnits }],
    signTx,
  })

  const burn = await buildAndSubmit({
    server,
    source: contractId,
    contract: STELLAR_TOKEN_MESSENGER_MINTER,
    method: 'deposit_for_burn',
    // forward.mjs approveAndBurnStellar order exactly: caller, amount, destination_domain,
    // mint_recipient, burn_token, destination_caller (zero = anyone may relay), max_fee, min_finality.
    args: [
      { addr: contractId },
      { i128: amountUnits },
      { u32: CCTP_BASE_DOMAIN },
      { bytes32: recipient32 },
      { addr: STELLAR_USDC_SAC },
      { bytes32: ZERO32 },
      { i128: CCTP_MAX_FEE },
      { u32: CCTP_MIN_FINALITY_STANDARD },
    ],
    signTx,
  })

  return { approveHash: approve.hash, burnHash: burn.hash }
}
