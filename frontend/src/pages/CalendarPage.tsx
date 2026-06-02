import { useEffect, useMemo, useRef, useState } from 'react'
import { Printer, FileSpreadsheet, Filter, Search, X, MessageSquare, Trash2 } from 'lucide-react'
import { api } from '../api/client'
import { useFetch } from '../lib/useFetch'
import { num, yen, ymd, errorText } from '../lib/format'
import { tokenize, matchesAllTokens } from '../lib/search'
import { usePreferences } from '../auth/PreferencesContext'
import { useDialog } from '../components/Dialog'
import { LoadingState } from '../components/StatusDisplay'
import LotCodeBadge from '../components/LotCodeBadge'
import LotDetailDrawer from '../components/LotDetailDrawer'
import {
  COLUMN_DEFS,
  columnDefById,
  type CalendarColumnDef,
} from '../lib/calendarColumns'
import type {
  CalendarColumnPref,
  CalendarLot,
  CalendarView,
  EmphasisColor,
} from '../api/types'

function thisMonth(): string {
  return new Date().toISOString().slice(0, 7)
}

function todayInfo(): { ym: string; day: number } {
  const d = new Date()
  return {
    ym: d.toISOString().slice(0, 7),
    day: d.getDate(),
  }
}

/** 数値を表示用に整形（単位なし）。 */
function fmtNumber(v: number | string | null, digits = 1, asYen = false): string {
  if (v == null) return '—'
  const n = typeof v === 'string' ? Number(v) : v
  if (!Number.isFinite(n)) return '—'
  if (asYen) return yen(n)
  return num(n, digits)
}

/** ユーザー設定から、(left列群, right列群) と各列の強調を返す。
 * ユーザーの順序を尊重しつつ、設定されていない（=後から追加された）列は
 * defaultVisible に従って末尾に補完する。 */
function resolveColumns(prefCols?: { id: string; visible: boolean; emphasis?: EmphasisColor }[]) {
  if (!prefCols || prefCols.length === 0) {
    const left = COLUMN_DEFS.filter((c) => c.side === 'left'  && c.defaultVisible)
    const right = COLUMN_DEFS.filter((c) => c.side === 'right' && c.defaultVisible)
    return { left, right, emphasis: {} as Record<string, EmphasisColor> }
  }
  const known = new Set(prefCols.map((p) => p.id))
  const left:  CalendarColumnDef[] = []
  const right: CalendarColumnDef[] = []
  const emphasis: Record<string, EmphasisColor> = {}
  for (const p of prefCols) {
    const def = columnDefById(p.id)
    if (!def || !p.visible) continue
    if (def.side === 'left') left.push(def)
    else right.push(def)
    if (p.emphasis && p.emphasis !== 'none') emphasis[p.id] = p.emphasis
  }
  // 設定に存在しない列は defaultVisible に従い末尾に追加
  for (const def of COLUMN_DEFS) {
    if (known.has(def.id) || !def.defaultVisible) continue
    if (def.side === 'left') left.push(def)
    else right.push(def)
  }
  return { left, right, emphasis }
}

function emphasisClass(e?: EmphasisColor): string {
  if (!e || e === 'none') return ''
  return 'emphasize-' + e
}

