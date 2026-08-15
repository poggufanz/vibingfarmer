// frontend/extension/ceremonyView.js
// VF Wallet Task 13 -- pure vanilla view-model + DOM rendering for the INTERNAL-action passkey
// ceremony (ceremony.html): deposit / approve / connect / signTransaction / signAuthEntry
// triggered from INSIDE the extension's own popup, never by a dapp (a dapp request renders
// through approve.html + approvalView.js instead -- see that file's own header for the sibling
// implementation this module mirrors).
//
// Two of approvalView.js's patterns are load-bearing and are reproduced here deliberately rather
// than imported -- approvalView.js is a Task 12, already-reviewed file outside this task's file
// list, so importing from it would widen that list; the patterns themselves are small enough
// (~15 lines) that duplicating them is cheaper and safer than a cross-task coupling:
//   1. the plain()/addr() parts model, so "mono only on identifiers, never on prose" is
//      structural, not CSS-guessed;
//   2. a fail-closed variant returned BEFORE any section is built, so no rendering path can ever
//      imply a request is safe to act on when it isn't.
//
// Consequence-first, same principle as approvalView.js: origin, active address, network, then
// WHAT this passkey touch actually authorizes -- never a claim the underlying request doesn't
// carry, and a signed-but-undelivered result (see CEREMONY_STATE.NOT_SUBMITTED) is never rendered
// with completed/confirmed language. ceremony.js owns the actual submit/reconciliation adapters
// and the snapshot revalidation that decides which state this module is asked to render; this
// module never calls chrome.*, never signs, never submits.
import { toDisplay } from '../src/stellar/format.js'
import { shortAddr } from './txSummary.js'
import { toBaseMandateView } from '../src/strategy/baseMandateView.js'

export const STELLAR_TESTNET_LABEL = 'Stellar testnet'
// This ceremony is always initiated by the extension's own popup screens, never a website --
// showing this (rather than a blank/guessed origin) is the internal-path equivalent of
// approvalView.js's Chrome-verified dapp origin: the one truthful fact about who is asking.
export const INTERNAL_ORIGIN_LABEL = 'VF Wallet (this extension)'
export const BASE_ROUTE_LABEL = `${STELLAR_TESTNET_LABEL} to Base Sepolia`
// Truthful, fixed venue label for the one live deposit target -- mirrors approvalView.js's own
// GRANT_TRUTHS[2] wording (Autofarm Vault -> Blend Capital v2 is a single Stellar destination,
// never re-derived per call site).
export const VAULT_ROUTE_LABEL = 'Autofarm Vault to Blend Capital v2'

// Every state a ceremony's result can end in (Step 3: "distinguish signed, submitted, confirmed,
// not submitted, and checking"). A signature is never called a completed deposit; a
// built-but-undelivered artifact (ceremony.js's post-signing snapshot revalidation) is
// NOT_SUBMITTED, never SIGNED or CONFIRMED -- see ceremonyStatusText below.
export const CEREMONY_STATE = Object.freeze({
  PREPARING: 'preparing',
  WAITING_PASSKEY: 'waiting-passkey',
  SIGNED: 'signed',
  SUBMITTED: 'submitted',
  CHECKING_STATUS: 'checking-status',
  CONFIRMED: 'confirmed',
  NOT_SUBMITTED: 'not-submitted',
  REJECTED: 'rejected',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
})

const GENERIC_SIGN_ACTIONS = new Set(['signTransaction', 'signAuthEntry'])

function presentText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizedStatus(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : ''
}

function parseNonNegativeBigInt(value) {
  if (typeof value === 'bigint') return value >= 0n ? value : null
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return null
    try {
      return BigInt(value)
    } catch {
      return null
    }
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null
  try {
    return BigInt(value.trim())
  } catch {
    return null
  }
}

function isGenericSignAction(action) {
  return GENERIC_SIGN_ACTIONS.has(action)
}

