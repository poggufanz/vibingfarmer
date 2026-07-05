// Deploy a standalone MockERC4626(realBaseSepoliaUSDC) to Base Sepolia — the
// SP1 fallback "real pool" when no live Morpho MetaMorpho vault is
// confirmed (see Task 1.6 Step 1's decision record).
// Mirrors spikes/smart-sessions/deploy-router.mjs (proven working pattern).
// Run (PowerShell, from base-contracts/): node --env-file=.dev.vars scripts/deploy-mock-pool.mjs
import { readFileSync } from 'node:fs';
import { createWalletClient, createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

const art = JSON.parse(readFileSync(new URL('../out/MockERC4626.sol/MockERC4626.json', import.meta.url)));
const abi = art.abi;
const bytecode = art.bytecode.object;

// Circle-confirmed Base Sepolia USDC — spikes/cctp-corridor/addresses.md.
const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

const pk = process.env.BASE_DEPLOYER_PRIVKEY;
if (!pk || /FILL_ME/.test(pk)) throw new Error('BASE_DEPLOYER_PRIVKEY missing');

const rpc = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
const account = privateKeyToAccount(pk);
const pub = createPublicClient({ chain: baseSepolia, transport: http(rpc) });
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(rpc) });

const hash = await wallet.deployContract({ abi, bytecode, args: [BASE_SEPOLIA_USDC] });
console.log('deploy tx:', hash);
const rcpt = await pub.waitForTransactionReceipt({ hash });
console.log('status:', rcpt.status);
console.log('INITIAL_POOL_ADDRESS=' + rcpt.contractAddress);
