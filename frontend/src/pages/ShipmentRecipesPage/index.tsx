import { useCallback, useMemo, useState } from 'react'
import { useFetch } from '../../lib/useFetch'
import { api } from '../../api/client'
import { LoadingState } from '../../components/StatusDisplay'
import type {
  MaterialCategory, MaterialStock, ProductWithRecipe, RecipeEntry,
} from '../../api/types'
import type { ProductUiState, ToolbarState } from './types'
import { DEFAULT_TOOLBAR_STATE, NEW_PRODUCT_UI_STATE } from './types'
import { filterAndSort } from './filterSort'
import { categoryNames } from './categoryUtils'
import type { EditRow } from './ProductRightEdit'
import ProductTable from './ProductTable'
import Toolbar from './Toolbar'

interface Props {
  fixedDivision?: number
  /** 'public' = 公開モード (認証なし、 /public/recipe-survey/{div}/by-product/* endpoints を 使う) */
  authMode?: 'auth' | 'public'
}

export default function ShipmentRecipesPage({
  fixedDivision, authMode = 'auth',
}: Props = {}) {
  // 公開モード では URL prefix を /public/recipe-survey/{div}/by-product に 切替。
  // この モード で は fixedDivision が 必須 (上位 で route param から 渡す)。
  const isPublic = authMode === 'public'
  const pubBase = isPublic && fixedDivision != null
    ? `/public/recipe-survey/${fixedDivision}/by-product`
    : null

  const products = useFetch<ProductWithRecipe[]>(
    isPublic
      ? (pubBase ? `${pubBase}/products` : null)
      : '/shipments/products',
    !isPublic && fixedDivision != null
      ? { division: String(fixedDivision) } : undefined,
  )
  const materials = useFetch<MaterialStock[]>(
    isPublic
      ? (pubBase ? `${pubBase}/materials` : null)
      : (fixedDivision != null ? '/materials/stock' : null),
    !isPublic && fixedDivision != null
      ? { division: String(fixedDivision), include_unassigned: 'true' }
      : undefined,
  )
  const categories = useFetch<MaterialCategory[]>(
    isPublic ? (pubBase ? `${pubBase}/categories` : null) : '/materials/categories',
  )
  const departments = useFetch<Array<{ department_code: string }>>(
    isPublic ? (pubBase ? `${pubBase}/departments` : null) : '/shipments/departments',
  )
  const knownDeptCodes = useMemo(
    () => (departments.data ?? []).map(d => d.department_code).sort(),
    [departments.data],
  )
  const categoriesAvailable = useMemo(
    () => categoryNames(categories.data),
    [categories.data],
  )

  const [toolbar, setToolbar] = useState<ToolbarState>(DEFAULT_TOOLBAR_STATE)
  const [uiState, setUiState] = useState<Map<number, ProductUiState>>(new Map())
  const [saveError, setSaveError] = useState<string | null>(null)
  // 保存成功 後 ~600ms だけ 緑 halo を 出す 商品 ID (halo proposal 1️⃣ 2026-05-27)。
  // user の 「保存できた?」 不安 を 視覚 で 解消。
  const [savedHaloProductId, setSavedHaloProductId] = useState<number | null>(null)

  const patchUi = useCallback((productId: number, patch: Partial<ProductUiState>) => {
    setUiState(prev => {
      const next = new Map(prev)
      const cur = next.get(productId) ?? NEW_PRODUCT_UI_STATE
      next.set(productId, { ...cur, ...patch })
      return next
    })
  }, [])

  /** 新規 部署 オーバーライド を 追加: その商品 を 部署X モード に 切替 +
   *  展開状態 へ (各 セル が inline-editable なので そのまま 編集 開始 できる) */
  const handleAddOverride = useCallback((productId: number, dept: string) => {
    patchUi(productId, { selectedDept: dept, expanded: true })
  }, [patchUi])

  /** Toolbar 検索 で 選択: 該当行 を 展開 + スクロール */
  const handlePickProduct = useCallback((pid: number) => {
    patchUi(pid, { expanded: true })
    setTimeout(() => {
      const el = document.getElementById(`product-row-${pid}`)
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 50)
  }, [patchUi])

  /** 保存: 編集中 商品 の 指定 dept の レシピ を 全置換 PUT。 */
  const handleSave = useCallback(async (
    productId: number, rows: EditRow[], deptCode: string,
  ) => {
    const product = products.data?.find(p => p.product_id === productId)
    if (!product) return
    setSaveError(null)

    const targetDept = deptCode || null
    // 編集対象 (deptCode) 以外 の 既存 行 は 維持
    const kept: RecipeEntry[] = product.recipes.filter(
      r => (r.department_code ?? null) !== targetDept,
    )
    const newEntries = rows
      .filter(r => r.material_id != null && r.quantity.trim() !== '')
      .map(r => ({
        material_id: r.material_id!,
        quantity_per_unit: r.quantity,
        note: r.note || null,
        is_estimated: r.is_estimated,
        estimation_weight: r.estimation_weight,
        alternative_material_ids: r.alternative_material_ids,
        department_code: targetDept,
      }))
    const allEntries = [
      ...kept.map(k => ({
        material_id: k.material_id,
        quantity_per_unit: String(k.quantity_per_unit),
        note: k.note,
        is_estimated: k.is_estimated ?? false,
        estimation_weight: k.estimation_weight ?? '1',
        alternative_material_ids: (k.alternatives ?? []).map(a => a.material_id),
        department_code: k.department_code ?? null,
      })),
      ...newEntries,
    ]
    try {
      const url = pubBase
        ? `${pubBase}/products/${productId}/recipes`
        : `/shipments/products/${productId}/recipes`
      await api.put(url, { entries: allEntries })
      products.reload()
      // 成功 halo: 600ms 後 に クリア
      setSavedHaloProductId(productId)
      setTimeout(() => {
        setSavedHaloProductId(cur => cur === productId ? null : cur)
      }, 650)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : '保存 失敗')
    }
  }, [products, pubBase])

  const visible = useMemo(
    () => filterAndSort(products.data ?? [], toolbar),
    [products.data, toolbar],
  )

  const inner = (
    <div className="page recipe-page-container">
      <h2>商品別資材使用状況調査</h2>
      {saveError && <div className="alert error">{saveError}</div>}
      {products.loading && <LoadingState />}
      {products.error && <div className="alert error">{products.error}</div>}
      {products.data && (
        <>
          <Toolbar
            state={toolbar}
            onChange={setToolbar}
            products={visible}
            onPickProduct={handlePickProduct}
            visibleCount={visible.length}
            totalCount={products.data.length}
          />
          <ProductTable
            products={visible}
            uiState={uiState}
            materials={materials.data}
            knownDeptCodes={knownDeptCodes}
            categoriesAvailable={categoriesAvailable}
            onPatchUi={patchUi}
            onAddOverride={handleAddOverride}
            onSave={handleSave}
            savedHaloProductId={savedHaloProductId}
          />
        </>
      )}
    </div>
  )

  // 公開 モード で は Layout が 無い ので、 自前 で 全画面 スクロール コンテナ を 提供。
  // (auth モード は Layout の main.main が overflow:auto を 提供 してる ので そのまま)
  if (isPublic) {
    return (
      <div style={{
        position: 'fixed', inset: 0,
        background: '#f5f7fa',
        overflowY: 'auto',
        WebkitOverflowScrolling: 'touch',
        touchAction: 'pan-y',
        padding: 12,
        paddingBottom: 'max(40px, env(safe-area-inset-bottom, 40px))',
        boxSizing: 'border-box',
      }}>
        {inner}
      </div>
    )
  }
  return inner
}
