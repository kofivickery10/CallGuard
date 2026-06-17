// Theme handling. The active theme is a single source of truth — the `dark`
// class on <html>, set before paint by an inline script in index.html (no flash).
// This module exposes a tiny external store so every consumer (toggle, charts)
// stays in sync and re-renders together when the theme changes. If the user has
// never made an explicit choice we follow the OS preference and keep following
// it live.
import { useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'cg-theme';

function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function getStoredTheme(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

export function resolveTheme(): Theme {
  return getStoredTheme() ?? (systemPrefersDark() ? 'dark' : 'light');
}

const listeners = new Set<() => void>();

function currentTheme(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  listeners.forEach((l) => l());
}

// Follow live OS changes only while the user hasn't made an explicit choice.
if (typeof window !== 'undefined') {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (getStoredTheme() === null) applyTheme(e.matches ? 'dark' : 'light');
  });
}

export function setTheme(next: Theme) {
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* ignore persistence failures (e.g. private mode) */
  }
  applyTheme(next);
}

export function toggleTheme() {
  setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
}

/** Subscribe to the active theme. All consumers share one store. */
export function useTheme() {
  const theme = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    currentTheme,
    () => 'light' as Theme,
  );
  return { theme, setTheme, toggle: toggleTheme };
}
