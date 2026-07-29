// frontend/extension/approvalView.js
// VF Wallet Task 12 -- pure vanilla view-model + DOM rendering for the connect/sign consent
// screen (approve.html). This is the security-critical surface of the whole wallet: it is where
// the user decides what a site may do with their money. No new React entry or mount boundary --
// approve.js imports this module and stays a plain DOM script, per the task brief.
//
// Two hard rules drive every function below:
//   1. The requesting origin rendered here MUST be the one Chrome verified (approve.js's real
//      wiring always sources it from the stashed request snapshot's `requester.origin`, which
//      background.js populated from the extension messaging API's own `sender.origin` -- content
//      scripts cannot spoof that field, see consentStore.js's own doc). If it is ever missing,
//      this module refuses to render a connect/sign screen at all (`variant: 'blocked-origin'`)
//      rather than render a blank or guessed origin.
//   2. Never claim a capability, scope, or amount the request does not actually carry, never
//      round/prettify a ceiling into something friendlier than what it authorizes, and never
//      coerce a missing/unparseable value into zero or an empty string -- render it as "unknown"
//      instead. FundingGrantSummaryV1's fail-closed schema-mismatch degrade (VFW3) is preserved
//      exactly: an unrecognized grant shape falls back to raw facts, never a guessed label.
import { SOROBAN_DECIMALS } from '../src/stellar/config.js'
import { toDisplay } from '../src/stellar/format.js'
import { shortAddr } from './txSummary.js'

// ---------------------------------------------------------------------------------------------
// Copy constants (verbatim strings, per the task brief).
// ---------------------------------------------------------------------------------------------

// Human-readable network copy, deliberately distinct from STELLAR_NETWORK_LABEL (the SDK's
// 'TESTNET'/'PUBLIC' constant, still shown as a technical fact where useful) -- this is the same
// plain-English badge text WalletShell.jsx's header already uses everywhere else in the wallet.
export const STELLAR_TESTNET_LABEL = 'Stellar testnet'

// A `getAddress` connect request always grants exactly these two capabilities together --
// consentStore.js's grantConsent() hardcodes `capabilities: ['readAddress', 'requestSignatures']`
// for every connect approval, there is no partial-capability connect anywhere in this codebase --
// so listing both, always, in this fixed order is a truthful statement of what WILL be granted,
// never an inflated claim.
export const CONNECT_CAPABILITIES = [
  { id: 'readAddress', label: 'See this address' },
  { id: 'requestSignatures', label: 'Ask for signatures' },
]

// ---------------------------------------------------------------------------------------------
// Submission state machine (Step 4). Every state a request could ever be in gets a distinct,
// named label -- a signature is never called a completed deposit/grant, and a generic dapp
// signTransaction/signAuthEntry ceremony ends at SIGNED_RETURNED because this extension does not
// submit it anywhere; only an internal flow that owns real submission + a transaction hash +
// reconciliation may ever reach SUBMITTED/CONFIRMED/CHECKING_STATUS/NOT_SUBMITTED. No such flow
// exists in approve.js today (see its own header) -- these four states are modeled for that
// future caller and are asserted, by DAPP_REACHABLE_STATES below, to be UNREACHABLE from the
// generic dapp path.
export const SUBMISSION_STATE = Object.freeze({
  REVIEWING: 'reviewing',
  WAITING_PASSWORD: 'waiting-password',
  WAITING_PASSKEY: 'waiting-passkey',
  SIGNED_RETURNED: 'signed-returned',
  SUBMITTED: 'submitted',
  CONFIRMED: 'confirmed',
  NOT_SUBMITTED: 'not-submitted',
  CHECKING_STATUS: 'checking-status',
  REJECTED: 'rejected',
  FAILED: 'failed',
})

// The only states the generic dapp signTransaction/signAuthEntry ceremony (approve.js's real
// wiring, today's only caller) may ever put on screen -- see the module doc above.
export const DAPP_REACHABLE_STATES = Object.freeze([
  SUBMISSION_STATE.REVIEWING,
  SUBMISSION_STATE.WAITING_PASSWORD,
  SUBMISSION_STATE.WAITING_PASSKEY,
  SUBMISSION_STATE.SIGNED_RETURNED,
  SUBMISSION_STATE.REJECTED,
  SUBMISSION_STATE.FAILED,
])

/** Formal copy for a submission state. `detail` overrides the default text for WAITING_PASSWORD
 *  (e.g. "Wrong password.") and FAILED (the actual error message) without inventing a tenth
 *  state for what is really the same state with more context attached. */
