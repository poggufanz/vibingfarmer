// keeper/src/chain.js — chain I/O for the Autofarm keeper.
//
// `readState(env)` gathers live testnet state into the exact shape `decide()` (./decide.js)
// consumes; `submit(env, action)` executes one action `decide()` returned. Pure decision logic
// stays in decide.js — this module only talks to Soroban RPC.
//
// All contract-call encodings verified live against testnet (2026-07-03) before being wired in
// here (see task-13-report.md): vault has NO public `last_rebalance` getter (checked
// soroban/contracts/rwa_vault/src/lib.rs), so it's read as a raw instance-storage entry instead
// (`readInstanceStorageEntry`) — Rust's `#[contracttype] enum DataKey { LastRebalance, .. }`
// (all-unit variants) encodes each variant as `ScVal::Vec([ScVal::Symbol(name)])`, confirmed by
// fetching the live vault's instance storage and observing exactly that shape.
import {
  rpc,
  Contract,
  TransactionBuilder,
  Keypair,
  Address,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';

const TX_TIMEOUT_S = 30;

// Blend v2 fixed-point scales (see docs/superpowers/specs/2026-07-03-vf-autofarm-design.md §3):
// config fractions (util/IR breakpoints) are 1e7 scale; b_rate/d_rate are 1e12 scale.
const SCALAR_7 = 10_000_000n;
const SCALAR_12 = 1_000_000_000_000n;
const BPS_DENOMINATOR = 10_000n;

// ----- SDK plumbing -----

function rpcServer(env) {
  return new rpc.Server(env.SOROBAN_RPC_URL);
}

/** The keeper's only identity: relayer keypair. It is both the tx source (pays gas) and the
 * on-chain `keeper()` the vault's `require_keeper` checks — see task-13 brief / CLAUDE.md. */
function relayerKeypair(env) {
  if (!env.STELLAR_RELAYER_SECRET) {
    throw new Error('STELLAR_RELAYER_SECRET is not set (wrangler secret / .dev.vars)');
  }
  return Keypair.fromSecret(env.STELLAR_RELAYER_SECRET);
}

function addrScVal(strkey) {
  return new Address(strkey).toScVal();
}
function i128ScVal(n) {
  return nativeToScVal(BigInt(n), { type: 'i128' });
}
function u32ScVal(n) {
  return nativeToScVal(Number(n), { type: 'u32' });
}
function i128VecScVal(values) {
  return xdr.ScVal.scvVec(values.map((v) => i128ScVal(v)));
}

/**
 * Simulate a read-only contract call and decode the return value. Throws on simulation error —
 * callers decide whether that's fatal (idle/strategy balance) or best-effort (APR/emissions/
 * quote — wrapped by `bestEffort` below).
 */
async function simCall(server, env, simSource, contractId, method, args = []) {
  const account = await server.getAccount(simSource);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: env.NETWORK_PASSPHRASE,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(TX_TIMEOUT_S)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`simulate ${contractId}.${method} failed: ${sim.error}`);
  }
  return sim.result?.retval ? scValToNative(sim.result.retval) : null;
}

/** Best-effort read: log a warning and fall back rather than fail the whole tick. Used for
 * fields the task brief marks best-effort (blndClaimable, supplyAprBps, lastRebalanceTs,
 * blndQuote) — idle and strategy balance are NOT wrapped here, a failure there is fatal for
 * the tick (readState throws, index.js logs + skips the whole tick). */
async function bestEffort(label, fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    console.warn(`[keeper:chain] best-effort read failed (${label}), using fallback`, String(err?.message || err));
    return fallback;
  }
}

/**
 * Raw instance-storage read for a contract's `env.storage().instance()` key that has no public
 * contract fn exposing it (the vault's `LastRebalance` — see module doc above for the encoding
 * proof). Returns the decoded native value, or `null` if the key isn't set.
 */
