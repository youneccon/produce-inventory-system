/**
 * SelectionPage — 選別 (仕分け) 画面 (新仕様 2026-05〜)。
 *
 * 主な変更:
 *   - 投入は 1 つ または 複数のロット を選択可能 (selection_sources)
 *   - 単価は投入の加重平均で自動算出 (全出力共通)
 *   - 出力は原料台帳 (inbound_lots) に新規ロットとして入庫
 *     (半製品台帳ではない)
 *   - 複数仕入先 / 複数産地 のミックスは警告 (確定可能だが注意喚起)
 *   - 投入量 = 出力総量 + 自動算出されるロス分 (= 投入 − 出力)
 *     ロスは selection_disposal として元ロットから出庫記録
 */
import { useEffect, useMemo, useState } from 'react'
import { Trash2, Plus, Trash } from 'lucide-react'
import { api } from '../api/client'
import { useFetch } from '../lib/useFetch'
import { useDialog } from '../components/Dialog'
import { errorText, num, yen, ymd, formatGrade } from '../lib/format'
import Combobox from '../components/Combobox'

const GARBAGE_SPEC_TYPE = '選別ゴミ'
import type {
  ReferencePrice,
  SelectionComputeResult,
  SelectionOperation,
  SourceLot,
} from '../api/types'

const today = () => new Date().toISOString().slice(0, 10)

// ─── 投入ロット行 ───
interface SourceRow {
  key: string
  lot_id: number | null
  source_kg: string       // 投入量入力欄
}

// ─── 出力規格行 ───
interface OutputRow {
  key: string
  product_id: number | null
  quantity_kg: string
  note: string
}

function rowKey(seed: number) {
  return `r-${Date.now()}-${seed}-${Math.random().toString(36).slice(2, 6)}`
}