export function submissionStatusText(state, { origin, detail } = {}) {
  switch (state) {
    case SUBMISSION_STATE.REVIEWING:
      return 'Reviewing'
    case SUBMISSION_STATE.WAITING_PASSWORD:
      return detail || 'Waiting for password'
    case SUBMISSION_STATE.WAITING_PASSKEY:
      return 'Waiting for passkey'
    case SUBMISSION_STATE.SIGNED_RETURNED:
      return `Signed and returned to ${origin || 'the site'}`
    case SUBMISSION_STATE.SUBMITTED:
      return 'Submitted'
    case SUBMISSION_STATE.CONFIRMED:
      return 'Confirmed'
    case SUBMISSION_STATE.NOT_SUBMITTED:
      return 'Not submitted'
    case SUBMISSION_STATE.CHECKING_STATUS:
      return 'Checking status'
    case SUBMISSION_STATE.REJECTED:
      return 'Rejected'
    case SUBMISSION_STATE.FAILED:
      return detail ? `Failed: ${detail}` : 'Failed'
    default:
      return 'Unknown'
  }
}

// ---------------------------------------------------------------------------------------------
// Grant truth copy (Task 3's FundingGrantSummaryV1 breakdown). GRANT_TRUTHS[0] is promoted to the
// consequence section (ranked first, per the brief); the rest explain the decoded breakdown and
// stay with it. GRANT_BRIDGE_TRUTH is no longer a general preamble bullet -- Step 2 requires a
// bridge agent's Base-side proxy explanation to nest under THAT agent, not float in a shared list
// a reader could miss if they skim past it before reaching the bridge row.
// ---------------------------------------------------------------------------------------------
const GRANT_TRUTHS = [
  'This grant creates isolated agent accounts and permissions; it does NOT mean any deposit has completed.',
  'Each agent has its own spending limit, expiry, and session signer.',
  'Current Stellar deposit agents all share the same destination: Autofarm Vault → Blend Capital v2.',
  'That shared destination is operational isolation (separate agents/keys), not multiple different Stellar protocols.',
]
const GRANT_MIXED_TOKEN_TRUTH =
  'This grant covers more than one token: each token’s allowance budget and each agent’s cap ceiling are shown separately below. Later execution may use less than either ceiling; the two numbers are never the same thing and are never added together.'
const GRANT_BRIDGE_TRUTH =
  'Base-side proxy: the bridge route is Stellar testnet → Circle CCTP → Base Sepolia. Base-side pools are custody proxies holding real Circle USDC; there is no live protocol yield there.'

// ---------------------------------------------------------------------------------------------
// Row values are built as arrays of PARTS, never a bare string -- rejection-checklist item 5
// ("Body or friendly copy uses monospace") failed twice earlier in this leg, and this surface is
// the densest mix of prose and genuine technical data in the whole wallet (a decoded agent row
// alone combines a kind word, an amount+token, a period, and a venue/destination label). Mono
// belongs on addresses/hashes and nowhere else -- so instead of relying on a blanket
// `.pc-approval-table td` font-family rule (which would force an entire mixed sentence into
// JetBrains Mono the moment ANY part of it is technical), each row's value is a sequence of
// `plain(text)` / `addr(text)` segments; only `addr()` segments render inside a `.pc-technical`
// span (see rowEl/partsFragment below). A bare string is still accepted as a convenience and
// auto-wrapped as a single plain segment.
function plain(text) {
  return { text, addr: false }
}
function addr(text) {
  return { text, addr: true }
}
function toParts(value) {
  return Array.isArray(value) ? value : [plain(String(value))]
}

/** Flattens a row value (parts array or plain string) to plain text for assertions/tests that
 *  only care about the wording, not which segments are mono. Exported so tests never need to
 *  re-implement this. */
export function partsToText(value) {
  return toParts(value)
    .map((p) => p.text)
    .join('')
}

// Honest amount rendering: toDisplay(units) (fixed /1e7) is only truthful for the pinned 7dp
// token. A v2 grant may carry any token address, and grantDecoder.js sets decimals:null (never a
// fabricated 7) for anything else; this must render the raw integer, never divide by an assumed
// scale (see grantDecoder.js's tokenAmount doc). Only the token address itself is an `addr()`
// segment -- the number and the "(not a deposit amount)" annotation are plain.
function amountParts({ units, token, decimals }, suffix) {
  const tail = suffix ? ` (${suffix})` : ''
  if (decimals === SOROBAN_DECIMALS) {
    return [plain(`${toDisplay(units)} `), addr(shortAddr(token)), plain(tail)]
  }
  const unknownTail = suffix ? ` (token decimals unknown; ${suffix})` : ' (token decimals unknown)'
  return [plain(`${units} raw units `), addr(shortAddr(token)), plain(unknownTail)]
}

