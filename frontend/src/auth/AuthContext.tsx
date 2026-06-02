import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import { api, ApiError, clearToken, getToken, setToken } from '../api/client'
import type { User } from '../api/types'

type AuthStatus = 'loading' | 'anonymous' | 'pending' | 'authenticated'

interface AuthState {
  status: AuthStatus
  user: User | null
  isAdmin: boolean
  // device_token をセットして本人確認をやり直す
  applyToken: (token: string) => Promise<void>
  refresh: () => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [user, setUser] = useState<User | null>(null)

  async function loadMe() {
    if (!getToken()) {
      setUser(null)
      setStatus('anonymous')
      return
    }
    try {
      const me = await api.get<User>('/auth/me')
      setUser(me)
      setStatus('authenticated')
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        // 承認待ち（トークンは有効だが is_active=false）
        setUser(null)
        setStatus('pending')
      } else if (e instanceof ApiError && e.status === 401) {
        // トークン本当に無効 → 破棄
        clearToken()
        setUser(null)
        setStatus('anonymous')
      } else {
        // 5xx / ネットワーク等の一時障害ではトークンは保持。
        // 承認待ち画面の「再確認」ボタンと同じUXで復帰できるよう pending 扱いにする。
        setUser(null)
        setStatus('pending')
      }
    }
  }

  useEffect(() => {
    // URL クエリ ?token=XXX があれば自動で localStorage に保存して URL を綺麗にする。
    // 別端末・別ブラウザに既存トークンを引き継ぐ用 (共有 URL で 1 回開けば登録不要)。
    try {
      const url = new URL(window.location.href)
      const fromQuery = url.searchParams.get('token')
      if (fromQuery && fromQuery.length > 10) {
        setToken(fromQuery)
        url.searchParams.delete('token')
        // URL からトークンを除去 (履歴やブックマーク汚染防止)
        window.history.replaceState(
          {}, '', url.pathname + url.search + url.hash,
        )
      }
    } catch { /* URL 解析失敗時は何もしない */ }
    loadMe()
  }, [])

  async function applyToken(token: string) {
    setToken(token)
    setStatus('loading')
    await loadMe()
  }

  function logout() {
    clearToken()
    setUser(null)
    setStatus('anonymous')
  }

  return (
    <AuthContext.Provider
      value={{
        status,
        user,
        isAdmin: user?.role === 'admin',
        applyToken,
        refresh: loadMe,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth は AuthProvider の内側で使ってください')
  return ctx
}
