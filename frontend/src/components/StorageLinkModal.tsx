/**
 * StorageLinkModal
 * ================
 * 置き場オブジェクトと在庫 (資材 or 原料ロット) の紐付けを編集するモーダル。
 *
 * UX: Linear/Notion 風の inline list picker
 *   - 上部: 検索 input + フィルタ chip (作物・規格 / 事業部・カテゴリ)
 *   - 中段: 候補ロット (or 資材) のインラインリスト, 行クリック=即追加
 *   - 下段: 既存紐付け一覧 (容量・優先度をインライン編集、 X で解除)
 *
 * 追加時は capacity=null (無制限), priority=50 で即時 INSERT。
 * 詳細調整は下段で行う (即時反映)。
 */

import { useEffect, useMemo, useState, useRef } from 'react'
import { Package, X, Search, Check, Pencil, Plus, Trash2 } from 'lucide-react'
import Tooltip from './Tooltip'
import { useDialog } from './Dialog'
import { num } from '../lib/format'
import { tokenize, matchesAllTokens } from '../lib/search'
import { stackShapeText, kgToCases, casesFromPalletTiersLoose, palletInputsFromCases } from '../lib/palletStack'
import Combobox from './Combobox'
import type {
  InventoryEntry, InventoryEntryCreate, InventoryEntryUpdate, EntrySuggestions,
  StocktakeAdjustRequest, StocktakeAdjustResult, StocktakeAdjustItem,
} from '../api/types'

export interface StorageLinkItem {
  id: number
  material_id?: number | null
  inbound_lot_id?: number | null
  // 表示用属性
  material_code?: string
  material_name?: string
  material_supplier?: string
  lot_code?: string
  lot_spec_type?: string
  lot_grade_level?: string
  lot_size_label?: string
  lot_origin_name?: string
  lot_supplier_name?: string
  lot_inbound_date?: string
  /** lot の 作物 (= 借り判定 用)。 layout.division と 異なれば 「借り」 */
  lot_crop_id?: number | null
  lot_crop_name?: string | null
  /** ロットの 1 ケース kg (パレット形分解用) */
  kg_per_case?: string | number | null
  current_stock?: string | number | null
  capacity: number | null
  priority: number
  /** この object に 按分 された 量 (= distributeStock の 結果)。 パレット 行 で
   *  「ここに M kg ≒ N段+Kケ」 表示 用。 親 から 渡される。 */
  allocated_kg?: number
  /** [旧 model] パレ別 詳細。 deprecated (= 新 model で 1 行 = 1 パレ に 分解)。 */
  pallet_details?: { t: number; c: number }[] | null
  /** [新 model] object 内 の パレット 位置 (0..N-1)。 ingredient pallet 用。
   *  NULL = 旧 model 行 (= 表示 互換 のみ、 編集 は 削除→再作成)。 */
  pallet_index?: number | null
  tier_count?: number | null
  case_count?: number | null
}

export interface MaterialOption {
  material_id: number
  code: string
  item_name: string
  supplier_name: string
  remaining_qty: string | number
  unit?: string | null
  division?: number | null
  category?: string | null
}

export interface LotOption {
  lot_id: number
  code: string | null
  spec_type: string
  grade_level?: string
  size_label?: string
  origin_name: string
  remaining_kg: string | number
  crop_id?: number | null
  crop_name?: string | null
  inbound_date?: string | null
  supplier_name?: string | null
  /** パレット計算用 (省略時は形分解非表示) */
  kg_per_case?: string | number | null
  /** 置場 紐付け済 容量 (storage_object_items.capacity 合計、 全 layout 横断)。
   *  紐付け 可能 残数 = remaining_kg - bound_kg。 省略時 0 扱い。 */
  bound_kg?: string | number | null
}

interface Props {
  open: boolean
  onClose: () => void
  objectLabel: string
  objectId: number
  /** 物理 タイプ。 'pallet' (既定) は 従来 の パレット 計算 UI、
   *  'steel_container' は 1 紐付け = 1 コンテナ = ケース重量 mirror の
   *  シンプル UI に 切り替わる。 */
  objectType?: 'pallet' | 'steel_container'
  targetKind: 'material' | 'ingredient'
  layoutDivision?: number | null
  /** 空 パレット 追加 (= 新 model 用、 ingredient pallet object のみ)。
   *  pallet_index は app 側 で 自動採番。 */
  onAddEmptyPallet?: () => Promise<void>
  /** 空 スチール コンテナ 追加 (= 構造-主 refactor 2026-05-27、 steel_container のみ)。
   *  pallet_index を 流用 して 順序 を 持つ。 */
  onAddEmptyContainer?: () => Promise<void>
  existingItems: StorageLinkItem[]
  availableMaterials?: MaterialOption[]
  availableLots?: LotOption[]
  /** ロード中の表示用 (親が useFetch 等の状態を渡す) */
  loadingCandidates?: boolean
  /** エラー表示用 */
  candidatesError?: string | null
  busy: boolean
  onAdd: (params: {
    targetId: number | null
    capacity: number | null
    priority: number
    pallet_index?: number
    tier_count?: number
    case_count?: number
  }) => Promise<void>
  onUpdate: (itemId: number, patch: { capacity?: number | null; priority?: number; pallet_details?: { t: number; c: number }[] | null; pallet_index?: number | null; tier_count?: number | null; case_count?: number | null; inbound_lot_id?: number | null; material_id?: number | null; semifinished_lot_id?: number | null }) => Promise<void>
  onRemove: (itemId: number) => Promise<void>
  // ── 棚卸エントリ タブ (Phase A1) ──
  /** この object の 棚卸エントリ 一覧 (履歴 含む)。 親 が fetch。 undefined = 未対応 layout */
  inventoryEntries?: InventoryEntry[]
  /** 棚卸エントリ 作成/上書き (同 object 同日 同名 = upsert) */
  onEntryCreate?: (body: InventoryEntryCreate) => Promise<void>
  /** 棚卸エントリ 部分更新 */
  onEntryUpdate?: (entryId: number, patch: InventoryEntryUpdate) => Promise<void>
  /** 棚卸エントリ 削除 */
  onEntryDelete?: (entryId: number) => Promise<void>
  /** 棚卸フォーム Combobox の候補 (master + 既存 entries の 集約)。 null = まだ取得中 */
  entrySuggestions?: EntrySuggestions | null
  /** Phase A3: 棚卸 → 差数 → 調整出庫 (links タブ で 紐づけ済 lot/material に 棚卸数 を 入れて 自動 出庫) */
  onStocktakeAdjust?: (body: StocktakeAdjustRequest) => Promise<StocktakeAdjustResult>
}

const DIVISION_LABEL: Record<number, string> = {
  0: '未割当', 1: '生姜', 2: '大蒜', 3: '長芋', 4: '牛蒡', 5: '薩摩芋', 6: '物流',
}

const PRIORITY_DEFAULT = 50

// ─── スタイル: chip ───
function chipStyle(active: boolean): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '4px 10px',
    fontSize: 12,
    lineHeight: 1.3,
    borderRadius: 999,
    border: `1px solid ${active ? 'var(--primary)' : 'var(--border)'}`,
    background: active ? 'var(--primary-light)' : 'transparent',
    color: active ? 'var(--primary)' : 'var(--text-secondary)',
    fontWeight: active ? 600 : 500,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    transition: 'background 120ms ease, border-color 120ms ease, color 120ms ease',
  }
}


