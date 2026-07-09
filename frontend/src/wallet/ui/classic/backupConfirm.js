export function pickConfirmIndices(total = 24, n = 3, rng = Math.random) {
  const count = Math.min(n, total)
  const idx = new Set()
  while (idx.size < count) idx.add(Math.floor(rng() * total))
  return [...idx].sort((a, b) => a - b)
}

export function checkConfirm(mnemonic, answers) {
  const words = mnemonic.trim().split(/\s+/)
  return answers.every((a) => words[a.index]?.toLowerCase() === String(a.word).trim().toLowerCase())
}
