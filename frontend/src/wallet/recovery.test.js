import { describe, it, expect } from 'vitest'

import { buildRecoveryRule, addRecoverySigner, rotateToNewPasskey } from './recovery.js'

describe('recovery rule scope', () => {
  it('binds the recovery signer to ONLY the account self signer-management fns', () => {
    const rule = buildRecoveryRule('CACCOUNT')
    expect(rule.allowedContract).toBe('CACCOUNT') // the account itself
    // EVIDENCE-BASED DEVIATION FROM BRIEF: the deployed OZ smart_account wasm
    // exposes `add_signer` + `remove_signer` for signer management — there is NO
    // `rotate` and NO `update_signer`. The brief's literal array was stale.
    // Verified via: stellar contract info interface --wasm
    // scripts/soroban/wasm/smart_account.wasm  (see task-14-report.md).
    expect(rule.allowedFns.sort()).toEqual(['add_signer', 'remove_signer'])
    // a vault deposit must NOT be permitted by this rule (negative invariant):
    expect(rule.allowedFns).not.toContain('deposit')
  })

  it('names the rule for signer-management-only intent', () => {
    const rule = buildRecoveryRule('CACCOUNT')
    expect(rule.name).toBe('recovery-signer-management-only')
  })
})

describe('addRecoverySigner', () => {
  it('creates the scoped rule then attaches the recovery G-address as a delegated signer', async () => {
    const calls = []
    const kit = {
      rules: {
        create: async (spec) => {
          calls.push(['rules.create', spec])
          return { contextRuleId: 7 }
        },
      },
      signers: {
        addDelegated: async (ruleId, signer) => {
          calls.push(['signers.addDelegated', ruleId, signer])
          return { ok: true, ruleId, signer }
        },
      },
    }

    const res = await addRecoverySigner({
      accountId: 'CACCOUNT',
      recoveryG: 'GRECOVERY',
      kit,
    })

    // rule.create received the signer-management-only spec
    expect(calls[0][0]).toBe('rules.create')
    expect(calls[0][1].params.allowedContract).toBe('CACCOUNT')
    expect(calls[0][1].params.allowedFns.sort()).toEqual(['add_signer', 'remove_signer'])
    // delegated signer bound to the returned rule id = recovery G-address
    expect(calls[1]).toEqual(['signers.addDelegated', 7, 'GRECOVERY'])
    expect(res).toEqual({ ok: true, ruleId: 7, signer: 'GRECOVERY' })
  })
})

describe('rotateToNewPasskey', () => {
  it('adds the new passkey then removes the old signer (rotate out)', async () => {
    const order = []
    const kit = {
      signers: {
        addPasskey: async (ruleId, appName, userName) => {
          order.push(['addPasskey', ruleId, appName, userName])
          return { credentialId: 'cred-new' }
        },
        remove: async (ruleId, signer) => {
          order.push(['remove', ruleId, signer])
          return { removed: signer }
        },
      },
    }

    const res = await rotateToNewPasskey({
      accountId: 'CACCOUNT',
      contextRuleId: 3,
      appName: 'Vibing Farmer',
      userName: 'vf-user',
      oldSigner: 'OLD_PASSKEY',
      kit,
    })

    // add-new BEFORE remove-old (never leave the account signer-less)
    expect(order[0]).toEqual(['addPasskey', 3, 'Vibing Farmer', 'vf-user'])
    expect(order[1]).toEqual(['remove', 3, 'OLD_PASSKEY'])
    expect(res).toEqual({ removed: 'OLD_PASSKEY' })
  })
})
