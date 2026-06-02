/**
 * PrintColumnSettings
 * ====================
 * 印刷レポート (CalendarPrintPage 等) で 使う 「列カスタマイズ」 ポップオーバー。
 *
 * 旧: CalendarPrintPage.tsx 内 に inline 定義 されていたが、 ファイルが 1024 行 に
 *     肥大化 していたため 独立コンポーネント に 切り出した。
 *
 * 注: 在庫一覧 で 使う ColumnTogglePopover (components/ColumnTogglePopover.tsx)
 *     と は 別物 — こちら は 印刷UI (オレンジ アクセント + 既定に戻す ボタン付き)。
 *
 * 使い方:
 *   <PrintColumnSettings
 *     items={OPTIONAL_COLS.map(c => ({ id: c.id, label: c.label, groupLabel: GROUP_LABEL[c.group] }))}
 *     visibleCols={visibleCols}
 *     onToggle={(id) => ...}
 *     onReset={() => ...}
 *   />
 */
import { useState } from 'react'

export interface PrintColumnSettingsItem {
  id: string
  label: string
  groupLabel: string
}

interface Props {
  items: PrintColumnSettingsItem[]
  visibleCols: Set<string>
  onToggle: (id: string) => void
  onReset: () => void
}

export default function PrintColumnSettings({ items, visibleCols, onToggle, onReset }: Props) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          background: open ? '#ff8a00' : '#fff7e6',
          color: open ? '#fff' : '#a85a00',
          border: '2px solid #ff8a00', padding: '6px 14px',
          borderRadius: 4, cursor: 'pointer', fontWeight: 700,
        }}
      >
        ⚙ 列カスタマイズ ({visibleCols.size}列)
      </button>
      {open && (
        <>
          <div
            onClick={() => setOpen(false)}
            style={{
              position: 'fixed', inset: 0, zIndex: 50,
              background: 'transparent',
            }}
          />
          <div
            role="menu"
            style={{
              position: 'absolute', top: '110%', right: 0, zIndex: 51,
              width: 320, padding: 12, background: '#fff',
              border: '1px solid #ccc', borderRadius: 6,
              boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
              maxHeight: '70vh', overflowY: 'auto',
            }}
          >
            <div style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
              印刷する列を選択 (固定列は常時表示)
            </div>
            {items.map((c) => (
              <label key={c.id} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '4px 0', cursor: 'pointer', fontSize: 13,
              }}>
                <input
                  type="checkbox"
                  checked={visibleCols.has(c.id)}
                  onChange={() => onToggle(c.id)}
                  style={{ width: 'auto' }}
                />
                <span>{c.label}</span>
                <span style={{ marginLeft: 'auto', color: '#999', fontSize: 11 }}>
                  {c.groupLabel}
                </span>
              </label>
            ))}
            <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #eee', textAlign: 'right' }}>
              <button
                onClick={onReset}
                style={{
                  fontSize: 11, padding: '2px 8px',
                  background: 'transparent', border: '1px solid #ccc',
                  color: '#666', borderRadius: 3, cursor: 'pointer',
                }}
              >
                既定に戻す
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