async function readInstanceStorageEntry(server, contractId, keyName) {
  const key = xdr.ScVal.scvLedgerKeyContractInstance();
  const entry = await server.getContractData(contractId, key, rpc.Durability.Persistent);
  const storage = entry.val.contractData().val().instance().storage();
  if (!storage) return null;
  for (const mapEntry of storage) {
    const k = scValToNative(mapEntry.key());
    if (Array.isArray(k) && k.length === 1 && k[0] === keyName) {
      return scValToNative(mapEntry.val());
    }
  }
  return null;
}

// ----- individual reads -----

async function readIdle(server, env, simSource) {
  const val = await simCall(server, env, simSource, env.USDC, 'balance', [addrScVal(env.VAULT_ADDRESS)]);
  return BigInt(val ?? 0);
}

async function readStrategyBalance(server, env, simSource, strategyAddress) {
  const val = await simCall(server, env, simSource, strategyAddress, 'balance', []);
  return BigInt(val ?? 0);
}

/** bToken (supply-side) `reserve_token_id` for `asset` on `poolAddress` = reserve_list index *
 * 2 + 1 (Blend v2 convention, verified live — Task 1 spike, docs/superpowers/plans/
 * 2026-07-03-vf-autofarm-progress.md). Derived fresh rather than hardcoded so a pool's reserve
 * ordering never silently drifts out from under a magic number. */
async function deriveReserveTokenId(server, env, simSource, poolAddress, assetAddress) {
  const list = await simCall(server, env, simSource, poolAddress, 'get_reserve_list', []);
  const idx = (list || []).findIndex((a) => String(a) === assetAddress);
  if (idx < 0) throw new Error(`asset ${assetAddress} not found in ${poolAddress} reserve list`);
  return idx * 2 + 1;
}

/** Best-effort BLND claimable for `strategyAddress` on `poolAddress`. Empirically `false` for
 * USDC supply on TestnetV2 (Task 1 spike: `get_reserve_emissions(7)` → None) — this will read 0
 * live today; kept real (not stubbed) so it starts working the day emissions turn on or a
 * different pool is wired in. */
async function readBlndClaimable(server, env, simSource, poolAddress, strategyAddress) {
  const reserveTokenId = await deriveReserveTokenId(server, env, simSource, poolAddress, env.USDC);
  const val = await simCall(server, env, simSource, poolAddress, 'get_user_emissions', [
    addrScVal(strategyAddress),
    u32ScVal(reserveTokenId),
  ]);
  if (val == null) return 0n; // Option::None — no emissions configured for this reserve token id
  if (typeof val === 'bigint') return val;
  if (val && typeof val === 'object' && 'accrued' in val) return BigInt(val.accrued); // UserEmissionData.accrued
  return 0n; // unrecognized shape — degrade to 0 rather than guess
}

/**
 * Keeper-side supply-APR ESTIMATE (bps) from Blend's reserve config/data, using the 3-slope
 * kinked-rate curve documented in docs/superpowers/specs/2026-07-03-vf-autofarm-design.md §3
 * (`pool/src/pool/reserve.rs`). This is a JUDGMENT-CALL approximation for cross-strategy
 * rebalance comparison, NOT an authoritative Blend APR source. With only one live strategy
 * today, `decide()`'s rebalance branch never fires regardless of this value (`highest ===
 * lowest` short-circuits — see decide.js `findAprExtremes`/`decideRebalance`); this exists so a
 * future second strategy has a real number to compare against, not a placeholder.
 */
