/**
 * LotEditCells
 * =============
 * DashboardPage の ロット表 で 使う インライン編集セル と セル描画 helper。
 *
 * 旧: DashboardPage.tsx 内 に inline 定義 されていたが、 ファイルが 1000+ 行 に
 *     肥大化 していたため 独立コンポーネント に 切り出した。
 *
 * 公開:
 *   - NumberCellInput / DateCellInput: 単体 input UI (Enter/Esc 対応)
 *   - renderDateEditCell / renderMoneyEditCell:
 *     ロット 1 行 の 1 セル 全体 (td) を 編集モード/表示モード で 切替
 *
 * 使い方:
 *   renderMoneyEditCell('unit_price', lot, editing, setEditing, patchLot)
 */
import { useState } from 'react'
import { ymd, yen } from '../lib/format'
import type { LotStock } from '../api/types'

export type LotEditField = string
export type EditingLot = { lotId: number; field: LotEditField } | null
export type PatchFn = (lotId: number, patch: Record<string, unknown>) => void

/** 数値入力セル — Enter / blur で 保存、 Esc キャンセル */
export function NumberCellInput({
  initial, onSave, onCancel,
}: {
  initial: string | number | null | undefined
  onSave: (v: number | null) => void
  onCancel: () => void
}) {
  const [v, setV] = useState(initial == null ? '' : String(initial))
  return (
    <input
      type="number"
      autoFocus
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        const n = v === '' ? null : Number(v)
        onSave(Number.isFinite(n as number) || n === null ? n : null)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        else if (e.key === 'Escape') { e.preventDefault(); onCancel() }
      }}
      style={{ width: '100%', padding: '2px 6px', textAlign: 'right', fontSize: 12, height: 24 }}
    />
  )
}

/** 日付入力セル */
export function DateCellInput({
  initial, onSave, onCancel,
}: {
  initial: string | null | undefined
  onSave: (v: string | null) => void
  onCancel: () => void
}) {
  const [v, setV] = useState(initial ?? '')
  return (
    <input
      type="date"
      autoFocus
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => onSave(v === '' ? null : v)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        else if (e.key === 'Escape') { e.preventDefault(); onCancel() }
      }}
      style={{ width: '100%', padding: '2px 6px', fontSize: 12, height: 24 }}
    />
  )
}

export function renderDateEditCell(
  field: LotEditField, l: LotStock,
  editing: EditingLot, setEditing: (v: EditingLot) => void,
  patchLot: PatchFn,
) {
  const isEditing = editing?.lotId === l.lot_id && editing.field === field
  const val = (l as unknown as Record<string, string | null>)[field] ?? null
  return (
    <td key={field} className="num"
        onClick={() => !isEditing && setEditing({ lotId: l.lot_id, field })}
        style={{ cursor: isEditing ? 'auto' : 'pointer' }}>
      {isEditing ? (
        <DateCellInput
          initial={val}
          onSave={(v) => patchLot(l.lot_id, { [field]: v })}
          onCancel={() => setEditing(null)}
        />
      ) : val ? ymd(val) : <span className="muted" style={{ fontSize: 11 }}>—</span>}
    </td>
  )
}

export function renderMoneyEditCell(
  field: LotEditField, l: LotStock,
  editing: EditingLot, setEditing: (v: EditingLot) => void,
  patchLot: PatchFn,
) {
  const isEditing = editing?.lotId === l.lot_id && editing.field === field
  const val = (l as unknown as Record<string, string | null>)[field]
  // 未入力の prepay/postpay は デフォルト値を計算して 仮値として表示 (= unit_price × total_kg)
  const defaultAmount = (field === 'prepay_amount' || field === 'postpay_amount')
    ? (l.unit_price && l.total_kg ? Number(l.unit_price) * Number(l.total_kg) : null)
    : null
  return (
    <td key={field} className="num"
        onClick={() => !isEditing && setEditing({ lotId: l.lot_id, field })}
        style={{ cursor: isEditing ? 'auto' : 'pointer' }}>
      {isEditing ? (
        <NumberCellInput
          initial={val ?? (defaultAmount ?? '')}
          onSave={(v) => patchLot(l.lot_id, { [field]: v })}
          onCancel={() => setEditing(null)}
        />
      ) : val != null ? yen(val) : (defaultAmount != null ? (
        <span className="muted" style={{ fontSize: 11 }} title="クリックで確定 (デフォルト = 単価×入荷量)">
          {yen(defaultAmount)}
        </span>
      ) : <span className="muted" style={{ fontSize: 11 }}>—</span>)}
    </td>
  )
}
