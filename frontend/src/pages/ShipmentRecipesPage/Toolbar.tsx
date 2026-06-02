import Combobox from '../../components/Combobox'
import type { ProductWithRecipe } from '../../api/types'
import type { SortKey, ToolbarState } from './types'

interface Props {
  state: ToolbarState
  onChange: (next: ToolbarState) => void
  /** 検索 候補 (= 表示中 の 商品 全部、 オートコンプリート 用) */
  products: ProductWithRecipe[]
  /** 検索 で 商品 を 選択 した 時 — 該当行 を 展開 + スクロール */
  onPickProduct: (productId: number) => void
  visibleCount: number
  totalCount: number
}

export default function Toolbar({
  state, onChange, products, onPickProduct, visibleCount, totalCount,
}: Props) {
  function setFilter(patch: Partial<ToolbarState['filters']>) {
    onChange({ ...state, filters: { ...state.filters, ...patch } })
  }

  return (
    <div style={{
      position: 'sticky', top: 0, zIndex: 10,
      // 下層 要素 が 透けて 見える の を 防ぐ ため opacity 1 の 不透明 背景 必須。
      // background-color に rgb 完全 不透明 を 明示 (rgba 透過 を 避ける)
      background: 'rgb(255, 255, 255)',
      borderBottom: '1px solid #e0e0e0',
      boxShadow: '0 2px 4px rgba(0,0,0,0.04)',
      padding: '8px 6px', marginBottom: 6,
    }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 320px', minWidth: 280 }}>
          <Combobox<ProductWithRecipe>
            items={products}
            getKey={p => p.product_id}
            getLabel={p =>
              `${p.product_code ?? '#' + p.product_id} | ` +
              `${p.classification_name ?? ''} ${p.name}`}
            getSearchText={p =>
              `${p.product_code ?? ''} ${p.classification_name ?? ''} ${p.name}`}
            value={null}
            onChange={v => v != null && onPickProduct(v as number)}
            placeholder="🔍 商品検索 (コード/名前/分類)"
            maxResults={50}
          />
        </div>
        <label style={{ fontSize: 12 }}>
          <input type="checkbox" checked={state.filters.unset}
            onChange={e => setFilter({ unset: e.target.checked })} /> 未設定 のみ
        </label>
        <label style={{ fontSize: 12 }}>
          <input type="checkbox" checked={state.filters.hasOverride}
            onChange={e => setFilter({ hasOverride: e.target.checked })} /> 部署別 指定 あり
        </label>
        <select
          value={state.sort}
          onChange={e => onChange({ ...state, sort: e.target.value as SortKey })}
          style={{ fontSize: 12 }}
        >
          <option value="code-asc">並び: コード昇順</option>
          <option value="last-ship-desc">並び: 最終出荷 (新→古)</option>
          <option value="recipe-count-desc">並び: 資材数 (多→少)</option>
          <option value="unset-first">並び: 未設定先頭</option>
        </select>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#666' }}>
          現在 {visibleCount} / 全 {totalCount} 件
        </span>
      </div>
    </div>
  )
}
