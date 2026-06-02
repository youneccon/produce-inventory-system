/**
 * SubstitutionRulesPage
 * ======================
 * 振替ルール マスタ管理画面。
 *
 * 1 行 = (作物 × 産地 × from_grade × priority) → to_grade + yield
 * 同じ from_grade に対して priority 1/2/3 の 3 行 を 並べる。
 * 入力 は Combobox で 検索式 (50 件 超 対応)。
 *
 * 振替出庫 計算 で この マスタ を 参照 する (priority 1 から フォールバック)。
 */
import { useMemo, useState } from 'react'
import { api } from '../api/client'
import { useFetch } from '../lib/useFetch'
import { errorText } from '../lib/format'
import Combobox from '../components/Combobox'
import { useDialog } from '../components/Dialog'
import { GARLIC_CROP_ID, GINGER_CROP_ID } from '../lib/crop'
import { ErrorBanner } from '../components/StatusDisplay'
import type { Grade, Origin } from '../api/types'

interface Rule {
  id: number
  crop_id: number
  origin_id: number
  origin_name: string
  from_grade_id: number
  from_grade_label: string
  priority: number
  to_grade_id: number
  to_grade_label: string
  yield_factor: string
  is_active: boolean
  note: string | null
}

const CROP_LIST = [
  { id: GARLIC_CROP_ID, name: '大蒜' },
  { id: GINGER_CROP_ID, name: '生姜' },
]

function gradeLabel(g: Grade): string {
  return `${g.spec_type}/${g.grade_level || '-'}/${g.size_label || '-'}`
}

function searchableGrade(g: Grade): string {
  return `${g.spec_type} ${g.grade_level} ${g.size_label}`
}

