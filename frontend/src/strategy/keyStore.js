// frontend/src/strategy/keyStore.js
// Explicit at-rest storage for sealed worker-key blobs, keyed by agent address.
// Browser: IndexedDB. Node/test: in-memory. The sealed blob and its salt live
// here; the derived secret NEVER does (it is re-derived from the session
// passphrase on demand, so an attacker reading this store cannot decrypt).
function memoryAdapter() {
  const m = new Map();
  return {
    get: async (k) => m.get(k),
    set: async (k, v) => { m.set(k, v); },
    del: async (k) => { m.delete(k); },
  };
}

function idbAdapter(dbName = 'vibing-farmer', storeName = 'sealed-keys') {
  const open = () => new Promise((res, rej) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(storeName);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(storeName, mode);
      const os = t.objectStore(storeName);
      const r = fn(os);
      t.oncomplete = () => res(r && r.result);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    get: (k) => tx('readonly', (os) => os.get(k)),
    set: (k, v) => tx('readwrite', (os) => os.put(v, k)),
    del: (k) => tx('readwrite', (os) => os.delete(k)),
  };
}

export function createKeyStore(adapter) {
  const store = adapter
    ?? (typeof indexedDB !== 'undefined' ? idbAdapter() : memoryAdapter());
  return {
    put: (address, blob) => store.set(`key:${address}`, blob),
    get: (address) => store.get(`key:${address}`),
    del: (address) => store.del(`key:${address}`),
  };
}
