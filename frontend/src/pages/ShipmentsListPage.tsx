import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useFetch } from '../lib/useFetch'
import { num, yen, ymd } from '../lib/format'
import Combobox from '../components/Combobox'
import RowMenu, { useRowMenu } from '../components/RowMenu'
import type {
  ProductWithRecipe,
  ShipmentDepartment,
  ShipmentRecord,
} from '../api/types'

const DIVISION_LABEL: Record<number, string> = {
  1: '生姜', 2: '大蒜', 3: '長芋', 4: '牛蒡', 5: '薩摩芋', 6: '物流',
}

export default function ShipmentsListPage() {
  const [division, setDivision] = useState<string>('')
  const [department, setDepartment] = useState<string>('')
  const navigate = useNavigate()
  const productMenu = useRowMenu<ProductWithRecipe>()
  const recordMenu  = useRowMenu<ShipmentRecord>()

  const departments = useFetch<ShipmentDepartment[]>('/shipments/departments')

  const productParams: Record<string, string> = {}
  if (division) productParams.division = division
  if (department) productParams.department = department
  const products = useFetch<ProductWithRecipe[]>('/shipments/products', productParams)

  const recordParams: Record<string, string> = { limit: '60' }
  if (division) recordParams.division = division
  if (department) recordParams.department = department
  const records = useFetch<ShipmentRecord[]>('/shipments/records', recordParams)

  return (
    <div>
      <h2>商品出荷台帳</h2>
      <p className="subtitle">
        商品の出荷を記録します。商品1点出荷ごとに紐づいた資材レシピで
        資材が自動的に消耗します（資材在庫に即時反映）。
        事業部・部署で絞り込み表示できます。
      </p>

      <div className="panel">
        <div className="inline" style={{ marginBottom: 12 }}>
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
          <div style={{ minWidth: 240 }}>
            <label>
              部署コード
              {departments.data && (
                <span className="muted" style={{ fontWeight: 400, marginLeft: 6, fontSize: 11 }}>
                  ({departments.data.length} 件)
                </span>
              )}
            </label>
            <Combobox<ShipmentDepartment>
              items={departments.data ?? []}
              getKey={(d) => d.department_code}
              getLabel={(d) =>
                `${d.department_code} (${d.shipment_count}件 / ${d.product_count}商品)`}
              getSearchText={(d) => d.department_code}
              value={department || null}
              onChange={(v) => setDepartment(v != null ? String(v) : '')}
              placeholder="部署コード検索 (空欄=全部署)"
              maxResults={60}
            />
          </div>
          {(division || department) && (
            <button className="ghost small" onClick={() => { setDivision(''); setDepartment('') }}>
              クリア
            </button>
          )}
        </div>
      </div>

      <div className="panel">
        <h3>
          商品一覧（レシピ込み）
          {products.data && <span className="muted" style={{ fontWeight: 400, marginLeft: 8, fontSize: 13 }}>
            ({products.data.length} 件)
          </span>}
        </h3>
        {products.error && <div className="alert error">{products.error}</div>}
        {products.loading && <div className="muted">読み込み中…</div>}
        {products.data && (
          <table className="sticky-head">
            <thead>
              <tr>
                <th>商品コード</th>
                <th>分類</th>
                <th>商品名</th>
                <th className="num">事業部</th>
                <th className="num">入り数</th>
                <th>1点あたり消耗する資材</th>
              </tr>
            </thead>
            <tbody>
              {products.data.map((p) => (
                <tr key={p.product_id}
                  onContextMenu={(e) => productMenu.openAt(e, p)}
                  style={{ cursor: 'context-menu' }}
                >
                  <td><code style={{ fontFamily: 'var(--font-mono)' }}>{p.product_code ?? '—'}</code></td>
                  <td className="muted" style={{ fontSize: 12 }}>{p.classification_name ?? '—'}</td>
                  <td>{p.name}{productMenu.triggerButton(p, 'メニュー')}</td>
                  <td className="num">{p.division} ({DIVISION_LABEL[p.division] ?? '?'})</td>
                  <td className="num">{p.pack_size ? num(p.pack_size, 0) : '—'}</td>
                  <td>
                    {p.recipes.length === 0 ? (
                      <span className="muted">レシピ未設定</span>
                    ) : (
                      p.recipes.map((r) => (
                        <span
                          key={`${r.material_id}-${r.department_code ?? ''}`}
                          style={{
                            display: 'inline-block',
                            marginRight: 10,
                            fontSize: 12,
                          }}
                        >
                          <strong>{r.material_code}</strong> {r.material_name} ×{' '}
                          {num(r.quantity_per_unit, 4)} {r.material_unit ?? ''}
                        </span>
                      ))
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h3>
          最近の出荷履歴
          {records.data && <span className="muted" style={{ fontWeight: 400, marginLeft: 8, fontSize: 13 }}>
            ({records.data.length} 件)
          </span>}
        </h3>
        {records.error && <div className="alert error">{records.error}</div>}
        {records.data && (
          <table className="sticky-head">
            <thead>
              <tr>
                <th>出荷日</th>
                <th>部署</th>
                <th>商品名</th>
                <th className="num">数量</th>
                <th className="num">販売金額</th>
                <th className="num">重量(kg)</th>
                <th className="num">入り数</th>
                <th>出庫元</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {records.data.map((r) => (
                <tr key={r.record_id}
                  onContextMenu={(e) => recordMenu.openAt(e, r)}
                  style={{ cursor: 'context-menu' }}
                >
                  <td>{ymd(r.ship_date)}</td>
                  <td><code style={{ fontFamily: 'var(--font-mono)' }}>{r.department_code ?? '—'}</code></td>
                  <td>{r.product_name}</td>
                  <td className="num">{num(r.quantity, 1)}</td>
                  <td className="num">{r.sales_amount ? yen(r.sales_amount) : '—'}</td>
                  <td className="num">{r.weight_kg ? num(r.weight_kg, 2) : '—'}</td>
                  <td className="num">{r.pack_size ? num(r.pack_size, 0) : '—'}</td>
                  <td>{r.dispatch_from ?? '—'}</td>
                  <td>{recordMenu.triggerButton(r, 'メニュー')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <RowMenu<ProductWithRecipe>
        state={productMenu.state}
        onClose={productMenu.close}
        items={(p) => [
          {
            icon: '📝', label: 'この商品のレシピを編集',
            onClick: () => navigate('/shipments/recipes'),
            title: '商品⇄資材レシピ画面を開きます',
          },
          {
            icon: '📥', label: 'この商品の出荷を登録',
            onClick: () => navigate('/shipments/register'),
          },
          {
            icon: '🔍', label: 'この商品の出荷履歴のみで絞り込み',
            onClick: () => setDivision(String(p.division)),
            title: '部署も指定して絞り込みたい場合はフィルタ欄を併用',
          },
          { divider: true,
            icon: '🔢', label: `商品コード ${p.product_code ?? p.product_id} をコピー`,
            onClick: () => {
              const t = p.product_code ?? String(p.product_id)
              navigator.clipboard.writeText(t).catch(() => {})
            },
          },
        ]}
      />

      <RowMenu<ShipmentRecord>
        state={recordMenu.state}
        onClose={recordMenu.close}
        items={(r) => [
          {
            icon: '🔍', label: `部署 ${r.department_code ?? '(なし)'} で絞り込み`,
            disabled: !r.department_code,
            onClick: () => { if (r.department_code) setDepartment(r.department_code) },
          },
          {
            icon: '📝', label: 'この商品のレシピを編集',
            onClick: () => navigate('/shipments/recipes'),
          },
          { divider: true,
            icon: '🔢', label: `出荷ID (${r.record_id}) をコピー`,
            onClick: () => navigator.clipboard.writeText(String(r.record_id)).catch(() => {}),
          },
        ]}
      />
    </div>
  )
}
