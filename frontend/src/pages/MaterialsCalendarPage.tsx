import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useFetch } from '../lib/useFetch'
import { num } from '../lib/format'
import { usePrintMode } from '../lib/printMode'
import RowMenu, { useRowMenu } from '../components/RowMenu'
import type { MaterialCalendar, MaterialCalendarRow } from '../api/types'

function thisMonth(): string {
  return new Date().toISOString().slice(0, 7)
}

/** 今日の年月 (YYYY-MM) と日 */
function todayInfo() {
  const t = new Date()
  return {
    ym: t.toISOString().slice(0, 7),
    day: t.getDate(),
  }
}

// 固定列の幅 (px) — sticky-col の left オフセット計算に使う
const COL_WIDTHS = {
  id: 90,
  name: 220,
  unit: 60,
  carry: 90,
} as const
const LEFT_OFFSETS = {
  id: 0,
  name: COL_WIDTHS.id,
  unit: COL_WIDTHS.id + COL_WIDTHS.name,
  carry: COL_WIDTHS.id + COL_WIDTHS.name + COL_WIDTHS.unit,
} as const

/**
 * 長さ管理資材 (length_per_roll_cm が設定済みの 巻/本) は、
 * 表示単位を「メートル」に切り替える。
 * 値は内部的には「巻」単位なので × length_per_roll_cm / 100 で m に変換。
 */
function rowDisplay(row: MaterialCalendarRow) {
  const lc = row.length_per_roll_cm ? Number(row.length_per_roll_cm) : null
  if (lc && lc > 0) {
    const toMeters = (v: string | number | undefined) =>
      v == null || v === '' ? 0 : (Number(v) * lc) / 100
    return {
      lengthManaged: true,
      unitLabel: 'm',
      transform: toMeters,
    }
  }
  return {
    lengthManaged: false,
    unitLabel: row.unit ?? '',
    transform: (v: string | number | undefined) => v == null || v === '' ? 0 : Number(v),
  }
}

const DIVISION_LABEL: Record<number, string> = {
  0: '未割当', 1: '生姜', 2: '大蒜', 3: '長芋', 4: '牛蒡', 5: '薩摩芋', 6: '物流',
}

