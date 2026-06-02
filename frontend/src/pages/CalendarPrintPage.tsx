/**
 * CalendarPrintPage — 旧 Excel 「入出庫まとめ管理.xlsm」 の作物別シートを
 * 完全再現した 紙レポート 専用ページ。
 *
 * 設計方針:
 *   1. 縦横の余白を最小に取り、 表だけで紙面を埋める。
 *   2. JS で表の自然サイズを計測し、 「Excel の 横1×縦1 印刷」 と同じく
 *      transform: scale() で 1 ページに収まるよう自動縮尺。
 *   3. 横長 (横スケール < 縦スケール) のときは上下余白をさらに削る。
 *   4. 表示列はユーザーがトグルでカスタマイズ可 (localStorage で永続)。
 *   5. ロード後、 自動で window.print() を起動。
 *
 * 起動方法:
 *   /print/calendar?crop_id=2&month=2026-05
 *   (CalendarPage の 「📄 紙レポート」 ボタンから new window で開かれる)
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api/client'
import { num, yen, ymd } from '../lib/format'
import { useAuth } from '../auth/AuthContext'
import PrintColumnSettings from '../components/PrintColumnSettings'
import type { CalendarView, CalendarLot } from '../api/types'

const A4_LANDSCAPE_W_MM = 297
const A4_LANDSCAPE_H_MM = 210
const MM_TO_PX = 96 / 25.4

// ─── Excel ライク な配色 (ユーザー指定) ───
// 列カテゴリ毎に HEADER / BODY / FOOTER (合計行) の背景色を持つ。
const COLOR = {
  borderHeader: '#1F4E79',  // 表外枠 (濃紺)
  borderInner:  '#7F7F7F',  // セル枠 中灰
  text:         '#000',
  white:        '#FFFFFF',
}

type ColCategory = 'blue' | 'yellow' | 'green' | 'day'

// 列 → カテゴリ
function categoryOf(id: string): ColCategory {
  if (id === 'supplier' || id === 'inbound_date'
      || id === 'stocktake' || id === 'stocktake_diff' || id === 'stocktake_note') {
    return 'blue'
  }
  if (id === 'end_kg' || id === 'end_value') return 'yellow'
  return 'green'
}

// カテゴリ → {header, body, footer} 背景色
function bgsFor(cat: ColCategory): { header: string; body: string; footer: string } {
  switch (cat) {
    case 'blue':
      // ヘッダー&フッター #9BC2E6、 間の行 #DDEBF7
      return { header: '#9BC2E6', body: '#DDEBF7', footer: '#9BC2E6' }
    case 'yellow':
      // 全部 #FFFF00
      return { header: '#FFFF00', body: '#FFFF00', footer: '#FFFF00' }
    case 'green':
      // ヘッダー&フッター #A9D08E、 間の行 無色
      return { header: '#A9D08E', body: COLOR.white, footer: '#A9D08E' }
    case 'day':
      // ヘッダーのみ #FCE4D6、 間の行と合計行は無色
      return { header: '#FCE4D6', body: COLOR.white, footer: COLOR.white }
  }
}

// 列定義 (id, ラベル, 親グループ, デフォルト ON?)
type ColGroup = 'identity' | 'cost' | 'tax' | 'prepay' | 'inbound' | 'postpay' | 'summary' | 'stocktake'
interface ColDef {
  id: string
  label: string
  group: ColGroup
  defaultOn: boolean
  width: string    // CSS 幅 (必須、 table-layout:fixed のため)
  numeric?: boolean
}

// 「常時表示の必須列」 はカスタマイズ対象外。
// 幅は table-layout:fixed 用の固定値。 文字つぶれを防ぐため text 系列は wrap 許容 + 余裕幅。
const ALWAYS_COLS: ColDef[] = [
  { id: 'supplier',    label: '仕入先',  group: 'identity', defaultOn: true, width: '110px' },
  { id: 'origin',      label: '産地',    group: 'identity', defaultOn: true, width: '70px' },
  { id: 'spec',        label: '規格',    group: 'identity', defaultOn: true, width: '70px' },
  { id: 'cases',       label: 'ケース',   group: 'identity', defaultOn: true, width: '50px', numeric: true },
  { id: 'kg_per_case', label: 'kg/CS',  group: 'identity', defaultOn: true, width: '45px', numeric: true },
  { id: 'total_kg',    label: '数量(kg)', group: 'identity', defaultOn: true, width: '60px', numeric: true },
  { id: 'unit_price',  label: '単価',    group: 'identity', defaultOn: true, width: '60px', numeric: true },
  { id: 'inbound_date',label: '入荷日',  group: 'identity', defaultOn: true, width: '72px' },
]
const OPTIONAL_COLS: ColDef[] = [
  { id: 'brokerage',     label: '仲介手数料',  group: 'cost',      defaultOn: false, width: '60px', numeric: true },
  { id: 'freight',       label: '運賃',         group: 'cost',      defaultOn: false, width: '55px', numeric: true },
  { id: 'tax',           label: '消費税(8%)',  group: 'tax',       defaultOn: true,  width: '72px', numeric: true },
  { id: 'grand_total',   label: '合計金額',     group: 'tax',       defaultOn: true,  width: '90px', numeric: true },
  { id: 'prepay_date',   label: '前払日',       group: 'prepay',    defaultOn: true,  width: '72px' },
  { id: 'prepay_amount', label: '前払金額(円)', group: 'prepay',    defaultOn: true,  width: '90px', numeric: true },
  { id: 'postpay_date',  label: '後払日',       group: 'postpay',   defaultOn: true,  width: '72px' },
  { id: 'postpay_amount',label: '後払金額(円)', group: 'postpay',   defaultOn: true,  width: '90px', numeric: true },
  // ─── 在庫サマリ: 「前月繰越」 「当月入荷」 「当月出庫」 「当月在庫」 「在庫評価額」 順 ───
  { id: 'carryover',     label: '前月繰越',    group: 'summary',   defaultOn: true,  width: '55px', numeric: true },
  { id: 'inbound_kg',    label: '当月入荷',    group: 'summary',   defaultOn: true,  width: '55px', numeric: true },
  { id: 'outbound',      label: '当月出庫',    group: 'summary',   defaultOn: true,  width: '55px', numeric: true },
  { id: 'end_kg',        label: '当月在庫',    group: 'summary',   defaultOn: true,  width: '55px', numeric: true },
  { id: 'end_value',     label: '在庫評価額',  group: 'summary',   defaultOn: true,  width: '80px', numeric: true },
  // ─── 月末棚卸 (デフォルト OFF) ───
  { id: 'stocktake',     label: '棚卸数',      group: 'stocktake', defaultOn: false, width: '55px', numeric: true },
  { id: 'stocktake_diff',label: '差数',        group: 'stocktake', defaultOn: false, width: '50px', numeric: true },
  { id: 'stocktake_note',label: '差数原因',    group: 'stocktake', defaultOn: false, width: '90px' },
]
const ALL_COLS = [...ALWAYS_COLS, ...OPTIONAL_COLS]

// 日付列は全て同じ幅で固定 (table-layout:fixed + 同じ width の <col> で強制)
const DAY_COL_WIDTH = '26px'

// 列カスタマイズ設定を 作物別 に記憶 (作物ごとに別レイアウトを使い分けるため)
const PREF_KEY_PREFIX = 'calendar_print_visible_cols_v2_crop'
function prefKeyFor(cropId: string | null | undefined): string {
  return `${PREF_KEY_PREFIX}${cropId ?? 'all'}`
}

function n(v: string | number | null | undefined): number {
  if (v == null || v === '') return 0
  const x = typeof v === 'string' ? Number(v) : v
  return Number.isFinite(x) ? x : 0
}

function daysOfMonth(month: string): number {
  const [y, m] = month.split('-').map(Number)
  return new Date(y, m, 0).getDate()
}

/** 表の自然サイズを計測し、 1 ページに収まる scale を返す。 */
function computeFitScale(
  innerWPx: number, innerHPx: number,
  pageWMm: number, pageHMm: number,
  marginMm: number,
): { scale: number, marginV: number, marginH: number } {
  const usableW = (pageWMm - marginMm * 2) * MM_TO_PX
  const usableH = (pageHMm - marginMm * 2) * MM_TO_PX
  const sx = usableW / innerWPx
  const sy = usableH / innerHPx
  const scale = Math.min(sx, sy, 1)
  const scaledH = innerHPx * scale
  const scaledW = innerWPx * scale
  const marginV = Math.max(2, (pageHMm - scaledH / MM_TO_PX) / 2)
  const marginH = Math.max(2, (pageWMm - scaledW / MM_TO_PX) / 2)
  return { scale, marginV, marginH }
}

