import { useEffect, useMemo, useRef, useState, lazy, Suspense, type ChangeEvent } from 'react'
import { useParams, useSearchParams, Link } from 'react-router-dom'
import {
  Eye, ClipboardList, Pencil, Search, Printer,
  Package, MapPin, X, Box, Map as MapIcon, MoveDiagonal2,
  MousePointer2, SquarePlus, RotateCw, Layers, Maximize2, Info,
  Square,
} from 'lucide-react'
import { api } from '../api/client'
import { useFetch } from '../lib/useFetch'
import { useDialog } from '../components/Dialog'
import { errorText, num } from '../lib/format'
import { matchesQuery, tokenize } from '../lib/search'
import { stackShapeText } from '../lib/palletStack'
import { useAuth } from '../auth/AuthContext'
import { buildInfoLinesMap, type LotInfo } from '../lib/storageObjectInfo'
import StorageCanvas from '../components/StorageCanvas'
// Storage3DView は Three.js + react-three-fiber + drei を 引き連れる 重い chunk
// (~700KB)。 material layout や ingredient で 3D 必要 ない タイミング では 読み込ま
// ない よう に 動的 import で 分離。 React.lazy + Suspense で 初回 mount 時 に
// 非同期 読み込み。
const Storage3DView = lazy(() => import('../components/Storage3DView'))
import StocktakePanel from '../components/StocktakePanel'
import StorageLinkModal from '../components/StorageLinkModal'
import SemifinishedRegisterModal from '../components/SemifinishedRegisterModal'
import Tooltip from '../components/Tooltip'
import {
  distributeStock,
  FILL_COLOR,
  fillState,
} from '../lib/storageDistribution'
import type {
  InventoryEntry,
  InventoryEntryCreate,
  InventoryEntryUpdate,
  LayoutState,
  MaterialStock,
  StorageObject,
  StorageObjectItem,
  StorageTargetKind,
  StorageWall,
} from '../api/types'

