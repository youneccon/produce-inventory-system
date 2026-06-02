/**
 * ColumnTogglePopover
 * ====================
 * DashboardPage 等で 使う 「表示列の切替」 ポップオーバー。
 *
 * 旧: DashboardPage.tsx 内 に inline 定義 されていたが、 ファイルが 1352 行 に
 *     肥大化 していたため 独立コンポーネント に 切り出した。
 *
 * 使い方:
 *   <ColumnTogglePopover
 *     defs={PRODUCT_COLUMNS}
 *     prefs={dash.product_columns}
 *     onChange={(next) => update({ ...prefs, dashboard: { ...dash, product_columns: next } })}
 *   />
 *
 * 仕様:
 *   - prefs が 空 → 全 col の defaultVisible で 表示制御
 *   - toggle で 該当 id のみ 反転、 prefs に 載っていない 列は その時 追加
 *   - クリック 外で 自動 close (mousedown 監視)
 */
import { useEffect, useRef, useState } from 'react'
import type { DashColumn } from '../lib/dashboardColumns'
import type { DashboardColumnPref } from '../api/types'

interface Props<T> {
  defs: DashColumn<T>[]
  prefs: DashboardColumnPref[] | undefined
  onChange: (next: DashboardColumnPref[]) => void
}

export default function ColumnTogglePopover<T>({ defs, prefs, onChange }: Props<T>) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [open])

  function isVisible(id: string): boolean {
    if (!prefs || prefs.length === 0) {
      return !!defs.find((d) => d.id === id)?.defaultVisible
    }
    const p = prefs.find((x) => x.id === id)
    if (!p) return !!defs.find((d) => d.id === id)?.defaultVisible
    return p.visible
  }

  function toggle(id: string) {
    if (!prefs || prefs.length === 0) {
      // 初回: 全列を defaultVisible で書き出し、対象列のみ反転
      const next = defs.map((d) => ({
        id: d.id,
        visible: d.id === id ? !d.defaultVisible : !!d.defaultVisible,
      }))
      onChange(next)
      return
    }
    const known = prefs.find((p) => p.id === id)
    if (known) {
      onChange(prefs.map((p) => p.id === id ? { ...p, visible: !p.visible } : p))
    } else {
      const def = defs.find((d) => d.id === id)
      onChange([...prefs, { id, visible: !def?.defaultVisible }])
    }
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        className="secondary small"
        onClick={() => setOpen((o) => !o)}
        title="表示する列を選択"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        ⚙ 列設定
      </button>
      {open && (
        <div className="popover" style={{ minWidth: 220 }} role="menu">
          <div className="popover-header">表示列の切替</div>
          <div className="popover-section">
            {defs.map((c) => (
              <label key={c.id} className="popover-item">
                <input
                  type="checkbox"
                  checked={isVisible(c.id)}
                  onChange={() => toggle(c.id)}
                  style={{ width: 'auto' }}
                />
                <span>{c.label}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
