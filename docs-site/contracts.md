# Deployed contracts

All contracts run on **Stellar testnet**. Verify any of them on [Stellar Expert](https://stellar.expert/explorer/testnet) at `https://stellar.expert/explorer/testnet/contract/<address>`.

| Contract | Address |
|----------|---------|
| Autofarm vault (live deposit, `vfVLT` 7-dp) | `CDWHNHIHOGBPXAK23NCU37BCXRRHCNNCEG6IPE4Q7FXBYLTJ7UYYKM77` |
| Funding router (single-signature grant) | `CCEWWRQVYKEIWTO7GTX2QVHQASC3GIQOZZTDMGTOHFQYKZIX5KJ6CYE5` |
| Registry | `CAP5E2FPDAGEQ7SR55YRY4Z56GPBSTRRZJCYN2PQ6PZQHQJKYEDVM5FB` |
| Blend USDC token (7-dp) | `CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU` |
| Blend v2 pool | `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF` |

The full manifest — including wasm hashes and deploy receipts — is in [`deployments/stellar-testnet.json`](../deployments/stellar-testnet.json). The optional Base Sepolia leg is manifested in [`deployments/base-sepolia.json`](../deployments/base-sepolia.json).

## Contract roles at a glance

The **funding router** is the single entry point you grant to; it holds no funds, has no admin path, and deploys scoped agent accounts. Each **agent account** is a disposable, deposit-only, vault-pinned, expiring signer. The **autofarm vault** takes deposits and supplies them into the **Blend v2 pool** for real testnet lending yield. The **registry** tracks deployed components, and the **attestation** contract records the hash of the approved strategy so it can be verified against the original file.

For build and test one-liners, see [`soroban/README.md`](../soroban/README.md).
