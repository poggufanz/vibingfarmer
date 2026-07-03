// Pure decision function for the Autofarm keeper.
// No I/O, no SDK imports, no side effects — deterministic function of (state, config).
// Task 13 (the Worker) is responsible for gathering `state` from chain and submitting
// the returned actions; this module only decides *what* to do.

const BPS_DENOMINATOR = 10000n;

/**
 * @param {{
 *   strategies: Array<{ address: string, balance: bigint, supplyAprBps: number, pendingInterest: bigint, blndClaimable: bigint }>,
 *   idle: bigint,
 *   lastRebalanceTs: number,
 *   nowTs: number,
 *   blndQuote: { usdcOutFor: (blndAmount: bigint) => bigint } | null,
 * }} state
 * @param {{ minCompound: bigint, rebalanceBps: number, cooldownS: number, slippageBps: number }} config
 * @returns {Array<{ type: 'compound', minOuts: bigint[] } | { type: 'rebalance', from: string, to: string, amount: bigint }>}
 */
export function decide(state, config) {
  const actions = [];

  const compoundAction = decideCompound(state, config);
  if (compoundAction) actions.push(compoundAction);

  const rebalanceAction = decideRebalance(state, config);
  if (rebalanceAction) actions.push(rebalanceAction);

  return actions;
}

function decideCompound(state, config) {
  const totalPendingInterest = state.strategies.reduce(
    (sum, strategy) => sum + strategy.pendingInterest,
    0n,
  );

  const shouldCompound = totalPendingInterest >= config.minCompound || state.idle > 0n;
  if (!shouldCompound) return null;

  const minOuts = state.strategies.map((strategy) => minOutForStrategy(strategy, state.blndQuote, config.slippageBps));
  return { type: 'compound', minOuts };
}

function minOutForStrategy(strategy, blndQuote, slippageBps) {
  if (strategy.blndClaimable <= 0n || !blndQuote) return 0n;

  const quotedOut = blndQuote.usdcOutFor(strategy.blndClaimable);
  return (quotedOut * (BPS_DENOMINATOR - BigInt(slippageBps))) / BPS_DENOMINATOR;
}

function decideRebalance(state, config) {
  const cooldownElapsed = state.nowTs - state.lastRebalanceTs >= config.cooldownS;
  if (!cooldownElapsed) return null;

  const { highest, lowest } = findAprExtremes(state.strategies);
  if (!highest || !lowest || highest === lowest) return null;

  const aprDeltaBps = highest.supplyAprBps - lowest.supplyAprBps;
  if (aprDeltaBps <= config.rebalanceBps) return null;

  const imbalance = lowest.balance - highest.balance;
  const halfImbalance = imbalance / 2n;
  const halfFromBalance = lowest.balance / 2n;
  const amount = halfImbalance < halfFromBalance ? halfImbalance : halfFromBalance;

  return { type: 'rebalance', from: lowest.address, to: highest.address, amount };
}

function findAprExtremes(strategies) {
  let highest = null;
  let lowest = null;
  for (const strategy of strategies) {
    if (!highest || strategy.supplyAprBps > highest.supplyAprBps) highest = strategy;
    if (!lowest || strategy.supplyAprBps < lowest.supplyAprBps) lowest = strategy;
  }
  return { highest, lowest };
}
