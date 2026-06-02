import { useState } from 'react'
import { api } from '../api/client'
import { useFetch } from '../lib/useFetch'
import { errorText } from '../lib/format'
import Combobox from '../components/Combobox'
import type { Grade, Origin, Product, Supplier } from '../api/types'

const CROP_NAMES: Record<number, string> = {
  1: '生姜', 2: '大蒜', 3: '親生姜', 4: '牛蒡', 5: '薩摩芋',
}
const CROP_LIST: { id: number; name: string }[] = [
  { id: 1, name: '生姜' },
  { id: 2, name: '大蒜' },
  { id: 3, name: '親生姜' },
  { id: 4, name: '牛蒡' },
  { id: 5, name: '薩摩芋' },
]

export default function MastersPage() {
  // 規格・商品の絞り込み (内部状態 — 「全作物」 or 特定作物)
  // localStorage で永続化、 次回開いた時の続きから
  const [selectedCrop, setSelectedCrop] = useState<number | null>(() => {
    try {
      const raw = localStorage.getItem('masters_selected_crop_v1')
      if (raw === 'all') return null
      const n = raw ? Number(raw) : null
      return n && Number.isFinite(n) ? n : null
    } catch { return null }
  })
  // selectedCrop 永続化
  function setCrop(v: number | null) {
    setSelectedCrop(v)
    try { localStorage.setItem('masters_selected_crop_v1', v == null ? 'all' : String(v)) }
    catch { /* */ }
  }
  // 「規格」 「商品」 は作物別、 「仕入先」 「産地」 は共通
  const cropQuery = selectedCrop != null ? { crop_id: String(selectedCrop) } : undefined
  const suppliers = useFetch<Supplier[]>('/masters/suppliers')
  const origins = useFetch<Origin[]>('/masters/origins')
  const grades = useFetch<Grade[]>('/masters/grades', cropQuery)
  const products = useFetch<Product[]>('/masters/products', cropQuery)

  const [error, setError] = useState<string | null>(null)

  // 仕入先
  const [supName, setSupName] = useState('')
  // 産地
  const [oriName, setOriName] = useState('')
  const [oriRegion, setOriRegion] = useState('')
  // 規格
  const [gSpec, setGSpec] = useState('')
  const [gLevel, setGLevel] = useState('-')
  const [gSize, setGSize] = useState('-')
  // 商品
  const [pGrade, setPGrade] = useState<number | null>(null)
  const [pOrigin, setPOrigin] = useState<number | null>(null)

  async function run(fn: () => Promise<unknown>, reload: () => void) {
    setError(null)
    try {
      await fn()
      reload()
    } catch (e) {
      setError(errorText(e))
    }
  }

  const cropName = selectedCrop != null
    ? (CROP_NAMES[selectedCrop] ?? `作物 #${selectedCrop}`) : null
  return (
    <div>
      <h2>マスタ管理台帳</h2>
      <p className="subtitle">
        仕入先・産地・規格・商品の登録 (管理者のみ)。
        仕入先・産地は <strong>全作物で共有</strong>、
        規格・商品は <strong>作物別</strong> です。
      </p>
      {error && <div className="alert error">{error}</div>}

      <div className="panel">
        <h3>仕入先 <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>(共通: 全作物で共有 / {suppliers.data?.length ?? 0} 件)</span></h3>
        <div className="inline" style={{ marginBottom: 12 }}>
          <input
            placeholder="仕入先名"
            value={supName}
            onChange={(e) => setSupName(e.target.value)}
            style={{ width: 220 }}
          />
          <button
            disabled={!supName.trim()}
            onClick={() =>
              run(
                () =>
                  api
                    .post('/masters/suppliers', undefined, {
                      name: supName.trim(),
                    })
                    .then(() => setSupName('')),
                suppliers.reload,
              )
            }
          >
            追加
          </button>
        </div>
        <table>
          <thead>
            <tr>
              <th className="num">ID</th>
              <th>名称</th>
            </tr>
          </thead>
          <tbody>
            {suppliers.data?.map((s) => (
              <tr key={s.id}>
                <td className="num">{s.id}</td>
                <td>{s.name}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h3>産地 <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>(共通: 全作物で共有 / {origins.data?.length ?? 0} 件)</span></h3>
        <div className="inline" style={{ marginBottom: 12 }}>
          <input
            placeholder="産地名（例: 高知産）"
            value={oriName}
            onChange={(e) => setOriName(e.target.value)}
            style={{ width: 200 }}
          />
          <input
            placeholder="地域（任意）"
            value={oriRegion}
            onChange={(e) => setOriRegion(e.target.value)}
            style={{ width: 160 }}
          />
          <button
            disabled={!oriName.trim()}
            onClick={() =>
              run(
                () =>
                  api
                    .post('/masters/origins', undefined, {
                      name: oriName.trim(),
                      region: oriRegion.trim() || undefined,
                    })
                    .then(() => {
                      setOriName('')
                      setOriRegion('')
                    }),
                origins.reload,
              )
            }
          >
            追加
          </button>
        </div>
        <table>
          <thead>
            <tr>
              <th className="num">ID</th>
              <th>名称</th>
              <th>地域</th>
            </tr>
          </thead>
          <tbody>
            {origins.data?.map((o) => (
              <tr key={o.id}>
                <td className="num">{o.id}</td>
                <td>{o.name}</td>
                <td>{o.region ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 作物セレクタ — ここから下 (規格 + 商品) が作物別 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        margin: '20px 0 10px', padding: '8px 12px',
        background: 'var(--surface, #f8f9fa)',
        border: '1px solid var(--border)', borderRadius: 6,
        borderLeft: '4px solid var(--primary, #1a73e8)',
      }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>作物別マスタ:</span>
        <button
          type="button"
          onClick={() => setCrop(null)}
          className={selectedCrop == null ? '' : 'secondary'}
          style={{ fontSize: 12, padding: '4px 10px' }}>
          全作物
        </button>
        {CROP_LIST.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setCrop(c.id)}
            className={selectedCrop === c.id ? '' : 'secondary'}
            style={{ fontSize: 12, padding: '4px 10px' }}>
            {c.name}
          </button>
        ))}
        <span className="muted" style={{ fontSize: 11, marginLeft: 'auto' }}>
          ↓ 「規格」 「商品」 に適用
        </span>
      </div>

      <div className="panel">
        <h3>規格 <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
          ({cropName ? `${cropName}: ` : '全作物: '}{grades.data?.length ?? 0} 件)
        </span></h3>
        <div className="inline" style={{ marginBottom: 12 }}>
          <input
            placeholder="規格（spec_type）"
            value={gSpec}
            onChange={(e) => setGSpec(e.target.value)}
            style={{ width: 160 }}
          />
          <input
            placeholder="等級"
            value={gLevel}
            onChange={(e) => setGLevel(e.target.value)}
            style={{ width: 90 }}
          />
          <input
            placeholder="サイズ"
            value={gSize}
            onChange={(e) => setGSize(e.target.value)}
            style={{ width: 90 }}
          />
          <button
            disabled={!gSpec.trim()}
            onClick={() =>
              run(
                () =>
                  api
                    .post('/masters/grades', undefined, {
                      spec_type: gSpec.trim(),
                      grade_level: gLevel.trim() || '-',
                      size_label: gSize.trim() || '-',
                    })
                    .then(() => setGSpec('')),
                grades.reload,
              )
            }
          >
            追加
          </button>
        </div>
        <table>
          <thead>
            <tr>
              <th className="num">ID</th>
              <th>規格</th>
              <th>等級</th>
              <th>サイズ</th>
            </tr>
          </thead>
          <tbody>
            {grades.data?.map((g) => (
              <tr key={g.id}>
                <td className="num">{g.id}</td>
                <td>{g.spec_type}</td>
                <td>{g.grade_level}</td>
                <td>{g.size_label}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h3>商品 <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
          ({cropName ? `${cropName}: ` : '全作物: '}{products.data?.length ?? 0} 件) = 規格 × 産地
        </span></h3>
        <div className="row" style={{ marginBottom: 12 }}>
          <div className="field" style={{ minWidth: 220, flex: 1 }}>
            <label>
              規格 ({grades.data?.length ?? 0} 件)
            </label>
            <Combobox<Grade>
              items={grades.data ?? []}
              getKey={(g) => g.id}
              getLabel={(g) => `${g.spec_type} (${g.grade_level}/${g.size_label})`}
              getSearchText={(g) => `${g.spec_type} ${g.grade_level} ${g.size_label}`}
              value={pGrade}
              onChange={(v) => setPGrade(v as number | null)}
              placeholder="規格名で検索 (スペースで複数語 AND)"
            />
          </div>
          <div className="field" style={{ minWidth: 200, flex: 1 }}>
            <label>
              産地 ({origins.data?.length ?? 0} 件)
            </label>
            <Combobox<Origin>
              items={origins.data ?? []}
              getKey={(o) => o.id}
              getLabel={(o) => o.name + (o.region ? ` (${o.region})` : '')}
              getSearchText={(o) => `${o.name} ${o.region ?? ''}`}
              value={pOrigin}
              onChange={(v) => setPOrigin(v as number | null)}
              placeholder="産地名で検索"
            />
          </div>
          <div className="field" style={{ alignSelf: 'end' }}>
          <button
            disabled={pGrade == null || pOrigin == null}
            onClick={() =>
              run(
                () =>
                  api
                    .post('/masters/products', undefined, {
                      grade_id: pGrade,
                      origin_id: pOrigin,
                      ...(selectedCrop != null ? { crop_id: selectedCrop } : {}),
                    })
                    .then(() => {
                      setPGrade(null)
                      setPOrigin(null)
                    }),
                products.reload,
              )
            }
          >
            追加
          </button>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th className="num">ID</th>
              {selectedCrop == null && <th>作物</th>}
              <th>規格</th>
              <th>等級</th>
              <th>サイズ</th>
              <th>産地</th>
            </tr>
          </thead>
          <tbody>
            {products.data?.map((p) => (
              <tr key={p.id}>
                <td className="num">{p.id}</td>
                {selectedCrop == null && <td>{p.crop_name}</td>}
                <td>{p.spec_type}</td>
                <td>{p.grade_level === '-' ? '' : p.grade_level}</td>
                <td>{p.size_label === '-' ? '' : p.size_label}</td>
                <td>{p.origin_name}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