function resultState({ ok, action, status, hash, accountSnapshotStale, error: resultError }) {
  const statusValue = normalizedStatus(status)
  const hasHash = Boolean(presentText(hash))

  // A post-delivery account switch means the receipt is not safe to present as a result for the
  // currently selected account. Keep a real hash for investigation, but fail closed on the state
  // and share projection. A pre-submit NOT_SUBMITTED result remains explicit below.
  if (statusValue === 'NOT_SUBMITTED') return CEREMONY_STATE.NOT_SUBMITTED
  if (accountSnapshotStale) return CEREMONY_STATE.UNKNOWN
  if (ok === false) {
    if (typeof resultError === 'string' && /not submitted/i.test(resultError)) {
      return CEREMONY_STATE.NOT_SUBMITTED
    }
    if (['REJECTED', 'CANCELLED'].includes(statusValue)) return CEREMONY_STATE.REJECTED
    return CEREMONY_STATE.FAILED
  }

  // Generic signing returns a signed artifact to its caller; it never owns a submission or a
  // confirmation hash, even if a transport happens to attach status-shaped metadata.
  if (isGenericSignAction(action)) {
    if (statusValue === 'FAILED' || statusValue === 'ERROR') return CEREMONY_STATE.FAILED
    if (statusValue === 'REJECTED' || statusValue === 'CANCELLED') {
      return CEREMONY_STATE.REJECTED
    }
    return CEREMONY_STATE.SIGNED
  }

  if (statusValue === 'SUCCESS' && hasHash) return CEREMONY_STATE.CONFIRMED
  if (statusValue === 'PENDING' && hasHash) return CEREMONY_STATE.SUBMITTED
  if (['CHECKING', 'CHECKING_STATUS'].includes(statusValue)) {
    return CEREMONY_STATE.CHECKING_STATUS
  }
  if (statusValue === 'SIGNED') return CEREMONY_STATE.SIGNED
  if (statusValue === 'FAILED' || statusValue === 'ERROR') return CEREMONY_STATE.FAILED
  if (['REJECTED', 'CANCELLED'].includes(statusValue)) return CEREMONY_STATE.REJECTED
  return CEREMONY_STATE.UNKNOWN
}

function resultShares({ action, status, hash, sharesBefore, sharesAfter }, state) {
  if (action !== 'deposit' || state !== CEREMONY_STATE.CONFIRMED) return null
  if (normalizedStatus(status) !== 'SUCCESS' || !presentText(hash)) return null
  const before = parseNonNegativeBigInt(sharesBefore)
  const after = parseNonNegativeBigInt(sharesAfter)
  if (before === null || after === null || after < before) return null
  return (after - before).toString()
}

/**
 * Project an existing ceremony result into presentation-only state. This does not read a ledger,
 * revalidate a request, submit, sign, or infer a hash. A successful status without a non-empty
 * hash is deliberately UNKNOWN, and shares are only exposed for a confirmed deposit with both
 * authoritative share reads. Generic signing is SIGNED because this ceremony returns an artifact
 * to its caller rather than submitting it.
 *
 * @param {{ok?:boolean, action?:string, status?:string, hash?:string,
 *   accountSnapshotStale?:boolean, sharesBefore?:string|number|bigint,
 *   sharesAfter?:string|number|bigint, error?:string}} result
 * @returns {{state:string, statusText:string, hash:string|null, shares:string|null}}
 */
export function ceremonyResultModel(result = {}) {
  const input = result && typeof result === 'object' ? result : {}
  const state = resultState(input)
  const hash = presentText(input.hash)
  const shares = resultShares(input, state)
  let statusText

  if (input.accountSnapshotStale && state === CEREMONY_STATE.UNKNOWN) {
    statusText = 'Status unknown: the active account or request changed; verify the transaction.'
  } else if (state === CEREMONY_STATE.NOT_SUBMITTED) {
    const detail = presentText(input.error)
    statusText = detail
      ? `Nothing moved: ${detail}`
      : 'Nothing moved: the request was not submitted.'
  } else if (state === CEREMONY_STATE.SIGNED && isGenericSignAction(input.action)) {
    statusText = 'Signed and returned'
  } else if (state === CEREMONY_STATE.FAILED && presentText(input.error)) {
    statusText = `Failed: ${presentText(input.error)}`
  } else {
    statusText = ceremonyStatusText(state, { shares })
  }

  return Object.freeze({ state, statusText, hash, shares })
}

/** Formal copy for a ceremony state. `detail` overrides the default text for NOT_SUBMITTED (the
 *  actual reason nothing was delivered) and FAILED (the actual error message) without inventing a
 *  tenth state for what is really the same state with more context attached. `shares` (a decimal
 *  string/number, already computed from authoritative reads) may only be passed alongside
 *  CONFIRMED -- CHECKING_STATUS and SUBMITTED never accept it, so a pending shares-delta can never
 *  be phrased as a confirmed mint (the exact defect this task's Step 3 names). */
