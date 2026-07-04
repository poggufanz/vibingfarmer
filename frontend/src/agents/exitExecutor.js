// frontend/src/agents/exitExecutor.js
// Autonomous exit executor. Signs and submits scoped exit transactions.
//
// The exit is TWO sequential single-op transactions, not one multi-op tx:
//   1. vault.redeem(agent, shares)      — burns shares, pays assets to the agent
//   2. token.transfer(agent, owner, X)  — sweeps the agent's REAL balance to the owner
// A Stellar tx may carry exactly ONE InvokeHostFunction op (protocol rule since P20), so
// redeem+transfer cannot share an envelope. Splitting also lets X be the agent's actual
// post-redeem token balance instead of a shares×price_per_share estimate — price_per_share
// can DROP between a read and execution (blend_strategy harvest() marks principal down on
// pool shortfall), and an oversized estimate would make the transfer revert.

import { rpcServer, buildInvokeTx } from '../stellar/client.js'
import {
  SOROBAN_ACTIVE_VAULT_ADDRESS,
  SOROBAN_TOKEN_ADDRESS,
  NETWORK_PASSPHRASE,
} from '../stellar/config.js'
import { getRelayerAddress, submitViaRelay } from '../stellar/relay.js'
import { readVaultShares, readTokenBalance } from '../stellar/agentDeposit.js'
import { loadExitKey } from '../wallet/exitKey.js'

let _sdk = null
async function sdk() {
  if (!_sdk) _sdk = await import('@stellar/stellar-sdk')
  return _sdk
}

const AUTH_TTL_LEDGERS = 360

/**
 * Sign every auth entry credentialed to `agentAddress` with the exit key (using tag 1).
 */
export async function signAgentExitEntries({ tx, exitKeypair, validUntilLedger, agentAddress }) {
  const { xdr, hash, Address } = await sdk()
  const networkId = hash(Buffer.from(NETWORK_PASSPHRASE))
  const wantScAddress = Address.fromString(agentAddress).toScAddress().toXDR('base64')

  for (const op of tx.operations) {
    const entries = op.auth || []
    for (const entry of entries) {
      if (entry.credentials().switch().name !== 'sorobanCredentialsAddress') continue
      const creds = entry.credentials().address()
      if (creds.address().toXDR('base64') !== wantScAddress) continue // not this agent

      creds.signatureExpirationLedger(validUntilLedger)
      const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
        new xdr.HashIdPreimageSorobanAuthorization({
          networkId,
          nonce: creds.nonce(),
          signatureExpirationLedger: validUntilLedger,
          invocation: entry.rootInvocation(),
        })
      )
      const payload = hash(preimage.toXDR())

      // Sign and prepend Tag 1 (1 byte) for Exit Signer!
      const rawSig = exitKeypair.sign(new Uint8Array(payload))
      const sigWithTag = new Uint8Array(65)
      sigWithTag[0] = 1 // Tag 1 = exit key signature
      sigWithTag.set(rawSig, 1)

      creds.signature(xdr.ScVal.scvBytes(Buffer.from(sigWithTag)))
    }
  }
  return { xdr: tx.toEnvelope().toXDR('base64') }
}

/**
 * Build one single-op invoke (source = relayer), sign the agent's auth entry with the exit
 * key, then RE-prepare with the signed entry — the first prepare runs in recording mode,
 * which skips the custom account's __check_auth, so its footprint can miss the agent
 * contract's entries and the submit would trap (same fix as buildAgentDeposit).
 * @returns {Promise<{xdr:string}>}
 */
export async function buildAgentExitTx({
  contract,
  method,
  args,
  relayer,
  agentAddress,
  exitKeypair,
  server,
}) {
  const s = server || (await rpcServer())
  const { tx } = await buildInvokeTx({ source: relayer, contract, method, args, server: s })
  const latest = await s.getLatestLedger()
  const validUntilLedger = latest.sequence + AUTH_TTL_LEDGERS
  const { xdr: signedXdr } = await signAgentExitEntries({
    tx,
    exitKeypair,
    validUntilLedger,
    agentAddress,
  })
  const { TransactionBuilder } = await sdk()
  const prepared = await s.prepareTransaction(
    TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE)
  )
  return { xdr: prepared.toEnvelope().toXDR('base64') }
}

// Per-agent in-flight guard: the 15s checkExit interval (app.jsx) can re-fire while a slow
// relay/RPC leg is still pending; a concurrent second redeem would just fail on-chain, but
// rejecting early keeps the log clean and avoids a double transfer race after self-heal.
// This Set only guards within ONE browser tab (module-level memory) — a second TAB in the
// same browser has its own JS heap and would race straight past it. The localStorage lock
// below closes that gap. Two different BROWSERS (or machines) can still race past both guards
// — that residual ceiling is bounded on-chain: the loser's tx fails sequence/auth validation,
// wasting at most one tx, never a double spend.
const _exitInFlight = new Set()

// Cross-tab lock: a shared localStorage key so a second tab (same browser, same agent) sees
// the first tab's in-progress exit. TTL bounds how long a crashed/closed tab can wedge the
// lock — after it expires, a fresh run treats the stale entry as free and replaces it.
const EXIT_LOCK_KEY_PREFIX = 'vf_exit_inflight_'
const EXIT_LOCK_TTL_MS = 120_000

