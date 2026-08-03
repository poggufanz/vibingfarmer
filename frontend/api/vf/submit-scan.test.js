import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest'
import { Keypair } from '@stellar/stellar-sdk'
import vfRouter, { routes } from './_router.js'
import { handleSubmit } from './submit.js'
import { storeFrom } from './_db.js'
import { issueKey } from './_keystore.js'
import { _clearSeen, feeBumpAndSubmit } from '../stellar-relay.js'
import { RelaySubmissionUnknownError } from '../../src/stellar/relay.js'
import { makeVfClient } from '../../src/vfapi/httpClient.js'

const VAULT = 'CBZNITAPHCLSPEXC3UKIERYRUJR56GISM2G2Z5XD6KZH3U4ZZ76XNQOU'
const PASS = 'Test SDF Network ; September 2015'
const SECRET = 'SABCD'
const RELAYER = 'GBVJ34MT4GDKZJGILI6DRYGD75ZNUBJGGZIDUV7IPFNVVDWGE5GBLV3X'
const LIVE_SUBMIT_ROUTE = routes['POST /submit']

function invokeOp(contract) {
  return {
    type: 'invokeHostFunction',
    func: {
      switch: () => ({ name: 'hostFunctionTypeInvokeContract' }),
      invokeContract: () => ({
        contractAddress: () => ({ __sc: contract }),
        functionName: () => 'deposit',
        args: () => [],
      }),
    },
  }
}

class FakeFeeBump {}
function producerFixture({ innerHash, getStatus = 'SUCCESS', holdPoll = false } = {}) {
  let releasePoll
  const inner = {
    fee: '100000',
    source: RELAYER,
    operations: [invokeOp(VAULT)],
    hash: () => Buffer.from(innerHash, 'hex'),
    sign: vi.fn(),
  }
  const sdk = {
    TransactionBuilder: {
      fromXDR: vi.fn(() => inner),
      buildFeeBumpTransaction: vi.fn(() => ({ sign: vi.fn() })),
    },
    FeeBumpTransaction: FakeFeeBump,
    Keypair: { fromSecret: () => ({ publicKey: () => RELAYER }) },
    Address: { fromScAddress: (address) => ({ toString: () => address.__sc }) },
    scValToNative: (value) => value,
    rpc: { Api: { isSimulationSuccess: (value) => Boolean(value?.transactionData) } },
  }
  const rpcServer = {
    simulateTransaction: vi.fn(async () => ({ transactionData: {}, result: { retval: {} } })),
    sendTransaction: vi.fn(async () => ({ status: 'PENDING', hash: 'OUTERHASH' })),
    getTransaction: vi.fn(async () => {
      if (holdPoll) {
        return new Promise((resolve) => {
          releasePoll = resolve
        })
      }
      if (getStatus instanceof Error) throw getStatus
      return { status: getStatus }
    }),
  }
  return {
    rpcServer,
    release: (status = 'SUCCESS') => releasePoll?.({ status }),
    relay: ({ xdr, secret }) =>
      feeBumpAndSubmit({
        xdr,
        secret,
        passphrase: PASS,
        vaultAddr: VAULT,
        sdk,
        rpcServer,
        pollTries: 1,
        pollIntervalMs: 0,
      }),
  }
}

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) {
      this.headers[k] = v
    },
    end(s) {
      this.body = s ?? ''
      return this
    },
  }
}
const mk = (method, url, body, key) => ({
  method,
  url,
  body,
  headers: { 'x-real-ip': '5.5.5.5', ...(key ? { authorization: `Bearer ${key}` } : {}) },
})

let submitKey, scanKey
beforeEach(async () => {
  process.env.STELLAR_RELAYER_SECRET = ''
  process.env.SOROBAN_VAULT_ADDRESS = VAULT
  const s = storeFrom({})
  submitKey = (
    await issueKey(s, {
      owner: 'GS',
      scopes: ['submit'],
      rateLimit: 50,
      env: 'test',
      expiresAt: null,
    })
  ).key
  scanKey = (
    await issueKey(s, {
      owner: 'GS',
      scopes: ['scan'],
      rateLimit: 50,
      env: 'test',
      expiresAt: null,
    })
  ).key
})

afterEach(() => {
  routes['POST /submit'] = LIVE_SUBMIT_ROUTE
  process.env.STELLAR_RELAYER_SECRET = ''
  vi.unstubAllGlobals()
  _clearSeen()
})

function installSubmitRoute(relay) {
  routes['POST /submit'] = (req, res) => handleSubmit(req, res, { relay })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, options = {}) => {
      const request = mk(
        options.method || 'GET',
        String(url),
        options.body ? JSON.parse(options.body) : undefined,
        submitKey
      )
      request.headers.authorization = options.headers.Authorization
      const response = mockRes()
      await vfRouter(request, response)
      return new Response(response.body, {
        status: response.statusCode,
        headers: response.headers,
      })
    })
  )
  return makeVfClient({ apiKey: submitKey })
}

