// skillLoader.js
// Loads vault advisor skill with user-override support.
// Priority: user (localStorage) > user file > bundled default > hardcoded fallback
//
// NOTE: the default lives in src/ so it is imported with Vite's `?raw` suffix
// (bundled, always available). A fetch() against src/ paths would 404 in Vite.
import defaultSkill from './skills/default/vault-advisor.md?raw'

const USER_SKILL_PATH = '/skills/user/vault-advisor.md' // optional: only if hosted in public/
const LOCALSTORAGE_KEY = 'yv_user_skill'

export async function loadVaultSkill() {
  // Priority 1: localStorage (user pasted a custom skill via UI)
  const localSkill = localStorage.getItem(LOCALSTORAGE_KEY)
  if (localSkill && localSkill.trim().length > 100) {
    console.log('[SkillLoader] Using user skill from localStorage')
    return { content: localSkill, source: 'user-local' }
  }

  // Priority 2: user file served from public/ (optional)
  try {
    const res = await fetch(USER_SKILL_PATH)
    if (res.ok) {
      const text = await res.text()
      // guard against SPA fallback returning index.html
      if (text.trim().length > 100 && !text.trimStart().startsWith('<')) {
        console.log('[SkillLoader] Using user skill from file')
        return { content: text, source: 'user-file' }
      }
    }
  } catch (_) {}

  // Priority 3: bundled default skill
  if (defaultSkill && defaultSkill.trim().length > 100) {
    console.log('[SkillLoader] Using default skill')
    return { content: defaultSkill, source: 'default' }
  }

  // Priority 4: hardcoded fallback (should never reach here)
  console.warn('[SkillLoader] All skill sources failed, using minimal fallback')
  return {
    content: 'You are a DeFi yield advisor. Recommend vaults from the provided catalog based on user risk level. Respond in JSON only.',
    source: 'fallback'
  }
}

export function saveUserSkill(markdownContent) {
  localStorage.setItem(LOCALSTORAGE_KEY, markdownContent)
}

export function clearUserSkill() {
  localStorage.removeItem(LOCALSTORAGE_KEY)
}
