/**
 * SpecCalendarPage — 規格別 日次カレンダー
 * ==========================================
 * 既存 の ロット単位 日次カレンダー と 違い、 行 = 産地 × 規格 で 集約。
 *
 *   ・日付セル = その日 の 増減 の 絶対値 |入荷 - 出庫|
 *   ・hover    = 入荷 / 出庫 / その日 終了時点 の その規格 残高
 *   ・click    = 右パネル に その日 の 入出庫 詳細 (どの lot から 何kg)
 *
 * データ は 既存 /calendar API (ロット単位) を 取得し、 フロントで 産地×規格 集約。
 * 全作物 対応。
 */
import { useMemo, useState } from 'react'
import { useFetch } from '../lib/useFetch'
import { num } from '../lib/format'
import { ErrorBanner, LoadingState } from '../components/StatusDisplay'
import type { CalendarView, CalendarLot } from '../api/types'

const CROPS = [
  { id: 1, name: '生姜' },
  { id: 2, name: '大蒜' },
  { id: 3, name: '長芋' },
  { id: 4, name: '牛蒡' },
  { id: 5, name: '薩摩芋' },
  { id: 12, name: '大蒜(実験)' },
]

function thisMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** 規格 を 短ラベル化 (標準は省略、 '-' は省略) */
function gradeLabel(l: CalendarLot): string {
  const parts: string[] = []
  if (l.spec_type && l.spec_type !== '標準') parts.push(l.spec_type)
  if (l.grade_level && l.grade_level !== '-') parts.push(l.grade_level)
  if (l.size_label && l.size_label !== '-') parts.push(l.size_label)
  return parts.join('') || '標準'
}

function n(v: string | number | null | undefined): number {
  if (v == null || v === '') return 0
  const x = typeof v === 'string' ? Number(v) : v
  return Number.isFinite(x) ? x : 0
}

interface DayCell {
  inbound: number
  outbound: number
  balance: number   // その日 終了時点 の 残高
}

interface SpecRow {
  key: string
  origin: string
  grade: string
  carryover: number
  lots: CalendarLot[]
  days: Record<number, DayCell>   // day(1..31) → cell
  monthInbound: number
  monthOutbound: number
  endBalance: number
}

