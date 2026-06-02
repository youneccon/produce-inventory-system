/**
 * OutboundReportPage
 * ===================
 * 日次 出庫レポート 閲覧 + Excel ダウンロード。
 *
 * 12列構成:
 *   在庫分析 (月単位): 前月繰越 / 重量 / 当月出庫数 / 残高
 *   当日出庫まとめ:   産地名 / 規格名 / 平均単価 / 当日出庫数
 *   商品規格別出荷:   商品規格 / 出荷数 / 小計 / 歩留
 *
 * 表示ロジック:
 *   1 (origin, raw_grade) = 1 グループ。 サブ行 (商品規格 別) があれば 縦結合 表示。
 *   未動アイテム (当日 出庫 0) も 表示 (A〜H のみ)。
 */
import { useState } from 'react'
import { api } from '../api/client'
import { useFetch } from '../lib/useFetch'
import { useDialog } from '../components/Dialog'
import { errorText } from '../lib/format'
import { GARLIC_CROP_ID } from '../lib/crop'
import { ErrorBanner } from '../components/StatusDisplay'

interface SubRow {
  product_grade_label: string
  raw_qty_kg: string
  yield_applied: string
}

interface ReportRow {
  origin_id: number
  origin_name: string
  raw_grade_id: number
  raw_grade_label: string
  prev_kg: string
  weight_kg: string
  month_out_kg: string
  balance_kg: string
  avg_price: string | null
  today_out_kg: string
  sub_rows: SubRow[]
}

interface ReportData {
  target_date: string
  crop_id: number
  crop_name: string
  rows: ReportRow[]
}

const CROP_ID = GARLIC_CROP_ID  // 大蒜 固定

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function fmtKg(s: string | null | undefined): string {
  if (s == null) return ''
  const n = Number(s)
  if (!Number.isFinite(n)) return ''
  return n.toLocaleString('ja-JP', { maximumFractionDigits: 1 })
}

function fmtYen(s: string | null | undefined): string {
  if (s == null) return ''
  const n = Number(s)
  if (!Number.isFinite(n)) return ''
  return '¥' + Math.round(n).toLocaleString('ja-JP')
}

export default function OutboundReportPage() {
  const [targetDate, setTargetDate] = useState(today)
  const dialog = useDialog()
  const report = useFetch<ReportData>(`/report/outbound/${targetDate}`, { crop_id: String(CROP_ID) })

  async function handleDownload() {
    try {
      const blob = await api.blob(`/report/outbound/${targetDate}.xlsx`, { crop_id: CROP_ID })
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = `${targetDate.replaceAll('-', '')}_出庫レポート.xlsx`
      link.click()
      URL.revokeObjectURL(link.href)
    } catch (e) {
      await dialog.alert({
        title: 'ダウンロード失敗',
        message: errorText(e),
        variant: 'danger',
      })
    }
  }

  const data = report.data
  const totalToday = (data?.rows ?? []).reduce((sum, r) => sum + Number(r.today_out_kg || 0), 0)
  const movedRows = (data?.rows ?? []).filter(r => Number(r.today_out_kg || 0) > 0)
  const unmovedRows = (data?.rows ?? []).filter(r => Number(r.today_out_kg || 0) === 0)

  return (
    <div className="page">
      <h2>日次 出庫レポート ({data?.crop_name ?? '読込中'})</h2>

      <div className="card" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <label>日付:&nbsp;
          <input type="date" value={targetDate} onChange={e => setTargetDate(e.target.value)} />
        </label>
        <button onClick={() => report.reload()}>再読込</button>
        <button onClick={handleDownload} className="primary">Excel ダウンロード</button>
        <span className="muted" style={{ marginLeft: 'auto' }}>
          当日出庫 合計: <strong>{totalToday.toLocaleString('ja-JP', { maximumFractionDigits: 1 })} kg</strong>
        </span>
      </div>

      {report.loading && <div className="muted">読み込み中…</div>}
      <ErrorBanner error={report.error} style={{ marginTop: 0 }} />

      {data && (
        <>
          <h3 style={{ marginTop: 12 }}>当日 出庫あり ({movedRows.length} 行)</h3>
          <ReportTable rows={movedRows} />

          <h3 style={{ marginTop: 16 }}>未動アイテム ({unmovedRows.length} 行)</h3>
          <ReportTable rows={unmovedRows} unmoved />
        </>
      )}
    </div>
  )
}


