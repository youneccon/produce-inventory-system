import { useState } from 'react'
import { useFetch } from '../lib/useFetch'
import { num } from '../lib/format'
import type { ShipmentCalendar, ShipmentDepartment } from '../api/types'

const DIVISION_LABEL: Record<number, string> = {
  1: '生姜', 2: '大蒜', 3: '長芋', 4: '牛蒡', 5: '薩摩芋', 6: '物流',
}

function thisMonth(): string {
  return new Date().toISOString().slice(0, 7)
}

export default function ShipmentsCalendarPage() {
  const [month, setMonth] = useState(thisMonth())
  const [division, setDivision] = useState<string>('')
  const [department, setDepartment] = useState<string>('')

  const departments = useFetch<ShipmentDepartment[]>('/shipments/departments')

  const query: Record<string, string> = { month }
  if (division) query.division = division
  if (department) query.department = department
  const cal = useFetch<ShipmentCalendar>('/shipments/calendar', query)

  const data = cal.data
  const days = data
    ? Array.from({ length: data.days_in_month }, (_, i) => i + 1)
    : []

  // 列ごとの合計
  let monthSum = 0
  const dayTotals: Record<string, number> = {}
  if (data) {
    for (const d of days) dayTotals[String(d)] = 0
    for (const row of data.rows) {
      monthSum += Number(row.month_total)
      for (const d of days) {
        if (row.daily[String(d)]) dayTotals[String(d)] += Number(row.daily[String(d)])
      }
    }
  }

  return (
    <div>
      <h2>商品出荷 日次カレンダー</h2>
      <p className="subtitle">
        商品×日付の出荷数。出荷数に応じて資材は自動的に消耗します
        （資材タブのカレンダーで確認できます）。
      </p>

      <div className="panel">
        <div className="inline" style={{ marginBottom: 12 }}>
          <div>
            <label>表示月</label>
            <input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              style={{ width: 160 }}
            />
          </div>
          <div>
            <label>事業部</label>
            <select value={division} onChange={(e) => setDivision(e.target.value)}
                    style={{ width: 140 }}>
              <option value="">全事業部</option>
              {Object.entries(DIVISION_LABEL).map(([d, n]) => (
                <option key={d} value={d}>{d}: {n}</option>
              ))}
            </select>
          </div>
          <div>
            <label>部署</label>
            <select value={department} onChange={(e) => setDepartment(e.target.value)}
                    style={{ width: 220 }}>
              <option value="">全部署</option>
              {departments.data?.map((d) => (
                <option key={d.department_code} value={d.department_code}>
                  {d.department_code} ({d.shipment_count}件)
                </option>
              ))}
            </select>
          </div>
          {(division || department) && (
            <button className="ghost small" onClick={() => { setDivision(''); setDepartment('') }}>
              絞り込みクリア
            </button>
          )}
          {data && (
            <span className="muted">
              {data.rows.length} 商品 ／ {data.days_in_month} 日間
            </span>
          )}
        </div>

        {cal.error && <div className="alert error">{cal.error}</div>}
        {cal.loading && <div className="muted">読み込み中…</div>}

        {data && data.rows.length > 0 && (
          <div className="calendar-wrap">
            <table className="calendar">
              <thead>
                <tr>
                  <th className="col-id">商品ID</th>
                  <th className="col-name">商品名</th>
                  <th className="col-date">単位</th>
                  {days.map((d) => (
                    <th key={d} className="num daycol">{d}</th>
                  ))}
                  <th className="num">当月出荷</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.product_id}>
                    <td className="col-id num">{row.product_id}</td>
                    <td className="col-name">{row.name}</td>
                    <td className="col-date">{row.unit ?? ''}</td>
                    {days.map((d) => {
                      const v = row.daily[String(d)]
                      if (!v) return <td key={d} className="num day" />
                      return (
                        <td key={d} className="num day" style={{ color: 'var(--primary)' }}>
                          {num(v, 1)}
                        </td>
                      )
                    })}
                    <td className="num" style={{ fontWeight: 600 }}>
                      {num(row.month_total, 1)} {row.unit ?? ''}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td className="col-id" style={{ fontWeight: 600 }}>合計</td>
                  <td className="col-name"></td>
                  <td className="col-date"></td>
                  {days.map((d) => {
                    const t = dayTotals[String(d)]
                    if (!t) return <td key={d} className="num day" />
                    return (
                      <td key={d} className="num day" style={{ color: 'var(--primary)' }}>
                        {num(t, 1)}
                      </td>
                    )
                  })}
                  <td className="num">{num(monthSum, 1)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