export default function CalendarPrintPage() {
  const [params] = useSearchParams()
  const month = params.get('month') ?? new Date().toISOString().slice(0, 7)
  const cropId = params.get('crop_id')
  // サブ分類フィルタ (大蒜の通常 / 黒ニンニク / 田子産 で別レポートを出すため)
  const subKind = params.get('sub_kind') || undefined
  const originName = params.get('origin_name') || undefined
  const excludeOrigin = params.get('exclude_origin') || undefined
  const auth = useAuth()
  const printName = auth.user?.display_name ?? ''

  const [data, setData] = useState<CalendarView | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const q: Record<string, string> = { month }
    if (cropId) q.crop_id = cropId
    if (subKind) q.sub_kind = subKind
    if (originName) q.origin_name = originName
    if (excludeOrigin) q.exclude_origin_name = excludeOrigin
    api.get<CalendarView>('/calendar', q)
      .then(setData).catch((e) => setError(String(e)))
  }, [month, cropId, subKind, originName, excludeOrigin])

  const ndays = daysOfMonth(month)
  // 未来日付は紙レポートに不要 — 当月の場合は今日まで、 過去月なら月末まで
  const days = useMemo(() => {
    const todayJST = new Date()
    const currentYM = `${todayJST.getFullYear()}-${String(todayJST.getMonth() + 1).padStart(2, '0')}`
    const cutoff = (month === currentYM) ? todayJST.getDate() : ndays
    return Array.from({ length: Math.min(ndays, cutoff) }, (_, i) => i + 1)
  }, [ndays, month])

  // ─── 最新活動日 (= その日の入荷・出庫データを赤フォント強調) ───
  // 「当月内で最も新しい入荷日 or 出庫日」 を 1 つ特定する。
  const latestDay = useMemo<number | null>(() => {
    if (!data || data.lots.length === 0) return null
    const [yyyy, mm] = month.split('-').map(Number)
    let maxDay = 0
    for (const lot of data.lots) {
      // 入荷日が当月にあれば候補
      const d = new Date(lot.inbound_date)
      if (d.getFullYear() === yyyy && (d.getMonth() + 1) === mm) {
        if (d.getDate() > maxDay) maxDay = d.getDate()
      }
      // 出庫日 (daily の key)
      for (const dayStr of Object.keys(lot.daily ?? {})) {
        const dd = Number(dayStr)
        if (Number.isFinite(dd) && dd > maxDay) maxDay = dd
      }
    }
    return maxDay > 0 ? maxDay : null
  }, [data, month])

  // ─── 列表示設定 (localStorage で 作物別 に永続) ───
  // 起動時: URL の crop_id に紐づく前回設定を読込。 無ければデフォルト。
  // 変更時: URL crop_id 別キーで保存。
  const [visibleCols, setVisibleCols] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(prefKeyFor(cropId))
      if (raw) return new Set(JSON.parse(raw))
    } catch { /* */ }
    return new Set([
      ...ALWAYS_COLS.map((c) => c.id),
      ...OPTIONAL_COLS.filter((c) => c.defaultOn).map((c) => c.id),
    ])
  })
  useEffect(() => {
    try { localStorage.setItem(prefKeyFor(cropId), JSON.stringify([...visibleCols])) }
    catch { /* */ }
  }, [visibleCols, cropId])
  function toggleCol(id: string) {
    setVisibleCols((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  function resetCols() {
    setVisibleCols(new Set([
      ...ALWAYS_COLS.map((c) => c.id),
      ...OPTIONAL_COLS.filter((c) => c.defaultOn).map((c) => c.id),
    ]))
  }

  // 表示する列定義 (順序固定 = ALL_COLS の並び)
  const activeCols = useMemo(
    () => ALL_COLS.filter((c) => visibleCols.has(c.id)),
    [visibleCols])

  // ─── 自動縮尺 ───
  // innerRef: 表組み本体 (transform: scale 適用先 — natural サイズで描画される)
  // scaledWrapRef: scale 後の実寸で囲むラッパ
  //   → ブラウザ印刷エンジンが正しいレイアウト寸法で pagination 判定するために必須
  const innerRef = useRef<HTMLDivElement>(null)
  const scaledWrapRef = useRef<HTMLDivElement>(null)
  const [printReady, setPrintReady] = useState(false)

  // ─── 余白自動トリミング オプション ───
  // ON にすると、 @page サイズを実コンテンツに合わせて自動拡張/縮小し
  // 余白を最小化する (= 用紙サイズが非標準になる)。 OFF で A4 横の標準。
  const TRIM_KEY = 'calendar_print_auto_trim_v1'
  const [autoTrim, setAutoTrim] = useState<boolean>(() => {
    try { return localStorage.getItem(TRIM_KEY) === '1' }
    catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem(TRIM_KEY, autoTrim ? '1' : '0') }
    catch { /* */ }
  }, [autoTrim])

  // ─── ユーザー zoom (Ctrl + マウスホイール) ───
  // 印刷出力には影響しない、 プレビュー時の細部確認用。
  const [userZoom, setUserZoom] = useState(1)
  useEffect(() => {
    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      setUserZoom((z) => {
        const next = z + (e.deltaY < 0 ? 0.1 : -0.1)
        return Math.max(0.4, Math.min(3, Math.round(next * 10) / 10))
      })
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => window.removeEventListener('wheel', onWheel)
  }, [])
  function resetZoom() { setUserZoom(1) }

  useLayoutEffect(() => {
    if (!data || !innerRef.current) return
    const inner = innerRef.current
    const wrap = scaledWrapRef.current
    // 計測前に transform をリセット
    inner.style.transform = 'scale(1)'
    if (wrap) { wrap.style.width = 'auto'; wrap.style.height = 'auto' }
    const rect = inner.getBoundingClientRect()
    const styleEl = document.getElementById('print-page-style') as HTMLStyleElement | null
        ?? Object.assign(document.createElement('style'), { id: 'print-page-style' })
    if (!styleEl.parentElement) document.head.appendChild(styleEl)

    let scale = 1
    let pageWmm = A4_LANDSCAPE_W_MM
    let pageHmm = A4_LANDSCAPE_H_MM
    let marginV = 4
    let marginH = 4

    if (autoTrim) {
      // 自動トリミング: scale=1。 @page サイズは wrap (buffer 込み) を基に下で計算
      scale = 1
    } else {
      // ─── 通常モード: A4 横 + JS 自動縮尺 (縦に 12% 安全マージン) ───
      // 押印欄が下端ギリギリにならないよう、 縦の実効高を 88% に絞る。
      // ブラウザ印刷エンジンの DPI 丸めや transform: scale の誤差を吸収。
      const fit = computeFitScale(
        rect.width, rect.height,
        A4_LANDSCAPE_W_MM, A4_LANDSCAPE_H_MM * 0.88,
        4,
      )
      scale = fit.scale
      marginV = fit.marginV
      marginH = fit.marginH
    }

    inner.style.transform = `scale(${scale})`
    inner.style.transformOrigin = 'top left'
    // ★ wrap = 印刷エンジンが見る pagination 用 box (mm 単位)
    const BUFFER_MM = 5
    const scaledWmm = (rect.width * scale) / MM_TO_PX
    const scaledHmm = (rect.height * scale) / MM_TO_PX
    const wrapWmm = scaledWmm
    const wrapHmm = scaledHmm + BUFFER_MM
    if (wrap) {
      wrap.style.width = `${wrapWmm.toFixed(2)}mm`
      wrap.style.height = `${wrapHmm.toFixed(2)}mm`
      wrap.style.overflow = 'visible'
    }

    // ─── @page サイズ — wrap が必ず収まる寸法で決定 ───
    let pageSizeCss: string
    if (autoTrim) {
      // 自動トリミング: wrap (buffer 込み) + 2mm padding = 非標準ピッタリサイズ
      const padMm = 2
      pageWmm = Math.ceil(wrapWmm + padMm * 2)
      pageHmm = Math.ceil(wrapHmm + padMm * 2)
      marginV = padMm
      marginH = padMm
      pageSizeCss = `${pageWmm}mm ${pageHmm}mm`
    } else {
      // A4 横 — wrap を中央配置するための margin を計算 (wrap は scale で A4 内に収まる)
      pageWmm = A4_LANDSCAPE_W_MM
      pageHmm = A4_LANDSCAPE_H_MM
      marginH = Math.max(2, (pageWmm - wrapWmm) / 2)
      marginV = Math.max(2, (pageHmm - wrapHmm) / 2)
      pageSizeCss = 'A4 landscape'
    }

    styleEl.textContent = `
      @page {
        size: ${pageSizeCss};
        margin: ${marginV.toFixed(2)}mm ${marginH.toFixed(2)}mm;
      }
      @media print {
        html, body {
          margin: 0 !important; padding: 0 !important; background: #fff !important;
          width: auto !important; height: auto !important;
        }
        .no-print { display: none !important; }
        .report-preview-wrap { transform: none !important; }
        .report-page {
          width: auto !important;
          min-height: 0 !important;
          height: auto !important;
          margin: 0 !important;
          padding: 0 !important;
          box-shadow: none !important;
          overflow: visible !important;
          display: block !important;
          page-break-inside: avoid !important;
          break-inside: avoid !important;
          page-break-after: avoid !important;
          break-after: avoid !important;
        }
        .report-scaled-wrap {
          width: ${wrapWmm.toFixed(2)}mm !important;
          height: ${wrapHmm.toFixed(2)}mm !important;
          overflow: visible !important;
          page-break-inside: avoid !important;
          break-inside: avoid !important;
        }
        .report-scaled-wrap * {
          page-break-inside: avoid !important;
          break-inside: avoid !important;
        }
      }
    `
    setPrintReady(true)
  }, [data, activeCols, days, autoTrim])

  // 自動印刷起動 (auto=1 が default、 auto=0 で抑止)
  useEffect(() => {
    if (!printReady) return
    if (params.get('auto') === '0') return
    const t = setTimeout(() => { window.print() }, 250)
    return () => clearTimeout(t)
  }, [printReady, params])

  if (error) return <div style={{ padding: 16 }}><div className="alert error">{error}</div></div>
  if (!data) return <div style={{ padding: 16 }} className="muted">読み込み中…</div>

  // タイトル: 「みどり物産事業N部M月仕入管理台帳」
  // サブ分類があれば サブタイトルとして付与 (黒ニンニク / 半製品 / 産地別)
  // 通常 (= 黒・半製品・特定産地 を 除いた メイン) は 「○○部」 だけ で 表記 する ため
  // ラベル を 付与 しない。
  const divisionNo = data.crop_id ?? cropId ?? '？'
  const monthNo = parseInt(month.slice(5, 7), 10)
  let subCategory = ''
  if (subKind === 'black') subCategory = '黒ニンニク'
  else if (subKind === 'semifinished') subCategory = '半製品'
  else if (originName) subCategory = `${originName}産`
  const title = `みどり物産事業${divisionNo}部${monthNo}月仕入管理台帳`
    + (subCategory ? `「${subCategory}」` : '')
  const today = data.prepared_at ? data.prepared_at.slice(0, 10) : ymd(new Date().toISOString())
  const totals = computeTotals(data.lots, days)

  return (
    <div style={{ background: '#eee', minHeight: '100vh' }}>
      {/* 操作バー (印刷時は非表示) */}
      <div className="no-print" style={{
        position: 'sticky', top: 0, zIndex: 100,
        padding: '8px 12px', background: '#fff',
        borderBottom: '1px solid #ddd',
        display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
      }}>
        <strong>📄 紙レポート プレビュー</strong>
        <span style={{ color: '#666', fontSize: 12 }}>
          {title}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: '#666' }}>
          Ctrl+ホイール で 拡大/縮小 ({Math.round(userZoom * 100)}%)
        </span>
        {userZoom !== 1 && (
          <button onClick={resetZoom}
            style={{ fontSize: 11, padding: '2px 8px',
                     background: 'transparent', border: '1px solid #ccc',
                     color: '#666', borderRadius: 3 }}>
            zoom リセット
          </button>
        )}
        <label style={{
          display: 'flex', alignItems: 'center', gap: 4,
          fontSize: 11, padding: '4px 8px',
          background: autoTrim ? '#fff7e6' : '#fff',
          border: '1px solid ' + (autoTrim ? '#ff8a00' : '#ccc'),
          borderRadius: 4, cursor: 'pointer',
          color: autoTrim ? '#a85a00' : '#333',
          fontWeight: autoTrim ? 600 : 400,
        }} title="ON: 用紙サイズを実コンテンツに合わせて自動拡張 (非標準サイズ)。 OFF: A4 横 標準。">
          <input type="checkbox" style={{ width: 'auto' }}
            checked={autoTrim}
            onChange={(e) => setAutoTrim(e.target.checked)} />
          余白自動トリミング
        </label>
        <PrintColumnSettings
          items={OPTIONAL_COLS.map(c => ({ id: c.id, label: c.label, groupLabel: GROUP_LABEL[c.group] }))}
          visibleCols={visibleCols}
          onToggle={toggleCol}
          onReset={resetCols}
        />
        <button onClick={() => window.print()}
          style={{ background: '#1a73e8', color: '#fff',
                   border: 'none', padding: '6px 14px', borderRadius: 4 }}>
          🖨 印刷
        </button>
        <button onClick={() => window.close()}
          style={{ background: 'transparent', color: '#666', border: '1px solid #ddd' }}>
          閉じる
        </button>
      </div>

      {/* レポート本体 — プレビュー時の userZoom はここに適用 (印刷出力は無関係) */}
      <div className="report-preview-wrap" style={{
        transform: `scale(${userZoom})`,
        transformOrigin: 'top center',
        transition: 'transform 0.1s ease-out',
      }}>
        <div className="report-page" style={{
          padding: autoTrim ? '2mm' : '4mm',
          background: '#fff',
          width: autoTrim ? 'auto' : `${A4_LANDSCAPE_W_MM}mm`,
          minHeight: autoTrim ? 'auto' : `${A4_LANDSCAPE_H_MM}mm`,
          margin: '16px auto',
          boxShadow: '0 2px 16px rgba(0,0,0,0.12)',
          boxSizing: 'border-box',
          overflow: 'hidden',
          display: 'inline-block',
        }}>
          {/* scale 後の実寸で囲むラッパ — 印刷エンジンに正しい寸法を伝える。
              position: relative + inner を position: absolute にすることで、
              inner の natural サイズ が layout flow に漏れず、 印刷時の
              pagination は wrap の mm 寸法だけで判定される。 */}
          <div ref={scaledWrapRef} className="report-scaled-wrap"
            style={{ position: 'relative' }}>
            <div ref={innerRef} style={{
              transformOrigin: 'top left',
              position: 'absolute', top: 0, left: 0,
            }}>
              <ReportInner
                data={data}
                days={days}
                totals={totals}
                activeCols={activeCols}
                title={title}
                today={today}
                printName={printName}
                latestDay={latestDay}
                month={month}
              />
            </div>
          </div>
        </div>
      </div>
      {/* 印刷時に userZoom 由来の transform は無効化 */}
      <style>{`
        @media print {
          .report-preview-wrap { transform: none !important; }
          .report-page { margin: 0 !important; box-shadow: none !important; }
        }
      `}</style>
    </div>
  )
}

