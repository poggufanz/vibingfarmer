// RP_ID follows the serving origin (wallet/config.js defaultRpId), canonicalized to the apex:
// one Pages build serves pages.dev AND custom domains, so a baked 'localhost' default breaks
// every passkey ceremony off localhost — and a verbatim hostname default would split www vs
// apex into two credentials. Locks: custom-domain default, www → apex stripping (register on
// either host shares one passkey), localhost preserved, explicit override wins verbatim,
// extension origin stays undefined, and no-location runtimes keep 'localhost'.
import { describe, it, expect, vi, afterEach } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.resetModules()
})

async function freshConfig({ location = undefined, rpIdEnv = undefined } = {}) {
  vi.resetModules()
  if (location !== undefined) vi.stubGlobal('location', location)
  if (rpIdEnv !== undefined) vi.stubEnv('VITE_VF_RP_ID', rpIdEnv)
  return import('../config.js')
}

describe('wallet RP_ID origin default', () => {
  it("defaults to the serving custom domain (vibingfarmer.xyz), not 'localhost'", async () => {
    const mod = await freshConfig({
      location: { hostname: 'vibingfarmer.xyz', protocol: 'https:' },
    })
    expect(mod.RP_ID).toBe('vibingfarmer.xyz')
    expect(mod.makeWalletConfig().rpId).toBe('vibingfarmer.xyz')
  })

  it("strips a leading www. so www + apex share one passkey (vibingfarmer.xyz)", async () => {
    const mod = await freshConfig({
      location: { hostname: 'www.vibingfarmer.xyz', protocol: 'https:' },
    })
    expect(mod.RP_ID).toBe('vibingfarmer.xyz')
    expect(mod.makeWalletConfig().rpId).toBe('vibingfarmer.xyz')
  })

  it('strips www. on pages.dev aliases too, case-insensitively', async () => {
    const mod = await freshConfig({
      location: { hostname: 'WWW.vibing-farmer.pages.dev', protocol: 'https:' },
    })
    expect(mod.RP_ID).toBe('vibing-farmer.pages.dev')
  })

  it('leaves an explicit VITE_VF_RP_ID verbatim even with a www. prefix', async () => {
    const mod = await freshConfig({
      location: { hostname: 'vibingfarmer.xyz', protocol: 'https:' },
      rpIdEnv: 'www.vibingfarmer.xyz',
    })
    expect(mod.RP_ID).toBe('www.vibingfarmer.xyz')
  })

  it('stays undefined on a chrome-extension origin even for a www hostname', async () => {
    const mod = await freshConfig({
      location: { hostname: 'www.vibingfarmer.xyz', protocol: 'chrome-extension:' },
    })
    expect(mod.RP_ID).toBeUndefined()
    expect(mod.makeWalletConfig()).not.toHaveProperty('rpId')
  })

  it("keeps 'localhost' on a localhost origin", async () => {
    const mod = await freshConfig({
      location: { hostname: 'localhost', protocol: 'http:' },
    })
    expect(mod.RP_ID).toBe('localhost')
  })

  it('lets an explicit VITE_VF_RP_ID win over the serving origin', async () => {
    const mod = await freshConfig({
      location: { hostname: 'vibingfarmer.xyz', protocol: 'https:' },
      rpIdEnv: 'vibing-farmer.pages.dev',
    })
    expect(mod.RP_ID).toBe('vibing-farmer.pages.dev')
  })

  it('stays undefined on a chrome-extension origin regardless of env', async () => {
    const mod = await freshConfig({
      location: { hostname: 'abc123', protocol: 'chrome-extension:' },
      rpIdEnv: 'vibingfarmer.xyz',
    })
    expect(mod.RP_ID).toBeUndefined()
    expect(mod.makeWalletConfig()).not.toHaveProperty('rpId')
  })

  it("falls back to 'localhost' with no location global (Node/tests/workers)", async () => {
    const mod = await freshConfig()
    expect(mod.RP_ID).toBe('localhost')
  })
})