export function ceremonyStatusText(state, { detail, shares } = {}) {
  switch (state) {
    case CEREMONY_STATE.PREPARING:
      return 'Preparing request'
    case CEREMONY_STATE.WAITING_PASSKEY:
      return 'Waiting for Face ID'
    case CEREMONY_STATE.SIGNED:
      return 'Signed'
    case CEREMONY_STATE.SUBMITTED:
      return 'Submitted: awaiting confirmation'
    case CEREMONY_STATE.CHECKING_STATUS:
      return 'Checking status'
    case CEREMONY_STATE.CONFIRMED:
      return shares != null ? `Confirmed: minted ${shares} shares` : 'Confirmed'
    case CEREMONY_STATE.NOT_SUBMITTED:
      return detail || 'Not submitted'
    case CEREMONY_STATE.REJECTED:
      return 'Rejected'
    case CEREMONY_STATE.FAILED:
      return detail ? `Failed: ${detail}` : 'Failed'
    case CEREMONY_STATE.UNKNOWN:
      return 'Unknown'
    default:
      return 'Unknown'
  }
}

// ---------------------------------------------------------------------------------------------
// Parts model -- mirrors approvalView.js's plain()/addr()/toParts (see module doc above for why
// this is a deliberate duplication, not an import).
// ---------------------------------------------------------------------------------------------
function plain(text) {
  return { text, addr: false }
}
function addr(text) {
  return { text, addr: true }
}
function toParts(value) {
  return Array.isArray(value) ? value : [plain(String(value))]
}

/** Flattens a row/statement value (parts array or plain string) to plain text, for assertions
 *  that only care about the wording. Exported so tests never re-implement this. */
export function partsToText(value) {
  return toParts(value)
    .map((p) => p.text)
    .join('')
}

function safeShortAddr(address) {
  return address ? shortAddr(address) : 'Unknown'
}

// ---------------------------------------------------------------------------------------------
// Section builders.
// ---------------------------------------------------------------------------------------------
function originSection() {
  return { kind: 'origin', origin: INTERNAL_ORIGIN_LABEL, internal: true }
}

function accountTypeLabel(kind, address) {
  const normalized =
    kind === 'classic' || kind === 'G'
      ? 'G'
      : kind === 'passkey' || kind === 'C'
        ? 'C'
        : address?.[0]
  return normalized === 'G' ? 'Standard' : normalized === 'C' ? 'Passkey' : 'Unknown'
}

function accountSection(address, kind) {
  return {
    kind: 'account',
    accountType: accountTypeLabel(kind, address),
    address: safeShortAddr(address),
  }
}

function networkSection() {
  return { kind: 'network', label: STELLAR_TESTNET_LABEL }
}

// The note is fixed, ceremony-wide copy (unlike approvalView.js's per-variant note) -- this
// internal tab always auto-closes itself on completion (ceremony.js's scheduleClose), so the note
// is true for every action/state this module ever renders.
const AUTO_CLOSE_NOTE = 'This tab closes automatically when done.'

function stateSection({ action, submissionState, detail, shares, hash, status, resultStatusText }) {
  const authoritative =
    submissionState === CEREMONY_STATE.CONFIRMED &&
    normalizedStatus(status) === 'SUCCESS' &&
    Boolean(presentText(hash))
  const safeShares = authoritative ? shares : null
  return {
    kind: 'state',
    submissionState,
    note: AUTO_CLOSE_NOTE,
    status: status || null,
    hash: presentText(hash),
    shares: safeShares,
    authoritative,
    statusText:
      resultStatusText ||
      (action && isGenericSignAction(action) && submissionState === CEREMONY_STATE.SIGNED
        ? 'Signed and returned'
        : ceremonyStatusText(submissionState, { detail, shares: safeShares })),
  }
}

/** The one Base mandate disclosure block, sourced ENTIRELY from the canonical, already-reviewed
 *  Strategy Task 9 view (src/strategy/baseMandateView.js) -- never re-derived or restated from
 *  memory (a wrong cap on a consent surface is the worst defect class this project has). This
 *  ceremony surface never HOLDS a mandate status of its own (no kernelAddress/relayerOrigin/
 *  stellarOwner to compare -- that is Strategy's job); the four nulls below deliberately extract
 *  only toBaseMandateView's STATUS-INDEPENDENT copy fields (primaryCopy/perCallCap/durationDays),
 *  which are the exact seven-day / 10,000-USDC per-call, non-cumulative scope text, computed
 *  identically regardless of mandate status. */
