// frontend/src/chromeShim.js
// Runtime shim to allow the extension-first wallet storage code to run seamlessly
// on standard web environments (such as Vite/Cloudflare Pages) without throwing ReferenceErrors.

if (typeof globalThis.chrome === 'undefined') {
  globalThis.chrome = {}
}

if (!globalThis.chrome.storage) {
  const mockStorage = (store) => ({
    get: async (keys) => {
      if (!keys) {
        const all = {}
        for (let i = 0; i < store.length; i++) {
          const k = store.key(i)
          try {
            all[k] = JSON.parse(store.getItem(k))
          } catch {
            all[k] = store.getItem(k)
          }
        }
        return all
      }
      if (typeof keys === 'string') {
        const val = store.getItem(keys)
        try {
          return { [keys]: val ? JSON.parse(val) : undefined }
        } catch {
          return { [keys]: val }
        }
      }
      if (Array.isArray(keys)) {
        const res = {}
        for (const k of keys) {
          const val = store.getItem(k)
          try {
            res[k] = val ? JSON.parse(val) : undefined
          } catch {
            res[k] = val
          }
        }
        return res
      }
      if (typeof keys === 'object') {
        const res = {}
        for (const k in keys) {
          const val = store.getItem(k)
          try {
            res[k] = val ? JSON.parse(val) : keys[k]
          } catch {
            res[k] = val ?? keys[k]
          }
        }
        return res
      }
      return {}
    },
    set: async (obj) => {
      for (const k in obj) {
        store.setItem(k, typeof obj[k] === 'string' ? obj[k] : JSON.stringify(obj[k]))
      }
    },
    remove: async (keys) => {
      const list = Array.isArray(keys) ? keys : [keys]
      for (const k of list) {
        store.removeItem(k)
      }
    },
    clear: async () => {
      store.clear()
    }
  })

  globalThis.chrome.storage = {
    local: mockStorage(globalThis.localStorage),
    session: mockStorage(globalThis.sessionStorage)
  }
}

if (!globalThis.chrome.alarms) {
  globalThis.chrome.alarms = {
    create: () => {},
    clear: () => {},
    onAlarm: {
      addListener: () => {},
      removeListener: () => {},
      hasListener: () => false
    }
  }
}

if (!globalThis.chrome.runtime) {
  globalThis.chrome.runtime = {
    onMessage: {
      addListener: () => {},
      removeListener: () => {},
      hasListener: () => false
    }
  }
}
