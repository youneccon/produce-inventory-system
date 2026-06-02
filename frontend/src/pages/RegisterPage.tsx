import { useState, type FormEvent } from 'react'
import { api } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { errorText } from '../lib/format'
import { setToken } from '../api/client'
import type { RegisterResponse } from '../api/types'

export default function RegisterPage() {
  const { applyToken } = useAuth()
  const [mode, setMode] = useState<'new' | 'paste'>('new')
  const [name, setName] = useState('')
  const [pasteToken, setPasteToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<RegisterResponse | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const r = await api.post<RegisterResponse>('/auth/register', {
        display_name: name.trim(),
      })
      // 即 localStorage に保存 (ブラウザを閉じてもトークン消失しない)
      // 承認待ち時も保存 → 管理者承認後に同じ端末からそのまま使える
      setToken(r.device_token)
      setResult(r)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function submitPaste(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      // applyToken は内部で /auth/me を叩いて検証する
      await applyToken(pasteToken.trim())
      // 成功すれば AuthProvider 側で status='authenticated' に切り替わって
      // App.tsx が RegisterPage を捨てるので、この後の UI 更新は不要
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  if (result) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <h1>デバイス登録完了</h1>
          <div className="alert success">{result.message}</div>
          <div className="field">
            <label>権限</label>
            <div>
              {result.role}（{result.is_active ? '有効' : '承認待ち'}）
            </div>
          </div>
          <div className="field">
            <label>デバイストークン（必ず保管してください）</label>
            <input readOnly value={result.device_token}
              onClick={(e) => (e.target as HTMLInputElement).select()} />
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              このトークンはこの端末に保存されます。再ログインや別端末利用時に必要です。
              （カスタマイズ画面でいつでも再表示・他端末への引継ぎ URL が生成できます）
            </div>
          </div>
          <button onClick={() => applyToken(result.device_token)}>
            続ける
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1>在庫管理システム</h1>
        <div className="inline" style={{
          gap: 0, marginBottom: 16,
          borderBottom: '1px solid var(--border)',
        }}>
          <button
            type="button"
            onClick={() => { setMode('new'); setError(null) }}
            style={{
              flex: 1,
              padding: '8px 12px',
              background: mode === 'new' ? 'var(--accent)' : 'transparent',
              color: mode === 'new' ? 'var(--header-text)' : 'var(--text)',
              border: 'none',
              borderBottom: mode === 'new' ? '2px solid var(--primary)' : '2px solid transparent',
              borderRadius: 0,
              cursor: 'pointer',
              fontWeight: mode === 'new' ? 600 : 400,
            }}
          >
            新規デバイス登録
          </button>
          <button
            type="button"
            onClick={() => { setMode('paste'); setError(null) }}
            style={{
              flex: 1,
              padding: '8px 12px',
              background: mode === 'paste' ? 'var(--accent)' : 'transparent',
              color: mode === 'paste' ? 'var(--header-text)' : 'var(--text)',
              border: 'none',
              borderBottom: mode === 'paste' ? '2px solid var(--primary)' : '2px solid transparent',
              borderRadius: 0,
              cursor: 'pointer',
              fontWeight: mode === 'paste' ? 600 : 400,
            }}
          >
            既存トークンで入る
          </button>
        </div>

        {error && <div className="alert error">{error}</div>}

        {mode === 'new' && (
          <form onSubmit={submit}>
            <p className="muted" style={{ marginTop: 0 }}>
              この端末を新しく登録します。最初の登録は管理者として自動承認されます。
              既に他端末で登録済の場合は「既存トークンで入る」タブから移行できます。
            </p>
            <div className="field">
              <label>表示名（担当者名など）</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例: 山田太郎"
                autoFocus
              />
            </div>
            <button type="submit" disabled={busy || !name.trim()}>
              {busy ? '登録中…' : 'デバイスを登録'}
            </button>
          </form>
        )}

        {mode === 'paste' && (
          <form onSubmit={submitPaste}>
            <p className="muted" style={{ marginTop: 0 }}>
              他端末で取得したデバイストークンを貼り付けます。
              トークンはカスタマイズ画面から取得できます。<br/>
              <span style={{ fontSize: 11 }}>
                ※ ヒント: URL に <code>?token=XXX</code> を付けても自動で取り込めます。
              </span>
            </p>
            <div className="field">
              <label>デバイストークン</label>
              <input
                value={pasteToken}
                onChange={(e) => setPasteToken(e.target.value)}
                placeholder="例: 1OBO_9NMQ0RkV6...bHU"
                autoFocus
                style={{ fontFamily: 'var(--font-mono)' }}
              />
            </div>
            <button type="submit" disabled={busy || pasteToken.trim().length < 10}>
              {busy ? '確認中…' : 'このトークンで入る'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
