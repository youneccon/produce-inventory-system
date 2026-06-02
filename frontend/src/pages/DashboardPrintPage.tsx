/**
 * DashboardPrintPage — 在庫一覧 紙レポート.
 *
 * 構成 (v2):
 *   - ヘッダ: タイトル + 月 + ロゴ + 更新日 / 作成者
 *   - サマリーカード (前月繰越 / 当月入荷 / 当月出庫 / 当月在庫)
 *   - 当月の動きの内訳: 入荷件数 / 出庫件数 / アクティブロット数 / 未確定単価ロット数
 *   - 商品別サマリー (現在のカスタマイズ列)
 *   - フッタ: 印刷日時 / 凡例
 *
 * ロット別の明細は紙レポートに載せない (画面で確認、または別レポート)。
 * 起動:
 *   /print/dashboard?crop_id=2                              通常 (黒・半製品除外) 自動
 *   /print/dashboard?crop_id=2&sub_kind=black               黒ニンニクのみ
 *   /print/dashboard?crop_id=2&sub_kind=semifinished        半製品 (大蒜独自)
 *   /print/dashboard?crop_id=2&sub_kind=normal              通常を明示
 *   ロード後 自動で window.print()。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useFetch } from '../lib/useFetch'
import { num, yen, ymd } from '../lib/format'
import { usePreferences } from '../auth/PreferencesContext'
import { useAuth } from '../auth/AuthContext'
import {
  PRODUCT_COLUMNS,
  type DashColumn,
} from '../lib/dashboardColumns'
import type {
  DashboardColumnPref,
  DashboardSummary,
  LotStock,
  ProductStock,
} from '../api/types'

const CROP_NAMES: Record<number, string> = {
  1: '生姜', 2: '大蒜', 3: '長芋', 4: '牛蒡', 5: '薩摩芋',
}


function resolveCols<T>(all: DashColumn<T>[], prefs?: DashboardColumnPref[]): DashColumn<T>[] {
  if (!prefs || prefs.length === 0) return all.filter(c => c.defaultVisible)
  const map = new Map(prefs.map(p => [p.id, p.visible]))
  return all.filter(c => {
    const v = map.get(c.id)
    if (v === undefined) return !!c.defaultVisible
    return v
  })
}


export default function DashboardPrintPage() {
  const [sp] = useSearchParams()
  const cropId = sp.get('crop_id') ? Number(sp.get('crop_id')) : undefined
  const subKind = sp.get('sub_kind') || undefined         // 'black' | 'semifinished' | 'normal'
  const originName = sp.get('origin_name') || undefined   // '田子' 等 (旧仕様 — 後方互換用)
  const excludeOrigin = sp.get('exclude_origin') || undefined
  const { prefs } = usePreferences()
  const auth = useAuth()
  const printName = auth.user?.display_name ?? ''
  const today = new Date()
  const todayStr = today.toISOString().slice(0, 10)
  const todayJp = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`

  const fetchParam: Record<string, string> = {}
  if (cropId !== undefined) fetchParam.crop_id = String(cropId)
  if (subKind) fetchParam.sub_kind = subKind
  if (originName) fetchParam.origin_name = originName
  if (excludeOrigin) fetchParam.exclude_origin_name = excludeOrigin
  const summary = useFetch<DashboardSummary>('/dashboard/summary', fetchParam)
  const products = useFetch<ProductStock[]>('/stock/products', fetchParam)
  const lots = useFetch<LotStock[]>('/stock/lots', fetchParam)

  const dash = prefs.dashboard ?? {}
  const productCols = resolveCols(PRODUCT_COLUMNS, dash.product_columns)

  const [autoPrintFired, setAutoPrintFired] = useState(false)
  useEffect(() => {
    if (autoPrintFired) return
    if (summary.loading || products.loading || lots.loading) return
    setAutoPrintFired(true)
    setTimeout(() => window.print(), 600)
  }, [autoPrintFired, summary.loading, products.loading, lots.loading])

  const baseCrop = cropId !== undefined ? (CROP_NAMES[cropId] ?? `crop ${cropId}`) : '全作物'
  // サブ分類のラベル: 黒ニンニク / 半製品 / 産地別
  // 通常 (= 黒・半製品・特定産地 を 除いた メイン) は ラベル 不要
  let categoryLabel = ''
  if (subKind === 'black') categoryLabel = '黒ニンニク'
  else if (subKind === 'semifinished') categoryLabel = '半製品'
  else if (originName) categoryLabel = `${originName}産`
  const cropName = categoryLabel ? `${baseCrop} (${categoryLabel})` : baseCrop
  const monthLabel = summary.data?.month ?? todayStr.slice(0, 7)

  if (summary.loading || products.loading || lots.loading) {
    return <div style={{ padding: 40, fontSize: 14, fontFamily: 'serif' }}>レポート準備中…</div>
  }

  const s = summary.data
  // 派生サマリー (画面の在庫状況の集計)
  const activeLots = lots.data?.filter(l => l.stock_status !== 'depleted').length ?? 0
  const lowLots = lots.data?.filter(l => l.stock_status === 'low').length ?? 0
  const pendingPriceLots = lots.data?.filter(l =>
    l.is_price_pending && l.stock_status !== 'depleted'
  ).length ?? 0
  const totalStockValue = (products.data ?? []).reduce(
    (acc, p) => acc + Number(p.total_stock_value ?? 0), 0
  )

  return (
    <>
      {/* 印刷専用 CSS */}
      <style>{`
        @page { size: A4 portrait; margin: 14mm 12mm; }
        html, body {
          font-family: "Yu Mincho","Hiragino Mincho ProN","MS Mincho",serif;
          color: #1f1e1b; background: #fff;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
        .pr-root { padding: 0; }

        /* ── Header ── */
        .pr-header {
          display: grid;
          grid-template-columns: auto 1fr auto;
          gap: 14px;
          align-items: center;
          padding-bottom: 8px;
          border-bottom: 2px solid #1F4E79;
          margin-bottom: 12px;
        }
        .pr-header img { height: 32px; display: block; }
        .pr-header .title-block { line-height: 1.25; }
        .pr-header .crop-name {
          font-size: 11px; color: #5C5644;
          letter-spacing: 0.05em;
        }
        .pr-header h1 {
          font-size: 18px; font-weight: 700;
          margin: 0; color: #1F4E79;
          letter-spacing: 0.02em;
        }
        .pr-header h1 .month {
          font-weight: 500; color: #4a4a4a;
          margin-left: 8px; font-size: 14px;
        }
        .pr-header .meta {
          font-size: 10px; color: #5C5644;
          text-align: right; line-height: 1.5;
        }
        .pr-header .meta .row { display: flex; gap: 10px; justify-content: flex-end; }
        .pr-header .meta .row .k { color: #8a8266; }

        /* ── サマリーカード (4枚) ── */
        .pr-section-label {
          font-size: 10px; font-weight: 600;
          color: #1F4E79; letter-spacing: 0.1em;
          margin: 14px 0 6px;
          padding-bottom: 2px;
          border-bottom: 1px solid #C9D6E0;
        }
        .pr-cards {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 6px;
        }
        .pr-card {
          border: 1px solid #BFC4B8;
          background: #FAF8F2;
          padding: 8px 10px;
          border-radius: 3px;
          position: relative;
        }
        .pr-card .label {
          font-size: 9.5px; color: #5C5644;
          letter-spacing: 0.04em;
        }
        .pr-card .value {
          font-size: 16px; font-weight: 700;
          font-variant-numeric: tabular-nums;
          margin-top: 2px;
          color: #1f1e1b;
        }
        .pr-card .value .unit {
          font-size: 10px; font-weight: 500;
          color: #5C5644; margin-left: 3px;
        }
        .pr-card .sub {
          font-size: 9px; color: #7a7560;
          margin-top: 1px;
          font-variant-numeric: tabular-nums;
        }
        .pr-card.accent { background: #EAF1F8; border-color: #1F4E79; }
        .pr-card.accent .value { color: #1F4E79; }
        .pr-card.warn { background: #FFF5E5; border-color: #C99744; }
        .pr-card.warn .value { color: #8a5a00; }

        /* ── KPI 横並び (派生指標) ── */
        .pr-kpis {
          display: flex; gap: 14px;
          padding: 8px 12px;
          background: #F5F4ED;
          border-left: 3px solid #1F4E79;
          border-radius: 2px;
          font-size: 10px;
        }
        .pr-kpis .kpi { display: flex; align-items: baseline; gap: 4px; }
        .pr-kpis .kpi .k { color: #5C5644; }
        .pr-kpis .kpi .v {
          font-weight: 700; color: #1f1e1b;
          font-variant-numeric: tabular-nums;
        }
        .pr-kpis .kpi.alert .v { color: #b85a00; }
        .pr-kpis .sep {
          width: 1px; background: #C9C4B0;
        }

        /* ── 商品別サマリー表 ── */
        table.pr-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 9.5px;
          margin-top: 4px;
        }
        .pr-table th, .pr-table td {
          border: 1px solid #BFC4B8;
          padding: 4px 7px;
          vertical-align: middle;
        }
        .pr-table thead th {
          background: #DCE5C6;
          font-weight: 600;
          color: #1f1e1b;
          letter-spacing: 0.02em;
        }
        .pr-table tbody tr:nth-child(even) td {
          background: #FCFCF8;
        }
        .pr-table td.num {
          text-align: right;
          font-variant-numeric: tabular-nums;
        }

        /* ── フッタ ── */
        .pr-footer {
          margin-top: 18px;
          padding-top: 8px;
          border-top: 1px solid #BFC4B8;
          font-size: 8.5px;
          color: #7a7560;
          display: flex; justify-content: space-between;
        }

        @media print {
          .no-print { display: none !important; }
        }
      `}</style>

      <div className="pr-root">
        {/* ── ヘッダ ── */}
        <header className="pr-header">
          <div className="title-block">
            <div className="crop-name">{cropName}</div>
            <h1>
              在庫サマリーレポート
              <span className="month">{monthLabel}</span>
            </h1>
          </div>
          <div className="meta">
            <div className="row"><span className="k">作成日</span><span>{todayJp}</span></div>
            <div className="row"><span className="k">作成者</span><span>{printName || '____'}</span></div>
          </div>
        </header>

        {/* ── 月次サマリー (4カード) ── */}
        {s && (
          <>
            <div className="pr-section-label">月次サマリー</div>
            <div className="pr-cards">
              <div className="pr-card">
                <div className="label">前月繰越</div>
                <div className="value">{num(s.carryover_kg, 0)}<span className="unit">kg</span></div>
                <div className="sub">{s.prev_month} 末棚卸</div>
              </div>
              <div className="pr-card">
                <div className="label">当月入荷</div>
                <div className="value">{num(s.inbound_kg, 0)}<span className="unit">kg</span></div>
                <div className="sub">{s.inbound_count} 件</div>
              </div>
              <div className="pr-card">
                <div className="label">当月出庫</div>
                <div className="value">{num(s.outbound_kg, 0)}<span className="unit">kg</span></div>
                <div className="sub">{s.outbound_count} 件</div>
              </div>
              <div className="pr-card accent">
                <div className="label">当月在庫</div>
                <div className="value">{num(s.stock_now_kg, 0)}<span className="unit">kg</span></div>
                <div className="sub">{ymd(todayStr)} 時点</div>
              </div>
            </div>
          </>
        )}

        {/* ── 派生 KPI ── */}
        <div className="pr-section-label">在庫状況</div>
        <div className="pr-kpis">
          <div className="kpi">
            <span className="k">アクティブロット:</span>
            <span className="v">{activeLots}</span>
          </div>
          <div className="sep" />
          <div className="kpi">
            <span className="k">在庫評価額:</span>
            <span className="v">{yen(totalStockValue)}</span>
          </div>
          <div className="sep" />
          <div className={'kpi' + (lowLots > 0 ? ' alert' : '')}>
            <span className="k">残少ロット:</span>
            <span className="v">{lowLots}</span>
          </div>
          <div className="sep" />
          <div className={'kpi' + (pendingPriceLots > 0 ? ' alert' : '')}>
            <span className="k">単価未確定:</span>
            <span className="v">{pendingPriceLots}</span>
          </div>
        </div>

        {/* ── 商品別サマリー ── */}
        {products.data && products.data.length > 0 && (
          <>
            <div className="pr-section-label">
              商品別サマリー <span style={{ color: '#7a7560', fontWeight: 400 }}>({products.data.length} 件)</span>
            </div>
            <table className="pr-table">
              <thead>
                <tr>
                  {productCols.map(c => (
                    <th key={c.id} className={c.numeric ? 'num' : ''}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {products.data.map((p, i) => (
                  <tr key={i}>
                    {productCols.map(c => (
                      <td key={c.id} className={c.numeric ? 'num' : ''}>
                        {renderProductCell(c.id, p)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {/* ── フッタ ── */}
        <footer className="pr-footer">
          <span>みどり物産 在庫管理システム</span>
          <span>印刷: {todayJp} {String(today.getHours()).padStart(2, '0')}:{String(today.getMinutes()).padStart(2, '0')}</span>
        </footer>
      </div>
    </>
  )
}


function renderProductCell(id: string, p: ProductStock): ReactNode {
  switch (id) {
    case 'spec_type':       return p.spec_type
    case 'grade_level':     return p.grade_level && p.grade_level !== '-' ? p.grade_level : '—'
    case 'size_label':      return p.size_label && p.size_label !== '-' ? p.size_label : '—'
    case 'origin_name':     return p.origin_name
    case 'active_lot_count':return p.active_lot_count
    case 'total_remaining_kg': return num(p.total_remaining_kg, 1)
    case 'total_stock_value':  return yen(p.total_stock_value)
    case 'pending_price_lot_count': return p.pending_price_lot_count
    case 'oldest_lot_date': return p.oldest_lot_date ? ymd(p.oldest_lot_date) : '—'
    default: return '—'
  }
}
