// router.js — React Router v6 helpers
// Thin wrappers so existing component call sites need minimal changes.

import { useNavigate, useLocation } from 'react-router-dom';

export const ROUTES = {
  HOME:     '/home',
  STRATEGY: '/strategy',
  AGENT:    '/agent',
  HISTORY:  '/history',
  SETTINGS: '/settings',
  VAULT:    '/vault/:protocol',
  TX:       '/tx/:txHash',
}

/**
 * Hook — returns a navigateTo(page, id?) function matching the old hash-router API.
 * navigateTo('vault', 'aave-v3') → navigate('/vault/aave-v3')
 */
export function useNavigateTo() {
  const navigate = useNavigate();
  return (page, id = null) => navigate(id ? `/${page}/${id}` : `/${page}`);
}

/**
 * Hook — returns a navigateHome function.
 */
export function useNavigateHome() {
  const navigate = useNavigate();
  return () => navigate('/home');
}

/**
 * Hook — returns current top-level page name from URL pathname.
 * /agent → 'agent', /vault/aave-v3 → 'vault'
 */
export function useCurrentPage() {
  const { pathname } = useLocation();
  return pathname.split('/').filter(Boolean)[0] || 'home';
}

/**
 * Maps a pathname to the sidebar path that should be highlighted.
 * Detail pages (vault, tx) map to their logical parent.
 */
export function getSidebarPath(pathname) {
  if (pathname.startsWith('/vault')) return '/home';
  if (pathname.startsWith('/tx'))    return '/history';
  if (pathname === '/')              return '/home';
  return pathname;
}