describe('/submit', () => {
  it('503 configured:false without relayer secret', async () => {
    const res = mockRes()
    await vfRouter(mk('POST', '/submit', { xdr: 'AAA' }, submitKey), res)
    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body)).toMatchObject({ configured: false })
  })
  it('401 without key', async () => {
    const res = mockRes()
    await vfRouter(mk('POST', '/submit', { xdr: 'AAA' }), res)
    expect(res.statusCode).toBe(401)
  })

  it('takes a real fee-bump SUCCESS through the routed VF handler and VF HTTP client', async () => {
    process.env.STELLAR_RELAYER_SECRET = SECRET
    const producer = producerFixture({ innerHash: '41', getStatus: 'SUCCESS' })
    const client = installSubmitRoute(producer.relay)

    await expect(client.submit('SIGNED_XDR')).resolves.toEqual({
      hash: 'OUTERHASH',
      status: 'SUCCESS',
      relayer: RELAYER,
    })
    expect(producer.rpcServer.sendTransaction).toHaveBeenCalledOnce()
  })

  it.each(['SUCCESS', 'FAILED'])(
    'keeps a real cached %s terminal and its duplicate evidence ordinary',
    async (status) => {
      process.env.STELLAR_RELAYER_SECRET = SECRET
      const producer = producerFixture({
        innerHash: status === 'SUCCESS' ? '42' : '46',
        getStatus: status,
      })
      const client = installSubmitRoute(producer.relay)

      await expect(client.submit('SIGNED_XDR')).resolves.toMatchObject({
        hash: 'OUTERHASH',
        status,
      })
      await expect(client.submit('SIGNED_XDR')).resolves.toMatchObject({
        hash: 'OUTERHASH',
        status,
        duplicate: true,
      })
      expect(producer.rpcServer.sendTransaction).toHaveBeenCalledOnce()
    }
  )

  it('types a real original and cached PENDING result as unknown with hash evidence', async () => {
    process.env.STELLAR_RELAYER_SECRET = SECRET
    const producer = producerFixture({ innerHash: '43', getStatus: 'NOT_FOUND' })
    const client = installSubmitRoute(producer.relay)

    for (const duplicate of [undefined, true]) {
      let error
      try {
        await client.submit('SIGNED_XDR')
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(RelaySubmissionUnknownError)
      expect(error).toMatchObject({
        code: 'VF_SUBMISSION_UNKNOWN',
        submission: 'unknown',
        httpStatus: 502,
        result: {
          hash: 'OUTERHASH',
          status: 'PENDING',
          relayer: RELAYER,
          ...(duplicate === undefined ? {} : { duplicate }),
        },
      })
    }
    expect(producer.rpcServer.sendTransaction).toHaveBeenCalledOnce()
  })

  it('types a real in-flight duplicate as HTTP 409 unknown without a second send', async () => {
    process.env.STELLAR_RELAYER_SECRET = SECRET
    const producer = producerFixture({ innerHash: '44', holdPoll: true })
    const client = installSubmitRoute(producer.relay)
    const first = client.submit('SIGNED_XDR')
    await vi.waitFor(() => expect(producer.rpcServer.getTransaction).toHaveBeenCalledOnce())

    await expect(client.submit('SIGNED_XDR')).rejects.toMatchObject({
      code: 'VF_SUBMISSION_UNKNOWN',
      httpStatus: 409,
      result: { hash: 'OUTERHASH', status: 'PENDING', relayer: RELAYER },
    })
    expect(producer.rpcServer.sendTransaction).toHaveBeenCalledOnce()

    producer.release()
    await expect(first).resolves.toMatchObject({ hash: 'OUTERHASH', status: 'SUCCESS' })
  })

  it('preserves a real post-send poll failure as HTTP 502 typed unknown with its hash', async () => {
    process.env.STELLAR_RELAYER_SECRET = SECRET
    const producer = producerFixture({ innerHash: '45', getStatus: new Error('poll unavailable') })
    const client = installSubmitRoute(producer.relay)

    await expect(client.submit('SIGNED_XDR')).rejects.toMatchObject({
      code: 'VF_SUBMISSION_UNKNOWN',
      submission: 'unknown',
      httpStatus: 502,
      result: { hash: 'OUTERHASH', status: 'PENDING', relayer: RELAYER },
    })
    expect(producer.rpcServer.sendTransaction).toHaveBeenCalledOnce()
  })

  it('types a malformed resolved relay result as unknown instead of terminal success', async () => {
    process.env.STELLAR_RELAYER_SECRET = SECRET
    const client = installSubmitRoute(async () => ({ status: 'SUCCESS', relayer: RELAYER }))

    await expect(client.submit('SIGNED_XDR')).rejects.toMatchObject({
      code: 'VF_SUBMISSION_UNKNOWN',
      httpStatus: 502,
      result: { status: 'SUCCESS', relayer: RELAYER },
    })
  })
})

describe('/scan', () => {
  it('classifies targets and flags the known vault', async () => {
    let res = mockRes()
    await vfRouter(mk('POST', '/scan', { target: VAULT }, scanKey), res)
    let out = JSON.parse(res.body)
    expect(out).toMatchObject({ kind: 'contract', isKnownVault: true })
    expect(out.eligibility).toBeDefined()

    res = mockRes()
    await vfRouter(mk('POST', '/scan', { target: Keypair.random().publicKey() }, scanKey), res)
    out = JSON.parse(res.body)
    expect(out).toMatchObject({ kind: 'account', isKnownVault: false })

    res = mockRes()
    await vfRouter(mk('POST', '/scan', { target: 'garbage' }, scanKey), res)
    expect(JSON.parse(res.body).kind).toBe('invalid')
  })
})
