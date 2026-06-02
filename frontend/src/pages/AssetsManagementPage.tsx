/**
 * AssetsManagementPage — 固定資産 (コンテナ・パレット・スチール) 管理 ハブ
 *
 * 構成:
 *   上部: 種別タブ (コンテナ / パレット / スチール)
 *   下部: サブタブ
 *     - 在庫一覧 (holdings)  — 各 (ロゴ × 規格) の 理論値
 *     - 移動履歴 (movements)
 *     - 貸出中 (open loans)
 *     - 棚卸 (stocktakes)
 *     - レイアウト+エリア (P5 で 追加予定 — 現在 placeholder)
 *
 * URL: /assets?type=<id>&tab=<id>
 *   両方とも URL クエリ で 維持 → リロード/共有 OK
 */
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api/client'
import { useFetch } from '../lib/useFetch'
import { useDialog } from '../components/Dialog'
import { ErrorBanner, LoadingState } from '../components/StatusDisplay'
import { errorText, num, ymd } from '../lib/format'

// ============================================================================
// 型定義 (API response と一致)
// ============================================================================
interface AssetType {
  id: number
  code: string
  name: string
  sort_order: number
}

interface HoldingRow {
  asset_type_id: number
  asset_type_name: string
  logo_id: number
  logo_name: string
  category_id: number
  category_name: string
  base_date: string | null
  base_qty: number
  movements_since: number
  theoretical_qty: number
  lent_out_qty: number
  total_purchased: number
  estimated_borrow_diff: number
}

interface AssetLogo { id: number; asset_type_id: number; name: string; sort_order: number; is_active: boolean }
interface AssetCategory { id: number; asset_type_id: number; name: string; is_default: boolean; sort_order: number }
interface Counterparty { id: number; name: string; kind: string }

interface Movement {
  id: number
  asset_type_id: number
  logo_id: number
  category_id: number
  movement_date: string
  kind: string
  qty: number
  counterparty_id: number | null
  counterparty_name: string | null
  division_code: number | null
  loan_id: number | null
  note: string | null
  created_at: string
}

interface LoanOpen {
  id: number
  asset_type_id: number
  logo_id: number
  logo_name: string
  category_id: number
  category_name: string
  counterparty_id: number
  counterparty_name: string
  division_code: number | null
  qty: number
  lent_at: string
  days_lent: number
  note: string | null
}

const KIND_LABEL: Record<string, string> = {
  stocktake: '棚卸調整',
  loan_out:  '貸出',
  loan_in:   '返却',
  in:        '入庫',
  out:       '廃棄',
  adjust:    '調整',
}
const DIVISION_LABEL: Record<number, string> = {
  1: '生姜', 2: '大蒜', 3: '長芋', 4: '牛蒡', 5: '薩摩芋',
}
const KIND_COLORS: Record<string, string> = {
  loan_out: '#a85a00',
  loan_in:  '#1d6f42',
  in:       '#1d6f42',
  out:      '#c8362d',
  stocktake: '#1F4E79',
  adjust:   '#5C5644',
}

// ============================================================================
// メイン Hub
// ============================================================================
const SUBTABS = [
  { id: 'holdings',   label: '在庫一覧' },
  { id: 'movements',  label: '移動履歴' },
  { id: 'loans',      label: '貸出中' },
  { id: 'stocktakes', label: '棚卸' },
  { id: 'layout',     label: 'レイアウト' },
] as const

