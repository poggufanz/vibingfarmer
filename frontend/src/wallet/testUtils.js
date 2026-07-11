// frontend/src/wallet/testUtils.js
// Minimal MV3 chrome.storage/alarms mock. Promise-based get/set/remove match MV3.
export function installChromeMock() {
  const local = {}
  const session = {}
  const wrap = (bag) => ({
    get: async (key) => (typeof key === 'string' ? { [key]: bag[key] } : { ...bag }),
    set: async (obj) => {
      Object.assign(bag, obj)
    },
    remove: async (key) => {
      delete bag[key]
    },
    setAccessLevel: async () => {},
  })
  globalThis.chrome = {
    storage: { local: wrap(local), session: wrap(session) },
    alarms: { create: () => {}, clear: () => {}, onAlarm: { addListener: () => {} } },
    runtime: { onMessage: { addListener: () => {} } },
  }
  return { local, session }
}