interface Props {
  targetKind: StorageTargetKind
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export default function StorageLayoutEditorPage({ targetKind }: Props) {
  const dialog = useDialog()
  const { id } = useParams<{ id: string }>()
  const [searchParams] = useSearchParams()
  const cropFrom = searchParams.get('from')
  const { isAdmin } = useAuth()

  // レイアウト編集中は本体スクロールを止めて、平面図を画面に固定する。
  // サイドパネルは内部スクロール (max-height: 100%).
  useEffect(() => {
    const main = document.querySelector('main.main') as HTMLElement | null
    if (!main) return
    main.classList.add('storage-editor-active')
    return () => main.classList.remove('storage-editor-active')
  }, [])
  const [dateFilter, setDateFilter] = useState<string>('')  // 空 = 現在
  const [showOnlyChanged, setShowOnlyChanged] = useState(false)

  // 状態取得
  const stateFetch = useFetch<LayoutState>(
    id ? `/storage/layouts/${id}/state` : null,
    dateFilter ? { date: dateFilter } : undefined,
  )

  // 当日変化のあった在庫を把握（資材のみ実装。原料はロット出庫履歴）
  const todayStr = today()
  const materialMovements = useFetch<Array<{ material_id: number; movement_date: string }>>(
    targetKind === 'material' ? '/materials/movements' : null,
    { date_from: dateFilter || todayStr, date_to: dateFilter || todayStr, limit: 500 },
  )

  // 編集モード
  const [editMode, setEditMode] = useState(false)
  // 編集スコープ: 'object' = 日常 オブジェクト 編集、 'floor' = 床面/壁/間取り 編集
  // (admin のみ、 構造変更 は 稀)。 editMode=true の とき のみ 意味 を 持つ。
  const [editScope, setEditScope] = useState<'object' | 'floor'>('object')
  // 棚卸モード
  const [stocktakeMode, setStocktakeMode] = useState(false)
  const [stocktakeDate, setStocktakeDate] = useState('')
  const [stocktakeDivision, setStocktakeDivision] = useState<number | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  // 複数選択 (Figma 風 — Shift+クリック で追加、 矩形ドラッグで一括)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  // 壁 選択 (select ツールで 壁 click → ハイライト + DEL/✕ で 削除)
  const [selectedWallId, setSelectedWallId] = useState<number | null>(null)
  // ツール (Figma/SketchUp 風: 選択 / 追加)
  const [tool, setTool] = useState<'select' | 'add'>('select')
  // 追加ツール 時 に 作成 する オブジェクト タイプ。 ingredient 限定。
  // 'pallet' = 既定 (パレット 84×72)、 'steel_container' = 長芋 スチール籠 100×80。
  const [newObjectType, setNewObjectType] =
    useState<'pallet' | 'steel_container'>('pallet')
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // 検索クエリ（資材/ロットコード・ラベル）
  const [searchTerm, setSearchTerm] = useState('')

  // ヒートマップモード
  const [heatmapDays, setHeatmapDays] = useState<number | null>(null)
  const activity = useFetch<{ days: number; activity: { object_id: number; activity: number }[] }>(
    heatmapDays && id ? `/storage/layouts/${id}/activity` : null,
    heatmapDays ? { days: String(heatmapDays) } : undefined,
  )

  // 紐付けモーダル状態 (fetch 条件で参照するので先に宣言)
  // 'ingredient' = 原料モード (StorageLinkModal), 'semifinished' = 半製品モード (SemifinishedRegisterModal)
  // null = 閉じている
  const [linkModalMode, setLinkModalMode] = useState<'ingredient' | 'semifinished' | null>(null)
  const linkModalOpen = linkModalMode !== null
  function setLinkModalOpen(open: boolean) {
    if (!open) setLinkModalMode(null)
    // open=true は明示的なモード呼び出しが必要 (openLinkModal を使う)
  }
  // ラベル編集 modal (オブジェクト選択中のみ)
  const [labelModalOpen, setLabelModalOpen] = useState(false)
  const [labelDraft, setLabelDraft] = useState('')
  // 平面視点ロック (default = true)
  //   true: 真上視点固定、 回転禁止、 ズーム/パンのみ
  //   false: ユーザー手動 orbit 自由
  //   true→false 切替: 即時 (アニメ無し)
  //   false→true 切替: camera が真上 + azimuth=0 へ自動アニメ、 アニメ中は全入力ブロック
  const [planarLocked, setPlanarLocked] = useState(true)
  // ポインタ 環境 (= マウス か タッチ か) を 検出。 キーボード ショートカット ヒント
  // (V/R/ESC/DEL) を タッチ デバイス で 出さない 等 に 使う。
  // SSR 安全 の ため useEffect で window matchMedia を 参照。
  const [hasFinePointer, setHasFinePointer] = useState(true)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(pointer: fine)')
    const handler = () => setHasFinePointer(mq.matches)
    handler()
    mq.addEventListener?.('change', handler)
    return () => mq.removeEventListener?.('change', handler)
  }, [])
  const toggleLock = () => setPlanarLocked(v => !v)

  // Fit-to-screen: tick をインクリメントすると 3D ビューがカメラをレイアウト中心 + 初期距離に戻す
  const [fitToScreenTick, setFitToScreenTick] = useState(0)

  // 詳細 表示 トグル (A3.2): ON で 各 object に 規格 / 産地 / 数量 / 仕入先 / 入荷日 等
  // を 多行 表示 する。 OFF で label のみ (普段 使い)。 印刷 時 (sheet page) は 強制 ON。
  const [showObjectInfo, setShowObjectInfo] = useState(false)

  // 右パネル ピン留め / 表示状態 (default = pinned)
  // localStorage で永続化 (per-layout)
  const pinKey = `layoutSidePanel.pinned.${id ?? 'new'}`
  const [sidePanelPinned, setSidePanelPinned] = useState<boolean>(() => {
    try { return localStorage.getItem(pinKey) !== 'false' } catch { return true }
  })
  // 一時表示状態 (グリップクリック / hover → open)
  const [sidePanelHoverOpen, setSidePanelHoverOpen] = useState(false)
  const sidePanelVisible = sidePanelPinned || sidePanelHoverOpen
  function togglePin() {
    setSidePanelPinned(v => {
      const next = !v
      try { localStorage.setItem(pinKey, next ? 'true' : 'false') } catch { /* noop */ }
      if (next) setSidePanelHoverOpen(false)
      return next
    })
  }

  // ロット候補 (原料の場合)
  // ingredient なら常時取得 — 候補一覧用 + canvas subtitle (パレ・段) の kg_per_case 参照用
  const lots = useFetch<Array<{
    lot_id: number; lot_code: string | null; spec_type: string; grade_level: string;
    size_label: string; origin_name: string; supplier_name: string; remaining_kg: string;
    crop_id: number | null; crop_name: string | null;
    inbound_date: string;
    kg_per_case: string;
    /** 置場 紐付け済 容量 (capacity 合計、 全 layout 横断)。 紐付け 可能 残数 算出 用 */
    bound_kg?: string;
  }>>(
    targetKind === 'ingredient' ? '/stock/lots' : null,
    {},
  )
  // ---- layout 全体 の entries (A3.2: canvas 詳細 表示 用、 showObjectInfo の とき のみ fetch) ----
  // (infoLinesByObject useMemo より 前 に 宣言 する 必要 あり)
  const layoutEntriesFetch = useFetch<InventoryEntry[]>(
    showObjectInfo && id ? `/storage/layouts/${id}/inventory-entries` : null,
    dateFilter ? { date: dateFilter } : { date: new Date().toISOString().slice(0, 10) },
  )
  // 資材候補 (編集モードまたは棚卸モードで必要)
  // UI 再設計: 上ツールバーの popover state
  // 検索/表示モード/凡例 を ひとつ の FAB + Panel に 集約 (2026-05-24)。
  // 旧 displayPopoverOpen / legendOpen は 廃止、 toolsPanelOpen で 一括 管理。
  const [toolsPanelOpen, setToolsPanelOpen] = useState(false)
  // ピン: ON で 常駐、 OFF で 外側 click で 閉じる。 localStorage で 永続化
  const toolsPinKey = 'storage-tools-panel.pinned'
  const [toolsPanelPinned, setToolsPanelPinned] = useState<boolean>(() => {
    try { return localStorage.getItem(toolsPinKey) === 'true' } catch { return false }
  })
  function toggleToolsPin() {
    setToolsPanelPinned(v => {
      const next = !v
      try { localStorage.setItem(toolsPinKey, next ? 'true' : 'false') } catch { /* noop */ }
      return next
    })
  }
  const materials = useFetch<MaterialStock[]>(
    targetKind === 'material' && (editMode || stocktakeMode || linkModalOpen)
      ? '/materials/stock' : null,
  )

  const data = stateFetch.data
  const layout = data?.layout
  const items = data?.items ?? []

  // ローカル objects state — 楽観的更新（ドラッグ中のチラつき防止）。
  // バックエンドからの再取得時に同期。
  const [objectsLocal, setObjectsLocal] = useState<StorageObject[]>([])
  useEffect(() => {
    if (data) setObjectsLocal(data.objects)
  }, [data])
  const objects = objectsLocal

  // ローカル walls state — 編集時の楽観的更新用
  const [wallsLocal, setWallsLocal] = useState<StorageWall[]>([])
  useEffect(() => {
    if (data) setWallsLocal(data.walls ?? [])
  }, [data])

  // ローカル floor outline state
  const [outlineLocal, setOutlineLocal] = useState<[number, number][] | null>(null)
  useEffect(() => {
    if (data) setOutlineLocal((data.layout.floor_outline ?? null) as [number, number][] | null)
  }, [data])

  // ─── 取消 / やり直し: outline + walls をまとめてスナップショット ───
  type Snapshot = { outline: [number, number][] | null; walls: StorageWall[] }
  const [history, setHistory] = useState<Snapshot[]>([])
  const [future, setFuture] = useState<Snapshot[]>([])
  // 連続編集 (例: 頂点ドラッグ) を 1 履歴にまとめるためのデバウンス
  const histPendingRef = useRef<number | null>(null)
  function snapshotNow(): Snapshot {
    return { outline: outlineLocal, walls: wallsLocal }
  }
  function pushHistoryBeforeChange() {
    // 直前 500ms 以内に push 済みなら同一セッションとみなしてスキップ
    if (histPendingRef.current !== null) {
      window.clearTimeout(histPendingRef.current)
    } else {
      const snap = snapshotNow()
      setHistory((h) => [...h.slice(-29), snap])  // 最大 30 件
      setFuture([])                                // 新規操作 → redo は消える
    }
    histPendingRef.current = window.setTimeout(() => {
      histPendingRef.current = null
    }, 500)
  }
  async function syncSnapshotToServer(snap: Snapshot) {
    if (!id) return
    try {
      await api.put(`/storage/layouts/${id}`, { floor_outline: snap.outline })
      await api.put(`/storage/layouts/${id}/walls`, {
        walls: snap.walls.map((w) => ({
          layout_id: Number(id),
          x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2, thickness: w.thickness,
        })),
      })
      // walls の id が再採番されるため、レイアウト状態を再取得
      stateFetch.reload()
    } catch (e) {
      setError(errorText(e))
    }
  }
  async function undo() {
    if (history.length === 0) return
    const target = history[history.length - 1]
    const current = snapshotNow()
    setHistory((h) => h.slice(0, -1))
    setFuture((f) => [current, ...f.slice(0, 29)])
    setOutlineLocal(target.outline)
    setWallsLocal(target.walls)
    await syncSnapshotToServer(target)
  }
  async function redo() {
    if (future.length === 0) return
    const target = future[0]
    const current = snapshotNow()
    setFuture((f) => f.slice(1))
    setHistory((h) => [...h.slice(-29), current])
    setOutlineLocal(target.outline)
    setWallsLocal(target.walls)
    await syncSnapshotToServer(target)
  }
  // キーボードショートカット (Ctrl/Cmd+Z = 取消、Ctrl/Cmd+Shift+Z = やり直し)
  useEffect(() => {
    if (!editMode) return
    function onKey(e: KeyboardEvent) {
      const tgt = e.target as HTMLElement | null
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' ||
                  tgt.tagName === 'SELECT' || tgt.isContentEditable)) return
      const meta = e.ctrlKey || e.metaKey
      if (!meta) return
      if (e.key === 'z' || e.key === 'Z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      } else if (e.key === 'y' || e.key === 'Y') {
        e.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editMode, history, future, outlineLocal, wallsLocal])

  // ─── データ変更 (履歴 push + 楽観的更新 + サーバー保存) ───
  const outlineSaveTimer = useRef<number | null>(null)
  function changeOutline(next: [number, number][] | null) {
    pushHistoryBeforeChange()
    setOutlineLocal(next)
    if (!id) return
    if (outlineSaveTimer.current) {
      window.clearTimeout(outlineSaveTimer.current)
    }
    outlineSaveTimer.current = window.setTimeout(async () => {
      try {
        await api.put(`/storage/layouts/${id}`, { floor_outline: next })
      } catch (e) {
        setError(errorText(e))
      }
    }, 400)
  }
  // アンマウント時に保留タイマーをクリア
  useEffect(() => () => {
    if (outlineSaveTimer.current) window.clearTimeout(outlineSaveTimer.current)
    if (histPendingRef.current) window.clearTimeout(histPendingRef.current)
  }, [])

  async function createWall(x1: number, y1: number, x2: number, y2: number) {
    if (!id) return
    pushHistoryBeforeChange()
    const tempId = -Date.now()
    const draft: StorageWall = {
      id: tempId, layout_id: Number(id),
      x1, y1, x2, y2, thickness: 8,
    }
    setWallsLocal((prev) => [...prev, draft])
    try {
      const created = await api.post<StorageWall>('/storage/walls', {
        layout_id: Number(id), x1, y1, x2, y2, thickness: 8,
      })
      setWallsLocal((prev) => prev.map((w) => w.id === tempId ? created : w))
    } catch (e) {
      setWallsLocal((prev) => prev.filter((w) => w.id !== tempId))
      setError(errorText(e))
    }
  }

  async function deleteWall(wallId: number) {
    pushHistoryBeforeChange()
    setWallsLocal((prev) => prev.filter((w) => w.id !== wallId))
    try {
      await api.delete(`/storage/walls/${wallId}`)
    } catch (e) {
      setError(errorText(e))
      stateFetch.reload()
    }
  }

  // オブジェクトID → そのオブジェクトのアイテム
  const itemsByObject = useMemo(() => {
    const m = new Map<number, StorageObjectItem[]>()
    for (const it of items) {
      const arr = m.get(it.object_id) ?? []
      arr.push(it); m.set(it.object_id, arr)
    }
    return m
  }, [items])

  // 分配（同 material/lot に紐づくアイテム間で配分）
  const distribution = useMemo(() => distributeStock(items), [items])

  // 変化のあった material_id セット
  const changedMaterialIds = useMemo(() => {
    if (targetKind !== 'material') return new Set<number>()
    return new Set(materialMovements.data?.map((m) => m.material_id) ?? [])
  }, [materialMovements.data, targetKind])

  // 検索でマッチするオブジェクトID — スペース区切りトークン AND 検索
  // 例: 「生姜 ﾋﾟﾛ」で「中国産生姜100gピロ」にも「生姜ピロ200g」にもヒット
  const searchMatchIds = useMemo(() => {
    const tokens = tokenize(searchTerm)
    if (tokens.length === 0) return null
    const ids = new Set<number>()
    for (const obj of objects) {
      // ラベル + 紐付けアイテムの属性を全部つなげた文字列に対し AND 検索
      const arr = itemsByObject.get(obj.id) ?? []
      const combined = [
        obj.label,
        ...arr.flatMap((it) => [
          it.material_code, it.material_name,
          it.lot_code, it.lot_spec_type,
        ]),
      ].filter(Boolean).join(' ')
      if (matchesQuery(searchTerm, [combined])) {
        ids.add(obj.id)
      }
    }
    return ids
  }, [searchTerm, objects, itemsByObject])

  // フィルター + 検索の合成（両方アクティブなら積集合）
  const highlightIds = useMemo(() => {
    let result: Set<number> | undefined = undefined
    if (showOnlyChanged) {
      result = new Set<number>()
      for (const obj of objects) {
        const arr = itemsByObject.get(obj.id) ?? []
        const hit = arr.some((it) =>
          it.material_id != null && changedMaterialIds.has(it.material_id),
        )
        if (hit) result.add(obj.id)
      }
    }
    if (searchMatchIds) {
      if (result) {
        result = new Set(Array.from(result).filter((id) => searchMatchIds.has(id)))
      } else {
        result = searchMatchIds
      }
    }
    return result
  }, [showOnlyChanged, searchMatchIds, objects, itemsByObject, changedMaterialIds])

  // ヒートマップの色補間: 白 → 黄 → オレンジ → 赤
  function heatColor(ratio: number): string {
    const r = Math.max(0, Math.min(1, ratio))
    if (r === 0) return '#f3f4f6'
    // HSL: 60(黄) → 0(赤) を r で補間し、彩度を上げる
    const hue = 60 - 60 * r
    const sat = 60 + 30 * r
    const light = 75 - 25 * r
    return `hsl(${hue}, ${sat}%, ${light}%)`
  }

  // 棚卸モード時の各 object 状態判定
  const stocktakeObjectStatus = useMemo(() => {
    // status: 'complete' | 'partial' | 'untouched' | 'out_of_scope'
    const m = new Map<number, 'complete' | 'partial' | 'untouched' | 'out_of_scope'>()
    if (!stocktakeMode || !materials.data) return m
    const matMap = new Map(materials.data.map((x) => [x.material_id, x]))
    for (const obj of objects) {
      const arr = itemsByObject.get(obj.id) ?? []
      const matsInScope = arr.filter((it) => {
        if (it.material_id == null) return false
        const mat = matMap.get(it.material_id)
        if (!mat) return false
        if (stocktakeDivision != null
            && mat.division !== stocktakeDivision && mat.division !== 0) return false
        return true
      })
      if (matsInScope.length === 0) {
        m.set(obj.id, 'out_of_scope')
        continue
      }
      // 全 mat について「この日に object 単位の count があるか」を判定
      // 簡易: materials_stock.latest_count_date が stocktakeDate と一致なら count あり扱い
      // (より精密にやるならカウント API を集計が必要だが、ここでは在庫VIEWの状態で代用)
      let countedN = 0
      for (const it of matsInScope) {
        const mat = matMap.get(it.material_id!)!
        if (mat.latest_count_date === stocktakeDate) countedN++
      }
      if (countedN === 0) m.set(obj.id, 'untouched')
      else if (countedN < matsInScope.length) m.set(obj.id, 'partial')
      else m.set(obj.id, 'complete')
    }
    return m
  }, [stocktakeMode, materials.data, objects, itemsByObject, stocktakeDate, stocktakeDivision])

  // 各オブジェクトの色
  const fillByObject = useMemo(() => {
    const m = new Map<number, string>()
    // --- 棚卸モード ---
    if (stocktakeMode) {
      const COLOR = {
        complete:     '#9ca3af',  // グレー (済)
        partial:      '#fbbf24',  // 黄 (途中)
        untouched:    '#c8362d',  // 赤 (未)
        out_of_scope: '#e5e7eb',  // 極薄
      } as const
      for (const obj of objects) {
        const s = stocktakeObjectStatus.get(obj.id) ?? 'untouched'
        m.set(obj.id, COLOR[s])
      }
      return m
    }
    // --- ヒートマップモード ---
    if (heatmapDays && activity.data) {
      const maxA = Math.max(0.0001,
        ...activity.data.activity.map((a) => a.activity))
      for (const a of activity.data.activity) {
        m.set(a.object_id, heatColor(a.activity / maxA))
      }
      // データに乗ってないオブジェクトは灰色
      for (const obj of objects) {
        if (!m.has(obj.id)) m.set(obj.id, '#e5e7eb')
      }
      return m
    }
    // --- 通常モード: 在庫量レベル ---
    const order = ['empty', 'low', 'mid', 'full', 'over'] as const
    for (const obj of objects) {
      const arr = itemsByObject.get(obj.id) ?? []
      if (arr.length === 0) {
        m.set(obj.id, FILL_COLOR.unlinked)
        continue
      }
      let worst: typeof order[number] = 'full'
      let worstIdx = order.indexOf(worst)
      for (const it of arr) {
        const allo = distribution.get(it.id)?.amount ?? 0
        const s = fillState(it, allo)
        if (s === 'unlinked') continue
        const idx = order.indexOf(s)
        if (idx < worstIdx) { worst = s; worstIdx = idx }
      }
      m.set(obj.id, FILL_COLOR[worst])
    }
    return m
  }, [objects, itemsByObject, distribution, heatmapDays, activity.data,
      stocktakeMode, stocktakeObjectStatus])

  // ロット ID → kg_per_case のマップ (subtitle の パレ・段 算出用)
  const kgPerCaseByLot = useMemo(() => {
    const m = new Map<number, number>()
    for (const l of lots.data ?? []) {
      const k = Number(l.kg_per_case)
      if (Number.isFinite(k) && k > 0) m.set(l.lot_id, k)
    }
    return m
  }, [lots.data])

  // オブジェクトごとの「総ケース数」 (canvas 内 パレット visualizer 用)
  const casesByObject = useMemo(() => {
    const m = new Map<number, number>()
    if (targetKind !== 'ingredient') return m
    for (const obj of objects) {
      const arr = itemsByObject.get(obj.id) ?? []
      let totalCases = 0
      for (const it of arr) {
        if (it.inbound_lot_id == null) continue
        const kpc = kgPerCaseByLot.get(it.inbound_lot_id)
        if (!kpc) continue
        const alloc = Number(distribution.get(it.id)?.amount ?? 0)
        if (alloc > 0) totalCases += alloc / kpc
      }
      if (totalCases > 0) m.set(obj.id, Math.round(totalCases))
    }
    return m
  }, [objects, itemsByObject, distribution, kgPerCaseByLot, targetKind])

  // 新 model パレ 構造 (= tier_count != null の 行 を pallet_index 昇順 で 並べる)。
  // 「構造-主」 思想: 各 行 = 1 パレ。 3D 描画 は 各 行 の (tier, case, 紐付け 有無)
  // を そのまま 反映 する (= 旧 「総 cases を 詰め直し」 ロジック を 廃止)。
  // 旧 model 行 (tier_count == null) しか ない object は 含まない (= 旧 casesByObject
  // 経由 で 描画 する fallback パス を 維持)。 2026-05-26 構造-主 refactor。
  const palletRowsByObject = useMemo(() => {
    const m = new Map<number, Array<{ tierCount: number; caseCount: number; isEmpty: boolean }>>()
    if (targetKind !== 'ingredient') return m
    for (const obj of objects) {
      if (obj.object_type === 'steel_container') continue
      const arr = itemsByObject.get(obj.id) ?? []
      const newRows = arr
        .filter(it => it.tier_count != null)
        .sort((a, b) => (a.pallet_index ?? 0) - (b.pallet_index ?? 0))
      if (newRows.length === 0) continue
      m.set(obj.id, newRows.map(it => ({
        tierCount: it.tier_count ?? 0,
        caseCount: it.case_count ?? 0,
        isEmpty: it.inbound_lot_id == null
          && it.material_id == null
          && it.semifinished_lot_id == null,
      })))
    }
    return m
  }, [objects, itemsByObject, targetKind])

  // steel_container 用: 紐付け 件数 = 積み 段数 (動的)
  // 1 紐付け = 1 コンテナ ルール。 構造-主 refactor (2026-05-27) で 空 コンテナ も
  // 1 行 と して 数える (= containerCount は 全 row 数、 binding 有無 問わず)。
  const containerCountByObject = useMemo(() => {
    const m = new Map<number, number>()
    if (targetKind !== 'ingredient') return m
    for (const obj of objects) {
      if (obj.object_type !== 'steel_container') continue
      const arr = itemsByObject.get(obj.id) ?? []
      m.set(obj.id, arr.length)
    }
    return m
  }, [objects, itemsByObject, targetKind])

  // steel_container 構造-主 model (2026-05-27): 各 row = 1 コンテナ slot。
  // isEmpty = lot/material 紐付け なし (= 区画 だけ 確保 された 状態)。 capacity は
  // bound なら kg (= 満杯 or 端数)、 空 なら null。 3D 描画 で per-row 区別 する。
  const containerRowsByObject = useMemo(() => {
    const m = new Map<number, Array<{ id: number; isEmpty: boolean; capacity: number | null }>>()
    if (targetKind !== 'ingredient') return m
    for (const obj of objects) {
      if (obj.object_type !== 'steel_container') continue
      const arr = itemsByObject.get(obj.id) ?? []
      // pallet_index で sort (= 構造 で 並べる、 古い 行 は id 順)。
      const sorted = [...arr].sort((a, b) => {
        const ai = a.pallet_index ?? a.id
        const bi = b.pallet_index ?? b.id
        return ai - bi
      })
      m.set(obj.id, sorted.map(it => ({
        id: it.id,
        isEmpty: it.inbound_lot_id == null
          && it.material_id == null
          && it.semifinished_lot_id == null,
        capacity: it.capacity == null ? null : Number(it.capacity),
      })))
    }
    return m
  }, [objects, itemsByObject, targetKind])

  // 各オブジェクトの subtitle (合計量 / 容量 + 原料の場合パレ・段)
  const subtitleByObject = useMemo(() => {
    const m = new Map<number, string>()
    for (const obj of objects) {
      const arr = itemsByObject.get(obj.id) ?? []
      if (arr.length === 0) continue
      const totalAlloc = arr.reduce(
        (s, it) => s + (distribution.get(it.id)?.amount ?? 0), 0)
      const totalCap = arr.reduce(
        (s, it) => s + (it.capacity ?? 0), 0)
      let main = totalCap > 0
        ? `${num(totalAlloc, 0)}/${num(totalCap, 0)} kg`
        : `${num(totalAlloc, 0)} kg`
      // 原料ロットの場合は パレット形分解を追加 (各ロットの kg_per_case で個別計算 → 合算は kg ベース)
      if (targetKind === 'ingredient') {
        // 代表 kg/cs: 同一オブジェクトで複数ロットあれば最大値 (実用的近似)
        let totalCases = 0
        let anyKpc = false
        for (const it of arr) {
          if (it.inbound_lot_id == null) continue
          const kpc = kgPerCaseByLot.get(it.inbound_lot_id)
          if (!kpc) continue
          anyKpc = true
          const alloc = Number(distribution.get(it.id)?.amount ?? 0)
          if (alloc > 0) totalCases += alloc / kpc
        }
        if (anyKpc && totalCases > 0) {
          main += ` · ${stackShapeText(Math.round(totalCases))}`
        }
      }
      m.set(obj.id, main)
    }
    return m
  }, [objects, itemsByObject, distribution, targetKind, kgPerCaseByLot])

  // 詳細 表示 (A3.2): 紐付け を ベース + entry override で 各 object の 行 を 生成。
  // showObjectInfo=false の とき は 空 Map (= canvas 側 で 何も 描か ない)。
  const infoLinesByObject = useMemo(() => {
    if (!showObjectInfo) return new Map<number, string[]>()
    const lotInfo = new Map<number, LotInfo>()
    for (const l of lots.data ?? []) {
      lotInfo.set(l.lot_id, {
        lot_id: l.lot_id,
        kg_per_case: l.kg_per_case,
        inbound_date: l.inbound_date,
        supplier_name: l.supplier_name,
      })
    }
    // entries を object_id ごと に group
    const entriesByObject = new Map<number, InventoryEntry[]>()
    for (const e of layoutEntriesFetch.data ?? []) {
      const arr = entriesByObject.get(e.object_id) ?? []
      arr.push(e)
      entriesByObject.set(e.object_id, arr)
    }
    return buildInfoLinesMap(
      itemsByObject, entriesByObject,
      objects.map(o => o.id),
      lotInfo,
    )
  }, [showObjectInfo, lots.data, layoutEntriesFetch.data, itemsByObject, objects])

  const selectedObject = objects.find((o) => o.id === selectedId) ?? null
  const selectedItems = selectedId ? itemsByObject.get(selectedId) ?? [] : []

  // ---- 画像アップロード ----
  const fileInputRef = useRef<HTMLInputElement>(null)
  async function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !layout) return
    setBusy(true); setError(null); setMsg(null)
    try {
      // 原寸サイズ取得
      const dims = await new Promise<{ w: number; h: number }>((resolve, reject) => {
        const img = new Image()
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
        img.onerror = () => reject(new Error('画像読み込み失敗'))
        img.src = URL.createObjectURL(file)
      })
      const fd = new FormData()
      fd.append('file', file)
      fd.append('width', String(dims.w))
      fd.append('height', String(dims.h))
      await api.upload(`/storage/layouts/${layout.id}/image`, fd)
      setMsg('画像をアップロードしました。')
      stateFetch.reload()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  // ---- オブジェクト操作 ----
  // 原料 (ingredient) のオブジェクト = 1 パレット (窓積み 4 vert + 3 horiz)
  // 7:6 アスペクト (長辺:短辺) で 同寸法 7 ケース完全タイリング
  // PALLET_LONG = 長辺 (default = X 軸方向)
  // PALLET_SHORT = 短辺 (default = Y 軸方向)
  const PALLET_LONG = 84   // 7 × 12
  const PALLET_SHORT = 72  // 6 × 12
  // steel_container: 1700×1000mm → canvas 85×50 px (= 比率 17:10 = 1700:1000)。
  // 3D で は world 2.83×1.67 と なり、 1 world ≈ 600mm スケール。
  const STEEL_CONTAINER_W = 85
  const STEEL_CONTAINER_H = 50
  // 2026-05-30: 複数 object を 同 delta で 一括 移動 (= marquee 複数選択 後 の drag)。
  // 各 object の 新 (x,y) を 受け取って updateObject に 流す (= デバウンス で 個別 PATCH)。
  function updateManyObjects(updates: Array<{ id: number; x: number; y: number }>) {
    for (const u of updates) {
      updateObject(u.id, { x: u.x, y: u.y })
    }
  }

  // 2026-05-30: Ctrl+Shift+Drag で source object を 複製 (PPT 風)。
  // 紐付け (items / labels) は コピー せず、 寸法 + color + object_type + orientation
  // + pallet_tiers の 「構造」 のみ コピー。 新 object を 選択 状態 に。
  async function duplicateObject(sourceId: number, x: number, y: number) {
    if (!layout) return
    const src = objects.find(o => o.id === sourceId)
    if (!src) return
    setBusy(true); setError(null)
    try {
      const o = await api.post<StorageObject>('/storage/objects', {
        layout_id: layout.id,
        x: Math.max(0, x),
        y: Math.max(0, y),
        width: src.width, height: src.height,
        color: src.color ?? undefined,
        object_type: src.object_type ?? 'pallet',
        orientation: src.orientation ?? 0,
        pallet_tiers: src.pallet_tiers ?? 7,
      })
      setSelectedId(o.id); setSelectedIds(new Set([o.id]))
      stateFetch.reload()
    } catch (e) { setError(errorText(e)) }
    finally { setBusy(false) }
  }

  async function createObject(x: number, y: number, orientation: number = 0) {
    if (!layout) return
    let W: number, H: number
    // スチール コンテナ は 長芋 (division=3) ingredient layout 専用。
    // 他 layout で newObjectType が steel_container に なって いる ケース は 強制 pallet。
    const useType = (targetKind === 'ingredient' && layout.division === 3)
      ? newObjectType
      : 'pallet'
    if (useType === 'steel_container') {
      W = STEEL_CONTAINER_W; H = STEEL_CONTAINER_H
    } else if (targetKind === 'ingredient') {
      // orientation=0: 長辺X, orientation=90: 長辺Y (寸法を入れ替える)
      W = orientation === 90 ? PALLET_SHORT : PALLET_LONG
      H = orientation === 90 ? PALLET_LONG  : PALLET_SHORT
    } else {
      W = 80; H = 60
    }
    setBusy(true)
    try {
      // クリック 位置 = 新規 オブジェクト の 左上 (top-left)。 中心配置 は user が
      // 「ずれて 配置 される」 と 感じる ため 廃止 (2026-05-24)。
      const o = await api.post<StorageObject>('/storage/objects', {
        layout_id: layout.id,
        x: Math.max(0, x),
        y: Math.max(0, y),
        width: W, height: H,
        object_type: useType,
      })
      setSelectedId(o.id)
      // 追加完了後に自動で「選択」 ツールへ復帰 (Figma 風 one-shot)
      setTool('select')
      stateFetch.reload()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  // ドラッグ中の即時更新は楽観的に。永続化はドロップ時にデバウンス。
  const pendingPatchRef = useRef<Map<number, Partial<StorageObject>>>(new Map())
  const flushTimerRef = useRef<number | null>(null)
  function updateObject(id: number, patch: Partial<StorageObject>) {
    // 楽観的に local state を更新（即時再描画）
    setObjectsLocal((prev) => prev.map((o) => o.id === id ? { ...o, ...patch } : o))
    // バックエンド呼出をデバウンス
    const cur = pendingPatchRef.current.get(id) ?? {}
    pendingPatchRef.current.set(id, { ...cur, ...patch })
    if (flushTimerRef.current) window.clearTimeout(flushTimerRef.current)
    flushTimerRef.current = window.setTimeout(async () => {
      const patches = new Map(pendingPatchRef.current)
      pendingPatchRef.current.clear()
      for (const [pid, pp] of patches) {
        try { await api.put(`/storage/objects/${pid}`, pp) }
        catch (e) { setError(errorText(e)) }
      }
    }, 350)
  }

  // パレット 90° 回転 toggle (ingredient 限定、 0 ⇄ 90)
  // 寸法も同時に入れ替え (長辺/短辺の向きが反転)
  // ↓ refs を使って常に最新の state を参照 (useEffect の stale closure を回避)
  const objectsRef = useRef(objects)
  useEffect(() => { objectsRef.current = objects }, [objects])
  const selectedIdRef = useRef(selectedId)
  useEffect(() => { selectedIdRef.current = selectedId }, [selectedId])
  function rotateSelectedPallet() {
    if (targetKind !== 'ingredient') return
    const sid = selectedIdRef.current
    if (sid == null) return
    const o = objectsRef.current.find(x => x.id === sid)
    if (!o) return
    const newOrient = (o.orientation ?? 0) === 0 ? 90 : 0
    // 現在の中心位置を保持しながら、 width/height を入れ替える
    const cx = o.x + o.width / 2
    const cy = o.y + o.height / 2
    const newW = o.height
    const newH = o.width
    updateObject(sid, {
      width: newW,
      height: newH,
      x: Math.max(0, cx - newW / 2),
      y: Math.max(0, cy - newH / 2),
      orientation: newOrient,
    })
  }
  // rotateSelectedPallet の latest ref (キーボード handler の stale closure 回避)
  const rotateFnRef = useRef(rotateSelectedPallet)
  useEffect(() => { rotateFnRef.current = rotateSelectedPallet })

  // パレット段数変更 (6 or 7)
  function setSelectedPalletTiers(tiers: 6 | 7) {
    const sid = selectedIdRef.current
    if (sid == null) return
    const o = objectsRef.current.find(x => x.id === sid)
    if (!o) return
    const current = o.pallet_tiers ?? 7
    if (current === tiers) return
    updateObject(sid, { pallet_tiers: tiers })
  }

  // 「パターン変更」 ポップオーバー (段数選択 用)
  const [patternPopoverOpen, setPatternPopoverOpen] = useState(false)
  useEffect(() => {
    if (!patternPopoverOpen) return
    function onClick(e: MouseEvent) {
      const t = e.target as HTMLElement
      if (!t.closest('.pattern-popover') && !t.closest('.pattern-popover-trigger')) {
        setPatternPopoverOpen(false)
      }
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [patternPopoverOpen])

  async function deleteObject() {
    if (!selectedObject) return
    if (!(await dialog.confirm({
      title: 'オブジェクトを削除',
      message: 'このオブジェクトを削除します。紐付きも一緒に削除されます。',
      okLabel: '削除',
      variant: 'danger',
    }))) return
    setBusy(true); setError(null)
    try {
      await api.delete(`/storage/objects/${selectedObject.id}`)
      setSelectedId(null)
      stateFetch.reload()
    } catch (e) {
      setError(errorText(e))
    } finally { setBusy(false) }
  }

  // ---- アイテム操作 ----
  // 紐付けモーダル経由の追加 (拡張#1)。
  // モーダル表示状態 linkModalOpen は materials fetch 条件で参照するため上方で宣言済み。
  async function addItemViaModal(params: {
    targetId: number | null  // null = 空 パレ (= 新 model 専用)
    capacity: number | null
    priority: number
    pallet_index?: number    // 新 model: 0..N-1
    tier_count?: number      // 新 model: 0..7
    case_count?: number      // 新 model: 0..6
  }) {
    if (!selectedObject) return
    setBusy(true); setError(null)
    try {
      await api.post(`/storage/objects/${selectedObject.id}/items`, {
        object_id: selectedObject.id,
        material_id:    params.targetId != null && targetKind === 'material'   ? params.targetId : null,
        inbound_lot_id: params.targetId != null && targetKind === 'ingredient' ? params.targetId : null,
        capacity: params.capacity,
        priority: params.priority || 50,
        pallet_index: params.pallet_index,
        tier_count:   params.tier_count,
        case_count:   params.case_count,
      })
      stateFetch.reload()
      lots.reload()  // 紐付け 可能 残数 (= remaining - bound_kg) を 即時 更新
    } catch (e) { setError(errorText(e)); throw e }
    finally { setBusy(false) }
  }

  // 確認 dialog は 呼び出し 側 (StorageLinkModal の ExistingRow) で 出す。
  // ここ で 出すと スチール コンテナ の 「−」 (1 個 減らす) や 「全削除 ×」 の 都度
  // dialog が 出て 煩わしい (= 解除 件数 や context を 知らない ため 文言 が 雑)。
  async function removeItem(itemId: number) {
    setBusy(true)
    try {
      await api.delete(`/storage/items/${itemId}`)
      stateFetch.reload()
      lots.reload()  // 紐付け 可能 残数 を 即時 更新
    } catch (e) { setError(errorText(e)) }
    finally { setBusy(false) }
  }

  async function updateItem(
    itemId: number,
    patch: {
      capacity?: number | null
      priority?: number
      pallet_details?: { t: number; c: number }[] | null
      pallet_index?: number | null
      tier_count?: number | null
      case_count?: number | null
      inbound_lot_id?: number | null
      material_id?: number | null
      semifinished_lot_id?: number | null
    },
  ) {
    setBusy(true)
    try {
      await api.put(`/storage/items/${itemId}`, patch)
      stateFetch.reload()
      lots.reload()  // capacity / 紐付け 変更 で bound_kg が 変わる ため
    } catch (e) { setError(errorText(e)) }
    finally { setBusy(false) }
  }

  // ---- 棚卸エントリ (Phase A1) ----
  // モーダル が ingredient mode で 開いて いる + 選択オブジェクト 確定 の とき だけ fetch。
  // 履歴 含む 全件 を 取得 (modal 側 で 表示順 を 制御)。
  const entriesFetch = useFetch<InventoryEntry[]>(
    linkModalMode === 'ingredient' && selectedId != null
      ? `/storage/objects/${selectedId}/inventory-entries`
      : null,
  )

  // 棚卸フォーム Combobox 候補 (master + 既存 entries の 集約) — モーダル開時のみ取得
  const entrySuggestionsFetch = useFetch<import('../api/types').EntrySuggestions>(
    linkModalMode != null && selectedId != null
      ? `/storage/inventory-entries/suggestions`
      : null,
  )

  async function createEntry(body: InventoryEntryCreate) {
    if (!selectedObject) return
    setBusy(true); setError(null)
    try {
      await api.post(`/storage/objects/${selectedObject.id}/inventory-entries`, body)
      entriesFetch.reload()
    } catch (e) { setError(errorText(e)); throw e }
    finally { setBusy(false) }
  }
  async function updateEntry(entryId: number, patch: InventoryEntryUpdate) {
    setBusy(true); setError(null)
    try {
      await api.put(`/storage/inventory-entries/${entryId}`, patch)
      entriesFetch.reload()
    } catch (e) { setError(errorText(e)); throw e }
    finally { setBusy(false) }
  }
  async function deleteEntry(entryId: number) {
    setBusy(true); setError(null)
    try {
      await api.delete(`/storage/inventory-entries/${entryId}`)
      entriesFetch.reload()
    } catch (e) { setError(errorText(e)); throw e }
    finally { setBusy(false) }
  }

  // 棚卸 → 差数 → 調整出庫 (Phase A3)。 preview (dry_run=true) も commit も 同じ関数
  async function stocktakeAdjust(
    body: import('../api/types').StocktakeAdjustRequest,
  ): Promise<import('../api/types').StocktakeAdjustResult> {
    if (!selectedObject) throw new Error('object not selected')
    setBusy(true); setError(null)
    try {
      const result = await api.post<import('../api/types').StocktakeAdjustResult>(
        `/storage/objects/${selectedObject.id}/stocktake-adjust`, body,
      )
      // commit 成功 時のみ 関連 fetch を 再ロード (在庫が変わるので)
      if (!body.dry_run) {
        entriesFetch.reload()
        if ('reload' in stateFetch) (stateFetch as { reload: () => void }).reload()
        if ('reload' in lots) (lots as { reload: () => void }).reload()
      }
      return result
    } catch (e) { setError(errorText(e)); throw e }
    finally { setBusy(false) }
  }

  // キーボードショートカット (Figma/Sketch 風: V=選択, R=追加, ESC=選択解除, DEL=削除)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // input 内のキー入力は無視
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'v' || e.key === 'V') { setTool('select'); e.preventDefault() }
      else if (e.key === 'r' || e.key === 'R') {
        if (editMode && targetKind === 'ingredient') { setTool('add'); e.preventDefault() }
      }
      else if (e.key === 'Escape') {
        setTool('select'); setSelectedId(null); setSelectedIds(new Set())
        setSelectedWallId(null)
        e.preventDefault()
      }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && editMode) {
        // scope 厳格 分離: floor で 壁 削除、 object で object 削除。 互い に 不可。
        if (editScope === 'floor' && selectedWallId != null) {
          e.preventDefault()
          const wid = selectedWallId
          setSelectedWallId(null)
          deleteWall(wid)
        } else if (editScope === 'object' && selectedId != null) {
          e.preventDefault(); deleteObject()
        }
      }
      else if ((e.key === 't' || e.key === 'T') && editMode && targetKind === 'ingredient') {
        // 選択中チェックは ref 経由で最新を参照
        if (selectedIdRef.current != null) {
          e.preventDefault(); rotateFnRef.current()
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editMode, editScope, selectedId, selectedWallId, targetKind])

  if (stateFetch.loading && !data) return <div className="muted">読み込み中…</div>
  if (stateFetch.error) return <div className="alert error">{stateFetch.error}</div>
  if (!layout) return <div className="muted">レイアウトが見つかりません。</div>

  return (
    <div className="storage-editor">
      {(error || msg) && (
        <div className="storage-alerts">
          {error && <div className="alert error">{error}</div>}
          {msg && <div className="alert success">{msg}</div>}
        </div>
      )}

      {/* =================================================================
       *  上ツールバー (Figma 風 UI 再設計)
       *  - レイアウト名 + 戻るリンク
       *  - モード segmented control [閲覧][棚卸][編集]
       *  - 検索ボックス
       *  - 表示モード popover
       *  - PDF
       * ================================================================= */}
      <div className="storage-top-toolbar">
        {/* タイトル */}
        <Link
          to={`/storage/${targetKind}${cropFrom ? `?from=${cropFrom}` : ''}`}
          className="muted" style={{ fontSize: 11, whiteSpace: 'nowrap' }}
          title="一覧へ戻る"
        >←</Link>
        <div className="toolbar-title">
          <div className="toolbar-title-name">{layout.name}</div>
          <div className="toolbar-title-meta">
            {targetKind === 'material' ? '資材' : '原料'}
            {layout.division != null && layout.division !== 0
              && ` / ${({1:'生姜',2:'大蒜',3:'長芋',4:'牛蒡',5:'薩摩芋',6:'物流'} as Record<number,string>)[layout.division] ?? `事業${layout.division}部`}`}
          </div>
        </div>

        {/* モード segmented (閲覧 ↔ 棚卸 ↔ オブジェクト編集 ↔ 床面・間取り編集) */}
        <div className="segmented-control" role="tablist">
          <button
            className={!stocktakeMode && !editMode ? 'active' : ''}
            onClick={() => { setStocktakeMode(false); setEditMode(false) }}
            title="閲覧モード (デフォルト)"
          ><Eye size={14} strokeWidth={1.7} /> 閲覧</button>
          {targetKind === 'material' && (
            <button
              className={stocktakeMode ? 'active' : ''}
              onClick={() => { setStocktakeMode(true); setEditMode(false) }}
              title="棚卸モード"
            ><ClipboardList size={14} strokeWidth={1.7} /> 棚卸</button>
          )}
          {isAdmin && (
            <button
              className={editMode && editScope === 'object' ? 'active' : ''}
              onClick={() => {
                setEditMode(true); setStocktakeMode(false)
                setEditScope('object'); setTool('select')
                setSelectedWallId(null)   // floor の壁選択 を 持ち越さない
              }}
              title="オブジェクト編集モード (パレット/資材の配置・移動・削除)"
            ><Pencil size={14} strokeWidth={1.7} /> オブジェクト</button>
          )}
          {isAdmin && (
            <button
              className={editMode && editScope === 'floor' ? 'active' : ''}
              onClick={() => {
                setEditMode(true); setStocktakeMode(false)
                setEditScope('floor'); setTool('select')
                setSelectedId(null); setSelectedIds(new Set())  // object 選択 を 持ち越さない
              }}
              title="床面・間取り編集モード (admin: 床面アウトライン / 壁 / 構造変更)"
            ><Square size={14} strokeWidth={1.7} /> 間取り</button>
          )}
        </div>

        {/* グループ 区切り: モード ↔ ツール */}
        {editMode && <div className="toolbar-sep" />}

        {editMode && targetKind === 'ingredient' && (
          <>
            {/* 'select'/'add' segmented — ingredient は 常に 3D ビュー (Phase 5 完了)、
                3D 内で add する 唯一 手段。
                seg-sub = サブ階層 で active 色 を 弱める (= 主モード との 視覚区別)。 */}
            <div className="segmented-control seg-sub" role="tablist" style={{ marginLeft: 6 }}>
              <Tooltip content="選択ツール (V) — クリックで選択、 ドラッグで移動">
                <button
                  className={tool === 'select' ? 'active' : ''}
                  onClick={() => setTool('select')}
                  aria-label="選択"
                ><MousePointer2 size={14} strokeWidth={1.7} /></button>
              </Tooltip>
              <Tooltip content="追加ツール (R) — クリックで新規オブジェクト">
                <button
                  className={tool === 'add' ? 'active' : ''}
                  onClick={() => setTool('add')}
                  aria-label="追加"
                ><SquarePlus size={14} strokeWidth={1.7} /></button>
              </Tooltip>
            </div>
            {/* 追加 タイプ 切替 (ingredient + add ツール + 長芋 layout 時 のみ):
                パレット / スチール。 スチール コンテナ は 長芋 専用 (= 他作物 では
                パレット 一択 で 切替 UI を 出さない)。 */}
            {tool === 'add' && targetKind === 'ingredient' && layout.division === 3 && (
              <div className="segmented-control seg-detail" role="tablist" style={{ marginLeft: 6 }}>
                <button
                  className={newObjectType === 'pallet' ? 'active' : ''}
                  onClick={() => setNewObjectType('pallet')}
                  title="新規 オブジェクト = パレット (84×72)"
                >パレット</button>
                <button
                  className={newObjectType === 'steel_container' ? 'active' : ''}
                  onClick={() => setNewObjectType('steel_container')}
                  title="新規 オブジェクト = スチール コンテナ (1000×800×510mm、 長芋 専用)"
                >スチール</button>
              </div>
            )}
            {/* パレット 回転 / パターン変更 — どちらも pallet 限定 機能 なので、
                選択 オブジェクト が steel_container の とき は 非表示。 */}
            {selectedObject?.object_type !== 'steel_container' && (
              <Tooltip content="選択パレットを 90° 回転 (T)">
                <button
                  className="toolbar-icon-btn"
                  onClick={rotateSelectedPallet}
                  disabled={selectedId == null}
                  aria-label="パレット回転"
                  style={{ marginLeft: 4 }}
                ><RotateCw size={14} strokeWidth={1.7} /></button>
              </Tooltip>
            )}
            {/* パレット 段数 / パターン変更 (popover) — pallet 限定 */}
            <div style={{ position: 'relative', display: 'inline-block', marginLeft: 4 }}>
              {selectedObject?.object_type !== 'steel_container' && (
              <Tooltip content="パターン変更 (段数選択)">
                <button
                  className="toolbar-icon-btn pattern-popover-trigger"
                  onClick={() => setPatternPopoverOpen(v => !v)}
                  disabled={selectedId == null}
                  aria-label="パターン変更"
                ><Layers size={14} strokeWidth={1.7} /></button>
              </Tooltip>
              )}
              {patternPopoverOpen && selectedObject && (
                <div className="pattern-popover" style={{
                  position: 'absolute', top: '100%', left: 0, marginTop: 4,
                  zIndex: 100, minWidth: 220,
                  background: 'var(--panel)',
                  border: '1px solid var(--border-strong)',
                  borderRadius: 6, padding: 10,
                  boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
                  fontSize: 12,
                }}>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>パターン変更</div>
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ color: 'var(--muted)', fontSize: 11, marginBottom: 4 }}>段数</div>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {([7, 6] as const).map(t => {
                        const active = (selectedObject.pallet_tiers ?? 7) === t
                        return (
                          <button key={t}
                            onClick={() => { setSelectedPalletTiers(t); setPatternPopoverOpen(false) }}
                            style={{
                              flex: 1, padding: '6px 10px',
                              background: active ? 'var(--primary)' : 'transparent',
                              color: active ? '#fff' : 'var(--text)',
                              border: '1px solid ' + (active ? 'var(--primary)' : 'var(--border)'),
                              borderRadius: 4, cursor: 'pointer',
                              fontWeight: active ? 600 : 400,
                            }}>
                            {t}段
                          </button>
                        )
                      })}
                    </div>
                  </div>
                  <div>
                    <div style={{ color: 'var(--muted)', fontSize: 11, marginBottom: 4 }}>
                      段あたりケース数
                    </div>
                    <div style={{
                      padding: '6px 10px',
                      background: 'var(--surface, #f5f4ed)',
                      border: '1px dashed var(--border)',
                      borderRadius: 4,
                      color: 'var(--muted)', fontSize: 11,
                    }}>
                      7 ケース (窓積み) — 将来追加予定
                    </div>
                  </div>
                </div>
              )}
            </div>
            {/* 旧 toolbar 内 アクション (紐付け / 半製品 / ラベル / 削除) は
                詳細パネル の ヘッダ に 移動 (2026-05-26 UX 改善 #4 = toolbar 軽量化)。
                ここ から は 削除。 */}
          </>
        )}
        {/* material 用 紐付け編集 + 削除 button (material 表は ingredient と別物)。
            選択なし時 は 非表示 (ghost 表示 排除)。 floor scope では オブジェクト 操作 不可。
            削除 button は iPad 対応 (DEL キー 不可) のため 必須。 */}
        {editMode && editScope === 'object' && targetKind === 'material' && selectedId != null && (
          <>
            <Tooltip content="選択オブジェクトの紐付け資材編集">
              <button
                className="toolbar-icon-btn active"
                onClick={() => setLinkModalMode('ingredient')}
                aria-label="紐付け編集"
                style={{ marginLeft: 6 }}
              ><Package size={14} strokeWidth={1.7} /></button>
            </Tooltip>
            {/* ラベル 編集 (= 原料側 と 同様、 storage_objects.label を 編集) — 2026-05-30 追加 */}
            <Tooltip content="選択オブジェクトのラベル">
              <button
                className="toolbar-icon-btn"
                onClick={() => {
                  setLabelDraft(selectedObject?.label ?? '')
                  setLabelModalOpen(true)
                }}
                aria-label="ラベル"
                style={{ marginLeft: 4 }}
              ><Pencil size={14} strokeWidth={1.7} /></button>
            </Tooltip>
            <Tooltip content="選択オブジェクトを削除 (DEL)">
              <button
                className="toolbar-icon-btn"
                onClick={deleteObject}
                aria-label="削除"
                style={{ marginLeft: 4, color: 'var(--danger)' }}
              ><X size={14} strokeWidth={1.7} /></button>
            </Tooltip>
          </>
        )}

        <div className="toolbar-spacer" />

        {/* 検索/表示/凡例 FAB は canvas 内右上 に 配置 (toolbar 横幅 を 節約)。
            → 下 の storage-layout-grid 内 を 参照 */}

        {/* グループ 区切り: ビュー (平面/立体) */}
        {targetKind === 'ingredient' && <div className="toolbar-sep" />}

        {/* ビュー 操作 (原料 ingredient のみ) — 平面ロック + Fit-to-screen。
            Phase 5 で 2D ビュー 廃止、 「平面/立体」 トグル は 削除。 平面ロック は そのまま 残す。 */}
        {targetKind === 'ingredient' && (
          <>
            <Tooltip content={planarLocked
              ? '平面ロックを解除 (orbit 自由) — 操作で斜めにできる'
              : '平面視点に戻る (自動で真上+初期向きへ、 アニメ中は操作不可)'}>
              <button
                className={`toolbar-icon-btn ${!planarLocked ? 'active' : ''}`}
                onClick={toggleLock}
                aria-label={planarLocked ? '平面ロック解除' : '平面ロック'}
              >{planarLocked ? <MapIcon size={16} strokeWidth={1.7} /> : <MoveDiagonal2 size={16} strokeWidth={1.7} />}</button>
            </Tooltip>
            <Tooltip content="カメラを初期位置に戻す (Fit to screen)">
              <button
                className="toolbar-icon-btn"
                onClick={() => setFitToScreenTick(t => t + 1)}
                aria-label="カメラリセット"
                style={{ marginLeft: 4 }}
              ><Maximize2 size={16} strokeWidth={1.7} /></button>
            </Tooltip>
          </>
        )}

        {/* PDF (アイコンのみ、 ホバーでヒント) */}
        <Tooltip content={showObjectInfo
          ? '詳細表示 OFF (label のみ)'
          : '詳細表示 ON (規格 / 数量 / 仕入先 / 入荷日 を 各 object に 表示)'}>
          <button
            className={`toolbar-icon-btn ${showObjectInfo ? 'active' : ''}`}
            onClick={() => setShowObjectInfo(v => !v)}
            aria-label="詳細表示"
          ><Info size={16} strokeWidth={1.7} /></button>
        </Tooltip>
        <Tooltip content="集計表頁を開く (canvas + 産地×規格 集計表、 印刷可)">
          <Link
            to={`/storage/${targetKind}/${id}/sheet${dateFilter ? `?date=${dateFilter}` : ''}`}
            className="toolbar-icon-btn"
            aria-label="集計表頁"
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
          ><Printer size={16} strokeWidth={1.7} /></Link>
        </Tooltip>
      </div>

      <div className="storage-layout-grid">
        {/* メインビュー —
            原料 ingredient = 常に Storage3DView (Phase 5 で 2D 廃止、 床面 編集 も 3D 内 で 完結)、
            資材 material = 常に StorageCanvas (2D SVG、 床面・壁編集 が 常時 可能) */}
        <div style={{ flex: 1, minHeight: 400, position: 'relative', borderRadius: 12, overflow: 'hidden' }}>
          {/* 検索/表示モード/凡例 FAB — canvas 内 右上 absolute、 panel も 右寄せ。
              Tooltip は panel と 重複 表示 されて 邪魔 だった ので 廃止。
              aria-label + Search icon で 意味 自明。 */}
          <div className="storage-tools-fab-wrap storage-tools-fab-floating">
            <button
              className={`storage-tools-fab-btn ${
                (toolsPanelOpen || toolsPanelPinned
                  || searchTerm || dateFilter || heatmapDays || showOnlyChanged)
                  ? 'active' : ''}`}
              onClick={() => setToolsPanelOpen(o => !o)}
              aria-label="検索・表示モード・凡例"
              title="検索・表示モード・凡例"
            >
              <Search size={18} strokeWidth={1.8} />
            </button>
            {(toolsPanelOpen || toolsPanelPinned) && (
              <>
                {/* ピン中 で ない 時 だけ 外側 click で 閉じる */}
                {!toolsPanelPinned && (
                  <div
                    style={{ position: 'fixed', inset: 0, zIndex: 90 }}
                    onClick={() => setToolsPanelOpen(false)}
                  />
                )}
                <div className="storage-tools-panel">
                  <div className="storage-tools-panel-header">
                    <span className="storage-tools-panel-title">検索・表示</span>
                    <div className="storage-tools-panel-actions">
                      <button
                        className={`pin-btn ${toolsPanelPinned ? 'active' : ''}`}
                        onClick={toggleToolsPin}
                        title={toolsPanelPinned
                          ? 'ピン解除 (外側クリックで閉じる)'
                          : 'ピン留め (常駐表示)'}
                      >📌</button>
                      {!toolsPanelPinned && (
                        <button
                          className="close-btn"
                          onClick={() => setToolsPanelOpen(false)}
                          title="閉じる"
                        >×</button>
                      )}
                    </div>
                  </div>
                  <div className="storage-tools-panel-body">
                    {/* 検索 */}
                    <div className="field">
                      <label>検索</label>
                      <div className="inline" style={{ gap: 4 }}>
                        <Search size={14} strokeWidth={1.7} style={{ opacity: 0.5 }} />
                        <input
                          type="search"
                          placeholder="コード / 規格 / ラベル"
                          value={searchTerm}
                          onChange={(e) => setSearchTerm(e.target.value)}
                          style={{ flex: 1 }}
                        />
                        {searchTerm && (
                          <button
                            className="ghost small"
                            onClick={() => setSearchTerm('')}
                            title="クリア"
                          ><X size={12} strokeWidth={1.8} /></button>
                        )}
                      </div>
                    </div>
                    {/* 表示日 */}
                    <div className="field">
                      <label>表示日</label>
                      <div className="inline" style={{ gap: 6 }}>
                        <input
                          type="date" value={dateFilter}
                          onChange={(e) => setDateFilter(e.target.value)}
                          style={{ flex: 1, fontSize: 12 }}
                        />
                        <button className="ghost small" onClick={() => setDateFilter('')}
                                disabled={!dateFilter}>×</button>
                      </div>
                    </div>
                    {/* 表示種別 */}
                    <div className="field">
                      <label>表示種別</label>
                      <select
                        value={heatmapDays ?? ''}
                        onChange={(e) => setHeatmapDays(e.target.value ? Number(e.target.value) : null)}
                      >
                        <option value="">在庫量モード</option>
                        <option value="7">ヒートマップ (7日)</option>
                        <option value="14">ヒートマップ (14日)</option>
                        <option value="30">ヒートマップ (30日)</option>
                        <option value="90">ヒートマップ (90日)</option>
                      </select>
                    </div>
                    <label className="inline" style={{ gap: 6, fontSize: 12, margin: 0, fontWeight: 400 }}>
                      <input
                        type="checkbox" style={{ width: 'auto' }}
                        checked={showOnlyChanged}
                        onChange={(e) => setShowOnlyChanged(e.target.checked)}
                      /> 変化のあった在庫のみ強調
                    </label>
                    {/* 凡例 */}
                    <div className="field storage-tools-legend">
                      <label>凡例</label>
                      {heatmapDays ? (
                        <>
                          <div style={{ fontSize: 12, marginBottom: 6 }}>
                            過去 {heatmapDays} 日間の在庫変動量
                          </div>
                          <div style={{
                            height: 18,
                            background: 'linear-gradient(to right, hsl(60,60%,75%) 0%, hsl(30,75%,62%) 50%, hsl(0,90%,50%) 100%)',
                            borderRadius: 4, marginBottom: 4,
                          }} />
                          <div className="muted inline" style={{ fontSize: 11, justifyContent: 'space-between' }}>
                            <span>少</span><span>多</span>
                          </div>
                        </>
                      ) : (
                        <ul className="legend" style={{ margin: 0, padding: 0 }}>
                          <li><span className="sw" style={{ background: FILL_COLOR.unlinked }} /> 未紐付け</li>
                          <li><span className="sw" style={{ background: FILL_COLOR.empty }} /> 在庫なし</li>
                          <li><span className="sw" style={{ background: FILL_COLOR.low }} /> 少 (&lt;20%)</li>
                          <li><span className="sw" style={{ background: FILL_COLOR.mid }} /> 中 (20-70%)</li>
                          <li><span className="sw" style={{ background: FILL_COLOR.full }} /> 多 (≥70%)</li>
                          <li><span className="sw" style={{ background: FILL_COLOR.over }} /> 容量超過</li>
                        </ul>
                      )}
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>

          {targetKind === 'ingredient' ? (
            <Suspense fallback={
              <div style={{
                position: 'absolute', inset: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: '#e8e4d6', color: 'var(--muted)', fontSize: 13,
              }}>3D ビュー 読み込み中…</div>
            }>
              <Storage3DView
                imageUrl={layout.image_url}
                imageWidth={layout.image_width}
                imageHeight={layout.image_height}
                objects={objects}
                selectedId={selectedId}
                selectedIds={selectedIds}
                fillByObject={fillByObject}
                casesByObject={casesByObject}
                palletRowsByObject={palletRowsByObject}
                containerCountByObject={containerCountByObject}
                containerRowsByObject={containerRowsByObject}
                labelByObject={new Map(objects.map((o) => [o.id, o.label || `#${o.id}`]))}
                infoLinesByObject={infoLinesByObject}
                planarLocked={planarLocked}
                editable={editMode}
                tool={tool}
                editScope={editScope}
                floorOutline={outlineLocal}
                onFloorOutlineChange={changeOutline}
                walls={wallsLocal}
                fitToScreenTick={fitToScreenTick}
                onSelect={(id, shift) => {
                  if (id == null) { setSelectedId(null); setSelectedIds(new Set()); return }
                  if (shift) {
                    setSelectedIds((s) => {
                      const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n
                    })
                    setSelectedId(id)
                  } else {
                    setSelectedId(id); setSelectedIds(new Set([id]))
                  }
                }}
                onCreate={createObject}
                onUpdate={(id, patch) => updateObject(id, patch)}
              />
              {/* 操作ヒント overlay (視点に応じて文言切替) */}
              <div style={{
                position: 'absolute', top: 10, left: 10, zIndex: 5,
                background: 'rgba(31, 30, 27, 0.78)',
                color: '#ece7da',
                fontSize: 11, padding: '8px 12px', borderRadius: 8,
                pointerEvents: 'none', lineHeight: 1.5,
                backdropFilter: 'blur(4px)',
                boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
                maxWidth: 220,
              }}>
                <div style={{ fontWeight: 600, marginBottom: 2 }}>
                  {planarLocked ? '視点: 平面ロック中' : '視点: 解除 (orbit 自由)'}
                </div>
                {!planarLocked ? (
                  <>
                    {hasFinePointer
                      ? <div>マウス: 左=回転 / 右=パン / ホイール=ズーム</div>
                      : <div>タッチ: 1本指=回転 / 2本指=パン+ピンチ</div>}
                    <div>クリック = オブジェクト選択</div>
                  </>
                ) : (
                  <>
                    {/* 床面 アウトライン 0 件 + 間取り モード = drag-to-rect ヒント */}
                    {editMode && editScope === 'floor' && (outlineLocal?.length ?? 0) < 3 && (
                      <div style={{ color: '#ffd66b', fontWeight: 600 }}>
                        📐 床面 を {hasFinePointer ? 'ドラッグ' : '指で 引いて'} 倉庫 の 輪郭 を 描画
                      </div>
                    )}
                    {editMode && editScope === 'floor' && (outlineLocal?.length ?? 0) >= 3 && (
                      <>
                        <div>頂点 を {hasFinePointer ? 'ドラッグ' : 'タッチ移動'} で 形状変更</div>
                        <div>中点 = 頂点 追加 / 頂点 ダブル{hasFinePointer ? 'クリック' : 'タップ'} = 削除</div>
                      </>
                    )}
                    {editMode && editScope === 'object' && tool === 'add' && (
                      <div style={{ color: '#ffd66b' }}>空白{hasFinePointer ? 'クリック' : 'タップ'} = オブジェクト追加</div>
                    )}
                    {editMode && editScope === 'object' && tool === 'select' && (
                      <>
                        <div>{hasFinePointer ? 'クリック' : 'タップ'} = 選択 (Shift で複数)</div>
                        <div>選択済を{hasFinePointer ? 'ドラッグ' : 'タッチ移動'} で 位置変更</div>
                      </>
                    )}
                    {!editMode && <div>{hasFinePointer ? 'クリック' : 'タップ'} = 選択</div>}
                    {hasFinePointer
                      ? <div>マウス: 右ドラッグ=パン / ホイール=ズーム</div>
                      : <div>タッチ: 1本指=パン / 2本指=ピンチでズーム</div>}
                    {/* キーボード ショートカット は デスクトップ (mouse) でのみ */}
                    {editMode && hasFinePointer && (
                      <div className="muted" style={{ fontSize: 10, marginTop: 4 }}>
                        V=選択 R=追加 ESC=解除 DEL=削除
                      </div>
                    )}
                  </>
                )}
              </div>
            </Suspense>
          ) : (
            <StorageCanvas
              imageUrl={layout.image_url}
              imageWidth={layout.image_width}
              imageHeight={layout.image_height}
              objects={objects}
              walls={wallsLocal}
              selectedId={selectedId}
              selectedIds={selectedIds}
              highlightIds={highlightIds}
              fillByObject={fillByObject}
              subtitleByObject={subtitleByObject}
              infoLinesByObject={infoLinesByObject}
              casesByObject={casesByObject}
              editable={editMode}
              editScope={editScope}
              onSelect={(id, shift) => {
                if (id == null) { setSelectedId(null); setSelectedIds(new Set()); return }
                if (shift) {
                  setSelectedIds((s) => {
                    const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n
                  })
                  setSelectedId(id)
                } else {
                  setSelectedId(id); setSelectedIds(new Set([id]))
                }
              }}
              onSelectMany={(ids, additive) => {
                setSelectedIds((s) => {
                  const n = additive ? new Set(s) : new Set<number>()
                  for (const id of ids) n.add(id)
                  return n
                })
                if (ids.length > 0) setSelectedId(ids[ids.length - 1])
              }}
              onCreate={createObject}
              onUpdate={(oid, patch) => updateObject(oid, patch)}
              onUpdateMany={updateManyObjects}
              onDuplicate={duplicateObject}
              onWallCreate={createWall}
              onWallDelete={deleteWall}
              selectedWallId={selectedWallId}
              onSelectWall={(wid) => { setSelectedWallId(wid); setSelectedId(null) }}
              floorOutline={outlineLocal}
              onFloorOutlineChange={changeOutline}
              canUndo={history.length > 0}
              canRedo={future.length > 0}
              onUndo={undo}
              onRedo={redo}
            />
          )}
        </div>

        {/* 右端グリップ — 非表示時にクリックで開く (Notion / VS Code 風) */}
        {!sidePanelVisible && (
          <Tooltip content="情報パネルを開く (ピンで常時表示)">
            <button
              type="button"
              onClick={() => setSidePanelHoverOpen(true)}
              aria-label="情報パネルを開く"
              className="storage-side-grip"
            />
          </Tooltip>
        )}

        {/* =====================================================
         *  右インスペクタ — 「選択中の詳細」 だけに集中
         *  sidePanelVisible が false なら非表示。 ピン留めで常時表示。
         * ===================================================== */}
        {sidePanelVisible && (
        <div className={'storage-side-panel ' + (sidePanelPinned ? 'pinned' : 'overlay')}>
          {/* ピン トグル + 閉じる ボタン */}
          <div className="storage-side-panel-header">
            <Tooltip content={sidePanelPinned ? 'ピン解除 (パネルを 自動で隠す)' : 'ピン留め (常時表示)'}>
              <button
                type="button"
                onClick={togglePin}
                aria-label="ピン留め"
                aria-pressed={sidePanelPinned}
                className={'side-pin-btn ' + (sidePanelPinned ? 'active' : '')}
              >📌</button>
            </Tooltip>
            {/* X 閉じるボタン: pinned でも 常時 表示。 1 click で 必ず 閉じる
                (pinned もリセット + hoverOpen も false に)。 user 混乱回避。 */}
            <Tooltip content="パネルを閉じる">
              <button
                type="button"
                onClick={() => {
                  setSidePanelHoverOpen(false)
                  if (sidePanelPinned) {
                    setSidePanelPinned(false)
                    try { localStorage.setItem(pinKey, 'false') } catch { /* noop */ }
                  }
                }}
                aria-label="閉じる"
                className="side-close-btn"
              ><X size={14} strokeWidth={1.8} /></button>
            </Tooltip>
          </div>
          {/* 棚卸モードでは StocktakePanel を最優先で表示 (カウント作業に集中) */}
          {stocktakeMode && targetKind === 'material' && materials.data ? (
            <div className="side-section side-section-flex">
              <StocktakePanel
                layoutId={layout.id}
                layoutDivision={layout.division ?? null}
                objects={objects}
                items={items}
                materials={materials.data}
                selectedObjectId={selectedId}
                onCountSaved={() => { materials.reload(); stateFetch.reload() }}
                onFilterChange={(d, div) => { setStocktakeDate(d); setStocktakeDivision(div) }}
              />
            </div>
          ) : (
            /* 情報専用パネル: 上=倉庫サマリー (常時) + 下=オブジェクト詳細 (選択時) */
            <div className="side-section side-section-flex" style={{
              display: 'flex', flexDirection: 'column', gap: 0, padding: 0,
            }}>
              {/* ── 上半分: 倉庫サマリー (常時表示) ── */}
              <WarehouseSummary
                targetKind={targetKind}
                objects={objects}
                itemsByObject={itemsByObject}
                distribution={distribution}
                kgPerCaseByLot={kgPerCaseByLot}
              />

              {/* ── 下半分: オブジェクト詳細 (選択時のみ、 操作系なし — toolbar に集約済) ── */}
              {!selectedObject ? (
                <div style={{
                  flex: 1, padding: 24, textAlign: 'center',
                  color: 'var(--muted)', display: 'flex',
                  alignItems: 'center', justifyContent: 'center',
                  borderTop: '1px solid var(--border)',
                }}>
                  <div>
                    <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'center' }}>
                      <MapPin size={28} strokeWidth={1.4} color="var(--muted-light)" />
                    </div>
                    <div style={{ fontSize: 13 }}>オブジェクトを選択してください</div>
                    <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                      図上のオブジェクトをクリックすると詳細表示
                    </div>
                  </div>
                </div>
              ) : (
                <div style={{ padding: 14, borderTop: '1px solid var(--border)', flex: 1, overflowY: 'auto' }}>
                  {/* タイトル + タイプ バッジ (右側 に アクション ボタン群) */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <div style={{ fontWeight: 700, fontSize: 15, flex: 1, minWidth: 0,
                                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {selectedObject.label || `オブジェクト #${selectedObject.id}`}
                    </div>
                    {targetKind === 'ingredient' && (() => {
                      // ingredient のとき タイプ バッジ を 必ず 出す (パレット/スチール の 区別)。
                      const isSteel = selectedObject.object_type === 'steel_container'
                      return (
                        <span style={{
                          display: 'inline-flex', alignItems: 'center', gap: 3,
                          padding: '1px 8px', fontSize: 10.5, fontWeight: 700,
                          borderRadius: 4,
                          background: isSteel ? '#64748b' : 'var(--primary)',
                          color: '#fff',
                          letterSpacing: '0.04em',
                          flexShrink: 0,
                        }} title={isSteel
                          ? 'スチール コンテナ (1700×1000×826mm、 長芋 専用)'
                          : 'パレット (84×72)'}
                        >{isSteel ? 'スチール' : 'パレット'}</span>
                      )
                    })()}
                  </div>

                  {/* アクション ボタン 行 (toolbar から 移動、 2026-05-26 UX 改善 #4)。
                      編集モード + object scope の とき のみ。 */}
                  {editMode && editScope === 'object' && targetKind === 'ingredient' && (
                    <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
                      <button
                        onClick={() => setLinkModalMode('ingredient')}
                        style={{ padding: '5px 10px', fontSize: 12, fontWeight: 600,
                                 display: 'inline-flex', alignItems: 'center', gap: 4 }}
                      ><Package size={13} strokeWidth={1.7} /> 紐付け</button>
                      {layout.division !== 2 && (
                        <button
                          className="ghost"
                          onClick={() => setLinkModalMode('semifinished')}
                          style={{ padding: '5px 10px', fontSize: 12,
                                   display: 'inline-flex', alignItems: 'center', gap: 4 }}
                        ><Box size={13} strokeWidth={1.7} /> 半製品</button>
                      )}
                      <button
                        className="ghost"
                        onClick={() => {
                          setLabelDraft(selectedObject?.label ?? '')
                          setLabelModalOpen(true)
                        }}
                        style={{ padding: '5px 10px', fontSize: 12,
                                 display: 'inline-flex', alignItems: 'center', gap: 4 }}
                      ><Pencil size={13} strokeWidth={1.7} /> ラベル</button>
                      <button
                        className="ghost"
                        onClick={deleteObject}
                        style={{ padding: '5px 10px', fontSize: 12, color: 'var(--danger)',
                                 marginLeft: 'auto',
                                 display: 'inline-flex', alignItems: 'center', gap: 4 }}
                      ><X size={13} strokeWidth={1.7} /> 削除</button>
                    </div>
                  )}
                  <div className="muted" style={{ fontSize: 11, marginBottom: 12 }}>
                    {targetKind === 'ingredient' && (
                      selectedObject.object_type === 'steel_container'
                        ? <>1700×1000×826mm / 寸法 {num(selectedObject.width, 0)} × {num(selectedObject.height, 0)}</>
                        : <>
                            {selectedObject.orientation === 90 ? '縦長 ' : '横長 '}
                            / 寸法 {num(selectedObject.width, 0)} × {num(selectedObject.height, 0)}
                          </>
                    )}
                    {targetKind === 'material' && (
                      <>位置 ({num(selectedObject.x, 0)}, {num(selectedObject.y, 0)}) /
                      サイズ {num(selectedObject.width, 0)} × {num(selectedObject.height, 0)}</>
                    )}
                  </div>
                  {/* 紐付け items 一覧 (情報表示) */}
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
                    紐付け {targetKind === 'material' ? '資材' : '原料ロット'} ({selectedItems.length})
                  </div>
                  {selectedItems.length === 0 ? (
                    <div className="muted" style={{
                      fontSize: 12, padding: 12,
                      background: 'var(--bg-tint)', borderRadius: 6,
                      textAlign: 'center',
                    }}>
                      まだ紐付けがありません。<br />
                      上部ツールバー <strong style={{ color: 'var(--primary)' }}>📦 紐付け編集</strong> から追加してください
                    </div>
                  ) : (
                    selectedItems.map((it) => {
                      const allo = distribution.get(it.id)?.amount ?? 0
                      const totalStock = Number(it.current_stock ?? 0)
                      const cap = it.capacity == null ? null : Number(it.capacity)
                      const fill = (cap != null && cap > 0) ? Math.min(1, allo / cap) : null
                      // パレ/段/ケ 表示用
                      const kpc = it.inbound_lot_id != null ? kgPerCaseByLot.get(it.inbound_lot_id) : null
                      const alloCases = kpc ? alloCases_calc(allo, kpc) : null
                      return (
                        <div key={it.id} style={{
                          marginBottom: 8, padding: 10,
                          background: 'var(--surface)',
                          border: '1px solid var(--border)',
                          borderRadius: 6,
                        }}>
                          <div style={{ fontWeight: 700, fontSize: 13, lineHeight: 1.3, marginBottom: 4 }}>
                            {targetKind === 'material'
                              ? `${it.material_code} ${it.material_name}`
                              : `${it.lot_code} ${it.lot_spec_type}${it.lot_size_label && it.lot_size_label !== '-' ? ' ' + it.lot_size_label : ''}`
                            }
                          </div>
                          {targetKind === 'ingredient' && it.lot_origin_name && (
                            <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
                              {it.lot_origin_name}
                            </div>
                          )}
                          <div style={{
                            display: 'grid', gridTemplateColumns: '1fr 1fr',
                            gap: 4, fontSize: 12, marginTop: 4,
                          }}>
                            <div>
                              <span className="muted">合計残量</span>
                              <div style={{ fontWeight: 700, fontSize: 14 }}>
                                {num(totalStock, 1)}
                              </div>
                            </div>
                            <div>
                              <span className="muted">ここに按分</span>
                              <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--primary)' }}>
                                {num(allo, 1)}
                              </div>
                              {alloCases != null && (
                                <div className="muted" style={{ fontSize: 10 }}>
                                  ≒ {stackShapeText(Math.round(alloCases))}
                                </div>
                              )}
                            </div>
                          </div>
                          {/* 容量/充足率 バー と 優先度 は 資材 (material) 側 のみ。
                              原料 は 「構造-主」 設計 で 容量概念 を 廃止 (2026-05-26)、
                              優先度 も 按分 ロジック なし で 未使用 のため 非表示。 */}
                          {targetKind === 'material' && cap != null && (
                            <div style={{ marginTop: 8 }}>
                              <div className="muted" style={{ fontSize: 11, marginBottom: 2 }}>
                                容量 {num(cap, 0)} / 充足 {fill != null ? `${Math.round(fill * 100)}%` : '—'}
                              </div>
                              <div style={{
                                height: 6, background: 'var(--border)', borderRadius: 3,
                                overflow: 'hidden',
                              }}>
                                <div style={{
                                  height: '100%',
                                  width: fill != null ? `${Math.min(100, fill * 100)}%` : '0%',
                                  background: fill != null && fill > 1
                                    ? 'var(--danger)' : 'var(--primary)',
                                }} />
                              </div>
                            </div>
                          )}
                          {targetKind === 'material' && (
                            <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                              優先度: <strong>{it.priority}</strong>
                            </div>
                          )}
                        </div>
                      )
                    })
                  )}
                </div>
              )}
            </div>
          )}

          {/* 隠し file input (画像アップロード機能の将来復活用) */}
          <input
            ref={fileInputRef} type="file" accept="image/*"
            onChange={onFileChange}
            style={{ display: 'none' }}
          />
        </div>
        )}
      </div>

      {/* 半製品: 棚卸登録モーダル */}
      {selectedObject && linkModalMode === 'semifinished' && (
        <SemifinishedRegisterModal
          objectId={selectedObject.id}
          objectLabel={selectedObject.label || `オブジェクト #${selectedObject.id}`}
          cropId={layout.division ?? undefined}
          existingLinks={selectedItems
            .filter((it) => it.semifinished_lot_id != null)
            .map((it) => ({
              id: it.id,
              semifinished_lot_id: it.semifinished_lot_id!,
              code: it.semifin_code ?? '?',
              base_kg: String(it.semifin_base_kg ?? '0'),
              spec_type: it.semifin_spec_type ?? '',
              grade_level: it.semifin_grade_level ?? '-',
              size_label: it.semifin_size_label ?? '-',
              origin_name: it.semifin_origin_name ?? '',
              status: it.semifin_status ?? 'pending',
            }))}
          onClose={() => setLinkModalMode(null)}
          onChanged={() => stateFetch.reload()}
        />
      )}

      {/* ─── 拡張#1: 紐付け編集モーダル ─── */}
      {selectedObject && linkModalMode === 'ingredient' && (
        <StorageLinkModal
          open={linkModalOpen}
          onClose={() => setLinkModalOpen(false)}
          objectId={selectedObject.id}
          objectLabel={selectedObject.label || `オブジェクト #${selectedObject.id}`}
          objectType={selectedObject.object_type ?? 'pallet'}
          targetKind={targetKind}
          onAddEmptyPallet={targetKind === 'ingredient' && selectedObject.object_type !== 'steel_container'
            ? async () => {
                // 新 model: 空 パレ を 追加。 pallet_index = 既存 max + 1 (= 後ろ に 積む)。
                // tier_count=7 (= 1 パレ 満杯) デフォルト、 case_count=0。
                const nextIdx = Math.max(-1, ...selectedItems
                  .map(it => (it.tier_count != null ? (it.pallet_index ?? 0) : -1))) + 1
                await addItemViaModal({
                  targetId: null,
                  capacity: null,
                  priority: 50,
                  pallet_index: nextIdx,
                  tier_count: 7,
                  case_count: 0,
                })
              }
            : undefined}
          onAddEmptyContainer={targetKind === 'ingredient' && selectedObject.object_type === 'steel_container'
            ? async () => {
                // 構造-主 (2026-05-27): 空 コンテナ を 追加。 pallet_index で 順序 維持。
                // tier_count は NULL の まま (= 旧 行 と 区別 不要、 全 row が 1 コンテナ)。
                const nextIdx = Math.max(-1, ...selectedItems
                  .map(it => it.pallet_index ?? -1)) + 1
                await addItemViaModal({
                  targetId: null,
                  capacity: null,
                  priority: 50,
                  pallet_index: nextIdx,
                  // tier_count/case_count は コンテナ で は 使わ ない。
                })
              }
            : undefined}
          layoutDivision={layout.division ?? null}
          existingItems={selectedItems.map((it) => ({
            id: it.id,
            material_id: it.material_id,
            inbound_lot_id: it.inbound_lot_id,
            material_code: it.material_code,
            material_name: it.material_name,
            material_supplier: it.material_supplier,
            lot_code: it.lot_code,
            lot_spec_type: it.lot_spec_type,
            lot_grade_level: it.lot_grade_level,
            lot_size_label: it.lot_size_label,
            lot_origin_name: it.lot_origin_name,
            lot_supplier_name: it.lot_supplier_name,
            lot_inbound_date: it.lot_inbound_date,
            current_stock: it.current_stock,
            capacity: it.capacity ?? null,
            priority: it.priority,
            // ロット原料の場合、 lots fetch から kg_per_case を逆引き
            kg_per_case: it.inbound_lot_id != null
              ? kgPerCaseByLot.get(it.inbound_lot_id) ?? null
              : null,
            // この object に 按分 された 量 (= distributeStock の 結果)。
            // パレット 形 換算 「ここに M kg ≒ N段+Kケ」 表示 用。
            allocated_kg: distribution.get(it.id)?.amount ?? 0,
            // パレ別 詳細 (= 各 パレット の {t,c})。 NULL/省略 で 全パレ統一 (旧)。
            pallet_details: it.pallet_details ?? null,
            // [新 model] 1 行 = 1 パレット の 構造情報
            pallet_index: it.pallet_index ?? null,
            tier_count:   it.tier_count ?? null,
            case_count:   it.case_count ?? null,
          }))}
          availableMaterials={targetKind === 'material' ? materials.data?.map((m) => ({
            material_id: m.material_id,
            code: m.code,
            item_name: m.item_name,
            supplier_name: m.supplier_name,
            remaining_qty: m.remaining_qty,
            unit: m.unit,
            division: m.division,
            category: m.category,
          })) : undefined}
          availableLots={targetKind === 'ingredient' ? lots.data?.map((l) => ({
            lot_id: l.lot_id,
            code: l.lot_code,
            spec_type: l.spec_type,
            grade_level: l.grade_level,
            size_label: l.size_label,
            origin_name: l.origin_name,
            remaining_kg: l.remaining_kg,
            crop_id: l.crop_id,
            crop_name: l.crop_name,
            inbound_date: l.inbound_date,
            supplier_name: l.supplier_name,
            kg_per_case: l.kg_per_case,
            bound_kg: l.bound_kg,
          })) : undefined}
          loadingCandidates={targetKind === 'ingredient' ? lots.loading : materials.loading}
          candidatesError={targetKind === 'ingredient' ? lots.error : materials.error}
          busy={busy}
          onAdd={addItemViaModal}
          onUpdate={updateItem}
          onRemove={removeItem}
          inventoryEntries={entriesFetch.data ?? []}
          entrySuggestions={entrySuggestionsFetch.data ?? null}
          onEntryCreate={createEntry}
          onEntryUpdate={updateEntry}
          onEntryDelete={deleteEntry}
          onStocktakeAdjust={stocktakeAdjust}
        />
      )}

      {/* ラベル編集モーダル (簡易) */}
      {labelModalOpen && selectedObject && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setLabelModalOpen(false) }}
          style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'rgba(30, 24, 12, 0.40)',
            backdropFilter: 'blur(2px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div style={{
            background: 'var(--panel)', borderRadius: 12, padding: 20,
            width: 'min(420px, 95vw)', boxShadow: 'var(--shadow-lg)',
            border: '1px solid var(--border)',
          }}>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>ラベル編集</div>
            <input
              autoFocus
              value={labelDraft}
              onChange={(e) => setLabelDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  api.put(`/storage/objects/${selectedObject.id}`, { label: labelDraft })
                    .catch((er) => setError(errorText(er)))
                  setObjectsLocal(prev => prev.map(o => o.id === selectedObject.id ? { ...o, label: labelDraft } : o))
                  setLabelModalOpen(false)
                } else if (e.key === 'Escape') setLabelModalOpen(false)
              }}
              placeholder="例: A-1, 前棚"
              style={{ width: '100%', height: 36 }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
              <button className="ghost small" onClick={() => setLabelModalOpen(false)}>取消</button>
              <button onClick={() => {
                api.put(`/storage/objects/${selectedObject.id}`, { label: labelDraft })
                  .catch((er) => setError(errorText(er)))
                setObjectsLocal(prev => prev.map(o => o.id === selectedObject.id ? { ...o, label: labelDraft } : o))
                setLabelModalOpen(false)
              }}>保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}


