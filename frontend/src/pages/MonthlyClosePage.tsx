import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { useFetch } from '../lib/useFetch'
import { errorText, num, ymd } from '../lib/format'
import type { MonthlyClosePreview, MonthlyCloseResult } from '../api/types'

function thisMonth(): string {
  return new Date().toISOString().slice(0, 7)
}

export default function MonthlyClosePage() {
  const [month, setMonth] = useState(thisMonth())
  const preview = useFetch<MonthlyClosePreview>('/monthly-close/preview', { month })

  // lot_id -> 入力中の実地棚卸数 / 差数原因 / 差数を埋めるか
  const [counts, setCounts] = useState<Record<number, string>>({})
  const [reasons, setReasons] = useState<Record<number, string>>({})
  const [fills, setFills] = useState<Record<number, boolean>>({})
  const [result, setResult] = useState<MonthlyCloseResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // プレビュー取得時に入力欄を初期化（確定済みなら確定値、未確定なら理論値で埋める）
  useEffect(() => {
    if (!preview.data) return
    const c: Record<number, string> = {}
    const r: Record<number, string> = {}
    const f: Record<number, boolean> = {}
    for (const lot of preview.data.lots) {
      c[lot.lot_id] = lot.counted_kg ?? lot.theoretical_kg
      r[lot.lot_id] = lot.note ?? ''
      f[lot.lot_id] = true // デフォルトで差数を埋める
    }
    setCounts(c)
    setReasons(r)
    setFills(f)
    setResult(null)
  }, [preview.data])

  const variance = (lotId: number, theoretical: string): number => {
    const v = counts[lotId]
    if (v === undefined || v === '') return 0
    return Number(v) - Number(theoretical)
  }

  async function submit() {
    if (!preview.data) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const items = preview.data.lots.map((lot) => ({
        lot_id: lot.lot_id,
        counted_kg: Number(counts[lot.lot_id] ?? lot.theoretical_kg),
        reason: reasons[lot.lot_id]?.trim() || null,
        fill_variance: !!fills[lot.lot_id],
      }))
      const res = await api.post<MonthlyCloseResult>('/monthly-close', {
        month,
        items,
      })
      setResult(res)
      preview.reload()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const data = preview.data
  const lastDay = data ? ymd(data.count_date) : ''

  return (
    <div>
      <h2>月次締め</h2>
      <p className="subtitle">
        月末の実地棚卸数を入力して締めます。確定した在庫が翌月の「前月繰越」に。
        差数（実地 − 理論）≠0 の行で「差数を埋める」にチェックすると、
        最終日付の調整 movement（正=出庫追加 / 負=入庫戻し）が自動作成され、
        計算上の在庫が実地と一致します。
      </p>

      {error && <div className="alert error">{error}</div>}
      {result && (
        <div className="alert success">
          {result.month} を締めました（{result.closed_count} ロット）。
          実地合計 {num(result.total_counted_kg, 1)} kg / 理論合計{' '}
          {num(result.total_theoretical_kg, 1)} kg / 差数合計{' '}
          {num(result.total_variance_kg, 1)} kg
          {result.adjustments.length > 0 && (
            <> ／ 調整 movement: {result.adjustments.length}件</>
          )}
        </div>
      )}

      <div className="panel">
        <h3>締め対象月</h3>
        <div className="inline">
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            style={{ width: 160 }}
          />
          {data && (
            <span className="muted">
              棚卸基準日: {lastDay}
              {data.is_closed && (
                <span className="badge ok" style={{ marginLeft: 8 }}>
                  確定済み（再締めで上書き）
                </span>
              )}
            </span>
          )}
        </div>
      </div>

      <div className="panel">
        <h3>棚卸入力</h3>
        {preview.error && <div className="alert error">{preview.error}</div>}
        {preview.loading && <div className="muted">読み込み中…</div>}
        {data && data.lots.length === 0 && (
          <div className="muted">対象ロットがありません。</div>
        )}
        {data && data.lots.length > 0 && (
          <>
            <table>
              <thead>
                <tr>
                  <th className="num">整理番号</th>
                  <th>仕入先</th>
                  <th>規格 / 産地</th>
                  <th>入荷日</th>
                  <th className="num">理論在庫(kg)</th>
                  <th className="num">実地棚卸数(kg)</th>
                  <th className="num">差数</th>
                  <th>差数を埋める</th>
                  <th>差数原因</th>
                </tr>
              </thead>
              <tbody>
                {data.lots.map((lot) => {
                  const v = variance(lot.lot_id, lot.theoretical_kg)
                  const willFill = !!fills[lot.lot_id] && v !== 0
                  const adjQty = -v
                  return (
                    <tr key={lot.lot_id}>
                      <td className="num">{lot.lot_id}</td>
                      <td>{lot.supplier_name}</td>
                      <td>
                        {lot.spec_type} / {lot.origin_name}
                      </td>
                      <td>{ymd(lot.inbound_date)}</td>
                      <td className="num">{num(lot.theoretical_kg, 1)}</td>
                      <td className="num">
                        <input
                          type="number"
                          step="0.0001"
                          style={{ width: 110, textAlign: 'right' }}
                          value={counts[lot.lot_id] ?? ''}
                          onChange={(e) =>
                            setCounts((c) => ({
                              ...c,
                              [lot.lot_id]: e.target.value,
                            }))
                          }
                        />
                      </td>
                      <td
                        className="num"
                        style={{
                          color:
                            v === 0
                              ? 'var(--muted)'
                              : v > 0
                                ? 'var(--ok)'
                                : 'var(--danger)',
                          fontWeight: v === 0 ? 'normal' : 600,
                        }}
                      >
                        {v > 0 ? '+' : ''}
                        {num(v, 1)}
                      </td>
                      <td>
                        {v !== 0 ? (
                          <label
                            className="inline"
                            style={{ fontSize: 12, gap: 4 }}
                          >
                            <input
                              type="checkbox"
                              style={{ width: 'auto' }}
                              checked={!!fills[lot.lot_id]}
                              onChange={(e) =>
                                setFills((f) => ({
                                  ...f,
                                  [lot.lot_id]: e.target.checked,
                                }))
                              }
                            />
                            {willFill && (
                              <span className="muted">
                                {lastDay} に
                                <span
                                  style={{
                                    color:
                                      adjQty > 0
                                        ? 'var(--danger)'
                                        : 'var(--ok)',
                                  }}
                                >
                                  {' '}
                                  {adjQty > 0
                                    ? `+${num(adjQty, 1)} 出庫`
                                    : `${num(-adjQty, 1)} 入庫戻し`}
                                </span>
                              </span>
                            )}
                          </label>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        <input
                          placeholder={v !== 0 ? '原因を入力' : ''}
                          value={reasons[lot.lot_id] ?? ''}
                          onChange={(e) =>
                            setReasons((r) => ({
                              ...r,
                              [lot.lot_id]: e.target.value,
                            }))
                          }
                          style={{
                            borderColor:
                              v !== 0 && !reasons[lot.lot_id]?.trim()
                                ? 'var(--warn)'
                                : undefined,
                          }}
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <div className="spacer" />
            <button onClick={submit} disabled={busy}>
              {busy ? '確定中…' : `${month} を締める（${data.lots.length} ロット）`}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
