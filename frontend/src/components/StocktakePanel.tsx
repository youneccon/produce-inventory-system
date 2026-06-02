/**
 * StocktakePanel — 棚卸モード時の入力 UI (side-panel 内に差し込む)。
 *
 * 表示:
 *   - 日付セレクト (既定: 今日)
 *   - 事業部フィルタ
 *   - 進捗 (合計 N 件 / 完了 M 件)
 *   - 選択中オブジェクトの紐付き資材 → 各々の理論在庫 + 入力欄
 *   - 「他の場所にも在庫あり」警告
 *   - 未配置 (storage_object_items 無し) の資材一覧 (in scope の事業部)
 */

import { useState, useEffect, useMemo } from 'react'
import { api } from '../api/client'
import { useDialog } from './Dialog'
import { errorText, num } from '../lib/format'
import type { MaterialCount, MaterialStock, StorageObject, StorageObjectItem } from '../api/types'

const DIVISION_LABEL: Record<number, string> = {
  0: '未割当', 1: '生姜', 2: '大蒜', 3: '長芋', 4: '牛蒡', 5: '薩摩芋', 6: '物流',
}

interface Props {
  layoutId: number
  layoutDivision: number | null
  objects: StorageObject[]
  items: StorageObjectItem[]                // 全 object-item link
  materials: MaterialStock[]                // 全資材 (理論値含む)
  selectedObjectId: number | null
  /** 棚卸入力後にレイアウト state を再取得する */
  onCountSaved: () => void
  /** 親に「事業部フィルタ」状況を返して fillByObject に反映 */
  onFilterChange: (date: string, division: number | null) => void
}

