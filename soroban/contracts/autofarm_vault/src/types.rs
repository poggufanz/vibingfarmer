use soroban_sdk::{contracterror, contractevent, contracttype, Address, BytesN};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    // NOTE: no `Admin` key here — the admin lives in OZ access-control storage
    // (`AccessControlStorageKey::Admin`). A `DataKey::Admin` unit variant would encode to
    // the identical `Vec[Symbol("Admin")]` storage key and collide (→ AdminAlreadySet).
    Token,         // yield-farming asset token address (SEP-41 / SAC)
    Strategies,    // Vec<Address> — registered strategies, drained in order on redeem
    Keeper,        // address allowed to call compound/rebalance (Task 8/9)
    LastRebalance, // ledger timestamp of the last rebalance; constructor seeds it to 0
    CooldownS,     // min seconds between rebalances (enforced starting Task 9)
    MaxMoveBps,    // max bps of total_assets movable per rebalance (enforced starting Task 9)
    // Task R1 — appended (not inserted) below the Task 9 keys: a `#[contracttype]`
    // unit-variant enum encodes each variant by its OWN name (see the `Admin` NOTE above), so
    // adding these here cannot shift or collide with any already-live storage entry on the
    // wasm-upgraded vault.
    LastCompound, // ledger timestamp of the last successful compound. Absent (NOT 0) until
    // the first compound EVER succeeds — deliberately not seeded by the constructor (unlike
    // LastRebalance), since a wasm upgrade never re-runs it; see storage::get_last_compound.
    CompoundCooldownS, // min seconds between compounds. Absent key falls back to
    // storage::DEFAULT_COMPOUND_COOLDOWN_S, so an already-deployed vault
    // gets the gate for free on upgrade with no constructor re-run needed.
    // Lifeboat — appended below the Task R1 keys (append-only rule: unit variants encode by
    // their own name, so adding here cannot shift or collide with live storage — see the
    // `Admin` NOTE at the top of this enum).
    MandateAuthority, // Option<Address> — may grant/renew the lifeboat mandate (admin sets once)
    MandateExpiry,    // u64 unix ts — keeper may derisk/resume only while now < expiry; absent = 0
    Derisked,         // bool — lifeboat engaged; compound/rebalance blocked while true
    // Upgrade timelock — appended (append-only rule: unit variants encode by their own name,
    // so adding here cannot shift or collide with any live storage entry on the upgraded vault).
    PendingUpgrade, // Option<PendingUpgrade> — scheduled upgrade; absent = none pending
}

/// A scheduled, not-yet-executed contract upgrade. Absent = nothing pending.
#[contracttype]
#[derive(Clone)]
pub struct PendingUpgrade {
    pub wasm_hash: BytesN<32>,
    pub eta: u64, // ledger timestamp at/after which execute_upgrade may run
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum VaultError {
    NotInit = 1,
    InvalidAmount = 2,
    InsufficientShares = 4, // redeem more shares than held
    MathOverflow = 5,
    StrategyNotFound = 10,  // remove_strategy: address isn't in the registry
    TooManyStrategies = 11, // add_strategy: registry already holds MAX_STRATEGIES (4)
    StrategyNotEmpty = 12,  // remove_strategy: strategy.balance() != 0
    NotKeeper = 13,         // compound/rebalance: caller isn't the registered keeper (or none set)
    CooldownActive = 14,    // rebalance OR compound (Task R1): called again before its own
    // cooldown (`CooldownS`/`CompoundCooldownS`) elapsed since its own last call — shared
    // variant, reused rather than adding a near-duplicate error code for the same condition
    MoveTooLarge = 15, // rebalance: amount <= 0, or exceeds `max_move_bps` of `from`'s balance
    FirstDepositTooSmall = 16, // first deposit below MIN_FIRST_DEPOSIT (inflation guard)
    InsufficientLiquidity = 17, // redeem cannot be covered even after draining strategies
    StrategyAlreadyRegistered = 18, // add_strategy: address is already in the registry
    AuthorityNotSet = 19, // set_mandate: no mandate authority configured yet
    MandateExpired = 20, // emergency_derisk/resume: mandate absent (0) or now >= expiry
    LifeboatEngaged = 21, // compound/rebalance: blocked while the vault is derisked
    // Security hardening — appended (append-only rule, see DataKey NOTE above).
    StrategyMisbehaved = 22, // observed token delta disagrees with the strategy's report
    InvalidParam = 23,       // set_limits bps > 10_000, or negative acknowledged_loss
    // Upgrade timelock (append-only — next free codes).
    NoPendingUpgrade = 24,   // execute/cancel called with nothing scheduled
    TimelockNotElapsed = 25, // execute called before eta
}

#[contractevent(topics = ["vault_deposit"])]
pub struct Deposit {
    pub holder: Address,
    pub amount: i128, // assets pulled in
    pub shares: i128, // shares minted at the current exchange rate
}

#[contractevent(topics = ["vault_redeem"])]
pub struct Redeem {
    pub holder: Address,
    pub shares: i128, // shares burned
    pub assets: i128, // assets paid out at the current exchange rate
}

#[contractevent(topics = ["vault_compound"])]
pub struct Compound {
    pub total_gain: i128,      // USDC gain realized across every strategy this call
    pub price_per_share: i128, // exchange rate immediately after the sweep (7dp, PPS_SCALE)
}

#[contractevent(topics = ["vault_rebalance"])]
pub struct Rebalance {
    pub from: Address, // strategy drained
    pub to: Address,   // strategy credited, or the vault's own address (de-risk-to-idle)
    pub amount: i128,  // actual amount moved (the `from` strategy's real `withdraw` return)
}

#[contracttype]
#[derive(Clone)]
pub struct LifeboatState {
    pub derisked: bool,
    pub mandate_expiry: u64,
    pub authority: Option<Address>,
}

#[contractevent(topics = ["vault_mandate"])]
pub struct MandateSet {
    pub authority: Address,
    pub expiry: u64,
}

#[contractevent(topics = ["vault_derisk"])]
pub struct LifeboatEngaged {
    pub reason_code: u32, // 1=UTIL_SPIKE 2=LIQ_DROP 3=ORACLE_DIVERGENCE (shared with keeper/UI)
    pub drained_total: i128,
}

#[contractevent(topics = ["vault_resume"])]
pub struct LifeboatResumed {
    pub idle: i128, // vault token balance right after resume
}

#[contractevent(topics = ["vault_quarantine"])]
pub struct StrategyQuarantined {
    pub strategy: Address,
    pub acknowledged_loss: i128, // admin-acknowledged NAV loss (incident accounting)
}

#[contractevent(topics = ["vault_upgrade_scheduled"])]
pub struct UpgradeScheduled {
    pub wasm_hash: BytesN<32>,
    pub eta: u64,
}

#[contractevent(topics = ["vault_upgrade_executed"])]
pub struct UpgradeExecuted {
    pub wasm_hash: BytesN<32>,
}

#[contractevent(topics = ["vault_upgrade_cancelled"])]
pub struct UpgradeCancelled {
    pub wasm_hash: BytesN<32>,
}
