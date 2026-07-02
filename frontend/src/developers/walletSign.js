// Wallet connect + SEP-10 challenge signing. Reuse the app's wallet plumbing if
// src/wallet.js exports a kit/sign helper; otherwise this local kit is the fallback.
import { StellarWalletsKit, WalletNetwork, allowAllModules } from '@creit.tech/stellar-wallets-kit'

let kit
function getKit() {
  if (!kit) kit = new StellarWalletsKit({ network: WalletNetwork.TESTNET, modules: allowAllModules() })
  return kit
}

export async function connectWallet() {
  const k = getKit()
  await new Promise((resolve, reject) =>
    k.openModal({
      onWalletSelected: (option) => {
        k.setWallet(option.id)
        resolve()
      },
      onClosed: () => reject(new Error('Wallet selection cancelled')),
    })
  )
  const { address } = await k.getAddress()
  return {
    address,
    signChallenge: async (xdr) => {
      const { signedTxXdr } = await k.signTransaction(xdr, {
        networkPassphrase: 'Test SDF Network ; September 2015',
      })
      return signedTxXdr
    },
  }
}