export default function AssetsManagementPage() {
  const types = useFetch<AssetType[]>('/assets/types')
  const [params, setParams] = useSearchParams()

  // 種別: クエリ → 既定は 1 (コンテナ)
  const typeIdFromUrl = Number(params.get('type') || 0)
  const activeTypeId = useMemo(() => {
    if (!types.data || types.data.length === 0) return 0
    return types.data.some(t => t.id === typeIdFromUrl)
      ? typeIdFromUrl
      : types.data[0].id
  }, [types.data, typeIdFromUrl])

  // サブタブ: クエリ → 既定 holdings
  const activeSubtab = SUBTABS.find(s => s.id === params.get('tab')) ?? SUBTABS[0]

  function selectType(typeId: number) {
    const next = new URLSearchParams(params)
    next.set('type', String(typeId))
    setParams(next, { replace: false })
  }
  function selectSubtab(subId: string) {
    const next = new URLSearchParams(params)
    next.set('tab', subId)
    setParams(next, { replace: false })
  }

  return (
    <div className="page" style={{ paddingTop: 0 }}>
      <h2 style={{ marginBottom: 4 }}>固定資産管理</h2>
      <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
        自社工場が 管理する コンテナ・パレット・スチールコンテナ。
        前月棚卸 + 移動履歴 で 理論値を 算出、 工場間貸出 も 追跡。
      </p>

      {types.loading && <LoadingState />}
      <ErrorBanner error={types.error} />

      {/* 種別タブ */}
      {types.data && types.data.length > 0 && (
        <>
          <div role="tablist" aria-label="資産種別"
            style={{ display: 'flex', gap: 4, borderBottom: '2px solid #ccc', marginBottom: 0 }}>
            {types.data.map(t => {
              const isActive = t.id === activeTypeId
              return (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => selectType(t.id)}
                  style={{
                    padding: '10px 20px', fontSize: 14,
                    border: 'none', cursor: 'pointer',
                    borderBottom: isActive ? '3px solid #1F4E79' : '3px solid transparent',
                    background: isActive ? '#fff' : '#f0f0f0',
                    fontWeight: isActive ? 700 : 400,
                    color: isActive ? '#1F4E79' : '#555',
                    marginBottom: -2, borderRadius: '6px 6px 0 0',
                  }}
                >{t.name}</button>
              )
            })}
          </div>

          {/* サブタブ */}
          <div role="tablist" aria-label="機能"
            style={{
              display: 'flex', gap: 2, padding: '6px 0',
              borderBottom: '1px solid #ddd', marginBottom: 12,
            }}>
            {SUBTABS.map(s => {
              const isActive = s.id === activeSubtab.id
              return (
                <button
                  key={s.id}
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => selectSubtab(s.id)}
                  style={{
                    padding: '4px 12px', fontSize: 13,
                    border: 'none', cursor: 'pointer',
                    background: isActive ? '#1F4E79' : 'transparent',
                    color: isActive ? '#fff' : '#555',
                    borderRadius: 4,
                    fontWeight: isActive ? 600 : 400,
                  }}
                >{s.label}</button>
              )
            })}
          </div>

          {/* サブタブ コンテンツ */}
          {activeSubtab.id === 'holdings' && <HoldingsView typeId={activeTypeId} />}
          {activeSubtab.id === 'movements' && <MovementsView typeId={activeTypeId} />}
          {activeSubtab.id === 'loans' && <LoansView typeId={activeTypeId} />}
          {activeSubtab.id === 'stocktakes' && <StocktakesView typeId={activeTypeId} />}
          {activeSubtab.id === 'layout' && <Placeholder name="レイアウト" comingSoon />}
        </>
      )}
    </div>
  )
}

