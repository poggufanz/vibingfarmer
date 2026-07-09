# Soroban contracts (Vibing Farmer → Stellar)

Cargo workspace for the on-chain layer. Runs under WSL (cargo/stellar-cli are not on the PowerShell path).

## Build
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && stellar contract build"

## Test
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test"

## Deploy + seed (testnet)
See ../scripts/soroban/deploy-seed.sh. Network passphrase: "Test SDF Network ; September 2015".
