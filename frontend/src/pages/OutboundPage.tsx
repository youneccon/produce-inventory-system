import { useMemo, useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Pencil, Trash2, X, ArrowUpDown, ArrowUp, ArrowDown, Columns3 } from 'lucide-react'
import { api } from '../api/client'
import { useFetch } from '../lib/useFetch'
import { useDialog } from '../components/Dialog'
import { errorText, num, yen, ymd, formatGrade } from '../lib/format'
import { tokenize, matchesAllTokens } from '../lib/search'
import Combobox from '../components/Combobox'
import RowMenu, { useRowMenu } from '../components/RowMenu'
import {
  OUTBOUND_HISTORY_COLUMNS,
  loadVisibleOutboundCols, saveVisibleOutboundCols, resetOutboundCols,
} from '../lib/outboundColumns'
import type {
  AllocationResult,
  EligibleCandidate,
  NeedsSelectionResponse,
  OutboundRecord,
  PreviewResult,
  Product,
} from '../api/types'

const today = () => new Date().toISOString().slice(0, 10)

function currentMonthRange(): { from: string; to: string } {
  const now = new Date()
  const y = now.getFullYear(), m = now.getMonth()
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  return { from: fmt(new Date(y, m, 1)), to: fmt(new Date(y, m + 1, 0)) }
}

// /stock/eligible が返す行 (autocomplete のソース)
interface EligibleLotRow {
  lot_id: number
  inbound_date: string
  kg_per_case: string | null
  cases: string | null
  remaining_kg: string
  supplier_name: string
  fifo_rank: number
}