// shortAddr('') / shortAddr(null) returns '' -- a blank cell reads as "nothing to see here", the
// exact coerced-empty-string failure this task is written against. A target address can
// genuinely be absent (grantDecoder.js's classifyDestination sets `targetAddress: target ?? null`
// for its 'unknown' classification) -- render that as the word "unknown", never a blank.
function safeShortAddr(address) {
  return address ? shortAddr(address) : 'unknown'
}

function periodText(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return 'unknown'
  if (seconds > 0 && seconds % 86400 === 0) return `every ${seconds / 86400}d`
  if (seconds > 0 && seconds % 3600 === 0) return `every ${seconds / 3600}h`
  return `every ${seconds}s`
}

function accountTypeLabel(kind) {
  return kind === 'classic' ? 'Standard' : kind === 'passkey' ? 'Passkey' : 'unknown'
}

// ---------------------------------------------------------------------------------------------
// Section builders. Each returns a plain `{ kind, ...data }` object -- no DOM here, so these are
// trivially unit-testable and the ordering itself (the array literal in buildApprovalView below)
// is the one place that encodes the brief's required order.
// ---------------------------------------------------------------------------------------------
function originSection(origin) {
  return { kind: 'origin', origin, verified: true }
}

function requestsSection(title) {
  return { kind: 'requests', title, capabilities: CONNECT_CAPABILITIES }
}

// Shortened, never the raw 56-59 char strkey -- Part A1's own sweep exists precisely because an
// untruncated address with no word-break rule forces the shell's implicit grid column past the
// fixed 320/360px box (see WalletShell.jsx's own documented history of this exact bug class).
// The brief's ordering item 3 explicitly allows "full/short address" -- short is the safe choice.
function accountSection(kind, address) {
  return { kind: 'account', accountType: accountTypeLabel(kind), address: safeShortAddr(address) }
}

function networkSection() {
  return { kind: 'network', label: STELLAR_TESTNET_LABEL }
}

function stateSection({ submissionState, note, needsPassword, origin, detail }) {
  return {
    kind: 'state',
    submissionState,
    statusText: submissionStatusText(submissionState, { origin, detail }),
    note: note || '',
    needsPassword: Boolean(needsPassword),
  }
}

/** Consequence + allowance/cap ceiling (ordering item 1 for a transaction approval) -- never an
 *  inferred intended movement. A recognized grant gets its truthful ceiling breakdown; a schema
 *  mismatch (fail-closed, VFW3) gets a loud warning and NO friendly claim; anything else gets a
 *  deliberately non-committal statement that never guesses what the call does. */
function buildConsequence(summary) {
  const grant = summary?.grant ?? null

  if (summary?.allFunds === true) {
    return {
      kind: 'consequence',
      statements: [
        'This approval withdraws all funds held by the selected agent scope to the displayed recipient.',
      ],
      ceilingRows: [],
      warning: false,
    }
  }

  if (grant?.kind === 'funding-router-grant') {
    const statements = [GRANT_TRUTHS[0]]
    if (grant.budgets.length > 1) statements.push(GRANT_MIXED_TOKEN_TRUTH)
    const ceilingRows = grant.budgets.map((b, i) => [
      i === 0 ? 'Allowance budget (ceiling)' : '',
      amountParts(b, 'not a deposit amount'),
    ])
    return { kind: 'consequence', statements, ceilingRows, warning: false }
  }

  if (grant?.kind === 'schema-mismatch') {
    // Fail-closed (VFW3): a known router whose args didn't match its pinned schema NEVER earns
    // the friendly primary-Confirm framing -- it gets the raw warning, unchanged, plus an
    // explicit instruction to read the raw technical details instead of trusting a summary.
    return {
      kind: 'consequence',
      statements: [
        grant.warning,
        'This could not be shown as a decoded breakdown. Review the technical details below before approving.',
      ],
      ceilingRows: [],
      warning: true,
    }
  }

  // Generic / undecoded call: never invent a "you are sending X to Y" claim (never an inferred
  // intended movement) -- state plainly that no ceiling can be guaranteed here.
  const what = summary?.fn
    ? `"${summary.fn}"${summary.contractLabel ? ` on ${summary.contractLabel}` : summary?.contract ? ` on ${safeShortAddr(summary.contract)}` : ''}`
    : 'a request'
  return {
    kind: 'consequence',
    statements: [
      `This asks you to sign ${what}. VF Wallet cannot state a guaranteed spending ceiling for this request — review the technical details below before approving.`,
    ],
    ceilingRows: [],
    warning: false,
  }
}

