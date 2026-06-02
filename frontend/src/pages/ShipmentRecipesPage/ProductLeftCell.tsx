import { Plus } from 'lucide-react'
import { num } from '../../lib/format'
import type { ProductWithRecipe } from '../../api/types'
import DeptChips from './DeptChips'

interface Props {
  product: ProductWithRecipe
  expanded: boolean
  selectedDept: string
  knownDeptCodes: string[]
  onToggle: () => void
  onSelectDept: (dept: string) => void
  onAddOverride: (dept: string) => Promise<void> | void
  /** 展開時 LEFT 下部 に 出す 「+ 資材 行 を 追加」 アクション */
  onAddRecipeRow?: () => void
}

/** 商品 LEFT セル の 中身。
 *  原則 (引き算): 既定 状態 は 装飾 しない、 主役 (商品名) は 大きく、 補助 情報 は 薄く、
 *  例外 (未設定 / 部署別 override) だけ 控えめ に 印 を 付ける。
 *  - product_code は 通常 非表示、 title 属性 で hover ツールチップ。
 *  - 編集 ボタン は 廃止 (各 セル が inline-editable)。 */
export default function ProductLeftCell({
  product, expanded, selectedDept, knownDeptCodes,
  onToggle, onSelectDept, onAddOverride, onAddRecipeRow,
}: Props) {
  const defaultRecipeCount = product.recipes.filter(r => !r.department_code).length
  const unset = defaultRecipeCount === 0
  const overrides = product.override_dept_codes
  const hasOverride = overrides.length > 0
  const lastShip = product.last_shipped_at
  const monthly = product.monthly_shipment_count

  // 例外 を 示す 行 左 ボーダー (未設定 > override > 通常)
  const borderColor = unset ? '#d04a4a' : (hasOverride ? '#d49000' : 'transparent')

  // 商品 コード は ホバー で 浮かぶ ツール チップ のみ
  const codeText = product.product_code ?? `#${product.product_id}`

  return (
    <div
      className="recipe-product-left"
      style={{
        borderLeft: `3px solid ${borderColor}`,
        paddingLeft: 10,
      }}
    >
      <div
        onClick={onToggle}
        title={codeText}
        style={{
          cursor: 'pointer',
          display: 'flex', alignItems: 'baseline', gap: 10,
        }}
      >
        <span style={{
          fontSize: 12, opacity: 0.45, alignSelf: 'center',
          minWidth: 12, display: 'inline-block',
        }}>
          {expanded ? '▼' : '▶'}
        </span>
        <span style={{
          fontSize: expanded ? 17 : 15,
          fontWeight: 600,
          color: '#222',
        }}>
          {product.name}
        </span>
        {lastShip && (
          <span style={{ fontSize: 11, color: '#888' }}>
            {lastShip.slice(5)}・月{num(monthly)}回
          </span>
        )}
        <span style={{ flex: 1 }} />
        {unset && (
          <span style={{ fontSize: 12, color: '#c0322a', fontWeight: 500 }}>
            未設定
          </span>
        )}
        {!unset && hasOverride && (
          <span style={{ fontSize: 11, color: '#a06400' }}>
            部署別: {overrides.join('・')}
          </span>
        )}
      </div>
      {expanded && (
        <div style={{ marginTop: 6, marginLeft: 22 }}>
          <DeptChips
            overrideDeptCodes={overrides}
            knownDeptCodes={knownDeptCodes}
            selectedDept={selectedDept}
            onSelect={onSelectDept}
            onAddOverride={onAddOverride}
          />
        </div>
      )}
      {expanded && onAddRecipeRow && (
        <div style={{ marginTop: 8, marginLeft: 22 }}>
          <button type="button"
            onClick={(e) => { e.stopPropagation(); onAddRecipeRow() }}
            title="この商品 に 資材 行 を 追加"
            aria-label="資材行を追加"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '4px 8px', fontSize: 11,
              background: '#eef4ff', color: '#3a6dd5',
              border: '1px solid #c5d8f4', borderRadius: 14,
              cursor: 'pointer',
            }}
          >
            <Plus size={12} strokeWidth={2} /> 資材
          </button>
        </div>
      )}
    </div>
  )
}
