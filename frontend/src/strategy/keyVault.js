// frontend/src/strategy/keyVault.js
// One responsibility: per-worker key material — generate, derive an at-rest
// secret from a session passphrase (KDF), seal/open, zeroize byte buffers.
// Never a master key; never persisted in clear.
//
// HONESTY: openKey returns a 0x-hex JS string for ethers signing. Strings are
// immutable — that value CANNOT be wiped. Callers minimize the exposure window
// (open -> sign -> drop reference). zeroize() only wipes Uint8Array buffers
// (the derived secret + raw key bytes), which is all we can actually clear.
import _sodium from 'libsodium-wrappers-sumo';
import { Wallet } from 'ethers';

let sodiumReady;
async function sodium() {
  if (!sodiumReady) sodiumReady = _sodium.ready.then(() => _sodium);
  return sodiumReady;
}

export async function generateWorkerKey() {
  const w = Wallet.createRandom(); // ethers v6 — no viem dep before Phase 5
  return { privateKey: w.privateKey, address: w.address };
}

/** Fresh random salt for crypto_pwhash. Persist it alongside the sealed blob. */
export async function newSalt() {
  const s = await sodium();
  return s.randombytes_buf(s.crypto_pwhash_SALTBYTES);
}

/**
 * Derive a 32-byte symmetric secret from a session passphrase + salt.
 * MODERATE limits (3 ops / 256 MB) raise brute-force cost ~4x in memory over
 * INTERACTIVE if the sealed IndexedDB blob + salt ever leak and the passphrase is
 * weak. Still browser-feasible (~0.7s on a laptop). Roadmap: move to a KMS entirely.
 */
export async function deriveSecret(passphrase, salt) {
  const s = await sodium();
  return s.crypto_pwhash(
    s.crypto_secretbox_KEYBYTES, // 32
    passphrase,
    salt,
    s.crypto_pwhash_OPSLIMIT_MODERATE,
    s.crypto_pwhash_MEMLIMIT_MODERATE,
    s.crypto_pwhash_ALG_DEFAULT,
  );
}

/** Seal a 0x-hex private key with a 32-byte symmetric secret. Returns base64 blob. */
export async function sealKey(privateKeyHex, secret32) {
  const s = await sodium();
  const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES);
  const msg = s.from_hex(privateKeyHex.slice(2));
  const cipher = s.crypto_secretbox_easy(msg, nonce, secret32);
  const out = new Uint8Array(nonce.length + cipher.length);
  out.set(nonce, 0); out.set(cipher, nonce.length);
  zeroize(msg); // wipe the raw key bytes; the hex-string arg is the caller's problem
  return s.to_base64(out);
}

export async function openKey(blobB64, secret32) {
  const s = await sodium();
  const all = s.from_base64(blobB64);
  const nonce = all.slice(0, s.crypto_secretbox_NONCEBYTES);
  const cipher = all.slice(s.crypto_secretbox_NONCEBYTES);
  const msg = s.crypto_secretbox_open_easy(cipher, nonce, secret32);
  const hex = '0x' + s.to_hex(msg);
  zeroize(msg); // wipe bytes; the returned hex string is immutable, see header note
  return hex;
}

/** Wipe a Uint8Array in place. No-op (by design) on anything that is not a buffer. */
export function zeroize(buf) {
  if (buf && typeof buf.fill === 'function') buf.fill(0);
}