// ============================================================================
// 在庫一覧 サブビュー
// ============================================================================
function HoldingsView({ typeId }: { typeId: number }) {
  const holdings = useFetch<HoldingRow[]>(
    typeId ? '/assets/holdings' : null,
    typeId ? { asset_type_id: String(typeId) } : undefined,
  )

  // 0 値の 行を 隠す トグル
  const [hideEmpty, setHideEmpty] = useState(true)
  const rows = useMemo(() => {
    if (!holdings.data) return []
    if (!hideEmpty) return holdings.data
    return holdings.data.filter(r =>
      r.theoretical_qty !== 0 || r.lent_out_qty !== 0 || r.base_qty !== 0
      || r.total_purchased !== 0
    )
  }, [holdings.data, hideEmpty])

  // 各種 合計
  const grandTotal = useMemo(() => rows.reduce((s, r) => s + r.theoretical_qty, 0), [rows])
  const grandLent = useMemo(() => rows.reduce((s, r) => s + r.lent_out_qty, 0), [rows])
  const grandPurchased = useMemo(() => rows.reduce((s, r) => s + r.total_purchased, 0), [rows])
  const grandDiff = grandTotal - grandPurchased   // (+) 借入超過、 (-) 貸出/紛失

  return (
    <div>
      {/* サマリ パネル */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
        gap: 12, padding: '10px 14px', marginBottom: 10,
        background: 'var(--surface, #f8f9fa)', borderRadius: 6,
      }}>
        <div>
          <div className="muted" style={{ fontSize: 11 }}>累計 購入数</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#5C5644' }}>
            {num(grandPurchased, 0)}<span style={{ fontSize: 11, marginLeft: 4 }}>個</span>
          </div>
        </div>
        <div>
          <div className="muted" style={{ fontSize: 11 }}>理論在庫 (棚卸+履歴)</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#1F4E79' }}>
            {num(grandTotal, 0)}<span style={{ fontSize: 11, marginLeft: 4 }}>個</span>
          </div>
        </div>
        <div title="(+) 借入超過 / (-) 貸出未返却・紛失・破損">
          <div className="muted" style={{ fontSize: 11 }}>推測 借入差 (理論−購入)</div>
          <div style={{ fontSize: 20, fontWeight: 700,
                         color: grandDiff > 0 ? '#1d6f42' : grandDiff < 0 ? '#c8362d' : '#5C5644' }}>
            {grandDiff > 0 ? '+' : ''}{num(grandDiff, 0)}
            <span style={{ fontSize: 11, marginLeft: 4 }}>個</span>
          </div>
        </div>
        <div>
          <div className="muted" style={{ fontSize: 11 }}>現在 貸出中 (個別追跡)</div>
          <div style={{ fontSize: 18, fontWeight: 600, color: '#a85a00' }}>
            {num(grandLent, 0)}<span style={{ fontSize: 11, marginLeft: 4 }}>個</span>
          </div>
        </div>
      </div>

      {/* 注釈 + フィルタ */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                     marginBottom: 8, fontSize: 11, gap: 8, flexWrap: 'wrap' }}>
        <span className="muted">
          推測借入差 = 理論在庫 − 累計購入数。 (+) なら 他工場から 借入超過、
          (-) なら 貸出未返却・紛失・破損 等の 推測値。
          個別追跡 (貸出中) は 既知の 履歴 のみ 反映。
        </span>
        <label className="inline" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={hideEmpty}
            onChange={e => setHideEmpty(e.target.checked)}
            style={{ width: 'auto' }} />
          0 値 ロゴ を 隠す
        </label>
      </div>

      {holdings.loading && <LoadingState />}
      <ErrorBanner error={holdings.error} />

      {/* テーブル */}
      {rows.length > 0 && (
        <div className="table-scroll">
          <table className="sticky-head">
            <thead>
              <tr>
                <th>ロゴ</th>
                <th>規格</th>
                <th className="num" title="購入履歴 全期間 累計">累計購入</th>
                <th>棚卸基点 日付</th>
                <th className="num">棚卸値</th>
                <th className="num">以降の純増減</th>
                <th className="num">理論在庫</th>
                <th className="num" title="(+) 借入超過 / (-) 貸出未返却・紛失・破損">
                  推測 借入差
                </th>
                <th className="num">貸出中 (個別)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={`${r.logo_id}-${r.category_id}`}>
                  <td><strong>{r.logo_name}</strong></td>
                  <td>{r.category_name}</td>
                  <td className="num" style={{ color: '#5C5644' }}>
                    {r.total_purchased > 0 ? num(r.total_purchased, 0) : <span className="muted">—</span>}
                  </td>
                  <td>{r.base_date ? ymd(r.base_date) : <span className="muted">—</span>}</td>
                  <td className="num">{num(r.base_qty, 0)}</td>
                  <td className="num" style={{
                    color: r.movements_since > 0 ? '#1d6f42' :
                           r.movements_since < 0 ? '#c8362d' : 'inherit'
                  }}>
                    {r.movements_since !== 0 && (r.movements_since > 0 ? '+' : '')}{num(r.movements_since, 0)}
                  </td>
                  <td className="num" style={{ fontWeight: 700 }}>
                    {num(r.theoretical_qty, 0)}
                  </td>
                  <td className="num" style={{
                    fontWeight: r.estimated_borrow_diff !== 0 ? 600 : 400,
                    color: r.estimated_borrow_diff > 0 ? '#1d6f42'
                         : r.estimated_borrow_diff < 0 ? '#c8362d' : 'inherit',
                  }}>
                    {r.estimated_borrow_diff > 0 ? '+' : ''}{num(r.estimated_borrow_diff, 0)}
                  </td>
                  <td className="num" style={{
                    color: r.lent_out_qty > 0 ? '#a85a00' : 'inherit'
                  }}>
                    {r.lent_out_qty > 0 ? num(r.lent_out_qty, 0) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {holdings.data && rows.length === 0 && (
        <div className="muted" style={{ padding: 24, textAlign: 'center' }}>
          {hideEmpty ? '値が ある 行は ありません。 「0値を隠す」 を 外すと 全部 表示。'
                     : '在庫データ が ありません。'}
        </div>
      )}
    </div>
  )
}

// ============================================================================
// 移動履歴 サブビュー (P4-b)
// ============================================================================
function thisMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
function monthRange(month: string): [string, string] {
  const [y, m] = month.split('-').map(Number)
  const last = new Date(y, m, 0).getDate()
  return [`${month}-01`, `${month}-${String(last).padStart(2, '0')}`]
}

function MovementsView({ typeId }: { typeId: number }) {
  const dialog = useDialog()
  const [month, setMonth] = useState(thisMonth())
  const [from, to] = monthRange(month)
  const [showCreate, setShowCreate] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const movements = useFetch<Movement[]>(
    typeId ? '/assets/movements' : null,
    typeId ? { asset_type_id: String(typeId), date_from: from, date_to: to } : undefined,
  )

  async function handleDelete(m: Movement) {
    if (!(await dialog.confirm({
      title: '移動履歴を削除',
      message: `${ymd(m.movement_date)} ${KIND_LABEL[m.kind]} ${m.qty}個 を 削除します。\n貸出/返却 の場合 紐づく loan も 削除されます。`,
      variant: 'danger', okLabel: '削除',
    }))) return
    try {
      await api.delete(`/assets/movements/${m.id}`)
      movements.reload()
    } catch (e) {
      setError(errorText(e))
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
        <label className="inline" style={{ fontSize: 13 }}>
          月:&nbsp;
          <input type="month" value={month} onChange={e => setMonth(e.target.value)}
            style={{ fontSize: 13 }} />
        </label>
        <button onClick={() => movements.reload()} className="secondary small">再読込</button>
        <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>
          {movements.data ? `${movements.data.length} 件` : ''}
        </span>
        <button onClick={() => setShowCreate(true)}
          style={{ background: 'var(--primary)', color: '#fff' }}>
          ＋ 新規履歴登録
        </button>
      </div>

      <ErrorBanner error={error} />
      {movements.loading && <LoadingState />}
      <ErrorBanner error={movements.error} />

      {movements.data && movements.data.length === 0 && (
        <div className="muted" style={{ padding: 24, textAlign: 'center' }}>
          {month} の 移動履歴は ありません。
        </div>
      )}

      {movements.data && movements.data.length > 0 && (
        <div className="table-scroll">
          <table className="sticky-head">
            <thead>
              <tr>
                <th>日付</th>
                <th>区分</th>
                <th>ロゴ</th>
                <th>規格</th>
                <th className="num">数量</th>
                <th>取引先</th>
                <th>事業部</th>
                <th>備考</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {movements.data.map(m => (
                <tr key={m.id}>
                  <td>{ymd(m.movement_date)}</td>
                  <td>
                    <span style={{
                      padding: '2px 8px', borderRadius: 3, fontSize: 11,
                      background: (KIND_COLORS[m.kind] ?? '#888') + '22',
                      color: KIND_COLORS[m.kind] ?? '#555',
                      fontWeight: 600,
                    }}>{KIND_LABEL[m.kind] ?? m.kind}</span>
                  </td>
                  <td><LogoName typeId={typeId} logoId={m.logo_id} /></td>
                  <td><CategoryName typeId={typeId} categoryId={m.category_id} /></td>
                  <td className="num"><strong>{num(m.qty, 0)}</strong></td>
                  <td>{m.counterparty_name ?? <span className="muted">—</span>}</td>
                  <td>{m.division_code ? DIVISION_LABEL[m.division_code] : <span className="muted">—</span>}</td>
                  <td style={{ fontSize: 11, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {m.note ?? ''}
                  </td>
                  <td>
                    <button className="ghost small" onClick={() => handleDelete(m)}
                      title="削除" style={{ color: 'var(--danger)' }}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <CreateMovementModal
          typeId={typeId}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); movements.reload() }}
        />
      )}
    </div>
  )
}

/** ロゴ名 / 規格名 の キャッシュ表示 helper */
function LogoName({ typeId, logoId }: { typeId: number; logoId: number }) {
  const logos = useFetch<AssetLogo[]>('/assets/logos', { asset_type_id: String(typeId) })
  const l = logos.data?.find(x => x.id === logoId)
  return <span>{l?.name ?? `#${logoId}`}</span>
}
function CategoryName({ typeId, categoryId }: { typeId: number; categoryId: number }) {
  const cats = useFetch<AssetCategory[]>('/assets/categories', { asset_type_id: String(typeId) })
  const c = cats.data?.find(x => x.id === categoryId)
  return <span>{c?.name ?? `#${categoryId}`}</span>
}

// ============================================================================
// 新規履歴 登録 モーダル
// ============================================================================
function CreateMovementModal({
  typeId, onClose, onCreated,
}: {
  typeId: number
  onClose: () => void
  onCreated: () => void
}) {
  const logos = useFetch<AssetLogo[]>('/assets/logos', { asset_type_id: String(typeId) })
  const cats = useFetch<AssetCategory[]>('/assets/categories', { asset_type_id: String(typeId) })
  const cps = useFetch<Counterparty[]>('/assets/counterparties')

  const [movementDate, setMovementDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [kind, setKind] = useState<string>('loan_out')
  const [logoId, setLogoId] = useState<number | ''>('')
  const [categoryId, setCategoryId] = useState<number | ''>('')
  const [qty, setQty] = useState('')
  const [cpId, setCpId] = useState<number | ''>('')
  const [divisionCode, setDivisionCode] = useState<number | ''>('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 既定 カテゴリ
  useEffect(() => {
    if (categoryId === '' && cats.data) {
      const def = cats.data.find(c => c.is_default)
      if (def) setCategoryId(def.id)
    }
  }, [cats.data, categoryId])

  const needsCounterparty = kind === 'loan_out' || kind === 'loan_in'

  async function submit() {
    setError(null)
    if (!logoId || !categoryId || !qty || Number(qty) <= 0) {
      setError('ロゴ / 規格 / 数量 は 必須')
      return
    }
    if (needsCounterparty && !cpId) {
      setError(`${KIND_LABEL[kind]} は 取引先 必須`)
      return
    }
    setBusy(true)
    try {
      await api.post('/assets/movements', {
        asset_type_id: typeId,
        logo_id: Number(logoId),
        category_id: Number(categoryId),
        movement_date: movementDate,
        kind,
        qty: Number(qty),
        counterparty_id: needsCounterparty ? Number(cpId) : null,
        division_code: divisionCode ? Number(divisionCode) : null,
        note: note.trim() || null,
      })
      onCreated()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div role="dialog" aria-modal="true"
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(20,18,14,0.42)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: '#fff', border: '1px solid var(--border)', borderRadius: 8,
        padding: 20, minWidth: 480, maxWidth: 560, maxHeight: '85vh', overflowY: 'auto',
      }}>
        <h3 style={{ marginTop: 0 }}>新規 移動履歴</h3>

        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <div className="field" style={{ minWidth: 150 }}>
            <label>日付</label>
            <input type="date" value={movementDate}
              onChange={e => setMovementDate(e.target.value)} />
          </div>
          <div className="field" style={{ minWidth: 150 }}>
            <label>区分</label>
            <select value={kind} onChange={e => setKind(e.target.value)}>
              {Object.entries(KIND_LABEL).map(([k, l]) => (
                <option key={k} value={k}>{l}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="row" style={{ gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
          <div className="field" style={{ minWidth: 150 }}>
            <label>ロゴ <span style={{ color: 'var(--danger)' }}>*</span></label>
            <select value={logoId} onChange={e => setLogoId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">(選択)</option>
              {(logos.data ?? []).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
          <div className="field" style={{ minWidth: 130 }}>
            <label>規格 <span style={{ color: 'var(--danger)' }}>*</span></label>
            <select value={categoryId} onChange={e => setCategoryId(e.target.value ? Number(e.target.value) : '')}>
              {(cats.data ?? []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="field" style={{ minWidth: 100 }}>
            <label>数量 <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input type="number" min="1" value={qty} onChange={e => setQty(e.target.value)} />
          </div>
        </div>

        {needsCounterparty && (
          <div className="row" style={{ marginTop: 8 }}>
            <div className="field" style={{ flex: 1 }}>
              <label>取引先 <span style={{ color: 'var(--danger)' }}>*</span></label>
              <select value={cpId} onChange={e => setCpId(e.target.value ? Number(e.target.value) : '')}>
                <option value="">(選択)</option>
                <optgroup label="工場">
                  {(cps.data ?? []).filter(c => c.kind === 'external_factory').map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </optgroup>
                <optgroup label="業者">
                  {(cps.data ?? []).filter(c => c.kind === 'vendor').map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </optgroup>
              </select>
            </div>
          </div>
        )}

        <div className="row" style={{ gap: 10, marginTop: 8 }}>
          <div className="field" style={{ minWidth: 130 }}>
            <label>事業部 (任意)</label>
            <select value={divisionCode}
              onChange={e => setDivisionCode(e.target.value ? Number(e.target.value) : '')}>
              <option value="">(指定なし)</option>
              {Object.entries(DIVISION_LABEL).map(([d, n]) => (
                <option key={d} value={d}>{d}: {n}</option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: 1, minWidth: 200 }}>
            <label>備考</label>
            <input value={note} onChange={e => setNote(e.target.value)} />
          </div>
        </div>

        <ErrorBanner error={error} />

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button onClick={onClose} className="secondary">キャンセル</button>
          <button onClick={submit} disabled={busy}
            style={{ background: 'var(--primary)', color: '#fff' }}>
            {busy ? '登録中...' : '登録'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// 貸出中 サブビュー (P4-b)
// ============================================================================
function LoansView({ typeId }: { typeId: number }) {
  const dialog = useDialog()
  const loans = useFetch<LoanOpen[]>(
    typeId ? '/assets/loans/open' : null,
    typeId ? { asset_type_id: String(typeId) } : undefined,
  )
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  async function handleReturn(loan: LoanOpen) {
    const returnDate = await dialog.prompt({
      title: '返却日 入力',
      message: `${loan.counterparty_name} から ${loan.qty}個 を 返却。 返却日:`,
      defaultValue: new Date().toISOString().slice(0, 10),
      inputType: 'date',
      validate: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) ? null : 'YYYY-MM-DD 形式',
    })
    if (!returnDate) return
    setBusyId(loan.id)
    setError(null)
    try {
      await api.post(`/assets/loans/${loan.id}/return`, {
        return_date: returnDate, note: null,
      })
      loans.reload()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusyId(null)
    }
  }

  const total = useMemo(() => (loans.data ?? []).reduce((s, l) => s + l.qty, 0), [loans.data])

  return (
    <div>
      <div style={{
        padding: '10px 14px', marginBottom: 10,
        background: 'var(--surface, #f8f9fa)', borderRadius: 6,
      }}>
        <div className="muted" style={{ fontSize: 11 }}>現在 貸出中 合計</div>
        <div style={{ fontSize: 22, fontWeight: 700, color: '#a85a00' }}>
          {num(total, 0)}<span style={{ fontSize: 12, marginLeft: 4 }}>個</span>
        </div>
      </div>

      <ErrorBanner error={error} />
      {loans.loading && <LoadingState />}
      <ErrorBanner error={loans.error} />

      {loans.data && loans.data.length === 0 && (
        <div className="muted" style={{ padding: 24, textAlign: 'center' }}>
          現在 貸出中の 資産は ありません。
        </div>
      )}

      {loans.data && loans.data.length > 0 && (
        <div className="table-scroll">
          <table className="sticky-head">
            <thead>
              <tr>
                <th>貸出日</th>
                <th>経過日数</th>
                <th>取引先</th>
                <th>ロゴ</th>
                <th>規格</th>
                <th className="num">数量</th>
                <th>事業部</th>
                <th>備考</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {loans.data.map(l => (
                <tr key={l.id} style={l.days_lent >= 30 ? { background: '#fff4e6' } : undefined}>
                  <td>{ymd(l.lent_at)}</td>
                  <td className="num" style={{
                    color: l.days_lent >= 90 ? '#c8362d' :
                           l.days_lent >= 30 ? '#a85a00' : 'inherit',
                    fontWeight: l.days_lent >= 30 ? 600 : 400,
                  }}>
                    {l.days_lent} 日
                  </td>
                  <td><strong>{l.counterparty_name}</strong></td>
                  <td>{l.logo_name}</td>
                  <td>{l.category_name}</td>
                  <td className="num"><strong>{num(l.qty, 0)}</strong></td>
                  <td>{l.division_code ? DIVISION_LABEL[l.division_code] : <span className="muted">—</span>}</td>
                  <td style={{ fontSize: 11, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {l.note ?? ''}
                  </td>
                  <td>
                    <button
                      onClick={() => handleReturn(l)}
                      disabled={busyId === l.id}
                      style={{ background: '#1d6f42', color: '#fff', fontSize: 12 }}>
                      返却登録
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ============================================================================
// 棚卸 サブビュー (P4-c)
// ============================================================================
interface Stocktake {
  id: number
  asset_type_id: number
  logo_id: number
  logo_name: string
  category_id: number
  category_name: string
  count_date: string
  counted_qty: number
  theoretical_qty: number | null
  variance: number | null
  variance_note: string | null
  created_at: string
}

function StocktakesView({ typeId }: { typeId: number }) {
  const dialog = useDialog()
  const stocktakes = useFetch<Stocktake[]>(
    typeId ? '/assets/stocktakes' : null,
    typeId ? { asset_type_id: String(typeId), limit: '200' } : undefined,
  )
  const [showCreate, setShowCreate] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleDelete(s: Stocktake) {
    if (!(await dialog.confirm({
      title: '棚卸 を 削除',
      message: `${ymd(s.count_date)} の ${s.logo_name} / ${s.category_name} (${s.counted_qty}個) を 削除します。`,
      variant: 'danger', okLabel: '削除',
    }))) return
    try {
      await api.delete(`/assets/stocktakes/${s.id}`)
      stocktakes.reload()
    } catch (e) {
      setError(errorText(e))
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 10 }}>
        <span className="muted" style={{ fontSize: 12 }}>
          {stocktakes.data ? `${stocktakes.data.length} 件` : ''}
        </span>
        <button onClick={() => setShowCreate(true)}
          style={{ background: 'var(--primary)', color: '#fff', marginLeft: 'auto' }}>
          ＋ 棚卸 登録
        </button>
      </div>

      <ErrorBanner error={error} />
      {stocktakes.loading && <LoadingState />}
      <ErrorBanner error={stocktakes.error} />

      {stocktakes.data && stocktakes.data.length === 0 && (
        <div className="muted" style={{ padding: 24, textAlign: 'center' }}>
          棚卸 履歴が ありません。 ＋棚卸登録 で 追加してください。
        </div>
      )}

      {stocktakes.data && stocktakes.data.length > 0 && (
        <div className="table-scroll">
          <table className="sticky-head">
            <thead>
              <tr>
                <th>棚卸日</th>
                <th>ロゴ</th>
                <th>規格</th>
                <th className="num">棚卸値</th>
                <th className="num">理論値 (記録時)</th>
                <th className="num">差異</th>
                <th>差異原因</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {stocktakes.data.map(s => {
                const v = s.variance ?? 0
                return (
                  <tr key={s.id}>
                    <td>{ymd(s.count_date)}</td>
                    <td><strong>{s.logo_name}</strong></td>
                    <td>{s.category_name}</td>
                    <td className="num"><strong>{num(s.counted_qty, 0)}</strong></td>
                    <td className="num">{s.theoretical_qty != null ? num(s.theoretical_qty, 0) : <span className="muted">—</span>}</td>
                    <td className="num" style={{
                      color: v > 0 ? '#1d6f42' : v < 0 ? '#c8362d' : 'inherit',
                      fontWeight: v !== 0 ? 600 : 400,
                    }}>
                      {v > 0 ? '+' : ''}{num(v, 0)}
                    </td>
                    <td style={{ fontSize: 11, maxWidth: 250, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {s.variance_note ?? ''}
                    </td>
                    <td>
                      <button className="ghost small" onClick={() => handleDelete(s)}
                        title="削除" style={{ color: 'var(--danger)' }}>✕</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <CreateStocktakeModal
          typeId={typeId}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); stocktakes.reload() }}
        />
      )}
    </div>
  )
}

function CreateStocktakeModal({
  typeId, onClose, onCreated,
}: {
  typeId: number
  onClose: () => void
  onCreated: () => void
}) {
  const logos = useFetch<AssetLogo[]>('/assets/logos', { asset_type_id: String(typeId) })
  const cats = useFetch<AssetCategory[]>('/assets/categories', { asset_type_id: String(typeId) })

  const [countDate, setCountDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [logoId, setLogoId] = useState<number | ''>('')
  const [categoryId, setCategoryId] = useState<number | ''>('')
  const [countedQty, setCountedQty] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // デフォルト category 自動セット
  useEffect(() => {
    if (categoryId === '' && cats.data) {
      const def = cats.data.find(c => c.is_default)
      if (def) setCategoryId(def.id)
    }
  }, [cats.data, categoryId])

  async function submit() {
    setError(null)
    if (!logoId || !categoryId || countedQty === '' || Number(countedQty) < 0) {
      setError('ロゴ / 規格 / 棚卸値 (0以上) は 必須')
      return
    }
    setBusy(true)
    try {
      await api.post('/assets/stocktakes', {
        asset_type_id: typeId,
        logo_id: Number(logoId),
        category_id: Number(categoryId),
        count_date: countDate,
        counted_qty: Number(countedQty),
        variance_note: note.trim() || null,
      })
      onCreated()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div role="dialog" aria-modal="true"
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(20,18,14,0.42)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: '#fff', border: '1px solid var(--border)', borderRadius: 8,
        padding: 20, minWidth: 460, maxWidth: 540, maxHeight: '85vh', overflowY: 'auto',
      }}>
        <h3 style={{ marginTop: 0 }}>棚卸 登録</h3>
        <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
          同 (ロゴ, 規格, 日付) の 既存棚卸 は 自動上書きされます。
          理論値は その時点の 過去棚卸 + 移動履歴 から 自動計算されます。
        </p>

        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <div className="field" style={{ minWidth: 150 }}>
            <label>棚卸日</label>
            <input type="date" value={countDate}
              onChange={e => setCountDate(e.target.value)} />
          </div>
          <div className="field" style={{ minWidth: 150 }}>
            <label>ロゴ <span style={{ color: 'var(--danger)' }}>*</span></label>
            <select value={logoId} onChange={e => setLogoId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">(選択)</option>
              {(logos.data ?? []).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
          <div className="field" style={{ minWidth: 130 }}>
            <label>規格</label>
            <select value={categoryId} onChange={e => setCategoryId(e.target.value ? Number(e.target.value) : '')}>
              {(cats.data ?? []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="field" style={{ minWidth: 100 }}>
            <label>棚卸値 <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input type="number" min="0" value={countedQty}
              onChange={e => setCountedQty(e.target.value)} />
          </div>
        </div>

        <div className="field" style={{ marginTop: 8 }}>
          <label>差異原因 (任意)</label>
          <input value={note} onChange={e => setNote(e.target.value)}
            placeholder="例: 紛失、誤計上、廃棄漏れ など" />
        </div>

        <ErrorBanner error={error} />

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button onClick={onClose} className="secondary">キャンセル</button>
          <button onClick={submit} disabled={busy}
            style={{ background: 'var(--primary)', color: '#fff' }}>
            {busy ? '登録中...' : '登録'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// プレースホルダ (P5 レイアウトのみ)
// ============================================================================
function Placeholder({ name, comingSoon }: { name: string; comingSoon?: boolean }) {
  return (
    <div style={{
      padding: 40, textAlign: 'center',
      background: '#fafbfc', border: '1px dashed #ccc', borderRadius: 6,
    }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{name}</div>
      <div className="muted" style={{ fontSize: 12 }}>
        {comingSoon ? '(レイアウト + エリア設定 は 続フェーズで 開発)' : '(本機能 は 続フェーズで 開発)'}
      </div>
    </div>
  )
}
