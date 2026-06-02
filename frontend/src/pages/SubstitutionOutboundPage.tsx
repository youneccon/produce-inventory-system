/**
 * SubstitutionOutboundPage
 * =========================
 * 振替ロジック付き 商品出庫 入力画面。
 *
 * フロー:
 *   1. 日付 / 産地 / 出庫したい規格 / 数量 / メモ を 入力
 *   2. 「プレビュー」 → サーバー の 振替計算 (priority 1→2→3 フォールバック)
 *      結果 = 「どの lot から 何 kg 引く か」 の 一覧
 *   3. 「確定」 → outbound_orders + outbound_records 作成
 *
 * エラー:
 *   - NO_SUBSTITUTION_RULES → 「マスタ設定 が 未」
 *   - INSUFFICIENT_STOCK → 在庫不足 を 表示 (= ユーザー が マスタ調整 へ 戻る)
 */
import { useState } from 'react'
import { api } from '../api/client'
import { useFetch } from '../lib/useFetch'
import { errorText } from '../lib/format'
import Combobox from '../components/Combobox'
import { useDialog } from '../components/Dialog'
import { GARLIC_CROP_ID } from '../lib/crop'
import { ErrorBanner } from '../components/StatusDisplay'
import type { Grade, Origin } from '../api/types'

interface ConsumptionLine {
  outbound_record_id: number | null
  lot_id: number
  lot_code: string
  priority_used: number
  to_grade_id: number
  to_grade_label: string
  yield_applied: string
  raw_qty_kg: string
  product_qty_covered_kg: string
}

interface SubstitutionResult {
  order_id: number | null
  crop_id: number
  origin_id: number
  from_grade_id: number
  outbound_date: string
  requested_product_kg: string
  covered_product_kg: string
  is_complete: boolean
  lines: ConsumptionLine[]
}

const CROP_ID = GARLIC_CROP_ID  // 大蒜 (固定 — 後で 切替UI 追加可)

function gradeLabel(g: Grade): string {
  return `${g.spec_type}/${g.grade_level || '-'}/${g.size_label || '-'}`
}
function searchableGrade(g: Grade): string {
  return `${g.spec_type} ${g.grade_level} ${g.size_label}`
}

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function SubstitutionOutboundPage() {
  const dialog = useDialog()
  const origins = useFetch<Origin[]>('/masters/origins')
  const grades = useFetch<Grade[]>('/masters/grades')

  const [outboundDate, setOutboundDate] = useState(today)
  const [originId, setOriginId] = useState<number | null>(null)
  const [fromGradeId, setFromGradeId] = useState<number | null>(null)
  const [qty, setQty] = useState<string>('')
  const [note, setNote] = useState<string>('')

  const [preview, setPreview] = useState<SubstitutionResult | null>(null)
  const [executedResult, setExecutedResult] = useState<SubstitutionResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function reset() {
    setPreview(null)
    setExecutedResult(null)
    setError(null)
  }

  async function handlePreview() {
    setError(null); setPreview(null); setExecutedResult(null)
    if (originId == null || fromGradeId == null) { setError('産地 と 規格 を 選択'); return }
    const q = Number(qty)
    if (!Number.isFinite(q) || q <= 0) { setError('数量 を 入力 (> 0)'); return }
    setBusy(true)
    try {
      const r = await api.post<SubstitutionResult>('/substitution/preview', {
        crop_id: CROP_ID, origin_id: originId, from_grade_id: fromGradeId,
        outbound_date: outboundDate, product_qty_kg: q,
      })
      setPreview(r)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleExecute() {
    setError(null)
    if (!preview) return
    if (!preview.is_complete) {
      setError('プレビュー が 不足 状態 — 確定 不可')
      return
    }
    if (!(await dialog.confirm({
      title: '振替出庫 確定',
      message: `確定しますか? ${preview.requested_product_kg}kg を ${preview.lines.length}件 の lot から 引きます`,
      okLabel: '確定',
    }))) return
    setBusy(true)
    try {
      const r = await api.post<SubstitutionResult>('/substitution/execute', {
        crop_id: CROP_ID, origin_id: originId, from_grade_id: fromGradeId,
        outbound_date: outboundDate, product_qty_kg: Number(qty),
        note: note || null,
      })
      setExecutedResult(r)
      setPreview(null)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page">
      <h2>振替出庫 (商品 → 原料 振替計算)</h2>
      <p className="muted" style={{ marginTop: 4 }}>
        商品 規格 を 入れる と 振替ルール (priority 1→2→3) で 在庫 lot から 自動で 引く。
        プレビュー で 確認 → 確定 で outbound_records 作成。
      </p>

      <div className="card" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
        <label>出庫日
          <input type="date" value={outboundDate} onChange={e => { setOutboundDate(e.target.value); reset() }} />
        </label>
        <label>産地
          <select value={originId ?? ''} onChange={e => { setOriginId(e.target.value === '' ? null : Number(e.target.value)); reset() }}>
            <option value="">(選択)</option>
            {(origins.data ?? []).map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>
        <label>出庫したい規格
          <Combobox<Grade>
            items={grades.data ?? []}
            getKey={g => g.id} getLabel={gradeLabel} getSearchText={searchableGrade}
            value={fromGradeId} onChange={v => { setFromGradeId(v == null ? null : Number(v)); reset() }}
          />
        </label>
        <label>数量 (kg)
          <input type="number" step="0.001" min="0" value={qty}
                 onChange={e => { setQty(e.target.value); reset() }} />
        </label>
        <label style={{ gridColumn: '2 / span 2' }}>メモ
          <input type="text" value={note} onChange={e => setNote(e.target.value)} />
        </label>
      </div>

      <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
        <button onClick={handlePreview} disabled={busy}>プレビュー</button>
        <button onClick={handleExecute} disabled={busy || !preview || !preview.is_complete} className="primary">
          確定 (outbound 作成)
        </button>
      </div>

      <ErrorBanner error={error} />

      {preview && <ResultTable result={preview} title="プレビュー (まだ DB に 書込み していません)" />}
      {executedResult && (
        <ResultTable
          result={executedResult}
          title={`✓ 確定済み (order_id=${executedResult.order_id})`}
          highlight
        />
      )}
    </div>
  )
}

function ResultTable({ result, title, highlight }: { result: SubstitutionResult; title: string; highlight?: boolean }) {
  return (
    <div className="card" style={{ marginTop: 8, borderColor: highlight ? '#34a853' : undefined }}>
      <div style={{ fontWeight: 'bold' }}>{title}</div>
      <div style={{ marginTop: 4 }}>
        要求: {result.requested_product_kg} kg / 充足: {result.covered_product_kg} kg
        {result.is_complete ? ' ✓' : ' ⚠ 不足'}
      </div>
      <table style={{ width: '100%', marginTop: 6, borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ background: '#f4f4f4' }}>
            <th>P</th><th>lot</th><th>消化規格</th><th>歩留</th><th>原料 kg</th><th>商品換算 kg</th>
          </tr>
        </thead>
        <tbody>
          {result.lines.map((l, i) => (
            <tr key={i}>
              <td style={{ textAlign: 'center' }}>{l.priority_used}</td>
              <td>{l.lot_code}</td>
              <td>{l.to_grade_label}</td>
              <td style={{ textAlign: 'right' }}>{l.yield_applied}</td>
              <td style={{ textAlign: 'right' }}>{l.raw_qty_kg}</td>
              <td style={{ textAlign: 'right' }}>{l.product_qty_covered_kg}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
