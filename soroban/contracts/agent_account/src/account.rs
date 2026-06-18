use soroban_sdk::auth::{Context, CustomAccountInterface};
use soroban_sdk::crypto::Hash;
use soroban_sdk::{contractimpl, BytesN, Env, Vec};

use crate::types::AccountError;
use crate::{AgentAccount, AgentAccountArgs, AgentAccountClient};

#[contractimpl]
impl CustomAccountInterface for AgentAccount {
    type Signature = BytesN<64>; // single ed25519 signature over the payload
    type Error = AccountError;

    #[allow(non_snake_case)]
    fn __check_auth(
        _env: Env,
        _signature_payload: Hash<32>,
        _signature: BytesN<64>,
        _auth_contexts: Vec<Context>,
    ) -> Result<(), AccountError> {
        Ok(()) // real enforcement lands in Task 3 + Task 4
    }
}