export default function StorageLinkModal({
  open, onClose,
  objectLabel, objectId, objectType = 'pallet', targetKind,
  layoutDivision,
  existingItems, availableMaterials, availableLots,
  loadingCandidates, candidatesError,
  busy, onAdd, onUpdate, onRemove,
  inventoryEntries, onEntryCreate, onEntryUpdate, onEntryDelete,
  entrySuggestions, onStocktakeAdjust,
  onAddEmptyPallet, onAddEmptyContainer,
}: Props) {

  // 過剰紐付け 警告 等 で 使う dialog (確認 ポップアップ)
  const dialog = useDialog()
  // 「パレ別 詳細」 を 展開中 の item id 集合。 開いて いる 行 が ある と、
  // 配置タブ では 候補リスト を 隠して 編集 に 集中 (= 視界 広く)。
  const [expandedDetailIds, setExpandedDetailIds] = useState<Set<number>>(new Set())
  const hasAnyExpanded = expandedDetailIds.size > 0
  function toggleExpandDetail(id: number) {
    setExpandedDetailIds(prev => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id); else n.add(id)
      return n
    })
  }

  // ─── タブ (3 系統 整理 2026-05-26): 配置 / 棚卸調整 / フリー棚卸 ───
  // 旧 「紐付け」 タブ を 「配置 (binding 管理)」 と 「棚卸調整 (A3)」 に 分割。
  // 「フリー棚卸」 (= 在庫に 紐づか ない 商品/半製品 等 の 自由入力) は binding が
  // 1 件 でも あれば 内容 を ロック (= 排他ルール、 ただし タブ 自体 は 常時表示
  // で 「タブ が 消えた!」 という 唐突さ を 解消)。
  const entriesEnabled =
    !!(onEntryCreate && onEntryUpdate && onEntryDelete && inventoryEntries !== undefined)
  const freeTabLocked = existingItems.length > 0  // binding あり = フリー入力 不可
  type Tab = 'placement' | 'stocktake' | 'free'
  const [activeTab, setActiveTab] = useState<Tab>('placement')
  // 棚卸調整 タブ は binding 0 件 で 内容 案内 のみ なので 自動遷移 不要。
  // フリー棚卸 は ロック しても 表示 する ので 自動遷移 不要。

  // ingredient (pallet も steel_container も) は 配置 タブ で 構造編集 だけ を 出す。
  // ロット 紐付け は 空 パレ/コンテナ 行 の 「+ ロット 紐付け」 → ミニピッカー で 行う
  // (構造-主 refactor 2026-05-26〜27)。 material のみ 候補リスト を 下部 に 残す。
  const isStructureFirst = targetKind === 'ingredient'

  // 空 パレ に ロット を 紐付け する ミニピッカー の 対象 item (null = 非表示)
  const [bindingPickerForItem, setBindingPickerForItem] = useState<StorageLinkItem | null>(null)

  // ─── フィルタ state ───
  const [filterDivision, setFilterDivision] = useState<number | 'all'>(
    layoutDivision != null ? layoutDivision : 'all')
  const [filterCategory, setFilterCategory] = useState<string>('')
  const [filterCrop, setFilterCrop] = useState<number | 'main' | 'all'>('main')
  const [filterSpec, setFilterSpec] = useState<string>('')
  const [searchQuery, setSearchQuery] = useState<string>('')
  // 在庫 0 の lot を 候補リスト に 出すか (デフォルト 非表示)。
  // 「基本 在庫 ない 規格 を 紐付け しても 仕方ない」 のが 通常 ケース、 だが
  // 過去 ロット を 振り戻し したい 等 の 稀 ケース は toggle で 解除可。
  const [showEmptyStockLots, setShowEmptyStockLots] = useState(false)
  const [addingId, setAddingId] = useState<number | null>(null)

  // ─── 棚卸 (Phase A3): 各 link に対する 棚卸数 (kg)。 key = `lot:N` / `mat:N` ───
  const [stocktakeCounts, setStocktakeCounts] = useState<Record<string, string>>({})
  const [stocktakePreview, setStocktakePreview] =
    useState<StocktakeAdjustResult | null>(null)
  const [stocktakeSubmitting, setStocktakeSubmitting] = useState(false)
  const stocktakeEnabled = !!onStocktakeAdjust && existingItems.length > 0

  // モーダル開時 / オブジェクト 切替時 に カウント を リセット
  useEffect(() => {
    if (!open) return
    setStocktakeCounts({})
    setStocktakePreview(null)
  }, [open, objectId])

  function linkKey(it: StorageLinkItem): string {
    // steel container (Phase 3 2026-05-27): per-row key (= 各 コンテナ 個別 棚卸)
    // pallet/material: per-lot/per-material 集約 key (= 既存 動作 維持)
    if (objectType === 'steel_container') return `id:${it.id}`
    return targetKind === 'ingredient' ? `lot:${it.inbound_lot_id}` : `mat:${it.material_id}`
  }

  // 入力された 棚卸数 が ある link を 抽出 (diff 計算 + プレビュー対象)
  // steel container (Phase 3): per-row、 current = それぞれ の 容量 (= per-container kg)
  // pallet/material: per-lot、 current = lot/material の 全社 残量 (= current_stock)
  // どちら も 空 row (lot/material 紐付け なし) は スキップ — 棚卸 対象 ない。
  const stocktakeItems = useMemo(() => {
    if (!stocktakeEnabled) return []
    const isContainer = objectType === 'steel_container'
    const out: { it: StorageLinkItem; counted: number; current: number; diff: number }[] = []
    for (const it of existingItems) {
      if (it.inbound_lot_id == null && it.material_id == null) continue
      const raw = stocktakeCounts[linkKey(it)]
      if (raw == null || raw.trim() === '') continue
      const counted = Number(raw)
      if (!Number.isFinite(counted) || counted < 0) continue
      const current = isContainer
        ? Number(it.capacity ?? 0)
        : Number(it.current_stock ?? 0)
      out.push({ it, counted, current, diff: current - counted })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingItems, stocktakeCounts, stocktakeEnabled, targetKind, objectType])

  const stocktakeSummary = useMemo(() => {
    let outboundKg = 0
    let warnOver = 0
    let noop = 0
    for (const s of stocktakeItems) {
      if (s.diff > 0) outboundKg += s.diff
      else if (s.diff < 0) warnOver += 1
      else noop += 1
    }
    return { outboundKg, warnOver, noop, total: stocktakeItems.length }
  }, [stocktakeItems])

  // steel container (Phase 3): per-row 入力 を per-lot 集約 して API に 送る。
  // pallet/material: そのまま per-lot で 送信 (= 既存 動作)。
  // counted_kg は 「lot の 新 総量」 を 期待 する。 per-row diff を 合計 し、
  // lot の current_stock から 引いて 新 総量 を 算出。
  function aggregateForApi(): StocktakeAdjustItem[] {
    if (objectType !== 'steel_container') {
      return stocktakeItems.map((s) => ({
        inbound_lot_id: targetKind === 'ingredient' ? s.it.inbound_lot_id : null,
        material_id:    targetKind === 'material'   ? s.it.material_id    : null,
        counted_kg:     s.counted,
      }))
    }
    // per-lot aggregation for steel container
    const byLot = new Map<number, { lotCurrent: number; diffSum: number }>()
    const byMat = new Map<number, { lotCurrent: number; diffSum: number }>()
    for (const s of stocktakeItems) {
      const lot = s.it.inbound_lot_id
      const mat = s.it.material_id
      if (lot != null) {
        const e = byLot.get(lot) ?? { lotCurrent: Number(s.it.current_stock ?? 0), diffSum: 0 }
        e.diffSum += s.diff
        byLot.set(lot, e)
      } else if (mat != null) {
        const e = byMat.get(mat) ?? { lotCurrent: Number(s.it.current_stock ?? 0), diffSum: 0 }
        e.diffSum += s.diff
        byMat.set(mat, e)
      }
    }
    const out: StocktakeAdjustItem[] = []
    for (const [lotId, agg] of byLot) {
      out.push({
        inbound_lot_id: lotId, material_id: null,
        counted_kg: Math.max(0, agg.lotCurrent - agg.diffSum),
      })
    }
    for (const [matId, agg] of byMat) {
      out.push({
        inbound_lot_id: null, material_id: matId,
        counted_kg: Math.max(0, agg.lotCurrent - agg.diffSum),
      })
    }
    return out
  }

  async function runStocktakePreview() {
    if (!onStocktakeAdjust || stocktakeItems.length === 0) return
    setStocktakeSubmitting(true)
    try {
      const today = new Date().toISOString().slice(0, 10)
      const result = await onStocktakeAdjust({
        outbound_date: today, inventory_date: today,
        items: aggregateForApi(), dry_run: true,
      })
      setStocktakePreview(result)
    } finally {
      setStocktakeSubmitting(false)
    }
  }

  async function runStocktakeCommit() {
    if (!onStocktakeAdjust || stocktakeItems.length === 0) return
    setStocktakeSubmitting(true)
    try {
      const today = new Date().toISOString().slice(0, 10)
      await onStocktakeAdjust({
        outbound_date: today, inventory_date: today,
        items: aggregateForApi(), dry_run: false,
      })
      // steel container は per-container の capacity も 入力値 に 同期 更新
      // (= 棚卸 後 の 「この コンテナ に N kg」 を 永続化、 次回 表示 と 整合)
      if (objectType === 'steel_container') {
        for (const s of stocktakeItems) {
          if (Math.abs(s.diff) > 0.005) {
            await onUpdate(s.it.id, { capacity: s.counted })
          }
        }
      }
      // 成功 → state クリア + モーダル閉じる前 に 確認
      setStocktakeCounts({})
      setStocktakePreview(null)
    } finally {
      setStocktakeSubmitting(false)
    }
  }

  const searchInputRef = useRef<HTMLInputElement | null>(null)

  // ─── モーダル開時の初期化 ───
  useEffect(() => {
    if (!open) return
    setFilterDivision(layoutDivision != null ? layoutDivision : 'all')
    setFilterCategory('')
    setFilterCrop('main')
    setFilterSpec('')
    setSearchQuery('')
    // 検索フィールドに自動 focus
    setTimeout(() => searchInputRef.current?.focus(), 60)
  }, [open, layoutDivision])

  // ESC で閉じる
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onClose])

  // ─── 既に紐付け済み ID ───
  // ※ スチール コンテナ は 「1 紐付け = 1 コンテナ」 ルール で、 同じ ロット を
  //   複数 コンテナ 分 積む 運用 が ある (例: 16 個 = 16 件 binding)。 dedup を
  //   解除 して 候補リスト に 残し、 同じ 行 を 何度でも click できる ように。
  const linkedIds = useMemo(() => {
    if (objectType === 'steel_container') return new Set<number>()
    const s = new Set<number>()
    for (const it of existingItems) {
      const id = targetKind === 'material' ? it.material_id : it.inbound_lot_id
      if (id != null) s.add(id)
    }
    return s
  }, [existingItems, targetKind, objectType])

  // ─── 主作物 ID ───
  const mainCropId = useMemo(() => {
    if (layoutDivision == null || layoutDivision < 1 || layoutDivision > 5) return null
    return layoutDivision
  }, [layoutDivision])

  // ─── crop_id を返している API か (古い API は null) ───
  const hasCropInfo = useMemo(() =>
    (availableLots ?? []).some((l) => l.crop_id != null)
  , [availableLots])

  // ─── 資材候補 (フィルタ済み) ───
  const materialChoices = useMemo(() => {
    const tokens = tokenize(searchQuery)
    return (availableMaterials ?? [])
      .filter((m) => !linkedIds.has(m.material_id))
      .filter((m) => {
        if (filterDivision === 'all') return true
        const d = m.division ?? null
        return d === filterDivision || d === 0 || d == null
      })
      .filter((m) => !filterCategory || m.category === filterCategory)
      .filter((m) => !tokens.length || matchesAllTokens(
        `${m.code} ${m.item_name} ${m.supplier_name}`, tokens))
      .sort((a, b) => a.code.localeCompare(b.code))
  }, [availableMaterials, linkedIds, filterDivision, filterCategory, searchQuery])

  const categoryOptions = useMemo(() => {
    const set = new Set<string>()
    for (const m of availableMaterials ?? []) {
      if (filterDivision !== 'all') {
        const d = m.division ?? null
        if (d !== filterDivision && d !== 0 && d != null) continue
      }
      if (m.category) set.add(m.category)
    }
    return [...set].sort()
  }, [availableMaterials, filterDivision])

  // ─── ロット候補 (フィルタ済み) ───
  const cropFilteredLots = useMemo(() =>
    (availableLots ?? []).filter((l) => {
      if (linkedIds.has(l.lot_id)) return false
      // 在庫 0 以下 は デフォルト 非表示 (toggle で 表示可)
      if (!showEmptyStockLots && Number(l.remaining_kg) <= 0) return false
      if (!hasCropInfo) return true
      if (filterCrop === 'all') return true
      if (filterCrop === 'main') return mainCropId == null || l.crop_id === mainCropId
      return l.crop_id === filterCrop
    })
  , [availableLots, linkedIds, filterCrop, mainCropId, hasCropInfo, showEmptyStockLots])

  const lotChoices = useMemo(() => {
    const tokens = tokenize(searchQuery)
    return cropFilteredLots
      .filter((l) => !filterSpec || l.spec_type === filterSpec)
      .filter((l) => !tokens.length || matchesAllTokens(
        `${l.code ?? ''} ${l.crop_name ?? ''} ${l.spec_type ?? ''} ${l.grade_level ?? ''} ${l.size_label ?? ''} ${l.origin_name}`,
        tokens))
      .sort((a, b) => {
        if (mainCropId != null && filterCrop === 'all') {
          const aMain = a.crop_id === mainCropId ? 0 : 1
          const bMain = b.crop_id === mainCropId ? 0 : 1
          if (aMain !== bMain) return aMain - bMain
        }
        return Number(b.remaining_kg) - Number(a.remaining_kg)
      })
  }, [cropFilteredLots, filterSpec, searchQuery, mainCropId, filterCrop])

  const specOptions = useMemo(() => {
    const set = new Set<string>()
    for (const l of cropFilteredLots) {
      if (l.spec_type) set.add(l.spec_type)
    }
    return [...set].sort()
  }, [cropFilteredLots])

  // ─── 候補行クリック → 即追加 ───
  // スチール コンテナ の 場合:
  //   ・紐付け 可能 残数 (= remaining - bound) >= ケース重量 → capacity = ケース重量
  //   ・紐付け 可能 残数 <  ケース重量 → capacity = 残数 (端数 コンテナ)
  //   ・紐付け 可能 残数 <= 0 → **確認 dialog で 過剰紐付け 警告** (= 例外 ケース で
  //     しか 通らない よう に。 大量 click で 8,320kg ロット に 54 コンテナ 紐付け
  //     して しまう 事故 を 防ぐ)
  // material や kg_per_case 不明 lot は capacity=null。
  async function quickAdd(targetId: number) {
    if (busy || addingId != null) return
    let capacity: number | null = null
    if (objectType === 'steel_container' && targetKind === 'ingredient') {
      const lot = availableLots?.find((l) => l.lot_id === targetId)
      const kpc = lot ? Number(lot.kg_per_case) : NaN
      const rem = lot ? Number(lot.remaining_kg) : NaN
      const bound = lot ? Number(lot.bound_kg ?? 0) || 0 : 0
      const bindable = Math.max(0, (Number.isFinite(rem) ? rem : 0) - bound)
      if (Number.isFinite(kpc) && kpc > 0) {
        // 過剰紐付け 防止: bindable が 1 ケース 重量 の 10% 未満 (= 実質 0) なら 警告
        if (bindable < kpc * 0.1) {
          const lotLabel = lot?.code ?? `lot:${targetId}`
          const msg = bindable <= 0
            ? `${lotLabel} は 紐付け 可能 残数 が 0 kg です (在庫数 ${num(rem, 0)} kg、 既に ${num(bound, 0)} kg 紐付け済)。 過剰紐付け に なります が 続行 しますか?`
            : `${lotLabel} の 紐付け 可能 残数 は ${num(bindable, 1)} kg のみ です (1 ケース ${num(kpc, 0)} kg 未満)。 続行 すると 過剰紐付け に なります が、 よろしい ですか?`
          const ok = await dialog.confirm({
            title: '過剰紐付け の 警告',
            message: msg,
            okLabel: '続行',
          })
          if (!ok) return
        }
        if (bindable > 0 && bindable < kpc) {
          capacity = bindable
        } else {
          capacity = kpc
        }
      }
    }
    // ingredient pallet (非steel) → 新 model で 行 作成。 デフォルト 1 パレ 満杯
    // (= tier_count=7, case_count=0)。 capacity = 49 × kg_per_case で 同期。
    // pallet_index は 既存 max + 1。
    let palletIndex: number | undefined
    let tierCount: number | undefined
    let caseCount: number | undefined
    if (targetKind === 'ingredient' && objectType !== 'steel_container') {
      const lot = availableLots?.find((l) => l.lot_id === targetId)
      const kpc = lot ? Number(lot.kg_per_case) : NaN
      const hasKpcNow = Number.isFinite(kpc) && kpc > 0
      const maxIdx = Math.max(-1, ...existingItems.map(it =>
        it.tier_count != null ? (it.pallet_index ?? 0) : -1))
      palletIndex = maxIdx + 1
      tierCount = 7
      caseCount = 0
      if (hasKpcNow) capacity = 49 * kpc  // 1 パレ 満杯 = 49 ケ
    }
    setAddingId(targetId)
    try {
      await onAdd({
        targetId, capacity, priority: PRIORITY_DEFAULT,
        pallet_index: palletIndex,
        tier_count: tierCount,
        case_count: caseCount,
      })
    } finally {
      setAddingId(null)
    }
  }

  if (!open) return null

  const candidatesCount = targetKind === 'material' ? materialChoices.length : lotChoices.length
  // 候補データ全体の状況 (空・読込中・エラー・フィルタで除外、 を区別)
  const allCount = targetKind === 'material' ? (availableMaterials?.length ?? 0) : (availableLots?.length ?? 0)
  const dataMissing = targetKind === 'material' ? availableMaterials == null : availableLots == null
  const cropFilteredCount = targetKind === 'ingredient' ? cropFilteredLots.length : null

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(30, 24, 12, 0.40)',
        backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20,
      }}
    >
      <div
        style={{
          background: 'var(--panel)',
          color: 'var(--text)',
          borderRadius: 12,
          boxShadow: 'var(--shadow-lg)',
          width: 'min(820px, 95vw)',
          maxHeight: '88vh',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
          border: '1px solid var(--border)',
        }}
      >
        {/* ── ヘッダー ── */}
        <div style={{
          padding: '14px 18px 12px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 12,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
            <Package size={18} strokeWidth={1.6} aria-hidden style={{ flexShrink: 0, color: 'var(--muted)' }} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {objectLabel}
              </div>
              <div className="muted" style={{ fontSize: 11.5, marginTop: 1 }}>
                {targetKind === 'material' ? '資材' : '原料ロット'} の紐付け · 既存 {existingItems.length} 件
              </div>
            </div>
          </div>
          <Tooltip content="閉じる (Esc)">
            <button
              onClick={onClose}
              style={{
                background: 'transparent', border: 'none',
                cursor: 'pointer', color: 'var(--muted)', padding: 6,
                display: 'flex', alignItems: 'center', borderRadius: 8,
                boxShadow: 'none',
              }}
              aria-label="閉じる"
            ><X size={18} strokeWidth={1.6} /></button>
          </Tooltip>
        </div>

        {/* ── タブ セレクタ (3 系統 整理): 配置 / 棚卸調整 / フリー棚卸 ──
            entriesEnabled=false (旧 layout) は フリー棚卸 タブ なし。
            「フリー棚卸」 は binding 0 件 の とき のみ 表示 (= 排他ルール)。
            「棚卸調整」 は binding 0 件 でも 表示 だが、 中身 で 案内 を 出す。 */}
        <div style={{
          display: 'flex', gap: 0,
          padding: '0 14px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--surface)',
        }}>
          {(() => {
            const tabs: { key: Tab; label: string; locked?: boolean; visible: boolean }[] = [
              { key: 'placement', label: `配置 (${existingItems.length})`, visible: true },
              { key: 'stocktake', label: '棚卸調整', visible: true },
              { key: 'free', label: `フリー棚卸 (${inventoryEntries?.length ?? 0})`,
                visible: entriesEnabled, locked: freeTabLocked },
            ]
            return tabs.filter(t => t.visible).map(t => (
              <button
                key={t.key}
                onClick={() => setActiveTab(t.key)}
                style={{
                  all: 'unset',
                  cursor: 'pointer',
                  padding: '10px 16px',
                  fontSize: 13,
                  fontWeight: activeTab === t.key ? 600 : 500,
                  color: activeTab === t.key ? 'var(--primary)'
                    : t.locked ? 'var(--muted)' : 'var(--text-secondary)',
                  borderBottom: `2px solid ${activeTab === t.key ? 'var(--primary)' : 'transparent'}`,
                  marginBottom: -1,
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                }}
                title={t.locked ? '配置 が ある object では フリー棚卸 を 入力 できません' : undefined}
              >
                {t.locked && '🔒 '}{t.label}
              </button>
            ))
          })()}
        </div>

        {/* ════════ TAB 1: 配置 (binding 管理) ════════
            2 階層 構造 (user 提案 2026-05-26):
              ・候補から紐付け (candidates) — 検索 + 候補リスト full height
              ・構造編集 (structure)        — 既存 一覧 + 空パレ 追加 + 編集 full height
            空 パレ に ロット を 入れる の は 構造編集 から ミニピッカー で 行う。 */}
        {activeTab === 'placement' && (<>
        {/* ingredient pallet / steel_container は items=0 でも 「+ 追加」 ボタン
            を 出す ため、 セクション 自体 を 常時 表示。 */}
        {(existingItems.length > 0
          || (targetKind === 'ingredient' && objectType !== 'steel_container' && onAddEmptyPallet)
          || (targetKind === 'ingredient' && objectType === 'steel_container' && onAddEmptyContainer)) && (
          <div style={{
            padding: '0 14px 10px',
            background: 'var(--surface)',
            flex: '1 1 auto', minHeight: 0,
            display: 'flex', flexDirection: 'column',
          }}>
            <div style={{
              fontWeight: 600, fontSize: 10.5, color: 'var(--muted)',
              letterSpacing: '0.08em', textTransform: 'uppercase',
              padding: '8px 4px 4px',
              display: 'flex', alignItems: 'baseline', gap: 8,
            }}>
              <span>紐付け済 ({existingItems.length})</span>
              {objectType === 'steel_container' && (() => {
                // スチール コンテナ サマリ (構造-主 統一 2026-05-27):
                //   N コンテナ (うち M 空) · 合計 X kg
                const totalKg = existingItems.reduce(
                  (s, it) => s + (Number(it.capacity) || 0), 0)
                const emptyN = existingItems.filter(
                  it => it.inbound_lot_id == null && it.material_id == null).length
                return (
                  <span style={{
                    color: 'var(--primary)', fontWeight: 700,
                    fontSize: 10.5, letterSpacing: '0.04em',
                    textTransform: 'none',
                    fontVariantNumeric: 'tabular-nums',
                  }}>
                    = {existingItems.length} コンテナ
                    {emptyN > 0 && (
                      <span style={{ opacity: 0.7, fontWeight: 500, marginLeft: 3 }}>
                        (うち {emptyN} 空)
                      </span>
                    )}
                    {totalKg > 0 && <> · {num(totalKg, 1)} kg</>}
                  </span>
                )
              })()}
            </div>
            {/* 「+ パレット 追加」: ingredient pallet object 専用 (= 新 model 用)。
                pallet_index は app 側 で 自動採番。 lot 紐付け なし の 空 パレ を 追加。 */}
            {targetKind === 'ingredient' && objectType !== 'steel_container' && onAddEmptyPallet && (
              <button
                type="button"
                onClick={() => onAddEmptyPallet()}
                style={{
                  marginBottom: 6, padding: '6px 12px',
                  fontSize: 12, fontWeight: 600,
                  color: 'var(--primary)',
                  background: 'var(--primary-light, #fce4e1)',
                  border: '1px dashed var(--primary-tint)',
                  borderRadius: 6, cursor: 'pointer',
                  boxShadow: 'none', alignSelf: 'flex-start',
                }}
              >+ パレット 追加 (空)</button>
            )}
            {/* 「+ 空 コンテナ 追加」: steel_container 専用 (構造-主 refactor 2026-05-27)。
                空 行 (lot 紐付け なし) を 1 個 作る。 後 で 「+ ロット 紐付け」 で 実 lot を 入れる。 */}
            {targetKind === 'ingredient' && objectType === 'steel_container' && onAddEmptyContainer && (
              <button
                type="button"
                onClick={() => onAddEmptyContainer()}
                style={{
                  marginBottom: 6, padding: '6px 12px',
                  fontSize: 12, fontWeight: 600,
                  color: 'var(--primary)',
                  background: 'var(--primary-light, #fce4e1)',
                  border: '1px dashed var(--primary-tint)',
                  borderRadius: 6, cursor: 'pointer',
                  boxShadow: 'none', alignSelf: 'flex-start',
                }}
              >+ 空 コンテナ 追加</button>
            )}
            <div style={{
              display: 'flex', flexDirection: 'column', gap: 6,
              // サブ モード 分割 後: 構造編集 は full height を 使う ので flex で 残り 全部。
              flex: '1 1 auto', minHeight: 0,
              overflowY: 'auto',
            }}>
              {(() => {
                // 構造-主 統一 (2026-05-27): pallet も steel_container も 同じ ロジック で
                // per-row 表示。 旧 「集約 (× N コンテナ)」 表示 は 撤廃。
                // 並び順:
                //   ・新 model 行 (pallet_index あり) → pallet_index DESC (= 上 が 新規)
                //   ・steel container は id ASC (= 下 から 積む 順)。 一旦 DESC で 統一
                //     (= 「最近 追加 した もの が 上 に 来る」 が 操作 直後 に 見やすい)。
                //   ・旧 model 行 (pallet_index null) → 末尾
                const sorted = [...existingItems].sort((a, b) => {
                  const ai = a.pallet_index ?? (a.tier_count != null ? 0 : -1)
                  const bi = b.pallet_index ?? (b.tier_count != null ? 0 : -1)
                  // steel_container の 旧 行 で pallet_index/tier_count 両方 null の とき も
                  // id DESC で 並べる。
                  if (ai === -1 && bi === -1) return b.id - a.id
                  if (ai !== bi) return bi - ai
                  return b.id - a.id
                })
                return sorted.map((it) => {
                  // 空 行 判定: lot/material 紐付け なし。 pallet は 加えて tier_count 必要、
                  // steel_container は tier_count 関係 なし (= 1 行 = 1 コンテナ で 構造 単純)。
                  const isContainer = objectType === 'steel_container'
                  const isEmpty = targetKind === 'ingredient'
                    && it.inbound_lot_id == null
                    && it.material_id == null
                    && (isContainer || it.tier_count != null)
                  return (
                    <ExistingRow
                      key={it.id}
                      it={it}
                      targetKind={targetKind}
                      objectType={objectType}
                      objectLabel={objectLabel}
                      onUpdate={onUpdate}
                      onRemove={onRemove}
                      stocktakeEnabled={false}
                      detailExpanded={expandedDetailIds.has(it.id)}
                      onToggleDetail={() => toggleExpandDetail(it.id)}
                      onRequestBind={isEmpty ? () => setBindingPickerForItem(it) : undefined}
                    />
                  )
                })
              })()}
            </div>
          </div>
        )}
        {/* 空 状態 案内: 構造-主 (ingredient) では 「+ 空 パレ/コンテナ 追加」 ボタン が
            既に 上 に 出る ので 案内 不要。 material のみ 「下 の 候補リスト から」 案内。 */}
        {existingItems.length === 0 && !isStructureFirst && (
          <div className="muted" style={{ padding: 40, textAlign: 'center', fontSize: 13 }}>
            まだ 紐付け が ありません。<br />
            <span style={{ fontSize: 11.5, opacity: 0.8 }}>
              下 の 候補リスト から 選んで 追加 してください。
            </span>
          </div>
        )}

        {/* ── 候補 リスト (material / steel container 用)。 ingredient pallet は
            「空 パレ 追加 → ロット 紐付け ピッカー」 で 完結 する ので 非表示
            (= user 確認 2026-05-26 「構造編集 が 候補 を 完全 カバー」)。 ── */}
        {!isStructureFirst && !hasAnyExpanded && (<>
        <div style={{
          padding: '12px 18px 12px',
          borderBottom: '1px solid var(--border)',
        }}>
          {/* 検索 */}
          <div style={{ position: 'relative', marginBottom: 10 }}>
            <Search size={14} strokeWidth={1.7}
              style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)',
                       color: 'var(--muted)', pointerEvents: 'none' }} />
            <input
              ref={searchInputRef}
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={targetKind === 'material'
                ? '資材コード / 品名 / 仕入先 で検索 (空白区切で AND)'
                : '整理番号 / 規格 / 産地 で検索 (空白区切で AND)'}
              style={{ paddingLeft: 36, height: 36, fontSize: 13 }}
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                aria-label="検索クリア"
                style={{
                  position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  color: 'var(--muted)', padding: 4, display: 'flex', alignItems: 'center',
                  borderRadius: 6, boxShadow: 'none',
                }}
              ><X size={14} strokeWidth={1.8} /></button>
            )}
          </div>

          {/* フィルタ chip 列 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 12 }}>
            {targetKind === 'material' ? (
              <>
                <span className="muted" style={{ fontSize: 11, marginRight: 2 }}>事業部</span>
                <button style={chipStyle(filterDivision === 'all')}
                        onClick={() => setFilterDivision('all')}>全部署</button>
                {Object.entries(DIVISION_LABEL).map(([d, n]) => (
                  <button key={d}
                    style={chipStyle(filterDivision === Number(d))}
                    onClick={() => setFilterDivision(Number(d))}
                  >{n}{layoutDivision === Number(d) && ' ★'}</button>
                ))}
                {categoryOptions.length > 0 && (
                  <>
                    <span style={{ width: 1, height: 16, background: 'var(--border)', margin: '0 4px' }} />
                    <span className="muted" style={{ fontSize: 11, marginRight: 2 }}>カテゴリ</span>
                    <button style={chipStyle(filterCategory === '')}
                            onClick={() => setFilterCategory('')}>全て</button>
                    {categoryOptions.map((c) => (
                      <button key={c} style={chipStyle(filterCategory === c)}
                              onClick={() => setFilterCategory(c)}>{c}</button>
                    ))}
                  </>
                )}
              </>
            ) : (
              <>
                {/* 作物 chip は 削除 (2026-05-27 user 確認): layout は 事業部 = 作物 専用 で、
                    他作物 を 混ぜ ない。 cross-department は 将来 「倉庫 借り」 機能 で 対応。
                    主作物 への フィルタ は cropFilteredLots の useMemo で 自動 適用。 */}
                {specOptions.length > 0 && specOptions.length <= 20 && (
                  <>
                    <span className="muted" style={{ fontSize: 11, marginRight: 2 }}>規格</span>
                    <button style={chipStyle(filterSpec === '')}
                            onClick={() => setFilterSpec('')}>全て</button>
                    {specOptions.map((s) => (
                      <button key={s} style={chipStyle(filterSpec === s)}
                              onClick={() => setFilterSpec(s)}>{s}</button>
                    ))}
                    <span style={{ width: 1, height: 16, background: 'var(--border)', margin: '0 4px' }} />
                  </>
                )}
                {/* 在庫 0 含む toggle (デフォルト off = 在庫 0 を 隠す) */}
                <button
                  style={chipStyle(showEmptyStockLots)}
                  onClick={() => setShowEmptyStockLots(v => !v)}
                  title={showEmptyStockLots
                    ? '在庫 0 の lot も 表示中 (click で 非表示)'
                    : '在庫 0 の lot を 隠して います (click で 全表示)'}
                >{showEmptyStockLots ? '在庫 0 含む' : '在庫 0 除外'}</button>
              </>
            )}
          </div>
        </div>

        {/* ── 候補リスト (スクロール領域) ── */}
        <div style={{
          overflowY: 'auto', flex: '1 1 auto',
          minHeight: 200,
          padding: '4px 10px 8px',
        }}>
          {candidatesError ? (
            <div style={{
              padding: '24px 20px', textAlign: 'center', fontSize: 13,
              color: 'var(--danger)',
              background: 'var(--danger-bg)',
              border: '1px solid var(--danger-border)',
              borderRadius: 8,
              margin: 12,
            }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>候補の読み込みに失敗しました</div>
              <div style={{ fontSize: 12 }}>{candidatesError}</div>
            </div>
          ) : loadingCandidates || dataMissing ? (
            <div className="muted" style={{
              padding: '32px 20px', textAlign: 'center', fontSize: 13,
            }}>
              {targetKind === 'material' ? '資材' : 'ロット'} データを読み込み中…
            </div>
          ) : allCount === 0 ? (
            <div className="muted" style={{ padding: '32px 20px', textAlign: 'center', fontSize: 13 }}>
              {targetKind === 'material'
                ? 'システム上に資材が1件もありません'
                : 'システム上にロットが1件もありません (バックエンドが新しいレスポンス形式を返しているか確認してください)'}
            </div>
          ) : candidatesCount === 0 ? (
            <div className="muted" style={{
              padding: '32px 20px', textAlign: 'center', fontSize: 13,
            }}>
              <div style={{ marginBottom: 6 }}>
                {searchQuery
                  ? `「${searchQuery}」に一致する候補がありません`
                  : 'このフィルタに合致する候補がありません'}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                全体 {allCount} 件中、 既紐付け済を除いた候補
                {cropFilteredCount != null ? ` (作物フィルタ後 ${cropFilteredCount} 件)` : ''}{' '}
                — 「全作物」 / 「全部署」 chip でフィルタを外せます
              </div>
            </div>
          ) : targetKind === 'material' ? (
            materialChoices.slice(0, 200).map((m) => (
              <CandidateRow
                key={m.material_id}
                primary={`${m.code} ${m.item_name}`}
                secondary={m.supplier_name}
                tertiary={m.category ?? undefined}
                meta={`残 ${num(m.remaining_qty, 0)}${m.unit ?? ''}`}
                onClick={() => quickAdd(m.material_id)}
                adding={addingId === m.material_id}
              />
            ))
          ) : (
            lotChoices.slice(0, 200).map((l) => {
              const grade = l.grade_level && l.grade_level !== '-' ? l.grade_level : ''
              const size = l.size_label && l.size_label !== '-' ? l.size_label : ''
              const specParts = [l.spec_type, grade, size].filter(Boolean).join(' ')
              const cropTag = (filterCrop === 'all' && l.crop_name) ? `[${l.crop_name}] ` : ''
              // primary: 入荷日 + 仕入先 (整理番号 は 普段 覚えない の で 非表示、 2026-05-26)
              const headParts: string[] = []
              if (l.inbound_date) headParts.push(l.inbound_date)
              if (l.supplier_name) headParts.push(l.supplier_name)
              const headLine = headParts.join(' · ') || (l.code ?? `lot#${l.lot_id}`)
              // 2行目: 規格 · 産地
              const secondary = `${specParts} · ${l.origin_name}`
              // 3行目: (空欄)
              const tertiary: string | undefined = undefined
              // 在庫数 + 紐付け 可能 残数 (= remaining_kg - bound_kg)
              //   パレット: 「≒ 2段+2ケ」 (= stackShapeText)
              //   スチール コンテナ: 「= N コ満杯 + 1 コ未満端数 X kg」 (= ケース重量 mirror)
              const kpc = Number(l.kg_per_case)
              const hasKpc = Number.isFinite(kpc) && kpc > 0
              const stock = Number(l.remaining_kg)
              const boundKg = Number(l.bound_kg ?? 0) || 0
              const bindable = Math.max(0, stock - boundKg)

              function convertText(kg: number): string | null {
                if (!hasKpc || kg <= 0) return null
                if (objectType === 'steel_container') {
                  const full = Math.floor(kg / kpc)
                  const rem = kg - full * kpc
                  const parts: string[] = []
                  if (full > 0) parts.push(`${full} コ満杯`)
                  if (rem >= 0.05) parts.push(`1 コ未満端数 ${num(rem, 1)} kg`)
                  return parts.length > 0 ? `= ${parts.join(' + ')}` : null
                }
                const cases = kgToCases(kg, l.kg_per_case)
                if (cases == null || cases <= 0) return null
                return `≒ ${stackShapeText(cases)}`
              }

              // meta: 在庫数 (= 全社 ロット 残量)
              const metaPrimary = `在庫数 ${num(l.remaining_kg, 0)} kg`
              const metaPrimarySub = convertText(stock)
              // 紐付け 可能 残数 (= remaining - 全 layout 紐付け済) は 別 行 で 区別
              const metaSecondary = boundKg > 0
                ? `紐付け可能 ${num(bindable, 0)} kg`
                : null
              const metaSecondarySub = boundKg > 0 ? convertText(bindable) : null
              return (
                <CandidateRow
                  key={l.lot_id}
                  primary={`${cropTag}${headLine}`}
                  secondary={secondary}
                  tertiary={tertiary}
                  meta={metaPrimary}
                  metaSub={metaPrimarySub ?? undefined}
                  meta2={metaSecondary ?? undefined}
                  meta2Sub={metaSecondarySub ?? undefined}
                  onClick={() => quickAdd(l.lot_id)}
                  adding={addingId === l.lot_id}
                />
              )
            })
          )}
          {candidatesCount > 200 && (
            <div className="muted" style={{ padding: '8px 12px', fontSize: 11, textAlign: 'center' }}>
              … 先頭 200 件のみ表示 ({candidatesCount.toLocaleString()} 件中)。 検索で絞り込んでください。
            </div>
          )}
        </div>
        </>)}
        </>)}

        {/* ════════ TAB 2: 棚卸調整 (A3 stocktake-adjust) ════════
            配置済 lot/material に 棚卸 実測 kg を 入力 → 差数 計算 → 出庫 自動生成。
            binding 0 件 の とき は 案内 のみ。 */}
        {activeTab === 'stocktake' && (
          existingItems.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
              配置済 の 在庫 が ありません。<br />
              <span style={{ fontSize: 12 }}>
                「配置」 タブ で 先に lot/material を 紐付け してください。
              </span>
            </div>
          ) : (
            <div style={{
              padding: '0 14px 10px',
              borderBottom: '1px solid var(--border)',
              background: 'var(--surface)',
              flex: 1, overflowY: 'auto',
            }}>
              <div style={{
                fontWeight: 600, fontSize: 10.5, color: 'var(--muted)',
                letterSpacing: '0.08em', textTransform: 'uppercase',
                padding: '10px 4px 6px',
              }}>
                {objectType === 'steel_container'
                  ? `${existingItems.length} 件 — 各 コンテナ の 実測 kg を 入力 (Phase 3 per-container)`
                  : `配置済 ${existingItems.length} 件 — 棚卸 実測 kg を 入力`}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {existingItems.map((it) => (
                  <ExistingRow
                    key={it.id}
                    it={it}
                    targetKind={targetKind}
                    objectType={objectType}
                    objectLabel={objectLabel}
                    onUpdate={onUpdate}
                    onRemove={onRemove}
                    stocktakeEnabled={stocktakeEnabled}
                    stocktakeValue={stocktakeCounts[linkKey(it)] ?? ''}
                    onStocktakeChange={(v) => setStocktakeCounts((cur) => ({
                      ...cur, [linkKey(it)]: v,
                    }))}
                  />
                ))}
              </div>

              {/* 棚卸 → 調整出庫 サマリ + プレビュー ボタン */}
              {stocktakeEnabled && stocktakeSummary.total > 0 && (
                <div style={{
                  marginTop: 10, padding: '8px 10px',
                  background: 'var(--surface-soft, #F1F5F9)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  display: 'flex', alignItems: 'center', gap: 12,
                  fontSize: 12,
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <strong>棚卸 {stocktakeSummary.total} 件</strong>
                    {stocktakeSummary.outboundKg > 0 && (
                      <span style={{ marginLeft: 8, color: 'var(--warning-strong, #92400E)' }}>
                        調整出庫候補 {num(stocktakeSummary.outboundKg, 2)} kg
                      </span>
                    )}
                    {stocktakeSummary.warnOver > 0 && (
                      <span style={{ marginLeft: 8, color: 'var(--danger, #DC2626)' }}>
                        ⚠ 過剰 {stocktakeSummary.warnOver} 件
                      </span>
                    )}
                    {stocktakeSummary.noop > 0 && (
                      <span style={{ marginLeft: 8, color: 'var(--muted)' }}>
                        一致 {stocktakeSummary.noop} 件
                      </span>
                    )}
                  </div>
                  <button
                    onClick={runStocktakePreview}
                    disabled={stocktakeSubmitting || busy}
                    style={{ height: 28, padding: '0 12px', fontSize: 12, fontWeight: 600 }}
                  >プレビュー</button>
                </div>
              )}

              {!stocktakeEnabled && (
                <div className="muted" style={{
                  marginTop: 10, padding: '8px 10px',
                  background: 'var(--surface-soft, #F1F5F9)',
                  borderRadius: 6, fontSize: 11.5,
                }}>
                  棚卸調整 API が この layout で 利用できません。
                </div>
              )}
            </div>
          )
        )}

        {/* ════════ TAB 3: フリー棚卸 (B 系統 = inventory_entries) ════════
            在庫 紐付け なし の 商品/半製品 等 を 自由入力。 binding 1 件 でも
            あれば 入力 を ロック (= 排他 ルール、 ただし タブ 自体 は 常時表示)。 */}
        {activeTab === 'free' && entriesEnabled && (
          freeTabLocked ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>🔒</div>
              <div style={{ fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>
                配置 が あります — フリー棚卸 を 使えません
              </div>
              <div style={{ fontSize: 12, lineHeight: 1.7 }}>
                この object には 在庫 紐付け が <strong>{existingItems.length} 件</strong> 配置 されています。<br />
                棚卸 は 「棚卸調整」 タブ で 実測 kg を 入力 してください。<br />
                <span style={{ opacity: 0.7 }}>
                  フリー棚卸 を 使う なら、 まず 「配置」 タブ で 全 紐付け を 解除 してください。
                </span>
              </div>
            </div>
          ) : (
            <InventoryEntriesPanel
              objectId={objectId}
              entries={inventoryEntries ?? []}
              targetKind={targetKind}
              availableLots={availableLots}
              availableMaterials={availableMaterials}
              suggestions={entrySuggestions ?? null}
              hasExistingLinks={false}
              busy={busy}
              onCreate={onEntryCreate!}
              onUpdate={onEntryUpdate!}
              onDelete={onEntryDelete!}
            />
          )
        )}

        {/* ── フッター (subtle) ── */}
        <div style={{
          padding: '10px 18px',
          borderTop: '1px solid var(--border)',
          display: 'flex', justifyContent: 'space-between', gap: 8,
          alignItems: 'center',
        }}>
          <span className="muted" style={{ fontSize: 11 }}>
            {activeTab === 'placement' && isStructureFirst && objectType === 'steel_container'
              && '空 コンテナ 追加 → 「+ ロット 紐付け」 で バインド'}
            {activeTab === 'placement' && isStructureFirst && objectType !== 'steel_container'
              && '空 パレ 追加 → 「+ ロット 紐付け」 で バインド · 段ケ も 行内 編集 可'}
            {activeTab === 'placement' && !isStructureFirst
              && '行 クリック で 即 追加 · 即時 保存'}
            {activeTab === 'stocktake' && '棚卸 実測 kg を 入力 → プレビュー → 確定 で 出庫 自動生成'}
            {activeTab === 'free' && '在庫に 紐付か ない 商品/半製品 等 の フリー入力 · 同日 同名 は 上書き'}
          </span>
          <button
            className="ghost small"
            onClick={onClose}
            style={{ minWidth: 76 }}
          >閉じる</button>
        </div>
      </div>

      {/* 棚卸プレビュー モーダル (links タブ Phase A3) */}
      {stocktakePreview && (
        <StocktakePreviewModal
          result={stocktakePreview}
          busy={stocktakeSubmitting}
          onCancel={() => setStocktakePreview(null)}
          onConfirm={runStocktakeCommit}
        />
      )}

      {/* 空 パレ に ロット を 紐付け する ミニピッカー (= 構造編集 から 起動)。
          既存 の tier/case 構造 を 維持 し、 inbound_lot_id だけ セット する。 */}
      {bindingPickerForItem && targetKind === 'ingredient' && availableLots && (
        <LotBindingPicker
          targetItem={bindingPickerForItem}
          availableLots={availableLots}
          layoutDivision={layoutDivision}
          busy={busy}
          onClose={() => setBindingPickerForItem(null)}
          onSelect={async (lot) => {
            // capacity 計算 ロジック:
            //  ・パレ (tier_count あり): tier × 7 × kpc + case × kpc
            //  ・スチール コンテナ (tier_count なし): 1 コンテナ 分 = kpc (= ケース重量 mirror)
            //    残在庫 が kpc 未満 なら 残在庫 (= 端数 コンテナ)。
            //    紐付け 可能 残数 (= remaining - bound) を 見て 端数 判定。
            const kpc = Number(lot.kg_per_case)
            const hasKpc = Number.isFinite(kpc) && kpc > 0
            let cap: number | null = null
            if (objectType === 'steel_container') {
              if (hasKpc) {
                const rem = Number(lot.remaining_kg) || 0
                const bound = Number(lot.bound_kg ?? 0) || 0
                const bindable = Math.max(0, rem - bound)
                cap = (bindable > 0 && bindable < kpc) ? bindable : kpc
              }
            } else {
              const tier = bindingPickerForItem.tier_count ?? 0
              const cs = bindingPickerForItem.case_count ?? 0
              const totalCases = tier * 7 + cs
              cap = (hasKpc && totalCases > 0) ? totalCases * kpc : null
            }
            await onUpdate(bindingPickerForItem.id, {
              inbound_lot_id: lot.lot_id,
              capacity: cap,
            })
            setBindingPickerForItem(null)
          }}
        />
      )}
    </div>
  )
}


