import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../api/client'
import { useFetch } from '../lib/useFetch'
import { useDialog } from '../components/Dialog'
import { errorText, num, ymd } from '../lib/format'
import Combobox from '../components/Combobox'
import PackBreakdown from '../components/PackBreakdown'
import RowMenu, { useRowMenu } from '../components/RowMenu'
import type {
  MaterialMovementRow,
  MaterialStock,
  ProductWithRecipe,
  Supplier,
} from '../api/types'

interface RecipeTarget {
  product_id: number
  qty: string
  note: string
}

function currentMonthRange(): { from: string; to: string } {
  const now = new Date()
  const y = now.getFullYear(), m = now.getMonth()
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  return { from: fmt(new Date(y, m, 1)), to: fmt(new Date(y, m + 1, 0)) }
}

const DIVISION_LABEL: Record<number, string> = {
  0: '未割当', 1: '生姜', 2: '大蒜', 3: '長芋', 4: '牛蒡', 5: '薩摩芋', 6: '物流',
}
const COMMON_UNITS = ['枚', '個', '巻', '本', '袋', '箱', '袋', 'kg', 'ml']

function today() {
  return new Date().toISOString().slice(0, 10)
}

export default function MaterialInboundPage() {
  const dialog = useDialog()
  const materials = useFetch<MaterialStock[]>('/materials/stock',
    { include_unassigned: 'true' })
  // レシピ co-registration 用 (新規資材作成時に商品レシピへ一緒登録)
  const products = useFetch<ProductWithRecipe[]>('/shipments/products')
  // 仕入先マスタ — 新規資材作成時の Combobox ソース (migration 025 後は supplier_id を送る)
  const suppliers = useFetch<Supplier[]>('/masters/suppliers')

  // URL ?material_id= で初期選択 (資材一覧から「入荷登録」または「入出庫履歴」遷移用)
  const [searchParams, setSearchParams] = useSearchParams()
  const initialMaterialId = (() => {
    const v = searchParams.get('material_id')
    const n = v ? Number(v) : NaN
    return Number.isFinite(n) ? n : null
  })()

  const [materialId, setMaterialId] = useState<number | null>(initialMaterialId)
  const [date, setDate] = useState(today())
  const [qty, setQty] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // ===== 入出庫履歴 (デフォルト=当月分、事業部フィルタ可) =====
  const initialRange = useMemo(() => currentMonthRange(), [])
  const [histFrom, setHistFrom] = useState(initialRange.from)
  const [histTo,   setHistTo]   = useState(initialRange.to)
  const [histDivision, setHistDivision] = useState<string>('')
  const [histDirection, setHistDirection] = useState<'all' | 'in' | 'out'>('all')
  // ?material_id= 指定時は履歴も同資材に絞る (初回のみ)
  const [histMaterialId, setHistMaterialId] = useState<number | null>(initialMaterialId)
  const movements = useFetch<MaterialMovementRow[]>('/materials/movements', {
    date_from: histFrom, date_to: histTo,
    ...(histMaterialId != null ? { material_id: String(histMaterialId) } : {}),
    ...(histDivision ? { division: histDivision, include_unassigned: 'true' } : {}),
    ...(histDirection !== 'all' ? { direction: histDirection } : {}),
    limit: 500,
  })

  // 初期選択時に URL からクエリを除去 + 履歴セクションへスクロール (history=1 のとき)
  useEffect(() => {
    if (initialMaterialId != null && searchParams.has('material_id')) {
      const focusHistory = searchParams.get('focus') === 'history'
      const next = new URLSearchParams(searchParams)
      next.delete('material_id'); next.delete('focus')
      setSearchParams(next, { replace: true })
      if (focusHistory) {
        // 履歴セクションが描画されてからスクロール
        setTimeout(() => {
          const el = document.getElementById('material-movement-history')
          el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }, 200)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 履歴インライン編集
  interface MovEdit { movement_date: string; quantity: string; note: string }
  const [editMovId, setEditMovId] = useState<number | null>(null)
  const [editMov, setEditMov] = useState<MovEdit | null>(null)
  const [editMovBusy, setEditMovBusy] = useState(false)
  function startEditMov(mv: MaterialMovementRow) {
    setEditMovId(mv.id)
    setEditMov({
      movement_date: mv.movement_date.slice(0, 10),
      quantity: String(mv.quantity),
      note: mv.note ?? '',
    })
    setError(null)
  }
  function cancelEditMov() { setEditMovId(null); setEditMov(null); setEditMovErr(null) }
  const [editMovErr, setEditMovErr] = useState<string | null>(null)
  async function saveEditMov(id: number) {
    if (!editMov) return
    const q = Number(editMov.quantity)
    if (!Number.isFinite(q) || q === 0) {
      setEditMovErr('数量は 0 以外で入力してください'); return
    }
    setEditMovBusy(true); setEditMovErr(null)
    try {
      await api.patch(`/materials/movements/${id}`, {
        movement_date: editMov.movement_date,
        quantity: q,
        note: editMov.note || null,
      })
      setEditMovId(null); setEditMov(null); setEditMovErr(null)
      movements.reload(); materials.reload()
    } catch (e) {
      // インライン表示 (編集行下) と画面上部の両方に表示 (見落とし防止)
      const msg = errorText(e)
      setEditMovErr(msg)
      setError(msg)
    } finally { setEditMovBusy(false) }
  }
  async function deleteMov(mv: MaterialMovementRow) {
    if (!(await dialog.confirm({
      title: '資材入出庫を削除',
      message:
        `${ymd(mv.movement_date)} の ${mv.code} ${mv.item_name} `
        + `${Number(mv.quantity) > 0 ? '+' : ''}${num(mv.quantity, 1)} ${mv.unit ?? ''} を削除します。\n\n`
        + `この操作は資材の理論在庫に直接影響します。続行しますか？`,
      okLabel: '削除',
      variant: 'danger',
    }))) return
    setEditMovBusy(true); setEditMovErr(null)
    try {
      await api.delete(`/materials/movements/${mv.id}`)
      movements.reload(); materials.reload()
    } catch (e) {
      const msg = errorText(e)
      setEditMovErr(msg)
      setError(msg)
    } finally { setEditMovBusy(false) }
  }

  // 右クリック / ⋮ メニュー
  const navigate = useNavigate()
  const rowMenu = useRowMenu<MaterialMovementRow>()
  async function copyText(text: string) {
    try { await navigator.clipboard.writeText(text) } catch { /* */ }
  }

  // 新規資材作成モード (Combobox の onCreateNew で開く)
  const [creating, setCreating] = useState<{
    item_name: string;
    /** 仕入先 ID (suppliers マスタから選択時にセット)。null = 名前のみ (新規 or 未マッチ) */
    supplier_id: number | null;
    supplier_name: string;
    division: number; unit: string;
    /** 1ケース入り数 (任意、後から設定可) */
    pack_size: string;
    /** この資材を使う商品レシピを併せて登録 (作成と同じトランザクション風) */
    recipe_targets: RecipeTarget[];
    /** 共通 qty (各 target で空欄なら共通値を使う) */
    common_qty: string;
  } | null>(null)

  const selected = materials.data?.find((m) => m.material_id === materialId)

  function startCreate(typed: string) {
    setCreating({
      item_name: typed,
      supplier_id: null,
      supplier_name: '',
      division: 0,
      unit: '枚',
      pack_size: '',
      recipe_targets: [],
      common_qty: '1',
    })
  }

  async function saveCreate() {
    if (!creating || !creating.item_name.trim()) return
    setBusy(true); setError(null); setMsg(null)
    try {
      const created = await api.post<{ id: number; code: string; item_name: string }>(
        '/materials',
        {
          item_name: creating.item_name.trim(),
          // 仕入先: マスタから選んだなら supplier_id 優先、新規/未マッチなら名前
          ...(creating.supplier_id != null
            ? { supplier_id: creating.supplier_id }
            : { supplier_name: creating.supplier_name.trim() || '未指定' }),
          division: creating.division,
          unit: creating.unit || null,
          pack_size: creating.pack_size && Number(creating.pack_size) > 0
            ? Number(creating.pack_size) : null,
        },
      )

      // レシピ co-registration: 商品×qty が指定されていれば一括登録
      let recipeMsg = ''
      const validTargets = creating.recipe_targets.filter((t) => {
        const q = t.qty !== '' ? Number(t.qty) : Number(creating.common_qty)
        return Number.isFinite(q) && q > 0
      })
      if (validTargets.length > 0) {
        await api.put('/shipments/recipes/bulk', {
          material_id: created.id,
          action: 'set',
          quantity_per_unit: Number(creating.common_qty) || 1,
          items: validTargets.map((t) => ({
            product_id: t.product_id,
            quantity_per_unit: t.qty !== '' ? Number(t.qty) : null,
            note: t.note || null,
          })),
        })
        recipeMsg = ` / レシピも ${validTargets.length} 商品に登録`
      }

      await Promise.all([materials.reload(), products.reload()])
      setMaterialId(created.id)
      setMsg(`新規資材を作成しました: ${created.code} ${created.item_name}${recipeMsg}`)
      setCreating(null)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  async function submit(signMultiplier: 1 | -1) {
    if (materialId == null || !qty) return
    setBusy(true)
    setError(null)
    setMsg(null)
    try {
      const quantity = Number(qty) * signMultiplier
      await api.post('/materials/movements', {
        material_id: materialId,
        movement_date: date,
        quantity,
        note: note || null,
      })
      setMsg(
        `${selected?.code} に ${quantity > 0 ? '+' : ''}${quantity} ${selected?.unit ?? ''} を記録しました。`,
      )
      setQty('')
      setNote('')
      materials.reload()
      movements.reload()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <h2>資材 入荷・調整登録</h2>
      <p className="subtitle">
        資材の入荷や手動調整出庫を記録します。商品出荷からの自動消耗は別途
        商品出荷台帳側で自動連動します。
        新規資材は資材検索欄で名前を打ち、リスト末尾の「➕ 新規作成」から登録できます。
      </p>

      {error && <div className="alert error">{error}</div>}
      {msg && <div className="alert success">{msg}</div>}

      <div className="panel">
        <h3>入力</h3>
        <div className="row">
          <div className="field" style={{ flex: 2 }}>
            <label>
              資材 (
              <span className="muted" style={{ fontWeight: 400 }}>
                {materials.data?.length ?? 0} 件中から検索
              </span>
              )
            </label>
            <Combobox<MaterialStock>
              items={materials.data ?? []}
              getKey={(m) => m.material_id}
              getLabel={(m) =>
                `${m.code} | ${m.item_name}` +
                (m.unit ? ` (${m.unit})` : '') +
                (m.supplier_name && m.supplier_name !== '未指定' ? ` / ${m.supplier_name}` : '') +
                ` — 現在 ${num(m.remaining_qty, 1)} ${m.unit ?? ''}`}
              getSearchText={(m) =>
                `${m.code} ${m.item_name} ${m.supplier_name ?? ''} ${m.category ?? ''}`}
              value={materialId}
              onChange={(v) => setMaterialId(v as number | null)}
              placeholder="資材コード or 品目で検索 (スペースで複数語 AND)"
              maxResults={60}
              onCreateNew={startCreate}
              createLabel={(q) => `➕ 「${q}」を新規資材として登録`}
            />
          </div>
          <div className="field">
            <label>日付</label>
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
            {selected && (
              <div style={{ marginTop: 4 }}>
                <PackBreakdown
                  qty={qty}
                  unit={selected.unit}
                  packSize={selected.pack_size}
                  onSetPackSize={async (v) => {
                    await api.patch(`/materials/${selected.material_id}`, {
                      pack_size: v,
                    })
                    materials.reload()
                  }}
                />
              </div>
            )}
          </div>
        </div>
        <div className="field">
          <label>備考（任意）</label>
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <div className="inline">
          <button
            disabled={busy || materialId == null || !qty || Number(qty) <= 0}
            onClick={() => submit(1)}
          >
            入荷として登録（＋）
          </button>
          <button
            className="secondary"
            disabled={busy || materialId == null || !qty || Number(qty) <= 0}
            onClick={() => submit(-1)}
          >
            手動出庫として登録（−）
          </button>
        </div>
      </div>

      {/* 新規資材作成インラインフォーム */}
      {creating && (
        <div className="panel" style={{ borderColor: 'var(--primary)' }}>
          <h3>➕ 新規資材を作成</h3>
          <div className="row">
            <div className="field" style={{ flex: 2, minWidth: 240 }}>
              <label>品目名</label>
              <input
                value={creating.item_name}
                onChange={(e) => setCreating({ ...creating, item_name: e.target.value })}
                autoFocus
              />
            </div>
            <div className="field" style={{ flex: 2, minWidth: 200 }}>
              {(() => {
                // 仕入先マスタを正本に、追加で資材データ由来の品目数 hint を付与
                // (同事業部の materials だけで count、creating.division=0 のときは全体)
                const itemCountByName = (() => {
                  const counts = new Map<string, number>()
                  for (const m of materials.data ?? []) {
                    if (!m.supplier_name || m.supplier_name === '未指定') continue
                    if (creating.division !== 0 && m.division !== creating.division
                        && m.division !== 0) continue
                    counts.set(m.supplier_name, (counts.get(m.supplier_name) ?? 0) + 1)
                  }
                  return counts
                })()
                // suppliers マスタを源 + materials 由来で hint 付与。マスタに無くて
                // materials にだけある名前は、後ろ追加 (移行未完の表記揺れ用)
                const supplierOptions: { id: number | null; name: string; count: number }[] = []
                for (const s of suppliers.data ?? []) {
                  supplierOptions.push({
                    id: s.id, name: s.name, count: itemCountByName.get(s.name) ?? 0,
                  })
                }
                const masterNames = new Set(supplierOptions.map((o) => o.name))
                for (const [name, count] of itemCountByName) {
                  if (!masterNames.has(name)) {
                    supplierOptions.push({ id: null, name, count })
                  }
                }
                supplierOptions.sort((a, b) => b.count - a.count)

                return <>
                  <label>
                    仕入先 (任意)
                    <span className="muted" style={{ fontWeight: 400, fontSize: 11, marginLeft: 6 }}>
                      ({supplierOptions.length} 件 / マスタ {suppliers.data?.length ?? 0}
                      {creating.division !== 0
                        && `／品目数は ${DIVISION_LABEL[creating.division] ?? creating.division} の範囲`})
                    </span>
                  </label>
                  <Combobox<{ id: number | null; name: string; count: number }>
                    items={supplierOptions}
                    getKey={(s) => s.name}
                    getLabel={(s) => s.count > 0
                      ? `${s.name} (${s.count}品目)`
                      : s.name}
                    getSearchText={(s) => s.name}
                    value={creating.supplier_name || null}
                    onChange={(v) => {
                      const name = v != null ? String(v) : ''
                      const picked = supplierOptions.find((o) => o.name === name)
                      setCreating({
                        ...creating,
                        supplier_name: name,
                        supplier_id: picked?.id ?? null,
                      })
                    }}
                    placeholder="検索 (未登録名は「➕ 新規」で即作成)"
                    maxResults={40}
                    freeText
                    onCreateNew={(t) => setCreating({
                      ...creating, supplier_name: t, supplier_id: null,
                    })}
                    createLabel={(q) => `➕ 「${q}」を新規仕入先として登録`}
                  />
                </>
              })()}
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
              <label>単位</label>
              <select
                value={creating.unit}
                onChange={(e) => setCreating({ ...creating, unit: e.target.value })}
              >
                {COMMON_UNITS.map((u) => (
                  <option key={u} value={u}>{u}</option>
                ))}
              </select>
            </div>
            <div className="field" style={{ minWidth: 140 }}>
              <label>
                入り数 (1ケース) <span className="muted" style={{ fontWeight: 400 }}>任意</span>
              </label>
              <input
                type="number" step="1" min="0"
                value={creating.pack_size}
                onChange={(e) => setCreating({ ...creating, pack_size: e.target.value })}
                placeholder={`例: 3000 (${creating.unit}/C)`}
              />
            </div>
          </div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 8 }}>
            ※ 単価・入り数・1巻の長さ等は登録後、資材一覧画面でいつでも追加入力できます
            (空のまま登録 OK)。入り数は数量分解 (ケース+端数) の表示用ヘルパーで、
            在庫計算には影響しません。
          </div>

          {/* レシピ co-registration */}
          <div style={{
            marginTop: 8, padding: 10,
            background: 'var(--surface-soft, #f5f7fa)',
            borderRadius: 4, border: '1px dashed var(--border)',
          }}>
            <div style={{ marginBottom: 6, fontWeight: 600 }}>
              この資材を使う商品レシピも一緒に登録 (任意)
            </div>
            <div className="muted" style={{ fontSize: 11, marginBottom: 8 }}>
              ここで商品を選ぶと、新規資材を作成した後に
              「商品 1 点あたり {creating.common_qty || 1} {creating.unit}」のレシピが
              一括登録されます。商品ごとに個別 qty を指定することもできます。
              後から「商品⇄資材レシピ」画面でも編集可能です。
            </div>
            <div className="inline" style={{ marginBottom: 8 }}>
              <label style={{ fontSize: 12 }}>共通 qty</label>
              <input
                type="number" step="0.0001" min="0"
                value={creating.common_qty}
                onChange={(e) => setCreating(c => c && ({ ...c, common_qty: e.target.value }))}
                style={{ width: 100 }}
              />
              <span className="muted" style={{ fontSize: 11 }}>
                各商品で個別指定すれば、その値が優先されます
              </span>
            </div>

            {creating.recipe_targets.length > 0 && (
              <table style={{ marginBottom: 8 }}>
                <thead>
                  <tr>
                    <th>商品</th>
                    <th style={{ width: 120 }}>個別 qty (任意)</th>
                    <th>備考</th>
                    <th style={{ width: 40 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {creating.recipe_targets.map((t, idx) => {
                    const p = products.data?.find((x) => x.product_id === t.product_id)
                    return (
                      <tr key={t.product_id}>
                        <td style={{ fontSize: 12 }}>
                          <code>{p?.product_code ?? '#' + t.product_id}</code>
                          {' '}{p?.classification_name} {p?.name}
                        </td>
                        <td>
                          <input
                            type="number" step="0.0001" min="0"
                            value={t.qty}
                            placeholder={`共通 (${creating.common_qty})`}
                            onChange={(e) => setCreating(c => c && ({
                              ...c,
                              recipe_targets: c.recipe_targets.map((x, i) =>
                                i === idx ? { ...x, qty: e.target.value } : x),
                            }))}
                            style={{ width: '100%' }}
                          />
                        </td>
                        <td>
                          <input
                            value={t.note}
                            onChange={(e) => setCreating(c => c && ({
                              ...c,
                              recipe_targets: c.recipe_targets.map((x, i) =>
                                i === idx ? { ...x, note: e.target.value } : x),
                            }))}
                            placeholder="任意"
                          />
                        </td>
                        <td>
                          <button
                            className="ghost small"
                            onClick={() => setCreating(c => c && ({
                              ...c,
                              recipe_targets: c.recipe_targets.filter((_, i) => i !== idx),
                            }))}
                            title="この商品を外す"
                          >×</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}

            {/* 商品追加 */}
            {products.data && (() => {
              const usedIds = new Set(creating.recipe_targets.map((t) => t.product_id))
              // 事業部が選択済なら同事業部を優先表示 (creating.division=0 のときは全て)
              const candidates = products.data.filter((p) => !usedIds.has(p.product_id)
                && (creating.division === 0 || p.division === creating.division))
              return (
                <Combobox<ProductWithRecipe>
                  items={candidates}
                  getKey={(p) => p.product_id}
                  getLabel={(p) =>
                    `${p.product_code ?? '#' + p.product_id} | ` +
                    `${DIVISION_LABEL[p.division] ?? p.division} | ` +
                    `${p.classification_name ?? ''} ${p.name}`}
                  getSearchText={(p) =>
                    `${p.product_code ?? ''} ${p.classification_name ?? ''} ${p.name}`}
                  value={null}
                  onChange={(v) => {
                    if (v != null) {
                      setCreating(c => c && ({
                        ...c,
                        recipe_targets: [...c.recipe_targets,
                          { product_id: v as number, qty: '', note: '' }],
                      }))
                    }
                  }}
                  placeholder={creating.recipe_targets.length === 0
                    ? '商品を検索して追加 (スキップしても OK)'
                    : '更に追加…'}
                  maxResults={40}
                />
              )
            })()}
          </div>

          <div className="inline" style={{ marginTop: 10 }}>
            <button onClick={saveCreate}
                    disabled={busy || !creating.item_name.trim()}>
              {busy ? '作成中…'
                : creating.recipe_targets.length > 0
                  ? `作成 + レシピ ${creating.recipe_targets.length} 件登録`
                  : '作成して選択'}
            </button>
            <button className="ghost" onClick={() => setCreating(null)}>
              キャンセル
            </button>
          </div>
        </div>
      )}

      {/* ===== 入出庫履歴 (デフォルト=当月、事業部フィルタ可) ===== */}
      <div className="panel" id="material-movement-history">
        <h3>
          資材 入出庫履歴
          {histMaterialId != null && (() => {
            const m = materials.data?.find((x) => x.material_id === histMaterialId)
            return m ? (
              <span style={{
                marginLeft: 8, padding: '2px 8px', borderRadius: 8,
                background: 'var(--accent, #4a9eff)', color: '#fff',
                fontSize: 12, fontWeight: 500,
              }}>
                絞り込み中: {m.code} {m.item_name}
                <button type="button"
                  onClick={() => setHistMaterialId(null)}
                  style={{
                    background: 'none', border: 'none', color: '#fff',
                    cursor: 'pointer', marginLeft: 6, padding: 0,
                  }}
                  title="絞り込みを解除"
                >×</button>
              </span>
            ) : null
          })()}
        </h3>
        <p className="muted" style={{ fontSize: 11, marginTop: 0 }}>
          修正ルール: 備考は常に変更可。日付・数量の変更、および削除は
          「変更後も以降のどの日でも理論在庫が 0 を下回らない」場合のみ可
          (forward simulation で下流の出庫/商品出荷自動消耗との整合性を検証)。
        </p>
        <div className="inline" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
          <div className="field" style={{ minWidth: 150 }}>
            <label>開始日</label>
            <input type="date" value={histFrom}
              onChange={(e) => setHistFrom(e.target.value)} />
          </div>
          <div className="field" style={{ minWidth: 150 }}>
            <label>終了日</label>
            <input type="date" value={histTo}
              onChange={(e) => setHistTo(e.target.value)} />
          </div>
          <div className="field" style={{ minWidth: 160 }}>
            <label>事業部</label>
            <select value={histDivision}
              onChange={(e) => setHistDivision(e.target.value)}
              style={{ width: 160 }}>
              <option value="">全事業部</option>
              {Object.entries(DIVISION_LABEL).filter(([d]) => d !== '0').map(([d, n]) => (
                <option key={d} value={d}>{d}: {n}</option>
              ))}
            </select>
          </div>
          <div className="field" style={{ minWidth: 120 }}>
            <label>方向</label>
            <select value={histDirection}
              onChange={(e) => setHistDirection(e.target.value as typeof histDirection)}
              style={{ width: 120 }}>
              <option value="all">入荷+出庫</option>
              <option value="in">入荷のみ</option>
              <option value="out">出庫のみ</option>
            </select>
          </div>
          <button type="button" className="ghost small"
            style={{ alignSelf: 'flex-end' }}
            onClick={() => {
              const r = currentMonthRange()
              setHistFrom(r.from); setHistTo(r.to)
            }}
          >当月に戻す</button>
          <span className="muted" style={{ alignSelf: 'flex-end', fontSize: 12 }}>
            {movements.loading ? '読み込み中…'
              : `${movements.data?.length ?? 0} 件`}
          </span>
        </div>
        {histDivision && (
          <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
            ※「事業部 {histDivision}: {DIVISION_LABEL[Number(histDivision)]}」
            の資材 + 事業部0(未割当)を含む
          </div>
        )}
        {movements.error && <div className="alert error">{movements.error}</div>}
        {movements.data && movements.data.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>日付</th>
                <th>整理番号</th>
                <th>仕入先</th>
                <th>品目</th>
                <th>事業部</th>
                <th className="num">数量</th>
                <th>備考</th>
                <th>担当</th>
                <th style={{ width: 90 }}></th>
              </tr>
            </thead>
            <tbody>
              {movements.data.map((mv) => {
                const q = Number(mv.quantity)
                const isIn = q > 0
                const editing = editMovId === mv.id && editMov != null
                if (editing && editMov) return (
                  <tr key={mv.id} style={{ background: 'var(--accent-bg, #e8f4fd)' }}>
                    <td>
                      <input type="date" value={editMov.movement_date}
                        onChange={(e) => setEditMov({ ...editMov, movement_date: e.target.value })}
                        style={{ width: 130, fontSize: 12 }}/>
                    </td>
                    <td><code>{mv.code}</code></td>
                    <td>{mv.supplier_name}</td>
                    <td>{mv.item_name}</td>
                    <td>
                      {mv.division === 0
                        ? <span className="muted">未割当</span>
                        : (DIVISION_LABEL[mv.division] ?? mv.division)}
                    </td>
                    <td className="num">
                      <input type="number" step="0.0001" value={editMov.quantity}
                        onChange={(e) => setEditMov({ ...editMov, quantity: e.target.value })}
                        placeholder="正=入荷 負=出庫"
                        style={{ width: 100, fontSize: 12, padding: '2px 4px' }}/>
                      <span className="muted" style={{ fontSize: 11, marginLeft: 2 }}>
                        {mv.unit ?? ''}
                      </span>
                    </td>
                    <td colSpan={2}>
                      <div>
                        <input value={editMov.note}
                          onChange={(e) => setEditMov({ ...editMov, note: e.target.value })}
                          placeholder="備考"
                          style={{ width: '55%', fontSize: 12, padding: '2px 4px' }}/>
                        <button type="button" className="small" disabled={editMovBusy}
                          onClick={() => saveEditMov(mv.id)}
                          style={{ marginLeft: 4, padding: '2px 8px' }}>
                          {editMovBusy ? '保存中…' : '✓ 保存'}
                        </button>
                        <button type="button" className="ghost small" disabled={editMovBusy}
                          onClick={cancelEditMov}
                          style={{ marginLeft: 2, padding: '2px 8px' }}>×</button>
                      </div>
                      {editMovErr && editMovId === mv.id && (
                        <div style={{
                          marginTop: 4, padding: '4px 8px',
                          background: 'var(--surface-error, #fdecea)',
                          border: '1px solid var(--danger, #c0392b)',
                          color: 'var(--danger, #c0392b)',
                          borderRadius: 4, fontSize: 11,
                        }}>
                          ❌ {editMovErr}
                        </div>
                      )}
                    </td>
                  </tr>
                )
                return (
                  <tr key={mv.id}
                    onContextMenu={(e) => rowMenu.openAt(e, mv)}
                    style={{ cursor: 'context-menu' }}
                  >
                    <td>{ymd(mv.movement_date)}</td>
                    <td><code>{mv.code}</code></td>
                    <td>{mv.supplier_name}</td>
                    <td>{mv.item_name}</td>
                    <td>
                      {mv.division === 0
                        ? <span className="muted">未割当</span>
                        : (DIVISION_LABEL[mv.division] ?? mv.division)}
                    </td>
                    <td className="num" style={{
                      fontWeight: 600,
                      color: isIn ? 'var(--ok)' : 'var(--danger, #c0392b)',
                    }}>
                      {isIn ? '+' : ''}{num(mv.quantity, 1)} {mv.unit ?? ''}
                    </td>
                    <td>{mv.note ?? ''}</td>
                    <td>{mv.created_by_name ?? '—'}</td>
                    <td>
                      <span className="inline" style={{ gap: 2 }}>
                        <button type="button" className="ghost small"
                          onClick={() => startEditMov(mv)}
                          style={{ padding: '2px 6px', fontSize: 11 }}
                          title="この記録を修正"
                        >✎</button>
                        <button type="button" className="ghost small"
                          onClick={() => deleteMov(mv)}
                          style={{ padding: '2px 6px', fontSize: 11, color: 'var(--danger, #c0392b)' }}
                          title="この記録を取り消し"
                        >🗑</button>
                        {rowMenu.triggerButton(mv, 'その他の操作')}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        {movements.data && movements.data.length === 0 && !movements.loading && (
          <div className="muted">この期間に入出庫履歴はありません。</div>
        )}
      </div>

      <RowMenu<MaterialMovementRow>
        state={rowMenu.state}
        onClose={rowMenu.close}
        items={(mv) => [
          {
            icon: '✎', label: 'この記録を修正',
            onClick: () => startEditMov(mv),
          },
          {
            icon: '🗑', label: 'この記録を削除', danger: true,
            onClick: () => deleteMov(mv),
          },
          { divider: true,
            icon: '📜', label: `この資材 (${mv.code}) の履歴のみ表示`,
            onClick: () => setHistMaterialId(mv.material_id),
          },
          {
            icon: '📋', label: 'この資材のレシピ一括編集',
            onClick: () => navigate(`/shipments/recipes/bulk?material_id=${mv.material_id}`),
          },
          {
            icon: '📊', label: '資材一覧で見る',
            onClick: () => navigate('/materials'),
          },
          { divider: true,
            icon: '🔢', label: `整理番号 ${mv.code} をコピー`,
            onClick: () => copyText(mv.code),
          },
        ]}
      />
    </div>
  )
}
