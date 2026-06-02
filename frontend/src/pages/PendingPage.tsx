import { useAuth } from '../auth/AuthContext'

export default function PendingPage() {
  const { refresh, logout } = useAuth()
  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1>承認待ち</h1>
        <div className="alert warn">
          このデバイスはまだ承認されていません。管理者に承認を依頼してください。
        </div>
        <p className="muted">
          管理者が「デバイス管理」画面で承認すると利用できるようになります。
        </p>
        <div className="inline">
          <button onClick={refresh}>承認状況を再確認</button>
          <button className="secondary" onClick={logout}>
            別の端末として登録し直す
          </button>
        </div>
      </div>
    </div>
  )
}
