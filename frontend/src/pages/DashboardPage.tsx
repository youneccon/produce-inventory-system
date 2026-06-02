import { useEffect, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { useFetch } from '../lib/useFetch'
import { api } from '../api/client'
import { num, yen, ymd, errorText, formatGrade, formatSpecType } from '../lib/format'
import { useDialog } from '../components/Dialog'
import { tokenize, matchesAllTokens } from '../lib/search'
import { usePreferences } from '../auth/PreferencesContext'
import { useAuth } from '../auth/AuthContext'
import LotCodeBadge from '../components/LotCodeBadge'
import SelectionLotTooltip from '../components/SelectionLotTooltip'
import ColumnTogglePopover from '../components/ColumnTogglePopover'
import LotStockDrawer from '../components/LotStockDrawer'
import {
  NumberCellInput,
  renderDateEditCell,
  renderMoneyEditCell,
} from '../components/LotEditCells'
import { LoadingState } from '../components/StatusDisplay'
import SpecCalendarPage from './SpecCalendarPage'
import {
  LOT_COLUMNS,
  PRODUCT_COLUMNS,
  type DashColumn,
} from '../lib/dashboardColumns'
import type {
  DashboardColumnPref,
  DashboardSummary,
  LotStock,
  ProductStock,
} from '../api/types'

/** prefs と canonical 定義から、表示すべき列だけを返す。
 *  未設定の新規列は defaultVisible に従う（後方互換）。 */
function resolveDashColumns<T>(
  all: DashColumn<T>[],
  prefs?: DashboardColumnPref[],
): DashColumn<T>[] {
  if (!prefs || prefs.length === 0) {
    return all.filter((c) => c.defaultVisible)
  }
  const map = new Map(prefs.map((p) => [p.id, p.visible]))
  return all.filter((c) => {
    const v = map.get(c.id)
    if (v === undefined) return !!c.defaultVisible
    return v
  })
}

const statusLabel: Record<string, string> = {
  available: '在庫あり',
  low: '残少',
  depleted: '在庫切れ',
}

export default function DashboardPage({
  cropId,
  subKind,
  originName,
  excludeOriginName,
  pageTitle,
}: {
  cropId?: number
  /** 'black' = 黒ニンニクのみ、 'semifinished' = 半製品のみ、 'normal' = 通常 (sub_kind=NULL) のみ */
  subKind?: 'black' | 'semifinished' | 'normal'
  /** 産地名で絞り込み (例: '田子') */
  originName?: string
  /** 指定産地を除外 (例: '田子') */
  excludeOriginName?: string
  /** ページタイトル (default: '在庫一覧') */
  pageTitle?: string
}) {
  const dialog = useDialog()
  const { prefs, update } = usePreferences()
  const { isAdmin } = useAuth()
  const dash = prefs.dashboard ?? {}
  const showSummary = dash.show_summary !== false
  const showProducts = dash.show_products !== false
  const showLots = dash.show_lots !== false

  const visibleProductCols = resolveDashColumns(PRODUCT_COLUMNS, dash.product_columns)
  const visibleLotCols = resolveDashColumns(LOT_COLUMNS, dash.lot_columns)

  const fetchParam: Record<string, string> = {}
  if (cropId !== undefined) fetchParam.crop_id = String(cropId)
  if (subKind) fetchParam.sub_kind = subKind
  if (originName) fetchParam.origin_name = originName
  if (excludeOriginName) fetchParam.exclude_origin_name = excludeOriginName
  const summary = useFetch<DashboardSummary>('/dashboard/summary', fetchParam)
  const products = useFetch<ProductStock[]>('/stock/products', fetchParam)
  const lots = useFetch<LotStock[]>('/stock/lots', fetchParam)

  // インライン編集: ロット支払い列 (単価/前後払/手数料/送料)
  // 過去月入荷の単価のみ RO (それ以外は常時 可能)
  const [editingLot, setEditingLot] = useState<{ lotId: number; field: string } | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  async function patchLot(lotId: number, patch: Record<string, unknown>) {
    setEditError(null)
    try {
      await api.patch(`/inbound/lots/${lotId}`, patch)
      lots.reload()
    } catch (e) {
      setEditError(errorText(e))
    } finally {
      setEditingLot(null)
    }
  }
  // 過去月かどうか判定 (現月以降は編集可、 前月以前は単価 RO)
  function isPastMonth(inboundDate: string | undefined | null): boolean {
    if (!inboundDate) return false
    const d = new Date(inboundDate)
    const now = new Date()
    return (d.getFullYear() < now.getFullYear()) ||
           (d.getFullYear() === now.getFullYear() && d.getMonth() < now.getMonth())
  }

  const s = summary.data

  // ─── ロット表の機能拡張 ───
  // A. 検索 — スペース区切り AND マッチ
  const [searchQuery, setSearchQuery] = useState('')
  const searchTokens = useMemo(() => tokenize(searchQuery), [searchQuery])
  // B. 「在庫切れを隠す」 トグル (デフォルト ON)
  const [hideDepleted, setHideDepleted] = useState(true)
  // B'. クイックフィルタ — アラートチップから設定 (all | pending | low)
  const [quickFilter, setQuickFilter] = useState<'all' | 'pending' | 'low'>('all')
  // C. 列ヘッダソート — (sortKey, sortDir)
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  function toggleSort(key: string) {
    if (sortKey !== key) { setSortKey(key); setSortDir('asc'); return }
    if (sortDir === 'asc') { setSortDir('desc'); return }
    // 3 回目 → デフォルトに戻す
    setSortKey(null)
  }
  // D. 行クリックで詳細ドロワー
  const [selectedLotId, setSelectedLotId] = useState<number | null>(null)

  // ─── 商品別サマリー の検索 / ソート (ロット表とは独立) ───
  const [productSearch, setProductSearch] = useState('')
  const productSearchTokens = useMemo(() => tokenize(productSearch), [productSearch])
  // 在庫 0 (active_lot_count=0 AND remaining=0) を隠すトグル (デフォルト ON)
  const [hideEmptyProducts, setHideEmptyProducts] = useState(true)
  // 商品ソート
  const [productSortKey, setProductSortKey] = useState<string | null>(null)
  const [productSortDir, setProductSortDir] = useState<'asc' | 'desc'>('asc')
  function toggleProductSort(key: string) {
    if (productSortKey !== key) { setProductSortKey(key); setProductSortDir('asc'); return }
    if (productSortDir === 'asc') { setProductSortDir('desc'); return }
    setProductSortKey(null)
  }

  // 商品行クリックで対応するロット行を強調表示
  // 同じ product_id を再度クリック → 解除
  const [selectedProductId, setSelectedProductId] = useState<number | null>(null)
  const lotsTableRef = useRef<HTMLDivElement | null>(null)
  function selectProduct(pid: number) {
    setSelectedProductId((curr) => {
      const next = curr === pid ? null : pid
      // 新規選択時に「ロット別在庫」セクションへスクロール (見つけやすく)
      if (next !== null) {
        setTimeout(() => {
          lotsTableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }, 50)
      }
      return next
    })
  }
  // 選択中の商品にマッチするロットだけが見える状態にしてもいいが、
  // 今回は「強調 (色付け)」だけにして全ロットは表示維持
  const matchedLotCount = selectedProductId == null
    ? 0
    : lots.data?.filter((l) => l.product_id === selectedProductId).length ?? 0
  const selectedProduct = selectedProductId == null
    ? null
    : products.data?.find((p) => p.product_id === selectedProductId) ?? null

  // ─── 表示用ロットリスト (検索 / depleted 除外 / ソート 適用) ───
  function lotSearchText(l: LotStock): string {
    return [
      l.lot_code ?? '',
      l.supplier_name ?? '',
      l.spec_type ?? '',
      l.grade_level ?? '',
      l.size_label ?? '',
      l.origin_name ?? '',
    ].join(' ')
  }
  const sortedLots = useMemo<LotStock[]>(() => {
    if (!lots.data) return []
    let arr = lots.data
    if (hideDepleted) arr = arr.filter((l) => l.stock_status !== 'depleted')
    if (quickFilter === 'pending') {
      arr = arr.filter((l) => l.is_price_pending && l.stock_status !== 'depleted')
    } else if (quickFilter === 'low') {
      arr = arr.filter((l) => l.stock_status === 'low')
    }
    if (searchTokens.length > 0)
      arr = arr.filter((l) => matchesAllTokens(lotSearchText(l), searchTokens))
    if (sortKey) {
      const getVal = (l: LotStock): number | string => {
        switch (sortKey) {
          case 'lot_id':            return l.lot_code ?? String(l.lot_id)
          case 'inbound_date':      return l.inbound_date ?? ''
          case 'supplier_name':     return l.supplier_name ?? ''
          case 'spec_combined':     return formatGrade(l.spec_type, l.grade_level, l.size_label, { spaces: true })
          case 'spec_type':         return l.spec_type ?? ''
          case 'grade_level':       return l.grade_level ?? ''
          case 'size_label':        return l.size_label ?? ''
          case 'origin_name':       return l.origin_name ?? ''
          case 'kg_per_case':       return Number(l.kg_per_case ?? 0)
          case 'total_kg':          return Number(l.total_kg ?? 0)
          case 'base_kg':           return Number(l.base_kg ?? 0)
          case 'total_outbound_kg': return Number(l.total_outbound_kg ?? 0)
          case 'remaining_kg':      return Number(l.remaining_kg ?? 0)
          case 'stock_status':      return l.stock_status
          case 'unit_price':        return Number(l.unit_price ?? 0)
          case 'stock_value':       return Number(l.stock_value ?? 0)
          default: return 0
        }
      }
      arr = [...arr].sort((a, b) => {
        const av = getVal(a); const bv = getVal(b)
        if (typeof av === 'number' && typeof bv === 'number') {
          return sortDir === 'asc' ? av - bv : bv - av
        }
        const as = String(av); const bs = String(bv)
        return sortDir === 'asc' ? as.localeCompare(bs) : bs.localeCompare(as)
      })
    }
    return arr
  }, [lots.data, hideDepleted, quickFilter, searchTokens, sortKey, sortDir])

  // ─── 商品別サマリー — 検索 / 空在庫除外 / ソート ───
  function productSearchText(p: ProductStock): string {
    return [
      p.spec_type ?? '',
      p.grade_level ?? '',
      p.size_label ?? '',
      p.origin_name ?? '',
      p.region ?? '',
    ].join(' ')
  }
  const sortedProducts = useMemo<ProductStock[]>(() => {
    if (!products.data) return []
    let arr = products.data
    if (hideEmptyProducts) {
      arr = arr.filter((p) => p.active_lot_count > 0 || Number(p.total_remaining_kg) > 0)
    }
    if (productSearchTokens.length > 0) {
      arr = arr.filter((p) => matchesAllTokens(productSearchText(p), productSearchTokens))
    }
    if (productSortKey) {
      const dir = productSortDir === 'asc' ? 1 : -1
      const getVal = (p: ProductStock): number | string => {
        switch (productSortKey) {
          case 'spec_combined':            return formatGrade(p.spec_type, p.grade_level, p.size_label, { spaces: true })
          case 'spec_type':                return p.spec_type ?? ''
          case 'grade_level':              return p.grade_level ?? ''
          case 'size_label':               return p.size_label ?? ''
          case 'origin_name':              return p.origin_name ?? ''
          case 'active_lot_count':         return Number(p.active_lot_count ?? 0)
          case 'total_remaining_kg':       return Number(p.total_remaining_kg ?? 0)
          case 'total_stock_value':        return Number(p.total_stock_value ?? 0)
          case 'pending_price_lot_count':  return Number(p.pending_price_lot_count ?? 0)
          case 'oldest_lot_date':          return p.oldest_lot_date ?? ''
          default: return 0
        }
      }
      arr = [...arr].sort((a, b) => {
        const av = getVal(a); const bv = getVal(b)
        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
        return String(av).localeCompare(String(bv)) * dir
      })
    }
    return arr
  }, [products.data, hideEmptyProducts, productSearchTokens, productSortKey, productSortDir])

  // 商品別サマリー の合計 (フィルタ後)
  const productTotals = useMemo(() => {
    let totalKg = 0, totalValue = 0, lotCount = 0, pendingCount = 0
    for (const p of sortedProducts) {
      totalKg      += Number(p.total_remaining_kg ?? 0)
      totalValue   += Number(p.total_stock_value ?? 0)
      lotCount     += Number(p.active_lot_count ?? 0)
      pendingCount += Number(p.pending_price_lot_count ?? 0)
    }
    return { count: sortedProducts.length, totalKg, totalValue, lotCount, pendingCount }
  }, [sortedProducts])

  const productFiltersActive = productSearchTokens.length > 0 || !hideEmptyProducts || productSortKey !== null
  function clearProductFilters() {
    setProductSearch(''); setHideEmptyProducts(true)
    setProductSortKey(null); setProductSortDir('asc')
  }

  // ─── エイジング色: 入荷日から N 日経過で段階的に控えめに濃く ───
  // 30 → 180 日を 淡い warm gradient (黄 → 橙)。 全体に低彩度・低不透明度で 視認の邪魔にならない。
  function agingBg(inboundDate: string | null): string | undefined {
    if (!inboundDate) return undefined
    const today = new Date()
    const d = new Date(inboundDate)
    const days = Math.floor((today.getTime() - d.getTime()) / 86_400_000)
    if (days < 30) return undefined
    const t = Math.min(1, (days - 30) / 150)   // 0..1
    const hue = 40 - 30 * t                    // 40 (薄黄) → 10 (橙)
    const opacity = 0.04 + 0.14 * t            // 0.04 → 0.18 (控えめ)
    return `hsla(${hue.toFixed(0)}, 65%, 55%, ${opacity.toFixed(2)})`
  }

  // ─── キーボードナビ for ドロワー ───
  useEffect(() => {
    if (selectedLotId == null) return
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement
          || e.target instanceof HTMLTextAreaElement
          || e.target instanceof HTMLSelectElement) return
      if (e.key === 'Escape') {
        setSelectedLotId(null)
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const arr = sortedLots
        const idx = arr.findIndex((l) => l.lot_id === selectedLotId)
        if (idx < 0) return
        const next = e.key === 'ArrowDown'
          ? Math.min(arr.length - 1, idx + 1)
          : Math.max(0, idx - 1)
        e.preventDefault()
        setSelectedLotId(arr[next].lot_id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedLotId, sortedLots])

  function openPrintReport() {
    // 現在のサブ分類フィルタもクエリに渡す → 通常 / 黒ニンニク / 田子産 でレポート別れる
    const params: string[] = []
    if (cropId !== undefined) params.push(`crop_id=${cropId}`)
    if (subKind) params.push(`sub_kind=${subKind}`)
    if (originName) params.push(`origin_name=${encodeURIComponent(originName)}`)
    if (excludeOriginName) params.push(`exclude_origin=${encodeURIComponent(excludeOriginName)}`)
    const qs = params.length ? `?${params.join('&')}` : ''
    const w = window.open(`/print/dashboard${qs}`, '_blank', 'noopener,noreferrer')
    if (!w) {
      void dialog.alert({
        title: 'ポップアップがブロックされました',
        message: 'ブラウザ設定でこのサイトのポップアップを許可してください。',
        variant: 'warn',
      })
    }
  }

  // ─── 在庫アラート (未確定単価 / 残少) ───
  // 「全ロット」基準でカウントする (表のフィルタとは独立)。
  const alertCounts = useMemo(() => {
    if (!lots.data) return { pending: 0, low: 0 }
    return {
      pending: lots.data.filter(l => l.is_price_pending && l.stock_status !== 'depleted').length,
      low: lots.data.filter(l => l.stock_status === 'low').length,
    }
  }, [lots.data])

  // ─── CSV クリップボードコピー (現在の sortedLots & 表示列) ───
  const [copyToast, setCopyToast] = useState<string | null>(null)
  function copyLotsAsCsv() {
    if (!sortedLots.length) return
    function cellText(l: LotStock, id: string): string {
      switch (id) {
        case 'lot_id':            return l.lot_code ?? String(l.lot_id)
        case 'inbound_date':      return l.inbound_date ?? ''
        case 'supplier_name':     return l.supplier_name ?? ''
        case 'spec_combined':     return formatGrade(l.spec_type, l.grade_level, l.size_label, { spaces: true })
        case 'spec_type':         return l.spec_type ?? ''
        case 'grade_level':       return l.grade_level && l.grade_level !== '-' ? l.grade_level : ''
        case 'size_label':        return l.size_label && l.size_label !== '-' ? l.size_label : ''
        case 'origin_name':       return l.origin_name ?? ''
        case 'kg_per_case':       return l.kg_per_case ?? ''
        case 'total_kg':          return l.total_kg ?? ''
        case 'base_kg':           return l.base_date ? (l.base_kg ?? '') : ''
        case 'total_outbound_kg': return l.total_outbound_kg ?? ''
        case 'remaining_kg':      return l.remaining_kg ?? ''
        case 'stock_status':      return statusLabel[l.stock_status] ?? l.stock_status
        case 'unit_price':        return l.is_price_pending ? '未確定' : (l.unit_price ?? '')
        case 'stock_value':       return l.stock_value ?? ''
        case 'prepay_date':       return l.prepay_date ?? ''
        case 'prepay_amount':     return l.prepay_amount ?? ''
        case 'postpay_date':      return l.postpay_date ?? ''
        case 'postpay_amount':    return l.postpay_amount ?? ''
        case 'brokerage_fee':     return l.brokerage_fee ?? ''
        case 'freight_fee':       return l.freight_fee ?? ''
        default: return ''
      }
    }
    // TSV (Excel に貼り付けると列分割される)
    const header = visibleLotCols.map(c => c.label).join('\t')
    const rows = sortedLots.map(l => visibleLotCols.map(c => cellText(l, c.id)).join('\t'))
    const text = [header, ...rows].join('\n')
    navigator.clipboard.writeText(text).then(
      () => {
        setCopyToast(`${sortedLots.length} 行 × ${visibleLotCols.length} 列をコピーしました`)
        setTimeout(() => setCopyToast(null), 2200)
      },
      () => {
        setCopyToast('コピーに失敗しました')
        setTimeout(() => setCopyToast(null), 2200)
      },
    )
  }

  return (
    <div>
      <div className="inline" style={{ justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 4 }}>
        <h2 style={{ margin: 0 }}>{pageTitle ?? '在庫一覧'}</h2>
        <button className="secondary small" onClick={openPrintReport} title="現在の列設定で紙レポートを開く">
          🖨 紙レポート
        </button>
      </div>
      <p className="subtitle">
        前月繰越・当月入荷・当月出庫の3つの原始データから、すべての数値を導出しています。
      </p>

      {/* 3つの原始データ + 当月在庫 */}
      {showSummary && (
      <div className="panel">
        <h3>
          当月サマリー{s && <span className="muted">（{s.month}）</span>}
        </h3>
        {summary.error && <div className="alert error">{summary.error}</div>}
        {summary.loading && <LoadingState />}
        {s && (
          <>
            <div className="cards">
              <div className="card">
                <div className="label">前月繰越（{s.prev_month} 末の棚卸）</div>
                <div className="value">{num(s.carryover_kg, 0)} <span className="unit">kg</span></div>
              </div>
              <div className="card">
                <div className="label">＋ 当月入荷（{s.inbound_count}件）</div>
                <div className="value" style={{ color: 'var(--ok)' }}>
                  {num(s.inbound_kg, 0)} <span className="unit">kg</span>
                </div>
              </div>
              <div className="card">
                <div className="label">− 当月出庫（{s.outbound_count}件）</div>
                <div className="value">
                  {num(s.outbound_kg, 0)} <span className="unit">kg</span>
                </div>
              </div>
              <div className="card card-accent">
                <div className="label">＝ 当月在庫</div>
                <div className="value" style={{ color: 'var(--primary)' }}>
                  {num(s.stock_now_kg, 0)} <span className="unit">kg</span>
                </div>
              </div>
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              前月繰越 {num(s.carryover_kg, 0)} ＋ 当月入荷 {num(s.inbound_kg, 0)} −
              当月出庫 {num(s.outbound_kg, 0)} ＝ 当月在庫 {num(s.stock_now_kg, 0)} kg
            </div>
          </>
        )}
      </div>
      )}

      {/* 規格別 日次カレンダー — 折りたたみ (デフォルト 閉じ)。 商品別サマリーの 上。 */}
      <details className="panel" style={{ marginBottom: 8 }}>
        <summary style={{ cursor: 'pointer', fontWeight: 700, fontSize: 14, padding: '2px 0' }}>
          📅 規格別 日次カレンダー
          <span className="muted" style={{ fontSize: 12, fontWeight: 400, marginLeft: 6 }}>
            (クリックで 展開 — 産地×規格 の 日次 増減)
          </span>
        </summary>
        <div style={{ marginTop: 8 }}>
          <SpecCalendarPage cropId={cropId ?? 1} embedded />
        </div>
      </details>

      {showProducts && (
      <div className="panel">
        <div className="inline" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
          <h3 style={{ margin: 0, border: 'none', padding: 0 }}>
            商品別サマリー
            <span className="muted" style={{ fontSize: 12, fontWeight: 400, marginLeft: 6 }}>
              ({productTotals.count}
              {products.data && productTotals.count !== products.data.length
                ? ` / 全 ${products.data.length}` : ''} 件)
            </span>
          </h3>
          <ColumnTogglePopover<ProductStock>
            defs={PRODUCT_COLUMNS}
            prefs={dash.product_columns}
            onChange={(next) => update({ dashboard: { product_columns: next } })}
          />
        </div>
        {/* 検索 + 空在庫隠す トグル + 合計 */}
        <div style={{
          display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
          marginBottom: 8, padding: '6px 10px',
          background: 'var(--surface, #f8f9fa)', borderRadius: 6,
          border: '1px solid var(--border)',
        }}>
          <Search size={14} strokeWidth={1.7} style={{ color: 'var(--muted)', flexShrink: 0 }} aria-hidden />
          <input type="text"
            value={productSearch}
            onChange={(e) => setProductSearch(e.target.value)}
            placeholder="規格・等級・サイズ・産地 (スペース区切りで AND)"
            style={{ flex: 1, minWidth: 200, padding: '4px 8px', fontSize: 13 }}
          />
          {productSearch && (
            <button type="button" onClick={() => setProductSearch('')}
              title="クリア"
              style={{
                width: 22, height: 22, padding: 0, fontSize: 11,
                background: 'transparent', color: 'var(--muted)',
                border: '1px solid var(--border)', borderRadius: '50%',
                cursor: 'pointer',
              }}>×</button>
          )}
          <label style={{
            display: 'flex', alignItems: 'center', gap: 4,
            fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap',
          }}>
            <input type="checkbox"
              style={{ width: 'auto' }}
              checked={hideEmptyProducts}
              onChange={(e) => setHideEmptyProducts(e.target.checked)}
            />
            在庫 0 を隠す
          </label>
          {productSortKey && (
            <button type="button" onClick={() => setProductSortKey(null)}
              style={{
                fontSize: 11, padding: '2px 8px',
                background: 'transparent', border: '1px solid var(--border)',
                color: 'var(--muted)', borderRadius: 3, cursor: 'pointer',
              }}>
              並び順をリセット
            </button>
          )}
          {productFiltersActive && (
            <button type="button" onClick={clearProductFilters}
              title="検索 / 在庫 0 / ソートをすべて解除"
              style={{
                fontSize: 11, padding: '2px 8px',
                background: 'transparent', border: '1px solid var(--border)',
                color: 'var(--muted)', borderRadius: 3, cursor: 'pointer',
              }}>
              フィルタ解除
            </button>
          )}
        </div>
        {/* 合計サマリー — フィルタ適用中は その内訳 */}
        <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
          {products.loading ? '読み込み中…' : (
            <>
              {productFiltersActive
                ? <><strong>{productTotals.count} 件</strong> (元 {products.data?.length ?? 0} 件)</>
                : <>{productTotals.count} 件</>
              }
              {' '} / 在庫合計 <strong>{num(productTotals.totalKg, 0)} kg</strong>
              {' '} / 評価額 <strong>¥{num(productTotals.totalValue, 0)}</strong>
              {' '} / アクティブロット <strong>{productTotals.lotCount}</strong>
              {productTotals.pendingCount > 0 && (
                <> {' '} / 単価未確定 <strong>{productTotals.pendingCount}</strong></>
              )}
            </>
          )}
        </div>
        {products.error && <div className="alert error">{products.error}</div>}
        {products.loading && <LoadingState />}
        {products.data && products.data.length > 0 && sortedProducts.length === 0 && (
          <div className="muted" style={{ padding: '8px 12px' }}>
            フィルタに一致する商品がありません。 (元 {products.data.length} 件)
          </div>
        )}
        {sortedProducts.length > 0 && (
          <div className="table-scroll">
          <table className="sticky-head">
            <thead>
              <tr>
                {visibleProductCols.map((c) => {
                  const isSorted = productSortKey === c.id
                  const arrow = isSorted ? (productSortDir === 'asc' ? ' ▲' : ' ▼') : ''
                  return (
                    <th key={c.id}
                      className={c.numeric ? 'num' : ''}
                      onClick={() => toggleProductSort(c.id)}
                      style={{ cursor: 'pointer', userSelect: 'none' }}
                      title="クリックでソート (3 回目で解除)">
                      {c.label}{arrow}
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {sortedProducts.map((p) => {
                const isSelected = p.product_id === selectedProductId
                return (
                <tr key={p.product_id}
                  onClick={() => selectProduct(p.product_id)}
                  style={{
                    cursor: 'pointer',
                    background: isSelected ? 'var(--accent-bg, #e8f4fd)' : undefined,
                    outline: isSelected ? '2px solid var(--primary, #4a9eff)' : undefined,
                    outlineOffset: isSelected ? '-2px' : undefined,
                  }}
                  title="クリックでロット別在庫を絞り込み表示"
                >
                  {visibleProductCols.map((c) => {
                    switch (c.id) {
                      case 'spec_combined':
                        return (
                          <td key={c.id}>
                            {formatGrade(p.spec_type, p.grade_level, p.size_label, { spaces: true })}
                          </td>
                        )
                      case 'spec_type':          return <td key={c.id}>{formatSpecType(p.spec_type, '')}</td>
                      case 'grade_level':
                        return (
                          <td key={c.id}>
                            {p.grade_level && p.grade_level !== '-'
                              ? p.grade_level
                              : <span className="muted">—</span>}
                          </td>
                        )
                      case 'size_label':
                        return (
                          <td key={c.id}>
                            {p.size_label && p.size_label !== '-'
                              ? p.size_label
                              : <span className="muted">—</span>}
                          </td>
                        )
                      case 'origin_name':        return <td key={c.id}>{p.origin_name}</td>
                      case 'active_lot_count':   return <td key={c.id} className="num">{p.active_lot_count}</td>
                      case 'total_remaining_kg': return <td key={c.id} className="num">{num(p.total_remaining_kg, 0)}</td>
                      case 'total_stock_value':  return <td key={c.id} className="num">{yen(p.total_stock_value)}</td>
                      case 'pending_price_lot_count':
                        return (
                          <td key={c.id} className="num">
                            {p.pending_price_lot_count > 0 ? (
                              <span className="badge pending">{p.pending_price_lot_count}</span>
                            ) : 0}
                          </td>
                        )
                      case 'oldest_lot_date':    return <td key={c.id}>{ymd(p.oldest_lot_date)}</td>
                      default: return <td key={c.id}>—</td>
                    }
                  })}
                </tr>
                )
              })}
            </tbody>
          </table>
          </div>
        )}
      </div>
      )}

      {showLots && (
      <div className="panel" ref={lotsTableRef}>
        <div className="inline" style={{ justifyContent: 'space-between', marginBottom: 6, flexWrap: 'wrap', gap: 8 }}>
          <h3 style={{ margin: 0, border: 'none', padding: 0 }}>
            ロット別在庫
            <span className="muted" style={{ fontSize: 12, fontWeight: 400, marginLeft: 6 }}>
              ({sortedLots.length}{lots.data && sortedLots.length !== lots.data.length
                ? ` / 全 ${lots.data.length}` : ''} 件)
            </span>
            {selectedProduct && (
              <span style={{
                marginLeft: 10, padding: '2px 10px', borderRadius: 10,
                background: 'var(--primary, #4a9eff)', color: '#fff',
                fontSize: 11, fontWeight: 500,
              }}>
                絞り込み中: {selectedProduct.spec_type} / {selectedProduct.origin_name}
                ({matchedLotCount} ロット)
                <button
                  type="button"
                  onClick={() => setSelectedProductId(null)}
                  style={{
                    background: 'none', border: 'none', color: '#fff',
                    cursor: 'pointer', marginLeft: 6, padding: 0,
                  }}
                  title="絞り込みを解除"
                >×</button>
              </span>
            )}
          </h3>
          <ColumnTogglePopover<LotStock>
            defs={LOT_COLUMNS}
            prefs={dash.lot_columns}
            onChange={(next) => update({ dashboard: { lot_columns: next } })}
          />
        </div>
        <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
          残量 ＝ 起点（前月繰越。棚卸が無いロットは入庫量）− 起点日より後の出庫
          {isAdmin && '。動きの無いロットは「ロットのアーカイブ」メニューから整理できます'}
        </p>
        {/* 検索 + 在庫切れ隠す トグル */}
        <div style={{
          display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
          marginBottom: 10, padding: '6px 10px',
          background: 'var(--surface, #f8f9fa)', borderRadius: 6,
          border: '1px solid var(--border)',
        }}>
          <Search size={14} strokeWidth={1.7} style={{ color: 'var(--muted)', flexShrink: 0 }} aria-hidden />
          <input type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="整理番号・仕入先・規格・産地 (スペース区切りで AND)"
            style={{ flex: 1, minWidth: 200, padding: '4px 8px', fontSize: 13 }}
          />
          {searchQuery && (
            <button type="button" onClick={() => setSearchQuery('')}
              title="クリア"
              style={{
                width: 22, height: 22, padding: 0, fontSize: 11,
                background: 'transparent', color: 'var(--muted)',
                border: '1px solid var(--border)', borderRadius: '50%',
                cursor: 'pointer',
              }}>×</button>
          )}
          <label style={{
            display: 'flex', alignItems: 'center', gap: 4,
            fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap',
          }}>
            <input type="checkbox"
              style={{ width: 'auto' }}
              checked={hideDepleted}
              onChange={(e) => setHideDepleted(e.target.checked)}
            />
            在庫切れを隠す
          </label>
          {sortKey && (
            <button type="button" onClick={() => setSortKey(null)}
              style={{
                fontSize: 11, padding: '2px 8px',
                background: 'transparent', border: '1px solid var(--border)',
                color: 'var(--muted)', borderRadius: 3, cursor: 'pointer',
              }}>
              並び順をリセット
            </button>
          )}
          <button type="button" onClick={copyLotsAsCsv}
            title="表示中の表を Excel に貼り付け可能な形式でクリップボードへコピー"
            disabled={!sortedLots.length}
            style={{
              fontSize: 11, padding: '2px 10px',
              background: 'var(--surface, #fff)', border: '1px solid var(--border)',
              color: 'var(--text)', borderRadius: 3,
              cursor: sortedLots.length ? 'pointer' : 'not-allowed',
              opacity: sortedLots.length ? 1 : 0.5,
            }}>
            📋 Excel コピー
          </button>
        </div>

        {/* 在庫アラート (未確定単価 / 残少) — クリックで該当ロットのみ表示 */}
        {(alertCounts.pending > 0 || alertCounts.low > 0 || quickFilter !== 'all') && (
          <div style={{
            display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center',
            marginBottom: 8, fontSize: 12,
          }}>
            {alertCounts.pending > 0 && (
              <button type="button"
                onClick={() => setQuickFilter(quickFilter === 'pending' ? 'all' : 'pending')}
                title={quickFilter === 'pending' ? '解除' : '単価未確定のロットだけに絞り込み'}
                style={{
                  padding: '3px 10px', borderRadius: 12,
                  background: quickFilter === 'pending' ? '#ffc107' : '#fff3cd',
                  border: '1px solid #ffc107',
                  color: quickFilter === 'pending' ? '#fff' : '#856404',
                  cursor: 'pointer', fontSize: 11, fontWeight: 600,
                }}>
                ⚠ 単価未確定 {alertCounts.pending} ロット
                {quickFilter === 'pending' && ' ×'}
              </button>
            )}
            {alertCounts.low > 0 && (
              <button type="button"
                onClick={() => setQuickFilter(quickFilter === 'low' ? 'all' : 'low')}
                title={quickFilter === 'low' ? '解除' : '残少ロットだけに絞り込み'}
                style={{
                  padding: '3px 10px', borderRadius: 12,
                  background: quickFilter === 'low' ? '#e57373' : '#ffe5e5',
                  border: '1px solid #e57373',
                  color: quickFilter === 'low' ? '#fff' : '#c62828',
                  cursor: 'pointer', fontSize: 11, fontWeight: 600,
                }}>
                ⚠ 残少 {alertCounts.low} ロット
                {quickFilter === 'low' && ' ×'}
              </button>
            )}
          </div>
        )}
        {lots.error && <div className="alert error">{lots.error}</div>}
        {lots.loading && <LoadingState />}
        {lots.data && (
          <div className="table-scroll">
          <table className="sticky-head">
            <thead>
              <tr>
                {visibleLotCols.map((c) => {
                  const isSorted = sortKey === c.id
                  const arrow = isSorted ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''
                  return (
                    <th key={c.id}
                      className={c.numeric ? 'num' : ''}
                      onClick={() => toggleSort(c.id)}
                      style={{ cursor: 'pointer', userSelect: 'none' }}
                      title="クリックでソート (3 回目で解除)">
                      {c.label}{arrow}
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {sortedLots.map((l) => {
                const isMatch = selectedProductId != null && l.product_id === selectedProductId
                const isDimmed = selectedProductId != null && l.product_id !== selectedProductId
                const isSelected = l.lot_id === selectedLotId
                const aging = agingBg(l.inbound_date)
                return (
                <tr key={l.lot_id}
                  onClick={() => setSelectedLotId(l.lot_id)}
                  style={{
                    cursor: 'pointer',
                    background: isSelected
                      ? 'rgba(26, 115, 232, 0.10)'
                      : (isMatch ? 'var(--accent-bg, #e8f4fd)' : aging),
                    fontWeight: isMatch || isSelected ? 600 : undefined,
                    opacity: isDimmed ? 0.35 : 1,
                    boxShadow: isSelected ? 'inset 3px 0 0 var(--primary, #1a73e8)' : undefined,
                    transition: 'opacity 0.15s, background 0.1s',
                  }}
                >
                  {visibleLotCols.map((c) => {
                    // 選別由来ロットでは 一部のセルを 「—」 表示にする (二重計上回避)。
                    // 対象列: total_kg / base_kg / prepay_* / postpay_* / brokerage_fee / freight_fee
                    const isSelectionLot = l.selection_id != null
                    const supplierCount = l.selection_source_supplier_count ?? 1
                    const blankForSelection = (idsToBlank: string[]) =>
                      isSelectionLot && idsToBlank.includes(c.id)

                    if (blankForSelection([
                      'total_kg', 'base_kg',
                      'prepay_date', 'prepay_amount',
                      'postpay_date', 'postpay_amount',
                      'brokerage_fee', 'freight_fee',
                    ])) {
                      return (
                        <td key={c.id} className={c.numeric ? 'num' : ''}
                            title="選別由来ロット — 投入元の記録があるため空欄">
                          <span className="muted" style={{ fontStyle: 'italic' }}>—</span>
                        </td>
                      )
                    }

                    switch (c.id) {
                      case 'lot_id':
                        return (
                          <td key={c.id}>
                            <code style={{ fontFamily: 'var(--font-mono)', fontSize: '0.95em' }}>
                              {isSelectionLot ? (
                                <SelectionLotTooltip lotId={l.lot_id}>
                                  <LotCodeBadge
                                    code={l.lot_code ?? String(l.lot_id)}
                                    selectionId={l.selection_id}
                                  />
                                </SelectionLotTooltip>
                              ) : (
                                <LotCodeBadge
                                  code={l.lot_code ?? String(l.lot_id)}
                                  selectionId={l.selection_id}
                                />
                              )}
                            </code>
                          </td>
                        )
                      case 'inbound_date':      return <td key={c.id}>{ymd(l.inbound_date)}</td>
                      case 'supplier_name':
                        // 選別由来 で 複数仕入先 なら 「複数」 + ホバー
                        if (isSelectionLot && supplierCount > 1) {
                          return (
                            <td key={c.id}>
                              <SelectionLotTooltip lotId={l.lot_id}>
                                <span style={{
                                  padding: '1px 6px', borderRadius: 3,
                                  background: '#fff3cd', border: '1px solid #ffc107',
                                  color: '#856404', fontSize: 11,
                                  cursor: 'help',
                                }}>
                                  複数 ({supplierCount}社)
                                </span>
                              </SelectionLotTooltip>
                            </td>
                          )
                        }
                        return <td key={c.id}>{l.supplier_name ?? '—'}</td>
                      case 'spec_combined':
                        return (
                          <td key={c.id}>
                            {formatGrade(l.spec_type, l.grade_level, l.size_label, { spaces: true })}
                          </td>
                        )
                      case 'spec_type':         return <td key={c.id}>{formatSpecType(l.spec_type)}</td>
                      case 'grade_level':       return <td key={c.id}>{l.grade_level && l.grade_level !== '-' ? l.grade_level : '—'}</td>
                      case 'size_label':        return <td key={c.id}>{l.size_label && l.size_label !== '-' ? l.size_label : '—'}</td>
                      case 'origin_name':       return <td key={c.id}>{l.origin_name ?? '—'}</td>
                      case 'kg_per_case':       return <td key={c.id} className="num">{l.kg_per_case ? num(l.kg_per_case, 2) : '—'}</td>
                      case 'total_kg':          return <td key={c.id} className="num">{num(l.total_kg, 0)}</td>
                      case 'base_kg':
                        return (
                          <td key={c.id} className="num">
                            {l.base_date ? num(l.base_kg, 0) : <span className="muted">—</span>}
                          </td>
                        )
                      case 'total_outbound_kg': return <td key={c.id} className="num">{num(l.total_outbound_kg, 0)}</td>
                      case 'remaining_kg':      return <td key={c.id} className="num">{num(l.remaining_kg, 0)}</td>
                      case 'stock_status':
                        return (
                          <td key={c.id}>
                            <span className={'badge ' + l.stock_status}>
                              {statusLabel[l.stock_status] ?? l.stock_status}
                            </span>
                          </td>
                        )
                      case 'unit_price': {
                        // 選別由来は加重平均で確定済 → 編集不可
                        if (isSelectionLot) {
                          return (
                            <td key={c.id} className="num"
                                title="選別の加重平均単価 — 編集不可">
                              {yen(l.unit_price)}
                            </td>
                          )
                        }
                        const past = isPastMonth(l.inbound_date)
                        const isEditing = editingLot?.lotId === l.lot_id && editingLot.field === 'unit_price'
                        if (past && !isEditing) {
                          return (
                            <td key={c.id} className="num" title="過去月の単価は変更不可">
                              {l.is_price_pending ? (
                                <span className="badge pending">未確定</span>
                              ) : yen(l.unit_price)}
                            </td>
                          )
                        }
                        return (
                          <td key={c.id} className="num"
                              onClick={() => !isEditing && setEditingLot({ lotId: l.lot_id, field: 'unit_price' })}
                              style={{ cursor: isEditing ? 'auto' : 'pointer' }}>
                            {isEditing ? (
                              <NumberCellInput
                                initial={l.unit_price ?? ''}
                                onSave={(v) => patchLot(l.lot_id, { unit_price: v == null ? 0 : v })}
                                onCancel={() => setEditingLot(null)}
                              />
                            ) : l.is_price_pending ? (
                              <span className="badge pending">未確定</span>
                            ) : yen(l.unit_price)}
                          </td>
                        )
                      }
                      case 'stock_value':       return <td key={c.id} className="num">{yen(l.stock_value)}</td>
                      case 'prepay_date':
                      case 'postpay_date':
                        return renderDateEditCell(c.id, l, editingLot, setEditingLot, patchLot)
                      case 'prepay_amount':
                      case 'postpay_amount':
                      case 'brokerage_fee':
                      case 'freight_fee':
                        return renderMoneyEditCell(c.id, l, editingLot, setEditingLot, patchLot)
                      default: return <td key={c.id}>—</td>
                    }
                  })}
                </tr>
                )
              })}
            </tbody>
          </table>
          </div>
        )}
      </div>
      )}

      {editError && (
        <div className="alert error" style={{ position: 'fixed', bottom: 20, right: 20, zIndex: 1000 }}>
          {editError}
          <button onClick={() => setEditError(null)} className="ghost small" style={{ marginLeft: 8 }}>×</button>
        </div>
      )}

      {copyToast && (
        <div style={{
          position: 'fixed', bottom: 20, right: 20, zIndex: 1000,
          padding: '8px 14px', borderRadius: 6,
          background: 'rgba(40, 40, 40, 0.92)', color: '#fff',
          fontSize: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
        }}>
          ✓ {copyToast}
        </div>
      )}

      {!showSummary && !showProducts && !showLots && (
        <div className="alert info">
          すべてのセクションが非表示になっています。
          <a href="/settings"> 設定</a> から表示するセクションを選んでください。
        </div>
      )}

      {/* ─── 詳細ドロワー (行クリックで開く) ─── */}
      {selectedLotId != null && (
        <LotStockDrawer
          lot={lots.data?.find((l) => l.lot_id === selectedLotId) ?? null}
          onClose={() => setSelectedLotId(null)}
        />
      )}
    </div>
  )
}

