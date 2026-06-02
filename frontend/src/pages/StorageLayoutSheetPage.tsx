/**
 * StorageLayoutSheetPage — 集計表頁 (Phase A2.1: read-only)
 * =====================================================
 *
 * 役割:
 *   - 既存 「印刷」 ボタン から 遷移 して くる editable な 集計表 ページ。
 *   - A3 横 1 枚 想定: 左 = canvas (read-only)、 右 = 棚卸エントリ 集計表。
 *   - 集計表 は (大分類, 小分類) で サブ表 に 分け、 各 サブ表 内 で
 *     (産地, 規格, サブ規格) に group by 集計 (cases / total_kg sum)。
 *
 * Phase A2.1 ではタイトル/自由テキスト編集 と 印刷 CSS 詳細 は 未実装。
 * → Phase A2.2 で editable 化 + 印刷レイアウト 調整。
 *
 * データソース は storage_object_inventory_entries のみ (canvas は 既存
 * 紐付け を 表示 する だけ で、 集計表 と は 独立)。
 */

import { useMemo, useState, useEffect, useRef } from 'react'
import { useParams, useSearchParams, Link } from 'react-router-dom'
import { ArrowLeft, Printer, Download } from 'lucide-react'
import { api } from '../api/client'
import { useFetch } from '../lib/useFetch'
import { useDialog } from '../components/Dialog'
import { num, errorText, formatSpecCombined } from '../lib/format'
import { buildInfoLinesMap, type LotInfo } from '../lib/storageObjectInfo'
import { distributeStock } from '../lib/storageDistribution'
import { Eye, EyeOff, PanelLeftClose, Columns2, Columns3, Layers, List, Type } from 'lucide-react'
import StorageSheetPlanView, { type LegendEntry } from '../components/StorageSheetPlanView'
import EditableText from '../components/EditableText'
import type {
  InventoryEntry, LayoutState, StorageObjectItem,
  StorageTargetKind,
} from '../api/types'

// 色分け 軸 用 categorical palette (ColorBrewer Set2 系、 印刷 + colorblind 配慮)。
// 8 色 を 超える 色分け は industry 推奨 NG なので 9 色目 以降 は ローテーション。
const CATEGORICAL_PALETTE = [
  '#a8d8b9',  // soft green
  '#a5c8e1',  // soft blue
  '#f4cccc',  // soft pink
  '#f9d49b',  // soft orange
  '#cebbe4',  // soft lavender
  '#fff0a8',  // soft yellow
  '#c9b194',  // tan
  '#b5d4b5',  // sage
]
const MIXED_LABEL = '混在'
const MIXED_COLOR = '#d4d0c4'   // 中間 グレー (= 「複数 値 が ある」 を 示す)

const DIVISION_LABEL: Record<number, string> = {
  0: '未割当', 1: '生姜', 2: '大蒜', 3: '長芋', 4: '牛蒡', 5: '薩摩芋', 6: '物流',
}

// =============================================================================
// API 型
// =============================================================================

interface SheetRow {
  origin: string | null
  spec: string | null
  sub_spec: string | null
  cases_sum: number | null
  kg_per_case_repr: number | null
  total_kg_sum: number | null
  entry_count: number
}

interface SheetGroup {
  category_major: string | null
  category_minor: string | null
  rows: SheetRow[]
}

interface SheetData {
  layout: {
    id: number; name: string; division: number | null;
    target_kind: StorageTargetKind;
    image_url: string | null; image_width: number | null; image_height: number | null;
  }
  date: string | null
  groups: SheetGroup[]
}

interface Props {
  targetKind: StorageTargetKind
}

// =============================================================================
// Page
// =============================================================================