// ─── 候補行 (clickable card) ───
function CandidateRow({ primary, secondary, tertiary, meta, metaSub,
                       meta2, meta2Sub, onClick, adding }: {
  primary: string
  secondary: string
  tertiary?: string
  meta: string
  metaSub?: string
  /** 2 段目 meta (= 紐付け 可能 残数 等)。 在庫数 と 区別 して 色 を 変える */
  meta2?: string
  meta2Sub?: string
  onClick: () => void
  adding: boolean
}) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      disabled={adding}
      style={{
        all: 'unset',
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '9px 10px',
        borderRadius: 8,
        cursor: 'pointer',
        background: hover ? 'var(--hover-bg)' : 'transparent',
        opacity: adding ? 0.5 : 1,
        transition: 'background 100ms ease',
        width: '100%', boxSizing: 'border-box',
        borderBottom: '1px solid var(--divider)',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.005em' }}>
          {primary}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {secondary}
        </div>
        {tertiary && (
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        fontVariantNumeric: 'tabular-nums' }}>
            {tertiary}
          </div>
        )}
      </div>
      <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        <div style={{
          fontSize: 12.5, fontWeight: 600, color: 'var(--text)',
          fontVariantNumeric: 'tabular-nums',
        }}>{meta}</div>
        {metaSub && (
          <div style={{
            fontSize: 10.5, color: 'var(--muted)', marginTop: 1,
            fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.005em',
          }}>{metaSub}</div>
        )}
        {meta2 && (
          <div style={{
            fontSize: 11.5, fontWeight: 700, color: 'var(--primary)',
            marginTop: 4,
            fontVariantNumeric: 'tabular-nums',
          }}>{meta2}</div>
        )}
        {meta2Sub && (
          <div style={{
            fontSize: 10.5, color: 'var(--primary)', opacity: 0.7,
            marginTop: 1,
            fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.005em',
          }}>{meta2Sub}</div>
        )}
      </div>
      <div style={{
        width: 24, height: 24, borderRadius: 7,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: hover ? 'var(--primary)' : 'var(--surface-soft)',
        color: hover ? '#fff' : 'var(--muted)',
        transition: 'background 100ms ease, color 100ms ease',
        flexShrink: 0,
        border: hover ? 'none' : '1px solid var(--border)',
      }}>
        {adding ? <span style={{ fontSize: 11 }}>…</span> : <Check size={14} strokeWidth={2.2} />}
      </div>
    </button>
  )
}


