// Deterministic VF Wallet atlas registry.
//
// This module is presentation metadata only. It deliberately contains no account records,
// signer material, persistence, clocks, network readers, or action callbacks. The visual entry
// point resolves each composition name to the real WalletShell/Wallet*/extension renderer at its
// composition boundary. Keeping the P/A/C inventory here gives browser and jsdom contracts one
// exact, case-sensitive source of truth without making the fixture state a second wallet state
// machine.
import { BASE_HEX_FIXTURES, STELLAR_C_FIXTURES, STELLAR_G_FIXTURE } from './secondaryFixtures.js'

export { BASE_HEX_FIXTURES, STELLAR_C_FIXTURES, STELLAR_G_FIXTURE }

const freeze = (value) => Object.freeze(value)

const popupIds = Array.from({ length: 21 }, (_, i) => `P${String(i).padStart(2, '0')}`)
const approvalIds = Array.from({ length: 10 }, (_, i) => `A${String(i).padStart(2, '0')}`)
const ceremonyIds = Array.from({ length: 10 }, (_, i) => `C${String(i).padStart(2, '0')}`)

export const REQUIRED_WALLET_ATLAS_SECTIONS = freeze([...popupIds, ...approvalIds, ...ceremonyIds])

const POPUP = 'vf-wallet-home'
const APPROVAL = 'vf-wallet-approval'

const section = (id, fixture, composition, variant, states, title) =>
  freeze({
    id,
    fixture,
    family: id.startsWith('P') ? 'popup' : id.startsWith('A') ? 'approval' : 'ceremony',
    composition,
    variant,
    states: freeze([...states]),
    title,
  })