export default function StorageLayoutSheetPage({ targetKind }: Props) {
  const dialog = useDialog()
  const { id } = useParams<{ id: string }>()
  const [searchParams] = useSearchParams()

  // 表示日: 上ツールバー の dateFilter と 連動 (URL クエリ ?date=YYYY-MM-DD)
  const initialDate = searchParams.get('date') || ''
  const [dateFilter, setDateFilter] = useState<string>(initialDate)
  const [importing, setImporting] = useState(false)
  const [errMsg, setErrMsg] = useState<string | null>(null)

  // 色分け 軸 (industry pattern: 1 印刷 1 変数 推奨)
  type ColorAxis = 'none' | 'origin' | 'spec' | 'cat_major' | 'cat_minor'
  const [colorAxis, setColorAxis] = useState<ColorAxis>('none')

  // 図/表 比率 モード (user 仕様 2026-05-25)
  type LayoutMode = 'half' | 'wide-figure' | 'wide-table' | 'figure-only' | 'floating'
  const LAYOUT_KEY = 'storage-sheet-layout.v1'
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(() => {
    try {
      const raw = localStorage.getItem(LAYOUT_KEY)
      if (raw === 'half' || raw === 'wide-figure' || raw === 'wide-table'
          || raw === 'figure-only' || raw === 'floating') return raw
    } catch { /* noop */ }
    return 'wide-figure'   // デフォルト: 図を広く (印刷で 図が主役)
  })
  function setLayoutModeP(m: LayoutMode) {
    setLayoutMode(m)
    try { localStorage.setItem(LAYOUT_KEY, m) } catch { /* noop */ }
  }
  const LAYOUT_GRID_COLS: Record<LayoutMode, string> = {
    'half':         'minmax(280px, 50%) 1fr',
    'wide-figure':  'minmax(360px, 65%) 1fr',
    'wide-table':   'minmax(220px, 35%) 1fr',
    'figure-only':  '1fr',                 // 表 は 非表示
    'floating':     '1fr',                 // 表 は absolute overlay
  }

  // 詳細 表示 モード (2026-05-25 user 要望):
  //   - 'inline': box 内 に 詳細 行 (現行、 資材 等 box が 大きい layout 向き)
  //   - 'callout': box は 番号 のみ + 番号付きリスト で 詳細 (パレット 多い layout 向き)
  type InfoMode = 'inline' | 'callout'
  const INFO_KEY = 'storage-sheet-info-mode.v1'
  const [infoMode, setInfoMode] = useState<InfoMode>(() => {
    try {
      const raw = localStorage.getItem(INFO_KEY)
      if (raw === 'inline' || raw === 'callout') return raw
    } catch { /* noop */ }
    return 'inline'
  })
  function setInfoModeP(m: InfoMode) {
    setInfoMode(m)
    try { localStorage.setItem(INFO_KEY, m) } catch { /* noop */ }
  }

  // 集計表 列 表示 状態 (user 仕様 2026-05-24: ヘッダー 眼アイコン で 連鎖 ON/OFF)。
  // localStorage で 永続化 (layout 共通)。
  const COL_KEY = 'storage-sheet-cols.v1'
  type ColKey = 'origin' | 'spec' | 'cases' | 'kg_per_case' | 'total_kg' | 'entry_count'
  const ALL_COLS: ColKey[] = ['origin', 'spec', 'cases', 'kg_per_case', 'total_kg', 'entry_count']
  const COL_LABEL: Record<ColKey, string> = {
    origin: '産地',
    spec: '規格',
    cases: 'ケース数',
    kg_per_case: 'ケース重量(kg)',
    total_kg: '総重量(kg)',
    entry_count: '件数',
  }
  const [visibleCols, setVisibleCols] = useState<Set<ColKey>>(() => {
    try {
      const raw = localStorage.getItem(COL_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as ColKey[]
        return new Set(parsed.filter(k => ALL_COLS.includes(k)))
      }
    } catch { /* noop */ }
    // デフォルト: 件数 だけ 非表示 (本質的に補足情報)
    return new Set<ColKey>(['origin', 'spec', 'cases', 'kg_per_case', 'total_kg'])
  })
  function toggleCol(k: ColKey) {
    setVisibleCols(prev => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k); else next.add(k)
      try { localStorage.setItem(COL_KEY, JSON.stringify(Array.from(next))) } catch { /* noop */ }
      return next
    })
  }

  // 集計表 データ
  const sheet = useFetch<SheetData>(
    id ? `/storage/layouts/${id}/sheet-data` : null,
    dateFilter ? { date: dateFilter } : undefined,
  )
  // canvas 描画 用 の レイアウト 状態 (既存 stateFetch を 再利用)
  const state = useFetch<LayoutState>(
    id ? `/storage/layouts/${id}/state` : null,
    dateFilter ? { date: dateFilter } : undefined,
  )

  // 詳細 info 用 の entries (date 連動) + 原料ロット master (kg_per_case / inbound_date / supplier 補完)
  const entriesFetch = useFetch<InventoryEntry[]>(
    id ? `/storage/layouts/${id}/inventory-entries` : null,
    dateFilter ? { date: dateFilter } : { date: new Date().toISOString().slice(0, 10) },
  )
  const lotsFetch = useFetch<Array<{
    lot_id: number; kg_per_case: string; supplier_name: string | null; inbound_date: string
  }>>(
    targetKind === 'ingredient' ? '/stock/lots' : null,
  )

  // 集計表頁 メタ (Phase A2.3) — タイトル / 自由テキスト / セクション タイトル & メモ
  interface SheetMeta {
    report_title?: string | null
    report_subtitle?: string | null
    header_note?: string | null
    footer_note?: string | null
    group_titles?: Record<string, string> | null
    group_notes?: Record<string, string> | null
  }
  const metaFetch = useFetch<SheetMeta>(
    id ? `/storage/layouts/${id}/sheet-meta` : null,
  )
  const [metaLocal, setMetaLocal] = useState<SheetMeta>({})
  // 初回 fetch 完了 時 のみ local state を ハイドレート。 以降 は user 編集 を 上書き しない。
  // useFetch は データ 不変 でも 新 reference を 返す ことが ある (re-render の 原因) ため ref で 1 回 だけ ガード。
  const metaHydratedRef = useRef(false)
  useEffect(() => {
    if (metaFetch.data && !metaHydratedRef.current) {
      setMetaLocal(metaFetch.data)
      metaHydratedRef.current = true
    }
  }, [metaFetch.data])
  const metaSaveTimer = useRef<number | null>(null)
  function saveMeta(next: SheetMeta) {
    if (!id) return
    setMetaLocal(next)   // 楽観 更新
    if (metaSaveTimer.current) window.clearTimeout(metaSaveTimer.current)
    metaSaveTimer.current = window.setTimeout(async () => {
      try {
        await api.put(`/storage/layouts/${id}/sheet-meta`, next)
      } catch (e) {
        setErrMsg(errorText(e))
      }
    }, 400)
  }
  useEffect(() => () => {
    if (metaSaveTimer.current) window.clearTimeout(metaSaveTimer.current)
  }, [])
  function groupMetaKey(cmaj: string | null, cmin: string | null) {
    return `${cmaj ?? ''}|${cmin ?? ''}`
  }

  async function bulkImport() {
    if (!id || !state.data) return
    const ok = await dialog.confirm({
      title: '紐付け から 棚卸 を 一括 生成',
      message: `この レイアウト の 全 紐付け を、 ${dateFilter || '今日'} 付け の 棚卸エントリ と して 一括 取り込み します。\n\n配分 は 各 object の capacity + priority で 自動 計算 (= distributeStock)。 同日 同名 は 上書き されます。`,
      okLabel: '取り込み',
    })
    if (!ok) return
    setImporting(true); setErrMsg(null)
    try {
      // distributeStock で per-object の 数量 を 計算
      const dist = distributeStock(state.data.items)
      // lot_id → info (kg_per_case / supplier 等)
      const lotInfo = new Map<number, { kg_per_case?: string; supplier?: string | null }>()
      for (const l of lotsFetch.data ?? []) {
        lotInfo.set(l.lot_id, { kg_per_case: l.kg_per_case, supplier: l.supplier_name })
      }
      // 各 item を body item に 変換
      const items: Array<Record<string, unknown>> = []
      for (const it of state.data.items) {
        const allocated = Number(dist.get(it.id)?.amount ?? 0)
        if (allocated <= 0) continue   // 配分 0 は スキップ (無意味)
        let cases: number | null = null
        let kg_per_case: number | null = null
        let total_kg: number | null = null
        let origin: string | null = null
        let spec: string | null = null
        let name: string | null = null
        let crop_id: number | null = null
        if (it.inbound_lot_id != null) {
          const kpc = Number(lotInfo.get(it.inbound_lot_id)?.kg_per_case ?? 0)
          kg_per_case = kpc > 0 ? kpc : null
          total_kg = allocated
          cases = kpc > 0 ? Math.round((allocated / kpc) * 100) / 100 : null
          origin = it.lot_origin_name ?? null
          spec = it.lot_spec_type ?? null
          name = it.lot_code ?? `lot#${it.inbound_lot_id}`
        } else if (it.semifinished_lot_id != null) {
          total_kg = allocated
          origin = it.semifin_origin_name ?? null
          spec = it.semifin_spec_type ?? null
          name = `半製品#${it.semifinished_lot_id}`
        } else if (it.material_id != null) {
          // material: allocated は 数量 単位 (個 / 本 / ...)
          cases = allocated
          name = it.material_code ?? it.material_name ?? `material#${it.material_id}`
        }
        items.push({
          object_id: it.object_id,
          inbound_lot_id: it.inbound_lot_id ?? null,
          material_id: it.material_id ?? null,
          semifinished_lot_id: it.semifinished_lot_id ?? null,
          crop_id, origin_text: origin, spec_text: spec, name,
          cases, kg_per_case, total_kg,
        })
      }
      if (items.length === 0) {
        await dialog.alert({
          title: '取り込み対象なし',
          message: 'この レイアウト に は 紐付け が ありません。',
        })
        return
      }
      const res = await api.post<{ imported: number; skipped: number; inventory_date: string | null }>(
        `/storage/layouts/${id}/inventory-entries/bulk-import-from-items`,
        { inventory_date: dateFilter || null, items },
      )
      await dialog.alert({
        title: '取り込み 完了',
        message: `${res.imported} 件 の エントリ を ${res.inventory_date ?? '今日'} 付け で 取り込み ました。`,
      })
      sheet.reload()
      entriesFetch.reload()
    } catch (e) {
      setErrMsg(errorText(e))
    } finally {
      setImporting(false)
    }
  }

  // 色分け 軸 → object id → 色 マッピング + 凡例。 軸='none' は 空 Map (object 既定 色)。
  // axis 値 → object に 含まれる entries / items から 代表値 を 取得 (mixed は '混在' に)
  const { colorByObject, legend } = useMemo<{ colorByObject: Map<number, string>; legend: LegendEntry[] }>(() => {
    if (colorAxis === 'none' || !state.data) {
      return { colorByObject: new Map(), legend: [] }
    }
    const palette = CATEGORICAL_PALETTE
    const valueOfEntry = (e: InventoryEntry): string | null => {
      switch (colorAxis) {
        case 'origin':    return e.origin_text
        case 'spec':      return e.spec_text
        case 'cat_major': return e.category_major
        case 'cat_minor': return e.category_minor
      }
    }
    const valueOfItem = (it: StorageObjectItem): string | null => {
      switch (colorAxis) {
        case 'origin':    return it.lot_origin_name ?? it.semifin_origin_name ?? null
        case 'spec':      return it.lot_spec_type ?? it.semifin_spec_type ?? null
        case 'cat_major':
        case 'cat_minor': return null   // master 紐付け側に分類は無い
      }
    }

    // object id → 代表値 (mixed の場合 '混在')
    const objectValue = new Map<number, string | null>()
    const itemsByObj = new Map<number, StorageObjectItem[]>()
    for (const it of state.data.items) {
      const arr = itemsByObj.get(it.object_id) ?? []
      arr.push(it); itemsByObj.set(it.object_id, arr)
    }
    const entriesByObj = new Map<number, InventoryEntry[]>()
    for (const e of entriesFetch.data ?? []) {
      const arr = entriesByObj.get(e.object_id) ?? []
      arr.push(e); entriesByObj.set(e.object_id, arr)
    }
    for (const o of state.data.objects) {
      const vals = new Set<string>()
      for (const e of entriesByObj.get(o.id) ?? []) {
        const v = valueOfEntry(e)
        if (v != null && v !== '') vals.add(v)
      }
      for (const it of itemsByObj.get(o.id) ?? []) {
        const v = valueOfItem(it)
        if (v != null && v !== '') vals.add(v)
      }
      if (vals.size === 0) continue
      if (vals.size === 1) objectValue.set(o.id, Array.from(vals)[0])
      else objectValue.set(o.id, MIXED_LABEL)
    }

    // ユニーク 値 → 色 (出現順 で 安定。 '混在' は palette 最後 = グレー)
    const uniqueValues: string[] = []
    for (const v of objectValue.values()) {
      if (v != null && !uniqueValues.includes(v)) uniqueValues.push(v)
    }
    const valueColor = new Map<string, string>()
    let pi = 0
    for (const v of uniqueValues) {
      if (v === MIXED_LABEL) valueColor.set(v, MIXED_COLOR)
      else { valueColor.set(v, palette[pi % palette.length]); pi++ }
    }
    const colorByObj = new Map<number, string>()
    for (const [oid, v] of objectValue) {
      if (v != null) {
        const c = valueColor.get(v)
        if (c) colorByObj.set(oid, c)
      }
    }
    const leg: LegendEntry[] = uniqueValues.map(v => ({
      color: valueColor.get(v) ?? '#888', label: v,
    }))
    return { colorByObject: colorByObj, legend: leg }
  }, [colorAxis, state.data, entriesFetch.data])

  // 詳細 info Map (sheet page では 常時 ON)
  const infoLinesByObject = useMemo(() => {
    if (!state.data) return new Map<number, string[]>()
    const lotInfo = new Map<number, LotInfo>()
    for (const l of lotsFetch.data ?? []) {
      lotInfo.set(l.lot_id, {
        lot_id: l.lot_id,
        kg_per_case: l.kg_per_case,
        inbound_date: l.inbound_date,
        supplier_name: l.supplier_name,
      })
    }
    const itemsByObj = new Map<number, StorageObjectItem[]>()
    for (const it of state.data.items) {
      const arr = itemsByObj.get(it.object_id) ?? []
      arr.push(it); itemsByObj.set(it.object_id, arr)
    }
    const entriesByObj = new Map<number, InventoryEntry[]>()
    for (const e of entriesFetch.data ?? []) {
      const arr = entriesByObj.get(e.object_id) ?? []
      arr.push(e); entriesByObj.set(e.object_id, arr)
    }
    return buildInfoLinesMap(
      itemsByObj, entriesByObj,
      state.data.objects.map(o => o.id),
      lotInfo,
    )
  }, [state.data, entriesFetch.data, lotsFetch.data])

  // callout モード 用: reading order で 採番 (top→bottom, left→right)、 entries 持ち のみ。
  // multi-entry の object は entries を 「1 entry = 1 短い行」 で 縦並び (番号 は 最初 のみ)。
  // buildObjectInfoLines は entry 間 に '' (空行) を separator として 入れる ので、 それ で 分割。
  const { numberByObject, calloutList } = useMemo<{
    numberByObject: Map<number, number>
    calloutList: { n: number; label: string; entries: string[] }[]
  }>(() => {
    if (!state.data) return { numberByObject: new Map(), calloutList: [] }
    const objectsWithInfo = state.data.objects.filter(o =>
      (infoLinesByObject.get(o.id) ?? []).length > 0
    )
    const sorted = [...objectsWithInfo].sort((a, b) => {
      const bandA = Math.floor(Number(a.y) / 200)
      const bandB = Math.floor(Number(b.y) / 200)
      if (bandA !== bandB) return bandA - bandB
      return Number(a.x) - Number(b.x)
    })
    const nMap = new Map<number, number>()
    const list: { n: number; label: string; entries: string[] }[] = []
    sorted.forEach((o, i) => {
      const n = i + 1
      nMap.set(o.id, n)
      const lines = infoLinesByObject.get(o.id) ?? []
      // '' 区切り で entries (= 1 物理 アイテム) に 分割、 各 entry は 中身 を ' · ' で 連結
      const entries: string[] = []
      let buf: string[] = []
      const flush = () => { if (buf.length) { entries.push(buf.join(' · ')); buf = [] } }
      for (const l of lines) { if (l === '') flush(); else buf.push(l) }
      flush()
      const rawLbl = (o.label ?? '').trim()
      const lbl = rawLbl && !/^#\d+$/.test(rawLbl) ? rawLbl : ''
      list.push({ n, label: lbl, entries })
    })
    return { numberByObject: nMap, calloutList: list }
  }, [state.data, infoLinesByObject])

  if (sheet.loading && !sheet.data) return <div className="muted">読み込み中…</div>
  if (sheet.error) return <div className="alert error">{sheet.error}</div>
  if (!sheet.data) return null
  const data = sheet.data

  const totalRows = data.groups.reduce((s, g) => s + g.rows.length, 0)

  return (
    <div className="storage-sheet-page" style={{ padding: 12 }}>
      {/* ── 上 ツールバー (print 時 は 非表示) ── */}
      <div className="sheet-toolbar print-hide" style={{
        display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12,
        flexWrap: 'wrap',
      }}>
        <Link to={`/storage/${targetKind}/${id}`} className="muted"
              style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <ArrowLeft size={14} strokeWidth={1.7} /> レイアウトに戻る
        </Link>
        <div style={{ fontSize: 15, fontWeight: 600 }}>
          {data.layout.name} <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>集計表</span>
        </div>
        <div className="inline" style={{ gap: 4 }}>
          <span className="muted" style={{ fontSize: 11 }}>表示日:</span>
          <input type="date" value={dateFilter}
                 onChange={(e) => setDateFilter(e.target.value)}
                 style={{ fontSize: 12, height: 28 }} />
          {dateFilter && (
            <button className="ghost small" onClick={() => setDateFilter('')}
                    style={{ height: 28, padding: '0 8px', fontSize: 11 }}>×</button>
          )}
        </div>
        <div className="inline" style={{ gap: 4 }}>
          <span className="muted" style={{ fontSize: 11 }}>色分け:</span>
          <select value={colorAxis}
                  onChange={(e) => setColorAxis(e.target.value as ColorAxis)}
                  style={{ fontSize: 12, height: 28 }}>
            <option value="none">なし</option>
            <option value="origin">産地</option>
            <option value="spec">規格</option>
            <option value="cat_major">大分類</option>
            <option value="cat_minor">小分類</option>
          </select>
        </div>
        {/* 詳細 表示 モード トグル (box 内 / 番号+リスト) */}
        <div className="inline print-hide" style={{ gap: 2, marginLeft: 4,
              border: '1px solid var(--border)', borderRadius: 6, padding: 2 }}>
          {([
            { m: 'inline',  Icon: Type, title: '詳細は box 内 (資材 等 box が 大きい場合)' },
            { m: 'callout', Icon: List, title: '番号 + リスト (パレット 多い場合)' },
          ] as const).map(({ m, Icon, title }) => (
            <button key={m}
                    onClick={() => setInfoModeP(m)}
                    title={title}
                    style={{
                      width: 28, height: 24, padding: 0, lineHeight: 0,
                      background: infoMode === m ? 'var(--primary)' : 'transparent',
                      color: infoMode === m ? '#fff' : 'var(--text)',
                      border: 'none', borderRadius: 4, cursor: 'pointer',
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    }}>
              <Icon size={14} strokeWidth={1.8} />
            </button>
          ))}
        </div>
        {/* 図/表 比率 セレクタ — 5 モード (アイコン トグル) */}
        <div className="inline print-hide" style={{ gap: 2, marginLeft: 4,
              border: '1px solid var(--border)', borderRadius: 6, padding: 2 }}>
          {([
            { m: 'wide-figure',  Icon: Columns3,         title: '図を広く (65/35)' },
            { m: 'half',         Icon: Columns2,         title: '半々 (50/50)' },
            { m: 'wide-table',   Icon: Columns3,         title: '表を広く (35/65)' },
            { m: 'figure-only',  Icon: PanelLeftClose,   title: '図のみ (表 非表示)' },
            { m: 'floating',     Icon: Layers,           title: '表 を フロート (図の上 に 重ねる)' },
          ] as const).map(({ m, Icon, title }) => (
            <button key={m}
                    onClick={() => setLayoutModeP(m)}
                    title={title}
                    style={{
                      width: 28, height: 24, padding: 0, lineHeight: 0,
                      background: layoutMode === m ? 'var(--primary)' : 'transparent',
                      color: layoutMode === m ? '#fff' : 'var(--text)',
                      border: 'none', borderRadius: 4, cursor: 'pointer',
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      transform: m === 'wide-table' ? 'scaleX(-1)' : 'none',
                    }}>
              <Icon size={14} strokeWidth={1.8} />
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <span className="muted" style={{ fontSize: 11 }}>
          {totalRows} 行 / {data.groups.length} グループ
        </span>
        <button onClick={bulkImport} disabled={importing}
                className="ghost"
                style={{
                  height: 32, padding: '0 12px', fontSize: 12,
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                }}
                title="既存 紐付け (lot / material / 半製品) を 一括 で エントリ に snapshot">
          <Download size={14} strokeWidth={1.7} />
          {importing ? '取り込み中…' : '紐付けから取り込み'}
        </button>
        <button onClick={() => window.print()}
                style={{
                  height: 32, padding: '0 12px', fontSize: 12,
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                }}>
          <Printer size={14} strokeWidth={1.7} /> 印刷
        </button>
      </div>
      {errMsg && (
        <div className="alert error print-hide" style={{ marginBottom: 12 }}>{errMsg}</div>
      )}

      {/* ── ヘッダー (editable タイトル / サブタイトル / ヘッダーメモ) ── */}
      <div className="sheet-header" style={{
        marginBottom: 10, padding: '4px 0',
        borderBottom: '1px solid var(--divider)',
      }}>
        <EditableText
          as="h2"
          value={metaLocal.report_title ?? ''}
          onChange={(v) => saveMeta({ ...metaLocal, report_title: v })}
          placeholder={data.layout.name}
          style={{ margin: 0, fontSize: 18, fontWeight: 700 }}
        />
        <EditableText
          as="p"
          value={metaLocal.report_subtitle ?? ''}
          onChange={(v) => saveMeta({ ...metaLocal, report_subtitle: v })}
          placeholder="サブタイトル (期間、 担当者 等)"
          style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--muted)' }}
        />
        <EditableText
          as="p"
          value={metaLocal.header_note ?? ''}
          onChange={(v) => saveMeta({ ...metaLocal, header_note: v })}
          placeholder="備考・特記事項 (省略可)"
          multiline
          style={{ margin: '4px 0 0', fontSize: 12 }}
        />
      </div>

      {/* ── 印刷 / 画面 共通 レイアウト: 左 canvas + 右 集計表 ── */}
      <div className="sheet-body" style={{
        display: 'grid',
        gridTemplateColumns: LAYOUT_GRID_COLS[layoutMode],
        gap: layoutMode === 'figure-only' || layoutMode === 'floating' ? 0 : 16,
        alignItems: 'flex-start',
        position: 'relative',
      }}>
        {/* ── 左カラム: 平面図 + (callout モード時) 詳細リスト ── */}
        <div className="sheet-left-col" style={{
          display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0,
        }}>
        <div className="sheet-canvas" style={{
          aspectRatio: data.layout.image_width && data.layout.image_height
            ? `${data.layout.image_width} / ${data.layout.image_height}`
            : '4 / 3',
          minHeight: 200,
          border: '1px solid var(--border)',
          borderRadius: 8,
          overflow: 'hidden',
          position: 'relative',
        }}>
          {state.data ? (
            <StorageSheetPlanView
              layoutName={data.layout.name}
              layoutMeta={[
                data.layout.target_kind === 'material' ? '資材' : '原料',
                data.layout.division != null && data.layout.division !== 0
                  ? DIVISION_LABEL[data.layout.division] ?? `事業${data.layout.division}部`
                  : null,
              ].filter(Boolean).join(' / ')}
              reportDate={data.date ?? new Date().toISOString().slice(0, 10)}
              imageWidth={data.layout.image_width}
              imageHeight={data.layout.image_height}
              floorOutline={state.data.layout.floor_outline ?? null}
              objects={state.data.objects}
              walls={state.data.walls ?? []}
              infoLinesByObject={infoLinesByObject}
              colorByObject={colorByObject}
              legend={legend}
              infoMode={infoMode}
              numberByObject={numberByObject}
            />
          ) : (
            <div className="muted" style={{ padding: 24, textAlign: 'center' }}>
              レイアウト 読込中…
            </div>
          )}
        </div>
        {/* callout モード: 番号付き 詳細リスト (canvas の 下、 同じ 左カラム 内 sibling)。
            縦並び + multi-column auto 折返し で 読み やすく、 図 を 覆わない */}
        {infoMode === 'callout' && calloutList.length > 0 && (
          <div className="callout-list" style={{
            border: '1px solid var(--border)', borderRadius: 6,
            padding: 10, fontSize: 11, lineHeight: 1.4,
            columnWidth: 240, columnGap: 18,
            background: 'var(--panel)',
          }}>
            {calloutList.map(it => (
              <div key={it.n} className="callout-item" style={{
                breakInside: 'avoid',
                marginBottom: 6, paddingBottom: 6,
                borderBottom: '1px dotted var(--divider)',
                display: 'flex', gap: 6, alignItems: 'flex-start',
              }}>
                <div style={{
                  minWidth: 22, flexShrink: 0,
                  fontWeight: 700, color: 'var(--primary)',
                  fontVariantNumeric: 'tabular-nums',
                }}>{it.n}.</div>
                <div style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                  {it.label && (
                    <div style={{ fontWeight: 600, color: 'var(--text)' }}>{it.label}</div>
                  )}
                  {it.entries.map((e, ei) => (
                    <div key={ei} style={{ color: 'var(--muted)' }}>{e}</div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
        </div>{/* /sheet-left-col */}

        {/* ── 右: 集計表 (figure-only モード で は 非表示、 floating で は absolute) ── */}
        {layoutMode !== 'figure-only' && (
          <div className="sheet-tables" style={{
            display: 'flex', flexDirection: 'column', gap: 18,
            ...(layoutMode === 'floating' ? {
              // compass は 右上 (約 4-6% inset) に あるので、 表は 80px 下 + 8px 右 から
              position: 'absolute', top: 80, right: 8,
              width: 'min(38%, 460px)', zIndex: 5,
              background: 'rgba(255, 253, 246, 0.96)',
              border: '1px solid var(--border)', borderRadius: 8,
              padding: 12, maxHeight: 'calc(100% - 96px)', overflowY: 'auto',
              boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
              backdropFilter: 'blur(2px)',
            } : {}),
          }}>
            {data.groups.length === 0 ? (
              <div className="muted" style={{
                padding: '40px 20px', textAlign: 'center', fontSize: 13,
                border: '1px dashed var(--border)', borderRadius: 8,
              }}>
                棚卸エントリ が まだ あり ません。<br />
                レイアウト編集 で オブジェクト を 選び、 「棚卸エントリ」 タブ から 入力 して ください。
              </div>
            ) : (
              data.groups.map((g, i) => {
                const key = groupMetaKey(g.category_major, g.category_minor)
                const titleOverride = metaLocal.group_titles?.[key]
                const noteValue = metaLocal.group_notes?.[key] ?? ''
                return (
                  <SheetGroupTable key={i} group={g}
                    visibleCols={visibleCols}
                    allCols={ALL_COLS}
                    colLabel={COL_LABEL}
                    onToggleCol={toggleCol}
                    titleOverride={titleOverride}
                    onTitleChange={(v) => saveMeta({
                      ...metaLocal,
                      group_titles: { ...(metaLocal.group_titles ?? {}), [key]: v },
                    })}
                    noteValue={noteValue}
                    onNoteChange={(v) => saveMeta({
                      ...metaLocal,
                      group_notes: { ...(metaLocal.group_notes ?? {}), [key]: v },
                    })}
                  />
                )
              })
            )}
          </div>
        )}
      </div>

      {/* ── フッター (editable 自由テキスト) ── */}
      <div className="sheet-footer" style={{
        marginTop: 10, padding: '4px 0',
        borderTop: '1px solid var(--divider)',
      }}>
        <EditableText
          as="p"
          value={metaLocal.footer_note ?? ''}
          onChange={(v) => saveMeta({ ...metaLocal, footer_note: v })}
          placeholder="フッター 自由テキスト (署名・確認欄 等)"
          multiline
          style={{ margin: 0, fontSize: 11, color: 'var(--muted)' }}
        />
      </div>
    </div>
  )
}


/**
 * SheetGroupTable — 1 サブ表 (= 1 つの (大分類, 小分類) 組み合わせ)。
 *
 * 列カスタマイズ (user 仕様 2026-05-24):
 *   - 「規格」 列 は formatSpecCombined で spec + sub_spec を 統合 表示
 *   - ヘッダー の 眼アイコン 連鎖 ON/OFF で 列 表示 切替
 */
function SheetGroupTable({ group, visibleCols, allCols, colLabel, onToggleCol,
  titleOverride, onTitleChange, noteValue, onNoteChange }: {
  group: SheetGroup
  visibleCols: Set<'origin' | 'spec' | 'cases' | 'kg_per_case' | 'total_kg' | 'entry_count'>
  allCols: readonly ('origin' | 'spec' | 'cases' | 'kg_per_case' | 'total_kg' | 'entry_count')[]
  colLabel: Record<string, string>
  onToggleCol: (k: 'origin' | 'spec' | 'cases' | 'kg_per_case' | 'total_kg' | 'entry_count') => void
  titleOverride?: string
  onTitleChange: (v: string) => void
  noteValue: string
  onNoteChange: (v: string) => void
}) {
  // タイトル: override > cmaj > cmin > (両方 NULL なら 「その他」)
  const titleParts = [group.category_major, group.category_minor].filter(Boolean) as string[]
  const defaultTitle = titleParts.length > 0 ? titleParts.join(' / ') : 'その他'
  // title 変数 は EditableText 内 で 直接 titleOverride / defaultTitle を 参照 する
  void titleOverride   // 使用箇所 は JSX 内

  // 合計
  const totalCases = group.rows.reduce((s, r) => s + (r.cases_sum ?? 0), 0)
  const totalKg = group.rows.reduce((s, r) => s + (r.total_kg_sum ?? 0), 0)

  const isNumCol = (k: string) => k === 'cases' || k === 'kg_per_case' || k === 'total_kg' || k === 'entry_count'

  return (
    <section className="sheet-group" style={{
      border: '1px solid var(--border)',
      borderRadius: 8,
      overflow: 'hidden',
      background: 'var(--panel)',
    }}>
      <header style={{
        padding: '8px 12px',
        background: 'var(--surface)',
        borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        gap: 12,
      }}>
        <EditableText
          as="h3"
          value={titleOverride ?? ''}
          onChange={onTitleChange}
          placeholder={defaultTitle}
          style={{ margin: 0, fontSize: 13, fontWeight: 600 }}
        />
        <span className="muted" style={{ fontSize: 11 }}>
          {group.rows.length} 行
        </span>
      </header>
      <table style={{
        width: '100%', borderCollapse: 'collapse', fontSize: 12,
      }}>
        <thead>
          <tr style={{ background: 'var(--surface-subtle, var(--surface))' }}>
            {allCols.map(k => {
              const visible = visibleCols.has(k)
              const Icon = visible ? Eye : EyeOff
              return (
                <th key={k}
                    style={{
                      ...thStyle,
                      textAlign: isNumCol(k) ? 'right' : 'left',
                      opacity: visible ? 1 : 0.4,
                    }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    {colLabel[k]}
                    <button
                      onClick={() => onToggleCol(k)}
                      className="ghost print-hide"
                      style={{
                        padding: 2, lineHeight: 0,
                        background: 'transparent', border: 'none', cursor: 'pointer',
                        color: visible ? 'var(--muted)' : 'var(--primary)',
                      }}
                      title={visible ? '列を隠す' : '列を表示'}>
                      <Icon size={12} strokeWidth={1.7} />
                    </button>
                  </span>
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {group.rows.map((r, i) => (
            <tr key={i} style={{ borderTop: '1px solid var(--divider)' }}>
              {allCols.map(k => {
                if (!visibleCols.has(k)) return <td key={k} style={{ ...tdStyle, padding: 0 }} />
                if (k === 'origin')
                  return <td key={k} style={tdStyle}>{r.origin ?? <span className="muted">—</span>}</td>
                if (k === 'spec') {
                  const combined = formatSpecCombined(r.spec, null, null, r.sub_spec, { fallback: '' })
                  return <td key={k} style={tdStyle}>{combined || <span className="muted">—</span>}</td>
                }
                if (k === 'cases')
                  return <td key={k} style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {r.cases_sum != null ? num(r.cases_sum, 2) : '—'}
                  </td>
                if (k === 'kg_per_case')
                  return <td key={k} style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {r.kg_per_case_repr != null ? num(r.kg_per_case_repr, 2) : '—'}
                  </td>
                if (k === 'total_kg')
                  return <td key={k} style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                    {r.total_kg_sum != null ? num(r.total_kg_sum, 1) : '—'}
                  </td>
                if (k === 'entry_count')
                  return <td key={k} style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--muted)' }}>
                    {r.entry_count}
                  </td>
                return null
              })}
            </tr>
          ))}
        </tbody>
        {group.rows.length > 1 && (
          <tfoot>
            <tr style={{ borderTop: '2px solid var(--border)', background: 'var(--surface)' }}>
              {allCols.map((k, i) => {
                if (!visibleCols.has(k)) return <td key={k} style={{ ...tdStyle, padding: 0 }} />
                // 合計 ラベル を 最初 の text 列 に 入れる
                if (i === 0) return <td key={k} style={{ ...tdStyle, fontWeight: 600 }}>合計</td>
                if (k === 'cases')
                  return <td key={k} style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                    {num(totalCases, 2)}
                  </td>
                if (k === 'total_kg')
                  return <td key={k} style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                    {num(totalKg, 1)}
                  </td>
                return <td key={k} style={tdStyle}></td>
              })}
            </tr>
          </tfoot>
        )}
      </table>
      {/* セクション 備考 (editable) */}
      <div style={{
        padding: '4px 12px 8px',
        borderTop: noteValue ? '1px dashed var(--divider)' : 'none',
      }}>
        <EditableText
          as="p"
          value={noteValue}
          onChange={onNoteChange}
          placeholder="セクション備考 (省略可)"
          multiline
          style={{ margin: 0, fontSize: 11, color: 'var(--muted)' }}
        />
      </div>
    </section>
  )
}

const thStyle: React.CSSProperties = {
  padding: '6px 8px',
  textAlign: 'left',
  fontWeight: 600,
  fontSize: 11,
  color: 'var(--text-secondary)',
  letterSpacing: '0.02em',
}

const tdStyle: React.CSSProperties = {
  padding: '6px 8px',
  fontSize: 12,
}


// (CanvasReadOnly は 撤去。 専用 StorageSheetPlanView に 置換。)