// ─── 既存紐付け行 (inline-edit + パレット計算 popover) ───
function ExistingRow({ it, targetKind, objectType = 'pallet', objectLabel, onUpdate, onRemove,
                      stocktakeEnabled, stocktakeValue, onStocktakeChange,
                      detailExpanded, onToggleDetail, onRequestBind }: {
  it: StorageLinkItem
  targetKind: 'material' | 'ingredient'
  /** 親 オブジェクト の 物理 タイプ。 'steel_container' なら 1 紐付け = 1 コンテナ
   *  ルール で UI が 切り替わる (構造-主 統一 後 は per-row 表示、 集約 廃止)。 */
  objectType?: 'pallet' | 'steel_container'
  objectLabel: string
  onUpdate: (id: number, p: { capacity?: number | null; priority?: number; pallet_details?: { t: number; c: number }[] | null; pallet_index?: number | null; tier_count?: number | null; case_count?: number | null; inbound_lot_id?: number | null; material_id?: number | null }) => Promise<void>
  onRemove: (id: number) => Promise<void>
  /** パレ別 詳細 を 展開中 か (= 親 state)。 折りたたみ default。 */
  detailExpanded?: boolean
  onToggleDetail?: () => void
  /** 空 パレ 用: 「+ ロット を 紐付け」 ボタン handler。 set すれば 表示 される。
   *  ingredient + 空 パレ (lot/material 全 NULL + tier_count あり) でのみ 意味 を 持つ。 */
  onRequestBind?: () => void
  // Phase A3: 棚卸数 入力
  stocktakeEnabled?: boolean
  stocktakeValue?: string
  onStocktakeChange?: (v: string) => void
}) {
  const dialog = useDialog()
  const isContainer = objectType === 'steel_container'
  // 紐付け なし (= 空 パレ) 判定。 新 model で 全 lot ref が NULL の とき。
  const isEmptyPallet = targetKind === 'ingredient' && !isContainer
    && it.inbound_lot_id == null && it.material_id == null
  // 空 スチール コンテナ (構造-主 refactor 2026-05-27): lot 紐付け なし の steel row
  const isEmptyContainer = targetKind === 'ingredient' && isContainer
    && it.inbound_lot_id == null && it.material_id == null
  let primary = ''
  let secondary = ''
  if (isEmptyPallet) {
    // 新 model 空 パレ — pallet_index で 「N パレ目」 表示
    const idx = it.pallet_index ?? 0
    primary = `${idx + 1} パレ目`
    secondary = '未紐付け (構造のみ)'
  } else if (isEmptyContainer) {
    // 空 コンテナ — pallet_index を 流用 して 「N コンテナ目」 表示
    const idx = it.pallet_index ?? 0
    primary = `${idx + 1} コンテナ目`
    secondary = '未紐付け (空 コンテナ)'
  } else if (targetKind === 'material') {
    primary = `${it.material_code ?? '?'} ${it.material_name ?? ''}`
    secondary = it.material_supplier ?? ''
  } else {
    // 整理番号 (lot_code) は 普段 覚えない し、 見て も いつ 入荷 した か わからない。
    // → primary は **入荷日 + 仕入先** で 「いつ・どこから」 を 即時 識別 (2026-05-26)。
    // 規格 (spec/grade/size) と 産地 は secondary に 集約。 lot_code は 表示しない。
    const spec = it.lot_spec_type ?? ''
    const grade = it.lot_grade_level && it.lot_grade_level !== '-' ? it.lot_grade_level : ''
    const size = it.lot_size_label && it.lot_size_label !== '-' ? it.lot_size_label : ''
    const specParts = [spec, grade, size].filter(Boolean).join(' ')
    // 新 model で pallet_index あり なら 「N パレ目: 」 を 接頭
    const palletPrefix = it.tier_count != null && it.pallet_index != null
      ? `${it.pallet_index + 1} パレ目: ` : ''
    const headParts: string[] = []
    if (it.lot_inbound_date) headParts.push(it.lot_inbound_date)
    if (it.lot_supplier_name) headParts.push(it.lot_supplier_name)
    primary = `${palletPrefix}${headParts.join(' · ') || '?'}`
    const meta: string[] = []
    if (specParts) meta.push(specParts)
    if (it.lot_origin_name) meta.push(it.lot_origin_name)
    secondary = meta.join(' · ')
  }
  const kpc = Number(it.kg_per_case)
  const hasKpc = targetKind === 'ingredient' && Number.isFinite(kpc) && kpc > 0
  // 旧 「pallet mode toggle」 (= popout panel 開閉) は 廃止。 ingredient + pallet で
  // パレ数/段数 を 常時 行内 編集 できる ため。 state も 不要。
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 6,
      padding: '6px 10px', borderRadius: 8,
      background: 'var(--panel)',
      border: '1px solid var(--border)',
    }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.005em' }}>
          {primary}
        </div>
        {secondary && (
          <div style={{ fontSize: 11, color: 'var(--muted)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {secondary}
          </div>
        )}
        {/* 総重量 (= tier × 7 + case の kg 換算) を lot info に 続けて 左側 で 表示。
            行 右側 の 構造入力 [段] [ケ] は 全 行 で 揃って いる ので、 重量 表示 は
            「ロット に 続く 結果」 として 左側 に 配置 する。 2026-05-26 user 方針。
            ingredient + パレット + kpc + 紐付け済 + tier_count あり の とき のみ。 */}
        {targetKind === 'ingredient' && !isContainer && hasKpc
          && it.tier_count != null && !isEmptyPallet && (() => {
          const totalCases = (it.tier_count ?? 0) * 7 + (it.case_count ?? 0)
          if (totalCases <= 0) return null
          const totalKg = totalCases * kpc
          return (
            <div style={{
              fontSize: 11.5, color: 'var(--primary)', fontWeight: 700,
              marginTop: 2, fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
            }}>
              {num(totalKg, 0)} kg
            </div>
          )
        })()}
      </div>
      <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        <div style={{ fontSize: 11.5, color: 'var(--text)', fontWeight: 600,
                      fontVariantNumeric: 'tabular-nums' }}>
          {/* 「残」 は 紐付け 後 の 残量 だと 誤解 され やすい が、 実態 は ロット の
              システム全社 残量 (= total_kg − 全 出庫)。 在庫紐付け で は 減らない。
              「在庫数」 に 改名 して 意味 を 明確化。 */}
          在庫数 {num(it.current_stock ?? 0, 1)}
        </div>
        {/* (旧 「紐付け 可能 残数」 inline 表示 は 廃止: 集約 UI と セット で 削除、
            2026-05-27 構造-主 統一。 紐付け 可能 残数 は LotBindingPicker 内 で 確認可。) */}
        {targetKind === 'ingredient' && (() => {
          const stock = Number(it.current_stock ?? 0)
          if (!Number.isFinite(stock) || stock <= 0) return null

          if (isContainer && hasKpc) {
            // コンテナ 換算: 何 個 満杯 ＋ 1 個 未満 端数 何 kg
            const full = Math.floor(stock / kpc)
            const rem = stock - full * kpc
            const parts: string[] = []
            if (full > 0) parts.push(`${full} コ満杯`)
            if (rem >= 0.05) parts.push(`1 コ未満端数 ${num(rem, 1)} kg`)
            if (parts.length === 0) return null
            return (
              <div style={{
                fontSize: 10, color: 'var(--muted)', marginTop: 1,
                fontVariantNumeric: 'tabular-nums',
              }}>
                = {parts.join(' + ')}
              </div>
            )
          }
          // パレット ingredient (hasKpc) は 右側 の PalletInlineEditor で 「ここに
          // 何 パレット = 何 kg」 を 自前 で 表示 する ので、 ここ では 重複 表示 しない
          // (= 「在庫数 7,616 / ここに 784 kg / ≒ 1パレ満」 と 「784kg / 1パレ ...」 が
          // 二重 で 出る 問題 を 解消、 2026-05-26)。
          if (hasKpc && !isContainer) return null
          // pallet レイアウト で hasKpc 不明 / または material の とき は 従来 表示
          const alloc = Number(it.allocated_kg ?? 0)
          const allocCases = alloc > 0 ? kgToCases(alloc, it.kg_per_case) : null
          if (allocCases != null && allocCases > 0) {
            return (
              <div style={{
                fontSize: 11, fontWeight: 700, color: 'var(--primary)', marginTop: 2,
                fontVariantNumeric: 'tabular-nums',
              }}>
                ここに {num(alloc, 0)} kg
                <span style={{ display: 'block', fontSize: 10, fontWeight: 400, opacity: 0.85 }}>
                  ≒ {stackShapeText(allocCases)}
                </span>
              </div>
            )
          }
          // 按分 量 が 取れない とき は 在庫数 換算 を そのまま (= 旧 挙動)
          const cases = kgToCases(stock, it.kg_per_case)
          if (cases == null || cases <= 0) return null
          return (
            <div style={{
              fontSize: 10, color: 'var(--muted)', marginTop: 1,
              fontVariantNumeric: 'tabular-nums',
            }}>
              ≒ {stackShapeText(cases)}
            </div>
          )
        })()}
      </div>
      {/* パレット 容量 編集 (ingredient + パレット + kg/ケース あり):
          [kg] + [パレ] [段] [ケ] を **行内** で 同時 利用可。
          kg と パレ/段/端ケ は 相互変換。
          P>=2 で pallet_details が ある とき は 段/ケ を 合計表示 (read-only)、
          「パレ別 設定」 ボタン で 各パレ 編集 modal を 開く。 */}
      {/* [新 model] 1 行 = 1 パレ (tier_count IS NOT NULL):
          シンプル に [T] [C] HoverStepperNumber を 並べる。 末尾 以外 は C=0 強制
          (= disabled、 ただし 順序 判定 は parent 側 で する 必要 あり → ここ では
          自由 編集 を 許す。 後で 物理 制約 を 厳密 化 予定)。 */}
      {targetKind === 'ingredient' && !isContainer && it.tier_count != null && (
        <>
          {/* 空 パレ 専用: 「+ ロット を 紐付け」 ボタン (= ゴースト ケース に 実 ロット を 入れる)。
              click → 親 が ミニピッカー を 開く。 構造 (段/ケ) は 維持 した まま バインド。 */}
          {isEmptyPallet && onRequestBind && (
            <Tooltip content="このパレ に ロット を 紐付け (= ゴースト ケース を 実 ケース に)">
              <button
                type="button"
                onClick={onRequestBind}
                style={{
                  all: 'unset', cursor: 'pointer',
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '0 12px',
                  height: 36, marginRight: 8,
                  fontSize: 12, fontWeight: 600,
                  color: 'var(--primary)',
                  background: 'var(--primary-light, #FCE4E1)',
                  border: '1px dashed var(--primary-tint)',
                  borderRadius: 8,
                  transition: 'background 120ms ease',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--primary-tint, #f5c4be)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--primary-light, #FCE4E1)')}
              >
                <Plus size={13} strokeWidth={2.2} />
                <span>ロット 紐付け</span>
              </button>
            </Tooltip>
          )}
          <HoverStepperNumber label="段" value={it.tier_count} max={7}
            onChange={(v) => {
              // capacity も 同期更新 (= (t*7 + c) * kpc)。 kpc 不明 なら null。
              const cases = v * 7 + (it.case_count ?? 0)
              const cap = hasKpc ? cases * kpc : null
              onUpdate(it.id, { tier_count: v, capacity: cap })
            }} />
          <HoverStepperNumber label="ケ" value={it.case_count ?? 0} max={6}
            onChange={(v) => {
              const cases = (it.tier_count ?? 0) * 7 + v
              const cap = hasKpc ? cases * kpc : null
              onUpdate(it.id, { case_count: v, capacity: cap })
            }} />
          {/* 重量 表示 は 左側 (lot info に 続けて) に 移動 した。 ここ は 構造 入力 だけ
              に 限定 し、 全行 で [段] [ケ] [×] が 揃う よう に する (2026-05-26)。 */}
        </>
      )}
      {/* [旧 model] tier_count IS NULL — 後方互換 で PalletInlineEditor を 使う。
          ユーザー が 削除 → 新 model で 再作成 する 想定。 */}
      {targetKind === 'ingredient' && !isContainer && hasKpc && it.tier_count == null && (
        <PalletInlineEditor
          capacity={it.capacity}
          kgPerCase={kpc}
          palletDetails={it.pallet_details ?? null}
          onChange={(kg, pd) => onUpdate(it.id, {
            capacity: kg,
            pallet_details: pd,
          })}
          detailExpanded={detailExpanded}
          onToggleDetail={onToggleDetail}
        />
      )}
      {isContainer ? (() => {
        // スチール コンテナ (構造-主 refactor 2026-05-27): 1 row = 1 コンテナ。
        // 空 コンテナ → 「+ ロット 紐付け」 ボタン (= ミニピッカー 起動)
        // 紐付け 済 → 「N kg」 chip (= 中身 の 重量)。 端数 は warning 色。
        if (isEmptyContainer && onRequestBind) {
          return (
            <Tooltip content="この コンテナ に ロット を 紐付け">
              <button
                type="button"
                onClick={onRequestBind}
                style={{
                  all: 'unset', cursor: 'pointer',
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '0 12px',
                  height: 36,
                  fontSize: 12, fontWeight: 600,
                  color: 'var(--primary)',
                  background: 'var(--primary-light, #FCE4E1)',
                  border: '1px dashed var(--primary-tint)',
                  borderRadius: 8,
                  transition: 'background 120ms ease',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--primary-tint, #f5c4be)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--primary-light, #FCE4E1)')}
              >
                <Plus size={13} strokeWidth={2.2} />
                <span>ロット 紐付け</span>
              </button>
            </Tooltip>
          )
        }
        const cap = Number(it.capacity)
        const hasCap = Number.isFinite(cap) && cap > 0
        const isPartial = hasCap && hasKpc && cap < kpc * 0.99
        return (
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '3px 10px',
            fontSize: 12,
            height: 28,
            background: isPartial ? 'var(--warning-light, #fef3c7)' : 'var(--primary-light)',
            color: isPartial ? 'var(--warning, #92400e)' : 'var(--primary)',
            border: '1px solid ' + (isPartial ? 'var(--warning-tint, #fcd34d)' : 'var(--primary-tint)'),
            borderRadius: 6,
            fontWeight: 700,
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
          }} title={isPartial
            ? `端数 コンテナ (ケース重量 ${num(kpc, 1)}kg 未満)`
            : '満杯 コンテナ'}>
            {hasCap ? `${num(cap, 1)} kg` : '— kg'}
          </div>
        )
      })() : (
        // 容量 (kg) input は **資材 (material)** のみ。 原料 (ingredient) は
        // 「構造-主・紐付け-従」 の 設計 上、 容量 を 直接 扱わない (= 段/ケ で
        // 自動 算出)。 kpc 不明 lot で あって も 入力欄 を 出さない。
        // (2026-05-26 user 方針)
        targetKind === 'material' && (
          <Tooltip content="容量 (空欄=無制限) — 単位: kg">
            <input
              type="number"
              defaultValue={it.capacity ?? ''}
              onBlur={(e) => {
                const v = e.target.value
                onUpdate(it.id, { capacity: v === '' ? null : Number(v) })
              }}
              placeholder="∞"
              style={{ width: 70, padding: '3px 8px', fontSize: 11.5, height: 26 }}
            />
          </Tooltip>
        )
      )}
      {/* 優先度 は 資材 (material) のみ で 運用 (= 按分 優先順)。
          原料 (ingredient) では 使われて いない ので 非表示 (user 確認 2026-05-26)。 */}
      {!isContainer && targetKind === 'material' && (
        <Tooltip content="優先度 (0–100, 高=先に按分)">
          <input
            type="number" min={0} max={100}
            defaultValue={it.priority}
            onBlur={(e) => onUpdate(it.id, { priority: Number(e.target.value) || PRIORITY_DEFAULT })}
            style={{ width: 52, padding: '3px 8px', fontSize: 11.5, height: 26, textAlign: 'right' }}
          />
        </Tooltip>
      )}
      {stocktakeEnabled && onStocktakeChange && !isEmptyContainer && !isEmptyPallet && (
        <StocktakeInput
          value={stocktakeValue ?? ''}
          onChange={onStocktakeChange}
          /* steel container: per-container kg (= 容量); pallet/material: lot 残量 */
          currentKg={isContainer
            ? Number(it.capacity ?? 0)
            : Number(it.current_stock ?? 0)}
        />
      )}
      {/* 削除 ボタン (構造-主 統一: 1 row ずつ 削除。 集約 UI 廃止 2026-05-27)。
          空 コンテナ/パレ は 「区画 を 削除」、 紐付き は 「紐付け を 解除」 + row 削除。
          ※ 「+」「−」 で コンテナ 数 を 増減 する UI は 廃止 (= 「+ 空 コンテナ 追加」 で 代替)。 */}
      <Tooltip content={isEmptyContainer || isEmptyPallet
        ? 'この 区画 を 削除'
        : '紐付け を 解除 (区画 も 削除)'}>
        <button
          className="ghost small"
          onClick={async () => {
            const slotLabel = isEmptyContainer
              ? `${(it.pallet_index ?? 0) + 1} コンテナ目 (空)`
              : isEmptyPallet
                ? `${(it.pallet_index ?? 0) + 1} パレ目 (空)`
                : (targetKind === 'material' ? it.material_name : it.lot_code) ?? '?'
            const msg = `${slotLabel} を ${objectLabel} から 削除 します。 よろしいですか?`
            if (await dialog.confirm({
              title: isEmptyContainer || isEmptyPallet ? '区画 を 削除' : '紐付け を 解除',
              message: msg,
              okLabel: '削除',
            })) {
              await onRemove(it.id)
            }
          }}
          aria-label="削除"
          style={{ padding: '4px 6px', display: 'inline-flex', alignItems: 'center', boxShadow: 'none' }}
        ><X size={13} strokeWidth={1.8} /></button>
      </Tooltip>
    </div>
    {/* パレ別 詳細 (= P>=2 の とき 自動展開) — modal なし で 行 直下 に 出す。
        各 パレット の (段, 端ケ) を HoverStepperNumber で 個別 編集。
        ※ detailExpanded で 親 から 折りたたみ 制御。 デフォルト 折りたたみ。 */}
    {targetKind === 'ingredient' && !isContainer && hasKpc
      && it.pallet_details && it.pallet_details.length >= 2
      && detailExpanded && (
      <PalletDetailsInline
        details={it.pallet_details}
        kgPerCase={kpc}
        onChange={(newDetails) => {
          if (newDetails.length === 0) {
            onUpdate(it.id, { capacity: null, pallet_details: null })
          } else if (newDetails.length === 1) {
            const cases = newDetails[0].t * 7 + newDetails[0].c
            const kg = cases > 0 ? cases * kpc : null
            onUpdate(it.id, { capacity: kg, pallet_details: null })
          } else {
            const totalCases = newDetails.reduce((s, d) => s + d.t * 7 + d.c, 0)
            const kg = totalCases > 0 ? totalCases * kpc : null
            onUpdate(it.id, { capacity: kg, pallet_details: newDetails })
          }
        }}
      />
    )}
    </div>
  )
}


// ─── 行内 パレット 入力 (kg + P/T/C 4 入力 + +/− スピナー) ───
// ingredient + pallet (kg/ケース あり) 行 で、 容量 を 複数 単位 で 編集 可能 に。
//   kg input ─ 直接 kg 入力
//   [−/+] パレ ─ 全 パレット 数
//   [−/+] 段 ─ 最上 パレット の 段数 (0 〜 tiersPerPallet)
//   [−/+] ケ ─ 最上段 の 端ケ (0 〜 casesPerTier-1)
// 相互変換: kg ↔ casesFromPalletTiersLoose で 同期。 内部 state は P/T/C/kgStr の 4 つ、
// 外部 capacity 変化 で 全部 再計算 (= 他 タブ や 他人 の 編集 で 更新 された 時)。
function PalletInlineEditor({ capacity, kgPerCase, palletDetails, onChange,
                              detailExpanded, onToggleDetail }: {
  capacity: number | null
  kgPerCase: number
  palletDetails: { t: number; c: number }[] | null
  onChange: (kg: number | null, palletDetails: { t: number; c: number }[] | null) => void
  detailExpanded?: boolean
  onToggleDetail?: () => void
}) {
  // pallet_details が ある なら P = 長さ、 T/C は 合計表示。 ない なら 旧 (P/T/C 単一) 流儀。
  const hasDetails = palletDetails != null && palletDetails.length > 0
  const detailsAggregate = useMemo(() => {
    if (!hasDetails) return { pCount: 0, tSum: 0, cSum: 0 }
    let tSum = 0, cSum = 0
    for (const pd of palletDetails!) { tSum += pd.t; cSum += pd.c }
    return { pCount: palletDetails!.length, tSum, cSum }
  }, [palletDetails, hasDetails])

  // 単一流儀 (= 全パレ統一) 用 の derived
  const derived = useMemo(() => {
    if (capacity == null || capacity <= 0) {
      return { p: 0, t: 0, c: 0, kgStr: '' }
    }
    const inp = palletInputsFromCases(Number(capacity) / kgPerCase)
    return {
      p: inp.pallets,
      t: inp.lastPalletTiers,
      c: inp.lastTierCases,
      kgStr: String(capacity),
    }
  }, [capacity, kgPerCase])

  const [p, setP] = useState(derived.p)
  const [t, setT] = useState(derived.t)
  const [c, setC] = useState(derived.c)
  const [kgStr, setKgStr] = useState(derived.kgStr)
  useEffect(() => {
    setP(derived.p); setT(derived.t); setC(derived.c); setKgStr(derived.kgStr)
  }, [derived])

  // P/T/C を 変えた とき kg を 計算 して onChange (単一流儀)。
  // パレ を 1 → 2 に 変えた タイミング で pallet_details に 移行 (= 単一 →
  // 配列 化、 1 個目 は 元 T/C を 引き継ぎ、 2 個目 は {0,0})。
  function commitPTC(newP: number, newT: number, newC: number) {
    const tMax = 7
    const cMax = 6
    const pp = Math.max(0, Math.floor(newP))
    const tt = Math.max(0, Math.min(tMax, Math.floor(newT)))
    const cc = Math.max(0, Math.min(cMax, Math.floor(newC)))
    setP(pp); setT(tt); setC(cc)
    if (pp >= 2 && !hasDetails) {
      // 単一 → 配列 化 (= 「P=1 の とき の T/C」 を 1 個目、 残り は {0,0} で 埋める)
      const newDetails: { t: number; c: number }[] = []
      newDetails.push({ t: t, c: c })  // 元 T/C (この click 前の 単一値)
      for (let i = 1; i < pp; i++) newDetails.push({ t: 0, c: 0 })
      const totalCases = newDetails.reduce((s, d) => s + d.t * 7 + d.c, 0)
      const kg = totalCases > 0 ? totalCases * kgPerCase : null
      onChange(kg, newDetails)
      return
    }
    if (pp >= 2 && hasDetails) {
      // 既に 詳細 ある → パレ 数 が 変わった なら 配列 を 伸ばし/縮める
      let newDetails = palletDetails!.slice()
      if (pp > newDetails.length) {
        for (let i = newDetails.length; i < pp; i++) newDetails.push({ t: 0, c: 0 })
      } else if (pp < newDetails.length) {
        newDetails = newDetails.slice(0, pp)
      }
      const totalCases = newDetails.reduce((s, d) => s + d.t * 7 + d.c, 0)
      const kg = totalCases > 0 ? totalCases * kgPerCase : null
      onChange(kg, newDetails)
      return
    }
    // 単一流儀 (P=0 or 1)
    const cases = casesFromPalletTiersLoose(pp, tt, cc)
    const kg = cases > 0 ? cases * kgPerCase : null
    setKgStr(kg != null ? String(kg) : '')
    onChange(kg, null)  // 詳細 不要 (= NULL に 戻す)
  }
  function commitKg(s: string) {
    setKgStr(s)
    if (s.trim() === '') {
      onChange(null, null); setP(0); setT(0); setC(0); return
    }
    const kg = Number(s)
    if (!Number.isFinite(kg) || kg <= 0) {
      onChange(null, null); setP(0); setT(0); setC(0); return
    }
    // kg 直接編集 は 単一流儀 に 戻す (= 詳細 リセット)
    const inp = palletInputsFromCases(kg / kgPerCase)
    setP(inp.pallets); setT(inp.lastPalletTiers); setC(inp.lastTierCases)
    onChange(kg, null)
  }
  // (旧 commitDetails — modal 廃止 と 同時 に 削除。 パレ別 編集 は ExistingRow 側
  //  の PalletDetailsInline が 直接 onUpdate を 呼ぶ。)

  // P 数 (= 表示 用)。 詳細 ある なら 配列 長、 単一 流儀 なら p。
  const displayP = hasDetails ? detailsAggregate.pCount : p
  // 段 / 端ケ の 表示値 (read-only when hasDetails、 editable when single)
  const displayT = hasDetails ? detailsAggregate.tSum : t
  const displayC = hasDetails ? detailsAggregate.cSum : c

  return (
    <>
      {/* 左: 大きな kg 表示 + クリックで 編集 */}
      <ClickEditKg kgStr={kgStr} onCommit={commitKg} setKgStr={setKgStr} />
      <span style={{ width: 1, height: 28, background: 'var(--border)', margin: '0 4px' }} />
      {/* パレ は 常に editable (= P が 増減 トリガー) */}
      <HoverStepperNumber label="パレ" value={displayP}
        onChange={(v) => commitPTC(v, t, c)} />
      {hasDetails ? (
        // P>=2 + 詳細あり: 段/ケ は 合計 read-only + 「▼/▲」 で 下の パレ別 行 開閉
        <>
          <ReadOnlyNumber label="段 合計" value={displayT} />
          <ReadOnlyNumber label="ケ 合計" value={displayC} />
          <button
            type="button"
            onClick={onToggleDetail}
            title={detailExpanded ? 'パレ別 詳細 を 閉じる' : 'パレ別 詳細 を 展開 (= 各 パレ の 段/ケ を 個別 編集)'}
            style={{
              padding: '4px 10px', fontSize: 12, fontWeight: 600,
              color: detailExpanded ? 'var(--primary)' : 'var(--muted)',
              background: detailExpanded ? 'var(--primary-light, #fce4e1)' : 'transparent',
              border: '1px solid ' + (detailExpanded ? 'var(--primary-tint)' : 'var(--border)'),
              borderRadius: 6, height: 32,
              cursor: 'pointer', boxShadow: 'none',
              display: 'inline-flex', alignItems: 'center', gap: 4,
              marginLeft: 4,
            }}
          >
            {detailExpanded ? '▲' : '▼'} パレ別
          </button>
        </>
      ) : (
        // 単一流儀 (P<=1): 段/ケ も editable
        <>
          <HoverStepperNumber label="段" value={t} max={7}
            onChange={(v) => commitPTC(p, v, c)} />
          <HoverStepperNumber label="ケ" value={c} max={6}
            onChange={(v) => commitPTC(p, t, v)} />
        </>
      )}
    </>
  )
}


/** 段/ケ 合計 read-only 表示 (P>=2 + 詳細あり の とき)。 */
function ReadOnlyNumber({ label, value }: { label: string; value: number }) {
  return (
    <span style={{
      display: 'inline-flex', flexDirection: 'column', alignItems: 'center',
      width: 64, height: 56, marginRight: 8,
      justifyContent: 'center',
      fontVariantNumeric: 'tabular-nums', userSelect: 'none',
      opacity: 0.85,
    }}>
      <span style={{ fontSize: 22, fontWeight: 700, lineHeight: 1, color: 'var(--text-secondary)' }}>{value}</span>
      <span style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>{label}</span>
    </span>
  )
}


/**
 * パレ別 詳細 行内 編集 (= 既存行 の 下 に 展開)。 各 パレット の (t, c) を
 * HoverStepperNumber で 編集 + パレ 追加/削除。 modal なし。
 *
 * 「commit on change」: 任意 入力 で 即時 onChange (= 親 で 即保存)。
 * 確定 ボタン なし、 編集 直感的。
 */
function PalletDetailsInline({ details, kgPerCase, onChange }: {
  details: { t: number; c: number }[]
  kgPerCase: number
  onChange: (next: { t: number; c: number }[]) => void
}) {
  function updateAt(i: number, patch: Partial<{ t: number; c: number }>) {
    onChange(details.map((d, idx) => idx === i ? { ...d, ...patch } : d))
  }
  function addPallet() { onChange([...details, { t: 0, c: 0 }]) }
  function removeAt(i: number) { onChange(details.filter((_, idx) => idx !== i)) }

  return (
    <div style={{
      marginTop: 8, padding: '8px 10px',
      background: 'var(--bg-tint)', borderRadius: 6,
      borderLeft: '3px solid var(--primary-tint)',
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      {details.map((d, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 700, minWidth: 60, color: 'var(--muted)' }}>
            {i + 1} パレ目
          </span>
          <HoverStepperNumber label="段" value={d.t} max={7}
            onChange={(v) => updateAt(i, { t: v })} />
          <HoverStepperNumber label="ケ" value={d.c} max={6}
            onChange={(v) => updateAt(i, { c: v })} />
          <span style={{
            flex: 1, textAlign: 'right', fontSize: 11, color: 'var(--muted)',
            fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
          }}>
            = {d.t * 7 + d.c} ケ ({num((d.t * 7 + d.c) * kgPerCase, 0)} kg)
          </span>
          <button
            type="button"
            onClick={() => removeAt(i)}
            title="この パレ を 削除"
            style={{ padding: '2px 6px', color: 'var(--danger)',
                     background: 'transparent', border: 'none', cursor: 'pointer',
                     boxShadow: 'none' }}
          ><X size={12} strokeWidth={1.8} /></button>
        </div>
      ))}
      <button
        type="button"
        onClick={addPallet}
        style={{
          padding: '5px 10px', fontSize: 11.5, color: 'var(--muted)',
          background: 'transparent',
          border: '1px dashed var(--border)', borderRadius: 6,
          cursor: 'pointer', boxShadow: 'none',
          alignSelf: 'flex-start',
        }}
      >+ パレット 追加</button>
    </div>
  )
}


/**
 * ClickEditKg
 * ----------
 * デフォルト: 大きな text 表示 「784 kg」。 クリック で text input に 切替 → blur/Enter で commit。
 */
function ClickEditKg({ kgStr, setKgStr, onCommit }: {
  kgStr: string
  setKgStr: (s: string) => void
  onCommit: (s: string) => void
}) {
  const [editing, setEditing] = useState(false)
  if (editing) {
    return (
      <input
        type="number"
        value={kgStr}
        onChange={(e) => setKgStr(e.target.value)}
        onBlur={(e) => { onCommit(e.target.value); setEditing(false) }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { onCommit(kgStr); setEditing(false) }
          else if (e.key === 'Escape') { setEditing(false) }
        }}
        placeholder="∞"
        autoFocus
        style={{ width: 90, padding: '3px 8px', fontSize: 17, height: 32, fontWeight: 700,
                 textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
        aria-label="ここに 配置 kg"
      />
    )
  }
  const displayKg = kgStr === '' ? '∞' : kgStr
  return (
    <Tooltip content="ここに 配置 する kg (クリック で 直接編集)">
      <button
        type="button"
        onClick={() => setEditing(true)}
        style={{
          all: 'unset', cursor: 'text',
          padding: '4px 10px', borderRadius: 6,
          fontSize: 17, fontWeight: 700, lineHeight: 1.2,
          fontVariantNumeric: 'tabular-nums',
          color: 'var(--text)',
          height: 32, display: 'inline-flex', alignItems: 'baseline', gap: 4,
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-bg)')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
      >
        <span>{displayKg}</span>
        <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 500 }}>kg</span>
      </button>
    </Tooltip>
  )
}


/**
 * HoverStepperNumber
 * ------------------
 * 大きな 数字 + ラベル。 数字 領域 の 上半分 hover で ▲ 強調 (click で +1)、
 * 下半分 hover で ▼ 強調 (click で -1)。 ダブルクリック で text 入力 モード。
 * タッチ デバイス でも tap 位置 で +/− 動作 (= hover なし でも 操作可)。
 */
function HoverStepperNumber({ label, value, onChange, max }: {
  label: string
  value: number
  onChange: (next: number) => void
  max?: number
}) {
  const [hover, setHover] = useState<null | 'top' | 'bottom'>(null)
  const [editing, setEditing] = useState(false)
  const [editStr, setEditStr] = useState(String(value))
  // editing 開始 時 に 現在値 を 初期化
  useEffect(() => { if (editing) setEditStr(String(value)) }, [editing, value])

  function commitEdit() {
    const n = Number(editStr)
    if (Number.isFinite(n) && n >= 0) {
      const clamped = max != null ? Math.min(max, Math.floor(n)) : Math.floor(n)
      onChange(clamped)
    }
    setEditing(false)
  }
  function inc() {
    if (max != null && value >= max) return
    onChange(value + 1)
  }
  function dec() {
    if (value <= 0) return
    onChange(value - 1)
  }

  if (editing) {
    // 編集 input: 枠線 や spinner 矢印 を 隠し、 数字 だけ 大きく 出す (block と
    // 同じ サイズ で 違和感 なし)。 ↑↓ キー で 増減、 Enter/blur で 確定、 Esc で キャンセル。
    return (
      <span style={{ display: 'inline-block', width: 64, height: 56, marginRight: 8,
                     position: 'relative' }}>
        <input
          type="number" min={0} max={max}
          value={editStr}
          onChange={(e) => setEditStr(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitEdit()
            else if (e.key === 'Escape') setEditing(false)
          }}
          autoFocus
          onFocus={(e) => e.target.select()}
          className="hide-spinner"
          style={{
            position: 'absolute', inset: 0,
            width: '100%', height: '100%',
            border: 'none', outline: '2px solid var(--primary)', outlineOffset: -1,
            background: 'var(--surface)',
            borderRadius: 8,
            padding: '4px 0 18px',
            fontSize: 22, fontWeight: 700,
            textAlign: 'center',
            fontVariantNumeric: 'tabular-nums',
            color: 'var(--text)',
            boxShadow: 'none',
          }}
        />
        <span style={{
          position: 'absolute', bottom: 6, left: 0, right: 0,
          textAlign: 'center', fontSize: 11, color: 'var(--muted)',
          pointerEvents: 'none',
        }}>{label}</span>
      </span>
    )
  }

  const minusDisabled = value <= 0
  const plusDisabled = max != null && value >= max
  // block 全体 が hit zone。 数字 + ラベル を 含む 大きな ボックス を 2 分割 (上=+1、下=-1)。
  // サイズ: 幅 64 × 高さ 56 (= 各半分 28px = iOS HIG 推奨 44 に 近い)。
  const BLOCK_W = 64
  const BLOCK_H = 56
  return (
    <span
      style={{
        display: 'inline-block', position: 'relative',
        width: BLOCK_W, height: BLOCK_H,
        marginRight: 8,
        borderRadius: 8,
        // 枠線 なし (= スッキリ)。 hover 時 の 半分背景 だけ で 操作可能 を 示す。
      }}
      onDoubleClick={() => setEditing(true)}
      title="上半分 click = +1 / 下半分 click = −1 / ダブルクリック = 直接入力"
    >
      {/* 中央 表示 (= 数字 大きく + ラベル 小さく)。 pointer-events:none で hit
          zone と 干渉 しない。 */}
      <span style={{
        position: 'absolute', inset: 0,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        pointerEvents: 'none',
        userSelect: 'none',
        fontVariantNumeric: 'tabular-nums',
      }}>
        <span style={{
          fontSize: 22, fontWeight: 700, lineHeight: 1,
          color: 'var(--text)',
        }}>{value}</span>
        <span style={{
          fontSize: 11, fontWeight: 500, color: 'var(--muted)',
          marginTop: 2,
        }}>{label}</span>
      </span>

      {/* 上半分 hit zone (= +1) — block 全体 の 上 50% */}
      <span
        onMouseEnter={() => setHover('top')}
        onMouseLeave={() => setHover(null)}
        onClick={inc}
        style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: '50%',
          cursor: plusDisabled ? 'default' : 'pointer',
          background: hover === 'top' && !plusDisabled
            ? 'var(--primary-light, #FCE4E1)' : 'transparent',
          borderRadius: '8px 8px 0 0',
          transition: 'background 80ms ease',
        }}
      />
      {/* 下半分 hit zone (= -1) */}
      <span
        onMouseEnter={() => setHover('bottom')}
        onMouseLeave={() => setHover(null)}
        onClick={dec}
        style={{
          position: 'absolute', bottom: 0, left: 0, right: 0, height: '50%',
          cursor: minusDisabled ? 'default' : 'pointer',
          background: hover === 'bottom' && !minusDisabled
            ? 'var(--hover-bg, #f1f5f9)' : 'transparent',
          borderRadius: '0 0 8px 8px',
          transition: 'background 80ms ease',
        }}
      />
      {/* hover 時 の ▲/▼ アイコン — block の 端 に 大きく */}
      {hover === 'top' && !plusDisabled && (
        <span style={{
          position: 'absolute', top: 2, left: '50%', transform: 'translateX(-50%)',
          fontSize: 11, color: 'var(--primary)', pointerEvents: 'none', lineHeight: 1,
          fontWeight: 700,
        }}>▲</span>
      )}
      {hover === 'bottom' && !minusDisabled && (
        <span style={{
          position: 'absolute', bottom: 2, left: '50%', transform: 'translateX(-50%)',
          fontSize: 11, color: 'var(--text-secondary)', pointerEvents: 'none', lineHeight: 1,
          fontWeight: 700,
        }}>▼</span>
      )}
    </span>
  )
}


