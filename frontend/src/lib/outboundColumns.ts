/**
 * 出庫履歴 (OutboundPage 下部 テーブル) の 列 定義 + 表示 設定 helper。
 * dashboardColumns / calendarColumns と 同じ 思想 で、 順序 固定・表示 非表示 のみ
 * カスタマイズ。 localStorage で 永続 (ブラウザ ごと)。
 */

export interface OutboundColumn {
  id: string
  label: string
  numeric?: boolean
  defaultVisible: boolean
}

export const OUTBOUND_HISTORY_COLUMNS: OutboundColumn[] = [
  { id: 'outbound_date',   label: '出庫日',   defaultVisible: true },
  { id: 'lot_code',        label: '整理番号', defaultVisible: true },
  { id: 'inbound_date',    label: '入荷日',   defaultVisible: true },
  { id: 'spec',            label: '規格 / 産地', defaultVisible: true },
  { id: 'supplier_name',   label: '仕入先',   defaultVisible: true },
  { id: 'kg_per_case',     label: 'C/S重量',  numeric: true, defaultVisible: true },
  { id: 'quantity_kg',     label: '出庫量',   numeric: true, defaultVisible: true },
  { id: 'created_by_name', label: '担当',     defaultVisible: true },
  { id: 'note',            label: '備考',     defaultVisible: false },
]

const STORAGE_KEY = 'outbound-history-cols.v1'

/** localStorage から visible 列 集合 を 読み出す (= 既定 fallback)。 */
export function loadVisibleOutboundCols(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const arr = JSON.parse(raw) as string[]
      return new Set(arr)
    }
  } catch { /* noop */ }
  return new Set(OUTBOUND_HISTORY_COLUMNS.filter(c => c.defaultVisible).map(c => c.id))
}

/** localStorage に visible 列 集合 を 保存。 */
export function saveVisibleOutboundCols(ids: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]))
  } catch { /* noop */ }
}

/** 既定 set に リセット。 */
export function resetOutboundCols(): Set<string> {
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* noop */ }
  return new Set(OUTBOUND_HISTORY_COLUMNS.filter(c => c.defaultVisible).map(c => c.id))
}
