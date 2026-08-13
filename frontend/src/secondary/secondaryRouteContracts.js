// Secondary routes consume the Pocket Crew Foundation contracts directly.  This module only
// names the source kinds used by the visual inventory; it does not create another state or
// amount vocabulary.
export {
  FACT_STATES,
  formatTokenUnits,
  normalizeAmount,
  normalizeFact,
  statusNoticeModel,
  statusToneForState,
  toFreshnessView,
} from '../design/pocket-crew-foundation.js'

export const SOURCE_KINDS = Object.freeze([
  'stellar-rpc',
  'defillama',
  'base-indexer',
  'local-device',
  'replay-fixture',
  'portal-api',
  'catalog',
  'unavailable',
])
