use soroban_sdk::{Address, Env};
use stellar_tokens::fungible::Base;

use crate::storage::{get_acc, get_reward_debt, set_reward_debt, SCALE};

/// reward_debt = current_share_balance * acc / SCALE. Called after any balance change.
pub fn sync_debt(e: &Env, holder: &Address) {
    let bal = Base::balance(e, holder);
    let acc = get_acc(e);
    let debt = bal.checked_mul(acc).expect("debt overflow") / SCALE;
    set_reward_debt(e, holder, debt);
}

/// Bank the holder's accrued dividend (at the current balance) into Pending, then
/// realign reward_debt. Must be called BEFORE a balance change. Task 3 expands this
/// with the Pending accumulation; the deposit/redeem path above already calls it.
pub fn settle(e: &Env, holder: &Address) {
    // Task 3 fills the Pending banking. For Task 2 (no drips yet) acc == 0, so
    // settle is a no-op beyond keeping reward_debt consistent.
    let _ = get_reward_debt(e, holder);
    sync_debt(e, holder);
}