// One agent row's value, mixing a friendly kind word/period/venue label with an amount+token and
// (when unlabeled) a destination address -- built as parts so only the genuinely technical pieces
// (the token, and an unlabeled destination's raw address) render mono; "deposit"/"bridge", the
// period, and a known venue's route label stay plain body copy.
function agentRowParts(a) {
  const parts = [
    plain(`${a.kind} · cap `),
    ...amountParts(a.capPerPeriod),
    plain(` · ${periodText(a.periodDurationSeconds)} · `),
  ]
  if (a.destination.routeLabel) {
    parts.push(plain(a.destination.routeLabel))
  } else {
    parts.push(plain('unlabeled destination '), addr(safeShortAddr(a.destination.targetAddress)))
  }
  if (a.expiryTimestamp != null) parts.push(plain(` · agent expires ${a.expiryTimestamp}`))
  return parts
}

/** Decoded agent limits/destinations (ordering item 6). Step 2: one row per actual AgentInit
 *  (never more, never fewer), per-token budget already covered by the consequence ceiling above,
 *  cap/period/expiry per agent, one Stellar venue truth block, and a bridge agent's Base-side
 *  proxy explanation nested directly under that agent (not a generic preamble bullet). */
function buildDecodedRows(summary) {
  const rows = []
  if (summary?.contract) {
    rows.push([
      'Contract',
      [
        addr(safeShortAddr(summary.contract)),
        plain(summary.contractLabel ? ` (${summary.contractLabel})` : ''),
      ],
    ])
  }
  // These are the exact post-simulation consent facts. Unlike the navigational contract/signer
  // hints above, none may be shortened: this is the identity and digest material the user signs.
  if (summary?.owner) rows.push(['Owner', [addr(summary.owner)]])
  if (summary?.networkPassphrase) rows.push(['Network', [addr(summary.networkPassphrase)]])
  if (summary?.fn) rows.push(['Function', [plain(summary.fn)]])
  if (summary?.token) rows.push(['Token', [addr(summary.token)]])
  if (summary?.recipient) rows.push(['Recipient', [addr(summary.recipient)]])
  if (summary?.bodyDigest) rows.push(['Transaction body digest', [addr(summary.bodyDigest)]])
  if (summary?.authDigest) rows.push(['Authorization digest', [addr(summary.authDigest)]])
  if (summary?.signer) rows.push(['Signer (from request)', [addr(safeShortAddr(summary.signer))]])

  const grant = summary?.grant ?? null
  if (grant?.kind === 'funding-router-grant') {
    rows.push(['What this means', [plain(GRANT_TRUTHS[1])]])
    rows.push(['', [plain(GRANT_TRUTHS[2])]]) // the one Stellar venue truth block
    rows.push(['', [plain(GRANT_TRUTHS[3])]])
    rows.push(['Grant allowance expires', [plain(`ledger ${grant.expiryLedger}`)]])
    for (const a of grant.agents) {
      rows.push([`Agent #${a.index}`, agentRowParts(a)])
      if (a.kind === 'bridge') {
        // Nested child of THIS agent's row, not a top-of-list bullet -- see the module doc. Plain
        // prose (never mono): this is an explanatory sentence, not a technical value.
        rows.push(['', [plain(GRANT_BRIDGE_TRUTH)], { nested: true }])
      }
    }
    return rows
  }

  if (grant?.kind === 'schema-mismatch') rows.push(['Warning', [plain(grant.warning)]])
  // Raw, undecoded args (the fail-closed fallback for an unrecognized call): genuinely raw
  // technical data dumped for the user to verify themselves, not friendly copy -- kept mono.
  for (const [i, a] of (summary?.args ?? []).entries()) {
    rows.push([i === 0 ? 'Args' : '', [addr(a)]])
  }
  return rows
}