// (旧 PalletCalcRow popout panel は 2026-05-26 廃止。 PalletInlineEditor が 行内
//  で 同等以上 の 機能 を 担う。)


// =============================================================================
// 棚卸エントリ パネル (Phase A1 v2)
// =============================================================================
// 「種別 (kind)」 フィールド 廃止。 在庫 から 直接 取り込み + 各 フィールド の
// 自動補完 (既存 entries + 在庫 master) + free text 入力 (Combobox freeText)。
// 同日 同名 = 上書き、 別日 = 新規 (履歴 残る) は backend 側 で 処理。
//
// 集計表 セクション (A/B/C/D) の 振り分け は Phase A2 で 「データ から 推定」
// する 形 で 実装 (lot 紐付け 有無 + crop_id で 自動 判定)。

interface EntryDraft {
  inventory_date: string
  // 在庫 由来 ref (snapshot 元 を 残す)
  inbound_lot_id: number | null
  material_id: number | null
  semifinished_lot_id: number | null
  outbound_id: number | null
  crop_id: number | null
  // free text fields (Combobox freeText から セット)
  origin_text: string
  spec_text: string
  sub_spec_text: string
  supplier_text: string
  category_major: string
  category_minor: string
  name: string
  // 数量
  cases: string         // 文字列 保持 で 空文字 を 許す
  kg_per_case: string
  total_kg: string
  total_kg_touched: boolean   // 手動 編集 した か (= auto 計算 を 止める か)
  note: string
}

