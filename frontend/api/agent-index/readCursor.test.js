import { describe, expect, it } from 'vitest'
import { Keypair } from '@stellar/stellar-sdk'
import { createOwnerReadCursorCodec } from './readCursor.js'

const NETWORK = 'stellar-testnet'
const OWNER = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(41)).publicKey()
const OTHER_OWNER = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(42)).publicKey()
const AGENT_A = 'CABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGCK3'
const NOW = 2_000_000_000
const TTL_MS = 60_000
const SECRET = 'owner-read-cursor-secret-with-32-bytes-minimum'

function fixture(overrides = {}) {
  return {
    version: 1,
    networkId: NETWORK,
    owner: OWNER,
    manifestHash: 'manifest-a',
    snapshotThroughLedger: 900,
    afterLedger: 123,
    afterAddress: AGENT_A,
    expiresAt: 2_000_060_000,
    ...overrides,
  }
}

describe('createOwnerReadCursorCodec', () => {
  it('round trips the literal canonical payload and rejects a one-byte signature tamper', async () => {
    const codec = createOwnerReadCursorCodec({ secret: SECRET, now: () => NOW, ttlMs: TTL_MS })
    const payload = fixture()
    const token = await codec.encode(payload)

    await expect(codec.decode(token, { networkId: NETWORK, owner: OWNER })).resolves.toEqual(
      payload
    )
    await expect(
      codec.decode(token, {
        networkId: NETWORK,
        owner: OWNER,
        manifestHash: payload.manifestHash,
        snapshotThroughLedger: payload.snapshotThroughLedger,
        afterLedger: payload.afterLedger,
        afterAddress: payload.afterAddress,
        expiresAt: payload.expiresAt,
      })
    ).resolves.toEqual(payload)

    const [body, signature] = token.split('.')
    const tamperedSignature = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`
    await expect(
      codec.decode(`${body}.${tamperedSignature}`, { networkId: NETWORK, owner: OWNER })
    ).rejects.toThrow(/cursor/i)
  })

  it.each([
    ['owner', { owner: OTHER_OWNER }],
    ['network', { networkId: 'stellar-mainnet' }],
    ['manifest hash', { manifestHash: 'manifest-b' }],
    ['snapshot', { snapshotThroughLedger: 901 }],
  ])('rejects a cursor used in the wrong %s scope', async (_label, changedScope) => {
    const codec = createOwnerReadCursorCodec({ secret: SECRET, now: () => NOW, ttlMs: TTL_MS })
    const token = await codec.encode(fixture())
    await expect(
      codec.decode(token, { networkId: NETWORK, owner: OWNER, ...changedScope })
    ).rejects.toThrow(/cursor/i)
  })

  it('rejects an expired token from the authenticated expiry instead of returning its payload', async () => {
    let clock = NOW
    const codec = createOwnerReadCursorCodec({ secret: SECRET, now: () => clock, ttlMs: TTL_MS })
    const token = await codec.encode(fixture())
    clock = fixture().expiresAt

    await expect(codec.decode(token, { networkId: NETWORK, owner: OWNER })).rejects.toThrow(
      /cursor/i
    )
  })

  it.each([
    ['an unknown payload key', fixture({ extra: true })],
    ['a different version', fixture({ version: 2 })],
    ['a non-integer tuple ledger', fixture({ afterLedger: 1.5 })],
    ['an invalid owner StrKey', fixture({ owner: 'not-a-strkey' })],
    ['an invalid tuple address StrKey', fixture({ afterAddress: 'not-a-strkey' })],
    ['an expiry outside the configured TTL', fixture({ expiresAt: NOW + TTL_MS + 1 })],
  ])('refuses to sign %s', async (_label, payload) => {
    const codec = createOwnerReadCursorCodec({ secret: SECRET, now: () => NOW, ttlMs: TTL_MS })
    await expect(codec.encode(payload)).rejects.toThrow(/cursor/i)
  })

  it('rejects an invalid expected owner before accepting an otherwise valid token', async () => {
    const codec = createOwnerReadCursorCodec({ secret: SECRET, now: () => NOW, ttlMs: TTL_MS })
    const token = await codec.encode(fixture())
    await expect(
      codec.decode(token, { networkId: NETWORK, owner: 'not-a-strkey' })
    ).rejects.toThrow(/cursor/i)
  })
})
