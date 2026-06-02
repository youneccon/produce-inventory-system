import { useMemo, useState } from 'react'
import type { MaterialStock, ProductWithRecipe } from '../../api/types'
import type { ProductUiState } from './types'
import { effectiveRecipes } from './filterSort'
import { stripNoteMetaTags } from '../../lib/format'
import ProductLeftCell from './ProductLeftCell'
import {
  EditableRowCells, EmptyRowCells, CommentSubRowCells,
  type RowHandlers, type RowViewData,
} from './ProductRightView'
import {
  type EditRow, newEditRow, recipeEntryToEditRow, DEFAULT_CATEGORY_CYCLE,
} from './ProductRightEdit'

interface Props {
  product: ProductWithRecipe
  ui: ProductUiState
  materialsByDivision: MaterialStock[] | null
  knownDeptCodes: string[]
  categoriesAvailable: string[]
  onPatchUi: (patch: Partial<ProductUiState>) => void
  onAddOverride: (dept: string) => Promise<void> | void
  onSave: (rows: EditRow[], deptCode: string) => Promise<void>
  /** 直近 保存成功 した 商品 か (= 緑 halo 表示) */
  justSaved?: boolean
}

/** 1 商品 の 表示 単位 (= 1 つ の <tbody>)。 2 モード:
 *  - collapsed: 1 物理行 (LEFT セル のみ、 colSpan=4)
 *  - expanded: LEFT rowSpan=N + 各 資材行 (EditableRowCells) + 必要なら
 *    コメント サブ <tr> (CommentSubRowCells、 colSpan=3)
 *  「編集 モード」 は 廃止。 各 セル が 個別 に Notion 風 inline-editable。 */
