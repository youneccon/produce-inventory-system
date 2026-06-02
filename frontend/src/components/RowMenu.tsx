/**
 * RowMenu — 行/オブジェクトを右クリックしたら出るコンテキストメニュー。
 *
 * 使い方:
 *   const menu = useRowMenu<Material>()
 *
 *   // テーブル行に
 *   <tr onContextMenu={(e) => menu.openAt(e, material)}>
 *
 *   // どこかに一度
 *   <RowMenu state={menu.state} onClose={menu.close} items={(m) => [
 *     { label: 'レシピ編集', onClick: () => nav(`/recipes?material_id=${m.id}`) },
 *     { label: '削除', danger: true, onClick: () => del(m) },
 *   ]} />
 *
 * 仕様:
 *   - 画面端で自動反転 (右端なら左展開、下端なら上展開)
 *   - 外側クリック / Esc / スクロール で閉じる
 *   - Tab/矢印で項目移動、Enter で実行
 *   - icon は任意の文字列 (絵文字 1 文字想定)
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'

export interface RowMenuItem {
  /** 表示ラベル */
  label: ReactNode
  /** 先頭に置く小アイコン (絵文字想定) */
  icon?: string
  /** クリック時の処理。実行後メニューは自動で閉じる */
  onClick: () => void | Promise<void>
  /** 灰色化して無効化 */
  disabled?: boolean
  /** 危険操作 (赤色強調) */
  danger?: boolean
  /** ホバー時の補足説明 */
  title?: string
  /** 上に区切り線を描く */
  divider?: boolean
}

export interface RowMenuState<T> {
  x: number
  y: number
  target: T
}

export function useRowMenu<T>() {
  const [state, setState] = useState<RowMenuState<T> | null>(null)
  function openAt(e: React.MouseEvent, target: T) {
    e.preventDefault()
    e.stopPropagation()
    setState({ x: e.clientX, y: e.clientY, target })
  }
  function close() { setState(null) }
  /** 「⋮」ボタンに使うヘルパー。ボタンの位置にメニューを開く (モバイル/タッチ対応) */
  function triggerButton(target: T, title = 'メニューを開く') {
    return (
      <button
        type="button"
        className="ghost small"
        onClick={(e) => {
          e.stopPropagation()
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
          setState({ x: r.right, y: r.bottom, target })
        }}
        title={title}
        style={{
          padding: '2px 6px', fontSize: 14, lineHeight: 1,
          background: 'transparent', border: 'none', cursor: 'pointer',
        }}
      >⋮</button>
    )
  }
  return { state, openAt, close, triggerButton }
}

interface Props<T> {
  state: RowMenuState<T> | null
  onClose: () => void
  items: (target: T) => RowMenuItem[]
}

export default function RowMenu<T>(p: Props<T>) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  // メニュー表示位置を計算 (画面端で反転)
  useEffect(() => {
    if (!p.state) { setPos(null); return }
    const { x, y } = p.state
    // 初期描画 → サイズ測定 → 位置調整
    requestAnimationFrame(() => {
      const el = ref.current
      if (!el) return
      const w = el.offsetWidth
      const h = el.offsetHeight
      const vw = window.innerWidth
      const vh = window.innerHeight
      const margin = 8
      let left = x
      let top = y
      if (left + w + margin > vw) left = Math.max(margin, x - w)
      if (top + h + margin > vh)  top  = Math.max(margin, y - h)
      setPos({ left, top })
    })
  }, [p.state])

  // 外側クリック / Esc / スクロール で閉じる
  useEffect(() => {
    if (!p.state) return
    const handleDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) p.onClose()
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') p.onClose()
    }
    const handleScroll = () => p.onClose()
    window.addEventListener('mousedown', handleDown)
    window.addEventListener('keydown', handleKey)
    window.addEventListener('scroll', handleScroll, true)
    return () => {
      window.removeEventListener('mousedown', handleDown)
      window.removeEventListener('keydown', handleKey)
      window.removeEventListener('scroll', handleScroll, true)
    }
  }, [p.state, p.onClose])

  if (!p.state) return null
  const items = p.items(p.state.target)

  return (
    <div
      ref={ref}
      role="menu"
      style={{
        position: 'fixed',
        left: pos?.left ?? p.state.x,
        top:  pos?.top  ?? p.state.y,
        // pos がまだ計算前は透明にして表示位置のチラつきを防ぐ
        visibility: pos ? 'visible' : 'hidden',
        zIndex: 9999,
        minWidth: 220,
        background: 'var(--surface, #fff)',
        border: '1px solid var(--border, #d0d4d8)',
        borderRadius: 6,
        boxShadow: '0 6px 24px rgba(0,0,0,0.15)',
        padding: '4px 0',
        fontSize: 13,
        userSelect: 'none',
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, idx) => (
        <div key={idx}>
          {it.divider && (
            <div style={{
              height: 1, background: 'var(--divider, #e2e6ea)',
              margin: '4px 0',
            }} />
          )}
          <div
            role="menuitem"
            aria-disabled={it.disabled}
            title={it.title}
            onClick={async () => {
              if (it.disabled) return
              await it.onClick()
              p.onClose()
            }}
            style={{
              padding: '6px 14px',
              cursor: it.disabled ? 'not-allowed' : 'pointer',
              color: it.disabled
                ? 'var(--muted, #9aa0a6)'
                : it.danger ? 'var(--danger, #c0392b)' : 'var(--text)',
              opacity: it.disabled ? 0.5 : 1,
              display: 'flex', alignItems: 'center', gap: 8,
            }}
            onMouseEnter={(e) => {
              if (it.disabled) return
              (e.currentTarget as HTMLDivElement).style.background =
                'var(--surface-soft, #f0f4f8)'
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLDivElement).style.background = 'transparent'
            }}
          >
            {it.icon && (
              <span style={{ width: 18, textAlign: 'center' }}>{it.icon}</span>
            )}
            <span style={{ flex: 1 }}>{it.label}</span>
          </div>
        </div>
      ))}
    </div>
  )
}