export default function MaterialsCalendarPage() {
  const [month, setMonth] = useState(thisMonth())
  const [division, setDivision] = useState<string>('')
  const [categoryFilter, setCategoryFilter] = useState<string>('')
  const [recipeFilter, setRecipeFilter] = useState<'all' | 'has' | 'none'>('all')
  const navigate = useNavigate()
  const menu = useRowMenu<MaterialCalendarRow>()
  const print = usePrintMode()

  const params: Record<string, string> = { month }
  if (division) params.division = division
  const cal = useFetch<MaterialCalendar>('/materials/calendar', params)

  // クライアント側フィルタ (カテゴリ + レシピ登録有無)
  const filteredRows = useMemo<MaterialCalendarRow[]>(() => {
    const all = cal.data?.rows ?? []
    return all.filter((row) => {
      if (categoryFilter === '__none__' && row.category) return false
      if (categoryFilter && categoryFilter !== '__none__' && row.category !== categoryFilter) return false
      if (recipeFilter === 'has' && row.recipe_product_count === 0) return false
      if (recipeFilter === 'none' && row.recipe_product_count > 0) return false
      return true
    })
  }, [cal.data, categoryFilter, recipeFilter])

  // カテゴリ別件数 = 現在の (月 + 事業部 + レシピ) 条件下での件数 (カテゴリフィルタ自体は除外)
  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>()
    let unassignedCount = 0
    for (const row of cal.data?.rows ?? []) {
      if (recipeFilter === 'has' && row.recipe_product_count === 0) continue
      if (recipeFilter === 'none' && row.recipe_product_count > 0) continue
      if (row.category) counts.set(row.category, (counts.get(row.category) ?? 0) + 1)
      else unassignedCount++
    }
    return {
      list: Array.from(counts.entries())
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => a.category.localeCompare(b.category)),
      unassignedCount,
    }
  }, [cal.data, recipeFilter])

  const data = cal.data
  const today = todayInfo()
  const isCurrentMonth = month === today.ym
  const allDays = data
    ? Array.from({ length: data.days_in_month }, (_, i) => i + 1)
    : []
  // 当月なら今日以降の日付列を非表示 (将来日付は埋まっていないため)
  const days = isCurrentMonth ? allDays.filter((d) => d <= today.day) : allDays
  const hiddenDayCount = allDays.length - days.length

  // PDF時の「最新データ」マーキング: latestDay = 入荷 or 出庫があった最新の日
  // 資材にはロット概念が無いので「行を赤く」する規則は適用せず、
  // 日付列のみ赤くする。
  const latestDay = useMemo<number | null>(() => {
    if (!print.isPrintMode || !data) return null
    let latest = 0
    for (const row of filteredRows) {
      for (const [dayStr, qty] of Object.entries(row.daily_in ?? {})) {
        if (!qty || Number(qty) === 0) continue
        const d = Number(dayStr)
        if (d > latest) latest = d
      }
      for (const [dayStr, qty] of Object.entries(row.daily_out ?? {})) {
        if (!qty || Number(qty) === 0) continue
        const d = Number(dayStr)
        if (d > latest) latest = d
      }
    }
    return latest > 0 ? latest : null
  }, [print.isPrintMode, data, filteredRows])

  // 列ごとの合計 (フィルタ後の rows のみ)
  let carrySum = 0, inSum = 0, outSum = 0, endSum = 0
  const dayInTotals: Record<string, number> = {}
  const dayOutTotals: Record<string, number> = {}
  if (data) {
    for (const d of days) {
      dayInTotals[String(d)] = 0
      dayOutTotals[String(d)] = 0
    }
    for (const row of filteredRows) {
      carrySum += Number(row.carryover_qty)
      inSum += Number(row.inbound_qty)
      outSum += Number(row.outbound_qty)
      endSum += Number(row.end_qty)
      for (const d of days) {
        if (row.daily_in[String(d)]) dayInTotals[String(d)] += Number(row.daily_in[String(d)])
        if (row.daily_out[String(d)]) dayOutTotals[String(d)] += Number(row.daily_out[String(d)])
      }
    }
  }

  return (
    <div>
      <h2>資材 日次カレンダー</h2>
      <p className="subtitle">
        資材ごとの日々の入出庫。同日に入荷・出庫が両方あれば別行で表示。
      </p>

      <div className="panel">
        <div className="inline no-print" style={{ marginBottom: 12 }}>
          <div>
            <label>表示月</label>
            <input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              style={{ width: 160 }}
            />
          </div>
          <button
            type="button"
            className="secondary small"
            onClick={print.startPrint}
            style={{ alignSelf: 'flex-end' }}
            title="このカレンダーを PDF 出力 (印刷ダイアログから「PDF として保存」を選択)"
          >📄 PDF出力</button>
          <div>
            <label>事業部</label>
            <select
              value={division}
              onChange={(e) => setDivision(e.target.value)}
              style={{ width: 160 }}
            >
              <option value="">全事業部</option>
              {Object.entries(DIVISION_LABEL).map(([d, n]) => (
                <option key={d} value={d}>{d}: {n}</option>
              ))}
            </select>
          </div>
          {division && (
            <button className="ghost small" onClick={() => setDivision('')}>クリア</button>
          )}
          <div>
            <label>カテゴリ</label>
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              style={{ width: 180 }}
              title="件数は「現在の月・事業部・レシピ絞り込み下での件数」です"
            >
              <option value="">全カテゴリ</option>
              <option value="__none__">
                未分類のみ ({categoryCounts.unassignedCount})
              </option>
              {categoryCounts.list.map((c) => (
                <option key={c.category} value={c.category}>
                  {c.category} ({c.count})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>レシピ登録</label>
            <select
              value={recipeFilter}
              onChange={(e) => setRecipeFilter(e.target.value as typeof recipeFilter)}
              style={{ width: 160 }}
            >
              <option value="all">全て</option>
              <option value="has">登録済 (商品で使用中)</option>
              <option value="none">未登録 (どこでも未使用)</option>
            </select>
          </div>
          {data && (
            <span className="muted">
              {filteredRows.length} / {data.rows.length} 資材 ／ {data.days_in_month} 日間
              {hiddenDayCount > 0 && (
                <span style={{ marginLeft: 8 }}>
                  (未来日 {hiddenDayCount} 日分は非表示)
                </span>
              )}
            </span>
          )}
        </div>

        {cal.error && <div className="alert error">{cal.error}</div>}
        {cal.loading && <div className="muted">読み込み中…</div>}

        {data && filteredRows.length === 0 && data.rows.length > 0 && (
          <div className="muted">この条件に合う資材はありません。</div>
        )}
        {data && filteredRows.length > 0 && (
          <div className="calendar-wrap">
            <table className="calendar">
              <thead>
                <tr>
                  <th className="col-id sticky-col"
                    style={{ left: LEFT_OFFSETS.id,
                             minWidth: COL_WIDTHS.id, maxWidth: COL_WIDTHS.id }}>
                    整理番号
                  </th>
                  <th className="col-name sticky-col"
                    style={{ left: LEFT_OFFSETS.name,
                             minWidth: COL_WIDTHS.name, maxWidth: COL_WIDTHS.name }}>
                    品目
                  </th>
                  <th className="col-date sticky-col"
                    style={{ left: LEFT_OFFSETS.unit,
                             minWidth: COL_WIDTHS.unit, maxWidth: COL_WIDTHS.unit }}>
                    単位
                  </th>
                  <th className="num sticky-col"
                    style={{ left: LEFT_OFFSETS.carry,
                             minWidth: COL_WIDTHS.carry, maxWidth: COL_WIDTHS.carry }}>
                    前月繰越
                  </th>
                  {/* PDF時は 右サマリを 日付列より前に置く (日付列を最右に) */}
                  {!print.isPrintMode && days.map((d) => (
                    <th key={d}
                      className={'num daycol '
                        + (isCurrentMonth && d === today.day ? 'today ' : '')}>
                      {d}
                    </th>
                  ))}
                  <th className="num">当月入荷</th>
                  <th className="num">当月出庫</th>
                  <th className="num">現在在庫</th>
                  {print.isPrintMode && days.map((d) => (
                    <th key={d}
                      className={'num daycol '
                        + (isCurrentMonth && d === today.day ? 'today ' : '')
                        + (latestDay === d ? 'print-latest-col' : '')}>
                      {d}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => {
                  const disp = rowDisplay(row)
                  const dec = disp.lengthManaged ? 2 : 1
                  return (
                    <tr key={row.material_id}
                      onContextMenu={(e) => menu.openAt(e, row)}
                      style={{ cursor: 'context-menu' }}
                    >
                      <td className="col-id sticky-col"
                        style={{ left: LEFT_OFFSETS.id,
                                 minWidth: COL_WIDTHS.id, maxWidth: COL_WIDTHS.id,
                                 overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {row.code}
                      </td>
                      <td className="col-name sticky-col"
                        style={{ left: LEFT_OFFSETS.name,
                                 minWidth: COL_WIDTHS.name, maxWidth: COL_WIDTHS.name,
                                 overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {row.item_name}
                        {disp.lengthManaged && (
                          <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>
                            (1{row.unit} = {num(row.length_per_roll_cm!, 0)} cm)
                          </span>
                        )}
                      </td>
                      <td className="col-date sticky-col"
                        style={{ left: LEFT_OFFSETS.unit,
                                 minWidth: COL_WIDTHS.unit, maxWidth: COL_WIDTHS.unit }}>
                        {disp.lengthManaged
                          ? <span title={`元単位: ${row.unit}`}><strong>m</strong> <span className="muted" style={{ fontSize: 10 }}>({row.unit})</span></span>
                          : (row.unit ?? '')}
                      </td>
                      <td className="num sticky-col"
                        style={{ left: LEFT_OFFSETS.carry,
                                 minWidth: COL_WIDTHS.carry, maxWidth: COL_WIDTHS.carry }}>
                        {num(disp.transform(row.carryover_qty), dec)}
                      </td>
                      {!print.isPrintMode && days.map((d) => {
                        const isToday = isCurrentMonth && d === today.day
                        const din = row.daily_in[String(d)]
                        const dout = row.daily_out[String(d)]
                        if (!din && !dout)
                          return <td key={d} className={'num day ' + (isToday ? 'today' : '')} />
                        return (
                          <td key={d} className={'num day ' + (isToday ? 'today' : '')}>
                            {din && <div className="pos">+{num(disp.transform(din), dec)}</div>}
                            {dout && <div className="neg">{num(disp.transform(dout), dec)}</div>}
                          </td>
                        )
                      })}
                      <td className="num pos">
                        {Number(row.inbound_qty) ? num(disp.transform(row.inbound_qty), dec) : '—'}
                      </td>
                      <td className="num neg">
                        {Number(row.outbound_qty) ? num(disp.transform(row.outbound_qty), dec) : '—'}
                      </td>
                      <td className="num" style={{ fontWeight: 600 }}>
                        {num(disp.transform(row.end_qty), dec)} {disp.unitLabel}
                      </td>
                      {print.isPrintMode && days.map((d) => {
                        const din = row.daily_in[String(d)]
                        const dout = row.daily_out[String(d)]
                        const cls = (latestDay === d ? 'print-latest-col ' : '')
                        if (!din && !dout)
                          return <td key={d} className={'num day ' + cls} />
                        return (
                          <td key={d} className={'num day ' + cls}>
                            {din && <div className="pos">+{num(disp.transform(din), dec)}</div>}
                            {dout && <div className="neg">{num(disp.transform(dout), dec)}</div>}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td className="col-id sticky-col"
                    style={{ left: LEFT_OFFSETS.id, fontWeight: 600,
                             minWidth: COL_WIDTHS.id, maxWidth: COL_WIDTHS.id }}>
                    合計
                  </td>
                  <td className="col-name sticky-col"
                    style={{ left: LEFT_OFFSETS.name,
                             minWidth: COL_WIDTHS.name, maxWidth: COL_WIDTHS.name }} />
                  <td className="col-date sticky-col"
                    style={{ left: LEFT_OFFSETS.unit,
                             minWidth: COL_WIDTHS.unit, maxWidth: COL_WIDTHS.unit }} />
                  <td className="num sticky-col"
                    style={{ left: LEFT_OFFSETS.carry,
                             minWidth: COL_WIDTHS.carry, maxWidth: COL_WIDTHS.carry }}>
                    {num(carrySum, 1)}
                  </td>
                  {!print.isPrintMode && days.map((d) => {
                    const isToday = isCurrentMonth && d === today.day
                    const din = dayInTotals[String(d)]
                    const dout = dayOutTotals[String(d)]
                    if (!din && !dout)
                      return <td key={d} className={'num day ' + (isToday ? 'today' : '')} />
                    return (
                      <td key={d} className={'num day ' + (isToday ? 'today' : '')}>
                        {din > 0 && <div className="pos">+{num(din, 1)}</div>}
                        {dout > 0 && <div className="neg">{num(dout, 1)}</div>}
                      </td>
                    )
                  })}
                  <td className="num pos">{num(inSum, 1)}</td>
                  <td className="num neg">{num(outSum, 1)}</td>
                  <td className="num">{num(endSum, 1)}</td>
                  {print.isPrintMode && days.map((d) => {
                    const din = dayInTotals[String(d)]
                    const dout = dayOutTotals[String(d)]
                    const cls = (latestDay === d ? 'print-latest-col ' : '')
                    if (!din && !dout)
                      return <td key={d} className={'num day ' + cls} />
                    return (
                      <td key={d} className={'num day ' + cls}>
                        {din > 0 && <div className="pos">+{num(din, 1)}</div>}
                        {dout > 0 && <div className="neg">{num(dout, 1)}</div>}
                      </td>
                    )
                  })}
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      <RowMenu<MaterialCalendarRow>
        state={menu.state}
        onClose={menu.close}
        items={(row) => [
          {
            icon: '📋', label: 'レシピ一括編集を開く',
            onClick: () => navigate(`/shipments/recipes/bulk?material_id=${row.material_id}`),
            title: 'この資材を起点に、複数商品のレシピを一括登録/編集',
          },
          {
            icon: '📜', label: '入出庫履歴を見る',
            onClick: () => navigate(`/materials/inbound?material_id=${row.material_id}&focus=history`),
          },
          {
            icon: '📥', label: '入荷/出庫を記録 (新規)',
            onClick: () => navigate(`/materials/inbound?material_id=${row.material_id}`),
          },
          {
            icon: '📦', label: '置き場で棚卸 (レイアウト)',
            onClick: () => navigate('/storage/material'),
          },
          { divider: true,
            icon: '📊', label: '資材一覧で見る (単価/入り数編集など)',
            onClick: () => navigate('/materials'),
            title: '単価・入り数編集・削除は資材一覧画面から',
          },
        ]}
      />
    </div>
  )
}
