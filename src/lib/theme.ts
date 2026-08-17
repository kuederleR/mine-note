export type ThemeMode = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'mine-theme'
export const DEFAULT_THEME_MODE: ThemeMode = 'system'

export function parseThemeMode(value: unknown): ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system' ? value : DEFAULT_THEME_MODE
}

export function resolvedTheme(mode: ThemeMode, prefersDark = false): ResolvedTheme {
  if (mode === 'light' || mode === 'dark') return mode
  return prefersDark ? 'dark' : 'light'
}

export function prefersDarkScheme(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function applyTheme(mode: ThemeMode) {
  if (typeof document === 'undefined') return
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode)
  } catch {
    /* ignore quota / private mode */
  }
  const resolved = resolvedTheme(mode, prefersDarkScheme())
  document.documentElement.dataset.theme = resolved
  document.documentElement.style.colorScheme = resolved
}

export function readStoredThemeMode(): ThemeMode {
  try {
    return parseThemeMode(localStorage.getItem(THEME_STORAGE_KEY))
  } catch {
    return DEFAULT_THEME_MODE
  }
}
