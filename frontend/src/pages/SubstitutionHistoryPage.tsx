/**
 * SubstitutionHistoryPage
 * ========================
 * 振替出庫 履歴 (グループ管理付き)。
 *
 *   ・NR 一括登録 = 1 batch (同一 batch_id の 複数 order を 1 グループ表示)
 *   ・単発 振替出庫 = batch_id なし、 1 order 単独 表示
 *
 * 操作:
 *   ・batch 一括 日付変更 / 一括 キャンセル
 *   ・order 個別 日付変更 / 個別 キャンセル
 *
 * 削除 = outbound_orders + 関連 outbound_records を 物理削除 (= lot 在庫が戻る)。
 */
import { useMemo, useState } from 'react'
import { api } from '../api/client'
import { useFetch } from '../lib/useFetch'
import { useDialog } from '../components/Dialog'
import { errorText } from '../lib/format'
import { GARLIC_CROP_ID } from '../lib/crop'
import { ErrorBanner } from '../components/StatusDisplay'

interface OrderHistory {
  id: number
  crop_id: number
  outbound_date: string
  origin_id: number
  origin_name: string
  from_grade_id: number
  from_grade_label: string
  product_qty_kg: string
  note: string | null
  created_at: string
  batch_id: string | null
  record_count: number
}

interface BatchHistory {
  batch_id: string | null
  outbound_date: string
  crop_id: number
  note: string | null
  created_at: string
  order_count: number
  total_product_kg: string
  total_record_count: number
  orders: OrderHistory[]
}

const CROP_ID = GARLIC_CROP_ID

function fmtKg(s: string | number | null | undefined): string {
  if (s == null || s === '') return ''
  const n = Number(s)
  if (!Number.isFinite(n)) return ''
  return n.toLocaleString('ja-JP', { maximumFractionDigits: 1 })
}

