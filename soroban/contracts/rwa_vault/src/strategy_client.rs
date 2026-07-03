use soroban_sdk::{contractclient, Env};

#[contractclient(name = "StrategyClient")]
pub trait StrategyIface {
    fn deposit(e: Env, amount: i128);
    fn withdraw(e: Env, amount: i128) -> i128;
    fn balance(e: Env) -> i128;
    fn harvest(e: Env, min_out: i128) -> i128;
}
