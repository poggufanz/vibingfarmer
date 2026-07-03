// keeper/src/index.js — POC: prove stellar-sdk works under workerd (read + sign, no submit yet)
import { rpc, Keypair, TransactionBuilder, Networks, BASE_FEE, Account } from '@stellar/stellar-sdk';

export default {
  async scheduled(controller, env, ctx) {
    const server = new rpc.Server(env.SOROBAN_RPC_URL);
    const health = await server.getHealth();
    const kp = env.STELLAR_RELAYER_SECRET ? Keypair.fromSecret(env.STELLAR_RELAYER_SECRET) : Keypair.random();
    // sign a throwaway tx to prove crypto path works in workerd
    const tx = new TransactionBuilder(new Account(kp.publicKey(), '0'), { fee: BASE_FEE, networkPassphrase: env.NETWORK_PASSPHRASE }).setTimeout(30).build();
    tx.sign(kp);
    console.log('keeper POC ok', { health: health.status, signed: tx.signatures.length === 1 });
  },
};