export default function StocktakePanel(p: Props) {
  const dialog = useDialog()
  const [date, setDate] = useState<string>(() => new Date().toISOString().slice(0, 10))
  const [division, setDivision] = useState<number | null>(p.layoutDivision)
  const [counts, setCounts] = useState<MaterialCount[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [inputs, setInputs] = useState<Record<string, string>>({})   // key=`${material}-${object||0}`

  // 親に通知
  useEffect(() => { p.onFilterChange(date, division) }, [date, division])

  // 棚卸データ取得
  async function reloadCounts() {
    if (!p.layoutId) return
    try {
      const r = await api.get<MaterialCount[]>('/materials/counts', {
        date_from: date, date_to: date,
      })
      setCounts(r)
    } catch (e) {
      setError(errorText(e))
    }
  }
  useEffect(() => { reloadCounts() }, [date, p.layoutId])

  const countsByKey = useMemo(() => {
    const m = new Map<string, MaterialCount>()
    for (const c of counts) {
      m.set(`${c.material_id}-${c.object_id ?? 0}`, c)
    }
    return m
  }, [counts])

  // 各 material → 紐付き object のリスト
  const objectsByMaterial = useMemo(() => {
    const m = new Map<number, number[]>()
    for (const it of p.items) {
      if (it.material_id == null) continue
      const arr = m.get(it.material_id) ?? []
      if (!arr.includes(it.object_id)) arr.push(it.object_id)
      m.set(it.material_id, arr)
    }
    return m
  }, [p.items])

  // 選択オブジェクトの items (division フィルタ適用)
  const selectedItems = useMemo(() => {
    if (p.selectedObjectId == null) return []
    return p.items.filter((it) => {
      if (it.object_id !== p.selectedObjectId) return false
      if (it.material_id == null) return false
      if (division != null) {
        const mat = p.materials.find((m) => m.material_id === it.material_id)
        if (!mat) return false
        if (mat.division !== division && mat.division !== 0) return false
      }
      return true
    })
  }, [p.selectedObjectId, p.items, p.materials, division])

  // 未配置資材 (in scope)
  const unplaced = useMemo(() => {
    return p.materials.filter((m) => {
      if (!m.is_active) return false
      if (division != null && m.division !== division && m.division !== 0) return false
      const links = objectsByMaterial.get(m.material_id)
      return !links || links.length === 0
    })
  }, [p.materials, objectsByMaterial, division])

  // 進捗: 対象資材のうち valid count があるもの数
  const progress = useMemo(() => {
    const scope = p.materials.filter((m) =>
      m.is_active && (division == null || m.division === division || m.division === 0)
    )
    let complete = 0
    for (const m of scope) {
      if (m.latest_count_date === date && m.latest_count_complete) complete++
    }
    return { complete, total: scope.length }
  }, [p.materials, division, date])

  async function saveCount(materialId: number, objectId: number | null,
                           qty: number, materialName: string, theoretical: number) {
    if (qty < 0 || !Number.isFinite(qty)) {
      setError('数値を入力してください')
      return
    }
    // 乖離警告 (>10%)
    if (theoretical > 0) {
      const rate = Math.abs((qty - theoretical) / theoretical)
      if (rate > 0.10) {
        const ok = await dialog.confirm({
          title: '理論値と乖離があります',
          message: `「${materialName}」の棚卸値 ${qty} は理論値 ${num(theoretical, 1)} と ${(rate * 100).toFixed(1)}% の乖離があります。\n本当にこの値で保存しますか？`,
          okLabel: 'この値で保存',
          variant: 'warn',
        })
        if (!ok) return
      }
    }
    setBusy(true); setError(null)
    try {
      // 重複チェック → 既存があれば overwrite 確認
      const dup = await api.get<{ exists: boolean; existing: { counted_qty: string } | null }>(
        `/materials/${materialId}/counts/check-duplicate`,
        { count_date: date, object_id: objectId ? String(objectId) : '' },
      )
      let overwrite = false
      if (dup.exists) {
        const existingQty = dup.existing?.counted_qty
        const ok = await dialog.confirm({
          title: '同日の棚卸が存在します',
          message: `既に値 ${existingQty} が記録されています。上書きしますか？`,
          okLabel: '上書き保存',
          variant: 'warn',
        })
        if (!ok) { setBusy(false); return }
        overwrite = true
      }
      await api.post('/materials/counts', {
        material_id: materialId,
        count_date: date,
        counted_qty: qty,
        object_id: objectId,
        overwrite,
      })
      // 入力フィールドクリア
      setInputs((p) => {
        const next = { ...p }
        delete next[`${materialId}-${objectId ?? 0}`]
        return next
      })
      await reloadCounts()
      p.onCountSaved()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {/* 日付 + 事業部 */}
      <div className="side-section">
        <div className="side-section-title">棚卸モード</div>
        <div className="field" style={{ marginBottom: 8 }}>
          <label>棚卸日</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ fontSize: 12 }} />
        </div>
        <div className="field" style={{ marginBottom: 8 }}>
          <label>事業部フィルタ</label>
          <select
            value={division ?? ''}
            onChange={(e) => setDivision(e.target.value ? Number(e.target.value) : null)}
            style={{ fontSize: 12 }}
          >
            <option value="">全事業部</option>
            {Object.entries(DIVISION_LABEL).map(([d, n]) => (
              <option key={d} value={d}>{d}: {n}</option>
            ))}
          </select>
        </div>
        <div style={{ fontSize: 12 }}>
          進捗: <strong>{progress.complete}</strong> / {progress.total} 完了
          <div style={{
            height: 4, background: 'var(--accent)', borderRadius: 2, marginTop: 4,
            overflow: 'hidden',
          }}>
            <div style={{
              width: progress.total ? `${progress.complete / progress.total * 100}%` : '0%',
              height: '100%', background: 'var(--ok)',
              transition: 'width var(--t-base) var(--ease)',
            }} />
          </div>
        </div>
      </div>

      {error && <div className="side-section"><div className="alert error">{error}</div></div>}

      {/* 選択オブジェクトの入力欄 */}
      {p.selectedObjectId != null && (
        <div className="side-section">
          <div className="side-section-title">
            選択オブジェクトの棚卸 ({selectedItems.length} 件)
          </div>
          {selectedItems.length === 0 && (
            <div className="muted" style={{ fontSize: 12 }}>
              対象資材がありません (事業部フィルタ外、または資材未紐付け)
            </div>
          )}
          {selectedItems.map((it) => {
            const mat = p.materials.find((m) => m.material_id === it.material_id)
            if (!mat) return null
            const links = objectsByMaterial.get(it.material_id!) ?? []
            const otherLocations = links.filter((id) => id !== p.selectedObjectId).length
            const key = `${it.material_id}-${p.selectedObjectId}`
            const existing = countsByKey.get(key)
            const theoretical = Number(mat.remaining_qty)
            return (
              <div key={it.id} style={{
                padding: '8px 0', borderTop: '1px solid var(--divider)',
                fontSize: 12,
              }}>
                <div style={{ fontWeight: 600 }}>
                  {it.material_code} {it.material_name}
                </div>
                <div className="muted" style={{ fontSize: 11 }}>
                  理論在庫: {num(mat.remaining_qty, 1)} {mat.unit ?? ''}
                  {existing && (
                    <span style={{ color: 'var(--ok)', marginLeft: 8 }}>
                      ✓ {date} 棚卸済 ({existing.counted_qty})
                    </span>
                  )}
                </div>
                {otherLocations > 0 && (
                  <div style={{
                    fontSize: 11, color: 'var(--warn)', marginTop: 2,
                  }}>
                    ⚠ この資材は他に {otherLocations} 箇所にも在庫あり (全箇所棚卸で valid)
                  </div>
                )}
                <div className="inline" style={{ marginTop: 4, gap: 4 }}>
                  <input
                    type="number" step="0.01" min="0"
                    placeholder={existing?.counted_qty ?? '0'}
                    value={inputs[key] ?? ''}
                    onChange={(e) => setInputs((p) => ({ ...p, [key]: e.target.value }))}
                    style={{ flex: 1, fontSize: 12 }}
                  />
                  <button
                    className="small"
                    disabled={busy || !inputs[key]}
                    onClick={() => saveCount(it.material_id!, p.selectedObjectId,
                      Number(inputs[key]), it.material_name ?? '', theoretical)}
                  >保存</button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 未配置資材 (in scope) */}
      {unplaced.length > 0 && (
        <div className="side-section">
          <div className="side-section-title">
            未配置の資材 ({unplaced.length} 件) — 「全体合計」で入力
          </div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
            レイアウトに置かれていない資材。場所無し (object_id=null) で棚卸。
          </div>
          {unplaced.slice(0, 12).map((m) => {
            const key = `${m.material_id}-0`
            const existing = countsByKey.get(key)
            return (
              <div key={m.material_id} style={{
                padding: '6px 0', borderTop: '1px solid var(--divider)',
                fontSize: 12,
              }}>
                <div style={{ fontWeight: 500 }}>
                  {m.code} {m.item_name}
                  {existing && (
                    <span style={{ color: 'var(--ok)', marginLeft: 6, fontSize: 11 }}>
                      ✓ {existing.counted_qty}
                    </span>
                  )}
                </div>
                <div className="inline" style={{ marginTop: 2, gap: 4 }}>
                  <input
                    type="number" step="0.01" min="0"
                    placeholder={`理論 ${num(m.remaining_qty, 1)}`}
                    value={inputs[key] ?? ''}
                    onChange={(e) => setInputs((p) => ({ ...p, [key]: e.target.value }))}
                    style={{ flex: 1, fontSize: 12 }}
                  />
                  <button
                    className="small"
                    disabled={busy || !inputs[key]}
                    onClick={() => saveCount(m.material_id, null,
                      Number(inputs[key]), m.item_name, Number(m.remaining_qty))}
                  >保存</button>
                </div>
              </div>
            )
          })}
          {unplaced.length > 12 && (
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              他 {unplaced.length - 12} 件 (在庫一覧から入力)
            </div>
          )}
        </div>
      )}
    </>
  )
}