// The labels intentionally describe the complete state family each production composition owns.
// `variant` is the deterministic representative mounted by the visual entry; the full state
// list is the contract that prevents a P/A/C section from silently collapsing to a parent-only
// screenshot or a fake placeholder.
const sections = [
  section(
    'P00',
    POPUP,
    'WalletOnboarding',
    'choose-loading',
    ['bootstrap loading'],
    'Bootstrap loading'
  ),
  section(
    'P01',
    POPUP,
    'WalletOnboarding',
    'choose-error',
    ['no account', 'corrupt store', 'empty', 'retry'],
    'No account or corrupt store'
  ),
  section(
    'P02',
    POPUP,
    'WalletHome',
    'unavailable-retry',
    ['empty', 'retry', 'loading'],
    'Empty or retry'
  ),
  section('P03', POPUP, 'WalletOnboarding', 'select-account', ['account choice'], 'Account choice'),
  section(
    'P04',
    POPUP,
    'WalletOnboarding',
    'standard-create',
    [
      'Standard create',
      'Standard import',
      'Standard backup',
      'Standard unlock',
      'Passkey choose',
      'Passkey creating',
      'Passkey error',
    ],
    'Create, import, backup, unlock, or Passkey setup'
  ),
  section(
    'P05',
    POPUP,
    'SendScreen',
    'invalid',
    ['G Send invalid', 'preview', 'approval', 'sending', 'success', 'failure'],
    'G Send'
  ),
  section(
    'P06',
    POPUP,
    'WalletReceive',
    'loading',
    ['Receive loading', 'result', 'unavailable'],
    'Receive'
  ),
  section(
    'P07',
    POPUP,
    'AddAssetScreen',
    'invalid',
    ['Add Asset invalid', 'busy', 'error', 'success'],
    'Add Asset'
  ),
  section(
    'P08',
    POPUP,
    'WalletActivity',
    'loading',
    ['Activity loading', 'unavailable', 'confirmed-empty', 'current'],
    'Activity'
  ),
  section(
    'P09',
    POPUP,
    'WalletSettings',
    'locked',
    ['lock', 'autolock', 'export', 'reset'],
    'G Settings'
  ),
  section(
    'P10',
    POPUP,
    'WalletAdvanced',
    'faucet',
    ['faucet', 'import', 'read-only direct action'],
    'G Advanced'
  ),
  section('P11', POPUP, 'WalletOnboarding', 'passkey-choose', ['C onboarding'], 'C onboarding'),
  section(
    'P12',
    POPUP,
    'WalletHome',
    'passkey-send-unavailable',
    ['C Home', 'Send unavailable'],
    'C Home'
  ),
  section(
    'P13',
    POPUP,
    'WalletSettings',
    'passkey',
    ['C Settings', 'classic controls omitted'],
    'C Settings'
  ),
  section(
    'P14',
    POPUP,
    'WalletAdvanced',
    'eligibility-loading',
    ['eligibility loading', 'eligible', 'not eligible', 'unavailable'],
    'C Advanced eligibility'
  ),
  section(
    'P15',
    POPUP,
    'ApproveOverlay',
    'enable-deposit',
    ['enable-deposit overlay'],
    'Enable deposits'
  ),
  section(
    'P16',
    POPUP,
    'WalletAdvanced',
    'recovery',
    ['recovery signer unavailable', 'recovery signer ready', 'recovery signer error'],
    'Recovery signer'
  ),
  section(
    'P17',
    POPUP,
    'WalletReceive',
    'passkey',
    ['C Receive loading', 'result', 'unavailable'],
    'C Receive'
  ),
  section(
    'P18',
    POPUP,
    'WalletShell',
    'passkey-creating',
    ['signing pending context', 'account', 'status'],
    'Signing pending'
  ),
  section(
    'P19',
    POPUP,
    'WalletShell',
    'passkey-error',
    ['result confirmed with hash', 'submitted', 'unknown', 'not-submitted', 'failure'],
    'Signing result'
  ),
  section(
    'P20',
    POPUP,
    'ApproveOverlay',
    'allowance',
    ['allowance loading', 'eligible', 'rejected', 'pending', 'failure'],
    'Shared allowance'
  ),
  section('A00', APPROVAL, 'renderApprovalView', 'loading', ['loading'], 'Approval loading'),
  section(
    'A01',
    APPROVAL,
    'renderApprovalView',
    'no-wallet',
    ['blocked', 'no wallet'],
    'Approval blocked or no wallet'
  ),
  section(
    'A02',
    APPROVAL,
    'renderApprovalView',
    'connect',
    ['verified connect'],
    'Verified connect'
  ),
  section(
    'A03',
    APPROVAL,
    'renderApprovalView',
    'grant',
    ['decoded grant consequence'],
    'Decoded grant'
  ),
  section(
    'A04',
    APPROVAL,
    'renderApprovalView',
    'schema-mismatch',
    ['schema mismatch acknowledgement'],
    'Schema mismatch'
  ),
  section(
    'A05',
    APPROVAL,
    'renderApprovalView',
    'waiting-password',
    ['password wait', 'passkey wait'],
    'Credential wait'
  ),
  section(
    'A06',
    APPROVAL,
    'renderApprovalView',
    'signed-returned',
    ['signed returned'],
    'Signed returned'
  ),
  section(
    'A07',
    APPROVAL,
    'renderApprovalView',
    'rejected',
    ['rejected', 'failed'],
    'Rejected or failed'
  ),
  section(
    'A08',
    APPROVAL,
    'renderApprovalView',
    'stale-account',
    ['stale account', 'mismatched account'],
    'Stale or mismatched account'
  ),
  section(
    'A09',
    APPROVAL,
    'renderApprovalView',
    'internal-guarded',
    ['internal guarded state'],
    'Internal guarded state'
  ),
  section('C00', APPROVAL, 'renderCeremonyView', 'preparing', ['preparing'], 'Ceremony preparing'),
  section(
    'C01',
    APPROVAL,
    'renderCeremonyView',
    'deposit',
    ['deposit consequence'],
    'Ceremony deposit'
  ),
  section(
    'C02',
    APPROVAL,
    'renderCeremonyView',
    'approve',
    ['approve consequence'],
    'Ceremony allowance'
  ),
  section(
    'C03',
    APPROVAL,
    'renderCeremonyView',
    'connect',
    ['connect consequence'],
    'Ceremony connect'
  ),
  section(
    'C04',
    APPROVAL,
    'renderCeremonyView',
    'waiting-passkey',
    ['waiting Face ID'],
    'Waiting for Face ID'
  ),
  section('C05', APPROVAL, 'renderCeremonyView', 'signed', ['signed'], 'Signed'),
  section(
    'C06',
    APPROVAL,
    'renderCeremonyView',
    'submitted-checking',
    ['submitted', 'checking'],
    'Submitted and checking'
  ),
  section(
    'C07',
    APPROVAL,
    'renderCeremonyView',
    'confirmed',
    ['confirmed hash', 'reconcile'],
    'Confirmed'
  ),
  section(
    'C08',
    APPROVAL,
    'renderCeremonyView',
    'not-submitted',
    ['not-submitted', 'rejected', 'failed'],
    'Not submitted or failed'
  ),
  section(
    'C09',
    APPROVAL,
    'renderCeremonyView',
    'base-disclosure',
    ['Base custody', 'cap', 'expiry disclosure'],
    'Base custody disclosure'
  ),
]

