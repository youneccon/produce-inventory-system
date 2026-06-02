import type { MaterialCategory } from '../../api/types'

/** カテゴリ マスタ から 表示用 名前 配列 を 返す。 */
export function categoryNames(cats: MaterialCategory[] | null | undefined): string[] {
  return (cats ?? []).map(c => c.category)
}
