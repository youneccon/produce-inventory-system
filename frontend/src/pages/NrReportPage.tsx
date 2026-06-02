/**
 * NrReportPage
 * =============
 * NR 原材料使用計算レポート の Web 化。
 *
 * フロー (1 step):
 *   1. 「商品期間集計」 Excel (.xlsx) を アップロード
 *   2. 自動 で BOM 展開 + 振替シミュレーション (preview) → 結果表 表示
 *      列: 産地名 / 規格名 / 平均単価 / 当日出庫数 / 残在庫 / 規格名 / 出荷数 / 小計 / 歩どまり
 *   3. 「確定 → 一括登録」 で outbound_records 作成
 */
import { useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../api/client'
import { useDialog } from '../components/Dialog'
import { errorText } from '../lib/format'
import { GARLIC_CROP_ID } from '../lib/crop'
import { ErrorBanner } from '../components/StatusDisplay'

interface AggRow {
  origin_id: number | null
  origin_text: string
  raw_grade_id: number | null
  raw_grade_label: string
  total_kg: string
}

interface BulkConsumption {
  lot_id: number
  lot_code: string
  priority_used: number
  to_grade_id: number
  to_grade_label: string
  yield_applied: string
  raw_qty_kg: string
  product_qty_covered_kg: string
}

interface BulkLineResult {
  row_index: number
  label: string | null
  origin_id: number
  from_grade_id: number
  product_qty_kg: string
  order_id: number | null
  consumption_count: number
  consumptions: BulkConsumption[]
  covered_product_kg: string | null
  is_complete: boolean
  error: string | null
}

interface GroupSummary {
  origin_id: number
  to_grade_id: number
  avg_unit_price: string | null
  remaining_after_kg: string
}

interface BulkExecuteResult {
  total_rows: number
  success_rows: number
  failed_rows: number
  lines: BulkLineResult[]
  group_summaries: GroupSummary[]
}

interface WarningRow {
  excel_row: number
  code: string
  name: string | null
  total_kg: string
  reason: string
}

interface NrResult {
  input_rows: number
  processed_rows: number
  warning_rows: number
  grand_total_kg: string
  rows: AggRow[]
  warnings: WarningRow[]
}

const CROP_ID = GARLIC_CROP_ID

function fmtKg(s: string | null | undefined): string {
  if (s == null) return ''
  const n = Number(s)
  if (!Number.isFinite(n)) return ''
  return n.toLocaleString('ja-JP', { maximumFractionDigits: 1 })
}

function fmtYen(s: string | null | undefined): string {
  if (s == null || s === '') return ''
  const n = Number(s)
  if (!Number.isFinite(n)) return ''
  return '¥' + Math.round(n).toLocaleString('ja-JP')
}

function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function NrReportPage() {
  const dialog = useDialog()
  const fileRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [result, setResult] = useState<NrResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const title = '原材料使用計算'  // (Excel ダウンロード時 の タイトル、 現状 固定)

  // 振替出庫 一括登録 用
  const [outboundDate, setOutboundDate] = useState(todayStr)
  const [outboundNote, setOutboundNote] = useState('')
  const [previewResult, setPreviewResult] = useState<BulkExecuteResult | null>(null)
  const [bulkResult, setBulkResult] = useState<BulkExecuteResult | null>(null)

  function reset() {
    setResult(null); setError(null); setPreviewResult(null); setBulkResult(null)
  }

  async function handleUpload() {
    setError(null); setResult(null); setPreviewResult(null); setBulkResult(null)
    if (!file) { setError('ファイルを選択'); return }
    setBusy(true)
    try {
      // Step 1: Excel 取込 → BOM 展開
      const fd = new FormData()
      fd.append('file', file)
      const json = await api.upload<NrResult>('/nr-report/expand', fd, { crop_id: CROP_ID })
      setResult(json)

      // Step 2: 振替シミュレーション (自動 chain)
      const eligible = json.rows.filter(r => r.origin_id != null && r.raw_grade_id != null)
      if (eligible.length > 0) {
        const body = buildBulkBodyFrom(json, outboundDate, outboundNote)
        const previewR = await api.post<BulkExecuteResult>('/nr-report/preview-as-outbound', body!)
        setPreviewResult(previewR)
      }
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  function buildBulkBodyFrom(r: NrResult, date: string, note: string) {
    const eligible = r.rows.filter(x => x.origin_id != null && x.raw_grade_id != null)
    if (eligible.length === 0) return null
    return {
      crop_id: CROP_ID,
      outbound_date: date,
      note: note || null,
      rows: eligible.map(x => ({
        origin_id: x.origin_id,
        from_grade_id: x.raw_grade_id,
        product_qty_kg: Number(x.total_kg),
        label: `${x.origin_text} / ${x.raw_grade_label}`,
      })),
    }
  }

  /** Pydantic 422 を 日本語 の 読める メッセージ に 変換。
   *  典型例: product_qty_kg < 0 (Excel に 返品 / 取消 行 が 紛れ込み)。 */
  function friendlyError(e: unknown): string {
    if (e instanceof ApiError && Array.isArray(e.detail)) {
      const lines = (e.detail as Array<Record<string, unknown>>).map(d => {
        const loc = Array.isArray(d.loc) ? d.loc.join('.') : ''
        const input = d.input
        if (typeof loc === 'string' && loc.includes('product_qty_kg')) {
          return `Excel に 数量 ${input ?? '?'} kg の 行 が 含まれて います。 ` +
                 `振替出庫 は 正の 数量 (> 0) のみ 対応 です。 ` +
                 `返品 ・ 取消 行 を 除去 して 再アップロード してください。`
        }
        return `${loc}: ${d.msg ?? ''}${input != null ? ` (値=${input})` : ''}`
      })
      return lines.join(' / ')
    }
    return errorText(e)
  }

  function buildBulkBody() {
    return result ? buildBulkBodyFrom(result, outboundDate, outboundNote) : null
  }

  async function handleBulkPreview() {
    // 出庫日 / メモ 変更時 に 手動 再実行 (アップロード時は handleUpload で 自動 chain)
    setError(null); setPreviewResult(null); setBulkResult(null)
    const body = buildBulkBody()
    if (!body) { setError('対象行なし (アップロード or 全マスタ未解決)'); return }
    setBusy(true)
    try {
      const r = await api.post<BulkExecuteResult>('/nr-report/preview-as-outbound', body)
      setPreviewResult(r)
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  // 出庫日 が 変わったら プレビュー も 再実行 (in-place)
  useEffect(() => {
    if (!result) return
    if (busy) return
    // 既に previewResult が ある (= 初回 後) ときだけ 再実行
    if (!previewResult) return
    void handleBulkPreview()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outboundDate])

  async function handleBulkExecute() {
    setError(null); setBulkResult(null)
    if (!previewResult) { setError('まず プレビュー を 実行'); return }
    if (previewResult.failed_rows > 0) {
      setError(`プレビューで ${previewResult.failed_rows} 行 失敗 — 確定不可 (在庫/ルール を 修正後 再プレビュー)`)
      return
    }
    const body = buildBulkBody()
    if (!body) return
    const totalConsumptions = previewResult.lines.reduce((s, l) => s + l.consumption_count, 0)
    if (!(await dialog.confirm({
      title: '振替出庫 一括登録 確認',
      message: `${previewResult.success_rows} 行 × 計 ${totalConsumptions} lot 消化 を 確定します。\n(${outboundDate} 付け で outbound_records を 一括作成)`,
      okLabel: '一括登録 実行',
    }))) return

    setBusy(true)
    try {
      const r = await api.post<BulkExecuteResult>('/nr-report/execute-as-outbound', body)
      setBulkResult(r)
      setPreviewResult(null)
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleDownload() {
    if (!file) { setError('ファイル を 再選択 (= 同じ ファイル を 再アップロード)'); return }
    setBusy(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const blob = await api.postBlob('/nr-report/export.xlsx', fd, { crop_id: CROP_ID, title })
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = `NR_${title.replace(/\s+/g, '_')}_${new Date().toISOString().slice(0,10)}.xlsx`
      link.click()
      URL.revokeObjectURL(link.href)
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page">
      <h2>NR 原材料使用計算レポート</h2>
      <p className="muted" style={{ marginTop: 4 }}>
        商品期間集計 .xlsx を アップロード → BOM 突合 + 配合展開 → 産地×規格 単位 で 原材料使用量 を 集計。
      </p>

      <div className="card">
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 2fr', gap: 8, alignItems: 'end' }}>
          <label>商品期間集計 .xlsx
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={e => { setFile(e.target.files?.[0] ?? null); reset() }}
            />
          </label>
          <label>出庫日
            <input type="date" value={outboundDate} onChange={e => setOutboundDate(e.target.value)} />
          </label>
          <label>メモ
            <input type="text" value={outboundNote} onChange={e => setOutboundNote(e.target.value)}
                   placeholder="例: 5月期間 NR 集計 反映" />
          </label>
        </div>
        <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
          <button onClick={handleUpload} disabled={busy || !file}>
            読み込み + 振替計算
          </button>
          <button
            onClick={handleBulkExecute}
            disabled={busy || !previewResult || previewResult.failed_rows > 0}
            className="primary"
          >
            確定 → 一括登録
          </button>
          <button onClick={handleDownload} disabled={busy || !file} style={{ marginLeft: 'auto' }}>
            合計表 Excel ダウンロード
          </button>
        </div>
        <div style={{ marginTop: 4 }} className="muted">
          ※ アップロード で 自動的に BOM 展開 + 振替シミュレーション。
          失敗 0 件 なら 「確定」 で outbound_records を 一括作成 (在庫不足は 全ロールバック)。
        </div>
      </div>

      <ErrorBanner error={error} />

      {result && (
        <>
          {/* メタ情報 + 警告 */}
          <div className="card" style={{ marginTop: 8 }}>
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
              <span>入力: <strong>{result.input_rows}</strong> 行</span>
              <span>処理: <strong>{result.processed_rows}</strong></span>
              <span style={{ color: result.warning_rows > 0 ? '#c00' : undefined }}>
                警告: <strong>{result.warning_rows}</strong>
              </span>
              <span>合計: <strong>{fmtKg(result.grand_total_kg)} kg</strong></span>
              <details style={{ marginLeft: 'auto' }}>
                <summary style={{ cursor: 'pointer', color: '#666' }}>BOM 展開 合計表 を見る</summary>
                <div style={{ marginTop: 8, overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9em' }}>
                    <thead>
                      <tr style={{ background: '#E0F0FF' }}>
                        <th>#</th><th>産地</th><th>原料規格</th><th style={{ textAlign: 'right' }}>使用量 (kg)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.rows.map((r, i) => (
                        <tr key={i}>
                          <td style={{ textAlign: 'center' }}>{i + 1}</td>
                          <td>{r.origin_text}</td>
                          <td>{r.raw_grade_label}</td>
                          <td style={{ textAlign: 'right' }}>{fmtKg(r.total_kg)}</td>
                        </tr>
                      ))}
                      <tr style={{ background: '#FFFBE6', fontWeight: 'bold' }}>
                        <td colSpan={3} style={{ textAlign: 'right' }}>合計</td>
                        <td style={{ textAlign: 'right' }}>{fmtKg(result.grand_total_kg)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </details>
            </div>
          </div>

          {result.warnings.length > 0 && (
            <div className="card" style={{ marginTop: 8, background: '#FFE8E8' }}>
              <div style={{ fontWeight: 'bold', color: '#c00' }}>⚠ 警告 ({result.warnings.length} 件)</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9em', marginTop: 4 }}>
                <thead>
                  <tr><th>行</th><th>商品コード</th><th>品名</th><th>kg</th><th>理由</th></tr>
                </thead>
                <tbody>
                  {result.warnings.map((w, i) => (
                    <tr key={i}>
                      <td style={{ textAlign: 'center' }}>{w.excel_row}</td>
                      <td>{w.code}</td>
                      <td>{w.name}</td>
                      <td style={{ textAlign: 'right' }}>{fmtKg(w.total_kg)}</td>
                      <td>{w.reason === 'not_in_bom' ? '未登録 (BOM に 無い)' : 'マスタ未解決'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {previewResult && (
            <PreviewSection result={previewResult} title="🔍 振替シミュレーション 結果 (まだ DB に 書込み していません)" />
          )}

          {bulkResult && (
            <PreviewSection result={bulkResult} title={`✓ 振替出庫 完了 (${bulkResult.success_rows} 成功 / ${bulkResult.failed_rows} 失敗 / 計 ${bulkResult.total_rows} 行)`} executed />
          )}
        </>
      )}
    </div>
  )
}


/** NR 一括振替 プレビュー/結果 を Excel 「出庫レポート」 と 同じ レイアウト で 表示。
 *
 *  ┌──────────────── 当日出庫まとめ ────────────────┐┌──────── 当日原料規格別商品出荷数 ────────┐
 *  │ 産地名 │ 規格名 │ 当日出庫数 │ ──────────────│ 規格名  │ 出荷数 │ 小計 │ 歩どまり │
 *  │  (1 raw_grade = 1 行、 1 raw → N 商品規格 で 縦結合)                                  │
 */
function PreviewSection({ result, title, executed }: { result: BulkExecuteResult; title: string; executed?: boolean }) {
  // group_summaries を (origin, to_grade) → {avg_price, remaining_after} に
  const summaryMap = new Map<string, { avg_price: number | null; remaining_after: number }>()
  for (const gs of result.group_summaries || []) {
    summaryMap.set(`${gs.origin_id}_${gs.to_grade_id}`, {
      avg_price: gs.avg_unit_price != null ? Number(gs.avg_unit_price) : null,
      remaining_after: Number(gs.remaining_after_kg),
    })
  }

  // (origin, to_grade) で グループ化 → 各 グループ内 で from_grade (= NR 規格 = 振替前 商品規格) 別
  type Group = {
    origin_id: number
    origin_text: string
    to_grade_id: number
    to_grade_label: string
    today_total_raw_kg: number
    today_total_product_kg: number
    avg_unit_price: number | null
    remaining_after_kg: number
    sub_rows: {
      from_grade_only: string
      product_kg: number
      raw_kg: number
      yield: number
    }[]
    lot_codes: string[]
  }
  const groupMap = new Map<string, Group>()
  for (const l of result.lines) {
    if (l.error) continue
    for (const c of l.consumptions) {
      const key = `${l.origin_id}_${c.to_grade_id}`
      let g = groupMap.get(key)
      if (!g) {
        const [originPart] = (l.label || '').split(' / ')
        const s = summaryMap.get(key)
        g = {
          origin_id: l.origin_id,
          origin_text: originPart || '',
          to_grade_id: c.to_grade_id,
          to_grade_label: c.to_grade_label,
          today_total_raw_kg: 0,
          today_total_product_kg: 0,
          avg_unit_price: s?.avg_price ?? null,
          remaining_after_kg: s?.remaining_after ?? 0,
          sub_rows: [],
          lot_codes: [],
        }
        groupMap.set(key, g)
      }
      const fromOnly = (l.label || '').split(' / ').slice(1).join(' / ')
      const rawKg = Number(c.raw_qty_kg || 0)
      const prodKg = Number(c.product_qty_covered_kg || 0)
      const yieldThis = Number(c.yield_applied || 1)
      g.today_total_raw_kg += rawKg
      g.today_total_product_kg += prodKg
      // 同一 (origin, to_grade, from_grade) は 1 行 に マージ。 複数ロット に 跨いだ
      // 引き当て でも 表示上 は 「秋田県 泥L → 加工品 140kg」 と 1 行 になる。
      //  - product_kg / raw_kg は SUM
      //  - yield は 加重平均 (重み = raw_kg)
      //  - lot_codes は 配列 で 保持 (toolTip 等 で 後日 利用可)
      const existing = g.sub_rows.find(sr => sr.from_grade_only === fromOnly)
      if (existing) {
        const newRaw = existing.raw_kg + rawKg
        const weighted = existing.yield * existing.raw_kg + yieldThis * rawKg
        existing.product_kg += prodKg
        existing.raw_kg = newRaw
        existing.yield = newRaw > 0 ? weighted / newRaw : existing.yield
      } else {
        g.sub_rows.push({
          from_grade_only: fromOnly,
          product_kg: prodKg,
          raw_kg: rawKg,
          yield: yieldThis,
        })
      }
      if (!g.lot_codes.includes(c.lot_code)) g.lot_codes.push(c.lot_code)
    }
  }
  const groups = [...groupMap.values()].sort((a, b) =>
    (a.origin_text + a.to_grade_label).localeCompare(b.origin_text + b.to_grade_label),
  )

  // 失敗行
  const failedLines = result.lines.filter(l => l.error != null)

  // 全合計
  const grandTotalRaw = groups.reduce((s, g) => s + g.today_total_raw_kg, 0)
  const grandTotalProduct = groups.reduce((s, g) => s + g.today_total_product_kg, 0)
  const totalSubRows = groups.reduce((s, g) => s + g.sub_rows.length, 0)

  return (
    <>
      <h3 style={{ marginTop: 12, color: result.failed_rows === 0 ? '#080' : '#c00' }}>{title}</h3>
      <div className="card">
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <span><strong>成功:</strong> {result.success_rows} 行</span>
          <span style={{ color: result.failed_rows > 0 ? '#c00' : undefined }}>
            <strong>失敗:</strong> {result.failed_rows} 行
          </span>
          <span><strong>原料消費 (左):</strong> {grandTotalRaw.toLocaleString('ja-JP', { maximumFractionDigits: 1 })} kg</span>
          <span><strong>商品出荷 (右):</strong> {grandTotalProduct.toLocaleString('ja-JP', { maximumFractionDigits: 1 })} kg</span>
        </div>
      </div>

      {/* 失敗 行 (= 在庫不足 / ルール未設定) */}
      {failedLines.length > 0 && (
        <div className="card" style={{ marginTop: 8, background: '#FFE8E8' }}>
          <div style={{ fontWeight: 'bold', color: '#c00' }}>⚠ 失敗 {failedLines.length} 行</div>
          <ul style={{ marginTop: 4 }}>
            {failedLines.map(l => (
              <li key={l.row_index}>{l.label} ({fmtKg(l.product_qty_kg)} kg): {l.error}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Excel 風 出庫レポート レイアウト */}
      {groups.length > 0 && (
        <div className="card" style={{ marginTop: 8, overflowX: 'auto', padding: 0 }}>
          <table className="nr-preview-table" style={{
            width: '100%', borderCollapse: 'collapse', fontSize: '0.92em',
            tableLayout: 'fixed',
          }}>
            <colgroup>
              {/* LEFT: 当日出庫まとめ (5 cols) */}
              <col style={{ width: '8%' }} />   {/* 産地名 */}
              <col style={{ width: '11%' }} />  {/* 規格名 (raw) */}
              <col style={{ width: '10%' }} />  {/* 平均単価 */}
              <col style={{ width: '11%' }} />  {/* 当日出庫数 (強調) */}
              <col style={{ width: '11%' }} />  {/* 残在庫 */}
              {/* RIGHT: 当日原料規格別商品出荷数 (4 cols) */}
              <col style={{ width: '11%' }} />  {/* 規格名 (product) */}
              <col style={{ width: '11%' }} />  {/* 出荷数 (強調) */}
              <col style={{ width: '11%' }} />  {/* 小計 */}
              <col style={{ width: '8%' }} />   {/* 歩どまり */}
              {executed && <col style={{ width: '8%' }} />}
            </colgroup>
            <thead>
              <tr>
                <th colSpan={5} style={{
                  background: '#FFE8D0', borderBottom: '2px solid #888',
                  padding: '6px 8px', textAlign: 'left',
                }}>当日出庫まとめ</th>
                <th colSpan={4} style={{
                  background: '#E8F0D0', borderBottom: '2px solid #888',
                  padding: '6px 8px', textAlign: 'left',
                }}>当日原料規格別商品出荷数</th>
                {executed && <th rowSpan={2} style={{ background: '#f4f4f4', padding: '6px 8px' }}>消化 lot</th>}
              </tr>
              <tr style={{ background: '#f4f4f4' }}>
                <th style={{ padding: '6px 8px', textAlign: 'left' }}>産地名</th>
                <th style={{ padding: '6px 8px', textAlign: 'left' }}>規格名</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>平均単価</th>
                <th style={{ padding: '6px 8px', textAlign: 'right', background: '#FFD8A8' }}>当日出庫数</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>残在庫</th>
                <th style={{ padding: '6px 8px', textAlign: 'left' }}>規格名</th>
                <th style={{ padding: '6px 8px', textAlign: 'right', background: '#D4E8B0' }}>出荷数</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>小計</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>歩どまり</th>
              </tr>
            </thead>
            <tbody>
              {groups.map(g => {
                const span = g.sub_rows.length
                return g.sub_rows.map((sr, idx) => {
                  const cellStyle = { padding: '6px 8px', borderTop: '1px solid #eee' }
                  const numStyle = { ...cellStyle, textAlign: 'right' as const }
                  const groupCellStyle = {
                    ...cellStyle, verticalAlign: 'middle' as const,
                    borderTop: idx === 0 ? '1px solid #999' : '1px solid #eee',
                  }
                  const groupNumStyle = { ...groupCellStyle, textAlign: 'right' as const }
                  // 強調 セル (当日出庫数 / 出荷数)
                  const emphasisOut = { ...groupNumStyle, background: '#FFF4E0', fontWeight: 'bold' as const }
                  const emphasisShip = { ...numStyle, background: '#F0F8E0', fontWeight: 'bold' as const }
                  return (
                    <tr key={`${g.origin_id}-${g.to_grade_id}-${idx}`}>
                      {idx === 0 && (
                        <>
                          <td rowSpan={span} style={groupCellStyle}>{g.origin_text}</td>
                          <td rowSpan={span} style={{ ...groupCellStyle, fontWeight: 'bold' }}>{g.to_grade_label}</td>
                          <td rowSpan={span} style={groupNumStyle}>
                            {g.avg_unit_price != null ? fmtYen(String(g.avg_unit_price)) : '—'}
                          </td>
                          <td rowSpan={span} style={emphasisOut}>{fmtKg(String(g.today_total_raw_kg))}</td>
                          <td rowSpan={span} style={groupNumStyle}>{fmtKg(String(g.remaining_after_kg))}</td>
                        </>
                      )}
                      <td style={cellStyle}>{sr.from_grade_only}</td>
                      <td style={emphasisShip}>{fmtKg(String(sr.product_kg))}</td>
                      {idx === 0 && (
                        <td rowSpan={span} style={groupNumStyle}>{fmtKg(String(g.today_total_product_kg))}</td>
                      )}
                      <td style={numStyle}>{sr.yield.toFixed(4)}</td>
                      {executed && idx === 0 && (
                        <td rowSpan={span} style={{ ...groupCellStyle, fontSize: '0.85em', color: '#666' }}>
                          {g.lot_codes.join(', ')}
                        </td>
                      )}
                    </tr>
                  )
                })
              })}
              {/* 合計行 */}
              <tr style={{ background: '#FFFBE6', fontWeight: 'bold', borderTop: '2px solid #888' }}>
                <td colSpan={3} style={{ padding: '6px 8px', textAlign: 'right' }}>合計</td>
                <td style={{ padding: '6px 8px', textAlign: 'right', background: '#FFE8C8' }}>
                  {fmtKg(String(grandTotalRaw))}
                </td>
                <td style={{ padding: '6px 8px', textAlign: 'right', color: '#666' }}>—</td>
                <td style={{ padding: '6px 8px', textAlign: 'right', color: '#666' }}>{totalSubRows} 件</td>
                <td style={{ padding: '6px 8px', textAlign: 'right', background: '#E0F0C8' }}>
                  {fmtKg(String(grandTotalProduct))}
                </td>
                <td style={{ padding: '6px 8px', textAlign: 'right', color: '#666' }}>—</td>
                <td style={{ padding: '6px 8px', textAlign: 'right' }}>—</td>
                {executed && <td style={{ padding: '6px 8px' }}>—</td>}
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
