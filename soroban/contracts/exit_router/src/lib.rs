//! ExitRouter — the one-popup exit, mirroring what `funding_router.grant` does for entry.
//!
//! A position is the SUM of every agent's shares, but `agent_account.owner_withdraw` sweeps ONE
//! agent whole and Soroban allows a single host-function invocation per transaction. Exiting N
//! agents was therefore N transactions and N wallet popups — the deposit side takes one signature,
//! the withdraw side charged one per agent.
//!
//! `sweep` is that missing single invocation. The owner's `require_auth()` here and the one inside
//! each agent's `owner_withdraw` are the SAME address as the transaction source, so every one of
//! them rides source-account credentials and the envelope signature covers the whole tree — one
//! popup, N agents. (Same insight as grant.js: `router.grant` covers its nested `token.approve`.)
//!
//! Zero custody, zero state, no admin, no upgrade. The funds go agent -> `to` directly; this
//! contract never holds them. It grants no authority either: each agent still checks its OWN
//! stored owner, so naming an agent you do not own sweeps nothing.
#![no_std]
use soroban_sdk::{contract, contractclient, contracterror, contractimpl, Address, Env, Vec};

mod test;

/// Local typed client for the deployed agent_account. Hand-written rather than importing the
/// sibling wasm — same reasoning (and same `Result<i128, E>` -> `-> i128` convention, the SDK
/// unwraps Ok on the wire and traps on Err) as agent_account's own vault_client.
#[contractclient(name = "AgentClient")]
pub trait AgentInterface {
    fn owner_withdraw(env: Env, to: Address) -> i128;
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ExitError {
    EmptyAgents = 1,
    NothingSwept = 2,
}

#[contract]
pub struct ExitRouter;

#[contractimpl]
impl ExitRouter {
    /// Sweep every agent in `agents` back to `to` under ONE owner authorization.
    ///
    /// Returns the amount swept per agent, positionally — 0 where that agent had nothing to sweep
    /// or refused (revoked, expired, or not owned by `owner`). A caller showing a partial sweep as
    /// done is the failure this return value exists to prevent, so per-agent outcomes are reported
    /// rather than summed away.
    ///
    /// One bad agent must not strand the rest's funds, so each call is a `try_` — a failing agent
    /// rolls back alone and the sweep continues. But a sweep that moved NOTHING is an error, not
    /// an empty success: without that, an all-agents-failed exit would return a Vec of zeros and
    /// every caller that only checks the transaction status would report the withdraw as done.
    pub fn sweep(env: Env, owner: Address, agents: Vec<Address>, to: Address) -> Result<Vec<i128>, ExitError> {
        owner.require_auth();
        if agents.is_empty() {
            return Err(ExitError::EmptyAgents);
        }
        let mut swept: Vec<i128> = Vec::new(&env);
        let mut any = false;
        for agent in agents.iter() {
            let amount = match AgentClient::new(&env, &agent).try_owner_withdraw(&to) {
                Ok(Ok(amount)) if amount > 0 => {
                    any = true;
                    amount
                }
                _ => 0,
            };
            swept.push_back(amount);
        }
        if !any {
            return Err(ExitError::NothingSwept);
        }
        Ok(swept)
    }
}
