import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import { useFetch } from '../lib/useFetch'
import { useDialog } from '../components/Dialog'
import { errorText, num, yen, ymd } from '../lib/format'
import RowMenu, { useRowMenu } from '../components/RowMenu'
import type { MaterialStock } from '../api/types'

const DIVISION_LABEL: Record<number, string> = {
  0: '未割当', 1: '生姜', 2: '大蒜', 3: '長芋', 4: '牛蒡', 5: '薩摩芋', 6: '物流',
}

/** 差異率に応じた色強調クラス (理論 vs 棚卸). */
function discrepancyClass(theoretical: number, actual: number): string {
  if (theoretical === 0) return actual === 0 ? '' : 'discr-mid'
  const rate = Math.abs((actual - theoretical) / theoretical)
  if (rate <= 0.03) return ''            // ±3%以内は無色
  if (rate <= 0.10) return 'discr-mid'   // 3-10% 淡黄
  return 'discr-large'                    // >10% 淡赤
}

export default function MaterialsStockPage() {
  const dialog = useDialog()
  const [division, setDivision] = useState<string>('')
  const [includeUnassigned, setIncludeUnassigned] = useState(true)
  const [recipeFilter, setRecipeFilter] = useState<'all' | 'has' | 'none'>('all')
  const [categoryFilter, setCategoryFilter] = useState<string>('')

  // 単価インライン編集
  const [priceEdits, setPriceEdits] = useState<Record<number, string>>({})
  const [savingPriceId, setSavingPriceId] = useState<number | null>(null)
  const [priceMsg, setPriceMsg] = useState<string | null>(null)

  // 入り数インライン編集
  const [packEdits, setPackEdits] = useState<Record<number, string>>({})
  const [savingPackId, setSavingPackId] = useState<number | null>(null)

  // 1巻あたりの長さインライン編集 (cm) — unit が 巻/本 の資材のみ
  const [lengthEdits, setLengthEdits] = useState<Record<number, string>>({})
  const [savingLengthId, setSavingLengthId] = useState<number | null>(null)

  async function savePrice(materialId: number) {
    const raw = priceEdits[materialId]
    if (raw === undefined) return
    const val = raw === '' ? null : Number(raw)
    if (val !== null && (!Number.isFinite(val) || val < 0)) {
      setPriceMsg('単価は 0 以上の数値を入力してください')
      return
    }
    setSavingPriceId(materialId)
    setPriceMsg(null)
    try {
      await api.patch(`/materials/${materialId}`, { unit_price: val })
      setPriceEdits((p) => { const n = { ...p }; delete n[materialId]; return n })
      stockAll.reload()
      setPriceMsg('単価を更新しました')
    } catch (e) {
      setPriceMsg(errorText(e))
    } finally {
      setSavingPriceId(null)
    }
  }

  async function savePack(materialId: number) {
    const raw = packEdits[materialId]
    if (raw === undefined) return
    const val = raw === '' ? 0 : Number(raw)   // 0 で NULL に戻す
    if (!Number.isFinite(val) || val < 0) {
      setPriceMsg('入り数は 0 以上の数値を入力してください (0=未設定)')
      return
    }
    setSavingPackId(materialId)
    setPriceMsg(null)
    try {
      await api.patch(`/materials/${materialId}`, { pack_size: val })
      setPackEdits((p) => { const n = { ...p }; delete n[materialId]; return n })
      stockAll.reload()
      setPriceMsg('入り数を更新しました')
    } catch (e) {
      setPriceMsg(errorText(e))
    } finally {
      setSavingPackId(null)
    }
  }

  /** 1巻 (or 1本) あたりの長さを保存。 0/空欄で長さ管理解除 (= NULL)。
   * バックエンドの PATCH /materials/{id} は length_per_roll_cm=0 を NULL に変換する。 */
  async function saveLength(materialId: number) {
    const raw = lengthEdits[materialId]
    if (raw === undefined) return
    const val = raw === '' ? 0 : Number(raw)
    if (!Number.isFinite(val) || val < 0) {
      setPriceMsg('長さは 0 以上の数値を入力してください (0=長さ管理解除)')
      return
    }
    setSavingLengthId(materialId)
    setPriceMsg(null)
    try {
      await api.patch(`/materials/${materialId}`, { length_per_roll_cm: val })
      setLengthEdits((p) => { const n = { ...p }; delete n[materialId]; return n })
      stockAll.reload()
      setPriceMsg(val > 0 ? `長さを ${val}cm に更新しました` : '長さ管理を解除しました')
    } catch (e) {
      setPriceMsg(errorText(e))
    } finally {
      setSavingLengthId(null)
    }
  }

  // 削除 (参照あり時は backend が 409 を返す → 詳細を表示)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  async function deleteMaterial(m: { material_id: number; code: string; item_name: string }) {
    if (!(await dialog.confirm({
      title: '資材を削除',
      message:
        `資材「${m.code} ${m.item_name}」を完全に削除します。\n\n`
        + `※ 入出庫履歴・棚卸・レシピ・配置のいずれかが残っているとサーバ側で拒否されます。\n`
        + `※ 削除すると元に戻せません。`,
      okLabel: '削除',
      variant: 'danger',
    }))) return
    setDeletingId(m.material_id); setPriceMsg(null)
    try {
      await api.delete(`/materials/${m.material_id}`)
      stockAll.reload()
      setPriceMsg(`資材「${m.code} ${m.item_name}」を削除しました`)
    } catch (e) {
      setPriceMsg(errorText(e))
    } finally {
      setDeletingId(null)
    }
  }

  // 右クリックメニュー (行ごと)
  const navigate = useNavigate()
  const menu = useRowMenu<MaterialStock>()

  const params: Record<string, string> = {}
  if (division) {
    params.division = division
    params.include_unassigned = includeUnassigned ? 'true' : 'false'
  }
  const stockAll = useFetch<MaterialStock[]>('/materials/stock', params)
  // クライアント側フィルタ (レシピ登録有無 + カテゴリ)
  const stock = {
    ...stockAll,
    data: stockAll.data?.filter((m) => {
      if (recipeFilter === 'has' && m.recipe_product_count === 0) return false
      if (recipeFilter === 'none' && m.recipe_product_count > 0) return false
      if (categoryFilter === '__none__' && m.category) return false
      if (categoryFilter && categoryFilter !== '__none__' && m.category !== categoryFilter) return false
      return true
    }),
  }

  // カテゴリ別件数 = 現在の (事業部 + レシピ) 条件下での件数 (カテゴリフィルタ自体は除外)
  // → ドロップダウンの (数字) が画面の絞り込みと一致して見える
  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>()
    let unassignedCount = 0
    for (const m of stockAll.data ?? []) {
      if (recipeFilter === 'has' && m.recipe_product_count === 0) continue
      if (recipeFilter === 'none' && m.recipe_product_count > 0) continue
      if (m.category) counts.set(m.category, (counts.get(m.category) ?? 0) + 1)
      else unassignedCount++
    }
    return {
      list: Array.from(counts.entries())
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => a.category.localeCompare(b.category)),
      unassignedCount,
    }
  }, [stockAll.data, recipeFilter])

  // 集計
  let totalValue = 0
  let pricedCount = 0
  let countedComplete = 0
  let countedIncomplete = 0
  let neverCounted = 0
  let recipeRegistered = 0
  let recipeUnregistered = 0
  if (stock.data) {
    for (const m of stock.data) {
      if (m.stock_value != null) {
        totalValue += Number(m.stock_value)
        pricedCount++
      }
      if (m.latest_count_date == null) neverCounted++
      else if (m.latest_count_complete) countedComplete++
      else countedIncomplete++
      if (m.recipe_product_count > 0) recipeRegistered++
      else recipeUnregistered++
    }
  }

  return (
    <div>
      <h2>資材一覧</h2>
      <p className="subtitle">
        <strong>理論在庫</strong> = 起点 (前回棚卸) + 以降の入出庫 + 商品出荷自動消耗 /
        <strong> 棚卸在庫</strong> = 直近の有効棚卸日の合計値 /
        <strong> 差異</strong> = 棚卸日時点の理論在庫 − 棚卸値
        (その日「ズレていた量」、ズレが大きいほど強調表示)。
      </p>

      <div className="panel">
        <div className="inline" style={{ marginBottom: 12 }}>
          <div>
            <label>事業部</label>
            <select
              value={division}
              onChange={(e) => setDivision(e.target.value)}
              style={{ width: 160 }}
            >
              <option value="">全事業部</option>
              {Object.entries(DIVISION_LABEL).filter(([d]) => d !== '0').map(([d, n]) => (
                <option key={d} value={d}>{d}: {n}</option>
              ))}
            </select>
          </div>
          {division && (
            <label className="inline" style={{ fontSize: 12, gap: 4 }}>
              <input
                type="checkbox"
                checked={includeUnassigned}
                onChange={(e) => setIncludeUnassigned(e.target.checked)}
              />
              未割当 (事業部0) も含める
            </label>
          )}
          {division && (
            <button className="ghost small" onClick={() => setDivision('')}>
              クリア
            </button>
          )}
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
          <div>
            <label>カテゴリ</label>
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              style={{ width: 180 }}
              title="件数は「現在の事業部・レシピ絞り込み下での件数」です"
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
        </div>
        {stock.error && <div className="alert error">{stock.error}</div>}
      {priceMsg && <div className="alert info" style={{ marginBottom: 8 }}>{priceMsg}</div>}
        {stock.loading && <div className="muted">読み込み中…</div>}
        {stock.data && (
          <>
            <div className="cards" style={{ marginBottom: 16 }}>
              <div className="card">
                <div className="label">資材点数</div>
                <div className="value">{stock.data.length}</div>
              </div>
              <div className="card">
                <div className="label">棚卸 (有効/未完了/未実施)</div>
                <div className="value" style={{ fontSize: 18 }}>
                  <span style={{ color: 'var(--ok)' }}>{countedComplete}</span>
                  {' / '}
                  <span style={{ color: 'var(--warn)' }}>{countedIncomplete}</span>
                  {' / '}
                  <span className="muted">{neverCounted}</span>
                </div>
              </div>
              <div className="card">
                <div className="label">レシピ登録 (登録済/未登録)</div>
                <div className="value" style={{ fontSize: 18 }}>
                  <span style={{ color: 'var(--ok)' }}>{recipeRegistered}</span>
                  {' / '}
                  <span style={{ color: 'var(--warn)' }}>{recipeUnregistered}</span>
                </div>
              </div>
              <div className="card card-accent">
                <div className="label">在庫評価額 合計 (理論)</div>
                <div className="value" style={{ color: 'var(--primary)' }}>{yen(totalValue)}</div>
              </div>
            </div>
            <table className="sticky-head">
              <thead>
                <tr>
                  <th>整理番号</th>
                  <th>仕入先</th>
                  <th>品目</th>
                  <th>単位</th>
                  <th className="num" title="単位が 巻/本 の資材のみ設定可。 cm 値が消費レシピと連動">
                    長さ<br/>(cm/巻)
                  </th>
                  <th className="num">入り数<br/>(1C)</th>
                  <th className="num">理論在庫</th>
                  <th className="num">棚卸在庫</th>
                  <th>棚卸日</th>
                  <th className="num">差異 (棚卸日時点)</th>
                  <th className="num">レシピ</th>
                  <th className="num">単価</th>
                  <th className="num">評価額</th>
                  <th style={{ width: 50 }}></th>
                </tr>
              </thead>
              <tbody>
                {stock.data.map((m) => {
                  const actual = m.actual_qty != null ? Number(m.actual_qty) : null
                  // 差異 = 棚卸日時点の理論在庫 − 棚卸値 (= 「その日にズレていた量」)
                  // 前回棚卸が無いと theoretical_at_count_date は null → 差異も null
                  const theoryAtCount = m.theoretical_at_count_date != null
                    ? Number(m.theoretical_at_count_date) : null
                  const diff = (actual != null && theoryAtCount != null)
                    ? actual - theoryAtCount : null
                  const diffPct = (diff != null && theoryAtCount !== null && theoryAtCount !== 0)
                    ? (diff / theoryAtCount) * 100 : null
                  const cls = (actual != null && theoryAtCount != null)
                    ? discrepancyClass(theoryAtCount, actual) : ''
                  return (
                    <tr key={m.material_id}
                      onContextMenu={(e) => menu.openAt(e, m)}
                      style={{
                        cursor: 'context-menu',
                      }}
                    >
                      <td>
                        {/* 孤児資材マーク: 商品紐付け 無し かつ 非一般消耗品 */}
                        {m.recipe_product_count === 0 && !m.is_general_supply && (
                          <span
                            title="孤児資材 — 商品にも紐づかず、 一般消耗品 でもない。 アンケートで 設定 してください"
                            style={{
                              display: 'inline-block', marginRight: 4,
                              padding: '0 6px', fontSize: 11, fontWeight: 700,
                              background: '#ff8a00', color: '#fff',
                              borderRadius: 3, verticalAlign: 'middle',
                            }}
                          >⚠ 孤児</span>
                        )}
                        <code>{m.code}</code>
                      </td>
                      <td>{m.supplier_name}</td>
                      <td>{m.item_name}</td>
                      <td>{m.unit ?? '—'}</td>
                      {/* 長さ — unit が 巻/本 の場合のみ編集可、 それ以外は "—" */}
                      <td className="num" style={{ minWidth: 80 }}>
                        {(m.unit === '巻' || m.unit === '本') ? (
                          lengthEdits[m.material_id] !== undefined ? (
                            <span className="inline" style={{ gap: 2, justifyContent: 'flex-end' }}>
                              <input
                                type="number" step="1" min="0"
                                value={lengthEdits[m.material_id]}
                                onChange={(e) => setLengthEdits((p) => ({
                                  ...p, [m.material_id]: e.target.value,
                                }))}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') saveLength(m.material_id)
                                  if (e.key === 'Escape') setLengthEdits((p) => {
                                    const n = { ...p }; delete n[m.material_id]; return n
                                  })
                                }}
                                style={{ width: 60, padding: '2px 4px', fontSize: 12 }}
                                autoFocus
                                disabled={savingLengthId === m.material_id}
                                placeholder="0=解除"
                              />
                              <button
                                className="ghost small"
                                onClick={() => saveLength(m.material_id)}
                                disabled={savingLengthId === m.material_id}
                                title="保存 (Enter)"
                                style={{ padding: '2px 6px' }}
                              >✓</button>
                            </span>
                          ) : (
                            <span
                              onClick={() => setLengthEdits((p) => ({
                                ...p,
                                [m.material_id]: m.length_per_roll_cm
                                  ? String(m.length_per_roll_cm) : '',
                              }))}
                              style={{ cursor: 'pointer' }}
                              title={m.length_per_roll_cm
                                ? `クリックで変更 (現在: 1${m.unit} = ${num(m.length_per_roll_cm, 0)}cm)`
                                : `1${m.unit} あたりの長さを cm で設定 (レシピで cm 値を使う場合に必要)`}
                            >
                              {m.length_per_roll_cm ? (
                                <>{num(m.length_per_roll_cm, 0)}cm <span className="muted" style={{ fontSize: 10 }}>✎</span></>
                              ) : (
                                <span className="muted" style={{ fontStyle: 'italic', fontSize: 11 }}>
                                  未設定 ✎
                                </span>
                              )}
                            </span>
                          )
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="num" style={{ minWidth: 90 }}>
                        {packEdits[m.material_id] !== undefined ? (
                          <span className="inline" style={{ gap: 2, justifyContent: 'flex-end' }}>
                            <input
                              type="number" step="1" min="0"
                              value={packEdits[m.material_id]}
                              onChange={(e) => setPackEdits((p) => ({
                                ...p, [m.material_id]: e.target.value,
                              }))}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') savePack(m.material_id)
                                if (e.key === 'Escape') setPackEdits((p) => {
                                  const n = { ...p }; delete n[m.material_id]; return n
                                })
                              }}
                              style={{ width: 60, padding: '2px 4px', fontSize: 12 }}
                              autoFocus
                              disabled={savingPackId === m.material_id}
                              placeholder="0=解除"
                            />
                            <button
                              className="ghost small"
                              onClick={() => savePack(m.material_id)}
                              disabled={savingPackId === m.material_id}
                              title="保存 (Enter)"
                              style={{ padding: '2px 6px' }}
                            >✓</button>
                          </span>
                        ) : (
                          <span
                            onClick={() => setPackEdits((p) => ({
                              ...p,
                              [m.material_id]: m.pack_size ? String(m.pack_size) : '',
                            }))}
                            style={{ cursor: 'pointer' }}
                            title={m.pack_size
                              ? `クリックで変更 (現在: 1ケース = ${num(m.pack_size, 0)} ${m.unit ?? ''})`
                              : '入り数を設定 (任意・表示用ヘルパー)'}
                          >
                            {m.pack_size ? (
                              <>{num(m.pack_size, 0)} {m.unit ?? ''} <span className="muted" style={{ fontSize: 10 }}>✎</span></>
                            ) : (
                              <span className="muted" style={{ fontStyle: 'italic', fontSize: 11 }}>
                                未設定 ✎
                              </span>
                            )}
                          </span>
                        )}
                      </td>
                      <td className="num" style={{ fontWeight: 600 }}>
                        {num(m.remaining_qty, 1)} {m.unit ?? ''}
                      </td>
                      <td className="num">
                        {actual != null ? (
                          <span style={{ fontWeight: 600 }}>{num(actual, 1)} {m.unit ?? ''}</span>
                        ) : m.latest_count_date ? (
                          <span className="muted" title="棚卸未完了 (一部 object のみ計上)">
                            未完了 {m.counted_object_n}/{m.linked_object_count}
                          </span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        {ymd(m.latest_count_date)}
                      </td>
                      <td className={'num ' + cls}>
                        {diff != null ? (
                          <>
                            <span>{diff > 0 ? '+' : ''}{num(diff, 1)}</span>
                            {diffPct != null && (
                              <span className="muted" style={{ fontSize: 11, marginLeft: 4 }}>
                                ({diffPct > 0 ? '+' : ''}{diffPct.toFixed(1)}%)
                              </span>
                            )}
                          </>
                        ) : actual != null ? (
                          <span className="muted" title="前回棚卸が無いため差異計算不可">
                            初回棚卸
                          </span>
                        ) : <span className="muted">—</span>}
                      </td>
                      <td className="num">
                        {m.recipe_product_count > 0 ? (
                          <span title={
                            m.recipe_estimated_count > 0
                              ? `${m.recipe_product_count} 商品で使用 (うち ${m.recipe_estimated_count} 件が推定モード)`
                              : `${m.recipe_product_count} 商品で使用`
                          }>
                            <strong>{m.recipe_product_count}</strong>
                            {m.recipe_estimated_count > 0 && (
                              <span className="muted" style={{ fontSize: 10, marginLeft: 2 }}>
                                (~{m.recipe_estimated_count})
                              </span>
                            )}
                          </span>
                        ) : (
                          <span className="muted" title="どの商品レシピでも使われていない">未登録</span>
                        )}
                      </td>
                      <td className="num" style={{ minWidth: 110 }}>
                        {priceEdits[m.material_id] !== undefined ? (
                          <span className="inline" style={{ gap: 2, justifyContent: 'flex-end' }}>
                            <input
                              type="number" step="0.01" min="0"
                              value={priceEdits[m.material_id]}
                              onChange={(e) => setPriceEdits((p) => ({
                                ...p, [m.material_id]: e.target.value,
                              }))}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') savePrice(m.material_id)
                                if (e.key === 'Escape') setPriceEdits((p) => {
                                  const n = { ...p }; delete n[m.material_id]; return n
                                })
                              }}
                              style={{ width: 70, padding: '2px 4px', fontSize: 12 }}
                              autoFocus
                              disabled={savingPriceId === m.material_id}
                            />
                            <button
                              className="ghost small"
                              onClick={() => savePrice(m.material_id)}
                              disabled={savingPriceId === m.material_id}
                              title="保存 (Enter)"
                              style={{ padding: '2px 6px' }}
                            >✓</button>
                          </span>
                        ) : (
                          <span
                            onClick={() => setPriceEdits((p) => ({
                              ...p,
                              [m.material_id]: m.unit_price ? String(m.unit_price) : '',
                            }))}
                            style={{ cursor: 'pointer' }}
                            title="クリックで単価編集"
                          >
                            {m.unit_price ? yen(m.unit_price) : (
                              <span className="muted" style={{ fontStyle: 'italic' }}>
                                未入力 ✎
                              </span>
                            )}
                          </span>
                        )}
                      </td>
                      <td className="num" style={{ fontWeight: 600 }}>
                        {m.stock_value != null ? yen(m.stock_value) : <span className="muted">—</span>}
                      </td>
                      <td>
                        <span className="inline" style={{ gap: 2 }}>
                          <button
                            type="button"
                            className="ghost small"
                            onClick={() => deleteMaterial(m)}
                            disabled={deletingId === m.material_id}
                            style={{
                              padding: '2px 6px', fontSize: 11,
                              color: 'var(--danger, #c0392b)',
                            }}
                            title="この資材を削除 (参照ありは拒否)"
                          >🗑</button>
                          {menu.triggerButton(m, 'メニュー (右クリックでも開きます)')}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={11} style={{ fontWeight: 600 }}>合計</td>
                  <td className="num" style={{ fontWeight: 700, fontSize: '1.05em' }}>
                    {yen(totalValue)}
                  </td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </>
        )}
      </div>

      <RowMenu<MaterialStock>
        state={menu.state}
        onClose={menu.close}
        items={(m) => [
          {
            icon: '📋', label: 'レシピ一括編集を開く',
            onClick: () => navigate(`/shipments/recipes/bulk?material_id=${m.material_id}`),
            title: 'この資材を起点に、複数商品のレシピを一括登録/編集',
          },
          {
            icon: '📜', label: '入出庫履歴を見る',
            onClick: () => navigate(`/materials/inbound?material_id=${m.material_id}&focus=history`),
          },
          {
            icon: '📥', label: '入荷/出庫を記録 (新規)',
            onClick: () => navigate(`/materials/inbound?material_id=${m.material_id}`),
          },
          {
            icon: '📦', label: '置き場で棚卸 (レイアウト)',
            onClick: () => navigate('/storage/material'),
          },
          { divider: true,
            icon: '✎', label: '単価を編集',
            onClick: () => setPriceEdits((p) => ({
              ...p, [m.material_id]: m.unit_price ? String(m.unit_price) : '',
            })),
          },
          {
            icon: '✎', label: '入り数を編集',
            onClick: () => setPackEdits((p) => ({
              ...p, [m.material_id]: m.pack_size ? String(m.pack_size) : '',
            })),
          },
          ...((m.unit === '巻' || m.unit === '本') ? [{
            icon: '✎', label: '1' + m.unit + 'あたりの長さを編集 (cm)',
            onClick: () => setLengthEdits((p) => ({
              ...p, [m.material_id]: m.length_per_roll_cm ? String(m.length_per_roll_cm) : '',
            })),
            title: '長さを設定するとレシピの cm 指定が消費量に変換されます',
          }] : []),
          { divider: true,
            icon: '🗑', label: '削除 (参照無し時のみ)',
            danger: true,
            disabled: deletingId === m.material_id,
            onClick: () => deleteMaterial(m),
            title: '入出庫履歴・棚卸・レシピ・配置のいずれも無い資材のみ削除可能',
          },
        ]}
      />
    </div>
  )
}
