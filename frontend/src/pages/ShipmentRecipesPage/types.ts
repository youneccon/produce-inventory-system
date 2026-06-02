import type { RecipeEntry } from '../../api/types'

/** 1 商品 の UI 状態 (展開 / 表示 部署 のみ。 編集 モード は 廃止: 各 セル が
 *  個別 に inline-editable) */
export interface ProductUiState {
  expanded: boolean
  /** 現在 表示中 の 部署 ('' = 全部署 default、 値あり = 特定 部署) */
  selectedDept: string
}

export const NEW_PRODUCT_UI_STATE: ProductUiState = {
  expanded: false,
  selectedDept: '',
}

/** フィルター ON/OFF */
export interface FilterFlags {
  unset: boolean
  hasOverride: boolean
}

export type SortKey =
  | 'code-asc'           // 商品コード 昇順 (既定)
  | 'last-ship-desc'     // 最終出荷日 (新→古)
  | 'recipe-count-desc'  // 資材数 (多→少)
  | 'unset-first'        // 未設定 → 設定済み

/** RIGHT 側 で 表示 する 「効果的な レシピ 行」 1 行分 */
export interface EffectiveRecipeRow {
  /** 由来: 'default' = default 行、 'override' = 選択 dept の override 行 */
  source: 'default' | 'override'
  entry: RecipeEntry
}

export interface ToolbarState {
  search: string
  filters: FilterFlags
  sort: SortKey
}

export const DEFAULT_TOOLBAR_STATE: ToolbarState = {
  search: '',
  filters: { unset: false, hasOverride: false },
  sort: 'code-asc',
}
