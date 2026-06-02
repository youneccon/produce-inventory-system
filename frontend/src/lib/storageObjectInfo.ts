/**
 * storageObjectInfo.ts
 * ====================
 * オブジェクト 詳細 表示 (canvas + 集計表頁) 用 の info 行 生成 ヘルパー。
 *
 * 仕様 (user 合意 2026-05-24):
 *   - source priority: 紐付け (storage_object_items) を ベース、 棚卸エントリ が
 *     override (entry の 値 が non-null なら 上書き)
 *   - 複数 entry / 紐付け が 1 object に ある 場合 = 全部 表示 (複数 行)
 *   - 表示 内容: 規格 / 産地 / cases × kg/cs = total / 仕入先 / 入荷日
 */

import type { InventoryEntry, StorageObjectItem } from '../api/types'
import { formatSpecCombined } from './format'

/** lots fetch の 1 件 (StorageLayoutEditorPage 内 で 定義 されてる shape に 揃える) */
export interface LotInfo {
  lot_id: number
  kg_per_case?: string | number | null
  inbound_date?: string | null
  supplier_name?: string | null
}

function toNum(v: string | number | null | undefined): number | null {
  if (v == null) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function fmtNum(v: number | null, digits = 1): string | null {
  if (v == null) return null
  return v.toLocaleString('ja-JP', { maximumFractionDigits: digits })
}

function shortDate(s: string | null | undefined): string | null {
  if (!s) return null
  // 'YYYY-MM-DD' → 'YY/MM/DD'
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return s
  return `${m[1].slice(2)}/${m[2]}/${m[3]}`
}

/** item と entry が 同じ 在庫 を 指して いる か (ref FK の 一致) */
function matchesItem(item: StorageObjectItem, entry: InventoryEntry): boolean {
  if (item.inbound_lot_id != null && entry.inbound_lot_id === item.inbound_lot_id) return true
  if (item.material_id != null && entry.material_id === item.material_id) return true
  if (item.semifinished_lot_id != null && entry.semifinished_lot_id === item.semifinished_lot_id) return true
  return false
}

interface Merged {
  spec_type: string | null      // 台帳 元 規格 (元: 100g 等)
  grade: string | null
  size: string | null
  sub_spec: string | null
  origin: string | null
  supplier: string | null
  inbound_date: string | null
  cases: number | null
  kg_per_case: number | null
  total_kg: number | null
}

function fromItem(item: StorageObjectItem, lotInfo: Map<number, LotInfo>): Merged {
  if (item.inbound_lot_id != null) {
    const li = lotInfo.get(item.inbound_lot_id)
    const total = toNum(item.current_stock)
    const kpc = toNum(li?.kg_per_case ?? null)
    return {
      spec_type: item.lot_spec_type ?? null,
      grade:     item.lot_grade_level ?? null,
      size:      item.lot_size_label ?? null,
      sub_spec:  null,
      origin:    item.lot_origin_name ?? null,
      supplier:  li?.supplier_name ?? item.lot_supplier_name ?? null,
      inbound_date: li?.inbound_date ?? null,
      cases: kpc && total != null ? Math.round((total / kpc) * 100) / 100 : null,
      kg_per_case: kpc,
      total_kg: total,
    }
  }
  if (item.semifinished_lot_id != null) {
    const total = toNum(item.current_stock ?? item.semifin_base_kg ?? null)
    return {
      spec_type: item.semifin_spec_type ?? null,
      grade:     null,
      size:      null,
      sub_spec:  null,
      origin:    item.semifin_origin_name ?? null,
      supplier:  null,
      inbound_date: null,
      cases: null, kg_per_case: null, total_kg: total,
    }
  }
  // material
  return {
    spec_type: item.material_unit ?? null,
    grade: null, size: null, sub_spec: null,
    origin: null,
    supplier: item.material_supplier ?? null,
    inbound_date: null,
    cases: toNum(item.current_stock),
    kg_per_case: null, total_kg: null,
  }
}

function fromEntry(e: InventoryEntry): Merged {
  return {
    spec_type: e.spec_text,
    grade: null, size: null,
    sub_spec: e.sub_spec_text,
    origin: e.origin_text,
    supplier: null,
    inbound_date: e.inventory_date,
    cases: e.cases,
    kg_per_case: e.kg_per_case,
    total_kg: e.total_kg,
  }
}

/** 紐付け に entry を 上書き 反映 (entry の non-null 値 が 優先) */
function override(base: Merged, entry: InventoryEntry): Merged {
  return {
    spec_type:    entry.spec_text     ?? base.spec_type,
    grade:        base.grade,
    size:         base.size,
    sub_spec:     entry.sub_spec_text ?? base.sub_spec,
    origin:       entry.origin_text   ?? base.origin,
    supplier:     base.supplier,
    inbound_date: base.inbound_date,
    cases:        entry.cases       ?? base.cases,
    kg_per_case:  entry.kg_per_case ?? base.kg_per_case,
    total_kg:     entry.total_kg    ?? base.total_kg,
  }
}

/**
 * 1 アイテム を 3 行 に 整形 (industry 推奨 max 3 行)。
 *   line 1: 産地 + 規格統合 (sub_spec があれば spec を 置換)
 *   line 2: cases × kg = total
 *   line 3: 仕入先 + 入荷日
 * 各行 空 なら 飛ばす。 結果 配列 (1〜3 要素)。
 */
function formatItemLines(m: Merged, prefix?: string): string[] {
  const out: string[] = []
  // line 1: 産地 + 規格統合
  const specCombined = formatSpecCombined(m.spec_type, m.grade, m.size, m.sub_spec, { fallback: '' })
  const head = [prefix, m.origin, specCombined].filter(Boolean).join(' ')
  if (head) out.push(head)
  // line 2: 数量
  const c = fmtNum(m.cases, 1)
  const kpc = fmtNum(m.kg_per_case, 1)
  const t = fmtNum(m.total_kg, 1)
  let qty: string | null = null
  if (c && kpc && t) qty = `${c}×${kpc}=${t}kg`
  else if (c && kpc) qty = `${c}×${kpc}kg`
  else if (t)       qty = `${t}kg`
  else if (c)       qty = `${c}cs`
  if (qty) out.push(qty)
  // line 3: 仕入先 + 入荷日
  const tail = [m.supplier, shortDate(m.inbound_date)].filter(Boolean).join(' ')
  if (tail) out.push(tail)
  return out
}

/**
 * 1 object 分 の 表示 行 を 生成。
 * @param items この object に 紐付け 済み の items
 * @param entries この object の 最新 entries (date filter 適用後)
 * @param lotInfo lot_id → 追加 info (kg_per_case / inbound_date / supplier)
 */
export function buildObjectInfoLines(
  items: StorageObjectItem[],
  entries: InventoryEntry[],
  lotInfo: Map<number, LotInfo>,
): string[] {
  const groups: string[][] = []   // 1 アイテム = 1 グループ (1〜3 行)
  const consumed = new Set<number>()

  for (const item of items) {
    const matched = entries.filter(e => matchesItem(item, e))
    if (matched.length === 0) {
      groups.push(formatItemLines(fromItem(item, lotInfo)))
    } else {
      const base = fromItem(item, lotInfo)
      for (const e of matched) {
        consumed.add(e.id)
        groups.push(formatItemLines(override(base, e)))
      }
    }
  }
  for (const e of entries) {
    if (consumed.has(e.id)) continue
    groups.push(formatItemLines(fromEntry(e), e.name ?? undefined))
  }
  // flatten: グループ間 に 区切り 用 空 文字 を 入れる (canvas / 表示 側 で 改行扱い)
  const lines: string[] = []
  groups.forEach((g, i) => {
    if (i > 0) lines.push('')   // separator
    lines.push(...g)
  })
  return lines
}

/**
 * layout 全体 用: object_id → 行 配列 の Map を 一気 に 作る。
 */
export function buildInfoLinesMap(
  itemsByObject: Map<number, StorageObjectItem[]>,
  entriesByObject: Map<number, InventoryEntry[]>,
  objectIds: number[],
  lotInfo: Map<number, LotInfo>,
): Map<number, string[]> {
  const out = new Map<number, string[]>()
  for (const oid of objectIds) {
    const items = itemsByObject.get(oid) ?? []
    const entries = entriesByObject.get(oid) ?? []
    if (items.length === 0 && entries.length === 0) continue
    const lines = buildObjectInfoLines(items, entries, lotInfo)
    if (lines.length > 0) out.set(oid, lines)
  }
  return out
}