function emptyDraft(): EntryDraft {
  return {
    inventory_date: new Date().toISOString().slice(0, 10),
    inbound_lot_id: null,
    material_id: null,
    semifinished_lot_id: null,
    outbound_id: null,
    crop_id: null,
    origin_text: '',
    spec_text: '',
    sub_spec_text: '',
    supplier_text: '',
    category_major: '',
    category_minor: '',
    name: '',
    cases: '',
    kg_per_case: '',
    total_kg: '',
    total_kg_touched: false,
    note: '',
  }
}

function draftFromEntry(e: InventoryEntry): EntryDraft {
  return {
    inventory_date: e.inventory_date,
    inbound_lot_id: e.inbound_lot_id,
    material_id: e.material_id,
    semifinished_lot_id: e.semifinished_lot_id,
    outbound_id: e.outbound_id,
    crop_id: e.crop_id,
    origin_text: e.origin_text ?? '',
    spec_text: e.spec_text ?? '',
    sub_spec_text: e.sub_spec_text ?? '',
    supplier_text: e.supplier_text ?? '',
    category_major: e.category_major ?? '',
    category_minor: e.category_minor ?? '',
    name: e.name ?? '',
    cases: e.cases != null ? String(e.cases) : '',
    kg_per_case: e.kg_per_case != null ? String(e.kg_per_case) : '',
    total_kg: e.total_kg != null ? String(e.total_kg) : '',
    total_kg_touched: true,
    note: e.note ?? '',
  }
}