function fmtDateTime(s: string): string {
  if (!s) return ''
  const d = new Date(s)
  if (isNaN(d.getTime())) return s
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export default function SubstitutionHistoryPage() {
  const dialog = useDialog()
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const params = useMemo(() => {
    const p: Record<string, string> = { crop_id: String(CROP_ID) }
    if (dateFrom) p.date_from = dateFrom
    if (dateTo) p.date_to = dateTo
    return p
  }, [dateFrom, dateTo])

  const batches = useFetch<BatchHistory[]>('/substitution/orders', params)

  function bkey(b: BatchHistory): string {
    return b.batch_id ?? `single_${b.orders[0]?.id}`
  }
  function toggleExpand(key: string) {
    setExpanded(prev => {
      const n = new Set(prev)
      if (n.has(key)) n.delete(key); else n.add(key)
      return n
    })
  }

  async function handleBatchCancel(b: BatchHistory) {
    if (!b.batch_id) return
    const ok = await dialog.confirm({
      title: 'バッチ 一括 キャンセル',
      message: `${b.order_count} 注文 (計 ${fmtKg(b.total_product_kg)} kg / ${b.total_record_count} lot 消化) を 削除します。\n紐付く outbound_records が 削除され、 lot 在庫が 戻ります。`,
      variant: 'danger',
      okLabel: '一括 削除',
    })
    if (!ok) return
    try {
      await api.delete(`/substitution/batches/${b.batch_id}`)
      batches.reload()
    } catch (e) {
      setError(errorText(e))
    }
  }

  async function handleBatchDateChange(b: BatchHistory) {
    if (!b.batch_id) return
    const newDate = await dialog.prompt({
      title: 'バッチ出庫日 変更',
      message: `バッチ全体の出庫日を変更します (現: ${b.outbound_date})`,
      defaultValue: b.outbound_date,
      inputType: 'date',
      validate: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) ? null : '日付形式 が 不正 (YYYY-MM-DD)',
    })
    if (!newDate || newDate === b.outbound_date) return
    try {
      await api.patch(`/substitution/batches/${b.batch_id}/date`, { outbound_date: newDate })
      batches.reload()
    } catch (e) {
      setError(errorText(e))
    }
  }

  async function handleOrderCancel(o: OrderHistory) {
    const ok = await dialog.confirm({
      title: '注文 キャンセル',
      message: `${o.origin_name} / ${o.from_grade_label} ${fmtKg(o.product_qty_kg)} kg (${o.record_count} lot 消化) を 削除します。`,
      variant: 'danger',
      okLabel: '削除',
    })
    if (!ok) return
    try {
      await api.delete(`/substitution/orders/${o.id}`)
      batches.reload()
    } catch (e) {
      setError(errorText(e))
    }
  }

  async function handleOrderDateChange(o: OrderHistory) {
    const newDate = await dialog.prompt({
      title: '注文 出庫日 変更',
      message: `注文の出庫日を変更します (現: ${o.outbound_date})`,
      defaultValue: o.outbound_date,
      inputType: 'date',
      validate: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) ? null : '日付形式 が 不正 (YYYY-MM-DD)',
    })
    if (!newDate || newDate === o.outbound_date) return
    try {
      await api.patch(`/substitution/orders/${o.id}/date`, { outbound_date: newDate })
      batches.reload()
    } catch (e) {
      setError(errorText(e))
    }
  }

  return (
    <div className="page">
      <h2>振替出庫 履歴</h2>
      <p className="muted" style={{ marginTop: 4 }}>
        NR 一括登録 (= batch) と 単発 振替出庫 の 履歴。 出庫日 変更 / キャンセル 可能。
      </p>

      <div className="card" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <label>出庫日 (from):&nbsp;
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        </label>
        <label>出庫日 (to):&nbsp;
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
        </label>
        <button onClick={() => batches.reload()}>再読込</button>
        <span style={{ marginLeft: 'auto' }} className="muted">
          {batches.data?.length ?? 0} batch
        </span>
      </div>

      <ErrorBanner error={error} />
      {batches.loading && <div className="muted">読み込み中…</div>}

      {(batches.data ?? []).map(b => {
        const key = bkey(b)
        const isExp = expanded.has(key)
        const isBatch = b.batch_id != null && b.order_count > 1
        return (
          <div key={key} className="card" style={{
            marginTop: 8, padding: 0, overflow: 'hidden',
            border: isBatch ? '1px solid #4a90e2' : '1px solid #ddd',
          }}>
            {/* バッチ ヘッダー */}
            <div style={{
              display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
              padding: '8px 12px',
              background: isBatch ? '#E0F0FF' : '#fafafa',
              borderBottom: isExp ? '1px solid #ddd' : 'none',
              cursor: 'pointer',
            }} onClick={() => toggleExpand(key)}>
              <span style={{ fontSize: '1.1em' }}>{isExp ? '▼' : '▶'}</span>
              <span style={{ fontWeight: 'bold' }}>
                {isBatch ? '🔗 NR 一括 ' : '📦 単発 '}
                {b.outbound_date}
              </span>
              <span className="muted">{fmtDateTime(b.created_at)}</span>
              <span>注文: <strong>{b.order_count}</strong></span>
              <span>合計: <strong>{fmtKg(b.total_product_kg)} kg</strong></span>
              <span>lot 消化: <strong>{b.total_record_count}</strong></span>
              {b.note && <span className="muted" style={{ fontStyle: 'italic' }}>「{b.note}」</span>}

              <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                {isBatch && (
                  <>
                    <button onClick={e => { e.stopPropagation(); handleBatchDateChange(b) }} style={{ fontSize: '0.9em' }}>
                      日付一括変更
                    </button>
                    <button onClick={e => { e.stopPropagation(); handleBatchCancel(b) }} className="danger" style={{ fontSize: '0.9em' }}>
                      一括 キャンセル
                    </button>
                  </>
                )}
              </span>
            </div>

            {/* 展開: order 一覧 */}
            {isExp && (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9em' }}>
                <thead>
                  <tr style={{ background: '#f4f4f4' }}>
                    <th style={{ padding: '6px 8px', textAlign: 'left' }}>order_id</th>
                    <th style={{ padding: '6px 8px', textAlign: 'left' }}>出庫日</th>
                    <th style={{ padding: '6px 8px', textAlign: 'left' }}>産地</th>
                    <th style={{ padding: '6px 8px', textAlign: 'left' }}>商品規格</th>
                    <th style={{ padding: '6px 8px', textAlign: 'right' }}>kg</th>
                    <th style={{ padding: '6px 8px', textAlign: 'right' }}>lot 消化</th>
                    <th style={{ padding: '6px 8px', textAlign: 'right' }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {b.orders.map(o => (
                    <tr key={o.id} style={{ borderTop: '1px solid #eee' }}>
                      <td style={{ padding: '6px 8px' }}><code>#{o.id}</code></td>
                      <td style={{ padding: '6px 8px' }}>{o.outbound_date}</td>
                      <td style={{ padding: '6px 8px' }}>{o.origin_name}</td>
                      <td style={{ padding: '6px 8px' }}>{o.from_grade_label}</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmtKg(o.product_qty_kg)}</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right' }}>{o.record_count}</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                        <button onClick={() => handleOrderDateChange(o)} style={{ fontSize: '0.85em', marginRight: 4 }}>
                          日付変更
                        </button>
                        <button onClick={() => handleOrderCancel(o)} className="danger" style={{ fontSize: '0.85em' }}>
                          削除
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )
      })}

      {!batches.loading && (batches.data?.length ?? 0) === 0 && (
        <div className="muted" style={{ marginTop: 16 }}>履歴なし (= 振替出庫 登録 0 件)</div>
      )}
    </div>
  )
}
