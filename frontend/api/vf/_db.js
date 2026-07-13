// VF gate store. One interface, two backends:
//  - d1Store(db): Cloudflare D1 binding (prod/preview; schema in migrations/0001_vf_gate.sql)
//  - memoryStore(): Maps (vitest + vite dev, non-persistent)
// Import-only (underscore prefix — never routed).

export function memoryStore() {
  const rows = new Map() // id -> row
  const counters = new Map() // `${keyId}|${window}` -> count
  const usage = new Map() // `${keyId}|${day}|${endpoint}` -> count
  const pub = ({ key_hash: _omit, ...rest }) => rest // strip the hash from public rows
  return {
    _usage: usage,
    keys: {
      async insert(row) {
        rows.set(row.id, { ...row })
      },
      async getByHash(hash) {
        for (const r of rows.values()) if (r.key_hash === hash) return { ...r }
        return null
      },
      async list(owner) {
        return [...rows.values()].filter((r) => r.owner === owner).map(pub)
      },
      async revoke(id, owner) {
        const r = rows.get(id)
        if (!r || r.owner !== owner) return false
        r.enabled = 0
        return true
      },
      async touch(id, ts) {
        const r = rows.get(id)
        if (r) r.last_used_at = ts
      },
    },
    counters: {
      async bump(keyId, windowStart) {
        const k = `${keyId}|${windowStart}`
        const n = (counters.get(k) || 0) + 1
        counters.set(k, n)
        return n
      },
      async pruneBefore(ts) {
        for (const k of counters.keys()) if (Number(k.split('|')[1]) < ts) counters.delete(k)
      },
    },
    usage: {
      async log(keyId, day, endpoint) {
        const k = `${keyId}|${day}|${endpoint}`
        usage.set(k, (usage.get(k) || 0) + 1)
      },
      async listForOwner(owner, sinceDay) {
        const own = new Set([...rows.values()].filter((r) => r.owner === owner).map((r) => r.id))
        const out = []
        for (const [k, count] of usage) {
          const [keyId, day, ...ep] = k.split('|')
          if (!own.has(keyId) || day < sinceDay) continue
          out.push({ key_id: keyId, day, endpoint: ep.join('|'), count })
        }
        return out.sort((a, b) =>
          a.day === b.day ? (a.endpoint < b.endpoint ? -1 : 1) : a.day < b.day ? 1 : -1
        )
      },
    },
  }
}

export function d1Store(db) {
  return {
    keys: {
      async insert(r) {
        await db
          .prepare(
            `INSERT INTO api_keys (id, key_hash, key_hint, owner, scopes, rate_limit, expires_at, enabled, created_at, last_used_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)`
          )
          .bind(
            r.id,
            r.key_hash,
            r.key_hint,
            r.owner,
            r.scopes,
            r.rate_limit,
            r.expires_at,
            r.enabled,
            r.created_at,
            r.last_used_at
          )
          .run()
      },
      async getByHash(hash) {
        return (
          (await db.prepare(`SELECT * FROM api_keys WHERE key_hash = ?`).bind(hash).first()) ?? null
        )
      },
      async list(owner) {
        const { results } = await db
          .prepare(
            `SELECT id, key_hint, owner, scopes, rate_limit, expires_at, enabled, created_at, last_used_at
             FROM api_keys WHERE owner = ? ORDER BY created_at DESC`
          )
          .bind(owner)
          .all()
        return results ?? []
      },
      async revoke(id, owner) {
        const r = await db
          .prepare(`UPDATE api_keys SET enabled = 0 WHERE id = ? AND owner = ?`)
          .bind(id, owner)
          .run()
        return (r.meta?.changes ?? 0) > 0
      },
      async touch(id, ts) {
        await db.prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`).bind(ts, id).run()
      },
    },
    counters: {
      async bump(keyId, windowStart) {
        const row = await db
          .prepare(
            `INSERT INTO usage_counters (key_id, window_start, count) VALUES (?,?,1)
             ON CONFLICT(key_id, window_start) DO UPDATE SET count = count + 1
             RETURNING count`
          )
          .bind(keyId, windowStart)
          .first()
        return row?.count ?? 1
      },
      async pruneBefore(ts) {
        await db.prepare(`DELETE FROM usage_counters WHERE window_start < ?`).bind(ts).run()
      },
    },
    usage: {
      async log(keyId, day, endpoint) {
        await db
          .prepare(
            `INSERT INTO usage_log (key_id, day, endpoint, count) VALUES (?,?,?,1)
             ON CONFLICT(key_id, day, endpoint) DO UPDATE SET count = count + 1`
          )
          .bind(keyId, day, endpoint)
          .run()
      },
      async listForOwner(owner, sinceDay) {
        const { results } = await db
          .prepare(
            `SELECT u.key_id, u.day, u.endpoint, u.count
             FROM usage_log u JOIN api_keys k ON k.id = u.key_id
             WHERE k.owner = ? AND u.day >= ?
             ORDER BY u.day DESC, u.endpoint ASC`
          )
          .bind(owner, sinceDay)
          .all()
        return results ?? []
      },
    },
  }
}

let _devStore = null
export function storeFrom(req) {
  const db = req?.env?.VF_DB
  if (db) return d1Store(db)
  if (!_devStore) _devStore = memoryStore()
  return _devStore
}