// ---------------------------------------------------------------------------------------------
// The public model builder. Successor to the old flat screenModel() -- same inputs, richer,
// ordered output. `req` is the already-stashed, Chrome-verified snapshot fields approve.js reads
// (never anything URL-supplied); `ctx` is the same shape screenModel() took.
// ---------------------------------------------------------------------------------------------

/**
 * @param {{method:string, params:object, origin:string|null}} req
 * @param {{address:string|null, summary?:object|null, kind?:'passkey'|'classic',
 *          unlocked?:boolean, submissionState?:string, detail?:string}} ctx
 */
export function buildApprovalView(req, ctx = {}) {
  const {
    address,
    summary,
    kind,
    unlocked,
    submissionState = SUBMISSION_STATE.REVIEWING,
    detail,
  } = ctx

  // Security requirement: never render an origin the extension has not verified. `req.origin` is
  // only ever populated from the Chrome-verified `sender.origin` (see consentStore.js) -- if it
  // is missing, this is not a screen the extension can safely attribute to anyone, so it fails
  // closed with no confirming action at all, rather than rendering a blank/guessed origin.
  if (!req.origin) {
    return {
      variant: 'blocked-origin',
      title: 'Request blocked',
      note: 'VF Wallet could not verify which site sent this request, so it cannot be shown or approved.',
      rejectLabel: 'Close',
      approveLabel: null,
      needsPassword: false,
      raw: null,
      submissionState: SUBMISSION_STATE.FAILED,
      sections: [],
    }
  }

  if (!address) {
    return {
      variant: 'no-wallet',
      title: 'No wallet yet',
      note: 'Create a wallet in VF Wallet first, then retry from the site.',
      rejectLabel: 'Reject',
      approveLabel: 'Open VF Wallet',
      needsPassword: false,
      raw: null,
      submissionState,
      sections: [originSection(req.origin)],
    }
  }

  if (req.method === 'getAddress') {
    return {
      variant: 'connect',
      title: 'Connection request',
      note: '',
      rejectLabel: 'Reject',
      approveLabel: 'Connect',
      needsPassword: false,
      raw: null,
      submissionState,
      sections: [
        originSection(req.origin),
        requestsSection('Connection request'),
        accountSection(kind, address),
        networkSection(),
        stateSection({ submissionState, origin: req.origin, detail }),
      ],
    }
  }

  // sign
  const needsPassword = kind === 'classic' && !unlocked
  const note =
    kind === 'classic'
      ? 'Approving asks for your wallet password.'
      : 'Approving opens the passkey (Face ID) prompt.'
  const raw =
    req.method === 'signTransaction' ? (req.params?.xdr ?? null) : (req.params?.authEntry ?? null)

  const consequence = buildConsequence(summary)
  // C1/I1 fix: a schema-mismatch (fail-closed, VFW3) consequence must not offer the same friendly
  // primary action as a decoded grant -- approve.js gates Confirm on the raw technical-details
  // disclosure having been opened (see wireAcknowledgmentGate) whenever this is true.
  const needsAcknowledgment = Boolean(consequence.warning)

  return {
    variant: 'sign',
    title: 'Signature request',
    note,
    rejectLabel: 'Cancel',
    approveLabel: needsAcknowledgment ? 'Confirm anyway' : 'Confirm',
    needsAcknowledgment,
    needsPassword,
    raw,
    consentDigest: summary?.consentDigest ?? null,
    submissionState,
    sections: [
      consequence,
      originSection(req.origin),
      accountSection(kind, address),
      networkSection(),
      stateSection({ submissionState, note, needsPassword, origin: req.origin, detail }),
      { kind: 'decoded', rows: buildDecodedRows(summary) },
      { kind: 'technical', raw },
    ],
  }
}

// ---------------------------------------------------------------------------------------------
// Pure vanilla DOM rendering. No framework, no JSX -- createElement calls only, per the brief.
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

function rowEl([key, value, opts = {}]) {
  const tr = h('tr', { className: opts.nested ? 'pc-approval-row--nested' : undefined })
  const td = document.createElement('td')
  td.append(partsFragment(value))
  tr.append(h('th', { text: key }), td)
  return tr
}

function renderOrigin(section) {
  const wrap = h('div', { className: 'pc-wallet-origin' })
  wrap.append(h('p', { className: 'pc-field-help', text: 'Verified site' }))
  wrap.append(h('p', { className: 'pc-technical', attrs: { id: 'origin' }, text: section.origin }))
  return wrap
}