export default function OutboundPage({ cropId }: { cropId?: number }) {
  const dialog = useDialog()
  const productsQuery = cropId !== undefined ? { crop_id: String(cropId) } : {}
  const products = useFetch<Product[]>('/masters/products', productsQuery)

  // 出庫履歴 (デフォルト=当月分、作物単位)
  const initialRange = useMemo(() => currentMonthRange(), [])
  const [histFrom, setHistFrom] = useState(initialRange.from)
  const [histTo,   setHistTo]   = useState(initialRange.to)
  const records = useFetch<OutboundRecord[]>('/outbound/records', {
    ...(cropId !== undefined ? { crop_id: String(cropId) } : {}),
    date_from: histFrom, date_to: histTo, limit: 500,
  })

  // ─── 出庫履歴 フィルタ / ソート (フロント側でのみ適用) ───
  // 検索クエリ — スペース区切り AND マッチ (整理番号 / 規格 / 産地 / 仕入先 / 担当 / 備考)
  const [histSearch, setHistSearch] = useState('')
  // 数量範囲フィルタ (kg)
  const [histMinKg, setHistMinKg] = useState('')
  const [histMaxKg, setHistMaxKg] = useState('')
  // 列 表示 設定 (= localStorage 永続)、 popover open state
  const [visibleCols, setVisibleCols] = useState<Set<string>>(loadVisibleOutboundCols)
  const [colsPopoverOpen, setColsPopoverOpen] = useState(false)
  const colsPopoverRef = useRef<HTMLDivElement | null>(null)
  function toggleCol(id: string) {
    setVisibleCols(s => {
      const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); saveVisibleOutboundCols(n); return n
    })
  }
  function setAllCols(on: boolean) {
    const n = on ? new Set(OUTBOUND_HISTORY_COLUMNS.map(c => c.id)) : new Set<string>()
    saveVisibleOutboundCols(n); setVisibleCols(n)
  }
  function resetCols() { setVisibleCols(resetOutboundCols()) }
  const isCol = (id: string) => visibleCols.has(id)
  // popover 外 click で 閉じる
  useEffect(() => {
    if (!colsPopoverOpen) return
    const h = (e: MouseEvent) => {
      if (colsPopoverRef.current && !colsPopoverRef.current.contains(e.target as Node)) {
        setColsPopoverOpen(false)
      }
    }
    setTimeout(() => document.addEventListener('mousedown', h), 0)
    return () => document.removeEventListener('mousedown', h)
  }, [colsPopoverOpen])
  // ソート (列ヘッダクリック)
  type HistSortKey =
    | 'outbound_date' | 'lot_code' | 'spec' | 'supplier_name'
    | 'kg_per_case' | 'quantity_kg' | 'created_by_name'
  const [histSortKey, setHistSortKey] = useState<HistSortKey | null>(null)
  const [histSortDir, setHistSortDir] = useState<'asc' | 'desc'>('asc')
  function toggleHistSort(key: HistSortKey) {
    if (histSortKey !== key) { setHistSortKey(key); setHistSortDir('asc'); return }
    if (histSortDir === 'asc') { setHistSortDir('desc'); return }
    setHistSortKey(null)  // 3 度目 → ソート解除 (デフォルト = 出庫日 降順 ?)
  }

  // 検索 + 数量範囲 + ソート を 1 つの memo にまとめる
  const histSearchTokens = useMemo(() => tokenize(histSearch), [histSearch])
  const minKgNum = histMinKg ? Number(histMinKg) : null
  const maxKgNum = histMaxKg ? Number(histMaxKg) : null
  const filteredRecords = useMemo<OutboundRecord[]>(() => {
    if (!records.data) return []
    let arr = records.data
    if (histSearchTokens.length > 0) {
      arr = arr.filter((r) => {
        const text = [
          r.lot_code ?? '',
          r.spec_type ?? '', r.grade_level ?? '', r.size_label ?? '',
          r.origin_name ?? '',
          r.supplier_name ?? '',
          r.created_by_name ?? '',
          r.note ?? '',
        ].join(' ')
        return matchesAllTokens(text, histSearchTokens)
      })
    }
    if (minKgNum != null && !Number.isNaN(minKgNum)) {
      arr = arr.filter((r) => Number(r.quantity_kg) >= minKgNum)
    }
    if (maxKgNum != null && !Number.isNaN(maxKgNum)) {
      arr = arr.filter((r) => Number(r.quantity_kg) <= maxKgNum)
    }
    if (histSortKey) {
      const dir = histSortDir === 'asc' ? 1 : -1
      const getVal = (r: OutboundRecord): number | string => {
        switch (histSortKey) {
          case 'outbound_date':   return r.outbound_date ?? ''
          case 'lot_code':        return r.lot_code ?? ''
          case 'spec':            return `${r.spec_type ?? ''} ${r.origin_name ?? ''}`
          case 'supplier_name':   return r.supplier_name ?? ''
          case 'kg_per_case':     return Number(r.kg_per_case ?? 0)
          case 'quantity_kg':     return Number(r.quantity_kg ?? 0)
          case 'created_by_name': return r.created_by_name ?? ''
        }
      }
      arr = [...arr].sort((a, b) => {
        const av = getVal(a); const bv = getVal(b)
        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
        return String(av).localeCompare(String(bv)) * dir
      })
    }
    return arr
  }, [records.data, histSearchTokens, minKgNum, maxKgNum, histSortKey, histSortDir])

  // ヘッダ ボタン (列クリックでソート 切替)
  function HistSortHeader({ k, children, num: isNum }: {
    k: HistSortKey; children: React.ReactNode; num?: boolean
  }) {
    const active = histSortKey === k
    const Icon = active ? (histSortDir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown
    return (
      <th className={isNum ? 'num' : undefined}
          onClick={() => toggleHistSort(k)}
          style={{ cursor: 'pointer', userSelect: 'none' }}
          title="クリックで並び替え (3 回目で解除)">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4,
                       opacity: active ? 1 : 0.85 }}>
          {children}
          <Icon size={11} strokeWidth={1.8}
            style={{ opacity: active ? 1 : 0.4 }} />
        </span>
      </th>
    )
  }
  const histFiltersActive = histSearchTokens.length > 0 || histMinKg !== '' || histMaxKg !== '' || histSortKey !== null
  function clearHistFilters() {
    setHistSearch(''); setHistMinKg(''); setHistMaxKg('')
    setHistSortKey(null); setHistSortDir('asc')
  }

  // 出庫履歴 インライン編集 / 削除
  interface OutEdit { outbound_date: string; quantity_kg: string; note: string }
  const [editRecId, setEditRecId] = useState<number | null>(null)
  const [editRecData, setEditRecData] = useState<OutEdit | null>(null)
  const [editRecBusy, setEditRecBusy] = useState(false)
  const [editRecErr, setEditRecErr] = useState<string | null>(null)
  function startEditRec(r: OutboundRecord) {
    setEditRecId(r.record_id)
    setEditRecData({
      outbound_date: r.outbound_date.slice(0, 10),
      quantity_kg: String(r.quantity_kg),
      note: r.note ?? '',
    })
    setEditRecErr(null)
  }
  function cancelEditRec() { setEditRecId(null); setEditRecData(null) }
  async function saveEditRec(recordId: number) {
    if (!editRecData) return
    setEditRecBusy(true); setEditRecErr(null)
    try {
      await api.patch(`/outbound/records/${recordId}`, {
        outbound_date: editRecData.outbound_date,
        quantity_kg: Number(editRecData.quantity_kg),
        note: editRecData.note || null,
      })
      setEditRecId(null); setEditRecData(null)
      records.reload()
    } catch (e) {
      setEditRecErr(errorText(e))
    } finally { setEditRecBusy(false) }
  }
  async function deleteRec(r: OutboundRecord) {
    if (!(await dialog.confirm({
      title: '出庫レコードを削除',
      message:
        `${ymd(r.outbound_date)} / ロット ${r.lot_code} / ${num(r.quantity_kg, 1)} kg を削除します。\n`
        + `ロットの残量が ${num(r.quantity_kg, 1)} kg 戻ります。`,
      okLabel: '削除',
      variant: 'danger',
    }))) return
    setEditRecBusy(true); setEditRecErr(null)
    try {
      await api.delete(`/outbound/records/${r.record_id}`)
      records.reload()
    } catch (e) {
      setEditRecErr(errorText(e))
    } finally { setEditRecBusy(false) }
  }

  // 右クリック / ⋮ メニュー
  const navigate = useNavigate()
  const rowMenu = useRowMenu<OutboundRecord>()
  async function copyText(text: string) {
    try { await navigator.clipboard.writeText(text) } catch { /* */ }
  }

  const [productId, setProductId] = useState('')
  const [qty, setQty] = useState('')
  const [date, setDate] = useState(today())
  const [note, setNote] = useState('')
  const [filterInboundDate, setFilterInboundDate] = useState<string>('')
  const [filterKgPerCase, setFilterKgPerCase] = useState<string>('')

  // 商品が選択されたら、その商品で引き当て可能なロット候補を取得
  // (入荷日・ケース重量のオートコンプリート候補に使う)
  const eligibleLots = useFetch<{ candidates: EligibleLotRow[] }>(
    productId ? '/stock/eligible' : null,
    productId ? { product_id: productId, quantity_kg: '0.0001' } : undefined,
  )

  // 入荷日 候補 (一意化、新しい順)
  const inboundDateOptions = useMemo(() => {
    const set = new Set<string>()
    for (const c of eligibleLots.data?.candidates ?? []) {
      if (c.inbound_date) set.add(c.inbound_date)
    }
    return [...set].sort().reverse().map((d) => ({ key: d, label: d }))
  }, [eligibleLots.data])

  // ケース重量 候補 (一意化、小さい順)
  const kgPerCaseOptions = useMemo(() => {
    const set = new Set<string>()
    for (const c of eligibleLots.data?.candidates ?? []) {
      if (c.kg_per_case) set.add(String(Number(c.kg_per_case)))
    }
    return [...set].sort((a, b) => Number(a) - Number(b))
      .map((v) => ({ key: v, label: `${v} kg/C/S` }))
  }, [eligibleLots.data])

  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [candidates, setCandidates] = useState<EligibleCandidate[] | null>(null)
  // 候補が複数ロットに 跨ぐ 場合 に、 ユーザー が 順序付きで 複数選択 する 状態。
  // 配列の順 = 引当 優先順位 (先頭 = preferred、 続く = fallback)。 残り は 自動 FIFO。
  const [selectedLotIds, setSelectedLotIds] = useState<number[]>([])
  const [result, setResult] = useState<AllocationResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function resetOutputs() {
    setPreview(null)
    setCandidates(null)
    setSelectedLotIds([])
    setResult(null)
    setError(null)
  }

  // 入力された値をリクエストのフィルタへ変換 (空文字は null)
  function buildFilters() {
    return {
      filter_inbound_date: filterInboundDate || null,
      filter_kg_per_case: filterKgPerCase ? Number(filterKgPerCase) : null,
    }
  }

  async function doPreview() {
    resetOutputs()
    try {
      const r = await api.post<PreviewResult>('/outbound/preview', {
        product_id: Number(productId),
        quantity_kg: Number(qty),
        ...buildFilters(),
      })
      setPreview(r)
    } catch (e) {
      setError(errorText(e))
    }
  }

  async function doAllocate() {
    setError(null)
    setBusy(true)
    try {
      const r = await api.post<AllocationResult | NeedsSelectionResponse>(
        '/outbound/allocate',
        {
          product_id: Number(productId),
          outbound_date: date,
          quantity_kg: Number(qty),
          note: note || null,
          ...buildFilters(),
        },
      )
      if ('needs_selection' in r) {
        setCandidates(r.candidates)
        setResult(null)
      } else {
        setResult(r)
        setCandidates(null)
        afterSuccess()
      }
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  async function doAllocateManual(lotId: number) {
    setError(null)
    setBusy(true)
    try {
      const r = await api.post<AllocationResult>('/outbound/allocate/manual', {
        product_id: Number(productId),
        outbound_date: date,
        quantity_kg: Number(qty),
        preferred_lot_id: lotId,
        note: note || null,
      })
      setResult(r)
      setCandidates(null)
      setSelectedLotIds([])
      afterSuccess()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  // 複数 ロット を 順序付きで 引当 (preferred + fallback)
  async function doAllocateMulti(lotIds: number[]) {
    if (lotIds.length === 0) return
    setError(null)
    setBusy(true)
    try {
      const r = await api.post<AllocationResult>('/outbound/allocate/manual', {
        product_id: Number(productId),
        outbound_date: date,
        quantity_kg: Number(qty),
        preferred_lot_ids: lotIds,
        note: note || null,
      })
      setResult(r)
      setCandidates(null)
      setSelectedLotIds([])
      afterSuccess()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  function afterSuccess() {
    setPreview(null)
    setQty('')
    setNote('')
    records.reload()
  }

  const canSubmit = productId && Number(qty) > 0

  return (
    <div>
      <h2>出庫・引き当て</h2>
      <p className="subtitle">
        商品と数量を指定すると、FIFO（入荷日順）で在庫ロットへ引き当てます。
      </p>

      {error && <div className="alert error">{error}</div>}

      <div className="panel">
        <h3>引き当て指示</h3>
        <div className="row">
          <div className="field" style={{ flex: 2, minWidth: 280 }}>
            <label>
              商品 (規格 / 産地)
              <span className="muted" style={{ fontWeight: 400, marginLeft: 6, fontSize: 11 }}>
                {products.data?.length ?? 0} 件中から検索
              </span>
            </label>
            <Combobox<Product>
              items={products.data ?? []}
              getKey={(p) => p.id}
              getLabel={(p) =>
                formatGrade(p.spec_type, p.grade_level, p.size_label, { spaces: true, fallback: '(規格未設定)' })
                + ` / ${p.origin_name}`}
              getSearchText={(p) =>
                `${p.spec_type} ${p.grade_level ?? ''} ${p.size_label ?? ''} ${p.origin_name} ${p.region ?? ''}`}
              value={productId ? Number(productId) : null}
              onChange={(v) => { setProductId(v != null ? String(v) : ''); resetOutputs() }}
              placeholder="規格 / 産地で検索 (スペースで複数語 AND)"
              maxResults={60}
            />
          </div>
          <div className="field">
            <label>出庫数量 (kg)</label>
            <input
              type="number"
              step="0.0001"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
            />
          </div>
          <div className="field">
            <label>出庫日</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="field">
            <label>備考（任意）</label>
            <input value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
        {/* ロット絞り込み (任意) - 入荷日 / ケース重量 */}
        <div className="row" style={{ marginTop: 8 }}>
          <div className="field" style={{ flex: 1, minWidth: 240 }}>
            <label>
              入荷日で絞り込み（任意・選択 or 入力）
              {eligibleLots.data && (
                <span className="muted" style={{ fontWeight: 400, marginLeft: 6, fontSize: 11 }}>
                  候補 {inboundDateOptions.length} 件
                </span>
              )}
            </label>
            <Combobox<{ key: string; label: string }>
              items={inboundDateOptions}
              getKey={(o) => o.key}
              getLabel={(o) => o.label}
              getSearchText={(o) => o.label}
              value={filterInboundDate || null}
              onChange={(v) => { setFilterInboundDate(v ? String(v) : ''); resetOutputs() }}
              placeholder={productId
                ? '例: 2026-04-15 (クリックで候補表示)'
                : '先に商品を選んでください'}
              disabled={!productId}
              maxResults={50}
              clearable
            />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 200 }}>
            <label>
              ケース重量(kg)で絞り込み（任意）
              {eligibleLots.data && (
                <span className="muted" style={{ fontWeight: 400, marginLeft: 6, fontSize: 11 }}>
                  候補 {kgPerCaseOptions.length} 件
                </span>
              )}
            </label>
            <Combobox<{ key: string; label: string }>
              items={kgPerCaseOptions}
              getKey={(o) => o.key}
              getLabel={(o) => o.label}
              getSearchText={(o) => o.label}
              value={filterKgPerCase || null}
              onChange={(v) => { setFilterKgPerCase(v ? String(v) : ''); resetOutputs() }}
              placeholder={productId
                ? '例: 10 (クリックで候補表示)'
                : '先に商品を選んでください'}
              disabled={!productId}
              maxResults={50}
              clearable
            />
          </div>
          {(filterInboundDate || filterKgPerCase) && (
            <button
              type="button" className="ghost small"
              style={{ alignSelf: 'flex-end' }}
              onClick={() => { setFilterInboundDate(''); setFilterKgPerCase(''); resetOutputs() }}
            >
              フィルタクリア
            </button>
          )}
        </div>
        <div className="inline">
          <button
            type="button"
            className="secondary"
            onClick={doPreview}
            disabled={!canSubmit}
          >
            プレビュー
          </button>
          <button type="button" onClick={doAllocate} disabled={!canSubmit || busy}>
            {busy ? '処理中…' : '引き当て実行'}
          </button>
        </div>
      </div>

      {preview && (
        <div className="panel">
          <h3>引き当てプレビュー</h3>
          <div className={'alert ' + (preview.is_sufficient ? 'info' : 'error')}>
            必要 {num(preview.required_kg, 1)} kg / 利用可能{' '}
            {num(preview.available_kg, 1)} kg ・{' '}
            {preview.is_sufficient ? '充足' : '在庫不足'}
            {preview.needs_user_select && '（複数ロット候補あり：実行時に選択）'}
          </div>
          {preview.sim_lines.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th className="num">整理番号</th>
                  <th>入荷日</th>
                  <th>仕入先</th>
                  <th className="num">残量</th>
                  <th className="num">引当量</th>
                </tr>
              </thead>
              <tbody>
                {preview.sim_lines.map((s) => (
                  <tr key={s.lot_id}>
                    <td><code>{s.lot_code}</code></td>
                    <td>{ymd(s.inbound_date)}</td>
                    <td>{s.supplier_name}</td>
                    <td className="num">{num(s.remaining_kg, 1)}</td>
                    <td className="num">{num(s.take_kg, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {candidates && (() => {
        const need = Number(qty) || 0
        const selectedTotal = selectedLotIds.reduce((s, lid) => {
          const c = candidates.find(c => c.lot_id === lid)
          return s + (c ? Number(c.remaining_kg) : 0)
        }, 0)
        const isCovered = selectedTotal >= need
        const toggleLot = (lid: number) => {
          setSelectedLotIds((cur) => cur.includes(lid)
            ? cur.filter(x => x !== lid)
            : [...cur, lid])
        }
        return (
          <div className="panel">
            <h3>ロットを選択してください</h3>
            <div className="alert warn">
              複数の在庫ロットが候補です。 1 ロット の 「このロットで引当」 で 即時引当、
              または 複数ロット にチェックを入れて 「選択順で引当」 で fallback 付き 引当。
              足りない分は 自動 で FIFO 補充 されます。
            </div>
            <table>
              <thead>
                <tr>
                  <th style={{ width: 50 }}>選択</th>
                  <th className="num">整理番号</th>
                  <th>入荷日</th>
                  <th>仕入先</th>
                  <th className="num">残量</th>
                  <th className="num">単価</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((c) => {
                  const order = selectedLotIds.indexOf(c.lot_id)
                  const selected = order >= 0
                  return (
                    <tr key={c.lot_id} style={selected ? { background: 'var(--primary-light, #DBEAFE)' } : undefined}>
                      <td style={{ textAlign: 'center' }}>
                        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                          <input type="checkbox" checked={selected} onChange={() => toggleLot(c.lot_id)} disabled={busy} />
                          {selected && (
                            <span style={{
                              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                              width: 20, height: 20, borderRadius: 10,
                              background: 'var(--primary, #2563EB)', color: '#fff',
                              fontSize: 11, fontWeight: 700,
                            }}>{order + 1}</span>
                          )}
                        </label>
                      </td>
                      <td><code>{c.lot_code}</code></td>
                      <td>{ymd(c.inbound_date)}</td>
                      <td>{c.supplier_name}</td>
                      <td className="num">{num(c.remaining_kg, 1)}</td>
                      <td className="num">{yen(c.unit_price)}</td>
                      <td>
                        <button
                          className="small"
                          disabled={busy}
                          onClick={() => doAllocateManual(c.lot_id)}
                        >
                          このロットで引当
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {/* 複数選択時 の サマリ + 実行ボタン */}
            {selectedLotIds.length > 0 && (
              <div style={{
                marginTop: 10, padding: '8px 12px',
                background: 'var(--surface-soft, #F1F5F9)',
                border: '1px solid var(--border)', borderRadius: 6,
                display: 'flex', alignItems: 'center', gap: 12,
              }}>
                <div style={{ flex: 1, fontSize: 12.5 }}>
                  <strong>選択 {selectedLotIds.length} 件</strong>
                  <span style={{ marginLeft: 8, color: 'var(--muted)' }}>
                    選択計 {num(String(selectedTotal), 1)} kg / 必要 {num(qty, 1)} kg
                  </span>
                  {!isCovered && (
                    <span style={{ marginLeft: 8, color: 'var(--warning-strong, #92400E)' }}>
                      不足分は 自動 FIFO で 補充されます
                    </span>
                  )}
                </div>
                <button className="small ghost" disabled={busy}
                        onClick={() => setSelectedLotIds([])}>
                  選択クリア
                </button>
                <button disabled={busy}
                        onClick={() => doAllocateMulti(selectedLotIds)}>
                  選択順で引当 ({selectedLotIds.length} 件)
                </button>
              </div>
            )}
          </div>
        )
      })()}

      {result && (
        <div className="panel">
          <h3>引き当て完了</h3>
          <div className="alert success">
            合計 {num(result.total_kg, 1)} kg を {result.lines.length}{' '}
            ロットへ引き当てました
            {result.is_split && '（複数ロットに分割）'}。
          </div>
          <table>
            <thead>
              <tr>
                <th className="num">出庫レコードID</th>
                <th className="num">整理番号</th>
                <th>入荷日</th>
                <th>仕入先</th>
                <th className="num">引当量</th>
              </tr>
            </thead>
            <tbody>
              {result.lines.map((l) => (
                <tr key={l.outbound_record_id}>
                  <td className="num">{l.outbound_record_id}</td>
                  <td><code>{l.lot_code ?? `#${l.lot_id}`}</code></td>
                  <td>{ymd(l.inbound_date)}</td>
                  <td>{l.supplier_name}</td>
                  <td className="num">{num(l.quantity_kg, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="panel">
        <h3>出庫履歴 {cropId !== undefined ? '(この原料)' : '(全原料)'}</h3>
        <p className="muted" style={{ fontSize: 11, marginTop: 0 }}>
          修正ルール: 備考は常に変更可。日付・出庫量は下流が成立する範囲のみ変更可
          (ロット残量超過・入荷日より前の出庫日は拒否)。削除はロット残量が回復します。
        </p>
        <div className="inline" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
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
          <button type="button" className="ghost small"
            style={{ alignSelf: 'flex-end' }}
            onClick={() => {
              const r = currentMonthRange()
              setHistFrom(r.from); setHistTo(r.to)
            }}
          >当月に戻す</button>
        </div>
        {/* 2 段目: フィルタ (検索 / 数量範囲) — クライアント側で適用 */}
        <div className="inline" style={{ marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
          <div className="field" style={{ minWidth: 220, flex: '1 1 220px' }}>
            <label>検索 <span className="muted" style={{ fontSize: 10 }}>
              (整理番号・規格・産地・仕入先・担当・備考、スペース AND)
            </span></label>
            <div style={{ position: 'relative' }}>
              <input type="text" value={histSearch}
                onChange={(e) => setHistSearch(e.target.value)}
                placeholder="例: 田子 m以上、 R38、 黒バラ 5/9"
                style={{ width: '100%', paddingRight: histSearch ? 24 : undefined }}
              />
              {histSearch && (
                <button type="button"
                  onClick={() => setHistSearch('')}
                  title="検索クリア"
                  style={{
                    position: 'absolute', right: 4, top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'none', border: 'none', padding: 2,
                    cursor: 'pointer', color: 'var(--muted, #888)',
                    display: 'inline-flex', alignItems: 'center',
                  }}><X size={14} strokeWidth={1.8} /></button>
              )}
            </div>
          </div>
          <div className="field" style={{ minWidth: 90 }}>
            <label>最小kg</label>
            <input type="number" step="0.1" min="0" value={histMinKg}
              onChange={(e) => setHistMinKg(e.target.value)}
              placeholder="—" style={{ width: 80 }} />
          </div>
          <div className="field" style={{ minWidth: 90 }}>
            <label>最大kg</label>
            <input type="number" step="0.1" min="0" value={histMaxKg}
              onChange={(e) => setHistMaxKg(e.target.value)}
              placeholder="—" style={{ width: 80 }} />
          </div>
          {histFiltersActive && (
            <button type="button" className="ghost small"
              onClick={clearHistFilters}
              style={{ alignSelf: 'flex-end' }}
              title="検索 / 数量範囲 / ソートをすべて解除"
            >フィルタ解除</button>
          )}
          {/* 列 設定 popover (= dashboardColumns と 同 思想) */}
          <div ref={colsPopoverRef} style={{ alignSelf: 'flex-end', position: 'relative' }}>
            <button type="button" className="ghost small"
              onClick={() => setColsPopoverOpen(v => !v)}
              title="表示 列 を カスタマイズ"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            ><Columns3 size={13} strokeWidth={1.7} /> 列</button>
            {colsPopoverOpen && (
              <div style={{
                position: 'absolute', right: 0, top: '100%', marginTop: 4,
                background: 'var(--panel, #fff)', border: '1px solid var(--border, #ddd)',
                borderRadius: 8, boxShadow: 'var(--shadow-lg, 0 4px 16px rgba(0,0,0,0.12))',
                padding: 10, minWidth: 200, zIndex: 100,
              }}>
                <div style={{ display: 'flex', gap: 6, marginBottom: 8, fontSize: 11 }}>
                  <button type="button" className="ghost small" onClick={() => setAllCols(true)}
                    style={{ padding: '2px 8px' }}>全表示</button>
                  <button type="button" className="ghost small" onClick={() => setAllCols(false)}
                    style={{ padding: '2px 8px' }}>全非表示</button>
                  <button type="button" className="ghost small" onClick={resetCols}
                    style={{ padding: '2px 8px', marginLeft: 'auto' }}>既定</button>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {OUTBOUND_HISTORY_COLUMNS.map(c => (
                    <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 6,
                                               fontSize: 12, cursor: 'pointer', padding: '2px 4px' }}>
                      <input type="checkbox" checked={isCol(c.id)}
                        onChange={() => toggleCol(c.id)} />
                      {c.label}
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
          <span className="muted" style={{ alignSelf: 'flex-end', fontSize: 12, marginLeft: 'auto' }}>
            {records.loading ? '読み込み中…' : (
              histFiltersActive
                ? `${filteredRecords.length} 件 (元 ${records.data?.length ?? 0} 件) / 合計 ${
                    num(filteredRecords.reduce((s, r) => s + Number(r.quantity_kg || 0), 0), 1)
                  } kg`
                : `${records.data?.length ?? 0} 件 / 合計 ${
                    records.data
                      ? num(records.data.reduce((s, r) => s + Number(r.quantity_kg || 0), 0), 1)
                      : 0
                  } kg`
            )}
          </span>
        </div>
        {records.error && <div className="alert error">{records.error}</div>}
        {editRecErr && <div className="alert error">{editRecErr}</div>}
        {records.data && records.data.length > 0 && filteredRecords.length === 0 && (
          <div className="muted" style={{ padding: '8px 12px' }}>
            フィルタに一致する出庫履歴がありません。 (元 {records.data.length} 件)
          </div>
        )}
        {filteredRecords.length > 0 && (
          <table>
            <thead>
              <tr>
                {isCol('outbound_date')   && <HistSortHeader k="outbound_date">出庫日</HistSortHeader>}
                {isCol('lot_code')        && <HistSortHeader k="lot_code" num>整理番号</HistSortHeader>}
                {isCol('inbound_date')    && <th>入荷日</th>}
                {isCol('spec')            && <HistSortHeader k="spec">規格 / 産地</HistSortHeader>}
                {isCol('supplier_name')   && <HistSortHeader k="supplier_name">仕入先</HistSortHeader>}
                {isCol('kg_per_case')     && <HistSortHeader k="kg_per_case" num>C/S重量</HistSortHeader>}
                {isCol('quantity_kg')     && <HistSortHeader k="quantity_kg" num>出庫量</HistSortHeader>}
                {isCol('created_by_name') && <HistSortHeader k="created_by_name">担当</HistSortHeader>}
                {isCol('note')            && <th>備考</th>}
                <th style={{ width: 140 }}></th>
              </tr>
            </thead>
            <tbody>
              {filteredRecords.map((r) => {
                const editing = editRecId === r.record_id && editRecData != null
                if (editing && editRecData) return (
                  <tr key={r.record_id} style={{ background: 'var(--accent-bg, #e8f4fd)' }}>
                    {isCol('outbound_date') && <td>
                      <input type="date" value={editRecData.outbound_date}
                        onChange={(e) => setEditRecData({ ...editRecData, outbound_date: e.target.value })}
                        style={{ width: 130, fontSize: 12 }}/>
                    </td>}
                    {isCol('lot_code')        && <td><code>{r.lot_code}</code></td>}
                    {isCol('inbound_date')    && <td>{r.inbound_date ? ymd(r.inbound_date) : '—'}</td>}
                    {isCol('spec')            && <td>{formatGrade(r.spec_type, r.grade_level, r.size_label, { spaces: true })} / {r.origin_name}</td>}
                    {isCol('supplier_name')   && <td>{r.supplier_name}</td>}
                    {isCol('kg_per_case')     && <td className="num">{r.kg_per_case ? num(r.kg_per_case, 2) : '—'}</td>}
                    {isCol('quantity_kg')     && <td className="num">
                      <input type="number" step="0.0001" min="0" value={editRecData.quantity_kg}
                        onChange={(e) => setEditRecData({ ...editRecData, quantity_kg: e.target.value })}
                        style={{ width: 80, fontSize: 12, padding: '2px 4px' }}/>
                    </td>}
                    {isCol('created_by_name') && <td>{r.created_by_name ?? '—'}</td>}
                    {isCol('note')            && <td>
                      <input value={editRecData.note}
                        onChange={(e) => setEditRecData({ ...editRecData, note: e.target.value })}
                        placeholder="備考"
                        style={{ width: '95%', fontSize: 12, padding: '2px 4px' }}/>
                    </td>}
                    <td>
                      <div>
                        {!isCol('note') && (
                          <input value={editRecData.note}
                            onChange={(e) => setEditRecData({ ...editRecData, note: e.target.value })}
                            placeholder="備考"
                            style={{ width: 120, fontSize: 12, padding: '2px 4px', marginRight: 4 }}/>
                        )}
                        <button type="button" className="small" disabled={editRecBusy}
                          onClick={() => saveEditRec(r.record_id)}
                          style={{ padding: '2px 8px' }}>
                          {editRecBusy ? '保存中…' : '✓ 保存'}
                        </button>
                        <button type="button" className="ghost small" disabled={editRecBusy}
                          onClick={cancelEditRec}
                          style={{ marginLeft: 2, padding: '2px 8px' }}>×</button>
                      </div>
                      {editRecErr && editRecId === r.record_id && (
                        <div style={{
                          marginTop: 4, padding: '4px 8px',
                          background: 'var(--surface-error, #fdecea)',
                          border: '1px solid var(--danger, #c0392b)',
                          color: 'var(--danger, #c0392b)',
                          borderRadius: 4, fontSize: 11,
                        }}>
                          ❌ {editRecErr}
                        </div>
                      )}
                    </td>
                  </tr>
                )
                return (
                <tr key={r.record_id}
                  onContextMenu={(e) => rowMenu.openAt(e, r)}
                  style={{ cursor: 'context-menu' }}
                >
                  {isCol('outbound_date')   && <td>{ymd(r.outbound_date)}</td>}
                  {isCol('lot_code')        && <td><code>{r.lot_code}</code></td>}
                  {isCol('inbound_date')    && <td>{r.inbound_date ? ymd(r.inbound_date) : '—'}</td>}
                  {isCol('spec')            && <td>
                    {formatGrade(r.spec_type, r.grade_level, r.size_label, { spaces: true })} / {r.origin_name}
                  </td>}
                  {isCol('supplier_name')   && <td>{r.supplier_name}</td>}
                  {isCol('kg_per_case')     && <td className="num">{r.kg_per_case ? num(r.kg_per_case, 2) : '—'}</td>}
                  {isCol('quantity_kg')     && <td className="num">{num(r.quantity_kg, 1)}</td>}
                  {isCol('created_by_name') && <td>{r.created_by_name ?? '—'}</td>}
                  {isCol('note')            && <td style={{ fontSize: 11, color: 'var(--muted)' }}>{r.note || '—'}</td>}
                  <td>
                    <span className="inline" style={{ gap: 2 }}>
                      <button type="button" className="ghost small"
                        onClick={() => startEditRec(r)}
                        style={{ padding: '4px 6px', display: 'inline-flex', alignItems: 'center' }}
                        title="出庫を修正"
                      ><Pencil size={12} strokeWidth={1.8} aria-hidden /></button>
                      <button type="button" className="ghost small"
                        onClick={() => deleteRec(r)}
                        style={{ padding: '4px 6px', color: 'var(--danger)', display: 'inline-flex', alignItems: 'center' }}
                        title="この出庫を取り消し"
                      ><Trash2 size={12} strokeWidth={1.8} aria-hidden /></button>
                      {rowMenu.triggerButton(r, 'その他の操作')}
                    </span>
                  </td>
                </tr>
                )
              })}
            </tbody>
          </table>
        )}
        {records.data && records.data.length === 0 && !records.loading && (
          <div className="muted">この期間に出庫履歴はありません。</div>
        )}
        {records.data && records.data.length > 0 && filteredRecords.length > 0
          && filteredRecords.length < records.data.length && (
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            ※ フィルタにより {records.data.length - filteredRecords.length} 件を除外中
          </div>
        )}
      </div>

      <RowMenu<OutboundRecord>
        state={rowMenu.state}
        onClose={rowMenu.close}
        items={(r) => [
          {
            icon: '✎', label: 'この出庫を修正',
            onClick: () => startEditRec(r),
          },
          {
            icon: '🗑', label: 'この出庫を取り消し', danger: true,
            onClick: () => deleteRec(r),
          },
          { divider: true,
            icon: '🔢', label: `整理番号 ${r.lot_code} をコピー`,
            onClick: () => copyText(r.lot_code),
          },
          {
            icon: '📦', label: '置き場で見る (原料レイアウト)',
            onClick: () => navigate('/storage/ingredient'),
          },
        ]}
      />
    </div>
  )
}
