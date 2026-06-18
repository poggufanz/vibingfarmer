use soroban_sdk::auth::{Context, CustomAccountInterface};
use soroban_sdk::crypto::Hash;
use soroban_sdk::{contractimpl, BytesN, Env, Vec};

use crate::{AgentAccount, AgentAccountArgs, AgentAccountClient};

// Probe: confirm the CustomAccountInterface signature compiles against the pinned SDK.
// Signature/Error are placeholders for this probe ONLY; Task 2 replaces them.
#[contractimpl]
impl CustomAccountInterface for AgentAccount {
    type Signature = BytesN<64>;
    type Error = soroban_sdk::Error;

    #[allow(non_snake_case)]
    fn __check_auth(
        _env: Env,
        _signature_payload: Hash<32>,
        _signatures: BytesN<64>,
        _auth_contexts: Vec<Context>,
    ) -> Result<(), Self::Error> {
        Ok(())
    }
}
