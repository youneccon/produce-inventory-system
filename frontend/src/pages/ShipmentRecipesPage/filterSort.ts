import type { ProductWithRecipe } from '../../api/types'
import type { EffectiveRecipeRow, FilterFlags, SortKey, ToolbarState } from './types'

/** 商品 が フィルター 通過 する か (= 表示対象 か) を 判定。 */
export function passesFilter(
  p: ProductWithRecipe, f: FilterFlags,
): boolean {
  const defaultRecipes = p.recipes.filter(r => !r.department_code)
  if (f.unset && defaultRecipes.length > 0) return false
  if (f.hasOverride && p.override_dept_codes.length === 0) return false
  return true
}

/** 商品 が 検索 文字列 に マッチ する か (空白 AND、 大文字 小文字 区別 なし)。 */
export function matchesSearch(
  p: ProductWithRecipe, query: string,
): boolean {
  if (!query.trim()) return true
  const haystack = [
    p.product_code ?? '',
    p.name,
    p.classification_name ?? '',
  ].join(' ').toLowerCase()
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  return tokens.every(t => haystack.includes(t))
}

/** 与えられた sortKey で 比較関数 を 返す。 */
export function comparator(sort: SortKey): (
  a: ProductWithRecipe, b: ProductWithRecipe,
) => number {
  switch (sort) {
    case 'code-asc':
      return (a, b) => (a.product_code ?? '').localeCompare(b.product_code ?? '')
    case 'last-ship-desc':
      return (a, b) => {
        const al = a.last_shipped_at ?? ''
        const bl = b.last_shipped_at ?? ''
        // 空文字 (=未出荷) は 最後
        if (!al && !bl) return 0
        if (!al) return 1
        if (!bl) return -1
        return bl.localeCompare(al)
      }
    case 'recipe-count-desc':
      return (a, b) => {
        const ac = a.recipes.filter(r => !r.department_code).length
        const bc = b.recipes.filter(r => !r.department_code).length
        return bc - ac
      }
    case 'unset-first':
      return (a, b) => {
        const au = a.recipes.filter(r => !r.department_code).length === 0
        const bu = b.recipes.filter(r => !r.department_code).length === 0
        if (au !== bu) return au ? -1 : 1
        return (a.product_code ?? '').localeCompare(b.product_code ?? '')
      }
  }
}

/** 商品 を fetch 結果 から 表示用 配列 に 変換 (filter + sort)。 */
export function filterAndSort(
  products: ProductWithRecipe[],
  toolbar: ToolbarState,
): ProductWithRecipe[] {
  return products
    .filter(p => passesFilter(p, toolbar.filters))
    .filter(p => matchesSearch(p, toolbar.search))
    .sort(comparator(toolbar.sort))
}

/** 選択 部署 に 応じた 「効果的な レシピ 行」 を 返す。
 *  - selectedDept === '' → default 行 のみ
 *  - selectedDept === 'X' → 部署X の override で 上書き、 無い 行 は default を fallback
 */
export function effectiveRecipes(
  p: ProductWithRecipe, selectedDept: string,
): EffectiveRecipeRow[] {
  const defaults = p.recipes.filter(r => !r.department_code)
  if (!selectedDept) {
    return defaults.map(e => ({ source: 'default', entry: e }))
  }
  const overrides = p.recipes.filter(r => r.department_code === selectedDept)
  const overrideByMat = new Map(overrides.map(o => [o.material_id, o]))
  return defaults.map(d => {
    const ov = overrideByMat.get(d.material_id)
    return ov
      ? { source: 'override' as const, entry: ov }
      : { source: 'default' as const, entry: d }
  })
}
