// Pure, deterministic, fail-closed eligibility gate (F8). No I/O — all facts arrive resolved.
// A fact field is { value, source: 'live'|'snapshot', asOf: epochMs }.

export const PONZI_RATIO_MAX = 1.5
export const SECURITY_MIN = 60
export const AGE_CAP_DAYS = 180
export const TVL_FLOOR = 100_000
export const TVL_CAP = 100_000_000
export const AGE_WEIGHT = 0.30
export const TVL_WEIGHT = 0.40
export const ADMIN_WEIGHT = 0.30
export const ADMIN_LEVELS = { timelock_multisig: 1.0, multisig: 0.7, timelock: 0.5, eoa: 0.0 }
export const MAX_FACT_AGE_MS = 30 * 86_400_000
export const MAX_TOKEN_AGE_MS = 15 * 60_000
export const REQUIRED_FACTS = [
  'annualizedDistributed', 'protocolRevenue', 'audit', 'ageDays', 'tvl', 'adminKey',
]

/** A fact field is present iff it has a non-null value and is not stale. */
export function factPresent(field, nowMs) {
  if (!field || field.value == null) return false
  if (typeof field.asOf !== 'number') return false
  return nowMs - field.asOf <= MAX_FACT_AGE_MS
}

export function allRequiredFactsPresent(facts, nowMs) {
  return REQUIRED_FACTS.every((k) => factPresent(facts?.[k], nowMs))
}

function pos(field) {
  const v = field?.value
  return typeof v === 'number' && v > 0 ? v : null
}

/** Test 1 — closes problem #5 (ponzi APY). Both operands must be positive verified numbers. */
export function yieldReality(facts) {
  const dist = pos(facts?.annualizedDistributed)
  const rev = pos(facts?.protocolRevenue)
  if (dist == null || rev == null) {
    return { ratio: null, verdict: 'unknown', inputs: { dist, rev } }
  }
  const ratio = dist / rev
  return { ratio, verdict: ratio < PONZI_RATIO_MAX ? 'real' : 'ponzi', inputs: { dist, rev } }
}

const clamp01 = (x) => Math.max(0, Math.min(1, x))

/** Test 2 — closes problem #4 (exploit/hack). Audit is a HARD gate; score grades the rest. */
export function securityScore(facts) {
  const auditGate = facts?.audit?.value === 'audited' ? 'pass' : 'fail'
  const ageSig = clamp01((facts?.ageDays?.value ?? 0) / AGE_CAP_DAYS)
  const tvl = facts?.tvl?.value ?? 0
  const tvlSig =
    tvl <= 0
      ? 0
      : clamp01(
          (Math.log10(tvl) - Math.log10(TVL_FLOOR)) /
            (Math.log10(TVL_CAP) - Math.log10(TVL_FLOOR))
        )
  const adminSig = ADMIN_LEVELS[facts?.adminKey?.value] ?? 0
  const score = Math.round(100 * (AGE_WEIGHT * ageSig + TVL_WEIGHT * tvlSig + ADMIN_WEIGHT * adminSig))
  return { score, auditGate, components: { age: ageSig, tvl: tvlSig, adminKey: adminSig } }
}

/** Combine the two tests into a fail-closed verdict. nowMs defaults to Date.now() in production. */
export function evaluate(input, nowMs = Date.now()) {
  const { protocol, facts, isFixture = false } = input
  const reasons = []
  const present = allRequiredFactsPresent(facts, nowMs)
  if (!present) reasons.push('missing or stale required data')
  const yr = yieldReality(facts)
  if (yr.verdict === 'ponzi') reasons.push(`yield/revenue ratio ${yr.ratio.toFixed(2)} (ponzi >= ${PONZI_RATIO_MAX})`)
  if (yr.verdict === 'unknown') reasons.push('yield/revenue unverifiable')
  const sec = securityScore(facts)
  if (sec.auditGate === 'fail') reasons.push('unaudited (audit gate)')
  if (sec.score < SECURITY_MIN) reasons.push(`security ${sec.score}/100 below ${SECURITY_MIN}`)
  const eligible =
    present && yr.verdict === 'real' && sec.auditGate === 'pass' && sec.score >= SECURITY_MIN
  return { protocol, eligible, yieldReality: yr, security: sec, reasons, isFixture, facts }
}

function hashVerdict(verdict) {
  const basis = `${verdict.protocol}|${verdict.yieldReality?.verdict}|${verdict.security?.score}|${verdict.security?.auditGate}`
  let h = 0
  for (let i = 0; i < basis.length; i++) h = (Math.imul(31, h) + basis.charCodeAt(i)) | 0
  return String(h >>> 0)
}

/** Internal fail-closed assertion token (NOT a security boundary — the on-chain scope bounds malice). */
export function mintToken(verdict, planIndex, nowMs = Date.now()) {
  if (!verdict.eligible) throw new Error('cannot mint token for ineligible verdict')
  return { protocolSlug: verdict.protocol, planIndex, eligible: true, verdictHash: hashVerdict(verdict), asOf: nowMs }
}

export function verifyToken(token, verdict, nowMs = Date.now()) {
  if (!token || token.eligible !== true) return false
  if (nowMs - token.asOf > MAX_TOKEN_AGE_MS) return false
  return token.verdictHash === hashVerdict(verdict)
}
