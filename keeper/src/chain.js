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
import { estimateSupplyAprBps, utilizationBps } from './apr.js';

const TX_TIMEOUT_S = 30;

// Blend v2 fixed-point scale for b_rate/d_rate (see docs/superpowers/specs/
// 2026-07-03-vf-autofarm-design.md §3). The 1e7 config-fraction scale + bps denominator
// `estimateSupplyAprBps` also needs now live in ./apr.js with that function (T2 Fix 3 dedup).
const SCALAR_12 = 1_000_000_000_000n;

// ----- SDK plumbing -----

function rpcServer(env) {
  return new rpc.Server(env.SOROBAN_RPC_URL);
}

/** The keeper's own identity: STELLAR_KEEPER_SECRET, deliberately separate from
 * STELLAR_RELAYER_SECRET (the user-facing gasless-relay signer used elsewhere in the app — see
 * frontend/src/stellar). It is both the tx source (pays gas) and the on-chain `keeper()` the
 * vault's `require_keeper` checks — see task-13 brief / CLAUDE.md. No fallback to the relayer
 * secret: fails fast if the keeper's own key is unset (T2 Fix 1, identity split). */
function keeperKeypair(env) {
  if (!env.STELLAR_KEEPER_SECRET) {
    throw new Error('STELLAR_KEEPER_SECRET is not set (wrangler secret / .dev.vars)');
  }
  return Keypair.fromSecret(env.STELLAR_KEEPER_SECRET);
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
 * fields the task brief marks best-effort (blndClaimable, supplyAprBps, pendingInterest,
 * lastRebalanceTs, blndQuote) — idle and strategy balance are NOT wrapped here, a failure there
 * is fatal for the tick (readState throws, index.js logs + skips the whole tick). */
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

/** Plain reserve-list index of `assetAddress` on `poolAddress`. Derived fresh (not hardcoded) so
 * a pool's reserve ordering never silently drifts out from under a magic number. This is the key
 * Blend v2's `Positions` struct (`get_positions` return) uses for its `supply`/`collateral`/
 * `liabilities` maps — see soroban/contracts/blend_strategy/src/blend.rs `Positions` doc comment
 * ("Keyed by reserve index"). NOT the bToken `reserve_token_id` (`index*2+1`, see
 * `deriveReserveTokenId` below) that emissions reads (`get_user_emissions`/`claim`) use. */
async function deriveReserveIndex(server, env, simSource, poolAddress, assetAddress) {
  const list = await simCall(server, env, simSource, poolAddress, 'get_reserve_list', []);
  const idx = (list || []).findIndex((a) => String(a) === assetAddress);
  if (idx < 0) throw new Error(`asset ${assetAddress} not found in ${poolAddress} reserve list`);
  return idx;
}

/** bToken (supply-side) `reserve_token_id` for `asset` on `poolAddress` = reserve index * 2 + 1
 * (Blend v2 convention, verified live — Task 1 spike, docs/superpowers/plans/
 * 2026-07-03-vf-autofarm-progress.md). */
async function deriveReserveTokenId(server, env, simSource, poolAddress, assetAddress) {
  const idx = await deriveReserveIndex(server, env, simSource, poolAddress, assetAddress);
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

// estimateSupplyAprBps lives in ./apr.js now (T2 Fix 3 — was duplicated verbatim in
// frontend/src/stellar/vaultReads.js; extracted to a single pure module both import).
async function readSupplyAprBps(server, env, simSource, poolAddress) {
  const reserve = await simCall(server, env, simSource, poolAddress, 'get_reserve', [addrScVal(env.USDC)]);
  const poolConfig = await simCall(server, env, simSource, poolAddress, 'get_config', []);
  return estimateSupplyAprBps(reserve, BigInt(poolConfig.bstop_rate));
}

/**
 * Pure: live Blend valuation of a strategy's bToken supply position minus its book principal —
 * the realizable-at-harvest interest `decide()`'s `totalPendingInterest` MIN_COMPOUND gate sums
 * across strategies (decide.js `decideCompound`; decide.js itself is unchanged by this — it just
 * finally receives a real, non-zero number here). `positions` is the pool's
 * `get_positions(strategy)` return, decoded by @stellar/stellar-sdk's `scValToNative` — a Blend
 * `Map<u32, i128>` decodes to a plain JS object keyed by the numeric-string reserve index (see
 * `scval.js`'s `scvMap` case: `Object.fromEntries`), which is why `positions.supply[reserveIndex]`
 * (a bare number) still resolves — JS coerces the property key to a string on access. `bRate` is
 * that reserve's `get_reserve(asset).data.b_rate` (12-decimal, SCALAR_12 — same scale
 * `estimateSupplyAprBps` uses). Clamped to 0n: a pool shortfall (live value < book principal —
 * see blend_strategy.rs `harvest()`'s "pulled < principal" markdown) is a realized loss, not
 * negative pending interest.
 * @param {{ supply?: Record<string, bigint|string|number> }} positions decoded Blend `Positions`
 * @param {number} reserveIndex USDC's plain reserve-list index (`deriveReserveIndex` — NOT the
 *   `reserve_token_id` emissions reads use)
 * @param {bigint} bRate pool `get_reserve(USDC).data.b_rate`
 * @param {bigint} principal strategy `balance()` (book principal)
 * @returns {bigint}
 */
export function computePendingInterest(positions, reserveIndex, bRate, principal) {
  const bTokenAmount = BigInt(positions?.supply?.[reserveIndex] ?? 0);
  const liveValue = (bTokenAmount * BigInt(bRate)) / SCALAR_12;
  const pending = liveValue - BigInt(principal);
  return pending > 0n ? pending : 0n;
}

/** Wires `computePendingInterest`'s three RPC-sourced inputs together for one strategy. Fully
 * best-effort at the call site in `readState` — any failure here (pool doesn't expose
 * `get_positions`, RPC hiccup) degrades to 0n, same floor the old hardcoded value used. */
async function readPendingInterest(server, env, simSource, poolAddress, strategyAddress, principal) {
  const reserveIndex = await deriveReserveIndex(server, env, simSource, poolAddress, env.USDC);
  const positions = await simCall(server, env, simSource, poolAddress, 'get_positions', [
    addrScVal(strategyAddress),
  ]);
  const reserve = await simCall(server, env, simSource, poolAddress, 'get_reserve', [addrScVal(env.USDC)]);
  return computePendingInterest(positions, reserveIndex, BigInt(reserve.data.b_rate), principal);
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
 * @param {object} env wrangler env (vars + STELLAR_KEEPER_SECRET secret)
 * @returns {Promise<import('./decide.js').DecideState>}
 */
export async function readState(env) {
  const server = rpcServer(env);
  const simSource = keeperKeypair(env).publicKey(); // funded keeper G-address; also submit's tx source

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
    const pendingInterest = await bestEffort(
      `pendingInterest:${strategy}`,
      () => readPendingInterest(server, env, simSource, pool, strategy, balance),
      0n,
    );
    strategies.push({
      address: strategy,
      balance,
      supplyAprBps,
      pendingInterest,
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

/**
 * Lifeboat radar read (one per ledger). Signal fields degrade to null on their own failure —
 * decideLifeboat treats null as "signal unavailable" and never engages on it. Only the vault
 * `lifeboat_state()` read is fatal (throws): if we cannot even see the vault, the radar tick
 * logs and skips rather than acting on a guess.
 * @param {object} env same env object `readState` takes (+ optional POOL_ORACLE)
 * @returns {Promise<{utilizationBps: number|null, availableLiquidity: bigint|null,
 *   poolPrice: number|null, derisked: boolean, mandateExpiry: number, nowTs: number}>}
 */
export async function readLifeboatChainState(env) {
  const server = rpcServer(env);
  const simSource = keeperKeypair(env).publicKey();

  const utilization = await bestEffort(
    'lifeboat:utilization',
    async () => {
      const reserve = await simCall(server, env, simSource, env.POOL_1, 'get_reserve', [addrScVal(env.USDC)]);
      return utilizationBps(reserve);
    },
    null,
  );

  const availableLiquidity = await bestEffort(
    'lifeboat:availableLiquidity',
    async () => {
      const val = await simCall(server, env, simSource, env.USDC, 'balance', [addrScVal(env.POOL_1)]);
      return BigInt(val ?? 0);
    },
    null,
  );

  let poolPrice = null;
  if (env.POOL_ORACLE) {
    poolPrice = await bestEffort(
      'lifeboat:poolPrice',
      async () => {
        // Blend oracle (SEP-40 style): lastprice(Asset::Stellar(usdc)) -> Option<PriceData>,
        // price scaled by oracle.decimals().
        const asset = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Stellar'), addrScVal(env.USDC)]);
        const priceData = await simCall(server, env, simSource, env.POOL_ORACLE, 'lastprice', [asset]);
        if (priceData == null) return null; // Option::None — no price feed for this asset
        const decimals = await simCall(server, env, simSource, env.POOL_ORACLE, 'decimals', []);
        return Number(priceData.price) / 10 ** Number(decimals);
      },
      null,
    );
  }

  // Fatal on failure by design — no bestEffort wrapper here.
  const ls = await simCall(server, env, simSource, env.VAULT_ADDRESS, 'lifeboat_state', []);

  const nowTs = await bestEffort('lifeboat:nowTs', () => readLedgerNowTs(server), Math.floor(Date.now() / 1000));

  return {
    utilizationBps: utilization,
    availableLiquidity,
    poolPrice,
    derisked: Boolean(ls.derisked),
    mandateExpiry: Number(ls.mandate_expiry),
    nowTs,
  };
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
  if (action.type === 'derisk') {
    return new Contract(env.VAULT_ADDRESS).call('emergency_derisk', u32ScVal(action.reason));
  }
  if (action.type === 'resume') {
    return new Contract(env.VAULT_ADDRESS).call('resume');
  }
  throw new Error(`submit: unknown action type "${action.type}"`);
}

/**
 * Execute one action `decide()` returned. Flow: re-fetch the source (keeper) account fresh →
 * build → simulate+assemble (`prepareTransaction`, one call) → sign → send → poll for
 * confirmation → return the tx hash. Throws on any failure (simulation, send rejection, or
 * non-SUCCESS confirmation) — index.js's per-action try/catch treats that as a graceful skip,
 * no retry (the next 15-min cron tick tries again with fresh state).
 * @param {object} env wrangler env
 * @param {{ type: 'compound', minOuts: bigint[] } | { type: 'rebalance', from: string, to: string, amount: bigint }
 *   | { type: 'derisk', reason: number } | { type: 'resume' }} action
 * @returns {Promise<string>} confirmed tx hash
 */
export async function submit(env, action) {
  const server = rpcServer(env);
  const kp = keeperKeypair(env);
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
