import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import { api } from '../api/client'
import type { UserPreferences } from '../api/types'
import { useAuth } from './AuthContext'

interface PreferencesState {
  prefs: UserPreferences
  loaded: boolean
  update: (patch: UserPreferences) => Promise<void>
}

const PreferencesContext = createContext<PreferencesState | null>(null)

const DEFAULTS: UserPreferences = {
  theme: 'light',
  density: 'normal',
  dashboard: { show_summary: true, show_products: true, show_lots: true },
  calendar: {
    hide_future: true,
    tax_rate: 0.08,
    columns: [],   // 空ならカレンダー側でデフォルト列セットを使う
  },
}

function mergeDashboard(p?: UserPreferences['dashboard']) {
  return { ...DEFAULTS.dashboard, ...(p ?? {}) }
}

function mergeCalendar(p?: UserPreferences['calendar']) {
  return { ...DEFAULTS.calendar, ...(p ?? {}) }
}

function applyToDom(prefs: UserPreferences) {
  const root = document.documentElement
  if (prefs.theme === 'dark') root.setAttribute('data-theme', 'dark')
  else root.removeAttribute('data-theme')
  if (prefs.density && prefs.density !== 'normal') {
    root.setAttribute('data-density', prefs.density)
  } else {
    root.removeAttribute('data-density')
  }
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const { status, user } = useAuth()
  const [prefs, setPrefs] = useState<UserPreferences>(DEFAULTS)
  const [loaded, setLoaded] = useState(false)

  // 認証後にサーバから設定をロード
  useEffect(() => {
    if (status !== 'authenticated') {
      // 未認証の間はデフォルト見た目に戻す
      applyToDom(DEFAULTS)
      setLoaded(false)
      return
    }
    let cancelled = false
    api
      .get<UserPreferences>('/auth/preferences')
      .then((p) => {
        if (cancelled) return
        const merged: UserPreferences = {
          theme: p?.theme ?? DEFAULTS.theme,
          density: p?.density ?? DEFAULTS.density,
          dashboard: mergeDashboard(p?.dashboard),
          calendar:  mergeCalendar(p?.calendar),
        }
        setPrefs(merged)
        setLoaded(true)
      })
      .catch(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [status, user?.id])

  // 設定変更時に DOM 反映
  useEffect(() => {
    applyToDom(prefs)
  }, [prefs])

  async function update(patch: UserPreferences) {
    const next: UserPreferences = {
      ...prefs,
      ...patch,
      dashboard:
        patch.dashboard !== undefined
          ? { ...(prefs.dashboard ?? {}), ...patch.dashboard }
          : prefs.dashboard,
      calendar:
        patch.calendar !== undefined
          ? { ...(prefs.calendar ?? {}), ...patch.calendar }
          : prefs.calendar,
    }
    setPrefs(next)
    try {
      await api.put<UserPreferences>('/auth/preferences', next)
    } catch {
      // 失敗してもUIは更新済み。サーバ復旧時に同期し直す想定。
    }
  }

  return (
    <PreferencesContext.Provider value={{ prefs, loaded, update }}>
      {children}
    </PreferencesContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePreferences(): PreferencesState {
  const ctx = useContext(PreferencesContext)
  if (!ctx) throw new Error('usePreferences は PreferencesProvider の内側で使ってください')
  return ctx
}
