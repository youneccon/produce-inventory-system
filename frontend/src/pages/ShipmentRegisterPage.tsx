import { useRef, useState, type ChangeEvent } from 'react'
import { api } from '../api/client'
import { useFetch } from '../lib/useFetch'
import { errorText, num } from '../lib/format'
import Combobox from '../components/Combobox'
import type { ProductWithRecipe } from '../api/types'

const DIVISION_LABEL: Record<number, string> = {
  1: '生姜', 2: '大蒜', 3: '長芋', 4: '牛蒡', 5: '薩摩芋', 6: '物流',
}

interface BulkImportResult {
  filename: string
  ship_date: string
  new_products: number
  new_product_samples: Array<{ product_code: string; name: string; division: number }>
  inserted_records: number
  updated_records: number
  skipped_rows: number
  errors: string[]
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

export default function ShipmentRegisterPage() {
  const products = useFetch<ProductWithRecipe[]>('/shipments/products')

  const [productId, setProductId] = useState<number | null>(null)
  const [date, setDate] = useState(today())
  const [qty, setQty] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // 新規商品作成モード (Combobox の onCreateNew で開く)
  const [creating, setCreating] = useState<{
    name: string; division: number; unit: string;
  } | null>(null)
  function startCreate(typed: string) {
    setCreating({ name: typed, division: 1, unit: '' })
  }
  async function saveCreate() {
    if (!creating || !creating.name.trim()) return
    setBusy(true); setError(null); setMsg(null)
    try {
      const created = await api.post<{ id: number; name: string; division: number }>(
        '/shipments/products',
        undefined,
        {
          division: creating.division,
          name: creating.name.trim(),
          unit: creating.unit || undefined,
        },
      )
      await products.reload()
      setProductId(created.id)
      setMsg(`新規商品を作成しました: ${created.name} (事業部 ${created.division})`)
      setCreating(null)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  // 一括取り込み (XLSX)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [bulkResult, setBulkResult] = useState<BulkImportResult | null>(null)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkError, setBulkError] = useState<string | null>(null)

  async function uploadXlsx(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setBulkBusy(true); setBulkError(null); setBulkResult(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const r = await api.upload<BulkImportResult>('/shipments/bulk-import', fd)
      setBulkResult(r)
      products.reload()
    } catch (er) {
      setBulkError(errorText(er))
    } finally {
      setBulkBusy(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const selected = products.data?.find((p) => p.product_id === productId)

  async function submit() {
    if (productId == null || !qty) return
    setBusy(true); setError(null); setMsg(null)
    try {
      await api.post('/shipments/records', {
        product_id: productId,
        ship_date: date,
        quantity: Number(qty),
        note: note || null,
      })
      const consumed = selected?.recipes.map(
        (r) =>
          `${r.material_code}(${r.material_name}) ${num(
            Number(r.quantity_per_unit) * Number(qty), 4,
          )} ${r.material_unit ?? ''}`,
      ).join(' / ') ?? '—'
      setMsg(
        `${selected?.name} を ${qty} ${selected?.unit ?? ''} 出荷登録しました。`
        + ` 自動消耗: ${consumed}`,
      )
      setQty('')
      setNote('')
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <h2>商品出荷 登録</h2>
      <p className="subtitle">
        商品の出荷を記録します。登録すると紐づくレシピで資材が即時消耗されます。
        1 行ずつ登録するか、商品集計 XLSX をアップロードして一括取り込みできます。
      </p>

      {error && <div className="alert error">{error}</div>}
      {msg && <div className="alert success">{msg}</div>}

      <div className="panel">
        <h3>XLSX 一括取り込み</h3>
        <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
          商品集計 XLSX (例: <code>260515商品期間集計.xlsx</code>) を選択してアップロードすると、
          ファイル名から出荷日を判定し、商品マスタを UPSERT、出荷レコードを
          (出荷日 × 商品 × 部署 × 出庫元) で UPSERT します。
          <strong> 同じファイルを再度アップロードしても重複登録されません </strong>
          （既存レコードは数量等が更新されます）。
        </p>
        <div className="inline">
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={uploadXlsx}
            disabled={bulkBusy}
            style={{ maxWidth: 320 }}
          />
          {bulkBusy && <span className="muted">取り込み中…</span>}
        </div>
        {bulkError && (
          <div className="alert error" style={{ marginTop: 10 }}>{bulkError}</div>
        )}
        {bulkResult && (
          <div className="alert success" style={{ marginTop: 10 }}>
            <div><strong>取り込み完了:</strong> {bulkResult.filename}（出荷日 {bulkResult.ship_date}）</div>
            <div style={{ marginTop: 6, fontSize: 12 }}>
              新規商品: <strong>{bulkResult.new_products}</strong> 件
              新規出荷レコード: <strong>{bulkResult.inserted_records}</strong> 件
              既存レコード更新: <strong>{bulkResult.updated_records}</strong> 件
              スキップ: {bulkResult.skipped_rows} 件
            </div>
            {bulkResult.new_product_samples.length > 0 && (
              <div style={{ marginTop: 4, fontSize: 11 }}>
                新規商品の例:{' '}
                {bulkResult.new_product_samples.map((p) => (
                  <span key={p.product_code} style={{ marginRight: 8 }}>
                    <code>{p.product_code}</code> {p.name} (div={p.division})
                  </span>
                ))}
              </div>
            )}
            {bulkResult.updated_records > 0 && bulkResult.inserted_records === 0 && (
              <div className="muted" style={{ marginTop: 4, fontSize: 11 }}>
                ※ このファイルの内容はすでに登録済みでした。差分があれば更新されています。
              </div>
            )}
          </div>
        )}
      </div>

      <div className="panel">
        <div className="row">
          <div className="field" style={{ flex: 2 }}>
            <label>
              商品 (
              <span className="muted" style={{ fontWeight: 400 }}>
                {products.data?.length ?? 0} 件中から検索
              </span>
              )
            </label>
            <Combobox<ProductWithRecipe>
              items={products.data ?? []}
              getKey={(p) => p.product_id}
              getLabel={(p) =>
                `${p.product_code ?? '#' + p.product_id} | ` +
                `${DIVISION_LABEL[p.division] ?? p.division} | ` +
                `${p.classification_name ?? ''} ${p.name}` +
                (p.unit ? ` (${p.unit})` : '')}
              getSearchText={(p) =>
                `${p.product_code ?? ''} ${p.classification_name ?? ''} ${p.name} ${DIVISION_LABEL[p.division] ?? ''}`}
              value={productId}
              onChange={(v) => setProductId(v as number | null)}
              placeholder="商品コード or 名前で検索 (スペースで複数語 AND)"
              maxResults={60}
              onCreateNew={startCreate}
              createLabel={(q) => `➕ 「${q}」を新規商品として登録`}
            />
          </div>
          <div className="field">
            <label>出荷日</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="field">
            <label>数量（{selected?.unit ?? '単位'}）</label>
            <input
              type="number"
              step="0.0001"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
            />
          </div>
        </div>
        <div className="field">
          <label>備考（任意）</label>
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </div>

        {selected && qty && Number(qty) > 0 && selected.recipes.length > 0 && (
          <div className="alert info" style={{ marginBottom: 12 }}>
            <strong>自動消耗プレビュー:</strong>
            <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
              {selected.recipes.map((r) => (
                <li key={r.material_id}>
                  {r.material_code} {r.material_name}: −
                  {num(Number(r.quantity_per_unit) * Number(qty), 4)}{' '}
                  {r.material_unit ?? ''}
                </li>
              ))}
            </ul>
          </div>
        )}

        <button
          onClick={submit}
          disabled={busy || productId == null || !qty || Number(qty) <= 0}
        >
          {busy ? '登録中…' : '出荷を登録'}
        </button>
      </div>

      {/* 新規商品作成インラインフォーム */}
      {creating && (
        <div className="panel" style={{ borderColor: 'var(--primary)' }}>
          <h3>➕ 新規商品を作成</h3>
          <div className="row">
            <div className="field" style={{ flex: 2, minWidth: 240 }}>
              <label>商品名</label>
              <input
                value={creating.name}
                onChange={(e) => setCreating({ ...creating, name: e.target.value })}
                autoFocus
              />
            </div>
            <div className="field" style={{ minWidth: 140 }}>
              <label>事業部</label>
              <select
                value={creating.division}
                onChange={(e) => setCreating({ ...creating, division: Number(e.target.value) })}
              >
                {Object.entries(DIVISION_LABEL).map(([d, n]) => (
                  <option key={d} value={d}>{d}: {n}</option>
                ))}
              </select>
            </div>
            <div className="field" style={{ minWidth: 100 }}>
              <label>単位 (任意)</label>
              <input
                value={creating.unit}
                onChange={(e) => setCreating({ ...creating, unit: e.target.value })}
                placeholder="例: 個, 袋"
              />
            </div>
          </div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 8 }}>
            ※ 商品コード・分類・入数は後でレシピ編集や CSV インポートで補完できます
          </div>
          <div className="inline">
            <button onClick={saveCreate}
                    disabled={busy || !creating.name.trim()}>
              {busy ? '作成中…' : '作成して選択'}
            </button>
            <button className="ghost" onClick={() => setCreating(null)}>
              キャンセル
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