export default function CalendarPage({
  cropId,
  endpoint = '/calendar',
  title,
  subKind,
  originName,
  excludeOriginName,
}: {
  cropId?: number
  /** API エンドポイント (default = 原料 /calendar、 半製品なら /semifinished/calendar) */
  endpoint?: string
  /** ページタイトル (default = 「日次カレンダー」) */
  title?: string
  subKind?: 'black' | 'semifinished' | 'normal'
  originName?: string
  excludeOriginName?: string
}) {
  const dialog = useDialog()
  const { prefs, update } = usePreferences()
  const [month, setMonth] = useState(thisMonth())
  const [includeArchived, setIncludeArchived] = useState(false)
  const query: Record<string, string> = { month }
  if (cropId !== undefined) query.crop_id = String(cropId)
  if (includeArchived) query.include_archived = 'true'
  if (subKind) query.sub_kind = subKind
  if (originName) query.origin_name = originName
  if (excludeOriginName) query.exclude_origin_name = excludeOriginName
  const cal = useFetch<CalendarView>(endpoint, query)

  // インライン列設定ポップオーバー
  const [colMenuOpen, setColMenuOpen] = useState(false)
  const colMenuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!colMenuOpen) return
    const handler = (e: MouseEvent) => {
      if (colMenuRef.current && !colMenuRef.current.contains(e.target as Node)) {
        setColMenuOpen(false)
      }
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [colMenuOpen])

  // 行フィルター（規格・産地・仕入先・自由テキスト で絞り込み。セッション内のみ）
  const [filterOpen, setFilterOpen] = useState(false)
  const filterRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!filterOpen) return
    const handler = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setFilterOpen(false)
      }
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [filterOpen])
  const [specFilter,   setSpecFilter]   = useState<Set<string>>(new Set())
  const [supFilter,    setSupFilter]    = useState<Set<string>>(new Set())
  const [originFilter, setOriginFilter] = useState<Set<string>>(new Set())
  // 自由テキスト検索 (整理番号 / 規格 / 等級 / サイズ / 産地 / 仕入先 / 備考)
  const [searchQuery, setSearchQuery] = useState('')
  // 動きの無い行 (前月繰越 0 / 入荷 0 / 出庫 0) を隠す
  const [hideInactive, setHideInactive] = useState(false)
  const searchTokens = useMemo(() => tokenize(searchQuery), [searchQuery])
  function toggleInSet<T>(s: Set<T>, v: T): Set<T> {
    const n = new Set(s); if (n.has(v)) n.delete(v); else n.add(v); return n
  }
  function clearFilters() {
    setSpecFilter(new Set()); setSupFilter(new Set()); setOriginFilter(new Set())
    setSearchQuery(''); setHideInactive(false)
  }
  const filterActive = specFilter.size > 0 || supFilter.size > 0 || originFilter.size > 0
    || searchTokens.length > 0 || hideInactive
  const filterCount = specFilter.size + supFilter.size + originFilter.size
    + (searchTokens.length > 0 ? 1 : 0) + (hideInactive ? 1 : 0)

  // インライン列トグル — カスタマイズページと同じ prefs を更新
  function toggleColumnVisible(id: string) {
    const def = COLUMN_DEFS.find((d) => d.id === id)
    if (!def) return
    const existing = prefs.calendar?.columns ?? []
    let next: CalendarColumnPref[]
    if (existing.length === 0) {
      // まだカスタマイズしていなければ、フル列リストを生成して切替
      next = COLUMN_DEFS.map((d) => ({
        id: d.id,
        visible: d.id === id ? !d.defaultVisible : !!d.defaultVisible,
        emphasis: 'none',
      }))
    } else {
      const known = existing.find((c) => c.id === id)
      if (known) {
        next = existing.map((c) =>
          c.id === id ? { ...c, visible: !c.visible } : c)
      } else {
        next = [
          ...existing,
          { id, visible: !def.defaultVisible, emphasis: 'none' },
        ]
      }
    }
    update({ calendar: { columns: next } })
  }

  function isColumnVisible(id: string): boolean {
    const existing = prefs.calendar?.columns ?? []
    if (existing.length === 0) {
      return !!COLUMN_DEFS.find((d) => d.id === id)?.defaultVisible
    }
    const c = existing.find((x) => x.id === id)
    if (c) return c.visible
    return !!COLUMN_DEFS.find((d) => d.id === id)?.defaultVisible
  }

  const taxRate = prefs.calendar?.tax_rate ?? 0.08
  const hideFutureDefault = prefs.calendar?.hide_future !== false
  const [showFuture, setShowFuture] = useState(false)

  // ─── 詳細ドロワー (Stripe Dashboard 風) ───
  const [selectedLotId, setSelectedLotId] = useState<number | null>(null)
  const [drawerPinned, setDrawerPinned] = useState(false)
  // キーボード: Esc → 閉じる、 ↑↓ → 前後 lot
  useEffect(() => {
    if (selectedLotId == null) return
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement
          || e.target instanceof HTMLTextAreaElement
          || e.target instanceof HTMLSelectElement) return
      if (e.key === 'Escape') {
        setSelectedLotId(null)
        setDrawerPinned(false)
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!cal.data) return
        const lots = cal.data.lots
        const idx = lots.findIndex((l) => l.lot_id === selectedLotId)
        if (idx < 0) return
        const next = e.key === 'ArrowDown'
          ? Math.min(lots.length - 1, idx + 1)
          : Math.max(0, idx - 1)
        e.preventDefault()
        setSelectedLotId(lots[next].lot_id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedLotId, cal.data])

  const { left: leftCols, right: rightCols, emphasis } = useMemo(
    () => resolveColumns(prefs.calendar?.columns),
    [prefs.calendar?.columns],
  )

  // ─── セル コメント (migration 055) ───
  //   特定 (lot_id, day) に対する 任意メモ。 紙レポートにも反映される。
  //   セルクリックで popover を開き、 編集/保存/削除 を行う。
  const [commentCell, setCommentCell] = useState<{
    lotId: number; day: number; existing: string; anchor: DOMRect
  } | null>(null)
  const [commentDraft, setCommentDraft] = useState('')
  const [commentBusy, setCommentBusy] = useState(false)
  const [commentErr, setCommentErr] = useState<string | null>(null)
  function openCommentEditor(lotId: number, day: number, existing: string, anchorEl: HTMLElement) {
    setCommentCell({
      lotId, day, existing,
      anchor: anchorEl.getBoundingClientRect(),
    })
    setCommentDraft(existing)
    setCommentErr(null)
  }
  function closeCommentEditor() {
    setCommentCell(null); setCommentDraft(''); setCommentErr(null)
  }
  async function saveComment() {
    if (!commentCell) return
    const text = commentDraft.trim()
    if (!text) {
      setCommentErr('コメント本文を入力してください (削除したい場合は 削除ボタンを使用)')
      return
    }
    setCommentBusy(true); setCommentErr(null)
    try {
      const yyyy = month.slice(0, 4)
      const mm = month.slice(5, 7)
      const dd = String(commentCell.day).padStart(2, '0')
      await api.put('/calendar/comments', {
        lot_id: commentCell.lotId,
        comment_date: `${yyyy}-${mm}-${dd}`,
        comment: text,
      })
      closeCommentEditor()
      cal.reload()
    } catch (e) {
      setCommentErr(errorText(e))
    } finally {
      setCommentBusy(false)
    }
  }
  async function deleteComment() {
    if (!commentCell) return
    setCommentBusy(true); setCommentErr(null)
    try {
      const yyyy = month.slice(0, 4)
      const mm = month.slice(5, 7)
      const dd = String(commentCell.day).padStart(2, '0')
      await api.delete('/calendar/comments', {
        lot_id: commentCell.lotId,
        comment_date: `${yyyy}-${mm}-${dd}`,
      })
      closeCommentEditor()
      cal.reload()
    } catch (e) {
      setCommentErr(errorText(e))
    } finally {
      setCommentBusy(false)
    }
  }
  // Esc で閉じる
  useEffect(() => {
    if (!commentCell) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeCommentEditor()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [commentCell])

  // iPad / タッチ用 — 600ms 長押しで コメント editor を開く (contextmenu の代用)
  //   onTouchStart で setTimeout 開始、 動かす/離す で キャンセル
  const longPressTimerRef = useRef<number | null>(null)
  function startLongPress(
    e: React.TouchEvent<HTMLTableCellElement>,
    lotId: number, day: number, existing: string,
  ) {
    if (longPressTimerRef.current != null) {
      window.clearTimeout(longPressTimerRef.current)
    }
    const target = e.currentTarget
    longPressTimerRef.current = window.setTimeout(() => {
      openCommentEditor(lotId, day, existing, target)
      longPressTimerRef.current = null
    }, 600)
  }
  function cancelLongPress() {
    if (longPressTimerRef.current != null) {
      window.clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
  }

  const data = cal.data
  const today = todayInfo()
  const isCurrentMonth = month === today.ym
  // 日次グリッドの対象日リスト
  const allDays = data
    ? Array.from({ length: data.days_in_month }, (_, i) => i + 1)
    : []
  const visibleDays = (hideFutureDefault && !showFuture && isCurrentMonth)
    ? allDays.filter((d) => d <= today.day)
    : allDays
  const hiddenDayCount = allDays.length - visibleDays.length

  // フィルター用のユニーク値
  const uniqueSpecs = useMemo(() => {
    if (!data) return [] as string[]
    return Array.from(new Set(data.lots.map((l) => l.spec_type))).sort()
  }, [data])
  const uniqueSuppliers = useMemo(() => {
    if (!data) return [] as string[]
    return Array.from(new Set(data.lots.map((l) => l.supplier_name))).sort()
  }, [data])
  const uniqueOrigins = useMemo(() => {
    if (!data) return [] as string[]
    return Array.from(new Set(data.lots.map((l) => l.origin_name))).sort()
  }, [data])

  // フィルター適用後のロットリスト
  function lotSearchText(l: CalendarLot): string {
    return [
      l.lot_code ?? '',
      l.spec_type ?? '',
      l.grade_level ?? '',
      l.size_label ?? '',
      l.origin_name ?? '',
      l.supplier_name ?? '',
    ].join(' ')
  }
  const filteredLots = useMemo(() => {
    if (!data) return [] as CalendarLot[]
    return data.lots.filter((l) => {
      if (specFilter.size > 0 && !specFilter.has(l.spec_type)) return false
      if (supFilter.size > 0 && !supFilter.has(l.supplier_name)) return false
      if (originFilter.size > 0 && !originFilter.has(l.origin_name)) return false
      if (searchTokens.length > 0 && !matchesAllTokens(lotSearchText(l), searchTokens)) return false
      if (hideInactive) {
        const c = Number(l.carryover_kg ?? 0)
        const inb = Number(l.inbound_kg ?? 0)
        const ob = Number(l.outbound_kg ?? 0)
        if (c === 0 && inb === 0 && ob === 0) return false
      }
      return true
    })
  }, [data, specFilter, supFilter, originFilter, searchTokens, hideInactive])

  // 集計（フィルター後のロットを対象に）
  const dayTotals: Record<string, number> = {}
  const totals: Record<string, number> = {}
  for (const c of [...leftCols, ...rightCols]) {
    if (c.numeric) totals[c.id] = 0
  }
  if (data) {
    for (const d of visibleDays) dayTotals[String(d)] = 0
    for (const lot of filteredLots) {
      for (const c of [...leftCols, ...rightCols]) {
        if (!c.numeric) continue
        const v = c.value(lot, taxRate)
        if (typeof v === 'number') totals[c.id] += v
      }
      for (const d of visibleDays) {
        const v = lot.daily[String(d)]
        if (v) dayTotals[String(d)] += Number(v)
      }
    }
  }

  function cellValue(lot: CalendarLot, c: CalendarColumnDef) {
    const v = c.value(lot, taxRate)
    if (c.numeric) return fmtNumber(v as number | null, c.digits ?? 1, c.asYen)
    // 日付 列 は ymd で 整形
    if (c.id === 'inbound_date' || c.id === 'prepay_date' || c.id === 'postpay_date') {
      return v ? ymd(v as string) : '—'
    }
    // 整理番号列は LotCodeBadge で選別バッジ表示 (migration 028)
    if (c.id === 'lot_code') {
      return <LotCodeBadge code={v == null ? '—' : String(v)} selectionId={lot.selection_id} />
    }
    return v == null ? '—' : String(v)
  }

  function totalCell(c: CalendarColumnDef) {
    if (!c.numeric) return ''
    return fmtNumber(totals[c.id] ?? 0, c.digits ?? 1, c.asYen)
  }

  // sticky な左列のオフセット計算
  const stickyOffsets: Record<string, number> = {}
  {
    let off = 0
    for (const c of leftCols) {
      stickyOffsets[c.id] = off
      // 幅は CSS 側の min-width に依存するので、ここでは概算
      off += parseInt((c.width ?? '100px').replace('px', ''), 10) || 100
    }
  }

  return (
    <div>
      <h2>{title || '日次カレンダー'}</h2>
      <p className="subtitle">
        各セルはその日の出庫量。左列群は横スクロールで固定、合計行は下に固定されます。
        金額系列のうち「税抜仕入金額／仕入消費税／仕入合計金額」は<strong> 入庫量 × 単価 </strong>
        で算出した<strong>仕入時</strong>の金額、「在庫評価額」は<strong> 現残量 × 単価 </strong>で算出した<strong>現時点</strong>の評価額です。
        <br />
        <span className="muted" style={{ fontSize: 11 }}>
          日付セルの<strong>右クリック</strong> (iPad は<strong>長押し</strong>) で コメントを追加できます。
          コメントは紙レポートにも反映されます。
        </span>
      </p>

      <div className="panel">
        <div className="inline no-print" style={{ marginBottom: 14, justifyContent: 'space-between' }}>
          <div className="inline">
            <div>
              <label>表示月</label>
              <input
                type="month"
                value={month}
                onChange={(e) => setMonth(e.target.value)}
                style={{ width: 160 }}
              />
            </div>
            {data && (() => {
              // 合計 (フィルタ後): 前月繰越 / 入荷 / 出庫 / 月末
              let carryover = 0, inb = 0, ob = 0, endKg = 0
              for (const l of filteredLots) {
                carryover += Number(l.carryover_kg ?? 0)
                inb       += Number(l.inbound_kg ?? 0)
                ob        += Number(l.outbound_kg ?? 0)
                endKg     += Number(l.end_kg ?? 0)
              }
              return (
                <span className="muted" style={{ fontSize: 12 }}>
                  {filterActive
                    ? <><strong>{filteredLots.length}</strong> / 全 {data.lots.length} ロット</>
                    : <><strong>{data.lots.length}</strong> ロット</>}
                  {' ／ '}{data.days_in_month} 日間
                  {' ／ 繰越 '}<strong>{num(carryover, 0)}</strong>
                  {' ＋ 入荷 '}<strong>{num(inb, 0)}</strong>
                  {' − 出庫 '}<strong>{num(ob, 0)}</strong>
                  {' ＝ 月末 '}<strong>{num(endKg, 0)} kg</strong>
                  {isCurrentMonth && hideFutureDefault && hiddenDayCount > 0 && (
                    <> ／ <span style={{ color: 'var(--muted)' }}>
                      未来 {hiddenDayCount} 日{showFuture ? '表示中' : '非表示'}
                    </span></>
                  )}
                </span>
              )
            })()}
          </div>
          <div className="inline" style={{ position: 'relative' }}>
            <button
              type="button"
              className="secondary small"
              onClick={() => {
                const url = new URL('/print/calendar', window.location.origin)
                url.searchParams.set('month', month)
                if (cropId !== undefined) url.searchParams.set('crop_id', String(cropId))
                // サブ分類フィルタも転写 (大蒜の通常 / 黒ニンニク / 田子産 別レポート)
                if (subKind) url.searchParams.set('sub_kind', subKind)
                if (originName) url.searchParams.set('origin_name', originName)
                if (excludeOriginName) url.searchParams.set('exclude_origin', excludeOriginName)
                window.open(url.toString(), '_blank', 'noopener')
              }}
              title="旧 Excel 台帳と同じレイアウトの 紙レポートを PDF 出力 (横1×縦1 自動縮尺、 合計行・押印欄付き、 列表示カスタマイズ可)"
              style={{ background: 'var(--primary)', color: '#fff', display: 'inline-flex', alignItems: 'center', gap: 6 }}
            ><Printer size={14} strokeWidth={1.7} aria-hidden /> 紙レポート</button>
            {/* Excel 出力 — 紙レポートと同じデータ・列構成を .xlsx として直接 ダウンロード */}
            <button
              type="button"
              className="secondary small"
              onClick={() => {
                const params: Record<string, string | number | boolean | null | undefined> = { month }
                if (cropId !== undefined) params.crop_id = cropId
                if (subKind) params.sub_kind = subKind
                if (originName) params.origin_name = originName
                if (excludeOriginName) params.exclude_origin_name = excludeOriginName
                if (includeArchived) params.include_archived = true
                // api.download は Content-Disposition の filename を 自動採用
                api.download('/calendar/export.xlsx', `calendar_${month}.xlsx`, params)
                  .catch((e) => dialog.alert({
                    title: 'Excel ダウンロード失敗',
                    message: errorText(e),
                    variant: 'danger',
                  }))
              }}
              title="紙レポートと同じデータ・列構成を Excel (.xlsx) として ダウンロード (セル背景・コメントも反映)"
              style={{ background: '#1d6f42', color: '#fff', display: 'inline-flex', alignItems: 'center', gap: 6 }}
            ><FileSpreadsheet size={14} strokeWidth={1.7} aria-hidden /> Excel</button>
            {isCurrentMonth && hideFutureDefault && (
              <button
                className="secondary small"
                onClick={() => setShowFuture((s) => !s)}
                title={showFuture ? '未来日を隠す' : '未来日を表示'}
              >
                {showFuture ? '◀ 今日まで' : '未来日も表示 ▶'}
              </button>
            )}
            <label className="inline" style={{ gap: 4, fontSize: 12, margin: 0 }}>
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={includeArchived}
                onChange={(e) => setIncludeArchived(e.target.checked)}
              />
              アーカイブを含む
            </label>
            {/* 自由テキスト検索 (整理番号 / 規格 / 等級 / サイズ / 産地 / 仕入先) */}
            <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
              <Search size={13} strokeWidth={1.7} aria-hidden style={{
                position: 'absolute', left: 8, top: '50%',
                transform: 'translateY(-50%)', color: 'var(--muted)', pointerEvents: 'none',
              }} />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="整理番号・規格・産地・仕入先"
                style={{
                  width: 220, padding: '4px 26px 4px 26px', fontSize: 12,
                  border: '1px solid var(--border)', borderRadius: 4,
                }}
              />
              {searchQuery && (
                <button type="button" onClick={() => setSearchQuery('')}
                  title="検索クリア"
                  style={{
                    position: 'absolute', right: 4, top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'none', border: 'none', padding: 2,
                    cursor: 'pointer', color: 'var(--muted)',
                    display: 'inline-flex', alignItems: 'center',
                  }}><X size={12} strokeWidth={1.8} /></button>
              )}
            </div>
            <label className="inline" style={{ gap: 4, fontSize: 12, margin: 0 }}>
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={hideInactive}
                onChange={(e) => setHideInactive(e.target.checked)}
              />
              動きの無い行を隠す
            </label>
            <div ref={filterRef} style={{ position: 'relative' }}>
              <button
                className={'secondary small ' + (filterActive ? 'active-filter' : '')}
                onClick={() => setFilterOpen((o) => !o)}
                title="規格・産地・仕入先 で絞り込み (多選択)"
              >
                <Filter size={13} strokeWidth={1.7} style={{ marginRight: 4, verticalAlign: '-2px' }} aria-hidden />
                絞り込み{filterCount > 0 && ` (${filterCount})`}
              </button>
              {filterOpen && (
                <div className="popover" style={{ maxHeight: '60vh', overflowY: 'auto', minWidth: 240 }}>
                  <div className="popover-header">
                    行の絞り込み
                    {filterActive && (
                      <button className="ghost small" onClick={clearFilters}
                              style={{ padding: '2px 8px' }}>クリア</button>
                    )}
                  </div>
                  <div className="popover-section">
                    <div className="popover-section-title">
                      規格 {specFilter.size > 0 && `(${specFilter.size})`}
                    </div>
                    {uniqueSpecs.length === 0 && (
                      <div className="muted" style={{ fontSize: 12, padding: '4px 10px' }}>
                        対象なし
                      </div>
                    )}
                    {uniqueSpecs.map((s) => (
                      <label key={s} className="popover-item">
                        <input
                          type="checkbox"
                          checked={specFilter.has(s)}
                          onChange={() => setSpecFilter((p) => toggleInSet(p, s))}
                          style={{ width: 'auto' }}
                        />
                        <span>{s}</span>
                      </label>
                    ))}
                  </div>
                  <div className="popover-section">
                    <div className="popover-section-title">
                      産地 {originFilter.size > 0 && `(${originFilter.size})`}
                    </div>
                    {uniqueOrigins.length === 0 && (
                      <div className="muted" style={{ fontSize: 12, padding: '4px 10px' }}>
                        対象なし
                      </div>
                    )}
                    {uniqueOrigins.map((s) => (
                      <label key={s} className="popover-item">
                        <input
                          type="checkbox"
                          checked={originFilter.has(s)}
                          onChange={() => setOriginFilter((p) => toggleInSet(p, s))}
                          style={{ width: 'auto' }}
                        />
                        <span>{s}</span>
                      </label>
                    ))}
                  </div>
                  <div className="popover-section">
                    <div className="popover-section-title">
                      仕入先 {supFilter.size > 0 && `(${supFilter.size})`}
                    </div>
                    {uniqueSuppliers.length === 0 && (
                      <div className="muted" style={{ fontSize: 12, padding: '4px 10px' }}>
                        対象なし
                      </div>
                    )}
                    {uniqueSuppliers.map((s) => (
                      <label key={s} className="popover-item">
                        <input
                          type="checkbox"
                          checked={supFilter.has(s)}
                          onChange={() => setSupFilter((p) => toggleInSet(p, s))}
                          style={{ width: 'auto' }}
                        />
                        <span>{s}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
            {filterActive && (
              <button type="button" className="ghost small" onClick={clearFilters}
                title="検索 / 多選択 / トグル をすべて解除"
                style={{ fontSize: 11 }}
              >フィルタ解除</button>
            )}
            <div ref={colMenuRef} style={{ position: 'relative' }}>
              <button
                className="secondary small"
                onClick={() => setColMenuOpen((o) => !o)}
                title="表示する列を選択"
              >
                ⚙ 列設定
              </button>
              {colMenuOpen && (
                <div className="popover">
                  <div className="popover-header">
                    表示列の切替
                    <a href="/settings" className="muted" style={{ fontSize: 11, marginLeft: 12 }}>
                      詳細設定 →
                    </a>
                  </div>
                  <div className="popover-section">
                    <div className="popover-section-title">左固定列</div>
                    {COLUMN_DEFS.filter((c) => c.side === 'left').map((c) => (
                      <label key={c.id} className="popover-item">
                        <input
                          type="checkbox"
                          checked={isColumnVisible(c.id)}
                          onChange={() => toggleColumnVisible(c.id)}
                          style={{ width: 'auto' }}
                        />
                        <span>{c.label}</span>
                      </label>
                    ))}
                  </div>
                  <div className="popover-section">
                    <div className="popover-section-title">右サマリ列</div>
                    {COLUMN_DEFS.filter((c) => c.side === 'right').map((c) => (
                      <label key={c.id} className="popover-item">
                        <input
                          type="checkbox"
                          checked={isColumnVisible(c.id)}
                          onChange={() => toggleColumnVisible(c.id)}
                          style={{ width: 'auto' }}
                        />
                        <span>{c.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {cal.error && <div className="alert error">{cal.error}</div>}
        {cal.loading && <LoadingState />}
        {data && data.lots.length === 0 && (
          <div className="muted">対象ロットがありません。</div>
        )}

        {data && data.lots.length > 0 && filterActive && filteredLots.length === 0 && (
          <div className="muted">
            絞り込み条件に一致するロットがありません。
          </div>
        )}

        {data && data.lots.length > 0 && (filteredLots.length > 0 || !filterActive) && (
          <>
            <div className="calendar-wrap">
              <table className="calendar">
                <thead>
                  <tr>
                    {leftCols.map((c) => (
                      <th
                        key={c.id}
                        className={[
                          'sticky-col',
                          c.numeric ? 'num' : '',
                          emphasisClass(emphasis[c.id]),
                        ].join(' ').trim()}
                        style={{
                          left: stickyOffsets[c.id],
                          minWidth: c.width,
                          maxWidth: c.width,
                        }}
                      >
                        {c.label}
                      </th>
                    ))}
                    {visibleDays.map((d) => (
                      <th
                        key={d}
                        className={'num daycol '
                          + (isCurrentMonth && d === today.day ? 'today' : '')}
                      >
                        {d}
                      </th>
                    ))}
                    {rightCols.map((c) => (
                      <th
                        key={c.id}
                        className={[
                          c.numeric ? 'num' : '',
                          emphasisClass(emphasis[c.id]),
                        ].join(' ').trim()}
                        style={{ minWidth: c.width }}
                      >
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredLots.map((lot) => {
                    const isSelected = lot.lot_id === selectedLotId
                    return (
                    <tr key={lot.lot_id}
                      onClick={() => setSelectedLotId(lot.lot_id)}
                      className={isSelected ? 'selected' : ''}
                      style={{ cursor: 'pointer' }}
                    >
                      {leftCols.map((c) => (
                        <td
                          key={c.id}
                          className={[
                            'sticky-col',
                            c.numeric ? 'num' : '',
                            emphasisClass(emphasis[c.id]),
                          ].join(' ').trim()}
                          style={{
                            left: stickyOffsets[c.id],
                            minWidth: c.width,
                            maxWidth: c.width,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {cellValue(lot, c)}
                        </td>
                      ))}
                      {visibleDays.map((d) => {
                        const v = lot.daily[String(d)]
                        const isToday = isCurrentMonth && d === today.day
                        const cmt = lot.comments?.[String(d)] ?? ''
                        const hasCmt = cmt !== ''
                        const n = v ? Number(v) : null
                        const cellClass = [
                          'num', 'day',
                          n != null && n >= 0 ? 'neg' : (n != null ? 'pos' : ''),
                          isToday ? 'today' : '',
                          hasCmt ? 'has-comment' : '',
                        ].filter(Boolean).join(' ')
                        // セルの 左クリック は 行クリック (詳細ドロワー) に任せる。
                        // コメント編集は 右クリック で起動 — 詳細パネルとの操作衝突を避ける。
                        // (App.tsx で contextmenu を 既定で抑止しているので
                        //  ブラウザ標準メニューは表示されない)
                        return (
                          <td key={d}
                            className={cellClass}
                            title={hasCmt
                              ? `📝 ${cmt}\n(右クリック / iPad は長押しで編集)`
                              : '右クリック / iPad は長押し で コメント追加'}
                            onContextMenu={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              openCommentEditor(lot.lot_id, d, cmt, e.currentTarget)
                            }}
                            onTouchStart={(e) => startLongPress(e, lot.lot_id, d, cmt)}
                            onTouchEnd={cancelLongPress}
                            onTouchMove={cancelLongPress}
                            onTouchCancel={cancelLongPress}
                            style={{
                              position: 'relative',
                              // iOS Safari の長押し ハイライト / コールアウト 抑止
                              WebkitTouchCallout: 'none',
                              WebkitUserSelect: 'none',
                              userSelect: 'none',
                            }}
                          >
                            {n == null ? '' : (n >= 0 ? num(n, 0) : `+${num(-n, 0)}`)}
                            {hasCmt && (
                              <span aria-hidden style={{
                                position: 'absolute', top: 0, right: 0,
                                width: 0, height: 0,
                                borderTop: '7px solid #f1c40f',
                                borderLeft: '7px solid transparent',
                              }} />
                            )}
                          </td>
                        )
                      })}
                      {rightCols.map((c) => (
                        <td
                          key={c.id}
                          className={[
                            c.numeric ? 'num' : '',
                            emphasisClass(emphasis[c.id]),
                          ].join(' ').trim()}
                        >
                          {cellValue(lot, c)}
                        </td>
                      ))}
                    </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    {leftCols.map((c, i) => (
                      <td
                        key={c.id}
                        className={[
                          'sticky-col',
                          c.numeric ? 'num' : '',
                          emphasisClass(emphasis[c.id]),
                        ].join(' ').trim()}
                        style={{
                          left: stickyOffsets[c.id],
                          minWidth: c.width,
                          maxWidth: c.width,
                          fontWeight: i === 0 ? 600 : undefined,
                        }}
                      >
                        {i === 0 ? '合計' : totalCell(c)}
                      </td>
                    ))}
                    {visibleDays.map((d) => {
                      const t = dayTotals[String(d)]
                      if (!t) return <td key={d} className="num day" />
                      return t >= 0 ? (
                        <td key={d} className="num day neg">{num(t, 0)}</td>
                      ) : (
                        <td key={d} className="num day pos">+{num(-t, 0)}</td>
                      )
                    })}
                    {rightCols.map((c) => (
                      <td
                        key={c.id}
                        className={[
                          c.numeric ? 'num' : '',
                          emphasisClass(emphasis[c.id]),
                        ].join(' ').trim()}
                      >
                        {totalCell(c)}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        )}
      </div>
      {/* ─── 詳細ドロワー (Stripe Dashboard 風) ─── */}
      {selectedLotId != null && cal.data && (
        <LotDetailDrawer
          lot={cal.data.lots.find((l) => l.lot_id === selectedLotId) ?? null}
          taxRate={taxRate}
          pinned={drawerPinned}
          onTogglePin={() => setDrawerPinned((v) => !v)}
          onClose={() => { setSelectedLotId(null); setDrawerPinned(false) }}
          onPatch={async (lotId, patch) => {
            try {
              await api.patch(`/inbound/lots/${lotId}`, patch)
              await cal.reload()
            } catch (e) {
              await dialog.alert({
                title: '保存に失敗',
                message: errorText(e),
                variant: 'danger',
              })
            }
          }}
        />
      )}
      {/* ─── セル コメント editor (popover) ─── */}
      {commentCell && (() => {
        const lot = cal.data?.lots.find((l) => l.lot_id === commentCell.lotId)
        const lotCode = lot?.lot_code ?? `#${commentCell.lotId}`
        const dayValue = lot?.daily?.[String(commentCell.day)] ?? null
        // 画面右端や下端からはみ出さない位置に調整
        const W = 320, H = 220
        let left = commentCell.anchor.left
        let top = commentCell.anchor.bottom + 6
        if (left + W > window.innerWidth - 8) left = window.innerWidth - W - 8
        if (top + H > window.innerHeight - 8) {
          top = commentCell.anchor.top - H - 6   // セルの上に出す
        }
        if (left < 8) left = 8
        if (top < 8) top = 8
        return (
          <>
            {/* クリックアウト用バックドロップ (透明) */}
            <div
              onClick={closeCommentEditor}
              style={{
                position: 'fixed', inset: 0, zIndex: 1499,
                background: 'transparent',
              }}
            />
            <div
              role="dialog"
              aria-label="セルコメント"
              style={{
                position: 'fixed', top, left, width: W,
                background: '#fff', border: '1px solid var(--border)',
                borderRadius: 6, boxShadow: '0 6px 24px rgba(0,0,0,0.18)',
                zIndex: 1500, padding: '10px 12px',
                fontSize: 13,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                marginBottom: 8, paddingBottom: 6,
                borderBottom: '1px solid var(--border)',
                fontSize: 12, color: 'var(--muted)',
              }}>
                <MessageSquare size={13} strokeWidth={1.8} />
                <strong style={{ color: 'var(--text, #333)' }}>{lotCode}</strong>
                <span> / {month.slice(5, 7)}月{commentCell.day}日</span>
                {dayValue && (
                  <span style={{ marginLeft: 'auto', color: 'var(--text, #333)' }}>
                    出庫 {num(Math.abs(Number(dayValue)), 1)} kg
                  </span>
                )}
                <button type="button" onClick={closeCommentEditor}
                  aria-label="閉じる"
                  style={{
                    background: 'transparent', border: 'none', cursor: 'pointer',
                    padding: 2, color: 'var(--muted)',
                    display: 'inline-flex', alignItems: 'center',
                  }}><X size={14} strokeWidth={1.8} /></button>
              </div>
              <textarea
                value={commentDraft}
                onChange={(e) => setCommentDraft(e.target.value)}
                rows={4}
                autoFocus
                placeholder="例: 26.2→26 修正は ●● の依頼。 異常値の理由 等"
                style={{
                  width: '100%', fontSize: 12, padding: '6px 8px',
                  border: '1px solid var(--border)', borderRadius: 4,
                  resize: 'vertical', fontFamily: 'inherit',
                }}
              />
              {commentErr && (
                <div className="alert error" style={{ fontSize: 11, marginTop: 6, padding: '4px 8px' }}>
                  {commentErr}
                </div>
              )}
              <div style={{
                display: 'flex', gap: 6, marginTop: 8,
                justifyContent: 'space-between',
              }}>
                {commentCell.existing ? (
                  <button type="button" className="ghost small"
                    disabled={commentBusy}
                    onClick={deleteComment}
                    title="このコメントを削除"
                    style={{
                      color: 'var(--danger, #c0392b)', fontSize: 11,
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                    }}>
                    <Trash2 size={12} strokeWidth={1.8} /> 削除
                  </button>
                ) : <span />}
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" className="ghost small"
                    onClick={closeCommentEditor} disabled={commentBusy}
                    style={{ fontSize: 11 }}>キャンセル</button>
                  <button type="button" className="primary small"
                    onClick={saveComment} disabled={commentBusy || !commentDraft.trim()}
                    style={{ fontSize: 11 }}>
                    {commentBusy ? '保存中…' : '保存'}
                  </button>
                </div>
              </div>
              <div className="muted" style={{ fontSize: 10, marginTop: 6 }}>
                Esc で閉じる / 紙レポートにも反映されます
              </div>
            </div>
          </>
        )
      })()}
    </div>
  )
}
