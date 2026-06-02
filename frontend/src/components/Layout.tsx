import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useAuth } from '../auth/AuthContext'
import FabNav from './FabNav'

/**
 * Layout — FAB ナビ式 (2026-05〜)
 *
 * 旧サイドバー + TabBar を FabNav (左上 ボタン + 半透明オーバーレイ 十字メニュー) に集約。
 * 画面右上に小さな アバター 円、 ホバー / タップで 詳細展開。
 */
export default function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth()
  const [pillExpanded, setPillExpanded] = useState(false)
  const pillRef = useRef<HTMLDivElement>(null)

  // 外側 クリックで閉じる (タッチで開いた後)
  useEffect(() => {
    if (!pillExpanded) return
    function onClick(e: MouseEvent) {
      if (pillRef.current && !pillRef.current.contains(e.target as Node)) {
        setPillExpanded(false)
      }
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [pillExpanded])

  // ユーザー名の頭文字 (アバター)
  const initial = (user?.display_name ?? '?').trim().charAt(0) || '?'

  return (
    <div className="app app-fabnav">
      <FabNav />

      {/* 右上 ユーザー アバター — 通常は丸、 ホバー / タップで詳細展開 */}
      <div
        ref={pillRef}
        className={'user-pill-avatar ' + (pillExpanded ? 'expanded' : '')}
        onMouseEnter={() => setPillExpanded(true)}
        onMouseLeave={() => setPillExpanded(false)}
      >
        <button
          type="button"
          className="avatar-circle"
          onClick={() => setPillExpanded((v) => !v)}
          aria-label={user?.display_name ?? 'ユーザー'}
          aria-expanded={pillExpanded}
        >{initial}</button>
        {pillExpanded && (
          <div className="avatar-popover">
            <div className="avatar-name">{user?.display_name}</div>
            <div className="avatar-role">{user?.role}</div>
            <button type="button" className="avatar-logout" onClick={logout}>
              ログアウト
            </button>
          </div>
        )}
      </div>

      <main className="main main-fabnav">
        {children}
      </main>
    </div>
  )
}