function ReportTable({ rows, unmoved }: { rows: ReportRow[]; unmoved?: boolean }) {
  if (rows.length === 0) return <div className="muted">該当なし</div>
  return (
    <div className="card" style={{ overflowX: 'auto' }}>
      <table className="report-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9em' }}>
        <thead>
          <tr style={{ background: '#E0F0FF' }}>
            <th colSpan={4} style={{ borderBottom: '2px solid #888' }}>在庫分析</th>
            <th colSpan={4} style={{ background: '#FFE8D0', borderBottom: '2px solid #888' }}>当日出庫まとめ</th>
            {!unmoved && <th colSpan={4} style={{ background: '#E8F0D0', borderBottom: '2px solid #888' }}>当日原料規格別商品出荷数</th>}
          </tr>
          <tr style={{ background: '#f4f4f4' }}>
            <th>前月繰越</th><th>重量</th><th>当月出庫数</th><th>残高</th>
            <th>産地名</th><th>規格名</th><th>平均単価</th><th>当日出庫数</th>
            {!unmoved && <><th>規格名</th><th>出荷数</th><th>小計</th><th>歩どまり</th></>}
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const subCount = Math.max(1, r.sub_rows.length)
            const subtotal = r.sub_rows.reduce((s, x) => s + Number(x.raw_qty_kg || 0), 0)
            return r.sub_rows.length > 0 ? (
              r.sub_rows.map((s, idx) => (
                <tr key={`${r.origin_id}-${r.raw_grade_id}-${idx}`}>
                  {idx === 0 && (
                    <>
                      <td rowSpan={subCount} style={{ textAlign: 'right' }}>{fmtKg(r.prev_kg)}</td>
                      <td rowSpan={subCount} style={{ textAlign: 'right' }}>{fmtKg(r.weight_kg)}</td>
                      <td rowSpan={subCount} style={{ textAlign: 'right' }}>{fmtKg(r.month_out_kg)}</td>
                      <td rowSpan={subCount} style={{ textAlign: 'right' }}>{fmtKg(r.balance_kg)}</td>
                      <td rowSpan={subCount}>{r.origin_name}</td>
                      <td rowSpan={subCount}>{r.raw_grade_label}</td>
                      <td rowSpan={subCount} style={{ textAlign: 'right' }}>{fmtYen(r.avg_price)}</td>
                      <td rowSpan={subCount} style={{ textAlign: 'right' }}>{fmtKg(r.today_out_kg)}</td>
                    </>
                  )}
                  {!unmoved && (
                    <>
                      <td>{s.product_grade_label}</td>
                      <td style={{ textAlign: 'right' }}>{fmtKg(s.raw_qty_kg)}</td>
                      {idx === 0 && (
                        <td rowSpan={subCount} style={{ textAlign: 'right' }}>{fmtKg(String(subtotal))}</td>
                      )}
                      <td style={{ textAlign: 'right' }}>{Number(s.yield_applied).toFixed(4)}</td>
                    </>
                  )}
                </tr>
              ))
            ) : (
              <tr key={`${r.origin_id}-${r.raw_grade_id}`}>
                <td style={{ textAlign: 'right' }}>{fmtKg(r.prev_kg)}</td>
                <td style={{ textAlign: 'right' }}>{fmtKg(r.weight_kg)}</td>
                <td style={{ textAlign: 'right' }}>{fmtKg(r.month_out_kg)}</td>
                <td style={{ textAlign: 'right' }}>{fmtKg(r.balance_kg)}</td>
                <td>{r.origin_name}</td>
                <td>{r.raw_grade_label}</td>
                <td style={{ textAlign: 'right' }}>{fmtYen(r.avg_price)}</td>
                <td style={{ textAlign: 'right' }}>{fmtKg(r.today_out_kg)}</td>
                {!unmoved && <><td>—</td><td>—</td><td>—</td><td>—</td></>}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
