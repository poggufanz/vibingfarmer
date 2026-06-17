// devFlag.js — gate dev-only UI behind ?dev=1 or VITE_DEV_PANEL=1
export const isDevMode = () => {
  try {
    if (import.meta.env.VITE_DEV_PANEL === '1') return true;
    return new URLSearchParams(window.location.search).get('dev') === '1';
  } catch { return false; }
};