function estimateSupplyAprBps(reserve, backstopTakeRateFraction) {
  const { config, data } = reserve;
  const bSupplyUnderlying = (BigInt(data.b_supply) * BigInt(data.b_rate)) / SCALAR_12;
  const dSupplyUnderlying = (BigInt(data.d_supply) * BigInt(data.d_rate)) / SCALAR_12;
  if (bSupplyUnderlying <= 0n) return 0;

  const util = (dSupplyUnderlying * SCALAR_7) / bSupplyUnderlying;
  const targetUtil = BigInt(config.util);
  const maxUtil = BigInt(config.max_util);
  const rBase = BigInt(config.r_base);
  const rOne = BigInt(config.r_one);
  const rTwo = BigInt(config.r_two);
  const rThree = BigInt(config.r_three);

  let borrowRate;
  if (util <= targetUtil) {
    borrowRate = rBase + (util * rOne) / (targetUtil || 1n);
  } else if (util <= maxUtil) {
    borrowRate = rBase + rOne + ((util - targetUtil) * rTwo) / ((maxUtil - targetUtil) || 1n);
  } else {
    borrowRate = rBase + rOne + rTwo + ((util - maxUtil) * rThree) / ((SCALAR_7 - maxUtil) || 1n);
  }
  const irMod = BigInt(data.ir_mod); // 1e7 fixed point, 1e7 == 1.0x (no reactivity adjustment yet)
  const adjustedBorrowRate = (borrowRate * irMod) / SCALAR_7;
  const supplyRate = (adjustedBorrowRate * util * (SCALAR_7 - backstopTakeRateFraction)) / (SCALAR_7 * SCALAR_7);
  return Number((supplyRate * BPS_DENOMINATOR) / SCALAR_7);
}

async function readSupplyAprBps(server, env, simSource, poolAddress) {
  const reserve = await simCall(server, env, simSource, poolAddress, 'get_reserve', [addrScVal(env.USDC)]);
  const poolConfig = await simCall(server, env, simSource, poolAddress, 'get_config', []);
  return estimateSupplyAprBps(reserve, BigInt(poolConfig.bstop_rate));
}

async function readLastRebalanceTs(server, env) {
  const raw = await readInstanceStorageEntry(server, env.VAULT_ADDRESS, 'LastRebalance');
  return raw == null ? 0 : Number(raw);
}

async function readLedgerNowTs(server) {
  const latest = await server.getLatestLedger();
  return Number(latest.closeTime);
}

/**
 * Soroswap router quote wrapper matching decide()'s synchronous `{ usdcOutFor(blndAmount) }`
 * contract (decide.js calls it with no `await` — see `minOutForStrategy`). Since RPC reads are
 * async, every claimable amount decide() could possibly ask about is quoted UP FRONT here and
 * stashed in a lookup map; `usdcOutFor` then just reads that map synchronously. Returns `null`
 * when there's nothing to quote (every strategy's `blndClaimable` is 0 — the live case today)
 * or the route read fails, matching decide.js's `!blndQuote` hold-BLND fallback.
 */
async function buildBlndQuote(server, env, simSource, claimableAmounts) {
  const nonZero = [...new Set(claimableAmounts.filter((a) => a > 0n).map((a) => a.toString()))].map(BigInt);
  if (nonZero.length === 0) return null;

  const path = xdr.ScVal.scvVec([addrScVal(env.BLND), addrScVal(env.USDC)]);
  const quotes = new Map();
  for (const amount of nonZero) {
    const amounts = await simCall(server, env, simSource, env.SOROSWAP_ROUTER, 'router_get_amounts_out', [
      i128ScVal(amount),
      path,
    ]);
    quotes.set(amount.toString(), BigInt(amounts[amounts.length - 1]));
  }
  return { usdcOutFor: (blndAmount) => quotes.get(BigInt(blndAmount).toString()) ?? 0n };
}

// ----- public API -----

/**
 * Gather live state into the exact shape `decide()` (./decide.js) consumes.
 * @param {object} env wrangler env (vars + STELLAR_RELAYER_SECRET secret)
 * @returns {Promise<import('./decide.js').DecideState>}
 */
