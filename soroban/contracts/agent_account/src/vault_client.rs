// Local typed client for the deployed autofarm_vault. Hand-written so we do NOT import the
// vault wasm at build time (a sibling-wasm import collided on __constructor in sub-project
// 1d). Signatures are copied verbatim from autofarm_vault's public contract API — keep them in sync.
use soroban_sdk::{contractclient, Address, Env};

#[contractclient(name = "VaultClient")]
pub trait VaultInterface {
    fn deposit(env: Env, from: Address, amount: i128) -> i128;
    fn redeem(env: Env, from: Address, shares: i128) -> i128;
    fn balance(env: Env, id: Address) -> i128;
}