function toNumberOrNull(s: string): number | null {
  const t = s.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

// 在庫 quick-fill picker 用 の 統一 アイテム (lot or material 両方 を 詰める)
type StockPickItem =
  | { kind: 'lot'; lotId: number; label: string; search: string; lot: LotOption }
  | { kind: 'material'; materialId: number; label: string; search: string; mat: MaterialOption }

function stockPickKey(it: StockPickItem): string {
  return it.kind === 'lot' ? `lot:${it.lotId}` : `mat:${it.materialId}`
}

// 既存 entries + 在庫 から 「free text + 別名」 の suggestions を 作る
type TextItem = { key: string; label: string }
function uniqueTextItems(values: (string | null | undefined)[]): TextItem[] {
  const seen = new Set<string>()
  const out: TextItem[] = []
  for (const v of values) {
    const s = (v ?? '').trim()
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push({ key: s, label: s })
  }
  return out
}

function InventoryEntriesPanel({
  entries, targetKind, availableLots, availableMaterials,
  suggestions,
  busy, onCreate, onUpdate, onDelete,
}: {
  objectId: number
  entries: InventoryEntry[]
  targetKind: 'material' | 'ingredient'
  availableLots?: LotOption[]
  availableMaterials?: MaterialOption[]
  suggestions: EntrySuggestions | null
  /** 親 で 排他 ルール (= binding 0 件 時 のみ 表示) を 担保 する ため、 panel 側
   *  では 警告 を 出さない。 prop は 後方互換 で 残す が、 destructure しない。 */
  hasExistingLinks?: boolean
  busy: boolean
  onCreate: (body: InventoryEntryCreate) => Promise<void>
  onUpdate: (entryId: number, patch: InventoryEntryUpdate) => Promise<void>
  onDelete: (entryId: number) => Promise<void>
}) {
  const dialog = useDialog()
  const [draft, setDraft] = useState<EntryDraft>(emptyDraft)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // 日付 降順 → id 降順 (= 最新 が 上)
  const sortedEntries = useMemo(() =>
    [...entries].sort((a, b) =>
      b.inventory_date.localeCompare(a.inventory_date) || b.id - a.id),
  [entries])

  // 在庫 picker 用 アイテム (lot / material)
  const stockItems = useMemo<StockPickItem[]>(() => {
    const out: StockPickItem[] = []
    if (targetKind === 'ingredient' && availableLots) {
      for (const l of availableLots) {
        const label = [
          l.crop_name,
          l.code,
          l.origin_name,
          l.spec_type,
          l.size_label,
          l.remaining_kg != null ? `残${num(l.remaining_kg, 0)}kg` : '',
        ].filter(Boolean).join(' ')
        out.push({
          kind: 'lot', lotId: l.lot_id, label, lot: l,
          search: [l.crop_name, l.code, l.origin_name, l.spec_type,
                   l.size_label, l.supplier_name].filter(Boolean).join(' '),
        })
      }
    }
    if (targetKind === 'material' && availableMaterials) {
      for (const m of availableMaterials) {
        const label = [m.code, m.item_name, m.supplier_name].filter(Boolean).join(' ')
        out.push({
          kind: 'material', materialId: m.material_id, label, mat: m,
          search: [m.code, m.item_name, m.supplier_name, m.category].filter(Boolean).join(' '),
        })
      }
    }
    return out
  }, [targetKind, availableLots, availableMaterials])

  // free text suggestion 集合 (既存 entries + master picker からの 全候補)
  const originSuggestions = useMemo(() => uniqueTextItems([
    ...(suggestions?.origins ?? []),
    ...entries.map(e => e.origin_text),
    ...(availableLots ?? []).map(l => l.origin_name),
  ]), [entries, availableLots, suggestions])
  const specSuggestions = useMemo(() => uniqueTextItems([
    ...(suggestions?.specs ?? []),
    ...entries.map(e => e.spec_text),
    ...(availableLots ?? []).map(l => l.spec_type),
  ]), [entries, availableLots, suggestions])
  const subSpecSuggestions = useMemo(() => uniqueTextItems(
    entries.map(e => e.sub_spec_text)
  ), [entries])
  const supplierSuggestions = useMemo(() => uniqueTextItems([
    ...(suggestions?.suppliers ?? []),
    ...entries.map(e => e.supplier_text),
    ...(availableLots ?? []).map(l => l.supplier_name ?? ''),
    ...(availableMaterials ?? []).map(m => m.supplier_name),
  ]), [entries, availableLots, availableMaterials, suggestions])
  const nameSuggestions = useMemo(() => uniqueTextItems([
    ...entries.map(e => e.name),
    ...(availableMaterials ?? []).map(m => m.item_name),
  ]), [entries, availableMaterials])
  // 大分類/小分類 デフォルト 候補 (Phase B 2026-05-27 user 確定):
  //  ・大分類 = 「商品」 / 「半製品」 で 集計表 サブ表 分け
  //  ・小分類 = 「洗」 / 「選」 / 「未処理」 で 半製品 の 処理状態 を 代用
  // 既存 entries に 同値 が あれば dedup される。 先頭 に 出す こと で 新規 入力 時 の 一発 選択 を 支援。
  const catMajorSuggestions = useMemo(() => uniqueTextItems([
    '商品', '半製品',
    ...(suggestions?.category_majors ?? []),
    ...entries.map(e => e.category_major),
  ]), [entries, suggestions])
  const catMinorSuggestions = useMemo(() => uniqueTextItems([
    '洗', '選', '未処理',
    ...(suggestions?.category_minors ?? []),
    ...entries.map(e => e.category_minor),
  ]), [entries, suggestions])

  // ケース 数 × ケース 重量 → 総 重量 を auto 計算 (total_kg_touched=false の とき のみ)
  useEffect(() => {
    if (draft.total_kg_touched) return
    const c = toNumberOrNull(draft.cases)
    const kpc = toNumberOrNull(draft.kg_per_case)
    if (c != null && kpc != null) {
      const next = String(+(c * kpc).toFixed(4))
      if (next !== draft.total_kg) {
        setDraft(d => ({ ...d, total_kg: next }))
      }
    }
  }, [draft.cases, draft.kg_per_case, draft.total_kg_touched, draft.total_kg])

  function startEdit(e: InventoryEntry) {
    setEditingId(e.id)
    setDraft(draftFromEntry(e))
  }
  function startNew() {
    setEditingId(null)
    setDraft(emptyDraft())
  }

  // 在庫 から 取り込み (snapshot)。 ref を 残しつつ 各 free text を fill。
  // ユーザー は その後 自由に 編集 できる (ref は そのまま 残る = 由来 記録)。
  function fillFromStock(it: StockPickItem) {
    if (it.kind === 'lot') {
      const l = it.lot
      const kpc = l.kg_per_case != null ? String(l.kg_per_case) : ''
      setDraft(d => ({
        ...d,
        inbound_lot_id: it.lotId,
        material_id: null,
        semifinished_lot_id: null,
        outbound_id: null,
        crop_id: l.crop_id ?? null,
        origin_text: l.origin_name ?? '',
        spec_text: l.spec_type ?? '',
        // 名前 は lot 由来 で は 空。 ユーザー が ラベル を 付けたい とき だけ 入れる
        name: d.name || '',
        kg_per_case: kpc || d.kg_per_case,
        total_kg_touched: false,
      }))
    } else {
      const m = it.mat
      setDraft(d => ({
        ...d,
        material_id: it.materialId,
        inbound_lot_id: null,
        semifinished_lot_id: null,
        outbound_id: null,
        crop_id: null,
        name: m.item_name || d.name,
      }))
    }
  }
  function clearStockRef() {
    setDraft(d => ({
      ...d,
      inbound_lot_id: null, material_id: null,
      semifinished_lot_id: null, outbound_id: null,
    }))
  }

  async function submit() {
    if (submitting) return
    const body: InventoryEntryCreate = {
      inventory_date: draft.inventory_date || undefined,
      inbound_lot_id: draft.inbound_lot_id,
      material_id: draft.material_id,
      semifinished_lot_id: draft.semifinished_lot_id,
      outbound_id: draft.outbound_id,
      crop_id: draft.crop_id,
      origin_text: draft.origin_text.trim() || null,
      spec_text: draft.spec_text.trim() || null,
      sub_spec_text: draft.sub_spec_text.trim() || null,
      supplier_text: draft.supplier_text.trim() || null,
      category_major: draft.category_major.trim() || null,
      category_minor: draft.category_minor.trim() || null,
      name: draft.name.trim() || null,
      cases: toNumberOrNull(draft.cases),
      kg_per_case: toNumberOrNull(draft.kg_per_case),
      total_kg: toNumberOrNull(draft.total_kg),
      note: draft.note.trim() || null,
    }
    setSubmitting(true)
    try {
      if (editingId != null) {
        await onUpdate(editingId, body)
      } else {
        await onCreate(body)
      }
      startNew()
    } finally {
      setSubmitting(false)
    }
  }

  async function remove(id: number) {
    if (!(await dialog.confirm({
      title: '棚卸エントリ を 削除',
      message: 'この エントリ を 削除 します。 復元 でき ません。',
      okLabel: '削除',
      variant: 'danger',
    }))) return
    await onDelete(id)
    if (editingId === id) startNew()
  }

  const isEditing = editingId != null
  const hasStockRef = draft.inbound_lot_id != null
    || draft.material_id != null
    || draft.semifinished_lot_id != null
  // 現在 の ref label (chip 表示 用)
  const currentRefLabel = useMemo(() => {
    if (draft.inbound_lot_id != null) {
      const l = availableLots?.find(x => x.lot_id === draft.inbound_lot_id)
      return l ? `ロット: ${l.crop_name ?? ''} ${l.code ?? ''} ${l.origin_name ?? ''} ${l.spec_type ?? ''}`.trim()
               : `ロット #${draft.inbound_lot_id}`
    }
    if (draft.material_id != null) {
      const m = availableMaterials?.find(x => x.material_id === draft.material_id)
      return m ? `資材: ${m.code} ${m.item_name}`.trim() : `資材 #${draft.material_id}`
    }
    if (draft.semifinished_lot_id != null) {
      return `半製品 #${draft.semifinished_lot_id}`
    }
    return null
  }, [draft.inbound_lot_id, draft.material_id, draft.semifinished_lot_id,
      availableLots, availableMaterials])

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0,
      overflow: 'hidden',
    }}>
      {/* ※ 排他 警告 バナー は 不要 に なった (= 親 StorageLinkModal で binding 0 件
            の とき のみ この タブ を 表示 する 排他 ルール に 変更、 2026-05-26)。 */}

      {/* ── 既存 エントリ リスト (履歴 含む) ── */}
      <div style={{
        flex: '1 1 auto',
        overflowY: 'auto',
        padding: '10px 14px',
        borderBottom: '1px solid var(--border)',
      }}>
        {sortedEntries.length === 0 ? (
          <div className="muted" style={{
            padding: '24px 12px', textAlign: 'center', fontSize: 12.5,
          }}>
            エントリ は まだ あり ません。 下 の フォーム で 追加 して ください。
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {sortedEntries.map(e => (
              <EntryRow
                key={e.id}
                entry={e}
                editing={editingId === e.id}
                onEdit={() => startEdit(e)}
                onRemove={() => remove(e.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── 入力 フォーム ── */}
      <div style={{
        flex: '0 0 auto',
        padding: '10px 14px 12px',
        background: 'var(--surface)',
        display: 'flex', flexDirection: 'column', gap: 8,
        maxHeight: '52vh', overflowY: 'auto',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
            {isEditing ? `エントリ #${editingId} を 編集` : '新規 エントリ'}
          </div>
          {isEditing && (
            <button className="ghost small" onClick={startNew}
                    style={{ fontSize: 11, padding: '2px 8px' }}>
              新規に切替
            </button>
          )}
        </div>

        {/* 行 0: 在庫 から 取り込み (snapshot) — 1 タップ で 各 free text を fill */}
        {stockItems.length > 0 && (
          <FormField
            label={`在庫から取り込み (${stockItems.length} 件)`}
            hint="選ぶ と 産地・規格・kg/cs が 自動 で 埋まる (後 から 編集可)">
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Combobox<StockPickItem>
                  items={stockItems}
                  getKey={stockPickKey}
                  getLabel={(it) => it.label}
                  getSearchText={(it) => it.search}
                  value={null}
                  onChange={(key) => {
                    if (key == null) return
                    const found = stockItems.find(it => stockPickKey(it) === String(key))
                    if (found) fillFromStock(found)
                  }}
                  placeholder={targetKind === 'ingredient'
                    ? 'ロットを検索 (整理番号 / 産地 / 規格)'
                    : '資材を検索 (コード / 品名 / 仕入先)'}
                />
              </div>
              {hasStockRef && (
                <button className="ghost small" onClick={clearStockRef}
                        style={{ height: 30, padding: '0 10px', fontSize: 11 }}
                        title="在庫 ref を 外す (= orphan 化)">
                  クリア
                </button>
              )}
            </div>
            {hasStockRef && currentRefLabel && (
              <div className="muted" style={{
                fontSize: 11, marginTop: 4, padding: '2px 6px',
                background: 'var(--primary-light)',
                color: 'var(--primary)',
                borderRadius: 4, display: 'inline-block',
              }}>
                由来: {currentRefLabel}
              </div>
            )}
          </FormField>
        )}

        {/* 行 1: 日付 のみ */}
        <FormField label="棚卸日" style={{ maxWidth: 160 }}>
          <input type="date" value={draft.inventory_date}
                 onChange={(e) => setDraft(d => ({ ...d, inventory_date: e.target.value }))}
                 style={entryInputStyle} />
        </FormField>

        {/* 行 2: 大分類 / 小分類 / 名前 (Combobox freeText) */}
        <div style={{ display: 'flex', gap: 8 }}>
          <FormField label="大分類" hint="集計 分け 用 (空欄 可)" style={{ flex: 1, minWidth: 0 }}>
            <FreeTextCombo items={catMajorSuggestions} value={draft.category_major}
              onChange={(v) => setDraft(d => ({ ...d, category_major: v }))}
              placeholder="例: 商品 / 半製品" />
          </FormField>
          <FormField label="小分類" style={{ flex: 1, minWidth: 0 }}>
            <FreeTextCombo items={catMinorSuggestions} value={draft.category_minor}
              onChange={(v) => setDraft(d => ({ ...d, category_minor: v }))}
              placeholder="任意" />
          </FormField>
          <FormField label="名前" style={{ flex: 2, minWidth: 0 }}>
            <FreeTextCombo items={nameSuggestions} value={draft.name}
              onChange={(v) => setDraft(d => ({ ...d, name: v }))}
              placeholder="例: キャベツ 100g ピロ" />
          </FormField>
        </div>

        {/* 行 3: 産地 / 規格 / サブ規格 (Combobox freeText) */}
        <div style={{ display: 'flex', gap: 8 }}>
          <FormField label="産地" style={{ flex: 1, minWidth: 0 }}>
            <FreeTextCombo items={originSuggestions} value={draft.origin_text}
              onChange={(v) => setDraft(d => ({ ...d, origin_text: v }))}
              placeholder="例: 中国" />
          </FormField>
          <FormField label="規格" style={{ flex: 1, minWidth: 0 }}>
            <FreeTextCombo items={specSuggestions} value={draft.spec_text}
              onChange={(v) => setDraft(d => ({ ...d, spec_text: v }))}
              placeholder="例: 100g" />
          </FormField>
          <FormField label="サブ規格" hint="台帳 値 の override" style={{ flex: 1, minWidth: 0 }}>
            <FreeTextCombo items={subSpecSuggestions} value={draft.sub_spec_text}
              onChange={(v) => setDraft(d => ({ ...d, sub_spec_text: v }))}
              placeholder="任意" />
          </FormField>
        </div>

        {/* 行 3.5: 仕入先 (Combobox freeText) — master suppliers + 既存 entries から候補 */}
        <FormField label="仕入先" hint="master + 過去入力 から自動補完" style={{ maxWidth: 360 }}>
          <FreeTextCombo items={supplierSuggestions} value={draft.supplier_text}
            onChange={(v) => setDraft(d => ({ ...d, supplier_text: v }))}
            placeholder="例: ◯◯物産" />
        </FormField>

        {/* 行 4: 数量 / ケース重量 / 総重量 */}
        <div style={{ display: 'flex', gap: 8 }}>
          <FormField label="ケース数" style={{ flex: 1 }}>
            <input type="number" inputMode="decimal" min={0} step="0.01"
                   value={draft.cases}
                   onChange={(e) => setDraft(d => ({ ...d, cases: e.target.value, total_kg_touched: false }))}
                   style={entryInputStyle} />
          </FormField>
          <FormField label="ケース重量 (kg)" style={{ flex: 1 }}>
            <input type="number" inputMode="decimal" min={0} step="0.01"
                   value={draft.kg_per_case}
                   onChange={(e) => setDraft(d => ({ ...d, kg_per_case: e.target.value, total_kg_touched: false }))}
                   style={entryInputStyle} />
          </FormField>
          <FormField label="総重量 (kg)" hint={draft.total_kg_touched ? '手入力' : '自動 計算'} style={{ flex: 1 }}>
            <input type="number" inputMode="decimal" min={0} step="0.01"
                   value={draft.total_kg}
                   onChange={(e) => setDraft(d => ({ ...d, total_kg: e.target.value, total_kg_touched: true }))}
                   style={entryInputStyle} />
          </FormField>
        </div>

        {/* 行 5: アクション */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 4 }}>
          {isEditing && (
            <button className="ghost small" onClick={startNew}
                    style={{ height: 30, padding: '0 12px', fontSize: 12 }}>取消</button>
          )}
          <button onClick={submit} disabled={submitting || busy}
                  style={{
                    height: 30, padding: '0 14px', fontSize: 12, fontWeight: 600,
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                  }}>
            {isEditing ? <Check size={14} strokeWidth={2} /> : <Plus size={14} strokeWidth={2} />}
            {isEditing ? '保存' : '追加'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Combobox の freeText mode を ラップ。 既存 候補 + 入力 (新規作成) どちらも 可。 */
function FreeTextCombo({ items, value, onChange, placeholder }: {
  items: TextItem[]
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <Combobox<TextItem>
      items={items}
      getKey={(it) => it.key}
      getLabel={(it) => it.label}
      getSearchText={(it) => it.label}
      value={value || null}
      onChange={(v) => onChange(v == null ? '' : String(v))}
      placeholder={placeholder}
      freeText
      onCreateNew={(t) => onChange(t)}
      createLabel={(q) => `✏️ 「${q}」 を そのまま 使う`}
    />
  )
}

function EntryRow({ entry, editing, onEdit, onRemove }: {
  entry: InventoryEntry
  editing: boolean
  onEdit: () => void
  onRemove: () => void
}) {
  // 表示 行 (canvas 表示 と 揃える): 産地 / 名前 / 規格 / 仕入先 / 数量 / 総重量
  const parts: string[] = []
  if (entry.origin_text) parts.push(entry.origin_text)
  if (entry.name) parts.push(entry.name)
  const specCombined = [entry.spec_text, entry.sub_spec_text].filter(Boolean).join(' / ')
  if (specCombined) parts.push(specCombined)
  if (entry.supplier_text) parts.push(`〈${entry.supplier_text}〉`)
  const main = parts.join(' ') || '(無題)'
  const qty: string[] = []
  if (entry.cases != null) qty.push(`${num(entry.cases, 2)} cs`)
  if (entry.kg_per_case != null) qty.push(`× ${num(entry.kg_per_case, 2)} kg`)
  if (entry.total_kg != null) qty.push(`= ${num(entry.total_kg, 2)} kg`)
  // 由来 ref tag (snapshot 元 が ある と き)
  const refTag = entry.inbound_lot_id != null ? `🔗 lot#${entry.inbound_lot_id}`
              : entry.material_id != null      ? `🔗 mat#${entry.material_id}`
              : entry.semifinished_lot_id != null ? `🔗 sf#${entry.semifinished_lot_id}`
              : null
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '6px 10px',
      borderRadius: 6,
      background: editing ? 'var(--primary-light)' : 'transparent',
      border: `1px solid ${editing ? 'var(--primary)' : 'var(--divider)'}`,
      fontSize: 12.5,
    }}>
      <div style={{
        flex: '0 0 78px', fontSize: 11, color: 'var(--muted)',
        fontFamily: 'var(--font-mono, monospace)',
      }}>{entry.inventory_date}</div>
      <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {main}
        {qty.length > 0 && (
          <span style={{ color: 'var(--muted)', marginLeft: 8, fontSize: 11.5 }}>
            {qty.join(' ')}
          </span>
        )}
        {refTag && (
          <span style={{ color: 'var(--muted)', marginLeft: 8, fontSize: 10.5 }}
                title="由来 ref (snapshot)">{refTag}</span>
        )}
      </div>
      <Tooltip content="編集">
        <button onClick={onEdit} aria-label="編集"
          style={iconButtonStyle}><Pencil size={13} strokeWidth={1.7} /></button>
      </Tooltip>
      <Tooltip content="削除">
        <button onClick={onRemove} aria-label="削除"
          style={{ ...iconButtonStyle, color: 'var(--danger)' }}>
          <Trash2 size={13} strokeWidth={1.7} />
        </button>
      </Tooltip>
    </div>
  )
}

function FormField({ label, hint, style, children }: {
  label: string
  hint?: string
  style?: React.CSSProperties
  children: React.ReactNode
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, ...style }}>
      <label style={{ fontSize: 10.5, fontWeight: 500, color: 'var(--muted)' }}>
        {label}
        {hint && <span style={{ fontWeight: 400, marginLeft: 4 }}>· {hint}</span>}
      </label>
      {children}
    </div>
  )
}

const entryInputStyle: React.CSSProperties = {
  height: 30, padding: '0 8px', fontSize: 12.5,
  border: '1px solid var(--border)', borderRadius: 4,
  background: 'var(--bg)', color: 'var(--text)',
  width: '100%', boxSizing: 'border-box',
}

const iconButtonStyle: React.CSSProperties = {
  background: 'transparent', border: 'none', cursor: 'pointer',
  color: 'var(--muted)', padding: 5,
  display: 'inline-flex', alignItems: 'center',
  borderRadius: 4, boxShadow: 'none',
}

// ─── 棚卸数 入力 + 差数 バッジ (Phase A3) ───
function StocktakeInput({ value, onChange, currentKg }: {
  value: string
  onChange: (v: string) => void
  currentKg: number
}) {
  const counted = value.trim() === '' ? null : Number(value)
  const validCount = counted != null && Number.isFinite(counted) && counted >= 0
  const diff = validCount ? currentKg - counted : null
  let badge: { text: string; bg: string; fg: string } | null = null
  if (diff != null) {
    if (Math.abs(diff) < 0.005) {
      badge = { text: '一致', bg: '#D1FAE5', fg: '#065F46' }
    } else if (diff > 0) {
      badge = { text: `-${num(diff, 2)}kg`, bg: '#FEF3C7', fg: '#92400E' }
    } else {
      badge = { text: `+${num(-diff, 2)}kg ⚠`, bg: '#FEE2E2', fg: '#991B1B' }
    }
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <Tooltip content="棚卸数 (kg) — 残kg より少なければ 調整出庫を 提案">
        <input
          type="number" inputMode="decimal" min={0} step="0.01"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="棚卸kg"
          style={{
            width: 64, padding: '3px 6px', fontSize: 11.5, height: 26,
            textAlign: 'right',
            border: '1px solid var(--primary-tint, #93C5FD)',
            background: validCount ? 'var(--primary-light, #DBEAFE)' : undefined,
          }}
        />
      </Tooltip>
      {badge && (
        <span style={{
          fontSize: 10.5, fontWeight: 600, padding: '2px 5px',
          background: badge.bg, color: badge.fg, borderRadius: 4,
          fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
        }}>{badge.text}</span>
      )}
    </div>
  )
}

// ─── 棚卸 → 調整出庫 プレビュー モーダル (Phase A3) ───
function StocktakePreviewModal({ result, busy, onConfirm, onCancel }: {
  result: StocktakeAdjustResult
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const outboundCount = result.lines.filter(l => l.action === 'outbound').length
  const warnCount = result.lines.filter(l => l.action === 'warn_over').length
  const noopCount = result.lines.filter(l => l.action === 'noop').length
  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onCancel() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1100,
        background: 'rgba(15, 23, 42, 0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        backdropFilter: 'blur(2px)',
      }}
    >
      <div style={{
        background: 'var(--panel)', borderRadius: 12,
        width: 'min(640px, 95vw)', maxHeight: '85vh',
        display: 'flex', flexDirection: 'column',
        boxShadow: 'var(--shadow-lg)',
        border: '1px solid var(--border)',
      }}>
        <div style={{
          padding: '12px 16px', borderBottom: '1px solid var(--border)',
          fontSize: 14, fontWeight: 600,
        }}>
          棚卸調整 プレビュー
          <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--muted)', fontWeight: 400 }}>
            出庫 {outboundCount} · 警告 {warnCount} · 一致 {noopCount}
          </span>
        </div>
        <div style={{
          flex: 1, overflowY: 'auto', padding: '8px 16px',
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          {result.lines.map((l, idx) => {
            const color = l.action === 'outbound' ? '#92400E'
                        : l.action === 'warn_over' ? '#991B1B'
                        : 'var(--muted)'
            const bg = l.action === 'outbound' ? '#FEF3C7'
                     : l.action === 'warn_over' ? '#FEE2E2'
                     : 'transparent'
            return (
              <div key={idx} style={{
                padding: '8px 10px', borderRadius: 6,
                border: '1px solid var(--divider)',
                background: bg,
                fontSize: 12.5,
              }}>
                <div style={{ fontWeight: 600 }}>{l.label}</div>
                <div style={{
                  fontSize: 11.5, color: 'var(--muted)', marginTop: 2,
                  fontVariantNumeric: 'tabular-nums',
                }}>
                  在庫 {num(l.current_kg, 2)} kg · 棚卸 {num(l.counted_kg, 2)} kg · 差 {num(l.diff_kg, 2)} kg
                </div>
                {l.message && (
                  <div style={{ fontSize: 11, color, marginTop: 2 }}>{l.message}</div>
                )}
              </div>
            )
          })}
        </div>
        <div style={{
          padding: '10px 16px', borderTop: '1px solid var(--border)',
          display: 'flex', justifyContent: 'flex-end', gap: 8,
        }}>
          <button className="ghost small" onClick={onCancel} disabled={busy}
                  style={{ height: 30, padding: '0 14px', fontSize: 12 }}>キャンセル</button>
          <button onClick={onConfirm} disabled={busy || outboundCount === 0}
                  style={{ height: 30, padding: '0 14px', fontSize: 12, fontWeight: 600 }}>
            {busy ? '登録中…' : `調整出庫を登録 (${outboundCount} 件)`}
          </button>
        </div>
      </div>
    </div>
  )
}


// =============================================================================
// LotBindingPicker — 空 パレ に ロット を 紐付け する ミニピッカー
// =============================================================================
// 構造編集 サブ モード で 空 パレ 行 の 「+ ロット 紐付け」 を 押す と 開く。
// 既存 の tier/case 構造 は そのまま に lot だけ バインド (= ゴースト ケース が 実 ケース に)。
// 上品 な カード スタイル: 中央 浮遊、 柔らか い 影、 シンプル な ロット リスト。
//
// 選択 後: parent が PATCH /storage/items/{id} { inbound_lot_id, capacity (再計算) } を 投げる。
// 構造 (pallet_index/tier_count/case_count) は 触ら ない。

function LotBindingPicker({
  targetItem, availableLots, layoutDivision, busy,
  onSelect, onClose,
}: {
  targetItem: StorageLinkItem
  availableLots: LotOption[]
  layoutDivision?: number | null
  busy: boolean
  onSelect: (lot: LotOption) => Promise<void>
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [showEmptyStockLots, setShowEmptyStockLots] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 60)
  }, [])

  // ESC で 閉じる
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const mainCropId = useMemo(() => {
    if (layoutDivision == null || layoutDivision < 1 || layoutDivision > 5) return null
    return layoutDivision
  }, [layoutDivision])

  const filtered = useMemo(() => {
    const tokens = tokenize(query)
    return availableLots
      .filter((l) => showEmptyStockLots || Number(l.remaining_kg) > 0)
      // 主作物 のみ で 自動 フィルタ (chip 廃止、 2026-05-27)。
      // layout に division なし or lot に crop_id なし は 通す。
      .filter((l) => mainCropId == null || l.crop_id == null || l.crop_id === mainCropId)
      .filter((l) => !tokens.length || matchesAllTokens(
        `${l.code ?? ''} ${l.crop_name ?? ''} ${l.spec_type ?? ''} ${l.grade_level ?? ''} ${l.size_label ?? ''} ${l.origin_name} ${l.supplier_name ?? ''} ${l.inbound_date ?? ''}`,
        tokens))
      .sort((a, b) => Number(b.remaining_kg) - Number(a.remaining_kg))
  }, [availableLots, query, mainCropId, showEmptyStockLots])

  async function handleSelect(lot: LotOption) {
    if (submitting || busy) return
    setSubmitting(true)
    try { await onSelect(lot) }
    finally { setSubmitting(false) }
  }

  const palletLabel = targetItem.pallet_index != null
    ? `${targetItem.pallet_index + 1} パレ目`
    : 'このパレ'
  const tier = targetItem.tier_count ?? 0
  const cs = targetItem.case_count ?? 0
  const structureLabel = (tier > 0 || cs > 0)
    ? `${tier}段 ${cs}ケ`
    : '構造 未設定'

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1100,
        background: 'rgba(30, 24, 12, 0.32)',
        backdropFilter: 'blur(3px)',
        WebkitBackdropFilter: 'blur(3px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
        animation: 'lbp-fade-in 140ms ease-out',
      }}
    >
      <style>{`
        @keyframes lbp-fade-in {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes lbp-card-in {
          from { opacity: 0; transform: translateY(6px) scale(0.985); }
          to   { opacity: 1; transform: translateY(0)    scale(1); }
        }
      `}</style>
      <div
        style={{
          background: 'var(--panel)',
          color: 'var(--text)',
          borderRadius: 14,
          boxShadow: '0 20px 60px -20px rgba(30, 24, 12, 0.35), 0 4px 16px -4px rgba(30, 24, 12, 0.15)',
          width: 'min(520px, 92vw)',
          maxHeight: '78vh',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
          border: '1px solid var(--border)',
          animation: 'lbp-card-in 180ms ease-out',
        }}
      >
        {/* ── 上品 な ヘッダー: ターゲット パレ の 情報 + 閉じる ── */}
        <div style={{
          padding: '16px 18px 12px',
          borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'flex-start', gap: 12,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, color: 'var(--muted)', letterSpacing: '0.04em',
                          textTransform: 'uppercase', marginBottom: 2 }}>
              ロット を 紐付け
            </div>
            <div style={{ fontSize: 14, fontWeight: 700, lineHeight: 1.3,
                          color: 'var(--text)' }}>
              {palletLabel}
              <span style={{ fontWeight: 500, color: 'var(--muted)', marginLeft: 8,
                             fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>
                {structureLabel}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--muted)', padding: 6, display: 'flex',
              alignItems: 'center', borderRadius: 8, boxShadow: 'none',
            }}
          ><X size={16} strokeWidth={1.6} /></button>
        </div>

        {/* ── 検索 + 作物 chip (compact) ── */}
        <div style={{ padding: '10px 18px 8px' }}>
          <div style={{ position: 'relative', marginBottom: 8 }}>
            <Search size={13} strokeWidth={1.7} style={{
              position: 'absolute', left: 11, top: '50%',
              transform: 'translateY(-50%)', color: 'var(--muted)', pointerEvents: 'none',
            }} />
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="整理番号 / 規格 / 産地 / 入荷日 …"
              style={{ paddingLeft: 32, height: 34, fontSize: 12.5 }}
            />
          </div>
          {/* 作物 chip は 削除 (2026-05-27): layout = 事業部 専用 で 主作物 だけ で 十分。
              在庫 0 toggle のみ 残す。 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4,
                        flexWrap: 'wrap', fontSize: 11 }}>
            <button
              style={chipStyle(showEmptyStockLots)}
              onClick={() => setShowEmptyStockLots(v => !v)}
            >{showEmptyStockLots ? '在庫 0 含む' : '在庫 0 除外'}</button>
          </div>
        </div>

        {/* ── ロット リスト (上品 な 1 行 ずつ) ── */}
        <div style={{
          flex: '1 1 auto', overflowY: 'auto',
          padding: '4px 10px 12px',
        }}>
          {filtered.length === 0 ? (
            <div className="muted" style={{
              padding: '28px 20px', textAlign: 'center', fontSize: 12.5,
            }}>
              候補 ロット が ありません
            </div>
          ) : (
            filtered.slice(0, 100).map((l) => {
              const grade = l.grade_level && l.grade_level !== '-' ? l.grade_level : ''
              const size = l.size_label && l.size_label !== '-' ? l.size_label : ''
              const specParts = [l.spec_type, grade, size].filter(Boolean).join(' ')
              const headParts: string[] = []
              if (l.inbound_date) headParts.push(l.inbound_date)
              if (l.supplier_name) headParts.push(l.supplier_name)
              const head = headParts.join(' · ') || (l.code ?? `lot#${l.lot_id}`)
              return (
                <LotPickerRow
                  key={l.lot_id}
                  head={head}
                  spec={`${specParts} · ${l.origin_name}`}
                  stockKg={Number(l.remaining_kg) || 0}
                  cropName={l.crop_name ?? undefined}
                  disabled={submitting || busy}
                  onSelect={() => handleSelect(l)}
                />
              )
            })
          )}
          {filtered.length > 100 && (
            <div className="muted" style={{
              padding: '8px 12px', fontSize: 10.5, textAlign: 'center',
            }}>
              … 先頭 100 件のみ。 検索 で 絞り込ん で ください。
            </div>
          )}
        </div>
      </div>
    </div>
  )
}


