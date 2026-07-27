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
export const BASE_ROUTE_LABEL = `${STELLAR_TESTNET_LABEL} → Base Sepolia`
// Truthful, fixed venue label for the one live deposit target -- mirrors approvalView.js's own
// GRANT_TRUTHS[2] wording (Autofarm Vault -> Blend Capital v2 is a single Stellar destination,
// never re-derived per call site).
export const VAULT_ROUTE_LABEL = 'Autofarm Vault → Blend Capital v2'

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
})

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
      return 'Submitted — awaiting confirmation'
    case CEREMONY_STATE.CHECKING_STATUS:
      return 'Checking status'
    case CEREMONY_STATE.CONFIRMED:
      return shares != null ? `Confirmed — minted ${shares} shares` : 'Confirmed'
    case CEREMONY_STATE.NOT_SUBMITTED:
      return detail || 'Not submitted'
    case CEREMONY_STATE.REJECTED:
      return 'Rejected'
    case CEREMONY_STATE.FAILED:
      return detail ? `Failed: ${detail}` : 'Failed'
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
  return address ? shortAddr(address) : 'unknown'
}

// ---------------------------------------------------------------------------------------------
// Section builders.
// ---------------------------------------------------------------------------------------------
function originSection() {
  return { kind: 'origin', origin: INTERNAL_ORIGIN_LABEL, internal: true }
}

function accountSection(address) {
  return { kind: 'account', accountType: 'Passkey', address: safeShortAddr(address) }
}

function networkSection() {
  return { kind: 'network', label: STELLAR_TESTNET_LABEL }
}

// The note is fixed, ceremony-wide copy (unlike approvalView.js's per-variant note) -- this
// internal tab always auto-closes itself on completion (ceremony.js's scheduleClose), so the note
// is true for every action/state this module ever renders.
const AUTO_CLOSE_NOTE = 'This tab closes automatically when done.'

function stateSection({ submissionState, detail, shares }) {
  return {
    kind: 'state',
    submissionState,
    note: AUTO_CLOSE_NOTE,
    statusText: ceremonyStatusText(submissionState, { detail, shares }),
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
function buildBaseMandateSection() {
  const mv = toBaseMandateView({
    mandate: null,
    stellarOwner: null,
    kernelAddress: null,
    relayerOrigin: null,
  })
  return {
    kind: 'base-mandate',
    route: BASE_ROUTE_LABEL,
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
  return [plain(`${toDisplay(units)} `), addr('USDC')]
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
        [
          plain('Deposit '),
          ...amountParts(amountUnits),
          plain(` into ${VAULT_ROUTE_LABEL}. Approve with Face ID to continue.`),
        ],
      ],
    }
  }
  if (action === 'approve') {
    return {
      kind: 'consequence',
      statements: [
        [
          plain('Enable deposits: approve an allowance of up to '),
          ...amountParts(amountUnits),
          plain(
            ` so ${VAULT_ROUTE_LABEL} can pull funds on your behalf. This does not move funds by itself.`
          ),
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
  const tail = ' This ceremony only signs — it never submits or moves funds itself.'
  if (!summary) {
    return {
      kind: 'consequence',
      statements: [
        [
          plain(
            'This asks you to sign a request. VF Wallet cannot state a guaranteed spending ceiling for this request — review the technical details below before continuing.'
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
 * @param {{address:string|null, amountUnits?:bigint|null, decodedSummary?:object|null,
 *   submissionState?:string, detail?:string, shares?:string|number|null}} ctx
 */
export function buildCeremonyView(request, ctx = {}) {
  const { action, params = {} } = request
  const {
    address,
    amountUnits = null,
    decodedSummary = null,
    submissionState = CEREMONY_STATE.PREPARING,
    detail,
    shares = null,
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

  const consequence = buildConsequence(action, { amountUnits, decodedSummary })
  const bridgeAgent = decodedSummary?.grant?.agents?.find((a) => a.kind === 'bridge') ?? null

  const sections = [consequence, originSection(), accountSection(address), networkSection()]
  if (bridgeAgent) sections.push(buildBaseMandateSection())
  sections.push(stateSection({ submissionState, detail, shares }))
  sections.push({ kind: 'technical', raw: technicalRaw(action, params, decodedSummary) })

  return {
    variant: 'ceremony',
    title: 'Passkey ceremony',
    submissionState,
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
  for (const statement of section.statements) box.append(h('p', { text: statement }))
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
  wrap.append(
    h('p', {
      attrs: { id: 'status', role: 'status', 'aria-live': 'polite' },
      text: section.statusText,
    })
  )
  return wrap
}

function renderTechnical(section) {
  const wrap = h('div', { attrs: { id: 'raw-wrap' } })
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
