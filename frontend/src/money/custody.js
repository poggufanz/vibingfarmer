// frontend/src/money/custody.js
// Pure custody-location derivation for one agent's evidence (Pocket Crew "My money", Task 7).
// `custody.location` is NEVER guessed: it is derived only from evidence readOwnerMoney.js has
// already verified (an on-chain scope read, live vault-share/idle-token balances, or a durable
// relayer-attested Base association) — anything short of that reports 'unknown', never a
// confident-looking default like 'owner' or 'agent'.
const CUSTODY_LOCATIONS = new Set(['owner', 'agent', 'stellar-vault', 'in-transit', 'base-proxy', 'unknown'])

function isKnownPositive(read) {
  return read?.state === 'known' && read.amount != null && BigInt(read.amount.units) > 0n
}

function isKnown(read) {
  return read?.state === 'known' && read.amount != null
}

/**
 * @param {{scope?: {state:string}, vaultShares?: object, idleToken?: object,
 *   baseChild?: {custody?: {location?: string}}|null}} read one agent's assembled evidence
 * @returns {{location: 'owner'|'agent'|'stellar-vault'|'in-transit'|'base-proxy'|'unknown'}}
 */
export function custodyForAgent(read) {
  if (!read) return { location: 'unknown' }

  // A durable Base association (Task 5's relayer-attested evidence) is authoritative over
  // whatever the Stellar-side bridge agent's own token/vault-share balances show — the money has
  // moved chains, so its custody lives wherever the association says, not where it used to sit.
  if (read.baseChild) {
    const loc = read.baseChild.custody?.location
    return { location: CUSTODY_LOCATIONS.has(loc) ? loc : 'unknown' }
  }

  if (read.scope?.state !== 'known') return { location: 'unknown' }

  if (isKnownPositive(read.vaultShares)) return { location: 'stellar-vault' }
  if (isKnownPositive(read.idleToken)) return { location: 'agent' } // stranded post-redeem balance

  // Both reads succeeded and both came back zero: there is genuinely nothing to place, but the
  // agent contract is still nominally where the (absent) funds would be found next.
  if (isKnown(read.vaultShares) && isKnown(read.idleToken)) return { location: 'agent' }

  // Either read is unavailable — never combine a known zero with an unread balance and guess.
  return { location: 'unknown' }
}
