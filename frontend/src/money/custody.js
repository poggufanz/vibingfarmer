// frontend/src/money/custody.js
// Pure custody-location derivation for one agent's evidence (Pocket Crew "My money", Task 7).
// `custody.location` is NEVER guessed: it is derived only from evidence readOwnerMoney.js has
// already verified (an on-chain scope read, live vault-share/idle-token balances, or a durable
// relayer-attested Base association) — anything short of that reports 'unknown', never a
// confident-looking default like 'owner' or 'agent'.
const CUSTODY_LOCATIONS = new Set([
  'owner',
  'agent',
  'stellar-vault',
  'in-transit',
  'base-proxy',
  'unknown',
])

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
    // Fix loop 1, Fix 3: a known-positive Stellar leg alongside a Base association is a genuine
    // split — this agent's money is confirmed in more than one place at once, and a single
    // `location` field cannot say which one without guessing. Reuses the exact discipline below
    // (never combine a known zero with an unread balance and guess) rather than inventing a
    // second rule: two known-positive legs are just as unresolvable as one known and one unread.
    if (isKnownPositive(read.vaultShares) || isKnownPositive(read.idleToken)) {
      return { location: 'unknown' }
    }
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

/**
 * Fix loop 2, Fix 1: `custodyForAgent` collapses a genuine split (known-positive Stellar leg +
 * Base association) to a single `'unknown'` — honest as a one-value summary, but it throws away
 * the fact that BOTH legs are individually known. This is the per-leg counterpart: every leg this
 * agent's evidence actually confirms gets its OWN real location, so an owner-level breakdown can
 * show "$5 in stellar-vault, $5 in base-proxy" instead of "$10 unknown". A leg that never resolved
 * (unavailable, or the Base leg's own amount is unresolved) contributes NOTHING here — never a
 * guessed zero, never a guessed location; readOwnerMoney.js's `problems` markers are what already
 * carry the "this leg's read was incomplete" signal (see READ_INCOMPLETE_PROBLEMS).
 *
 * Scoped to Base-associated agents only (`read.baseChild` present) — that is the ONLY case where
 * `custodyForAgent` can collapse two independently-known legs into one summary value in the first
 * place; a plain Stellar-only agent's single `custody.location` already IS its one real location,
 * so aggregateOwnerPositions keeps using that directly when this returns `[]`.
 * @param {{scope?: {state:string}, vaultShares?: object, idleToken?: object,
 *   baseChild?: {custody?: {location?: string}, amount?: {token:string,units:string,decimals:number}|null}|null}} read
 * @returns {Array<{location: string, amount: {token:string,units:string,decimals:number}}>}
 */
export function custodyBreakdownForAgent(read) {
  if (!read || !read.baseChild || read.scope?.state !== 'known') return []

  const legs = []
  if (isKnownPositive(read.vaultShares))
    legs.push({ location: 'stellar-vault', amount: read.vaultShares.amount })
  if (isKnownPositive(read.idleToken))
    legs.push({ location: 'agent', amount: read.idleToken.amount })
  if (read.baseChild.amount != null) {
    const loc = read.baseChild.custody?.location
    legs.push({
      location: CUSTODY_LOCATIONS.has(loc) ? loc : 'unknown',
      amount: read.baseChild.amount,
    })
  }
  return legs
}
