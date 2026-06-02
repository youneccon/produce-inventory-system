import type { MaterialStock, ProductWithRecipe } from '../../api/types'
import type { ProductUiState } from './types'
import { NEW_PRODUCT_UI_STATE } from './types'
import ProductBlock from './ProductBlock'
import type { EditRow } from './ProductRightEdit'

interface Props {
  products: ProductWithRecipe[]
  uiState: Map<number, ProductUiState>
  materials: MaterialStock[] | null
  knownDeptCodes: string[]
  categoriesAvailable: string[]
  onPatchUi: (productId: number, patch: Partial<ProductUiState>) => void
  onAddOverride: (productId: number, dept: string) => Promise<void> | void
  onSave: (productId: number, rows: EditRow[], deptCode: string) => Promise<void>
  /** 直近 ~600ms 保存成功 した 商品 ID (halo 表示 用) */
  savedHaloProductId?: number | null
}

/** 全 商品 を 並べる メイン テーブル。 */
export default function ProductTable({
  products, uiState, materials, knownDeptCodes, categoriesAvailable,
  onPatchUi, onAddOverride, onSave, savedHaloProductId,
}: Props) {
  return (
    <table style={{
      width: '100%', borderCollapse: 'collapse',
      tableLayout: 'fixed',
    }}>
      <colgroup>
        <col style={{ width: '35%' }} />   {/* LEFT (商品名 + メタ) */}
        <col style={{ width: '12%' }} />   {/* カテゴリ */}
        <col style={{ width: '40%' }} />   {/* 資材名 (折返し許容、 メイン情報) */}
        <col style={{ width: '13%' }} />   {/* 数量 */}
      </colgroup>
      {products.map(p => (
        <ProductBlock
          key={p.product_id}
          product={p}
          ui={uiState.get(p.product_id) ?? NEW_PRODUCT_UI_STATE}
          materialsByDivision={materials}
          knownDeptCodes={knownDeptCodes}
          categoriesAvailable={categoriesAvailable}
          onPatchUi={(patch) => onPatchUi(p.product_id, patch)}
          onAddOverride={(dept) => onAddOverride(p.product_id, dept)}
          onSave={(rows, dept) => onSave(p.product_id, rows, dept)}
          justSaved={savedHaloProductId === p.product_id}
        />
      ))}
    </table>
  )
}
