import { useMemo, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { X, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react'
import { api } from '../api/client'
import { useFetch } from '../lib/useFetch'
import { useDialog } from '../components/Dialog'
import { errorText, num, ymd, formatGrade } from '../lib/format'
import { tokenize, matchesAllTokens } from '../lib/search'
import Combobox from '../components/Combobox'
import RowMenu, { useRowMenu } from '../components/RowMenu'
import { useAuth } from '../auth/AuthContext'
import type {
  Grade,
  InboundHistoryRow,
  InboundLot,
  Origin,
  Reservation,
  ResolveResult,
  SmartInputResult,
  Supplier,
} from '../api/types'

// 規格修正 (admin only) — API response shape
interface AffectedCounts {
  outbound_records: number
  substitution_records: number
  storage_items: number
  stock_counts: number
}
interface GradePatchResponse {
  lot_id: number
  old_grade_id: number
  old_grade_label: string
  new_grade_id: number
  new_grade_label: string
  old_product_id: number
  new_product_id: number
  new_product_created: boolean
  affected: AffectedCounts
  committed: boolean
}

interface InboundTriplet {
  supplier_name: string
  origin_name: string
  spec_type: string
  grade_level: string
  size_label: string
}
interface PatternsResponse { triplets: InboundTriplet[] }

const today = () => new Date().toISOString().slice(0, 10)

/** 当月初日 / 当月末日 (YYYY-MM-DD) */
function currentMonthRange(): { from: string; to: string } {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  return {
    from: fmt(new Date(y, m, 1)),
    to:   fmt(new Date(y, m + 1, 0)),
  }
}

interface FormState {
  supplier_name: string
  origin_name: string
  spec_type: string
  grade_level: string          // 任意 (空欄は '-' 扱い)
  size_label: string           // 任意 (空欄は '-' 扱い)
  inbound_date: string
  /** 入荷数 (kg) — 実測重量。 主入力に変更。 cases は派生計算 */
  total_kg: string
  kg_per_case: string
  /** 旧形式互換: cases から復元する古い行用 (履歴編集等)、 新規入力では使わない */
  cases: string
  unit_price: string
  note: string
}

const emptyForm = (): FormState => ({
  supplier_name: '',
  origin_name: '',
  spec_type: '',
  grade_level: '',
  size_label: '',
  inbound_date: today(),
  total_kg: '',
  cases: '',
  kg_per_case: '',
  unit_price: '',
  note: '',
})

function MatchTag({ label, m }: { label: string; m: ResolveResult['supplier'] }) {
  return (
    <span style={{ marginRight: 14 }}>
      {label}:{' '}
      {m.matched ? (
        <span className="badge ok">既存 #{m.id}</span>
      ) : (
        <span className="badge pending">新規登録</span>
      )}
    </span>
  )
}

export default function InboundPage({ cropId }: { cropId?: number }) {
  const dialog = useDialog()
  const { isAdmin } = useAuth()
  // マスタ候補 (Combobox 用) — supplier/origin の基本情報 (kana, region) 用
  const suppliers = useFetch<Supplier[]>('/masters/suppliers')
  const origins   = useFetch<Origin[]>('/masters/origins')
  // 規格修正 対象 lot (= null で dialog 非表示)。 grade master は dialog 内 で
  // 対象 lot の crop_id を 使って 絞り込み fetch する (= 他作物 の 規格 が 出ない)。
  const [gradePatchLot, setGradePatchLot] = useState<InboundHistoryRow | null>(null)

  // 過去の入庫履歴 (作物単位で厳格分離)
  // 生姜画面で大蒜の規格が候補に出ないようにするため、crop_id を必ず付ける。
  const patterns = useFetch<PatternsResponse>(
    '/inbound/patterns',
    cropId ? { crop_id: String(cropId) } : undefined,
  )
  const triplets = patterns.data?.triplets ?? []

  const [memo, setMemo] = useState('')
  const [form, setForm] = useState<FormState>(emptyForm())
  const [parsed, setParsed] = useState<SmartInputResult | null>(null)
  const [resolve, setResolve] = useState<ResolveResult | null>(null)
  const [created, setCreated] = useState<InboundLot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // ─── 整理番号 予約 ───
  // 当該 crop の未使用予約があれば、 入荷登録時は必ず選択する必要あり (backend で 409)。
  // 「+ 新規予約」 で発行、 一覧から行を選ぶと selectedReservationId が立ち、
  // 登録時にそれが消費される。
  const reservations = useFetch<Reservation[]>(
    cropId ? '/reservations' : null,
    cropId ? { crop_id: String(cropId), code_kind: 'G', unused_only: 'true' }
           : undefined,
  )
  const [selectedReservationId, setSelectedReservationId] = useState<number | null>(null)
  const [showNewRsvForm, setShowNewRsvForm] = useState(false)
  const [newRsvNote, setNewRsvNote] = useState('')
  const [rsvBusy, setRsvBusy] = useState(false)

  const unusedRsvs = reservations.data ?? []
  const selectedRsv = unusedRsvs.find((r) => r.id === selectedReservationId) ?? null

  async function createReservation() {
    if (!cropId) return
    setRsvBusy(true); setError(null)
    try {
      const r = await api.post<Reservation>('/reservations', {
        crop_id: cropId, code_kind: 'G',
        note: newRsvNote.trim() || null,
      })
      setNewRsvNote('')
      setShowNewRsvForm(false)
      reservations.reload()
      // 発行直後の予約を自動選択 (大体すぐ使う想定)
      setSelectedReservationId(r.id)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setRsvBusy(false)
    }
  }

  async function deleteReservation(id: number, code: string) {
    if (!(await dialog.confirm({
      title: '予約を削除',
      message: `予約 ${code} を削除します。\n(管理者のみ可能)`,
      okLabel: '削除',
      variant: 'danger',
    }))) return
    try {
      await api.delete(`/reservations/${id}`)
      if (selectedReservationId === id) setSelectedReservationId(null)
      reservations.reload()
    } catch (e) {
      setError(errorText(e))
    }
  }

  // 入荷履歴 (デフォルト = 当月分、作物単位)
  const initialRange = useMemo(() => currentMonthRange(), [])
  const [histFrom, setHistFrom] = useState(initialRange.from)
  const [histTo,   setHistTo]   = useState(initialRange.to)
  const history = useFetch<InboundHistoryRow[]>('/inbound/history', {
    ...(cropId ? { crop_id: String(cropId) } : {}),
    date_from: histFrom, date_to: histTo,
  })

  // ─── 入荷履歴 フィルタ / ソート (フロント側でのみ適用) ───
  // 検索クエリ — スペース区切り AND マッチ
  //   (整理番号 / 規格 / 産地 / 仕入先 / 担当 / 備考 / 原料)
  const [histSearch, setHistSearch] = useState('')
  // 数量範囲フィルタ (合計kg)
  const [histMinKg, setHistMinKg] = useState('')
  const [histMaxKg, setHistMaxKg] = useState('')
  // ソート
  type HistSortKey =
    | 'inbound_date' | 'code' | 'crop_name' | 'supplier_name' | 'spec'
    | 'cases' | 'kg_per_case' | 'total_kg' | 'unit_price'
    | 'remaining_kg' | 'created_by_name'
  const [histSortKey, setHistSortKey] = useState<HistSortKey | null>(null)
  const [histSortDir, setHistSortDir] = useState<'asc' | 'desc'>('asc')
  function toggleHistSort(key: HistSortKey) {
    if (histSortKey !== key) { setHistSortKey(key); setHistSortDir('asc'); return }
    if (histSortDir === 'asc') { setHistSortDir('desc'); return }
    setHistSortKey(null)
  }
  const histSearchTokens = useMemo(() => tokenize(histSearch), [histSearch])
  const histMinKgNum = histMinKg ? Number(histMinKg) : null
  const histMaxKgNum = histMaxKg ? Number(histMaxKg) : null
  const filteredHistory = useMemo<InboundHistoryRow[]>(() => {
    if (!history.data) return []
    let arr = history.data
    if (histSearchTokens.length > 0) {
      arr = arr.filter((r) => {
        const text = [
          r.code ?? '',
          r.crop_name ?? '',
          r.supplier_name ?? '',
          r.spec_type ?? '', r.grade_level ?? '', r.size_label ?? '',
          r.origin_name ?? '',
          r.created_by_name ?? '',
          r.note ?? '',
        ].join(' ')
        return matchesAllTokens(text, histSearchTokens)
      })
    }
    if (histMinKgNum != null && !Number.isNaN(histMinKgNum)) {
      arr = arr.filter((r) => Number(r.total_kg) >= histMinKgNum)
    }
    if (histMaxKgNum != null && !Number.isNaN(histMaxKgNum)) {
      arr = arr.filter((r) => Number(r.total_kg) <= histMaxKgNum)
    }
    if (histSortKey) {
      const dir = histSortDir === 'asc' ? 1 : -1
      const getVal = (r: InboundHistoryRow): number | string => {
        switch (histSortKey) {
          case 'inbound_date':    return r.inbound_date ?? ''
          case 'code':            return r.code ?? ''
          case 'crop_name':       return r.crop_name ?? ''
          case 'supplier_name':   return r.supplier_name ?? ''
          case 'spec':            return `${r.spec_type ?? ''} ${r.origin_name ?? ''}`
          case 'cases':           return Number(r.cases ?? 0)
          case 'kg_per_case':     return Number(r.kg_per_case ?? 0)
          case 'total_kg':        return Number(r.total_kg ?? 0)
          case 'unit_price':      return Number(r.unit_price ?? 0)
          case 'remaining_kg':    return Number(r.remaining_kg ?? 0)
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
  }, [history.data, histSearchTokens, histMinKgNum, histMaxKgNum, histSortKey, histSortDir])

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
          <Icon size={11} strokeWidth={1.8} style={{ opacity: active ? 1 : 0.4 }} />
        </span>
      </th>
    )
  }
  const histFiltersActive = histSearchTokens.length > 0 || histMinKg !== '' || histMaxKg !== '' || histSortKey !== null
  function clearHistFilters() {
    setHistSearch(''); setHistMinKg(''); setHistMaxKg('')
    setHistSortKey(null); setHistSortDir('asc')
  }

  // 合計値 (フィルタ後 — または フィルタ無し時は 全体)
  const histTotals = useMemo(() => {
    const src = histFiltersActive ? filteredHistory : (history.data ?? [])
    let totalKg = 0, totalPrice = 0, totalRemaining = 0
    for (const r of src) {
      totalKg        += Number(r.total_kg ?? 0)
      totalPrice     += Number(r.total_price ?? 0)
      totalRemaining += Number(r.remaining_kg ?? 0)
    }
    return { count: src.length, totalKg, totalPrice, totalRemaining }
  }, [history.data, filteredHistory, histFiltersActive])

  // ---- 履歴行のインライン編集 ----
  interface RowEdit {
    inbound_date: string
    cases: string
    kg_per_case: string
    unit_price: string
    note: string
  }
  const [editingLot, setEditingLot] = useState<number | null>(null)
  const [editData, setEditData] = useState<RowEdit | null>(null)
  const [editBusy, setEditBusy] = useState(false)
  const [editErr, setEditErr] = useState<string | null>(null)

  function startEdit(r: InboundHistoryRow) {
    setEditingLot(r.lot_id)
    setEditData({
      inbound_date: r.inbound_date.slice(0, 10),
      cases: r.cases ?? '',
      kg_per_case: r.kg_per_case ?? '',
      unit_price: r.unit_price ?? '',
      note: r.note ?? '',
    })
    setError(null); setEditErr(null)
  }
  function cancelEdit() { setEditingLot(null); setEditData(null); setEditErr(null) }
  async function saveEdit(lotId: number) {
    if (!editData) return
    setEditBusy(true); setError(null); setEditErr(null)
    try {
      await api.patch(`/inbound/lots/${lotId}`, {
        inbound_date: editData.inbound_date,
        cases: Number(editData.cases),
        kg_per_case: Number(editData.kg_per_case),
        unit_price: editData.unit_price === '' ? 0 : Number(editData.unit_price),
        note: editData.note || null,
      })
      setEditingLot(null); setEditData(null); setEditErr(null)
      history.reload()
    } catch (e) {
      const msg = errorText(e)
      setEditErr(msg); setError(msg)
    } finally {
      setEditBusy(false)
    }
  }

  // 右クリック / ⋮ ボタン
  const navigate = useNavigate()
  const rowMenu = useRowMenu<InboundHistoryRow>()

  async function copyText(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text)
      setError(null)
      // 簡易フィードバック (上部 success bar が長いので message として再利用)
      const old = document.title
      document.title = `✓ ${label}コピー`
      setTimeout(() => { document.title = old }, 1500)
    } catch { /* ignore */ }
  }

  const set = (k: keyof FormState, v: string) =>
    setForm((f) => ({ ...f, [k]: v }))

  // ---- カスケード候補 (過去入庫履歴から作物単位で抽出) ----
  // supplierItems: 全 distinct supplier
  // originItems: supplier 選択時はその supplier の組合せに絞る
  // specItems: supplier + origin で更に絞る
  // どれも本マスタ (suppliers/origins) と合わせて kana/region を補完
  const supplierByName = useMemo(() => {
    const map = new Map<string, Supplier>()
    for (const s of suppliers.data ?? []) map.set(s.name, s)
    return map
  }, [suppliers.data])
  const originByName = useMemo(() => {
    const map = new Map<string, Origin>()
    for (const o of origins.data ?? []) map.set(o.name, o)
    return map
  }, [origins.data])

  const supplierItems = useMemo<Supplier[]>(() => {
    const names = new Set<string>()
    for (const t of triplets) names.add(t.supplier_name)
    return Array.from(names).sort().map((n) =>
      supplierByName.get(n) ?? ({ id: 0, name: n, name_kana: null } as Supplier))
  }, [triplets, supplierByName])

  const originItems = useMemo<Origin[]>(() => {
    const names = new Set<string>()
    for (const t of triplets) {
      if (form.supplier_name && t.supplier_name !== form.supplier_name) continue
      names.add(t.origin_name)
    }
    return Array.from(names).sort().map((n) =>
      originByName.get(n) ?? ({ id: 0, name: n, region: null, name_kana: null } as Origin))
  }, [triplets, form.supplier_name, originByName])

  const specItems = useMemo<{ spec_type: string }[]>(() => {
    const names = new Set<string>()
    for (const t of triplets) {
      if (form.supplier_name && t.supplier_name !== form.supplier_name) continue
      if (form.origin_name && t.origin_name !== form.origin_name) continue
      names.add(t.spec_type)
    }
    return Array.from(names).sort().map((n) => ({ spec_type: n }))
  }, [triplets, form.supplier_name, form.origin_name])

  // 等級候補 — supplier+origin+spec で絞り込み (DB '-' は「未指定」として除外)
  const gradeItems = useMemo<{ grade_level: string }[]>(() => {
    const names = new Set<string>()
    for (const t of triplets) {
      if (form.supplier_name && t.supplier_name !== form.supplier_name) continue
      if (form.origin_name && t.origin_name !== form.origin_name) continue
      if (form.spec_type && t.spec_type !== form.spec_type) continue
      if (t.grade_level && t.grade_level !== '-') names.add(t.grade_level)
    }
    return Array.from(names).sort().map((n) => ({ grade_level: n }))
  }, [triplets, form.supplier_name, form.origin_name, form.spec_type])

  // サイズ候補 — supplier+origin+spec+grade で絞り込み
  const sizeItems = useMemo<{ size_label: string }[]>(() => {
    const names = new Set<string>()
    for (const t of triplets) {
      if (form.supplier_name && t.supplier_name !== form.supplier_name) continue
      if (form.origin_name && t.origin_name !== form.origin_name) continue
      if (form.spec_type && t.spec_type !== form.spec_type) continue
      if (form.grade_level && t.grade_level !== form.grade_level) continue
      if (t.size_label && t.size_label !== '-') names.add(t.size_label)
    }
    return Array.from(names).sort().map((n) => ({ size_label: n }))
  }, [triplets, form.supplier_name, form.origin_name, form.spec_type, form.grade_level])

  // この組合せが過去履歴に存在するか (新規組合せ警告用)
  // 等級・サイズは空欄なら '-' 扱いで比較
  const comboInHistory = useMemo(() => {
    if (!form.supplier_name || !form.origin_name || !form.spec_type) return null
    const g = form.grade_level || '-'
    const sz = form.size_label || '-'
    return triplets.some(
      (t) => t.supplier_name === form.supplier_name
        && t.origin_name === form.origin_name
        && t.spec_type === form.spec_type
        && (t.grade_level || '-') === g
        && (t.size_label || '-') === sz,
    )
  }, [triplets, form.supplier_name, form.origin_name, form.spec_type,
      form.grade_level, form.size_label])

  async function doParse() {
    setError(null)
    setCreated(null)
    setResolve(null)
    try {
      const r = await api.post<SmartInputResult>('/inbound/parse', {
        text: memo,
      })
      setParsed(r)
      // メモ解析結果 → form 反映。 cases × kg_per_case → total_kg (新形式)
      const kpc = r.kg_per_case != null ? Number(r.kg_per_case) : null
      const cs = r.cases != null ? Number(r.cases) : null
      const derivedTotal = (cs != null && kpc != null) ? cs * kpc : null
      setForm((f) => ({
        ...f,
        supplier_name: r.supplier_name ?? '',
        origin_name: r.origin_name ?? '',
        spec_type: r.spec_type ?? '',
        total_kg: derivedTotal != null ? String(derivedTotal) : '',
        cases: cs != null ? String(cs) : '',
        kg_per_case: r.kg_per_case != null ? String(r.kg_per_case) : '',
        unit_price: r.unit_price != null ? String(r.unit_price) : '',
      }))
      await doResolve({
        supplier_name: r.supplier_name,
        origin_name: r.origin_name,
        spec_type: r.spec_type,
      })
    } catch (e) {
      setError(errorText(e))
    }
  }

  async function doResolve(payload?: {
    supplier_name: string | null
    origin_name: string | null
    spec_type: string | null
    grade_level?: string | null
    size_label?: string | null
  }) {
    setError(null)
    try {
      const baseBody = payload ?? {
        supplier_name: form.supplier_name,
        origin_name: form.origin_name,
        spec_type: form.spec_type,
        grade_level: form.grade_level || null,
        size_label: form.size_label || null,
      }
      // crop_id を 必ず 送る (大蒜/大蒜実験 等 同名 grade+origin 別 crop の 区別 用)
      const body = { ...baseBody, crop_id: cropId ?? null }
      const r = await api.post<ResolveResult>('/inbound/resolve', body)
      setResolve(r)
    } catch (e) {
      setError(errorText(e))
    }
  }

  async function doRegister(e: FormEvent) {
    e.preventDefault()
    setError(null)
    // 未使用予約があるのに未選択は backend 側で 409 になるが、 先に UI で警告
    if (unusedRsvs.length > 0 && selectedReservationId == null) {
      setError(`未使用の予約 (${unusedRsvs[0].code} ほか ${unusedRsvs.length}件) があります。`
        + ' 先に予約パネルから選んでください。')
      return
    }
    setBusy(true)
    try {
      const r = await api.post<InboundLot>('/inbound/lots/smart', {
        supplier_name: form.supplier_name,
        origin_name: form.origin_name,
        spec_type: form.spec_type,
        grade_level: form.grade_level || null,
        size_label: form.size_label || null,
        inbound_date: form.inbound_date,
        // 主入力 = total_kg。 cases は backend で kg_per_case から派生計算
        total_kg: Number(form.total_kg),
        kg_per_case: Number(form.kg_per_case),
        unit_price: form.unit_price === '' ? null : Number(form.unit_price),
        note: form.note || null,
        auto_register: true,
        crop_id: cropId ?? null,
        use_reservation_id: selectedReservationId,
      })
      setCreated(r)
      setForm(emptyForm())
      setParsed(null)
      setResolve(null)
      setMemo('')
      setSelectedReservationId(null)
      // マスタ再取得 (新規作成された場合に候補に反映)
      suppliers.reload(); origins.reload()
      patterns.reload()
      history.reload()
      reservations.reload()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  // total_kg は form の主入力。 cases は派生計算用に保持
  const totalKg = form.total_kg ? Number(form.total_kg) : null
  const derivedCases =
    form.total_kg && form.kg_per_case && Number(form.kg_per_case) > 0
      ? Number(form.total_kg) / Number(form.kg_per_case)
      : null
  // 整数ケース + 端数 kg に分解
  const integerCases = derivedCases != null ? Math.floor(derivedCases) : null
  const remainderKg =
    derivedCases != null && integerCases != null && Number(form.kg_per_case) > 0
      ? Number(form.total_kg) - integerCases * Number(form.kg_per_case)
      : 0
  const hasRemainder = remainderKg > 0.0001

  return (
    <div>
      <h2>入庫登録</h2>
      <p className="subtitle">
        メモ書きから自動で項目を抽出。仕入先・産地・規格は既存マスタから検索 (スペースで複数語 AND)、
        未登録の名前は「➕ 新規」で即時作成され、登録時にマスタへ反映されます。
      </p>

      {/* ─── 予約パネル ─── */}
      {cropId && (
        <div className="panel" style={{
          marginBottom: 12,
          borderLeft: unusedRsvs.length > 0
            ? '3px solid var(--warning, #f5a623)' : '3px solid var(--border)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>
              整理番号 予約 ({unusedRsvs.length} 件 未使用)
            </h3>
            <span style={{ flex: 1 }} />
            <button type="button"
              onClick={() => setShowNewRsvForm((v) => !v)}
              disabled={rsvBusy}
              className="ghost small"
              style={{ fontSize: 11, padding: '2px 8px' }}>
              {showNewRsvForm ? 'キャンセル' : '+ 新規予約'}
            </button>
          </div>
          {unusedRsvs.length > 0 && (
            <p className="muted" style={{ fontSize: 11, margin: '4px 0 0' }}>
              未使用の予約があります。 入荷登録時は必ず予約から選択してください
              (放置防止ポリシー)。
            </p>
          )}
          {showNewRsvForm && (
            <div style={{
              marginTop: 8, padding: 8,
              background: 'var(--surface, #f8f9fa)', borderRadius: 4,
              display: 'flex', gap: 6, alignItems: 'flex-end',
            }}>
              <div className="field" style={{ flex: 1, marginBottom: 0 }}>
                <label style={{ fontSize: 11 }}>メモ (任意)</label>
                <input
                  value={newRsvNote}
                  onChange={(e) => setNewRsvNote(e.target.value)}
                  placeholder="例: 明日着 高知産生姜"
                  style={{ fontSize: 13 }}
                  maxLength={200}
                />
              </div>
              <button type="button" onClick={createReservation}
                disabled={rsvBusy}
                style={{ padding: '6px 12px', fontSize: 12 }}>
                {rsvBusy ? '発行中…' : '予約番号を発行'}
              </button>
            </div>
          )}
          {unusedRsvs.length === 0 && !showNewRsvForm && (
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              未使用の予約はありません。 通常通り入荷登録すれば 自動採番します。
            </div>
          )}
          {unusedRsvs.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
              {unusedRsvs.map((r) => {
                const isSelected = r.id === selectedReservationId
                const ageDays = Math.floor(
                  (Date.now() - new Date(r.created_at).getTime()) / 86_400_000)
                return (
                  <div key={r.id}
                    onClick={() => setSelectedReservationId(isSelected ? null : r.id)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      padding: '6px 10px',
                      background: isSelected
                        ? 'rgba(26, 115, 232, 0.12)' : '#fff',
                      border: '1px solid ' + (isSelected
                        ? 'var(--primary, #1a73e8)' : 'var(--border)'),
                      borderRadius: 16, cursor: 'pointer',
                      fontSize: 12, fontWeight: isSelected ? 600 : 400,
                    }}
                    title={r.note ? `メモ: ${r.note}` : '(メモなし)'}
                  >
                    {isSelected && (
                      <span style={{ color: 'var(--primary)' }}>✓</span>
                    )}
                    <strong>{r.code}</strong>
                    {r.note && (
                      <span className="muted" style={{ fontSize: 10, maxWidth: 140,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.note}
                      </span>
                    )}
                    <span className="muted" style={{ fontSize: 10 }}>
                      {ageDays === 0 ? '今日' : `${ageDays}日前`}
                      {r.created_by_name && ` / ${r.created_by_name}`}
                    </span>
                    <button type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        deleteReservation(r.id, r.code)
                      }}
                      title="予約をキャンセル (admin のみ)"
                      style={{
                        width: 18, height: 18, padding: 0, fontSize: 10,
                        background: 'transparent', color: 'var(--muted)',
                        border: 'none', borderRadius: '50%', cursor: 'pointer',
                        marginLeft: 2,
                      }}>×</button>
                  </div>
                )
              })}
            </div>
          )}
          {selectedRsv && (
            <div style={{
              marginTop: 8, padding: '6px 10px',
              background: 'rgba(26, 115, 232, 0.08)',
              borderRadius: 4, fontSize: 12,
            }}>
              ✓ 今回の入荷は予約 <strong>{selectedRsv.code}</strong> として登録されます。
            </div>
          )}
        </div>
      )}

      {error && <div className="alert error">{error}</div>}
      {created && (
        <div className="alert success">
          整理番号 {created.id} で入庫ロットを登録しました（
          {num(created.total_kg, 1)} kg
          {created.unit_price == null ? '・単価未確定' : ''}）。
        </div>
      )}

      <div className="panel">
        <h3>スマート・メモ・インプット</h3>
        <div className="field">
          <label>メモ（例: 西川 高知産 新物 700ケース 16kg 605円）</label>
          <textarea
            rows={2}
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder="仕入先 産地 規格 ケース数 kg/ケース 単価"
          />
        </div>
        <button
          type="button"
          className="secondary"
          onClick={doParse}
          disabled={!memo.trim()}
        >
          解析してフォームに反映
        </button>
        {parsed && (
          <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
            確度: {parsed.confidence}
            {parsed.warnings.length > 0 && ' / ' + parsed.warnings.join(' / ')}
          </div>
        )}
      </div>

      <form className="panel" onSubmit={doRegister}>
        <h3>入庫内容</h3>
        <div className="row">
          <div className="field">
            <label>
              仕入先
              <span className="muted" style={{ fontWeight: 400, fontSize: 11, marginLeft: 6 }}>
                ({supplierItems.length} 件{cropId ? '（この原料の入庫履歴から）' : ''})
              </span>
            </label>
            <Combobox<Supplier>
              items={supplierItems}
              getKey={(s) => s.name}
              getLabel={(s) => s.name + (s.name_kana ? ` (${s.name_kana})` : '')}
              getSearchText={(s) => `${s.name} ${s.name_kana ?? ''}`}
              value={form.supplier_name || null}
              onChange={(v) => {
                const next = v != null ? String(v) : ''
                // 仕入先を変えたら下流 (産地・規格) は組合せ整合の為クリア
                setForm((f) => (f.supplier_name === next
                  ? f
                  : { ...f, supplier_name: next, origin_name: '', spec_type: '' }))
              }}
              placeholder="検索 (未登録名は「➕ 新規」で即作成)"
              maxResults={60}
              freeText
              onCreateNew={(t) => setForm((f) => ({
                ...f, supplier_name: t, origin_name: '', spec_type: '',
              }))}
              createLabel={(q) => `➕ 「${q}」を新規仕入先として登録`}
            />
          </div>
          <div className="field">
            <label>
              産地
              <span className="muted" style={{ fontWeight: 400, fontSize: 11, marginLeft: 6 }}>
                ({originItems.length} 件
                {form.supplier_name ? `／${form.supplier_name} の組合せ` : ''})
              </span>
            </label>
            <Combobox<Origin>
              items={originItems}
              getKey={(o) => o.name}
              getLabel={(o) => o.name + (o.region ? ` (${o.region})` : '')}
              getSearchText={(o) => `${o.name} ${o.name_kana ?? ''} ${o.region ?? ''}`}
              value={form.origin_name || null}
              onChange={(v) => {
                const next = v != null ? String(v) : ''
                setForm((f) => (f.origin_name === next
                  ? f
                  : { ...f, origin_name: next, spec_type: '' }))
              }}
              placeholder="検索 (未登録名は「➕ 新規」で即作成)"
              maxResults={60}
              freeText
              onCreateNew={(t) => setForm((f) => ({
                ...f, origin_name: t, spec_type: '',
              }))}
              createLabel={(q) => `➕ 「${q}」を新規産地として登録`}
            />
          </div>
          <div className="field">
            <label>
              規格
              <span className="muted" style={{ fontWeight: 400, fontSize: 11, marginLeft: 6 }}>
                ({specItems.length} 件
                {form.supplier_name || form.origin_name
                  ? `／${[form.supplier_name, form.origin_name].filter(Boolean).join(' × ')} の組合せ`
                  : ''})
              </span>
            </label>
            <Combobox<{ spec_type: string }>
              items={specItems}
              getKey={(s) => s.spec_type}
              getLabel={(s) => s.spec_type}
              getSearchText={(s) => s.spec_type}
              value={form.spec_type || null}
              onChange={(v) => {
                const next = v != null ? String(v) : ''
                setForm((f) => (f.spec_type === next
                  ? f
                  : { ...f, spec_type: next, grade_level: '', size_label: '' }))
              }}
              placeholder="検索 (未登録規格は「➕ 新規」で即作成)"
              maxResults={60}
              freeText
              onCreateNew={(t) => setForm((f) => ({
                ...f, spec_type: t, grade_level: '', size_label: '',
              }))}
              createLabel={(q) => `➕ 「${q}」を新規規格として登録`}
            />
          </div>
        </div>
        <div className="row">
          <div className="field">
            <label>
              等級 <span className="muted" style={{ fontWeight: 400, fontSize: 11, marginLeft: 6 }}>
                (任意 / {gradeItems.length} 件
                {form.spec_type ? `／${form.spec_type} の組合せ` : ''})
              </span>
            </label>
            <Combobox<{ grade_level: string }>
              items={gradeItems}
              getKey={(s) => s.grade_level}
              getLabel={(s) => s.grade_level}
              getSearchText={(s) => s.grade_level}
              value={form.grade_level || null}
              onChange={(v) => {
                const next = v != null ? String(v) : ''
                setForm((f) => (f.grade_level === next
                  ? f
                  : { ...f, grade_level: next, size_label: '' }))
              }}
              placeholder="例: A / 特選 / 加工品 (空欄 = 未指定)"
              maxResults={40}
              freeText
              onCreateNew={(t) => setForm((f) => ({
                ...f, grade_level: t, size_label: '',
              }))}
              createLabel={(q) => `➕ 「${q}」を新規等級として登録`}
            />
          </div>
          <div className="field">
            <label>
              サイズ <span className="muted" style={{ fontWeight: 400, fontSize: 11, marginLeft: 6 }}>
                (任意 / {sizeItems.length} 件
                {form.spec_type || form.grade_level
                  ? `／${[form.spec_type, form.grade_level].filter(Boolean).join(' × ')} の組合せ`
                  : ''})
              </span>
            </label>
            <Combobox<{ size_label: string }>
              items={sizeItems}
              getKey={(s) => s.size_label}
              getLabel={(s) => s.size_label}
              getSearchText={(s) => s.size_label}
              value={form.size_label || null}
              onChange={(v) => set('size_label', v != null ? String(v) : '')}
              placeholder="例: L / M / S (空欄 = 未指定)"
              maxResults={40}
              freeText
              onCreateNew={(t) => set('size_label', t)}
              createLabel={(q) => `➕ 「${q}」を新規サイズとして登録`}
            />
          </div>
        </div>
        <div className="row">
          <div className="field">
            <label>入荷日</label>
            <input
              type="date"
              value={form.inbound_date}
              onChange={(e) => set('inbound_date', e.target.value)}
            />
          </div>
          <div className="field">
            <label>入荷数 (kg) <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input
              type="number"
              step="0.01"
              value={form.total_kg}
              onChange={(e) => set('total_kg', e.target.value)}
              placeholder="例: 100.0 (実測 kg)"
              title="現場で実測した入荷重量。 これを基準に登録します"
            />
          </div>
          <div className="field">
            <label>kg/ケース <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input
              type="number"
              step="0.0001"
              value={form.kg_per_case}
              onChange={(e) => set('kg_per_case', e.target.value)}
              placeholder="例: 20"
            />
          </div>
          <div className="field">
            <label>ケース数 <span className="muted" style={{ fontSize: 11 }}>(自動計算)</span></label>
            <input
              type="text"
              value={
                integerCases == null
                  ? ''
                  : hasRemainder
                    ? `${integerCases} ケース + ${num(remainderKg, 1)} kg`
                    : `${integerCases} ケース`
              }
              readOnly
              tabIndex={-1}
              style={{
                background: 'var(--surface, #f8f9fa)',
                color: hasRemainder ? 'var(--warning, #f5a623)' : 'var(--muted)',
                fontWeight: hasRemainder ? 600 : 400,
              }}
              title="入荷数 / kg/ケース で自動計算。 端数 (1 ケース未満) は kg で表示"
            />
          </div>
          <div className="field">
            <label>単価（円・任意）</label>
            <input
              type="number"
              step="0.00001"
              value={form.unit_price}
              onChange={(e) => set('unit_price', e.target.value)}
              placeholder="後追い入力可 (小数 5 桁 まで)"
            />
          </div>
        </div>
        <div className="field">
          <label>備考（任意）</label>
          <input
            value={form.note}
            onChange={(e) => set('note', e.target.value)}
          />
        </div>

        <div className="inline" style={{ marginBottom: 10 }}>
          <button type="button" className="secondary" onClick={() => doResolve()}>
            マスタ照合
          </button>
          {totalKg != null && (
            <span className="muted">入荷 {num(totalKg, 1)} kg</span>
          )}
          {integerCases != null && (
            <span className="muted">
              ({integerCases} ケース
              {hasRemainder && (
                <span style={{ color: 'var(--warning, #f5a623)' }}>
                  {' + '}{num(remainderKg, 1)} kg
                </span>
              )})
            </span>
          )}
        </div>

        {resolve && (
          <div className="alert info">
            <MatchTag label="仕入先" m={resolve.supplier} />
            <MatchTag label="産地" m={resolve.origin} />
            <MatchTag label="規格" m={resolve.grade} />
            {!resolve.all_resolved && '（新規分は登録時に自動作成されます）'}
          </div>
        )}

        {comboInHistory === false && (
          <div className="alert" style={{
            background: 'var(--surface-warn, #fff8e1)',
            border: '1px solid var(--warn, #f5c542)',
            color: 'var(--text)', marginBottom: 10, fontSize: 13,
          }}>
            ⚠ 初めての組合せです:
            <strong style={{ marginLeft: 6 }}>
              {form.supplier_name} × {form.origin_name} × {form.spec_type}
            </strong>
            {cropId && '（この原料での入庫履歴に該当パターンが見つかりません）'}
            。誤入力でないかご確認ください。
          </div>
        )}

        <button
          type="submit"
          disabled={
            busy ||
            !form.supplier_name ||
            !form.origin_name ||
            !form.spec_type ||
            !form.total_kg ||
            !form.kg_per_case ||
            Number(form.kg_per_case) <= 0
          }
        >
          {busy ? '登録中…' : '入庫ロットを登録'}
        </button>
      </form>

      {/* ===== 入荷履歴 (デフォルト=当月、作物ごと) ===== */}
      <div className="panel">
        <h3>入荷履歴 {cropId ? '(この原料)' : '(全原料)'}</h3>
        <p className="muted" style={{ fontSize: 11, marginTop: 0 }}>
          修正ルール: 備考・単価は常に変更可。日付・ケース数・kg/C/S は
          下流 (このロットからの出庫) が成立する範囲のみ変更可
          (出庫済合計を下回る数量や、出庫日より後ろの入荷日は拒否されます)。
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
        <div className="inline" style={{ marginBottom: 6, flexWrap: 'wrap', gap: 8 }}>
          <div className="field" style={{ minWidth: 220, flex: '1 1 220px' }}>
            <label>検索 <span className="muted" style={{ fontSize: 10 }}>
              (整理番号・規格・産地・仕入先・担当・備考{!cropId && '・原料'}、 スペース AND)
            </span></label>
            <div style={{ position: 'relative' }}>
              <input type="text" value={histSearch}
                onChange={(e) => setHistSearch(e.target.value)}
                placeholder="例: 田子 m以上、 みどり物産、 R38"
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
        </div>
        {/* 合計サマリー — フィルタ適用中は その内訳 */}
        <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
          {history.loading ? '読み込み中…' : (
            histFiltersActive ? (
              <>
                <strong>{histTotals.count} 件</strong> (元 {history.data?.length ?? 0} 件)
                {' '} / 合計 <strong>{num(histTotals.totalKg, 1)} kg</strong>
                {' '} / 金額 <strong>¥{num(histTotals.totalPrice, 0)}</strong>
                {' '} / 残量 <strong>{num(histTotals.totalRemaining, 1)} kg</strong>
              </>
            ) : (
              <>
                {histTotals.count} 件 / 合計 <strong>{num(histTotals.totalKg, 1)} kg</strong>
                {' '} / 金額 <strong>¥{num(histTotals.totalPrice, 0)}</strong>
                {' '} / 残量 <strong>{num(histTotals.totalRemaining, 1)} kg</strong>
              </>
            )
          )}
        </div>
        {history.error && <div className="alert error">{history.error}</div>}
        {history.data && history.data.length > 0 && filteredHistory.length === 0 && (
          <div className="muted" style={{ padding: '8px 12px' }}>
            フィルタに一致する入荷履歴がありません。 (元 {history.data.length} 件)
          </div>
        )}
        {filteredHistory.length > 0 && (
          <table>
            <thead>
              <tr>
                <HistSortHeader k="inbound_date">入荷日</HistSortHeader>
                <HistSortHeader k="code">整理番号</HistSortHeader>
                {!cropId && <HistSortHeader k="crop_name">原料</HistSortHeader>}
                <HistSortHeader k="supplier_name">仕入先</HistSortHeader>
                <HistSortHeader k="spec">規格 / 産地</HistSortHeader>
                <HistSortHeader k="cases" num>C/S</HistSortHeader>
                <HistSortHeader k="kg_per_case" num>kg/C/S</HistSortHeader>
                <HistSortHeader k="total_kg" num>合計kg</HistSortHeader>
                <HistSortHeader k="unit_price" num>単価</HistSortHeader>
                <HistSortHeader k="remaining_kg" num>残量</HistSortHeader>
                <HistSortHeader k="created_by_name">担当</HistSortHeader>
                <th style={{ width: 90 }}></th>
              </tr>
            </thead>
            <tbody>
              {filteredHistory.map((r) => {
                const isEditing = editingLot === r.lot_id && editData != null
                if (isEditing && editData) return (
                  <tr key={r.lot_id} style={{ background: 'var(--accent-bg, #e8f4fd)' }}>
                    <td>
                      <input type="date" value={editData.inbound_date}
                        onChange={(e) => setEditData({ ...editData, inbound_date: e.target.value })}
                        style={{ width: 130, fontSize: 12 }}/>
                    </td>
                    <td><code>{r.code}</code></td>
                    {!cropId && <td>{r.crop_name}</td>}
                    <td>{r.supplier_name}</td>
                    <td>{formatGrade(r.spec_type, r.grade_level, r.size_label, { spaces: true })}{' / '}{r.origin_name}</td>
                    <td className="num">
                      <input type="number" step="0.01" min="0" value={editData.cases}
                        onChange={(e) => setEditData({ ...editData, cases: e.target.value })}
                        style={{ width: 70, fontSize: 12, padding: '2px 4px' }}/>
                    </td>
                    <td className="num">
                      <input type="number" step="0.0001" min="0" value={editData.kg_per_case}
                        onChange={(e) => setEditData({ ...editData, kg_per_case: e.target.value })}
                        style={{ width: 80, fontSize: 12, padding: '2px 4px' }}/>
                    </td>
                    <td className="num">
                      {Number(editData.cases) && Number(editData.kg_per_case)
                        ? num(Number(editData.cases) * Number(editData.kg_per_case), 1)
                        : '—'}
                    </td>
                    <td className="num">
                      <input type="number" step="0.00001" min="0" value={editData.unit_price}
                        onChange={(e) => setEditData({ ...editData, unit_price: e.target.value })}
                        placeholder="0=未確定 (5 桁)"
                        style={{ width: 100, fontSize: 12, padding: '2px 4px' }}/>
                    </td>
                    <td className="num">{num(r.remaining_kg, 1)}</td>
                    <td colSpan={2}>
                      <div>
                        <input value={editData.note}
                          onChange={(e) => setEditData({ ...editData, note: e.target.value })}
                          placeholder="備考"
                          style={{ width: '60%', fontSize: 12, padding: '2px 4px' }}/>
                        <button type="button" className="small" disabled={editBusy}
                          onClick={() => saveEdit(r.lot_id)}
                          style={{ marginLeft: 4, padding: '2px 8px' }}>
                          {editBusy ? '保存中…' : '✓ 保存'}
                        </button>
                        <button type="button" className="ghost small" disabled={editBusy}
                          onClick={cancelEdit}
                          style={{ marginLeft: 2, padding: '2px 8px' }}>×</button>
                      </div>
                      {editErr && editingLot === r.lot_id && (
                        <div style={{
                          marginTop: 4, padding: '4px 8px',
                          background: 'var(--surface-error, #fdecea)',
                          border: '1px solid var(--danger, #c0392b)',
                          color: 'var(--danger, #c0392b)',
                          borderRadius: 4, fontSize: 11,
                        }}>
                          ❌ {editErr}
                        </div>
                      )}
                    </td>
                  </tr>
                )
                return (
                <tr key={r.lot_id}
                  onContextMenu={(e) => rowMenu.openAt(e, r)}
                  style={{ cursor: 'context-menu' }}
                >
                  <td>{ymd(r.inbound_date)}</td>
                  <td><code>{r.code}</code></td>
                  {!cropId && <td>{r.crop_name}</td>}
                  <td>{r.supplier_name}</td>
                  <td>
                    {formatGrade(r.spec_type, r.grade_level, r.size_label, { spaces: true })}
                    {' / '}{r.origin_name}
                  </td>
                  <td className="num">{r.cases ? num(r.cases, 0) : '—'}</td>
                  <td className="num">{r.kg_per_case ? num(r.kg_per_case, 2) : '—'}</td>
                  <td className="num">{num(r.total_kg, 1)}</td>
                  <td className="num">
                    {r.unit_price != null ? `¥${num(r.unit_price, 0)}` : (
                      <span className="muted">未確定</span>
                    )}
                  </td>
                  <td className="num">{num(r.remaining_kg, 1)}</td>
                  <td>{r.created_by_name ?? '—'}</td>
                  <td>
                    <span className="inline" style={{ gap: 2 }}>
                      <button type="button" className="ghost small"
                        onClick={() => startEdit(r)}
                        title="この入荷を修正"
                        style={{ padding: '2px 8px', fontSize: 11 }}
                      >✎ 修正</button>
                      {rowMenu.triggerButton(r, 'その他の操作')}
                    </span>
                  </td>
                </tr>
                )
              })}
            </tbody>
          </table>
        )}
        {history.data && history.data.length === 0 && !history.loading && (
          <div className="muted">この期間に入荷履歴はありません。</div>
        )}
      </div>

      <RowMenu<InboundHistoryRow>
        state={rowMenu.state}
        onClose={rowMenu.close}
        items={(r) => {
          const base = [
            {
              icon: '✎', label: 'この入荷を修正',
              onClick: () => startEdit(r),
            },
            {
              icon: '📋', label: `整理番号 ${r.code} をコピー`,
              onClick: () => copyText(r.code, '整理番号'),
            },
            { divider: true,
              icon: '📦', label: '置き場で見る (原料レイアウト)',
              onClick: () => navigate('/storage/ingredient'),
            },
          ]
          if (isAdmin) {
            base.push({ divider: true,
              icon: '⚠️', label: '規格を 修正 (admin、 履歴 全部 再集計)',
              onClick: () => setGradePatchLot(r),
            })
          }
          return base
        }}
      />

      {/* 規格修正 dialog (admin only) — 影響件数 を 試算 表示 → 確定 で UPDATE */}
      {gradePatchLot && (
        <GradePatchDialog
          lot={gradePatchLot}
          onClose={() => setGradePatchLot(null)}
          onApplied={() => { setGradePatchLot(null); history.reload() }}
        />
      )}
    </div>
  )
}


// =============================================================================
// GradePatchDialog (admin only)
// =============================================================================
// 入庫 履歴 で 規格 を 取り違えた lot を 後 から 正規化 する dialog。
// flow: 規格 picker → dry_run で 影響件数 試算 → 確定 で UPDATE + reload。
// =============================================================================
function GradePatchDialog({
  lot, onClose, onApplied,
}: {
  lot: InboundHistoryRow
  onClose: () => void
  onApplied: () => void
}) {
  const dialog = useDialog()
  // 対象 lot の crop_id で 絞った grade 一覧 (= 他作物 規格 を 表示 しない)。
  const grades = useFetch<Grade[]>('/masters/grades', { crop_id: String(lot.crop_id) })
  const [newGradeId, setNewGradeId] = useState<number | null>(null)
  const [preview, setPreview] = useState<GradePatchResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const currentLabel = formatGrade(lot.spec_type, lot.grade_level, lot.size_label, { spaces: true })

  async function runPreview(gradeId: number) {
    setBusy(true); setErr(null); setPreview(null)
    try {
      const r = await api.patch<GradePatchResponse>(
        `/inbound/lots/${lot.lot_id}/grade`,
        { grade_id: gradeId, dry_run: true })
      setPreview(r)
    } catch (e) { setErr(errorText(e)) }
    finally { setBusy(false) }
  }
  async function commit() {
    if (!newGradeId || !preview) return
    if (!(await dialog.confirm({
      title: '規格 を 確定 変更 します',
      message: `${preview.affected.outbound_records} 件 の 出庫 履歴 と ${preview.affected.storage_items} 件 の 倉庫 配置 が 新 規格 で 再集計 されます。 振替 出庫 の 履歴 (from_grade_id snapshot) は 旧 規格 の まま 残ります。 続行 しますか?`,
      variant: 'danger', okLabel: '実行',
    }))) return
    setBusy(true); setErr(null)
    try {
      await api.patch<GradePatchResponse>(
        `/inbound/lots/${lot.lot_id}/grade`,
        { grade_id: newGradeId, dry_run: false })
      onApplied()
    } catch (e) { setErr(errorText(e)) }
    finally { setBusy(false) }
  }

  return (
    <div onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
         style={{ position: 'fixed', inset: 0, zIndex: 1000,
                  background: 'rgba(30,24,12,0.40)', backdropFilter: 'blur(2px)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: 'var(--panel)', color: 'var(--text)', borderRadius: 12,
                    boxShadow: 'var(--shadow-lg)', width: 'min(640px, 95vw)',
                    border: '1px solid var(--border)', padding: 18 }}>
        <h3 style={{ marginTop: 0 }}>規格を 修正 — {lot.code}</h3>
        <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          ロット の 規格 (grade) を 別 に 切替 ます。 origin / crop / 数量 は 据置。
          下流 (出庫レポート、 倉庫、 NR) は 自動 反映、 振替 履歴 の snapshot は 旧 規格 の まま 保護 されます。
        </p>

        <div style={{ marginTop: 14, padding: 10, background: 'var(--bg-tint)', borderRadius: 6 }}>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>現在 の 規格</div>
          <div style={{ fontWeight: 600 }}>{currentLabel}</div>
        </div>

        <div style={{ marginTop: 14 }}>
          <label style={{ fontSize: 12, fontWeight: 600 }}>新 規格</label>
          <Combobox<Grade>
            items={grades.data ?? []}
            getKey={g => g.id}
            getLabel={g => `${g.spec_type} / ${g.grade_level || '-'} / ${g.size_label || '-'}`}
            getSearchText={g => `${g.spec_type} ${g.grade_level} ${g.size_label}`}
            value={newGradeId}
            onChange={v => { const id = v as number | null; setNewGradeId(id); if (id) runPreview(id) }}
            placeholder={grades.loading ? '規格 を 読込み中…' : `${lot.crop_name} の 規格 を 選択…`}
            maxResults={50}
          />
        </div>

        {busy && <div className="muted" style={{ marginTop: 12, fontSize: 12 }}>試算中…</div>}
        {err && (
          <div style={{ marginTop: 12, padding: '8px 10px',
                        background: 'var(--surface-error, #fdecea)',
                        border: '1px solid var(--danger, #c0392b)',
                        color: 'var(--danger, #c0392b)', borderRadius: 6, fontSize: 12 }}>
            ❌ {err}
          </div>
        )}

        {preview && !busy && (
          <div style={{ marginTop: 14, padding: 10, background: 'var(--surface-soft, #f1f5f9)',
                        borderRadius: 6, fontSize: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>
              {preview.old_grade_label} → <strong>{preview.new_grade_label}</strong>
            </div>
            <div>影響 範囲 (= 自動 再集計):</div>
            <ul style={{ marginTop: 4, paddingLeft: 20 }}>
              <li>出庫 履歴: <strong>{preview.affected.outbound_records}</strong> 件
                (うち 振替: {preview.affected.substitution_records} 件 — snapshot 保護)</li>
              <li>倉庫 配置: <strong>{preview.affected.storage_items}</strong> 件</li>
              <li>月次棚卸: <strong>{preview.affected.stock_counts}</strong> 件</li>
            </ul>
            {preview.new_product_created && (
              <div style={{ marginTop: 6, color: 'var(--warning-strong, #92400E)' }}>
                ⚠ 新 product 「{lot.crop_name} × {preview.new_grade_label} × {lot.origin_name}」 が 自動 作成 されます (= 既存 product なし)
              </div>
            )}
          </div>
        )}

        <div style={{ marginTop: 18, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>キャンセル</button>
          <button type="button" onClick={commit}
                  disabled={!preview || busy} className="danger">
            {busy ? '実行中…' : '規格 を 変更 (確定)'}
          </button>
        </div>
      </div>
    </div>
  )
}
