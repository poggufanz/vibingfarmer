// Ecosystem strip: icons where the brand ships one (simple-icons, in each brand's own official
// color), styled wordmarks for the rest so the row still reads as one system. EcosystemPage renders
// the same set, so this is the one source of truth for the stack.
export const ECOSYSTEM = [
  // Soroban is Stellar's own smart-contract platform, so both names share one card. The official
  // SDF mark ships Black + White finals; Black is illegible on Forest, so the band swaps to White
  // under Forest via CSS (picking the SDF-approved variant per theme, no recoloring).
  {
    name: 'Stellar / Soroban',
    icon: '/brand/networks/stellar.svg',
    iconDark: '/brand/networks/stellar-white.svg',
  },
  { name: 'Blend Capital', icon: '/logos/blend.svg' },
  { name: 'Base', icon: '/logos/base.svg' },
  { name: 'Circle CCTP', icon: '/logos/circle.svg' },
  { name: 'OpenZeppelin', icon: '/logos/openzeppelin.svg' },
  { name: 'DeFiLlama', icon: '/logos/defillama.svg' },
  { name: 'ZeroDev', icon: '/logos/zerodev.svg' },
]