export default function SubstitutionRulesPage() {
  const dialog = useDialog()
  const [cropId, setCropId] = useState<number>(GARLIC_CROP_ID)
  const [showInactive, setShowInactive] = useState(false)
  const [filterOriginId, setFilterOriginId] = useState<number | null>(null)
  const [filterFromGradeId, setFilterFromGradeId] = useState<number | null>(null)

  const origins = useFetch<Origin[]>('/masters/origins')
  const grades = useFetch<Grade[]>('/masters/grades')   // 全 grade (商品/原料 区別なし)
  const rules = useFetch<Rule[]>('/substitution/rules', {
    crop_id: String(cropId),
    ...(filterOriginId != null ? { origin_id: String(filterOriginId) } : {}),
    ...(filterFromGradeId != null ? { from_grade_id: String(filterFromGradeId) } : {}),
    include_inactive: showInactive ? 'true' : 'false',
  })

  // 新規 追加 用 入力
  const [newOriginId, setNewOriginId] = useState<number | null>(null)
  const [newFromGradeId, setNewFromGradeId] = useState<number | null>(null)
  const [newPriority, setNewPriority] = useState<number>(1)
  const [newToGradeId, setNewToGradeId] = useState<number | null>(null)
  const [newYield, setNewYield] = useState<string>('1')
  const [newNote, setNewNote] = useState<string>('')
  const [error, setError] = useState<string | null>(null)

  // 行 を origin + from_grade で group 化
  const grouped = useMemo(() => {
    const data = rules.data ?? []
    const map = new Map<string, { origin_name: string; from_grade_label: string; rules: Rule[] }>()
    for (const r of data) {
      const key = `${r.origin_id}_${r.from_grade_id}`
      if (!map.has(key)) {
        map.set(key, { origin_name: r.origin_name, from_grade_label: r.from_grade_label, rules: [] })
      }
      map.get(key)!.rules.push(r)
    }
    for (const v of map.values()) v.rules.sort((a, b) => a.priority - b.priority)
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [rules.data])

  async function handleAdd() {
    setError(null)
    if (newOriginId == null || newFromGradeId == null || newToGradeId == null) {
      setError('産地 / 出庫したい規格 / 消化する規格 を 全て 選択')
      return
    }
    const y = Number(newYield)
    if (!Number.isFinite(y) || y <= 0 || y > 1) {
      setError('歩留まり は 0 < y ≤ 1')
      return
    }
    try {
      await api.post('/substitution/rules', {
        crop_id: cropId,
        origin_id: newOriginId,
        from_grade_id: newFromGradeId,
        priority: newPriority,
        to_grade_id: newToGradeId,
        yield_factor: y,
        is_active: true,
        note: newNote || null,
      })
      setNewToGradeId(null)
      setNewYield('1')
      setNewNote('')
      rules.reload()
    } catch (e) {
      setError(errorText(e))
    }
  }

  async function handlePatch(rule: Rule, patch: { to_grade_id?: number; yield_factor?: number; is_active?: boolean }) {
    setError(null)
    try {
      await api.patch(`/substitution/rules/${rule.id}`, patch)
      rules.reload()
    } catch (e) {
      setError(errorText(e))
    }
  }

  async function handleDelete(rule: Rule) {
    if (!(await dialog.confirm({
      title: '振替ルール削除',
      message: `削除しますか? (${rule.origin_name} ${rule.from_grade_label} P${rule.priority})`,
      variant: 'danger',
    }))) return
    try {
      await api.delete(`/substitution/rules/${rule.id}`)
      rules.reload()
    } catch (e) {
      setError(errorText(e))
    }
  }

  return (
    <div className="page">
      <h2>振替ルール マスタ</h2>
      <p className="muted" style={{ marginTop: 4 }}>
        商品 (from) 規格 → 原料 (to) 規格 の 振替 を 優先順位 1〜3 で 設定。
        振替出庫 時に priority 1 から 順に フォールバック。
      </p>

      {/* 絞り込み */}
      <div className="card" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <label>作物:&nbsp;
          <select value={cropId} onChange={e => setCropId(Number(e.target.value))}>
            {CROP_LIST.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label>産地:&nbsp;
          <select
            value={filterOriginId ?? ''}
            onChange={e => setFilterOriginId(e.target.value === '' ? null : Number(e.target.value))}
          >
            <option value="">(全て)</option>
            {(origins.data ?? []).map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>
        <label style={{ minWidth: 240 }}>出庫したい規格:&nbsp;
          <Combobox<Grade>
            items={grades.data ?? []}
            getKey={g => g.id}
            getLabel={gradeLabel}
            getSearchText={searchableGrade}
            value={filterFromGradeId}
            onChange={v => setFilterFromGradeId(v == null ? null : Number(v))}
            placeholder="(全て)"
          />
        </label>
        <label>
          <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
          無効も表示
        </label>
        <button onClick={() => rules.reload()}>再読込</button>
      </div>

      <ErrorBanner error={error} style={{ marginTop: 0 }} />

      {/* 新規追加 */}
      <details open className="card" style={{ marginTop: 8 }}>
        <summary><strong>新規ルール 追加</strong></summary>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 8 }}>
          <label>産地
            <select value={newOriginId ?? ''} onChange={e => setNewOriginId(e.target.value === '' ? null : Number(e.target.value))}>
              <option value="">(選択)</option>
              {(origins.data ?? []).map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
          <label>出庫したい規格 (from)
            <Combobox<Grade>
              items={grades.data ?? []}
              getKey={g => g.id} getLabel={gradeLabel} getSearchText={searchableGrade}
              value={newFromGradeId} onChange={v => setNewFromGradeId(v == null ? null : Number(v))}
              placeholder="商品 規格"
            />
          </label>
          <label>優先順位
            <select value={newPriority} onChange={e => setNewPriority(Number(e.target.value))}>
              <option value={1}>1 (A)</option>
              <option value={2}>2 (B)</option>
              <option value={3}>3 (C)</option>
            </select>
          </label>
          <label>消化する規格 (to)
            <Combobox<Grade>
              items={grades.data ?? []}
              getKey={g => g.id} getLabel={gradeLabel} getSearchText={searchableGrade}
              value={newToGradeId} onChange={v => setNewToGradeId(v == null ? null : Number(v))}
              placeholder="在庫 から 引く 規格"
            />
          </label>
          <label>歩留まり (0&lt;y≤1)
            <input type="number" step="0.0001" min="0.0001" max="1" value={newYield}
                   onChange={e => setNewYield(e.target.value)} />
          </label>
          <label>メモ
            <input type="text" value={newNote} onChange={e => setNewNote(e.target.value)} placeholder="(任意)" />
          </label>
        </div>
        <button onClick={handleAdd} style={{ marginTop: 8 }}>追加</button>
      </details>

      {/* 一覧 */}
      {rules.loading && <div className="muted">読み込み中…</div>}
      {!rules.loading && grouped.length === 0 && <div className="muted">ルール 0 件</div>}

      {grouped.map(([key, g]) => (
        <div className="card" key={key} style={{ marginTop: 8 }}>
          <div style={{ fontWeight: 'bold' }}>
            {g.origin_name} / {g.from_grade_label}
          </div>
          <table style={{ width: '100%', marginTop: 6, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#f4f4f4' }}>
                <th>P</th>
                <th>消化する規格 (to)</th>
                <th>歩留まり</th>
                <th>有効</th>
                <th>メモ</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {g.rules.map(r => (
                <tr key={r.id}>
                  <td style={{ textAlign: 'center' }}>{r.priority}</td>
                  <td>
                    <Combobox<Grade>
                      items={grades.data ?? []}
                      getKey={gg => gg.id}
                      getLabel={gradeLabel}
                      getSearchText={searchableGrade}
                      value={r.to_grade_id}
                      onChange={v => v != null && handlePatch(r, { to_grade_id: Number(v) })}
                    />
                  </td>
                  <td>
                    <input type="number" step="0.0001" min="0.0001" max="1"
                           defaultValue={r.yield_factor}
                           onBlur={e => {
                             const v = Number(e.target.value)
                             if (Number.isFinite(v) && String(v) !== r.yield_factor) {
                               handlePatch(r, { yield_factor: v })
                             }
                           }}
                           style={{ width: 80 }} />
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    <input type="checkbox" checked={r.is_active}
                           onChange={e => handlePatch(r, { is_active: e.target.checked })} />
                  </td>
                  <td>{r.note}</td>
                  <td><button onClick={() => handleDelete(r)} className="danger">削除</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}