function LotPickerRow({ head, spec, stockKg, cropName, disabled, onSelect }: {
  head: string
  spec: string
  stockKg: number
  cropName?: string
  disabled: boolean
  onSelect: () => void
}) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      disabled={disabled}
      style={{
        all: 'unset',
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '9px 10px',
        borderRadius: 8,
        cursor: disabled ? 'default' : 'pointer',
        background: hover && !disabled ? 'var(--hover-bg)' : 'transparent',
        opacity: disabled ? 0.5 : 1,
        transition: 'background 100ms ease',
        width: '100%', boxSizing: 'border-box',
        borderBottom: '1px solid var(--divider)',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 12.5, fontWeight: 600, color: 'var(--text)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.005em',
        }}>
          {cropName && <span style={{ color: 'var(--muted)', fontWeight: 500 }}>[{cropName}] </span>}
          {head}
        </div>
        <div style={{
          fontSize: 11, color: 'var(--text-secondary)', marginTop: 2,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{spec}</div>
      </div>
      <div style={{
        textAlign: 'right', whiteSpace: 'nowrap',
        fontSize: 11.5, fontWeight: 600, color: 'var(--text)',
        fontVariantNumeric: 'tabular-nums',
      }}>
        {num(stockKg, 0)} <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--muted)' }}>kg</span>
      </div>
      <div style={{
        width: 22, height: 22, borderRadius: 6,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: hover && !disabled ? 'var(--primary)' : 'var(--surface-soft)',
        color: hover && !disabled ? '#fff' : 'var(--muted)',
        transition: 'background 100ms ease, color 100ms ease',
        flexShrink: 0,
        border: hover && !disabled ? 'none' : '1px solid var(--border)',
      }}>
        <Check size={12} strokeWidth={2.2} />
      </div>
    </button>
  )
}