export async function readState(env) {
  const server = rpcServer(env);
  const simSource = relayerKeypair(env).publicKey(); // funded relayer G-address; also submit's tx source

  const idle = await readIdle(server, env, simSource);

  const pairs = [
    { strategy: env.STRATEGY_1, pool: env.POOL_1 },
    { strategy: env.STRATEGY_2, pool: env.POOL_2 },
  ].filter((p) => p.strategy);

  const strategies = [];
  for (const { strategy, pool } of pairs) {
    const balance = await readStrategyBalance(server, env, simSource, strategy);
    const blndClaimable = await bestEffort(
      `blndClaimable:${strategy}`,
      () => readBlndClaimable(server, env, simSource, pool, strategy),
      0n,
    );
    const supplyAprBps = await bestEffort(
      `supplyAprBps:${pool}`,
      () => readSupplyAprBps(server, env, simSource, pool),
      0,
    );
    strategies.push({
      address: strategy,
      balance,
      supplyAprBps,
      // Book-principal design (blend_strategy.rs `balance()`): interest realizes at harvest,
      // not read live here. A live estimate would need pool.get_reserve(USDC).b_rate times the
      // strategy's live bToken position, which the strategy contract doesn't expose today — 0
      // is an honest floor; `idle > 0` already drives compound on the demo vault regardless
      // (see decide.js `decideCompound`).
      pendingInterest: 0n,
      blndClaimable,
    });
  }

  const lastRebalanceTs = await bestEffort('lastRebalanceTs', () => readLastRebalanceTs(server, env), 0);
  const nowTs = await bestEffort(
    'nowTs',
    () => readLedgerNowTs(server),
    Math.floor(Date.now() / 1000),
  );
  const blndQuote = await bestEffort(
    'blndQuote',
    () => buildBlndQuote(server, env, simSource, strategies.map((s) => s.blndClaimable)),
    null,
  );

  return { strategies, idle, lastRebalanceTs, nowTs, blndQuote };
}

function buildActionOperation(env, action) {
  if (action.type === 'compound') {
    return new Contract(env.VAULT_ADDRESS).call('compound', i128VecScVal(action.minOuts));
  }
  if (action.type === 'rebalance') {
    return new Contract(env.VAULT_ADDRESS).call(
      'rebalance',
      addrScVal(action.from),
      addrScVal(action.to),
      i128ScVal(action.amount),
    );
  }
  throw new Error(`submit: unknown action type "${action.type}"`);
}

/**
 * Execute one action `decide()` returned. Flow: re-fetch the source (relayer) account fresh →
 * build → simulate+assemble (`prepareTransaction`, one call) → sign → send → poll for
 * confirmation → return the tx hash. Throws on any failure (simulation, send rejection, or
 * non-SUCCESS confirmation) — index.js's per-action try/catch treats that as a graceful skip,
 * no retry (the next 15-min cron tick tries again with fresh state).
 * @param {object} env wrangler env
 * @param {{ type: 'compound', minOuts: bigint[] } | { type: 'rebalance', from: string, to: string, amount: bigint }} action
 * @returns {Promise<string>} confirmed tx hash
 */
export async function submit(env, action) {
  const server = rpcServer(env);
  const kp = relayerKeypair(env);
  // Re-fetch the source account fresh right before building — reusing a stale Account object
  // across multiple tx builds double-increments the sequence number client-side and causes
  // txBadSeq on submit (memory: onchain-live-submit-error-playbook, 2026-06-30).
  const account = await server.getAccount(kp.publicKey());

  const op = buildActionOperation(env, action);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: env.NETWORK_PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(TX_TIMEOUT_S)
    .build();

  // prepareTransaction simulates + assembles auth/footprint/resource fees in one call; it
  // throws on simulation failure (@stellar/stellar-sdk rpc/server.js `prepareTransaction`) —
  // e.g. a dust compound below Blend's minimum supply. That throw propagates to index.js's
  // per-action catch as the graceful skip.
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(kp);

  const sendResult = await server.sendTransaction(prepared);
  if (sendResult.status !== 'PENDING' && sendResult.status !== 'DUPLICATE') {
    throw new Error(`submit ${action.type} not accepted: status=${sendResult.status} ${JSON.stringify(sendResult.errorResult ?? '')}`);
  }

  const final = await server.pollTransaction(sendResult.hash);
  if (final.status !== 'SUCCESS') {
    throw new Error(`submit ${action.type} tx ${sendResult.hash} did not confirm: status=${final.status}`);
  }
  return sendResult.hash;
}