function renderRequests(section) {
  const frag = document.createDocumentFragment()
  frag.append(h('h1', { attrs: { id: 'title' }, text: section.title }))
  const list = h('ul', { className: 'pc-capability-list' })
  for (const cap of section.capabilities) list.append(h('li', { text: cap.label }))
  frag.append(list)
  return frag
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
  // I1 fix: a schema-mismatch's `warning: true` used to be a dead field -- this box now renders
  // visibly differently (a danger-tone border, matching the contract's own --pc-danger token) and
  // its lead statement (the raw schema-mismatch warning itself) renders in the same danger-red
  // `.pc-field-error` treatment already used everywhere else in this file for error copy, instead
  // of identical body-ink prose. See buildApprovalView's `needsAcknowledgment` for the Confirm-gate
  // half of this fix.
  const box = h('div', {
    className: section.warning
      ? 'pc-wallet-consequence pc-wallet-consequence--warning'
      : 'pc-wallet-consequence',
  })
  box.append(h('h1', { attrs: { id: 'title' }, text: 'Signature request' }))
  section.statements.forEach((statement, i) => {
    box.append(
      h('p', {
        className: section.warning && i === 0 ? 'pc-field-error' : undefined,
        text: statement,
      })
    )
  })
  if (section.ceilingRows.length > 0) {
    const table = h('table', { className: 'pc-approval-table' })
    const tbody = h('tbody')
    for (const row of section.ceilingRows) tbody.append(rowEl(row))
    table.append(tbody)
    box.append(table)
  }
  return box
}

function renderState(section) {
  const wrap = h('div', { className: 'pc-wallet-state' })
  if (section.note)
    wrap.append(h('p', { attrs: { id: 'note' }, className: 'pc-field-help', text: section.note }))
  wrap.append(
    // No extra class -- approval.css's existing `#status` rule (id-scoped) already styles this
    // element; adding a second, class-scoped rule here would either duplicate or fight it on
    // specificity for the same properties.
    h('p', {
      attrs: { id: 'status', role: 'status', 'aria-live': 'polite' },
      text: section.statusText,
    })
  )
  if (section.needsPassword) {
    const pwWrap = h('div', { className: 'pc-field', attrs: { id: 'pw-wrap' } })
    pwWrap.append(h('label', { attrs: { for: 'pw' }, text: 'Password' }))
    pwWrap.append(
      h('input', {
        className: 'pc-input',
        attrs: { id: 'pw', type: 'password', placeholder: 'Wallet password' },
      })
    )
    wrap.append(pwWrap)
  }
  return wrap
}

function renderDecoded(section) {
  const table = h('table', { className: 'pc-approval-table' })
  const tbody = h('tbody', { attrs: { id: 'rows' } })
  for (const row of section.rows) tbody.append(rowEl(row))
  table.append(tbody)
  return table
}

function renderTechnical(section) {
  const wrap = h('div', { attrs: { id: 'raw-wrap' } })
  if (!section.raw) wrap.style.display = 'none'
  // id targeted by approve.js's wireAcknowledgmentGate (I1) -- Confirm on a schema-mismatch stays
  // disabled until this disclosure is opened.
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
    case 'requests':
      return renderRequests(section)
    case 'account':
      return renderAccount(section)
    case 'network':
      return renderNetwork(section)
    case 'consequence':
      return renderConsequence(section)
    case 'state':
      return renderState(section)
    case 'decoded':
      return renderDecoded(section)
    case 'technical':
      return renderTechnical(section)
    default:
      return document.createDocumentFragment()
  }
}

/** Renders `view` (buildApprovalView's output) into `root`, in the exact section order the view
 *  carries -- ordering lives entirely in buildApprovalView's array literal, this function never
 *  reorders or filters. `blocked-origin`/`no-wallet` render a minimal title+note (no requestable
 *  sections exist for either). */
export function renderApprovalView(root, view) {
  root.innerHTML = ''
  if (view.variant === 'blocked-origin' || view.variant === 'no-wallet') {
    // Origin still leads (when there is one to show at all) -- never bury the "who is asking"
    // fact below unrelated text, even on the two variants the brief's ordering list doesn't name.
    for (const section of view.sections) root.append(renderSection(section))
    root.append(h('h1', { attrs: { id: 'title' }, text: view.title }))
    root.append(h('p', { attrs: { id: 'note' }, className: 'pc-field-help', text: view.note }))
    return
  }
  for (const section of view.sections) root.append(renderSection(section))
}
