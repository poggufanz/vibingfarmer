// ZERODEV_PASSKEY_RP_ID follows the serving origin (base/config.js defaultZeroDevRpId),
// canonicalized to the apex — the same pattern as wallet/config.js. One Pages build serves
// pages.dev AND custom domains, so the old baked 'vibing-farmer.pages.dev' default broke every
// Base passkey ceremony on xyz with no env override set — and a verbatim hostname default
// would split www vs apex into two credentials. Locks: custom-domain default, www → apex
// stripping, localhost preserved, explicit VITE_ZERODEV_PASSKEY_RP_ID wins verbatim,
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
  if (rpIdEnv !== undefined) vi.stubEnv('VITE_ZERODEV_PASSKEY_RP_ID', rpIdEnv)
  return import('../config.js')
}

describe('base ZeroDev RP_ID origin default', () => {
  it("defaults to the serving custom domain (vibingfarmer.xyz), not 'vibing-farmer.pages.dev'", async () => {
    const mod = await freshConfig({
      location: { hostname: 'vibingfarmer.xyz', protocol: 'https:' },
    })
    expect(mod.ZERODEV_PASSKEY_RP_ID).toBe('vibingfarmer.xyz')
  })

  it('strips a leading www. so www + apex share one passkey (vibingfarmer.xyz)', async () => {
    const mod = await freshConfig({
      location: { hostname: 'www.vibingfarmer.xyz', protocol: 'https:' },
    })
    expect(mod.ZERODEV_PASSKEY_RP_ID).toBe('vibingfarmer.xyz')
  })

  it('strips www. on pages.dev aliases too, case-insensitively', async () => {
    const mod = await freshConfig({
      location: { hostname: 'WWW.vibing-farmer.pages.dev', protocol: 'https:' },
    })
    expect(mod.ZERODEV_PASSKEY_RP_ID).toBe('vibing-farmer.pages.dev')
  })

  it("keeps 'localhost' on a localhost origin", async () => {
    const mod = await freshConfig({
      location: { hostname: 'localhost', protocol: 'http:' },
    })
    expect(mod.ZERODEV_PASSKEY_RP_ID).toBe('localhost')
  })

  it('lets an explicit VITE_ZERODEV_PASSKEY_RP_ID win verbatim over the serving origin', async () => {
    const mod = await freshConfig({
      location: { hostname: 'vibingfarmer.xyz', protocol: 'https:' },
      rpIdEnv: 'vibing-farmer.pages.dev',
    })
    expect(mod.ZERODEV_PASSKEY_RP_ID).toBe('vibing-farmer.pages.dev')
  })

  it('leaves an explicit env with a www. prefix verbatim', async () => {
    const mod = await freshConfig({
      location: { hostname: 'vibingfarmer.xyz', protocol: 'https:' },
      rpIdEnv: 'www.vibingfarmer.xyz',
    })
    expect(mod.ZERODEV_PASSKEY_RP_ID).toBe('www.vibingfarmer.xyz')
  })

  it("maps an explicit 'origin' env to undefined (ceremony defaults to the caller origin)", async () => {
    const mod = await freshConfig({
      location: { hostname: 'vibingfarmer.xyz', protocol: 'https:' },
      rpIdEnv: 'origin',
    })
    expect(mod.ZERODEV_PASSKEY_RP_ID).toBeUndefined()
  })

  it('stays undefined on a chrome-extension origin regardless of env', async () => {
    const mod = await freshConfig({
      location: { hostname: 'abc123', protocol: 'chrome-extension:' },
      rpIdEnv: 'vibingfarmer.xyz',
    })
    expect(mod.ZERODEV_PASSKEY_RP_ID).toBeUndefined()
  })

  it("falls back to 'localhost' with no location global (Node/tests/workers)", async () => {
    const mod = await freshConfig()
    expect(mod.ZERODEV_PASSKEY_RP_ID).toBe('localhost')
  })
})
