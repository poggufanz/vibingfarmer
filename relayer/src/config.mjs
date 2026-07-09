// Single place that reads process.env into the config shapes watcher.mjs/orchestrator.mjs
// expect. Fails fast (system-boundary validation) if a required var is missing/unfilled —
// same need() pattern as spikes/cctp-corridor/roundtrip.mjs. YIELD_ROUTER_ADDRESS is read from
// env, not deployments/base-sepolia.json — that file does not exist yet (SP1 has not deployed
// YieldRouter as of this writing). Swap to reading the deployment file once SP1 lands: replace
// the `need(env, 'YIELD_ROUTER_ADDRESS')` line below with a read of
// deployments/base-sepolia.json's `yieldRouter` field, env var stays as an override.

import { rpc, Keypair } from '@stellar/stellar-sdk';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { CCTP_DOMAIN, STELLAR_TESTNET, BASE_SEPOLIA, IRIS_SANDBOX_URL } from './cctp/constants.mjs';
import { createFileStore } from './store.mjs';

function need(env, key) {
  const value = env[key];
  if (!value || /FILL_ME/.test(value)) throw new Error(`env ${key} missing/unfilled`);
  return value;
}

/** Builds the full runtime config (viem clients, Soroban server, store) from process.env. */
export function loadConfig(env = process.env) {
  const sorobanRpcUrl = need(env, 'SOROBAN_RPC_URL');
  const passphrase = need(env, 'STELLAR_NETWORK_PASSPHRASE');
  const relayerStellarSecret = need(env, 'RELAYER_STELLAR_SECRET');
  const relayerStellarPublic = need(env, 'RELAYER_STELLAR_PUBLIC');
  const baseRpcUrl = env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
  const relayerBasePrivkey = need(env, 'RELAYER_BASE_PRIVKEY');
  const zerodevProjectId = need(env, 'ZERODEV_PROJECT_ID');
  const yieldRouterAddress = need(env, 'YIELD_ROUTER_ADDRESS');
  const irisUrl = env.IRIS_URL || IRIS_SANDBOX_URL;
  const storePath = env.RELAYER_STORE_PATH || './.relayer-store.dev.json';

  const server = new rpc.Server(sorobanRpcUrl);
  const kp = Keypair.fromSecret(relayerStellarSecret);

  const account = privateKeyToAccount(relayerBasePrivkey.startsWith('0x') ? relayerBasePrivkey : `0x${relayerBasePrivkey}`);
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(baseRpcUrl) });
  const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(baseRpcUrl) });
  const bundlerRpcUrl = `https://rpc.zerodev.app/api/v3/${zerodevProjectId}/chain/${baseSepolia.id}`;

  return {
    // Downstream (watcher.mjs, farm.mjs) reads domains.stellar/domains.base (lowercase);
    // CCTP_DOMAIN uses uppercase STELLAR/BASE, so map here rather than leak two key casings.
    domains: { stellar: CCTP_DOMAIN.STELLAR, base: CCTP_DOMAIN.BASE },
    irisUrl,
    store: createFileStore(storePath),
    base: {
      chain: baseSepolia,
      rpcUrl: baseRpcUrl,
      bundlerRpcUrl,
      publicClient,
      walletClient,
      messageTransmitterAddress: BASE_SEPOLIA.messageTransmitterV2,
      tokenMessengerV2Address: BASE_SEPOLIA.tokenMessengerV2,
      usdcAddress: BASE_SEPOLIA.usdc,
      yieldRouterAddress,
    },
    stellar: {
      server,
      kp,
      sourcePub: relayerStellarPublic,
      passphrase,
      forwarderAddress: STELLAR_TESTNET.cctpForwarder,
      tokenMessengerMinter: STELLAR_TESTNET.tokenMessengerMinter,
      usdcSac: STELLAR_TESTNET.usdcSac,
    },
  };
}