export default function SelectionPage({ cropId }: { cropId: number }) {
  const dialog = useDialog()

  // ソース候補 (残量 > 0 全規格)。 大蒜の場合は「泥」のみ実態としてあるはず。
  const sources = useFetch<SourceLot[]>('/selection/source-lots', {
    crop_id: String(cropId),
  })
  const history = useFetch<SelectionOperation[]>(
    '/selection/operations',
    { crop_id: String(cropId) },
  )

  // ─── 投入行 (複数可) ───
  const [sourceRows, setSourceRows] = useState<SourceRow[]>([])
  const [rowSeed, setRowSeed] = useState(0)
  function addSourceRow() {
    setSourceRows((rs) => [...rs, {
      key: rowKey(rowSeed), lot_id: null, source_kg: '',
    }])
    setRowSeed((s) => s + 1)
  }
  function removeSourceRow(i: number) {
    setSourceRows((rs) => rs.filter((_, j) => j !== i))
  }
  function setSourceRow(i: number, patch: Partial<SourceRow>) {
    setSourceRows((rs) => rs.map((r, j) => j === i ? { ...r, ...patch } : r))
  }

  // 選択済み投入ロットの完全情報 (順序保持)
  const pickedSources = useMemo(() => {
    return sourceRows
      .map((r) => {
        const lot = r.lot_id != null
          ? sources.data?.find((s) => s.lot_id === r.lot_id) ?? null
          : null
        return { row: r, lot }
      })
      .filter((x) => x.lot != null) as { row: SourceRow; lot: SourceLot }[]
  }, [sourceRows, sources.data])

  // 投入合計 + 残量チェック
  const sourcesTotal = pickedSources.reduce(
    (s, x) => s + (Number(x.row.source_kg) || 0), 0)
  // 投入総価額 = Σ(投入kg × 単価)。 NULL 単価は 0 として扱う。
  const sourcesTotalValue = pickedSources.reduce(
    (s, x) => s + ((Number(x.lot.unit_price ?? 0) || 0) * (Number(x.row.source_kg) || 0)), 0)

  // 産地が混在しているか (= 警告対象)
  const distinctOrigins = useMemo(() => {
    return new Set(pickedSources
      .filter(x => Number(x.row.source_kg) > 0)
      .map(x => x.lot.origin_id))
  }, [pickedSources])
  const multiOrigin = distinctOrigins.size > 1
  const distinctSuppliers = useMemo(() => {
    return new Set(pickedSources
      .filter(x => Number(x.row.source_kg) > 0)
      .map(x => x.lot.supplier_id))
  }, [pickedSources])
  const multiSupplier = distinctSuppliers.size > 1

  // ─── 操作日 ───
  const [opDate, setOpDate] = useState(today())

  // ─── 出力行 ───
  const [outputRows, setOutputRows] = useState<OutputRow[]>([])
  function addOutputRow() {
    setOutputRows((rs) => [...rs, {
      key: rowKey(rowSeed), product_id: null, quantity_kg: '', note: '',
    }])
    setRowSeed((s) => s + 1)
  }

  /** 選別ゴミ 行を追加。 ゴミ product が 未存在 なら 動的に 作成 してから 行追加 */
  async function addGarbageRow() {
    if (!refOriginId) return
    setError(null)
    setBusy(true)
    try {
      // 既存 refs.data から ゴミ product を 探す
      const existing = (refs.data ?? []).find(r => r.spec_type === GARBAGE_SPEC_TYPE)
      let productId: number | null = existing?.product_id ?? null

      if (!productId) {
        // 「選別ゴミ」 grade を 取得 (mig 068 で追加済)
        const grades = await api.get<Array<{
          id: number; spec_type: string; grade_level: string; size_label: string
        }>>('/masters/grades')
        const garbageGrade = grades.find(g =>
          g.spec_type === GARBAGE_SPEC_TYPE && g.grade_level === '-' && g.size_label === '-')
        if (!garbageGrade) {
          throw new Error('選別ゴミ grade が マスタに 見つかりません (mig 068 未適用?)')
        }
        // (crop, origin, grade=選別ゴミ) の product を 作成
        const params = new URLSearchParams({
          grade_id: String(garbageGrade.id),
          origin_id: String(refOriginId),
          crop_id: String(cropId),
        })
        const newProd = await api.post<{ id: number }>(
          `/masters/products?${params.toString()}`, undefined)
        productId = newProd?.id ?? null
        await refs.reload()
        if (!productId) {
          // 別 device で 同時 作成 された 場合に備え、 再 fetch して 探す
          const refreshed = await api.get<ReferencePrice[]>('/selection/reference-prices', {
            crop_id: String(cropId), origin_id: String(refOriginId),
            target_spec_type: '__all__',
          })
          productId = refreshed.find(r => r.spec_type === GARBAGE_SPEC_TYPE)?.product_id ?? null
        }
      }

      if (productId == null) {
        throw new Error('選別ゴミ product の 作成 に 失敗')
      }
      setOutputRows((rs) => [...rs, {
        key: rowKey(rowSeed), product_id: productId, quantity_kg: '', note: '',
      }])
      setRowSeed((s) => s + 1)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  function removeOutputRow(i: number) {
    setOutputRows((rs) => rs.filter((_, j) => j !== i))
  }
  function setOutputRow(i: number, patch: Partial<OutputRow>) {
    setOutputRows((rs) => rs.map((r, j) => j === i ? { ...r, ...patch } : r))
  }

  // 投入が変わったら出力リセット (規格の参考価格が変わるため)
  useEffect(() => {
    setOutputRows([])
  }, [pickedSources.length])

  // 投入が空 or 産地が定まらない場合は参考価格を取得できない
  // 産地は「最初の」投入の産地を使う (混在の場合は警告)
  const refOriginId = pickedSources.length > 0 ? pickedSources[0].lot.origin_id : null
  const refs = useFetch<ReferencePrice[]>(
    refOriginId ? '/selection/reference-prices' : null,
    refOriginId
      ? { crop_id: String(cropId), origin_id: String(refOriginId),
          target_spec_type: '__all__' }
      : undefined,
  )

  // 出力合計
  const outputsTotal = outputRows.reduce(
    (s, r) => s + (r.product_id != null ? (Number(r.quantity_kg) || 0) : 0), 0)
  const disposalKg = sourcesTotal - outputsTotal

  // ─── プレビュー (compute) ───
  const [preview, setPreview] = useState<SelectionComputeResult | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  async function recompute() {
    setPreviewError(null)
    const validSources = pickedSources.filter(x => Number(x.row.source_kg) > 0)
    const validOutputs = outputRows.filter(
      (r) => r.product_id != null && Number(r.quantity_kg) > 0)
    if (validSources.length === 0 || validOutputs.length === 0) {
      setPreview(null); return
    }
    try {
      const r = await api.post<SelectionComputeResult>('/selection/compute', {
        sources: validSources.map(x => ({
          lot_id: x.lot.lot_id, source_kg: Number(x.row.source_kg),
        })),
        outputs: validOutputs.map((r) => ({
          product_id: r.product_id!, quantity_kg: Number(r.quantity_kg),
          note: r.note || null,
        })),
      })
      setPreview(r)
    } catch (e) {
      setPreviewError(errorText(e))
      setPreview(null)
    }
  }

  useEffect(() => {
    const t = setTimeout(() => recompute(), 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    JSON.stringify(pickedSources.map(x => [x.lot.lot_id, x.row.source_kg])),
    JSON.stringify(outputRows.map((r) => [r.product_id, r.quantity_kg])),
  ])

  // ─── 新規規格 作成 (Combobox から起動) ───
  const [creatingForRow, setCreatingForRow] = useState<number | null>(null)
  const [newSpecType, setNewSpecType] = useState('')
  const [newGradeLevel, setNewGradeLevel] = useState('')
  const [newSizeLabel, setNewSizeLabel] = useState('-')
  const [newSizeMm, setNewSizeMm] = useState('')

  function openCreateGrade(rowIdx: number, seedText: string) {
    const tokens = seedText.trim().split(/\s+/).filter(Boolean)
    let spec = '標準', grade = '', size = '-'
    if (tokens.length >= 3) { [spec, grade, size] = tokens.slice(0, 3) }
    else if (tokens.length === 2) { [grade, size] = tokens }
    else if (tokens.length === 1) { grade = tokens[0] }
    setNewSpecType(spec === '標準' ? '' : spec)
    setNewGradeLevel(grade)
    setNewSizeLabel(size)
    setNewSizeMm('')
    setCreatingForRow(rowIdx)
  }

  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function submitCreateGrade() {
    if (!newGradeLevel.trim()) { setError('等級は必須です'); return }
    if (!refOriginId) {
      setError('投入ロットの産地が解決できていないため規格追加できません')
      return
    }
    setBusy(true); setError(null); setMsg(null)
    const effectiveSpec = (newSpecType.trim() || '標準').trim()
    try {
      const gradeParams = new URLSearchParams({
        spec_type: effectiveSpec,
        grade_level: newGradeLevel.trim(),
        size_label: newSizeLabel.trim() || '-',
      })
      if (newSizeMm.trim()) gradeParams.set('size_mm', newSizeMm.trim())
      const grade = await api.post<{ id: number }>(
        `/masters/grades?${gradeParams.toString()}`, undefined)
      let gradeId = grade?.id
      if (!gradeId) {
        const list = await api.get<Array<{
          id: number; spec_type: string; grade_level: string; size_label: string
        }>>('/masters/grades')
        const found = list.find((g) =>
          g.spec_type === effectiveSpec
          && g.grade_level === newGradeLevel.trim()
          && g.size_label === (newSizeLabel.trim() || '-'))
        if (!found) throw new Error('規格の取得に失敗しました')
        gradeId = found.id
      }
      const productParams = new URLSearchParams({
        grade_id: String(gradeId),
        origin_id: String(refOriginId),
        crop_id: String(cropId),
      })
      const product = await api.post<{ id: number }>(
        `/masters/products?${productParams.toString()}`, undefined)
      let productId: number | null = product?.id ?? null
      await refs.reload()
      if (!productId) {
        const list = await api.get<ReferencePrice[]>(
          '/selection/reference-prices', {
            crop_id: String(cropId), origin_id: String(refOriginId),
            target_spec_type: '__all__',
          })
        const m = list.find((r) => r.grade_id === gradeId)
        productId = m?.product_id ?? null
      }
      if (productId != null && creatingForRow != null) {
        setOutputRow(creatingForRow, { product_id: productId })
      }
      setMsg(`規格 "${effectiveSpec} ${newGradeLevel.trim()}"`
        + (newSizeLabel !== '-' ? ' ' + newSizeLabel.trim() : '')
        + ' を追加しました')
      setCreatingForRow(null)
      setNewSpecType(''); setNewGradeLevel(''); setNewSizeLabel('-'); setNewSizeMm('')
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  // ─── 確定可否 ───
  const validSources = pickedSources.filter(x => Number(x.row.source_kg) > 0)
  const validOutputs = outputRows.filter(
    (r) => r.product_id != null && Number(r.quantity_kg) > 0)
  const exceedsRemaining = validSources.some(
    x => Number(x.row.source_kg) > Number(x.lot.remaining_kg))
  const canSubmit =
       validSources.length > 0
    && validOutputs.length > 0
    && !exceedsRemaining
    && outputsTotal <= sourcesTotal
    && opDate

  async function submit() {
    if (!canSubmit) return
    // 多産地警告
    if (multiOrigin) {
      const ok = await dialog.confirm({
        title: '異なる産地のロットを混ぜています',
        message: `${distinctOrigins.size} 種類の産地が混在しています。\n産出ロットは "最初の" 投入の産地が継承されます。\n本当に続行しますか？`,
        variant: 'warn',
        okLabel: '続行',
      })
      if (!ok) return
    }
    // 最終確認
    const ok = await dialog.confirm({
      title: '選別を確定',
      message:
        `投入: ${validSources.length} ロット / 合計 ${sourcesTotal}kg\n`
        + `出力: ${validOutputs.length} 規格 / 合計 ${outputsTotal}kg\n`
        + `ロス: ${disposalKg.toFixed(2)}kg\n`
        + `加重平均単価: ${preview?.weighted_unit_price
              ? yen(preview.weighted_unit_price) + '/kg'
              : '—'}`,
      okLabel: '確定',
    })
    if (!ok) return
    setBusy(true); setError(null); setMsg(null)
    try {
      const r = await api.post<SelectionOperation>('/selection/operations', {
        sources: validSources.map(x => ({
          lot_id: x.lot.lot_id, source_kg: Number(x.row.source_kg),
        })),
        outputs: validOutputs.map(r => ({
          product_id: r.product_id!, quantity_kg: Number(r.quantity_kg),
          note: r.note || null,
        })),
        operation_date: opDate,
      })
      setMsg(`選別 ${r.code} を登録しました (原料台帳に ${r.output_lots?.length ?? 0} ロット入庫)。`)
      setSourceRows([])
      setOutputRows([])
      setPreview(null)
      sources.reload()
      history.reload()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  function refLabel(r: ReferencePrice): string {
    const refTxt = r.reference_price != null
      ? `  (参考 ¥${Number(r.reference_price).toLocaleString()}/kg)`
      : ''
    const grade = formatGrade(r.spec_type, r.grade_level, r.size_label, { spaces: true, fallback: '(未設定)' })
    return `${grade}${refTxt}`
  }

  return (
    <div>
      <h2>選別（仕分け）</h2>
      <p className="subtitle">
        原料ロットを別の規格に仕分けます。 単価は投入の加重平均で自動算出。
        産出ロットは原料台帳に入庫され、 投入分は出庫扱い (selection_consume) +
        ロス分は別出庫 (selection_disposal) で記録されます。
        前月繰越や仕入金額の整合性を壊さず実行できます。
      </p>

      {error && <div className="alert error">{error}</div>}
      {msg   && <div className="alert success">{msg}</div>}

      {/* ─── ① 投入ロット ─── */}
      <div className="panel">
        <h3>① 投入ロット (複数可)</h3>
        {sources.loading && <div className="muted">読み込み中…</div>}
        {sources.data && sources.data.length === 0 && (
          <div className="muted">投入可能なロット (残量 &gt; 0) がありません。</div>
        )}
        {sources.data && sources.data.length > 0 && (
          <>
            <table>
              <thead>
                <tr>
                  <th style={{ minWidth: 240 }}>投入ロット (整理番号 · 規格 · 産地 · 仕入先)</th>
                  <th className="num">投入量 (kg)</th>
                  <th className="num">残量</th>
                  <th className="num">単価/kg</th>
                  <th className="num">投入価額</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sourceRows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="muted"
                        style={{ textAlign: 'center', padding: 16 }}>
                      投入ロットがまだありません。 下の「+ 投入ロットを追加」 を押してください。
                    </td>
                  </tr>
                )}
                {sourceRows.map((r, i) => {
                  const used = new Set(sourceRows
                    .filter((x, j) => j !== i && x.lot_id != null)
                    .map(x => x.lot_id))
                  const choices = (sources.data ?? []).filter(s => !used.has(s.lot_id))
                  const lot = r.lot_id != null
                    ? sources.data?.find(s => s.lot_id === r.lot_id) : null
                  const exceed = lot && Number(r.source_kg) > Number(lot.remaining_kg)
                  return (
                    <tr key={r.key}>
                      <td>
                        <Combobox<SourceLot>
                          items={choices}
                          getKey={(it) => it.lot_id}
                          getLabel={(s) =>
                            `${s.code} · ${formatGrade(s.spec_type, s.grade_level, s.size_label, { spaces: true, fallback: '' })} · ${s.origin_name} · ${s.supplier_name}`}
                          getSearchText={(s) =>
                            `${s.code} ${s.spec_type} ${s.grade_level} ${s.size_label} ${s.origin_name} ${s.supplier_name}`}
                          value={r.lot_id}
                          onChange={(v) => setSourceRow(i, { lot_id: v == null ? null : Number(v) })}
                          placeholder="ロットを選択 (整理番号 / 仕入先 / 規格 で検索)"
                        />
                      </td>
                      <td className="num">
                        <input type="number" step="0.01" style={{ width: 100 }}
                          value={r.source_kg}
                          onChange={(e) => setSourceRow(i, { source_kg: e.target.value })}
                          disabled={r.lot_id == null}
                        />
                        {exceed && (
                          <div style={{ color: 'var(--danger)', fontSize: 10 }}>
                            残量超過
                          </div>
                        )}
                      </td>
                      <td className="num">{lot ? num(lot.remaining_kg, 1) : '—'}</td>
                      <td className="num">{lot?.unit_price ? yen(lot.unit_price) : '—'}</td>
                      <td className="num">
                        {lot?.unit_price && Number(r.source_kg) > 0
                          ? yen(Number(lot.unit_price) * Number(r.source_kg))
                          : '—'}
                      </td>
                      <td>
                        <button type="button" className="ghost small"
                          onClick={() => removeSourceRow(i)}
                          title="この投入を削除"
                          style={{ padding: '4px 8px', color: 'var(--danger)' }}>
                          <Trash2 size={13} strokeWidth={1.8} />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              {sourceRows.length > 0 && (
                <tfoot>
                  <tr>
                    <td style={{ fontWeight: 600 }}>合計</td>
                    <td className="num"><strong>{num(sourcesTotal, 2)}</strong></td>
                    <td colSpan={2}></td>
                    <td className="num">
                      <strong>{sourcesTotalValue > 0 ? yen(sourcesTotalValue) : '—'}</strong>
                    </td>
                    <td></td>
                  </tr>
                </tfoot>
              )}
            </table>
            <div style={{ marginTop: 8 }}>
              <button type="button" onClick={addSourceRow}
                style={{ background: 'transparent', color: 'var(--primary)',
                         border: '1px dashed var(--primary)' }}>
                <Plus size={13} style={{ verticalAlign: 'middle' }} /> 投入ロットを追加
              </button>
            </div>
            {(multiOrigin || multiSupplier) && validSources.length > 1 && (
              <div className="alert" style={{
                marginTop: 10, background: '#fff4e0',
                border: '1px solid #e8a44d', color: '#8a5a00', fontSize: 12,
              }}>
                {multiOrigin && (
                  <div>⚠ 異なる産地 ({distinctOrigins.size}種) のロットを混ぜています。
                    産出ロットは「最初の」 投入の産地が継承されます。</div>
                )}
                {multiSupplier && (
                  <div>⚠ 異なる仕入先 ({distinctSuppliers.size}社) のロットを混ぜています。
                    産出ロットの仕入先は「最初の」 投入の仕入先が継承されます。</div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* ─── ② 操作日 + 出力規格 ─── */}
      {pickedSources.length > 0 && (
        <div className="panel">
          <h3>② 出力規格</h3>
          <div className="row" style={{ marginBottom: 12 }}>
            <div className="field">
              <label>操作日</label>
              <input type="date" value={opDate}
                onChange={(e) => setOpDate(e.target.value)} />
            </div>
            <div className="field" style={{ minWidth: 140 }}>
              <label>投入総量</label>
              <div style={{ fontSize: 17, fontWeight: 600 }}>
                {num(sourcesTotal, 2)} kg
              </div>
            </div>
            <div className="field" style={{ minWidth: 160 }}>
              <label>投入総価額</label>
              <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--primary)' }}>
                {sourcesTotalValue > 0 ? yen(sourcesTotalValue) : '—'}
              </div>
            </div>
            <div className="field" style={{ minWidth: 160 }}>
              <label>産出単価 (自動)</label>
              <div style={{ fontSize: 17, fontWeight: 600 }}>
                {preview?.weighted_unit_price
                  ? `${yen(preview.weighted_unit_price)}/kg`
                  : '—'}
              </div>
            </div>
            <div className="field" style={{ minWidth: 120 }}>
              <label>ロス予測</label>
              <div style={{ fontSize: 17, fontWeight: 600,
                            color: disposalKg < 0 ? 'var(--danger)'
                                  : disposalKg > 0 ? 'var(--warn)' : 'var(--ok)' }}>
                {num(disposalKg, 2)} kg
              </div>
            </div>
          </div>

          <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
            産出単価は <code>投入総価額 ÷ 出力総量</code> で算出され、 全規格共通。
            ロス分の価値が出力に按分されるため、 投入総価額 = 出力総価額 が保証されます。
          </p>

          {refs.loading && <div className="muted">参考価格 読み込み中…</div>}
          {refs.error && <div className="alert error">{refs.error}</div>}

          {refs.data && (
            <table>
              <thead>
                <tr>
                  <th style={{ minWidth: 240 }}>規格 (種別 / 等級 / サイズ)</th>
                  <th className="num">数量 (kg)</th>
                  <th className="num">産出単価/kg</th>
                  <th className="num">行金額</th>
                  <th>備考</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {outputRows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="muted"
                        style={{ textAlign: 'center', padding: 16 }}>
                      まだ出力行がありません。 下の「+ 出力規格を追加」 から行を追加してください。
                    </td>
                  </tr>
                )}
                {outputRows.map((r, i) => {
                  // この行 が 選別ゴミ product を 指しているか
                  const selectedRef = (refs.data ?? []).find(x => x.product_id === r.product_id)
                  const isGarbage = selectedRef?.spec_type === GARBAGE_SPEC_TYPE
                  // ゴミ は 単価 0 固定、 それ以外 は preview の weighted_unit_price を 使う
                  const wup = preview?.weighted_unit_price ?? null
                  const q = Number(r.quantity_kg) || 0
                  const rowUnit = isGarbage ? 0 : (wup ? Number(wup) : null)
                  const rowValue = isGarbage ? 0 : (wup ? Number(wup) * q : null)
                  return (
                    <tr key={r.key}
                        style={isGarbage ? { background: '#fff7e6' } : undefined}
                        title={isGarbage ? '選別ゴミ — 単価0、 量のみ 記録' : undefined}>
                      <td>
                        {isGarbage ? (
                          <span style={{
                            display: 'inline-flex', alignItems: 'center', gap: 4,
                            padding: '3px 8px',
                            background: '#ff8a00', color: '#fff',
                            borderRadius: 4, fontSize: 12, fontWeight: 600,
                          }}>
                            <Trash size={12} strokeWidth={2} aria-hidden /> 選別ゴミ
                          </span>
                        ) : (
                          <Combobox<ReferencePrice>
                            items={(refs.data ?? []).filter(x => x.spec_type !== GARBAGE_SPEC_TYPE)}
                            getKey={(it) => it.product_id}
                            getLabel={refLabel}
                            getSearchText={(it) =>
                              `${it.spec_type} ${it.grade_level} ${it.size_label}`}
                            value={r.product_id}
                            onChange={(v) => setOutputRow(i, {
                              product_id: v == null ? null : Number(v),
                            })}
                            placeholder="規格を選択"
                            onCreateNew={(qt) => openCreateGrade(i, qt)}
                            createLabel={(qt) => `➕ 「${qt}」を新規規格として登録`}
                          />
                        )}
                      </td>
                      <td className="num">
                        <input type="number" step="0.01" style={{ width: 100 }}
                          value={r.quantity_kg}
                          onChange={(e) => setOutputRow(i, { quantity_kg: e.target.value })}
                          disabled={r.product_id == null}
                        />
                      </td>
                      <td className="num">
                        {isGarbage
                          ? <span style={{ color: '#a85a00', fontWeight: 600 }}>¥0</span>
                          : (rowUnit != null ? yen(rowUnit) : <span className="muted">—</span>)}
                      </td>
                      <td className="num">
                        {isGarbage
                          ? <span style={{ color: '#a85a00', fontWeight: 600 }}>¥0</span>
                          : (rowValue != null ? yen(rowValue) : <span className="muted">—</span>)}
                      </td>
                      <td>
                        <input style={{ width: '100%' }}
                          value={r.note}
                          onChange={(e) => setOutputRow(i, { note: e.target.value })}
                        />
                      </td>
                      <td>
                        <button type="button" className="ghost small"
                          onClick={() => removeOutputRow(i)}
                          title="この出力を削除"
                          style={{ padding: '4px 8px', color: 'var(--danger)' }}>
                          <Trash2 size={13} strokeWidth={1.8} />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              {outputRows.length > 0 && (
                <tfoot>
                  <tr>
                    <td style={{ fontWeight: 600 }}>合計</td>
                    <td className="num">
                      <strong>{num(outputsTotal, 2)}</strong>
                      {outputsTotal > sourcesTotal && (
                        <span style={{ color: 'var(--danger)', fontSize: 10 }}>
                          {' '}投入超過
                        </span>
                      )}
                    </td>
                    <td></td>
                    <td className="num">
                      {preview?.output_total_value
                        ? <strong>{yen(preview.output_total_value)}</strong>
                        : '—'}
                    </td>
                    <td colSpan={2}></td>
                  </tr>
                </tfoot>
              )}
            </table>
          )}
          <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" onClick={addOutputRow}
              disabled={!refOriginId}
              style={{ background: 'transparent', color: 'var(--primary)',
                       border: '1px dashed var(--primary)' }}>
              <Plus size={13} style={{ verticalAlign: 'middle' }} /> 出力規格を追加
            </button>
            <button type="button" onClick={addGarbageRow}
              disabled={!refOriginId || busy}
              title="選別で 発生 した ゴミ の 量を 記録 (単価強制 0)"
              style={{ background: 'transparent', color: '#a85a00',
                       border: '1px dashed #ff8a00' }}>
              <Trash size={13} style={{ verticalAlign: 'middle' }} /> 選別ゴミ行を追加
            </button>
          </div>

          {previewError && (
            <div className="alert error" style={{ marginTop: 8 }}>{previewError}</div>
          )}

          {/* ─── 新規規格 作成モーダル ─── */}
          {creatingForRow != null && (
            <div style={{
              position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              zIndex: 1000,
            }} onClick={() => !busy && setCreatingForRow(null)}>
              <div className="panel" style={{ width: 460, maxWidth: '90vw', background: 'var(--bg)' }}
                   onClick={(e) => e.stopPropagation()}>
                <h3 style={{ marginTop: 0 }}>新規規格を登録</h3>
                <div className="field">
                  <label>規格種別 (空欄=「標準」)</label>
                  <input value={newSpecType}
                    onChange={(e) => setNewSpecType(e.target.value)}
                    placeholder="例: 標準, 加工品" />
                </div>
                <div className="field">
                  <label>等級 <span style={{ color: 'var(--danger)' }}>*</span></label>
                  <input value={newGradeLevel}
                    onChange={(e) => setNewGradeLevel(e.target.value)}
                    placeholder="例: A, B, 特" autoFocus />
                </div>
                <div className="row">
                  <div className="field" style={{ flex: 1 }}>
                    <label>サイズ</label>
                    <input value={newSizeLabel}
                      onChange={(e) => setNewSizeLabel(e.target.value)}
                      placeholder="例: L, M, S, -" />
                  </div>
                  <div className="field" style={{ flex: 1 }}>
                    <label>サイズ(mm) 任意</label>
                    <input type="number" value={newSizeMm}
                      onChange={(e) => setNewSizeMm(e.target.value)}
                      placeholder="数字のみ" />
                  </div>
                </div>
                <div className="inline" style={{ marginTop: 12 }}>
                  <button onClick={submitCreateGrade} disabled={busy || !newGradeLevel.trim()}>
                    {busy ? '登録中…' : '規格を登録'}
                  </button>
                  <button type="button" onClick={() => setCreatingForRow(null)} disabled={busy}
                    style={{ background: 'transparent', color: 'var(--muted)',
                             border: '1px solid var(--border)' }}>
                    キャンセル
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="inline" style={{ marginTop: 16 }}>
            <button onClick={submit} disabled={busy || !canSubmit}>
              {busy ? '登録中…' : '③ 選別を確定登録 (原料台帳へ入庫)'}
            </button>
            {!canSubmit && (
              <span className="muted" style={{ fontSize: 12 }}>
                ※ 投入と出力 各 1 件以上、 出力 ≤ 投入、 残量内 が必要です。
              </span>
            )}
          </div>
        </div>
      )}

      {/* ─── 履歴 ─── */}
      <div className="panel">
        <h3>選別履歴</h3>
        {history.error && <div className="alert error">{history.error}</div>}
        {history.data && history.data.length === 0 && (
          <div className="muted">選別履歴がまだありません。</div>
        )}
        {history.data && history.data.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>選別番号</th>
                <th>操作日</th>
                <th className="num">投入</th>
                <th className="num">投入量</th>
                <th className="num">ロス</th>
                <th className="num">出力</th>
                <th className="num">出力量</th>
                <th className="num">加重単価</th>
                <th>登録者</th>
              </tr>
            </thead>
            <tbody>
              {history.data.map((h) => (
                <tr key={h.id}>
                  <td><strong>{h.code}</strong></td>
                  <td>{ymd(h.operation_date)}</td>
                  <td className="num">{h.source_count ?? '—'}</td>
                  <td className="num">{num(h.sources_total_kg ?? 0, 1)} kg</td>
                  <td className="num">{num(h.disposal_kg ?? 0, 1)} kg</td>
                  <td className="num">{h.output_count ?? '—'}</td>
                  <td className="num">{num(h.outputs_total_kg ?? 0, 1)} kg</td>
                  <td className="num">
                    {h.weighted_unit_price ? yen(h.weighted_unit_price) : '—'}
                  </td>
                  <td>{h.created_by_name ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