/** 列表示設定パネル (印刷時は非表示) */
const GROUP_LABEL: Record<ColGroup, string> = {
  identity:  '基本',
  cost:      '諸経費',
  tax:       '税金/合計',
  prepay:    '前払い',
  inbound:   '入荷',
  postpay:   '後払い',
  summary:   '在庫',
  stocktake: '棚卸',
}

interface Totals {
  cases: number
  total_kg: number
  brokerage: number
  freight: number
  tax: number
  grand_total: number
  prepay: number
  postpay: number
  carryover: number
  inbound: number
  outbound: number
  end_kg: number
  end_value: number
  stocktake: number
  daily: number[]
}

function computeTotals(lots: CalendarLot[], days: number[]): Totals {
  const t: Totals = {
    cases: 0, total_kg: 0, brokerage: 0, freight: 0, tax: 0, grand_total: 0,
    prepay: 0, postpay: 0, carryover: 0, inbound: 0, outbound: 0, end_kg: 0,
    end_value: 0, stocktake: 0,
    daily: days.map(() => 0),
  }
  const TAX_RATE = 0.08
  for (const l of lots) {
    const kgPerCase = n(l.kg_per_case)
    const cases = kgPerCase > 0 ? n(l.total_kg) / kgPerCase : 0
    const unitPrice = n(l.unit_price)
    const subtotal = n(l.total_kg) * unitPrice
    const tax = Math.round(subtotal * TAX_RATE)
    const brokerage = n(l.brokerage_fee)
    const freight = n(l.freight_fee)
    const grandTotal = Math.round(subtotal + tax + brokerage + freight)
    t.cases += cases
    t.total_kg += n(l.total_kg)
    t.brokerage += brokerage
    t.freight += freight
    t.tax += tax
    t.grand_total += grandTotal
    t.prepay += n(l.prepay_amount)
    t.postpay += n(l.postpay_amount)
    t.carryover += n(l.carryover_kg)
    t.inbound += n(l.inbound_kg)
    t.outbound += n(l.outbound_kg)
    t.end_kg += n(l.end_kg)
    t.end_value += unitPrice * n(l.end_kg)
    t.stocktake += n(l.stocktake_kg)
    for (let i = 0; i < days.length; i++) {
      t.daily[i] += n(l.daily?.[String(days[i])])
    }
  }
  return t
}

