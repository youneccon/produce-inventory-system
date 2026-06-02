// 日次カレンダーのカラム定義
//
// 並び順の前提：
//   1. 左固定列群（identity 列）— spec / origin / inbound_date など、横スクロールで張り付き
//   2. 中央の日次出庫グリッド（変動）
//   3. 右側のサマリ列群（前月繰越 / 当月出庫 / 当月在庫 / 金額など）
//
// ユーザーは固定列群（leftまたはright）の表示・順序・色強調をカスタマイズできる。

import type { CalendarLot } from '../api/types'

export type ColumnSide = 'left' | 'right'

export interface CalendarColumnDef {
  id: string
  label: string
  side: ColumnSide
  numeric?: boolean
  /** ロット行の値を取り出す（rate=消費税率を引数として受け取る） */
  value: (lot: CalendarLot, rate: number) => string | number | null
  /** 数値表示時の小数桁 (default 1) */
  digits?: number
  /** 円表示 (¥プレフィックスを付ける) */
  asYen?: boolean
  /** デフォルト幅（CSS） */
  width?: string
  /** デフォルトで表示 */
  defaultVisible?: boolean
}

function num(v: string | null | undefined): number {
  if (v == null || v === '') return 0
  return Number(v)
}

function fmtProduct(lot: CalendarLot): string {
  // 規格表示: 「標準」 は省略、 grade/size の '-' も省略 (例: 標準 A L → AL)
  const parts: string[] = []
  if (lot.spec_type && lot.spec_type !== '標準') parts.push(lot.spec_type)
  if (lot.grade_level && lot.grade_level !== '-') parts.push(lot.grade_level)
  if (lot.size_label && lot.size_label !== '-') parts.push(lot.size_label)
  return (parts.join('') || '—') + ` / ${lot.origin_name}`
}

export const COLUMN_DEFS: CalendarColumnDef[] = [
  // ── 左固定列 ─────────────────────────────────────────────
  {
    id: 'lot_code', label: '整理番号', side: 'left',
    value: (l) => l.lot_code ?? String(l.lot_id),
    width: '90px', defaultVisible: true,
  },
  {
    id: 'product', label: '規格 / 産地', side: 'left',
    value: (l) => fmtProduct(l),
    width: '160px', defaultVisible: true,
  },
  {
    id: 'supplier', label: '仕入先', side: 'left',
    value: (l) => l.supplier_name,
    width: '120px', defaultVisible: false,
  },
  {
    id: 'inbound_date', label: '入荷日', side: 'left',
    value: (l) => l.inbound_date,
    width: '96px', defaultVisible: true,
  },
  {
    id: 'total_kg', label: '入庫量', side: 'left',
    numeric: true, digits: 0,
    value: (l) => num(l.total_kg),
    width: '80px', defaultVisible: true,
  },
  {
    id: 'kg_per_case', label: 'C/S重量', side: 'left',
    numeric: true, digits: 2,
    value: (l) => l.kg_per_case ? num(l.kg_per_case) : null,
    width: '80px', defaultVisible: true,
  },
  {
    id: 'unit_price', label: '単価', side: 'left',
    numeric: true, asYen: true, digits: 0,
    value: (l) => l.unit_price ? num(l.unit_price) : null,
    width: '90px', defaultVisible: true,
  },
  // 支払い 関連 (= lot 属性、 編集 可能 列 — DashboardPage と 同等)
  {
    id: 'prepay_date', label: '前払日', side: 'left',
    value: (l) => l.prepay_date ?? null,
    width: '96px', defaultVisible: false,
  },
  {
    id: 'prepay_amount', label: '前払金額', side: 'left',
    numeric: true, asYen: true, digits: 0,
    value: (l) => l.prepay_amount ? num(l.prepay_amount) : null,
    width: '110px', defaultVisible: false,
  },
  {
    id: 'postpay_date', label: '後払日', side: 'left',
    value: (l) => l.postpay_date ?? null,
    width: '96px', defaultVisible: false,
  },
  {
    id: 'postpay_amount', label: '後払金額', side: 'left',
    numeric: true, asYen: true, digits: 0,
    value: (l) => l.postpay_amount ? num(l.postpay_amount) : null,
    width: '110px', defaultVisible: false,
  },
  {
    id: 'carryover_kg', label: '前月繰越', side: 'left',
    numeric: true, digits: 0,
    value: (l) => num(l.carryover_kg),
    width: '90px', defaultVisible: true,
  },

  // ── 右サマリ列 ─────────────────────────────────────────
  {
    id: 'inbound_kg', label: '当月入荷', side: 'right',
    numeric: true, digits: 0,
    value: (l) => num(l.inbound_kg),
    width: '90px', defaultVisible: true,
  },
  {
    id: 'outbound_kg', label: '当月出庫', side: 'right',
    numeric: true, digits: 0,
    value: (l) => num(l.outbound_kg),
    width: '90px', defaultVisible: true,
  },
  {
    id: 'end_kg', label: '当月在庫', side: 'right',
    numeric: true, digits: 0,
    value: (l) => num(l.end_kg),
    width: '90px', defaultVisible: true,
  },
  // 仕入時の金額（= 入庫量 × 単価。仕入伝票の金額を再現する）
  {
    id: 'subtotal', label: '税抜仕入金額', side: 'right',
    numeric: true, asYen: true, digits: 0,
    value: (l) => l.unit_price ? num(l.unit_price) * num(l.total_kg) : null,
    width: '120px', defaultVisible: false,
  },
  {
    id: 'tax_8', label: '仕入消費税', side: 'right',
    numeric: true, asYen: true, digits: 0,
    value: (l, rate) =>
      l.unit_price ? Math.round(num(l.unit_price) * num(l.total_kg) * rate) : null,
    width: '110px', defaultVisible: false,
  },
  {
    id: 'total_amount', label: '仕入合計金額', side: 'right',
    numeric: true, asYen: true, digits: 0,
    value: (l, rate) =>
      l.unit_price ? Math.round(num(l.unit_price) * num(l.total_kg) * (1 + rate)) : null,
    width: '120px', defaultVisible: false,
  },
  // 在庫評価額（= 現在の残量 × 単価。今月末時点の在庫金額）
  {
    id: 'end_value', label: '在庫評価額', side: 'right',
    numeric: true, asYen: true, digits: 0,
    value: (l) => l.unit_price ? num(l.unit_price) * num(l.end_kg) : null,
    width: '120px', defaultVisible: false,
  },
]

export function columnDefById(id: string): CalendarColumnDef | undefined {
  return COLUMN_DEFS.find((c) => c.id === id)
}
