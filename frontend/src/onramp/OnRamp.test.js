import { describe, it, expect, vi, beforeEach } from 'vitest'
import { open, registerProvider, PROVIDERS } from './OnRamp.js'

beforeEach(() => {
  for (const k of Object.keys(PROVIDERS)) delete PROVIDERS[k]
})

describe('OnRamp interface', () => {
  it('rejects when address is missing', async () => {
    await expect(open({})).rejects.toThrow(/address/)
  })

  it('rejects when no provider has been registered yet', async () => {
    await expect(open({ address: 'GADDR' })).rejects.toThrow(/no provider registered/)
  })

  it('delegates to an explicitly-passed provider with the same request', async () => {
    const fakeProvider = {
      open: vi.fn(async (req) => ({ completed: true, network: 'stellar', ...req })),
    }
    const result = await open({ address: 'GADDR', amount: 25 }, fakeProvider)
    expect(fakeProvider.open).toHaveBeenCalledWith({ address: 'GADDR', amount: 25 })
    expect(result).toMatchObject({ completed: true, network: 'stellar' })
  })

  it('registerProvider makes a provider the default for subsequent open() calls', async () => {
    const fakeProvider = { open: vi.fn(async () => ({ completed: true, network: 'stellar' })) }
    registerProvider('fake', fakeProvider)
    await open({ address: 'GADDR' })
    expect(fakeProvider.open).toHaveBeenCalled()
  })

  it('the first registered provider stays default even after a second is registered', async () => {
    const first = { open: vi.fn(async () => ({ completed: true, network: 'stellar' })) }
    const second = { open: vi.fn(async () => ({ completed: true, network: 'base' })) }
    registerProvider('first', first)
    registerProvider('second', second)
    await open({ address: 'GADDR' })
    expect(first.open).toHaveBeenCalled()
    expect(second.open).not.toHaveBeenCalled()
  })
})