// kg → cases (kg_per_case が分かれば)
function alloCases_calc(kg: number, kgPerCase: number): number | null {
  if (!Number.isFinite(kg) || kg <= 0 || !Number.isFinite(kgPerCase) || kgPerCase <= 0) return null
  return kg / kgPerCase
}


// ─── 倉庫サマリー (右パネル上部) ───
// 当倉庫レイアウト内の オブジェクトに紐付けられた全在庫を集計し、 サマリー表示
function WarehouseSummary({
  targetKind, objects, itemsByObject, distribution, kgPerCaseByLot,
}: {
  targetKind: StorageTargetKind
  objects: StorageObject[]
  itemsByObject: Map<number, StorageObjectItem[]>
  distribution: Map<number, { amount: number }>
  kgPerCaseByLot: Map<number, number>
}) {
  // 総計
  let totalAlloc = 0
  let totalCap = 0
  let lotIds = new Set<number>()
  let materialIds = new Set<number>()
  let totalCases = 0
  // オブジェクト タイプ 別 集計 (steel_container を 区別)
  let palletObjCount = 0
  let steelObjCount = 0
  let steelContainerCount = 0      // = steel object 配下 の binding 数 合計
  let palletHasKpc = false         // pallet 由来 で kg_per_case が ある か

  for (const obj of objects) {
    const items = itemsByObject.get(obj.id) ?? []
    const isSteel = obj.object_type === 'steel_container'
    if (isSteel) {
      steelObjCount++
      steelContainerCount += items.length  // 1 binding = 1 コンテナ
    } else {
      palletObjCount++
    }
    for (const it of items) {
      const alloc = Number(distribution.get(it.id)?.amount ?? 0)
      totalAlloc += alloc
      if (it.capacity != null) totalCap += Number(it.capacity)
      if (it.inbound_lot_id != null) {
        lotIds.add(it.inbound_lot_id)
        const kpc = kgPerCaseByLot.get(it.inbound_lot_id)
        if (kpc && kpc > 0) {
          if (!isSteel) palletHasKpc = true       // パレット のみ で 換算 する
          if (alloc > 0) totalCases += alloc / kpc
        }
      }
      if (it.material_id != null) materialIds.add(it.material_id)
    }
  }

  const objectCount = objects.length
  const linkedObjCount = [...itemsByObject.keys()].filter(k => (itemsByObject.get(k)?.length ?? 0) > 0).length

  return (
    <div style={{ padding: '12px 14px', background: 'var(--bg-tint)' }}>
      <div style={{
        fontSize: 10.5, fontWeight: 600, color: 'var(--muted)',
        letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8,
      }}>
        倉庫サマリー
      </div>
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8,
      }}>
        <SummaryCell
          label="オブジェクト"
          value={`${linkedObjCount} / ${objectCount}`}
          hint="紐付け済 / 全数"
        />
        {targetKind === 'ingredient' ? (
          <SummaryCell
            label="ロット数"
            value={String(lotIds.size)}
          />
        ) : (
          <SummaryCell
            label="資材数"
            value={String(materialIds.size)}
          />
        )}
        <SummaryCell
          label={targetKind === 'ingredient' ? '在庫量' : '在庫数'}
          value={num(totalAlloc, 0) + (targetKind === 'ingredient' ? ' kg' : '')}
        />
        {/* 4 セル目: layout に 存在 する オブジェクト タイプ で 分岐
            ・スチール のみ → スチール 基数 (= コンテナ 合計 数)
            ・パレット のみ (kg/ケース あり) → パレット 換算
            ・混在 → スチール 数 + パレット 換算 (= 1 セル に 縦並び)
            ・どちらでも ない (material 等) → 充足率 or 空 */}
        {targetKind === 'ingredient' && steelObjCount > 0 && palletObjCount === 0 ? (
          <SummaryCell
            label="スチール 数"
            value={`${steelContainerCount} 基`}
            hint={`${steelObjCount} 配置`}
          />
        ) : targetKind === 'ingredient' && palletObjCount > 0 && palletHasKpc && steelObjCount === 0 ? (
          <SummaryCell
            label="パレット換算"
            value={stackShapeText(Math.round(totalCases)) || '—'}
            hint={`${num(totalCases, 0)} ケース`}
          />
        ) : targetKind === 'ingredient' && steelObjCount > 0 && palletObjCount > 0 ? (
          <SummaryCell
            label="混在"
            value={`スチール ${steelContainerCount} 基`}
            hint={palletHasKpc
              ? `パレット ≒ ${stackShapeText(Math.round(totalCases)) || '—'}`
              : `パレット ${palletObjCount} 配置`}
          />
        ) : totalCap > 0 ? (
          <SummaryCell
            label="充足率"
            value={`${Math.round(totalAlloc / totalCap * 100)}%`}
            hint={`${num(totalAlloc, 0)} / ${num(totalCap, 0)}`}
          />
        ) : (
          <SummaryCell label="" value="" />
        )}
      </div>
    </div>
  )
}

function SummaryCell({ label, value, hint }: { label: string; value: string; hint?: string }) {
  if (!label && !value) return <div />
  return (
    <div style={{
      background: 'var(--panel)',
      border: '1px solid var(--border)',
      borderRadius: 8,
      padding: '8px 10px',
    }}>
      <div className="muted" style={{ fontSize: 10, letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>
        {value}
      </div>
      {hint && (
        <div className="muted" style={{ fontSize: 10, marginTop: 1, fontVariantNumeric: 'tabular-nums' }}>
          {hint}
        </div>
      )}
    </div>
  )
}