/**
 * Acquire the cross-tab lock for `agentAddress`. Returns an ownership token, or null if
 * another tab holds a non-expired lock. The token ties release to THIS acquisition: a run
 * that overshoots the TTL and finishes late must not delete a successor's fresh lock, so
 * release only removes the key when it still holds this run's own token. In a non-browser
 * environment (no localStorage, e.g. tests/SSR) acquisition always succeeds — the in-memory
 * Set above is the only guard available there.
 */
function acquireExitLock(agentAddress) {
  const key = EXIT_LOCK_KEY_PREFIX + agentAddress
  try {
    const held = localStorage.getItem(key)
    // Value is `<epoch-ms>:<nonce>`; split tolerates legacy plain-timestamp values.
    if (held !== null && Date.now() - Number(held.split(':')[0]) < EXIT_LOCK_TTL_MS) {
      return null
    }
    const token = `${Date.now()}:${Math.random().toString(36).slice(2)}`
    localStorage.setItem(key, token)
    return token
  } catch {
    return 'no-localstorage' // degrade to the in-memory guard only
  }
}

function releaseExitLock(agentAddress, token) {
  try {
    const key = EXIT_LOCK_KEY_PREFIX + agentAddress
    if (localStorage.getItem(key) === token) localStorage.removeItem(key)
  } catch {
    // no localStorage to clear — nothing was acquired either
  }
}

/**
 * Run the autonomous exit using the scoped exit key.
 * Leg 1 redeems all shares; leg 2 transfers the agent's actual token balance to the owner.
 * If a prior run confirmed the redeem but failed the transfer, re-running self-heals:
 * shares are 0, so leg 1 is skipped and the stranded balance is swept.
 * @param {{ agentAddress:string, ownerAddress:string, server?:object }} p
 * @returns {Promise<{ hash:string, status:string, redeemHash:string|null }>}
 */
export async function runAutonomousExit({ agentAddress, ownerAddress, server }) {
  // In-memory check FIRST: if this tab already runs an exit, we must not touch the
  // localStorage lock at all (writing it and then throwing would wedge other tabs).
  if (_exitInFlight.has(agentAddress)) {
    throw new Error('exit already in flight for this agent')
  }
  const lockToken = acquireExitLock(agentAddress)
  if (lockToken === null) {
    throw new Error('exit already in flight for this agent')
  }
  _exitInFlight.add(agentAddress)
  try {
    return await _runAutonomousExit({ agentAddress, ownerAddress, server })
  } finally {
    _exitInFlight.delete(agentAddress)
    releaseExitLock(agentAddress, lockToken)
  }
}

async function _runAutonomousExit({ agentAddress, ownerAddress, server }) {
  const exitKeyData = loadExitKey(agentAddress)
  if (!exitKeyData) {
    throw new Error('No exit key authorized for this agent')
  }

  const s = server || (await rpcServer())
  const { Keypair } = await sdk()
  const exitKeypair = Keypair.fromSecret(exitKeyData.secret)

  const shares = await readVaultShares(agentAddress, { server: s })
  if (shares == null) {
    throw new Error('share balance read failed — cannot exit')
  }

  const relayer = await getRelayerAddress()
  if (!relayer) {
    throw new Error('No relayer configured')
  }

  // Leg 1: redeem all shares. Must confirm on-chain before the balance read below —
  // the payout only exists after the redeem lands.
  let redeemHash = null
  if (shares > 0n) {
    const { xdr } = await buildAgentExitTx({
      contract: SOROBAN_ACTIVE_VAULT_ADDRESS,
      method: 'redeem',
      args: [{ addr: agentAddress }, { i128: shares }],
      relayer,
      agentAddress,
      exitKeypair,
      server: s,
    })
    const res = await submitViaRelay({ xdr })
    if (!res || res.status !== 'SUCCESS') {
      throw new Error(`redeem ${res ? res.status : 'relay unreachable'} — exit aborted`)
    }
    redeemHash = res.hash
  }

  // Size the transfer from the agent's REAL balance — exact by construction, so it can
  // never exceed what redeem actually paid, and it also sweeps any pre-existing dust.
  const balance = await readTokenBalance(agentAddress, { server: s })
  if (balance == null) {
    throw new Error(
      `token balance read failed after redeem${redeemHash ? ` (redeem tx ${redeemHash})` : ''} — retry to sweep`
    )
  }
  if (balance <= 0n) {
    if (redeemHash) {
      // vault.redeem guards assets>0, so a confirmed redeem always leaves a balance
      throw new Error(`redeem tx ${redeemHash} confirmed but agent balance is 0`)
    }
    throw new Error('No vault shares to exit')
  }

  // Leg 2: sweep to the owner.
  const { xdr } = await buildAgentExitTx({
    contract: SOROBAN_TOKEN_ADDRESS,
    method: 'transfer',
    args: [{ addr: agentAddress }, { addr: ownerAddress }, { i128: balance }],
    relayer,
    agentAddress,
    exitKeypair,
    server: s,
  })
  const res = await submitViaRelay({ xdr })
  if (!res || res.status !== 'SUCCESS') {
    throw new Error(
      `transfer ${res ? res.status : 'relay unreachable'} after redeem ${redeemHash ?? '(skipped)'} — funds sit on the agent; re-run to sweep`
    )
  }
  return { hash: res.hash, status: res.status, redeemHash }
}
