/**
 * ProductBomPage
 * ===============
 * 商品 BOM マスタ 管理画面。
 *
 * 1 行 = 1 商品 (商品コード PK) → (産地, 原料規格1 × 割合1, 原料規格2 × 割合2)
 * 未解決 (origin/grade マスタ突合 失敗) は 赤帯 で 強調 → ユーザー が マッピング 編集。
 */
import { useMemo, useState } from 'react'
import { api } from '../api/client'
import { useFetch } from '../lib/useFetch'
import { errorText } from '../lib/format'
import Combobox from '../components/Combobox'
import { useDialog } from '../components/Dialog'
import { GARLIC_CROP_ID } from '../lib/crop'
import { ErrorBanner, LoadingState } from '../components/StatusDisplay'
import type { Grade, Origin } from '../api/types'

interface Bom {
  product_code: string
  product_name: string
  crop_id: number
  origin_id: number | null
  origin_text: string | null
  origin_name: string | null
  grade_id_1: number | null
  grade_text_1: string | null
  grade_label_1: string | null
  ratio_1: string
  grade_id_2: number | null
  grade_text_2: string | null
  grade_label_2: string | null
  ratio_2: string | null
  note: string | null
  is_resolved: boolean
}

const CROP_ID = GARLIC_CROP_ID

function gLabel(g: Grade): string {
  return `${g.spec_type}/${g.grade_level || '-'}/${g.size_label || '-'}`
}
function gSearch(g: Grade): string {
  return `${g.spec_type} ${g.grade_level} ${g.size_label}`
}

export default function ProductBomPage() {
  const dialog = useDialog()
  const [search, setSearch] = useState('')
  const [unresolvedOnly, setUnresolvedOnly] = useState(false)

  const origins = useFetch<Origin[]>('/masters/origins')
  const grades = useFetch<Grade[]>('/masters/grades')

  const boms = useFetch<Bom[]>('/bom', {
    crop_id: String(CROP_ID),
    ...(search ? { search } : {}),
    ...(unresolvedOnly ? { unresolved_only: 'true' } : {}),
  })

  const [error, setError] = useState<string | null>(null)
  const [editingCode, setEditingCode] = useState<string | null>(null)

  const total = boms.data?.length ?? 0
  const unresolved = useMemo(() => (boms.data ?? []).filter(b => !b.is_resolved).length, [boms.data])

  async function patchBom(code: string, patch: Partial<Bom>) {
    setError(null)
    try {
      await api.patch(`/bom/${encodeURIComponent(code)}`, patch)
      boms.reload()
    } catch (e) {
      setError(errorText(e))
    }
  }

  async function handleDelete(b: Bom) {
    if (!(await dialog.confirm({
      title: 'BOM 削除',
      message: `削除しますか? ${b.product_code} (${b.product_name})`,
      variant: 'danger',
    }))) return
    try {
      await api.delete(`/bom/${encodeURIComponent(b.product_code)}`)
      boms.reload()
    } catch (e) {
      setError(errorText(e))
    }
  }

  return (
    <div className="page">
      <h2>商品 BOM マスタ</h2>
      <p className="muted" style={{ marginTop: 4 }}>
        1 商品 = 最大 2 原料 (規格 × 割合 %) の 配合表。 NR 原材料使用計算 で 参照。
      </p>

      <div className="card" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <label>検索:&nbsp;
          <input type="text" value={search} onChange={e => setSearch(e.target.value)}
                 placeholder="商品コード or 品名" style={{ width: 260 }} />
        </label>
        <label>
          <input type="checkbox" checked={unresolvedOnly} onChange={e => setUnresolvedOnly(e.target.checked)} />
          未解決のみ
        </label>
        <span style={{ marginLeft: 'auto' }} className="muted">
          表示 {total} 件 (未解決 {unresolved} 件)
        </span>
        <button onClick={() => boms.reload()}>再読込</button>
      </div>

      <ErrorBanner error={error} />

      {boms.loading && <LoadingState />}

      <div className="card" style={{ marginTop: 8, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9em' }}>
          <thead>
            <tr style={{ background: '#f4f4f4' }}>
              <th>商品コード</th><th>品名</th><th>産地</th>
              <th>規格1</th><th>%</th>
              <th>規格2</th><th>%</th>
              <th>備考</th><th></th>
            </tr>
          </thead>
          <tbody>
            {(boms.data ?? []).map(b => (
              <tr key={b.product_code} style={{ background: b.is_resolved ? undefined : '#FFE0E0' }}>
                <td><code>{b.product_code}</code></td>
                <td>{b.product_name}</td>
                <td>
                  {editingCode === b.product_code ? (
                    <select value={b.origin_id ?? ''} onChange={e => {
                      const v = e.target.value === '' ? null : Number(e.target.value)
                      patchBom(b.product_code, { origin_id: v })
                    }}>
                      <option value="">(未設定)</option>
                      {(origins.data ?? []).map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                    </select>
                  ) : (
                    <span>{b.origin_name || `[${b.origin_text || '?'}]`}</span>
                  )}
                </td>
                <td>
                  {editingCode === b.product_code ? (
                    <Combobox<Grade>
                      items={grades.data ?? []} getKey={g => g.id} getLabel={gLabel} getSearchText={gSearch}
                      value={b.grade_id_1}
                      onChange={v => v != null && patchBom(b.product_code, { grade_id_1: Number(v) })}
                    />
                  ) : (
                    <span>{b.grade_label_1 || `[${b.grade_text_1 || '?'}]`}</span>
                  )}
                </td>
                <td style={{ textAlign: 'right' }}>{b.ratio_1}</td>
                <td>
                  {b.grade_label_2 ? b.grade_label_2 : (b.grade_text_2 ? `[${b.grade_text_2}]` : '—')}
                </td>
                <td style={{ textAlign: 'right' }}>{b.ratio_2 ?? '—'}</td>
                <td>{b.note}</td>
                <td>
                  {editingCode === b.product_code ? (
                    <button onClick={() => setEditingCode(null)}>完了</button>
                  ) : (
                    <button onClick={() => setEditingCode(b.product_code)}>編集</button>
                  )}
                  <button onClick={() => handleDelete(b)} className="danger" style={{ marginLeft: 4 }}>削除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
