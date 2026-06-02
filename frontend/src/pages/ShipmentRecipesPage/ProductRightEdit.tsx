import type { RecipeEntry } from '../../api/types'

/** 編集中 (= pending or commit 直前) の 1 資材行 の draft データ。
 *  既存行 を 編集 する 場合 も、 新規 pending row も 共通 で この 形 を 使う。 */
export interface EditRow {
  /** UI rid (重複しない、 単調増加)。 React key と patch 対象 識別 に 使う */
  rid: number
  category: string
  material_id: number | null
  quantity: string
  note: string
  /** 推定 関連 は UI から 廃止 (サーバー側 自動推定) されたが、 既存 値 は
   *  保存時 に そのまま 維持 する (壊さない) ため 内部 で 保持 */
  is_estimated: boolean
  estimation_weight: string
  alternative_material_ids: number[]
}

/** カテゴリ の デフォルト 並び (行 を 追加 する たび に 次 の もの を 既定 に) */
export const DEFAULT_CATEGORY_CYCLE = [
  '段ボール', '袋', 'ラベル', 'フィルム', 'ネット', '容器', '脱酸素剤', '梱包',
]

let _ridCounter = 1
export function newEditRow(category = '段ボール'): EditRow {
  return {
    rid: _ridCounter++, category,
    material_id: null, quantity: '', note: '',
    is_estimated: false, estimation_weight: '1',
    alternative_material_ids: [],
  }
}

export function recipeEntryToEditRow(e: RecipeEntry, category: string): EditRow {
  return {
    rid: _ridCounter++, category,
    material_id: e.material_id,
    quantity: String(e.quantity_per_unit),
    note: e.note ?? '',
    is_estimated: e.is_estimated ?? false,
    estimation_weight: e.estimation_weight ?? '1',
    alternative_material_ids: (e.alternatives ?? []).map(a => a.material_id),
  }
}