function buildBaseMandateSection(destination = null) {
  const mv = toBaseMandateView({
    mandate: null,
    stellarOwner: null,
    kernelAddress: null,
    relayerOrigin: null,
  })
  // The signing network is always Stellar testnet, and the user-facing route is the stable
  // custody handoff label. The decoder's routeLabel remains source evidence for the transport
  // line; it must not replace the concise route identity with a second hand-authored route.
  const route = BASE_ROUTE_LABEL
  const sourceRoute = presentText(destination?.routeLabel)
  const knownCctp = destination?.classification === 'known-cctp-messenger'
  const transport = knownCctp || sourceRoute?.includes('Circle CCTP') ? 'Circle CCTP' : null
  const custodyDisclosure =
    destination?.venueLabel ||
    (knownCctp ? 'Base Sepolia proxy. Custody only. No protocol yield.' : null)
  return {
    kind: 'base-mandate',
    route,
    sourceRoute,
    transport,
    custodyDisclosure,
    statements: [mv.primaryCopy],
    perCallCapUsdc: mv.perCallCap.usdc,
    nonCumulative: mv.perCallCap.nonCumulative,
    durationDays: mv.durationDays,
  }
}

// Honest amount rendering: toDisplay(units) is only correct for the pinned SOROBAN_DECIMALS
// token every ceremony action here uses (submit.js's deposit/approve both operate on the one
// USDC SAC) -- there is no "unknown decimals" branch to model, unlike approvalView.js's grant
// budgets (which can carry any token). Only the unit label ('USDC') is an addr() segment.
function amountParts(units) {
  return [plain(`${units == null ? 'Unknown' : toDisplay(units)} `), addr('USDC')]
}

/** Consequence section per action -- never a claim beyond what the action actually does.
 *  deposit/approve/connect are fixed, truthful, one-line statements about VF's own known
 *  contracts; signTransaction/signAuthEntry decode whatever the caller handed ceremony.js exactly
 *  like approve.js's dapp path does (txSummary.js's summarize*), but this ceremony NEVER submits
 *  what it signs -- the statement says so explicitly, matching CEREMONY_STATE.NOT_SUBMITTED's
 *  vocabulary, so nobody reads "sign" as "send". */
function buildConsequence(action, { amountUnits, decodedSummary }) {
  if (action === 'deposit') {
    return {
      kind: 'consequence',
      statements: [
        [plain('Deposit '), ...amountParts(amountUnits), plain(` into ${VAULT_ROUTE_LABEL}.`)],
        [plain('Approve with Face ID to continue.')],
      ],
    }
  }
  if (action === 'approve') {
    return {
      kind: 'consequence',
      statements: [
        [
          plain('Approve an allowance of up to '),
          ...amountParts(amountUnits),
          plain(` for ${VAULT_ROUTE_LABEL}; allowance only; this does not move funds by itself.`),
        ],
      ],
    }
  }
  if (action === 'connect') {
    return {
      kind: 'consequence',
      statements: [
        [plain('Reconnect this wallet to VF Wallet. No funds move and no allowance changes.')],
      ],
    }
  }
  // signTransaction / signAuthEntry -- the generic, decode-whatever-was-handed-in path. Never
  // submitted by this ceremony (see ceremony.js's post-signing snapshot revalidation).
  const summary = decodedSummary
  const tail = ' This ceremony only signs; it never submits or moves funds itself.'
  if (!summary) {
    return {
      kind: 'consequence',
      statements: [
        [
          plain(
            'This asks you to sign a request. VF Wallet cannot state a guaranteed spending ceiling for this request: review the technical details below before continuing.'
          ),
          plain(tail),
        ],
      ],
    }
  }
  const what = summary.fn
    ? [
        plain(`Sign "${summary.fn}"`),
        ...(summary.contractLabel
          ? [plain(` on ${summary.contractLabel}`)]
          : summary.contract
            ? [plain(' on '), addr(safeShortAddr(summary.contract))]
            : []),
      ]
    : [plain('Sign a request')]
  return {
    kind: 'consequence',
    statements: [[...what, plain('.'), plain(tail)]],
  }
}