export const WALLET_ATLAS_SECTIONS = freeze(sections)
export const WALLET_ATLAS_SECTION_MAP = freeze(
  Object.fromEntries(sections.map((entry) => [entry.id, entry]))
)

// This is the exact production composition vocabulary the visual entrypoint is allowed to
// resolve. It is intentionally strings rather than imported component references so this module
// remains safe for source/contract tests and cannot accidentally execute a signer/controller.
export const WALLET_ATLAS_COMPOSITIONS = freeze([
  'WalletOnboarding',
  'WalletHome',
  'WalletReceive',
  'WalletActivity',
  'WalletSettings',
  'WalletAdvanced',
  'WalletShell',
  'SendScreen',
  'AddAssetScreen',
  'ApproveOverlay',
  'renderApprovalView',
  'renderCeremonyView',
])

export const WALLET_CAPTURE_GROUPS = freeze([
  freeze({ id: 'popup', fixture: POPUP, section: 'P00' }),
  freeze({ id: 'approval', fixture: APPROVAL, section: 'A00' }),
  freeze({ id: 'ceremony', fixture: APPROVAL, section: 'C00' }),
])

export const WALLET3_VARIANTS = freeze([
  freeze({ id: 'forest-360', theme: 'forest', motion: 'normal', width: 360, height: 600 }),
  freeze({ id: 'day-field-360', theme: 'day-field', motion: 'normal', width: 360, height: 800 }),
  freeze({
    id: 'reduced-forest-360',
    theme: 'forest',
    motion: 'reduced',
    width: 360,
    height: 800,
  }),
])

export const WALLET_CAPTURE_CELLS = freeze(
  WALLET_CAPTURE_GROUPS.flatMap((group) =>
    WALLET3_VARIANTS.map((variant) =>
      freeze({ ...group, ...variant, id: `${group.id}-${variant.id}` })
    )
  )
)

export function assertWalletFixtureState(entry) {
  if (!entry || typeof entry !== 'object') throw new TypeError('Wallet fixture section is required')
  if (!REQUIRED_WALLET_ATLAS_SECTIONS.includes(entry.id)) {
    throw new Error(`Unknown VF Wallet fixture section: ${entry.id}`)
  }
  if (!WALLET_ATLAS_COMPOSITIONS.includes(entry.composition)) {
    throw new Error(`Unbound VF Wallet composition: ${entry.composition}`)
  }
  if (!['vf-wallet-home', 'vf-wallet-approval'].includes(entry.fixture)) {
    throw new Error(`Unknown VF Wallet fixture root: ${entry.fixture}`)
  }
  if (!Array.isArray(entry.states) || entry.states.length === 0) {
    throw new Error(`VF Wallet fixture section ${entry.id} has no deterministic states`)
  }
  return true
}