export default function ProductBlock({
  product, ui, materialsByDivision, knownDeptCodes,
  categoriesAvailable, onPatchUi, onAddOverride, onSave, justSaved,
}: Props) {
  const [pendingRows, setPendingRows] = useState<EditRow[]>([])
  /** どの 行 の コメント サブ 行 が 開いている か (rid set) */
  const [openComments, setOpenComments] = useState<Set<number>>(new Set())

  const materialsByMaterialId = useMemo(() => {
    const m = new Map<number, MaterialStock>()
    for (const x of materialsByDivision ?? []) m.set(x.material_id, x)
    return m
  }, [materialsByDivision])

  const materialsByCategory = useMemo(() => {
    const m = new Map<string, MaterialStock[]>()
    for (const x of materialsByDivision ?? []) {
      const c = x.category ?? '(未分類)'
      const a = m.get(c); if (a) a.push(x); else m.set(c, [x])
    }
    return m
  }, [materialsByDivision])

  const viewRows = effectiveRecipes(product, ui.selectedDept)

  /** カテゴリ の 正規 順序 (DEFAULT_CATEGORY_CYCLE)。 リスト 外 は 末尾 */
  const categoryOrder = useMemo(() => {
    const m = new Map<string, number>()
    DEFAULT_CATEGORY_CYCLE.forEach((c, i) => m.set(c, i))
    return m
  }, [])

  const existingEditRows = useMemo<EditRow[]>(() => {
    const rows = viewRows.map(r => {
      const cat = materialsByMaterialId.get(r.entry.material_id)?.category ?? '段ボール'
      return recipeEntryToEditRow(r.entry, cat)
    })
    // 保存順 を 無視 して 常 に カテゴリ正規順 で 表示 (ユーザー が 順不同 で 追加
    // しても 次 の 展開 時 に 整理 される)。 sort は stable なので 同カテゴリ 内 の
    // 元 順序 は 保持。
    return [...rows].sort((a, b) => {
      const ai = categoryOrder.get(a.category) ?? 999
      const bi = categoryOrder.get(b.category) ?? 999
      return ai - bi
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product, ui.selectedDept, materialsByDivision, categoryOrder])

  function dampoRid(rows: EditRow[]): number | undefined {
    return rows.find(r => r.category === '段ボール')?.rid
  }

  const displayRows = useMemo(() => {
    return [...existingEditRows, ...pendingRows]
  }, [existingEditRows, pendingRows])

  const dampoTakenRid = dampoRid(displayRows)

  /** 既存 行 1 つ を patch して 全 dept 行 を PUT */
  async function commitExistingRow(rid: number, patch: Partial<EditRow>) {
    const updated = existingEditRows.map(r => r.rid === rid ? { ...r, ...patch } : r)
    const completedPending = pendingRows.filter(
      r => r.material_id != null && r.quantity.trim() !== '',
    )
    await onSave([...updated, ...completedPending], ui.selectedDept)
    setPendingRows(rs => rs.filter(r => !completedPending.includes(r)))
  }

  async function deleteExistingRow(rid: number) {
    const kept = existingEditRows.filter(r => r.rid !== rid)
    const completedPending = pendingRows.filter(
      r => r.material_id != null && r.quantity.trim() !== '',
    )
    await onSave([...kept, ...completedPending], ui.selectedDept)
    setPendingRows(rs => rs.filter(r => !completedPending.includes(r)))
  }

  /** pending 行 を patch。 完成 (material_id + quantity) し たら 自動 commit */
  async function patchPendingRow(rid: number, patch: Partial<EditRow>) {
    const next = pendingRows.map(r => r.rid === rid ? { ...r, ...patch } : r)
    setPendingRows(next)
    const target = next.find(r => r.rid === rid)
    if (!target) return
    if (target.material_id != null && target.quantity.trim() !== '') {
      const completed = next.filter(
        r => r.material_id != null && r.quantity.trim() !== '',
      )
      await onSave([...existingEditRows, ...completed], ui.selectedDept)
      setPendingRows(rs => rs.filter(r => !completed.includes(r)))
    }
  }

  function removePendingRow(rid: number) {
    setPendingRows(rs => rs.filter(r => r.rid !== rid))
    setOpenComments(s => { const n = new Set(s); n.delete(rid); return n })
  }

  function addPendingRow() {
    const used = new Set(displayRows.map(r => r.category))
    const next = DEFAULT_CATEGORY_CYCLE.find(c => !used.has(c)) ?? '袋'
    setPendingRows(rs => [...rs, newEditRow(next)])
  }

  function toggleComment(rid: number) {
    setOpenComments(s => {
      const n = new Set(s)
      if (n.has(rid)) n.delete(rid); else n.add(rid)
      return n
    })
  }

  // ===== collapsed =====
  if (!ui.expanded) {
    return (
      <tbody className={`recipe-product-block${justSaved ? ' recipe-just-saved' : ''}`}>
        <tr id={`product-row-${product.product_id}`}>
          <td colSpan={4} style={{ padding: '10px 8px', borderTop: '1px solid #eee' }}>
            <ProductLeftCell
              product={product}
              expanded={false}
              selectedDept={ui.selectedDept}
              knownDeptCodes={knownDeptCodes}
              onToggle={() => onPatchUi({ expanded: true })}
              onSelectDept={(d) => onPatchUi({ selectedDept: d })}
              onAddOverride={onAddOverride}
            />
          </td>
        </tr>
      </tbody>
    )
  }

  // ===== expanded =====
  // 各 表示行 が 占める <tr> 数: 主行 1 + (comment 開 なら +1)
  const trCount = displayRows.length === 0
    ? 1
    : displayRows.reduce((acc, r) => acc + (openComments.has(r.rid) ? 2 : 1), 0)
  const rowSpan = trCount

  const leftCellStyle: React.CSSProperties = {
    padding: '10px 8px',
    borderTop: '2px solid #999',
    verticalAlign: 'top',
    background: '#fafbfc',
  }

  function makeHandlers(row: EditRow, isPending: boolean): RowHandlers {
    const patchFn = isPending ? patchPendingRow : commitExistingRow
    const deleteFn = isPending
      ? () => removePendingRow(row.rid)
      : () => deleteExistingRow(row.rid)
    return {
      onChangeCategory: (next) => patchFn(row.rid, { category: next, material_id: null }),
      onChangeMaterial: (next) => patchFn(row.rid, { material_id: next }),
      onChangeQuantity: (next) => patchFn(row.rid, { quantity: next }),
      onChangeNote: (next) => patchFn(row.rid, { note: next }),
      onChangeAlternatives: (ids) => patchFn(row.rid, { alternative_material_ids: ids }),
      onDelete: deleteFn,
      onToggleComment: () => toggleComment(row.rid),
    }
  }

  function makeRowViewData(row: EditRow): RowViewData {
    const mats = materialsByCategory.get(row.category) ?? []
    const selectedMaterial = row.material_id != null
      ? materialsByMaterialId.get(row.material_id) ?? null
      : null
    return {
      rowKey: String(row.rid),
      category: row.category,
      material_id: row.material_id,
      materials: mats,
      selectedMaterial,
      quantity: row.quantity,
      noteDisplay: stripNoteMetaTags(row.note),
      alternativeIds: row.alternative_material_ids,
      commentOpen: openComments.has(row.rid),
    }
  }

  /** 行 1 つ 分 の (主 <tr> + 必要 なら コメント サブ <tr>) を 返す */
  function renderRowTrs(row: EditRow, isFirst: boolean): React.ReactNode[] {
    const isPending = pendingRows.includes(row)
    const data = makeRowViewData(row)
    const handlers = makeHandlers(row, isPending)
    const dampoTakenByOther = dampoTakenRid != null && dampoTakenRid !== row.rid
    const result: React.ReactNode[] = []
    if (isFirst) {
      // 主行 (LEFT は 親 で 描画 済み なので ここ では 3 セル のみ)
      result.push(
        <EditableRowCells
          key={`main-${row.rid}`}
          row={data}
          firstRow
          dampoTakenByOther={dampoTakenByOther}
          categoriesAvailable={categoriesAvailable}
          handlers={handlers}
          isPending={isPending}
        />,
      )
    } else {
      result.push(
        <tr key={`main-${row.rid}`}>
          <EditableRowCells
            row={data}
            firstRow={false}
            dampoTakenByOther={dampoTakenByOther}
            categoriesAvailable={categoriesAvailable}
            handlers={handlers}
            isPending={isPending}
          />
        </tr>,
      )
    }
    if (openComments.has(row.rid)) {
      result.push(
        <tr key={`comment-${row.rid}`}>
          <CommentSubRowCells row={data} handlers={handlers} />
        </tr>,
      )
    }
    return result
  }

  // 最初 の 主 <tr> (LEFT + 3 セル) を 個別 に 構築
  const firstRow = displayRows[0]
  let firstTr: React.ReactNode
  if (!firstRow) {
    firstTr = (
      <tr id={`product-row-${product.product_id}`}>
        <td rowSpan={rowSpan} style={leftCellStyle}>
          <ProductLeftCell
            product={product}
            expanded={true}
            selectedDept={ui.selectedDept}
            knownDeptCodes={knownDeptCodes}
            onToggle={() => {
              setPendingRows([])
              setOpenComments(new Set())
              onPatchUi({ expanded: false })
            }}
            onSelectDept={(d) => onPatchUi({ selectedDept: d })}
            onAddOverride={onAddOverride}
            onAddRecipeRow={addPendingRow}
          />
        </td>
        <EmptyRowCells firstRow />
      </tr>
    )
  } else {
    const isPending = pendingRows.includes(firstRow)
    const data = makeRowViewData(firstRow)
    const handlers = makeHandlers(firstRow, isPending)
    const dampoTakenByOther = dampoTakenRid != null && dampoTakenRid !== firstRow.rid
    firstTr = (
      <tr id={`product-row-${product.product_id}`}>
        <td rowSpan={rowSpan} style={leftCellStyle}>
          <ProductLeftCell
            product={product}
            expanded={true}
            selectedDept={ui.selectedDept}
            knownDeptCodes={knownDeptCodes}
            onToggle={() => {
              setPendingRows([])
              setOpenComments(new Set())
              onPatchUi({ expanded: false })
            }}
            onSelectDept={(d) => onPatchUi({ selectedDept: d })}
            onAddOverride={onAddOverride}
            onAddRecipeRow={addPendingRow}
          />
        </td>
        <EditableRowCells
          row={data}
          firstRow
          dampoTakenByOther={dampoTakenByOther}
          categoriesAvailable={categoriesAvailable}
          handlers={handlers}
          isPending={isPending}
        />
      </tr>
    )
  }

  // 残り の trs (first の コメント サブ + 残り の 行 たち)
  const restTrs: React.ReactNode[] = []
  if (firstRow && openComments.has(firstRow.rid)) {
    const data = makeRowViewData(firstRow)
    const isPending = pendingRows.includes(firstRow)
    const handlers = makeHandlers(firstRow, isPending)
    restTrs.push(
      <tr key={`comment-${firstRow.rid}`}>
        <CommentSubRowCells row={data} handlers={handlers} />
      </tr>,
    )
  }
  for (const row of displayRows.slice(1)) {
    for (const tr of renderRowTrs(row, false)) {
      restTrs.push(tr)
    }
  }

  return (
    <tbody className={`recipe-product-block${justSaved ? ' recipe-just-saved' : ''}`}>
      {firstTr}
      {restTrs}
    </tbody>
  )
}