function technicalRaw(action, params, decodedSummary) {
  if (action === 'signTransaction') return params?.xdr ?? ''
  if (action === 'signAuthEntry') return params?.authEntry ?? ''
  const fields = { action, ...params }
  if (decodedSummary) fields.decoded = decodedSummary
  try {
    return JSON.stringify(fields, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)
  } catch {
    return String(params ?? '')
  }
}

// ---------------------------------------------------------------------------------------------
// The public model builder.
// ---------------------------------------------------------------------------------------------

/**
 * @param {{action:string, params:object}} request -- ceremony.js's own action + raw params
 *   (never anything a page/DOM could inject beyond what ceremony.js's snapshot revalidation
 *   already checked -- see that file's header).
 * @param {{address:string|null, kind?:string, amountUnits?:bigint|null, decodedSummary?:object|null,
 *   submissionState?:string, detail?:string, status?:string, hash?:string,
 *   shares?:string|number|null, ok?:boolean, accountSnapshotStale?:boolean,
 *   sharesBefore?:string|number|bigint, sharesAfter?:string|number|bigint,
 *   result?:object}} ctx
 */
export function buildCeremonyView(request, ctx = {}) {
  const { action, params = {} } = request
  const {
    address,
    kind,
    amountUnits = null,
    decodedSummary = null,
    submissionState = CEREMONY_STATE.PREPARING,
    detail,
    status,
    hash = null,
    shares = null,
    ok,
    accountSnapshotStale = false,
    sharesBefore,
    sharesAfter,
    result = null,
  } = ctx

  if (!address) {
    return {
      variant: 'no-wallet',
      title: 'No wallet yet',
      note: 'Create a wallet in VF Wallet first, then retry.',
      submissionState: CEREMONY_STATE.FAILED,
      sections: [],
    }
  }

  const resultInput =
    result ||
    (ok !== undefined || status !== undefined || hash !== null || accountSnapshotStale
      ? {
          ok,
          action,
          status,
          hash,
          accountSnapshotStale,
          sharesBefore,
          sharesAfter,
          error: detail,
        }
      : null)
  const resultModel = resultInput ? ceremonyResultModel(resultInput) : null
  const effectiveSubmissionState = resultModel?.state || submissionState
  const effectiveStatus = resultModel ? resultInput?.status : status
  const effectiveHash = resultModel ? resultModel.hash : hash
  const effectiveShares = resultModel ? resultModel.shares : shares
  const consequence = buildConsequence(action, { amountUnits, decodedSummary })
  const bridgeAgent = decodedSummary?.grant?.agents?.find((a) => a.kind === 'bridge') ?? null

  const sections = [consequence, originSection(), accountSection(address, kind), networkSection()]
  if (bridgeAgent) sections.push(buildBaseMandateSection(bridgeAgent.destination))
  sections.push(
    stateSection({
      action,
      submissionState: effectiveSubmissionState,
      detail: detail || resultInput?.error,
      shares: effectiveShares,
      hash: effectiveHash,
      status: effectiveStatus,
      resultStatusText: resultModel?.statusText,
    })
  )
  sections.push({ kind: 'technical', raw: technicalRaw(action, params, decodedSummary) })

  return {
    variant: 'ceremony',
    title: 'Passkey ceremony',
    submissionState: effectiveSubmissionState,
    sections,
  }
}

// ---------------------------------------------------------------------------------------------
// Pure vanilla DOM rendering. No framework, no JSX -- createElement calls only, mirroring
// approvalView.js's renderer shape (see module doc for why this is duplicated, not imported).
// ---------------------------------------------------------------------------------------------
function h(tag, opts = {}, children = []) {
  const node = document.createElement(tag)
  if (opts.className) node.className = opts.className
  if (opts.text != null) node.textContent = opts.text
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v)
  for (const child of children) if (child != null) node.append(child)
  return node
}

function partsFragment(parts) {
  const frag = document.createDocumentFragment()
  for (const p of toParts(parts)) {
    frag.append(
      p.addr
        ? h('span', { className: 'pc-technical', text: p.text })
        : document.createTextNode(p.text)
    )
  }
  return frag
}

function renderOrigin(section) {
  const wrap = h('div', { className: 'pc-wallet-origin' })
  wrap.append(h('p', { className: 'pc-field-help', text: 'Requested by' }))
  wrap.append(h('p', { attrs: { id: 'origin' }, text: section.origin }))
  return wrap
}

