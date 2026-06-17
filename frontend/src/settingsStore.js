// settingsStore.js
// Persistence for non-agent settings (agent config stays in yv_agent_settings).
// Each setting maps to its own yv_* localStorage key. Plus a tiny i18n table.

export const SETTINGS_KEYS = {
  modelPreference: 'yv_model_preference', // 'auto' | 'venice' | 'deepseek'
  veniceApiKey: 'yv_venice_api_key',
  deepseekApiKey: 'yv_deepseek_api_key',
  tavilyApiKey: 'yv_tavily_api_key',
  vaultDataSource: 'yv_vault_data_source', // 'live' | 'static'
  marketContext: 'yv_market_context', // boolean
  alertSeverity: 'yv_alert_severity', // { high, medium, low }
  alertPersistence: 'yv_alert_persistence', // 'session' | 'permanent'
  alertBanner: 'yv_alert_banner', // boolean
  timestampFormat: 'yv_timestamp_format', // 'relative' | 'absolute'
  language: 'yv_language', // 'en' | 'id'
}

export const SETTINGS_DEFAULTS = {
  modelPreference: 'auto',
  veniceApiKey: '',
  deepseekApiKey: '',
  tavilyApiKey: '',
  vaultDataSource: 'live',
  marketContext: true,
  alertSeverity: { high: true, medium: true, low: false },
  alertPersistence: 'session',
  alertBanner: true,
  timestampFormat: 'relative',
  language: 'en',
}

// Secret API keys live in sessionStorage, not localStorage: they clear on tab
// close and are not shared across tabs, narrowing the exfiltration window if any
// XSS lands. Non-secret prefs stay in localStorage for persistence.
const SECRET_KEYS = new Set(['veniceApiKey', 'deepseekApiKey', 'tavilyApiKey'])
const storeFor = (key) => (SECRET_KEYS.has(key) ? sessionStorage : localStorage)

const parse = (raw, def) => {
  if (raw == null) return def
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  } // bare strings stored unquoted
}

export function loadSettings() {
  const out = { ...SETTINGS_DEFAULTS }
  for (const k in SETTINGS_KEYS) {
    const raw = storeFor(k).getItem(SETTINGS_KEYS[k])
    if (raw != null) out[k] = parse(raw, SETTINGS_DEFAULTS[k])
  }
  return out
}

export function saveSetting(key, value) {
  const sk = SETTINGS_KEYS[key]
  if (!sk) return
  storeFor(key).setItem(sk, typeof value === 'string' ? value : JSON.stringify(value))
}

// Minimal i18n — UI labels only, never AI reasoning output.
export const I18N = {
  en: {
    depositAmount: 'Deposit amount',
    getRecommendation: 'Get Recommendation',
    getReco: 'Get Recommendation',
    strategy: 'AI Strategy',
    connect: 'Connect & Upgrade',
    skills: 'Review Skills',
    permission: 'Grant Permission',
    execute: 'Auto-Execute',
    done: 'Complete',
    riskLevel: 'Risk level',
    connectWallet: 'Connect Wallet',
    grantPermission: 'Grant Permission',
    activePositions: 'Active Positions',
    agentStatus: 'Autonomous Agent',
    recentActivity: 'Recent Activity',
    marketPulse: 'Market Pulse',
    withdraw: 'Withdraw',
    harvest: 'Harvest',
    dismiss: 'Dismiss',
    newStrategy: 'New Strategy',
  },
  id: {
    depositAmount: 'Jumlah deposit',
    getRecommendation: 'Dapatkan Rekomendasi',
    getReco: 'Dapatkan Rekomendasi',
    strategy: 'Strategi AI',
    connect: 'Hubungkan & Upgrade',
    skills: 'Tinjau Skill',
    permission: 'Beri Izin',
    execute: 'Eksekusi Otomatis',
    done: 'Selesai',
    riskLevel: 'Tingkat risiko',
    connectWallet: 'Hubungkan Wallet',
    grantPermission: 'Beri Izin',
    activePositions: 'Posisi Aktif',
    agentStatus: 'Agen Otonom',
    recentActivity: 'Aktivitas Terkini',
    marketPulse: 'Denyut Pasar',
    withdraw: 'Tarik Dana',
    harvest: 'Panen',
    dismiss: 'Abaikan',
    newStrategy: 'Strategi Baru',
  },
}

export const t = (lang, key) => (I18N[lang] && I18N[lang][key]) || I18N.en[key] || key