function ReportInner({
  data, days, totals, activeCols, title, today, printName, latestDay, month,
}: {
  data: CalendarView
  days: number[]
  totals: Totals
  activeCols: ColDef[]
  title: string
  today: string
  printName: string
  latestDay: number | null
  month: string
}) {
  // ─── セルコメント の脚注番号付与 (migration 055) ───
  //   ロット順 → 日付昇順 で 1, 2, 3, ... を振る。 表セルには * + 番号を表示し、
  //   下部の脚注リストで lot_code / 日付 / コメント本文 を一覧表示する。
  const footnotes: { n: number; lotId: number; lotCode: string; day: number; comment: string }[] = []
  const footnoteNumberByKey = new Map<string, number>()  // key = `${lotId}:${day}`
  for (const l of data.lots) {
    const cmts = l.comments ?? {}
    const dayNums = Object.keys(cmts).map(Number).sort((a, b) => a - b)
    for (const d of dayNums) {
      const c = cmts[String(d)]
      if (!c) continue
      const n = footnotes.length + 1
      footnotes.push({
        n, lotId: l.lot_id,
        lotCode: l.lot_code ?? `#${l.lot_id}`,
        day: d, comment: c,
      })
      footnoteNumberByKey.set(`${l.lot_id}:${d}`, n)
    }
  }

  return (
    <div style={{
      fontFamily: '"Yu Mincho", "Hiragino Mincho ProN", "MS Mincho", serif',
      fontSize: 10, color: COLOR.text,
    }}>
      {/* タイトル行 — 先頭に SHIMIZU ロゴ (SVG なので印刷時高解像度) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <img src="/logo-shimizu.png" alt="SHIMIZU"
          style={{ height: 28, flexShrink: 0 }} />
        <div style={{ fontWeight: 700, fontSize: 15, color: COLOR.borderHeader }}>
          {title}
        </div>
        <div style={{ marginLeft: 'auto', fontSize: 10 }}>
          更新日： {today}　/　作成者： {printName || '____'}
        </div>
      </div>

      <ReportTable lots={data.lots} days={days} totals={totals}
        activeCols={activeCols}
        latestDay={latestDay} month={month}
        footnoteNumberByKey={footnoteNumberByKey} />

      {footnotes.length > 0 && (
        <div style={{
          marginTop: 8, padding: '6px 10px',
          border: `1px solid ${COLOR.borderInner}`,
          background: '#fffef5', fontSize: 9, lineHeight: 1.5,
        }}>
          <div style={{ fontWeight: 700, marginBottom: 4, color: COLOR.borderHeader }}>
            ※ コメント
          </div>
          <ol style={{ margin: 0, paddingLeft: 22 }}>
            {footnotes.map((f) => (
              <li key={f.n} style={{ marginBottom: 1 }}>
                {/* 当該セルと同じ色の小さい □ — 視覚的に紐付ける */}
                <span aria-hidden style={{
                  display: 'inline-block', width: 8, height: 8,
                  background: bgsFor('day').header,
                  border: `1px solid ${COLOR.borderInner}`,
                  marginRight: 4, verticalAlign: 'middle',
                }} />
                <span style={{ color: '#666' }}>
                  ({month.slice(5, 7)}月{f.day}日)
                </span>
                {' '}{f.comment}
              </li>
            ))}
          </ol>
        </div>
      )}

      <div style={{ marginTop: 6, display: 'flex', gap: 16, justifyContent: 'flex-end' }}>
        <SignBox label="作成者" name={printName} />
        <SignBox label="確認者" />
        <SignBox label="承認者" />
      </div>
    </div>
  )
}

