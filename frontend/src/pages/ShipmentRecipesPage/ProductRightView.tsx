import { useState } from 'react'
import type { MaterialStock } from '../../api/types'
import {
  CategoryCell, MaterialPicker, MaterialFooter, QuantityCell,
  CommentArea, AlternativesEditor,
} from './EditableCells'

/** 1 資材行 (= 1 主 <tr>) + 必要なら コメント サブ <tr> を まとめて 返す。
 *  3 列 構成: [カテゴリ] [資材+footer+alt] [数量]
 *  アクション (+ 代替 / + コメント / 削除) は 資材 セル 下 の footer 行 右端 に 集約。 */

export interface RowViewData {
  rowKey: string
  category: string
  material_id: number | null
  materials: MaterialStock[]
  selectedMaterial: MaterialStock | null
  quantity: string
  noteDisplay: string
  alternativeIds: number[]
  commentOpen: boolean
}

export interface RowHandlers {
  onChangeCategory: (next: string) => void
  onChangeMaterial: (next: number | null) => void
  onChangeQuantity: (next: string) => void
  onChangeNote: (next: string) => void
  onChangeAlternatives: (ids: number[]) => void
  onDelete: () => void
  onToggleComment: () => void
}

interface Props {
  row: RowViewData
  firstRow: boolean
  dampoTakenByOther: boolean
  categoriesAvailable: string[]
  handlers: RowHandlers
  isPending: boolean
}

/** 主 <tr> の 中身 (3 セル fragment)。 */
export function EditableRowCells({
  row, firstRow, dampoTakenByOther, categoriesAvailable, handlers, isPending,
}: Props) {
  const [altOpen, setAltOpen] = useState(false)
  const cellStyle: React.CSSProperties = {
    padding: '4px 6px',
    borderTop: firstRow ? '2px solid #999' : '1px solid #eee',
    verticalAlign: 'top',
  }
  const isLengthBased = row.selectedMaterial?.length_per_roll_cm != null
  const displayUnit = isLengthBased ? 'cm' : (row.selectedMaterial?.unit ?? null)
  const hasComment = row.noteDisplay.trim() !== ''
  const hasMaterial = row.selectedMaterial != null

  return (
    <>
      <td style={{ ...cellStyle, background: '#f7f9f4' }}>
        <CategoryCell
          value={row.category}
          options={categoriesAvailable}
          dampoTakenByOther={dampoTakenByOther}
          onCommit={handlers.onChangeCategory}
          readonly={!isPending}
        />
      </td>
      <td style={cellStyle}>
        <MaterialPicker
          value={row.material_id}
          materials={row.materials}
          selectedMaterial={row.selectedMaterial}
          onCommit={handlers.onChangeMaterial}
        />
        <MaterialFooter
          selectedMaterial={row.selectedMaterial}
          alternativeIds={row.alternativeIds}
          altOpen={altOpen}
          onToggleAlt={() => setAltOpen(o => !o)}
          hasMaterial={hasMaterial}
          hasComment={hasComment}
          onAddAlternative={() => setAltOpen(true)}
          onToggleComment={handlers.onToggleComment}
          onDelete={handlers.onDelete}
        />
        {altOpen && row.selectedMaterial && (
          <AlternativesEditor
            row={{
              material_id: row.material_id,
              alternative_material_ids: row.alternativeIds,
            }}
            mainMaterial={row.selectedMaterial}
            candidates={row.materials}
            onChange={ids => handlers.onChangeAlternatives(ids)}
          />
        )}
      </td>
      <td style={{ ...cellStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>
        <QuantityCell
          value={row.quantity}
          unit={displayUnit}
          isLengthBased={isLengthBased}
          onCommit={handlers.onChangeQuantity}
        />
      </td>
    </>
  )
}

interface CommentSubRowProps {
  row: RowViewData
  handlers: RowHandlers
}
export function CommentSubRowCells({ row, handlers }: CommentSubRowProps) {
  return (
    <td colSpan={3} style={{ padding: 0 }} className="recipe-comment-subrow">
      <CommentArea
        value={row.noteDisplay}
        open={row.commentOpen}
        onClose={handlers.onToggleComment}
        onCommit={handlers.onChangeNote}
      />
    </td>
  )
}

export function EmptyRowCells({ firstRow }: { firstRow: boolean }) {
  const cellStyle: React.CSSProperties = {
    padding: '12px 8px',
    borderTop: firstRow ? '2px solid #999' : '1px solid #eee',
    color: '#999', fontStyle: 'italic', textAlign: 'center',
  }
  return (
    <td colSpan={3} style={cellStyle}>
      (まだ レシピ が 登録 されて いません — 左の 「+ 資材 行 を 追加」 から 開始)
    </td>
  )
}

export default EditableRowCells
