/**
 * PackBreakdown — 数量 (qty) を「ケース数 + 端数」に分解表示する小さなチップ。
 *
 * 動作:
 *   - packSize 未設定 (null/0) → 「入り数を設定」インライン入力ボックス
 *     入力 → onSetPackSize(value) コールバック (非同期 PATCH を呼ぶ親側)
 *   - packSize 設定済 + qty > 0 → 「= X ケース + Y {unit}」
 *   - packSize 設定済 + qty 空/0   → 「1ケース = N {unit}」リマインダのみ
 *
 * 重要: pack_size は表示用ヘルパーで、qty (実数量) には一切影響しない。
 *   入荷/出庫の数値は qty のままサーバへ送られる。
 */
import { useState } from 'react'
import { num } from '../lib/format'

interface Props {
  /** 入力中の数量 (string or number)。空 or 非数値は無視 */
  qty: string | number | null | undefined
  /** 単位 (枚, 巻, 本, 個, ...). null/'' なら省略 */
  unit: string | null | undefined
  /** 現在の入り数 (null/0/undefined = 未設定 → インライン入力モード) */
  packSize: string | number | null | undefined
  /** 入り数を設定/変更したいときのコールバック (非同期 PATCH を内部で呼ぶ親側) */
  onSetPackSize?: (value: number) => Promise<void> | void
  /** 編集中フラグ (親が握る場合、ボタン disabled に使う) */
  busy?: boolean
  /** インラインスタイル */
  style?: React.CSSProperties
  /** コンパクト表示 (rowsで使う想定) */
  compact?: boolean
}

export default function PackBreakdown(p: Props) {
  const [editing, setEditing] = useState(false)
  const [input, setInput] = useState('')
  const [saving, setSaving] = useState(false)

  const packSizeNum = (() => {
    if (p.packSize == null || p.packSize === '') return null
    const n = Number(p.packSize)
    return Number.isFinite(n) && n > 0 ? n : null
  })()

  const qtyNum = (() => {
    if (p.qty == null || p.qty === '') return null
    const n = Number(p.qty)
    return Number.isFinite(n) ? n : null
  })()

  async function commit() {
    const v = Number(input)
    if (!Number.isFinite(v) || v <= 0) return
    setSaving(true)
    try {
      if (p.onSetPackSize) await p.onSetPackSize(v)
      setEditing(false)
      setInput('')
    } finally {
      setSaving(false)
    }
  }

  const fontSize = p.compact ? 10 : 11
  const unitLabel = p.unit ?? ''

  // ---- packSize 未設定 → インライン設定 UI ----
  if (packSizeNum == null) {
    if (editing) {
      return (
        <span style={{ display: 'inline-flex', gap: 3, alignItems: 'center', fontSize, ...p.style }}>
          <span className="muted">1ケース =</span>
          <input
            type="number" step="1" min="1"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commit() }
              if (e.key === 'Escape') { setEditing(false); setInput('') }
            }}
            placeholder={`例: 3000`}
            style={{ width: 70, padding: '1px 4px', fontSize }}
            autoFocus
            disabled={saving || p.busy}
          />
          <span className="muted">{unitLabel}</span>
          <button
            type="button" className="ghost small"
            onClick={commit}
            disabled={saving || p.busy || !input}
            style={{ padding: '1px 6px', fontSize }}
            title="保存 (Enter)"
          >✓</button>
          <button
            type="button" className="ghost small"
            onClick={() => { setEditing(false); setInput('') }}
            disabled={saving}
            style={{ padding: '1px 6px', fontSize }}
            title="キャンセル (Esc)"
          >×</button>
        </span>
      )
    }
    // 設定可能 → ボタン / 設定不可 (onSetPackSize 無し) → 何も出さない
    if (!p.onSetPackSize) return null
    return (
      <button
        type="button" className="ghost small"
        onClick={() => setEditing(true)}
        style={{ padding: '1px 6px', fontSize, ...p.style }}
        title="1ケース当たりの入り数を設定 (任意・表示用ヘルパー)"
      >
        ＋ 入り数を設定
      </button>
    )
  }

  // ---- packSize 設定済 → 分解表示 ----
  if (qtyNum == null || qtyNum === 0) {
    return (
      <span className="muted" style={{ fontSize, ...p.style }}>
        1ケース = {num(packSizeNum, 0)} {unitLabel}
        {p.onSetPackSize && (
          <button
            type="button"
            onClick={() => { setEditing(true); setInput(String(packSizeNum)) }}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--muted)', fontSize: fontSize - 1, marginLeft: 4,
              padding: 0, textDecoration: 'underline',
            }}
            title="入り数を変更"
          >✎</button>
        )}
      </span>
    )
  }

  // 端数計算 (整数想定だが小数も許容)
  const cases = Math.floor(qtyNum / packSizeNum)
  const remainder = qtyNum - cases * packSizeNum
  const isExact = remainder === 0

  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontSize, ...p.style }}>
      <span style={{
        background: 'var(--chip-bg, #e0e7ef)',
        padding: '1px 6px', borderRadius: 8,
      }}>
        = <strong>{num(cases, 0)}</strong> ケース
        {!isExact && (
          <>
            {' + '}
            <strong>{num(remainder, remainder % 1 === 0 ? 0 : 2)}</strong>{' '}
            {unitLabel}
          </>
        )}
        {isExact && <span style={{ marginLeft: 4 }}>(端数 0)</span>}
      </span>
      <span className="muted" style={{ fontSize: fontSize - 1 }}>
        ※1C={num(packSizeNum, 0)}
        {p.onSetPackSize && (
          <button
            type="button"
            onClick={() => { setEditing(true); setInput(String(packSizeNum)) }}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--muted)', fontSize: fontSize - 1, marginLeft: 2,
              padding: 0,
            }}
            title="入り数を変更"
          >✎</button>
        )}
      </span>
    </span>
  )
}
