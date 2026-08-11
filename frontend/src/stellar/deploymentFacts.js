// Checked-in Stellar deployment facts. Keep this page-boundary data limited to public addresses
// and source names; hashes and receipts remain in deployments/stellar-testnet.json for audit use.
import manifest from '../../../deployments/stellar-testnet.json'

export const SOROBAN_SOURCE_CRATES = Object.freeze([
  'agent_account',
  'attestation',
  'autofarm_vault',
  'blend_strategy',
  'exit_router',
  'funding_router',
  'registry',
])

const deploymentRecords = [
  {
    id: 'funding-router-v2',
    name: 'Funding Router V2',
    address: manifest.fundingRouter.addressV2,
    ownership: 'first-party',
    role: 'Single-signature scoped grant and agent factory',
  },
  {
    id: 'autofarm-vault',
    name: 'Autofarm Vault',
    address: manifest.autofarmVault.address,
    ownership: 'first-party',
    role: 'Autofarm share vault supplying the live Blend strategy',
  },
  {
    id: 'blend-strategy',
    name: 'Blend Strategy',
    address: manifest.strategy1.address,
    ownership: 'first-party',
    role: 'Autofarm strategy that reads the Blend lending position',
  },
  {
    id: 'exit-router',
    name: 'Exit Router',
    address: manifest.exitRouter.address,
    ownership: 'first-party',
    role: 'Batched owner withdrawal route for scoped agent accounts',
  },
  {
    id: 'attestation',
    name: 'Strategy Attestation',
    address: manifest.attestation,
    ownership: 'first-party',
    role: 'On-chain anchor for reviewed strategy hashes',
  },
  {
    id: 'registry',
    name: 'Agent Registry',
    address: manifest.registry,
    ownership: 'first-party',
    role: 'Mirrored authorization records for scoped agents',
  },
  {
    id: 'blend-pool',
    name: 'Blend v2 Pool',
    address: manifest.strategy1.pool,
    ownership: 'external',
    role: 'External lending pool supplied by the Blend strategy',
  },
  {
    id: 'stellar-usdc-token',
    name: 'Stellar Testnet USDC',
    address: manifest.fundingRouter.token,
    ownership: 'external',
    role: 'External Stellar Asset Contract used as the vault asset',
  },
]

export const STELLAR_STATIC_DEPLOYMENTS = Object.freeze(
  deploymentRecords.map((record) => Object.freeze(record))
)

export const FIRST_PARTY_DEPLOYMENT_COUNT = STELLAR_STATIC_DEPLOYMENTS.filter(
  ({ ownership }) => ownership === 'first-party'
).length

export const EXTERNAL_PROTOCOL_COUNT = STELLAR_STATIC_DEPLOYMENTS.filter(
  ({ ownership }) => ownership === 'external'
).length

export const STATIC_ADDRESS_COUNT = STELLAR_STATIC_DEPLOYMENTS.length
