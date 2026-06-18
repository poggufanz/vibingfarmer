use soroban_sdk::auth::{Context, CustomAccountInterface};
use soroban_sdk::crypto::Hash;
use soroban_sdk::{contractimpl, Bytes, BytesN, Env, Vec};

use crate::types::{AccountError, DataKey};
use crate::{AgentAccount, AgentAccountArgs, AgentAccountClient};

#[contractimpl]
impl CustomAccountInterface for AgentAccount {
    type Signature = BytesN<64>; // single ed25519 signature over the payload
    type Error = AccountError;

    #[allow(non_snake_case)]
    fn __check_auth(
        env: Env,
        signature_payload: Hash<32>,
        signature: BytesN<64>,
        _auth_contexts: Vec<Context>,
    ) -> Result<(), AccountError> {
        let pubkey: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::Signer)
            .ok_or(AccountError::NotInit)?;

        // ed25519_verify panics on a bad signature; that panic is the rejection.
        // Hash<32> -> Bytes via `From<Hash<N>> for Bytes` (SDK 26).
        let payload: Bytes = signature_payload.into();
        env.crypto().ed25519_verify(&pubkey, &payload, &signature);

        Ok(()) // scope enforcement lands in Task 4
    }
}