export default function SpecCalendarPage({
  cropId: fixedCropId, embedded = false,
}: { cropId?: number; embedded?: boolean }) {
  // cropId プロップ が あれば その作物 に固定 (= 作物別ページ)。 無ければ 選択可。
  const [selCropId, setSelCropId] = useState(2)
  const cropId = fixedCropId ?? selCropId
  const setCropId = setSelCropId
  const [month, setMonth] = useState(thisMonth)
  const [selected, setSelected] = useState<{ rowKey: string; day: number } | null>(null)
  const cropName = CROPS.find(c => c.id === cropId)?.name ?? `作物#${cropId}`

  const cal = useFetch<CalendarView>('/calendar', {
    month, crop_id: String(cropId),
  })

  const data = cal.data
  const daysInMonth = data?.days_in_month ?? 31
  const dayList = useMemo(
    () => Array.from({ length: daysInMonth }, (_, i) => i + 1),
    [daysInMonth],
  )

  // 産地 × 規格 で 集約
  const rows: SpecRow[] = useMemo(() => {
    if (!data) return []
    const monthPrefix = month  // 'YYYY-MM'
    const map = new Map<string, SpecRow>()
    for (const lot of data.lots) {
      const grade = gradeLabel(lot)
      const key = `${lot.origin_name}__${grade}`
      let row = map.get(key)
      if (!row) {
        row = {
          key, origin: lot.origin_name, grade,
          carryover: 0, lots: [], days: {},
          monthInbound: 0, monthOutbound: 0, endBalance: 0,
        }
        map.set(key, row)
      }
      row.lots.push(lot)
      row.carryover += n(lot.carryover_kg)
      // 入荷: lot.inbound_date が 当月 なら その日 に 計上
      if (lot.inbound_date && lot.inbound_date.startsWith(monthPrefix)) {
        const d = Number(lot.inbound_date.slice(8, 10))
        const cell = row.days[d] ?? { inbound: 0, outbound: 0, balance: 0 }
        cell.inbound += n(lot.total_kg)
        row.days[d] = cell
      }
      // 出庫: lot.daily
      for (const [dayStr, v] of Object.entries(lot.daily ?? {})) {
        const d = Number(dayStr)
        const cell = row.days[d] ?? { inbound: 0, outbound: 0, balance: 0 }
        cell.outbound += n(v)
        row.days[d] = cell
      }
    }
    // 残高 累積計算 + 月計
    for (const row of map.values()) {
      let bal = row.carryover
      for (const d of dayList) {
        const cell = row.days[d]
        if (cell) {
          bal = bal + cell.inbound - cell.outbound
          cell.balance = bal
          row.monthInbound += cell.inbound
          row.monthOutbound += cell.outbound
        }
      }
      row.endBalance = bal
    }
    return [...map.values()].sort((a, b) =>
      (a.origin + a.grade).localeCompare(b.origin + b.grade),
    )
  }, [data, month, dayList])

  // 選択中 セル の 詳細 (右パネル)
  const detail = useMemo(() => {
    if (!selected) return null
    const row = rows.find(r => r.key === selected.rowKey)
    if (!row) return null
    const day = selected.day
    const inbounds: { lot: string; kg: number }[] = []
    const outbounds: { lot: string; kg: number }[] = []
    for (const lot of row.lots) {
      if (lot.inbound_date && lot.inbound_date.startsWith(month)
          && Number(lot.inbound_date.slice(8, 10)) === day) {
        inbounds.push({ lot: lot.lot_code ?? `#${lot.lot_id}`, kg: n(lot.total_kg) })
      }
      const ob = lot.daily?.[String(day)]
      if (ob) outbounds.push({ lot: lot.lot_code ?? `#${lot.lot_id}`, kg: n(ob) })
    }
    return { row, day, inbounds, outbounds, cell: row.days[day] }
  }, [selected, rows, month])

  const today = new Date()
  const isCurrentMonth = month === thisMonth()

  const Wrapper = embedded
    ? ({ children }: { children: React.ReactNode }) => <div>{children}</div>
    : ({ children }: { children: React.ReactNode }) => <div className="page">{children}</div>

  return (
    <Wrapper>
      {!embedded && (
        <>
          <h2>規格別 日次カレンダー{fixedCropId != null ? ` — ${cropName}` : ''}</h2>
          <p className="muted" style={{ marginTop: 4 }}>
            産地 × 規格 で 集約。 セル = その日の 増減 |入荷−出庫|。
            セルに ポインタ で 入荷/出庫/残高、 クリックで 右パネルに 明細。
          </p>
        </>
      )}

      <div className="card" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        {fixedCropId == null && (
          <label>作物:&nbsp;
            <select value={cropId} onChange={e => { setCropId(Number(e.target.value)); setSelected(null) }}>
              {CROPS.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        )}
        <label>月:&nbsp;
          <input type="month" value={month} onChange={e => { setMonth(e.target.value); setSelected(null) }} />
        </label>
        <button onClick={() => cal.reload()}>再読込</button>
        <span className="muted" style={{ marginLeft: 'auto' }}>{rows.length} 規格</span>
      </div>

      {cal.loading && <LoadingState />}
      <ErrorBanner error={cal.error} style={{ marginTop: 0 }} />

      {data && (
        <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
          {/* カレンダー本体 */}
          <div className="card" style={{ flex: 1, overflowX: 'auto', padding: 0 }}>
            <table style={{ borderCollapse: 'collapse', fontSize: '0.82em', width: '100%' }}>
              <thead>
                <tr style={{ background: '#f4f4f4' }}>
                  <th style={{ position: 'sticky', left: 0, background: '#f4f4f4', padding: '4px 8px', textAlign: 'left', minWidth: 60 }}>産地</th>
                  <th style={{ position: 'sticky', left: 60, background: '#f4f4f4', padding: '4px 8px', textAlign: 'left', minWidth: 90 }}>規格</th>
                  <th style={{ padding: '4px 6px', textAlign: 'right' }}>前月繰越</th>
                  {dayList.map(d => (
                    <th key={d} style={{
                      padding: '4px 3px', textAlign: 'center', minWidth: 26,
                      background: isCurrentMonth && d === today.getDate() ? '#FFF3CD' : undefined,
                    }}>{d}</th>
                  ))}
                  <th style={{ padding: '4px 6px', textAlign: 'right' }}>月末在庫</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.key}>
                    <td style={{ position: 'sticky', left: 0, background: '#fff', padding: '3px 8px' }}>{row.origin}</td>
                    <td style={{ position: 'sticky', left: 60, background: '#fff', padding: '3px 8px', fontWeight: 'bold' }}>{row.grade}</td>
                    <td style={{ padding: '3px 6px', textAlign: 'right', color: '#888' }}>{num(row.carryover, 0)}</td>
                    {dayList.map(d => {
                      const cell = row.days[d]
                      const isSel = selected?.rowKey === row.key && selected?.day === d
                      if (!cell) {
                        return <td key={d} style={{ padding: '3px 3px', borderLeft: '1px solid #f0f0f0' }} />
                      }
                      const net = cell.inbound - cell.outbound
                      const absVal = Math.abs(net)
                      // 色: 入荷優勢=緑、 出庫優勢=赤、 相殺(net=0 だが動きあり)=灰
                      const bg = isSel ? '#cce5ff'
                        : net > 0 ? '#e6f5e6'
                        : net < 0 ? '#fce8e8'
                        : '#f0f0f0'
                      return (
                        <td key={d}
                          onClick={() => setSelected({ rowKey: row.key, day: d })}
                          title={`${row.origin} ${row.grade} — ${month}/${d}\n入荷: ${num(cell.inbound,0)} kg\n出庫: ${num(cell.outbound,0)} kg\n残高: ${num(cell.balance,0)} kg`}
                          style={{
                            padding: '3px 3px', textAlign: 'center', cursor: 'pointer',
                            background: bg, borderLeft: '1px solid #f0f0f0',
                            fontWeight: isSel ? 700 : 400,
                          }}
                        >
                          {absVal > 0 ? num(absVal, 0) : ''}
                        </td>
                      )
                    })}
                    <td style={{ padding: '3px 6px', textAlign: 'right', fontWeight: 'bold' }}>{num(row.endBalance, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 右パネル: 選択日 明細 */}
          {detail && (
            <div className="card" style={{ width: 280, flexShrink: 0, alignSelf: 'flex-start' }}>
              <div style={{ fontWeight: 'bold', fontSize: '1.05em' }}>
                {detail.row.origin} / {detail.row.grade}
              </div>
              <div className="muted" style={{ fontSize: 12 }}>{month}/{detail.day} の 入出庫</div>
              <div style={{ marginTop: 8, fontSize: 13 }}>
                <div>入荷合計: <strong>{num(detail.cell?.inbound ?? 0, 0)} kg</strong></div>
                <div>出庫合計: <strong>{num(detail.cell?.outbound ?? 0, 0)} kg</strong></div>
                <div>当日残高: <strong>{num(detail.cell?.balance ?? 0, 0)} kg</strong></div>
              </div>
              <div style={{ marginTop: 10 }}>
                <div style={{ fontWeight: 'bold', fontSize: 12, color: '#080' }}>入荷 lot</div>
                {detail.inbounds.length === 0 ? <div className="muted" style={{ fontSize: 12 }}>なし</div> : (
                  <ul style={{ margin: '2px 0', paddingLeft: 18, fontSize: 12 }}>
                    {detail.inbounds.map((x, i) => (
                      <li key={i}><code>{x.lot}</code>: {num(x.kg, 0)} kg</li>
                    ))}
                  </ul>
                )}
              </div>
              <div style={{ marginTop: 8 }}>
                <div style={{ fontWeight: 'bold', fontSize: 12, color: '#c00' }}>出庫 lot</div>
                {detail.outbounds.length === 0 ? <div className="muted" style={{ fontSize: 12 }}>なし</div> : (
                  <ul style={{ margin: '2px 0', paddingLeft: 18, fontSize: 12 }}>
                    {detail.outbounds.map((x, i) => (
                      <li key={i}><code>{x.lot}</code>: {num(x.kg, 0)} kg</li>
                    ))}
                  </ul>
                )}
              </div>
              <button onClick={() => setSelected(null)} style={{ marginTop: 8, fontSize: 12 }}>閉じる</button>
            </div>
          )}
        </div>
      )}
    </Wrapper>
  )
}