function renderAccount(section) {
  return h(
    'p',
    { className: 'pc-wallet-account-chip', attrs: { 'data-testid': 'wallet-account-chip' } },
    [
      document.createTextNode(`${section.accountType} · `),
      h('span', { className: 'pc-technical', text: section.address }),
    ]
  )
}

function renderNetwork(section) {
  return h('span', { className: 'pc-network-badge', text: section.label })
}

function renderConsequence(section) {
  const box = h('div', { className: 'pc-wallet-consequence' })
  box.append(h('h1', { attrs: { id: 'title' }, text: 'Passkey ceremony' }))
  for (const statement of section.statements) {
    box.append(h('p', {}, [partsFragment(statement)]))
  }
  return box
}

// Reuses .pc-wallet-origin's existing (bordered, un-filled) treatment rather than a second
// .pc-wallet-consequence -- this is a secondary disclosure alongside the primary consequence
// above it, never a second equally-weighted decision surface on the same screen.
//
// Fix round 1, I2: this used to hardcode the literal "not cumulative" instead of reading
// `section.nonCumulative` (computed at buildBaseMandateSection from the canonical
// toBaseMandateView) -- the model and the rendered copy could disagree without anything noticing.
// A wrong cap or a dropped "non-cumulative" on a consent surface is the worst defect class this
// project has, so the rendered sentence now reads the same field the model already carries.
function renderBaseMandate(section) {
  const box = h('div', { className: 'pc-wallet-origin' })
  box.append(h('p', { className: 'pc-field-help', text: section.route }))
  if (section.transport) {
    box.append(h('p', { className: 'pc-field-help', text: section.transport }))
  }
  for (const statement of section.statements) box.append(h('p', { text: statement }))
  if (section.custodyDisclosure) {
    box.append(h('p', { className: 'pc-field-help', text: section.custodyDisclosure }))
  }
  box.append(
    h('p', {
      className: 'pc-field-help',
      text: `Per call, up to ${section.perCallCapUsdc} USDC, ${section.nonCumulative ? 'not cumulative' : 'cumulative'} · ${section.durationDays} days`,
    })
  )
  return box
}

function renderState(section) {
  const wrap = h('div', { className: 'pc-wallet-state' })
  if (section.note)
    wrap.append(h('p', { attrs: { id: 'note' }, className: 'pc-field-help', text: section.note }))
  const safeShares = section.authoritative ? section.shares : null
  const statusText =
    section.submissionState === CEREMONY_STATE.CONFIRMED
      ? ceremonyStatusText(CEREMONY_STATE.CONFIRMED, { shares: safeShares })
      : section.statusText || ceremonyStatusText(section.submissionState)
  wrap.append(
    h('p', {
      attrs: { id: 'status', role: 'status', 'aria-live': 'polite' },
      text: statusText,
    })
  )
  return wrap
}

function renderTechnical(section) {
  const wrap = h('div', {
    className: section.raw ? 'pc-technical-wrap' : 'pc-technical-wrap pc-technical-wrap--hidden',
    attrs: { id: 'raw-wrap' },
  })
  const details = h('details', { attrs: { id: 'raw-details' } })
  details.append(h('summary', { text: 'Technical details' }))
  details.append(
    h('pre', { className: 'pc-technical', attrs: { id: 'raw' }, text: section.raw ?? '' })
  )
  wrap.append(details)
  return wrap
}

function renderSection(section) {
  switch (section.kind) {
    case 'origin':
      return renderOrigin(section)
    case 'account':
      return renderAccount(section)
    case 'network':
      return renderNetwork(section)
    case 'consequence':
      return renderConsequence(section)
    case 'base-mandate':
      return renderBaseMandate(section)
    case 'state':
      return renderState(section)
    case 'technical':
      return renderTechnical(section)
    default:
      return document.createDocumentFragment()
  }
}

/** Renders `view` (buildCeremonyView's output) into `root`, in the exact section order the view
 *  carries. `no-wallet` renders a minimal title+note (no requestable sections exist for it) and
 *  is returned BEFORE any section is built above -- no code path here can render a ceremony's
 *  sections for a request buildCeremonyView already refused to model. */
export function renderCeremonyView(root, view) {
  root.innerHTML = ''
  if (view.variant === 'no-wallet') {
    root.append(h('h1', { attrs: { id: 'title' }, text: view.title }))
    root.append(h('p', { attrs: { id: 'note' }, className: 'pc-field-help', text: view.note }))
    return
  }
  for (const section of view.sections) root.append(renderSection(section))
}