function SignBox({ label, name }: { label: string; name?: string }) {
  return (
    <div style={{
      width: 70, height: 50,
      border: `1px solid ${COLOR.borderInner}`,
      display: 'flex', flexDirection: 'column',
      fontSize: 9,
    }}>
      <div style={{
        borderBottom: `1px solid ${COLOR.borderInner}`,
        padding: '1px 4px',
        background: COLOR.white, textAlign: 'center',
      }}>{label}</div>
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 10,
      }}>{name || ''}</div>
    </div>
  )
}

function ReportTable({
  lots, days, totals, activeCols, latestDay, month, footnoteNumberByKey,
}: {
  lots: CalendarLot[]
  days: number[]
  totals: Totals
  activeCols: ColDef[]
  latestDay: number | null
  month: string
  footnoteNumberByKey: Map<string, number>
}) {
  // 最新活動日強調用 — その日の入荷 lot は行全体、 その日の出庫セルは赤フォント
  const RED = '#c0392b'
  const [yyyy, mm] = month.split('-').map(Number)
  function lotInboundDay(l: CalendarLot): number {
    const d = new Date(l.inbound_date)
    if (d.getFullYear() === yyyy && (d.getMonth() + 1) === mm) return d.getDate()
    return -1
  }
  const TAX_RATE = 0.08
  // 行余裕 + セル余白: 上下 3px、 左右 5px。 line-height も少し広げて読みやすく
  const cellPad = '3px 5px'
  const border = `1px solid ${COLOR.borderInner}`

  // 文字つぶれ防止: text 系列は wrap 許容、 数値・日付列は nowrap (固定幅でも 1 行で収まる)
  const TEXT_WRAP_IDS = new Set(['supplier', 'origin', 'spec', 'stocktake_note'])
  function whiteSpaceFor(id: string): React.CSSProperties['whiteSpace'] {
    return TEXT_WRAP_IDS.has(id) ? 'normal' : 'nowrap'
  }

  // 列ごとのアライメント:
  //   - 日付 (入荷日/前払日/後払日) → center
  //   - 数値系 (numeric=true) → right (桁が縦に揃う = 会計帳票標準)
  //   - テキスト → left
  const CENTER_DATE_IDS = new Set(['inbound_date', 'prepay_date', 'postpay_date'])
  function alignFor(c: ColDef): React.CSSProperties['textAlign'] {
    if (CENTER_DATE_IDS.has(c.id)) return 'center'
    if (c.numeric) return 'right'
    return 'left'
  }

  const baseCell: React.CSSProperties = {
    border, padding: cellPad,
    wordBreak: 'break-all',
    lineHeight: 1.3,
  }
  const headerCellBase: React.CSSProperties = {
    ...baseCell,
    fontWeight: 700, textAlign: 'center', color: COLOR.borderHeader,
    borderColor: COLOR.borderHeader,
    whiteSpace: 'nowrap',
  }

  // 各列のレンダラ — 値だけ返す (背景色は呼び出し側で td に適用)
  function cellContent(col: ColDef, l: CalendarLot): React.ReactNode {
    switch (col.id) {
      case 'supplier':    return l.supplier_name
      case 'origin':      return l.origin_name
      case 'spec':        return [
        // 「標準」 は規格として表示しない (規格・等級・サイズの合体表示で省略)
        l.spec_type && l.spec_type !== '標準' ? l.spec_type : '',
        l.grade_level && l.grade_level !== '-' ? l.grade_level : '',
        l.size_label && l.size_label !== '-' ? l.size_label : '',
      ].join('')
      case 'cases': {
        const kpc = n(l.kg_per_case)
        const c = kpc > 0 ? n(l.total_kg) / kpc : 0
        return c ? num(c, 1) : ''
      }
      case 'kg_per_case': return l.kg_per_case ? num(n(l.kg_per_case), 1) : ''
      case 'total_kg':    return num(n(l.total_kg), 0)
      case 'unit_price':  return l.unit_price ? yen(n(l.unit_price)) : ''
      case 'brokerage':   return l.brokerage_fee ? yen(n(l.brokerage_fee)) : ''
      case 'freight':     return l.freight_fee ? yen(n(l.freight_fee)) : ''
      case 'tax': {
        const sub = n(l.total_kg) * n(l.unit_price)
        const t = sub > 0 ? Math.round(sub * TAX_RATE) : 0
        return t ? yen(t) : ''
      }
      case 'grand_total': {
        const sub = n(l.total_kg) * n(l.unit_price)
        const t = sub > 0 ? Math.round(sub * TAX_RATE) : 0
        const gt = Math.round(sub + t + n(l.brokerage_fee) + n(l.freight_fee))
        return gt ? yen(gt) : ''
      }
      case 'prepay_date':   return l.prepay_date ? ymd(l.prepay_date) : ''
      case 'prepay_amount': return l.prepay_amount ? yen(n(l.prepay_amount)) : ''
      case 'inbound_date':  return ymd(l.inbound_date)
      case 'postpay_date':  return l.postpay_date ? ymd(l.postpay_date) : ''
      case 'postpay_amount':return l.postpay_amount ? yen(n(l.postpay_amount)) : ''
      case 'carryover':     return num(n(l.carryover_kg), 0)
      case 'inbound_kg':    return n(l.inbound_kg) > 0 ? num(n(l.inbound_kg), 0) : ''
      case 'outbound':      return num(n(l.outbound_kg), 0)
      case 'end_kg':        return num(n(l.end_kg), 0)
      case 'end_value': {
        const ev = n(l.unit_price) * n(l.end_kg)
        return ev ? yen(Math.round(ev)) : ''
      }
      case 'stocktake':     return l.stocktake_kg != null ? num(n(l.stocktake_kg), 0) : ''
      case 'stocktake_diff':return l.stocktake_diff != null && n(l.stocktake_diff) !== 0 ? num(n(l.stocktake_diff), 0) : ''
      case 'stocktake_note':return l.stocktake_note ?? ''
      default: return ''
    }
  }

  // 合計行セル content
  function totalContent(col: ColDef): React.ReactNode {
    switch (col.id) {
      case 'supplier':    return '合計'
      case 'cases':       return num(totals.cases, 1)
      case 'total_kg':    return num(totals.total_kg, 0)
      case 'brokerage':   return totals.brokerage ? yen(totals.brokerage) : ''
      case 'freight':     return totals.freight ? yen(totals.freight) : ''
      case 'tax':         return yen(totals.tax)
      case 'grand_total': return yen(totals.grand_total)
      case 'prepay_amount':return totals.prepay ? yen(totals.prepay) : ''
      case 'postpay_amount':return totals.postpay ? yen(totals.postpay) : ''
      case 'carryover':   return num(totals.carryover, 0)
      case 'inbound_kg':  return totals.inbound ? num(totals.inbound, 0) : ''
      case 'outbound':    return num(totals.outbound, 0)
      case 'end_kg':      return num(totals.end_kg, 0)
      case 'end_value':   return yen(Math.round(totals.end_value))
      case 'stocktake':   return totals.stocktake ? num(totals.stocktake, 0) : ''
      default:            return ''
    }
  }

  return (
    <table style={{
      borderCollapse: 'collapse',
      tableLayout: 'fixed',
      fontSize: 9, lineHeight: 1.15,
      border: `1.5px solid ${COLOR.borderHeader}`,
    }}>
      <colgroup>
        {activeCols.map((c) => (
          <col key={c.id} style={{ width: c.width }} />
        ))}
        {days.map((d) => (
          <col key={`d${d}`} style={{ width: DAY_COL_WIDTH }} />
        ))}
      </colgroup>
      <thead>
        <tr>
          {activeCols.map((c) => (
            <th key={c.id}
              style={{ ...headerCellBase, background: bgsFor(categoryOf(c.id)).header }}>
              {c.label}
            </th>
          ))}
          {days.map((d) => (
            <th key={d}
              style={{ ...headerCellBase, background: bgsFor('day').header }}>
              {d}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {lots.map((l, rowIdx) => {
          // ─── 網状の格子罫線 (全 BODY セル) ───
          const meshTop  = rowIdx % 2 === 0 ? '#FCE4D6' : '#9BC2E6'
          const meshBot  = rowIdx % 2 === 0 ? '#9BC2E6' : '#FCE4D6'
          const meshLeft = (idx: number) => idx % 2 === 0 ? '#FCE4D6' : '#9BC2E6'
          const meshRight = (idx: number) => idx % 2 === 0 ? '#9BC2E6' : '#FCE4D6'
          // ─── 最新日 強調 ───
          // この lot の入荷日が latestDay と一致 → 行の活性列セルだけ赤フォント
          // (日付列セルは別判定 = その日の出庫量があれば赤フォント)
          const lotIsLatestInbound = latestDay != null && lotInboundDay(l) === latestDay
          return (
            <tr key={l.lot_id}>
              {activeCols.map((c, colIdx) => (
                <td key={c.id}
                  style={{
                    ...baseCell,
                    background: bgsFor(categoryOf(c.id)).body,
                    textAlign: alignFor(c),
                    whiteSpace: whiteSpaceFor(c.id),
                    borderTopColor:    meshTop,
                    borderBottomColor: meshBot,
                    borderLeftColor:   meshLeft(colIdx),
                    borderRightColor:  meshRight(colIdx),
                    color: lotIsLatestInbound ? RED : undefined,
                  }}>
                  {cellContent(c, l)}
                </td>
              ))}
              {days.map((d, dayIdx) => {
                const qty = n(l.daily?.[String(d)])
                const globalCol = activeCols.length + dayIdx
                const isLatestDayCell = latestDay != null && d === latestDay && qty > 0
                // 脚注番号 (このセルにコメントがあれば *N を上付き表示)
                const fnN = footnoteNumberByKey.get(`${l.lot_id}:${d}`)
                // コメント付きセルは 日付ヘッダーと同じ色 (#FCE4D6) で塗りつぶし、
                // 下の脚注リストの ■ と 視覚的に対応させる
                const cellBg = fnN != null ? bgsFor('day').header : bgsFor('day').body
                return (
                  <td key={d}
                    style={{
                      ...baseCell,
                      background: cellBg,
                      textAlign: 'center',   // 日別セル: 列が狭く値が短いので中央寄せが美しい
                      whiteSpace: 'nowrap',
                      borderTopColor:    meshTop,
                      borderBottomColor: meshBot,
                      borderLeftColor:   meshLeft(globalCol),
                      borderRightColor:  meshRight(globalCol),
                      color: isLatestDayCell ? RED : undefined,
                    }}>
                    {qty > 0 ? num(Math.round(qty), 0) : ''}
                    {fnN != null && (
                      <sup style={{
                        fontSize: 7, color: '#c0392b',
                        marginLeft: 1, fontWeight: 700,
                      }}>*{fnN}</sup>
                    )}
                  </td>
                )
              })}
            </tr>
          )
        })}
        <tr>
          {activeCols.map((c) => (
            <td key={c.id}
              style={{
                ...baseCell,
                background: bgsFor(categoryOf(c.id)).footer,
                textAlign: c.id === 'supplier' ? 'center' : alignFor(c),
                fontWeight: 700,
                whiteSpace: 'nowrap',
              }}>
              {totalContent(c)}
            </td>
          ))}
          {days.map((d, i) => (
            <td key={d}
              style={{
                ...baseCell,
                background: bgsFor('day').footer,
                textAlign: 'center',
                fontWeight: 700,
                whiteSpace: 'nowrap',
              }}>
              {totals.daily[i] > 0 ? num(Math.round(totals.daily[i]), 0) : ''}
            </td>
          ))}
        </tr>
      </tbody>
    </table>
  )
}

