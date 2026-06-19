# RWA KYC seam (ADR-B1: zkPass off-chain → on-chain claim)

Three distinct layers (spec ADR-B "Composition" — do not conflate):

1. **zkPass (off-chain, "who qualifies")** — user runs TransGate, proves a private
   KYC claim locally (VOLE-ZK + SNARK). Raw ID never leaves the device. The
   backend verifies the zkPass proof.
2. **Claim issuer (on-chain attestation)** — the backend holds the trusted
   claim-issuer key (an Ed25519 key authorized via `claim_issuer.allow_key`, and
   the issuer contract is registered in `claim_topics_and_issuers` as a trusted
   issuer for topic 1 = KYC). On a valid zkPass proof, the backend signs a
   topic-1 claim (Ed25519, scheme 101) and writes it into the investor's
   `identity` contract via `add_claim`.
3. **Token holder gate** — `rwa_token` calls `identity_verifier.verify_identity`
   on every mint/transfer, which validates the claim against CTI + IRS:
   the wallet must be in the IRS and hold a valid topic-1 claim from an issuer
   that is currently trusted in CTI.

## On-chain trust anchor (proven in 1b)

The CTI trusted-issuer registry is the trust anchor. `seam_test.rs` proves it
two ways:
- An issuer must be trusted in CTI for a topic before it can even register
  signing keys (`allow_key` reverts with `#371` otherwise).
- A claim whose issuer is **not** in CTI's trusted set for the topic does not
  verify the holder (revoking trust mid-flight makes a previously-valid claim
  stop verifying → mint traps).

The claim message bound by the Ed25519 signature is
`0x01 || network_id || claim_issuer.to_xdr || identity.to_xdr || topic(u32 BE) ||
nonce(u32 BE) || claim_data`, where `claim_data = created_at(u64 BE) ||
valid_until(u64 BE)`. The integration test signs this exactly (mirroring the
audited `build_claim_message` and the `sign-claim` tool).

## Trust anchor + mitigation

The backend's honest verification of the zkPass proof is the trust anchor
(spec §9). Mitigations:
(a) append-only audit log of every claim issuance (zkPass proof hash + wallet +
topic + timestamp);
(b) optionally anchor the proof hash on-chain.
The trust-minimized upgrade is ADR-B2 (own Groth16 verifier on Soroban via
BLS12-381) — tracked as optional sub-project 5, NOT built here.

## Consumed by

- Sub-project 3 (frontend): integrates the TransGate flow + calls the backend.
- Sub-project 4 (orchestrator): assumes holders are pre-KYC'd before agent deposits.
