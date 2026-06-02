// 1つの資材/ロットを複数オブジェクトに分散配置する際の表示量計算。
//
// 仕様:
//   - 合計残量 (current_stock) はバックエンドが返す。
//   - 各オブジェクトには capacity (上限) と priority (高いほど先に消費) がある。
//   - 配分: priority DESC でソートし、capacity 順に詰めていく。
//   - capacity が NULL のものは「制限なし」として最後に残りを全て受ける。
//
// 例: 合計 600kg
//      A (priority=80, capacity=200) → 200
//      B (priority=50, capacity=300) → 300
//      C (priority=30, capacity=NULL) → 100  (残り)
//
// 注意: 同じ material_id を持つアイテム群でグループ化して配分する。

import type { StorageObjectItem } from '../api/types'

export interface DistributedAmount {
  item_id: number
  amount: number      // この場所に按分された量
  capacity: number | null
  fill_ratio: number  // amount / capacity (0..1)。capacity=null なら 0
}

function num(v: string | number | null | undefined): number {
  if (v == null) return 0
  return typeof v === 'string' ? Number(v) : v
}

/** 同じ material_id (または inbound_lot_id) を共有するアイテム群を分配する。 */
export function distributeStock(items: StorageObjectItem[]): Map<number, DistributedAmount> {
  // グループ化: target identity → items
  const groups = new Map<string, StorageObjectItem[]>()
  for (const it of items) {
    const key = it.material_id != null
      ? `m:${it.material_id}`
      : `l:${it.inbound_lot_id}`
    const arr = groups.get(key) ?? []
    arr.push(it)
    groups.set(key, arr)
  }

  const result = new Map<number, DistributedAmount>()
  for (const [, group] of groups) {
    if (group.length === 0) continue
    let remaining = Math.max(0, num(group[0].current_stock))
    // priority DESC, タイブレーク: capacity 小 → 大
    const sorted = [...group].sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority
      const ca = a.capacity == null ? Infinity : a.capacity
      const cb = b.capacity == null ? Infinity : b.capacity
      return ca - cb
    })
    for (const it of sorted) {
      const cap = it.capacity == null ? Infinity : it.capacity
      const take = Math.min(remaining, cap)
      remaining -= take
      result.set(it.id, {
        item_id: it.id,
        amount: take,
        capacity: it.capacity,
        fill_ratio: it.capacity != null && it.capacity > 0 ? take / it.capacity : 0,
      })
    }
  }
  return result
}

/** オブジェクトの「在庫状態」分類 — 色決めに使う。 */
export type FillState = 'empty' | 'low' | 'mid' | 'full' | 'over' | 'unlinked'

export function fillState(item: StorageObjectItem, allocated: number): FillState {
  if (allocated <= 0) return 'empty'
  if (item.capacity == null) {
    // 容量未設定 → 残量があるかで判定
    return 'full'
  }
  const ratio = allocated / item.capacity
  if (ratio < 0.2) return 'low'
  if (ratio > 1.0) return 'over'
  if (ratio > 0.7) return 'full'
  return 'mid'
}

export const FILL_COLOR: Record<FillState, string> = {
  unlinked: '#94a3b8',  // gray
  empty:    '#fee2e2',  // red-100
  low:      '#fed7aa',  // orange-200
  mid:      '#bbf7d0',  // green-200
  full:     '#86efac',  // green-300
  over:     '#fcd34d',  // amber-300 (容量オーバー警告)
}
