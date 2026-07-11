// relayer/scripts/check-aave-usdc.mjs — SP0 gate: does Aave v3 Base Sepolia list Circle USDC?
// Run (from relayer/): node --env-file=.dev.vars scripts/check-aave-usdc.mjs
//
// NOTE (2026-07-09): the PoolAddressesProvider in the plan (0xe20fCBd…) is NOT a contract on
// Base Sepolia — getPool() returns 0x. Resolved the real market from bgd-labs/aave-address-book
// (AaveV3BaseSepolia.sol): POOL = 0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27. That market's own
// USDC reserve underlying is a faucet token (USDC_UNDERLYING = 0xba50Cd2A…), NOT Circle USDC —
// this script proves it on-chain so the gate decision is evidence-backed.
import { createPublicClient, http, parseAbi } from 'viem';
import { baseSepolia } from 'viem/chains';

const POOL = '0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27'; // Aave v3 Base Sepolia Pool (address-book)
const CIRCLE_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'; // CCTP mint target
const AAVE_FAUCET_USDC = '0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f'; // Aave's listed USDC (faucet)

const abi = parseAbi([
  // Aave v3 getReserveData returns a struct; aTokenAddress is field index 8.
  'function getReserveData(address asset) view returns ((uint256,uint128,uint128,uint128,uint128,uint128,uint40,uint16,address,address,address,address,uint128,uint128,uint128))',
]);

const client = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org'),
});

console.log('poolAddress=', POOL);

const circle = await client.readContract({ address: POOL, abi, functionName: 'getReserveData', args: [CIRCLE_USDC] });
const circleAToken = circle[8];
console.log('circleUSDC.aTokenAddress=', circleAToken);

const faucet = await client.readContract({ address: POOL, abi, functionName: 'getReserveData', args: [AAVE_FAUCET_USDC] });
console.log('aaveFaucetUSDC.aTokenAddress=', faucet[8]);

const ok = /^0x[0-9a-fA-F]{40}$/.test(circleAToken) && circleAToken !== '0x0000000000000000000000000000000000000000';
console.log('AAVE_USDC_OK=' + ok);

// ── SP0 GATE DECISION (2026-07-09) ────────────────────────────────────────────
// AAVE_USDC_OK=false: Aave v3 Base Sepolia does NOT list Circle/CCTP USDC — its
// only USDC market uses a faucet token (0xba50Cd2A…). Web research confirmed NO
// real yield protocol on Base Sepolia accepts CCTP USDC (Morpho/Moonwell/Compound
// = Base mainnet only; Nabla = Monad testnet). So the spec's "real Aave on testnet"
// premise is infeasible.
//
// User decision: ship AaveV3Adapter4626 as a MAINNET-READY, tested artifact
// (unit tests + Base MAINNET fork test where Aave lists real USDC), but deploy
// NOTHING new on testnet. The existing 3 ERC-4626 vaults stay (honest 1:1 custody
// of real bridged USDC, no fabricated yield) and are relabeled honestly. Mainnet
// flip = deploy the adapter (env-only). Aave v3 Base MAINNET targets for that flip:
//   POOL   = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5
//   USDC   = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
//   aUSDC  = 0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB
console.log('GATE_DECISION=adapter-mainnet-ready-honest-vaults-on-testnet');
process.exit(0); // informational check; the "false" verdict is an accepted design fact

