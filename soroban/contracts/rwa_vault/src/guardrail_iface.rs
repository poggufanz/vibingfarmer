use soroban_sdk::{contractclient, Address, Env};

/// Local client interface for the 1d guardrail (`consume`/`release`). Declared here rather
/// than taking a path-dependency on the guardrail crate so the guardrail's contract symbols
/// (`__constructor`, entrypoint exports) are NOT linked into the vault wasm — a runtime
/// path-dep on a sibling contract crate causes a duplicate-`__constructor` link error.
/// Signatures must match the guardrail's exported entrypoints (success type is `()`; an
/// out-of-policy `consume` returns `Err` on-chain, which traps this non-`try` call and
/// reverts the deposit before any mint).
#[allow(dead_code)] // codegen spec for GuardrailClient; the trait itself is never called
#[contractclient(name = "GuardrailClient")]
pub trait GuardrailIface {
    fn consume(e: Env, agent: Address, vault: Address, amount: i128);
    fn release(e: Env, agent: Address, vault: Address, amount: i128);
}
