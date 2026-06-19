use soroban_sdk::{Address, Env};
use stellar_tokens::fungible::Base;

use crate::storage::{get_acc, get_pending, get_reward_debt, set_pending, set_reward_debt, SCALE};

/// accumulated = share_balance * acc / SCALE  (total dividend this holder is entitled to
/// across all drips at the current balance).
fn accumulated(e: &Env, holder: &Address) -> i128 {
    let bal = Base::balance(e, holder);
    let acc = get_acc(e);
    bal.checked_mul(acc).expect("accumulated overflow") / SCALE
}

/// reward_debt = accumulated at the current balance. Call AFTER a balance change.
pub fn sync_debt(e: &Env, holder: &Address) {
    let debt = accumulated(e, holder);
    set_reward_debt(e, holder, debt);
}

/// Bank the holder's unaccounted gain (accumulated - reward_debt, computed at the
/// CURRENT balance) into Pending, then realign reward_debt. Call BEFORE a balance change.
pub fn settle(e: &Env, holder: &Address) {
    let acc_now = accumulated(e, holder);
    let debt = get_reward_debt(e, holder);
    let gain = acc_now - debt; // >= 0 (acc only grows; balance constant since last sync)
    if gain > 0 {
        let pend = get_pending(e, holder).checked_add(gain).expect("pending overflow");
        set_pending(e, holder, pend);
    }
    set_reward_debt(e, holder, acc_now);
}

/// View: settled Pending + unaccounted gain at the current balance.
pub fn claimable(e: &Env, holder: &Address) -> i128 {
    let acc_now = accumulated(e, holder);
    let debt = get_reward_debt(e, holder);
    get_pending(e, holder) + (acc_now - debt)
}
