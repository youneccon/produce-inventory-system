// API レスポンスの型定義（バックエンド api/main.py に対応）

export type Role = 'viewer' | 'operator' | 'admin'

export interface User {
  id: string
  display_name: string
  role: Role
  is_active: boolean
}

export interface RegisterResponse {
  user_id: string
  display_name: string
  role: Role
  is_active: boolean
  device_token: string
  message: string
}

export interface DeviceRow {
  id: string
  display_name: string
  role: Role
  is_active: boolean
  last_login_at: string | null
  created_at: string
}

export interface SmartInputResult {
  supplier_name: string | null
  origin_name: string | null
  spec_type: string | null
  cases: number | null
  kg_per_case: number | null
  unit_price: number | null
  confidence: 'low' | 'medium' | 'high'
  warnings: string[]
}

export interface MasterMatch {
  value: string | null
  matched: boolean
  id: number | null
}

export interface ResolveResult {
  supplier: MasterMatch
  origin: MasterMatch
  grade: MasterMatch
  product_id: number | null
  all_resolved: boolean
}

export interface InboundLot {
  id: number
  product_id: number
  supplier_id: number
  inbound_date: string
  cases: string
  kg_per_case: string
  total_kg: string
  unit_price: string | null
  price_confirmed_at: string | null
  note: string | null
  created_at: string
}

export interface LotStock {
  lot_id: number
  lot_code: string | null
  product_id: number
  supplier_id: number
  inbound_date: string
  cases: string
  kg_per_case: string
  total_kg: string
  total_outbound_kg: string
  remaining_kg: string
  stock_status: 'available' | 'low' | 'depleted'
  stock_value: string | null
  is_price_pending: boolean
  unit_price: string | null
  base_kg: string
  base_date: string | null
  // JOIN した表示属性
  selection_id: number | null    // 選別由来のロットなら選別 ID (バッジ表示用)
  supplier_name: string | null
  spec_type: string | null
  grade_level: string | null
  size_label: string | null
  origin_name: string | null
  crop_id: number | null
  crop_name: string | null
  // 支払い関連 (在庫一覧でインライン編集対象)
  prepay_date?: string | null
  prepay_amount?: string | null
  postpay_date?: string | null
  postpay_amount?: string | null
  brokerage_fee?: string | null
  freight_fee?: string | null
  // 選別由来ロットの 投入元 仕入先/産地 数 (>1 で「複数」表示)
  selection_source_supplier_count?: number | null
  selection_source_origin_count?: number | null
  /** 置場 紐付け済 容量 (storage_object_items.capacity 合計、 全 layout 横断)。
   *  紐付け 可能 残数 = remaining_kg - bound_kg */
  bound_kg?: string
}

export interface ArchiveCandidate {
  lot_id: number
  code: string
  crop_name: string
  inbound_date: string
  total_kg: string
  supplier_name: string
  spec_type: string
  grade_level: string
  size_label: string
  origin_name: string
  remaining_kg: string
  base_kg: string
  base_date: string | null
  carryover_kg: string        // 前月の棚卸数（= 0 のはず）
  carryover_period: string    // 'YYYY-MM'
}

export interface ArchivedLot {
  lot_id: number
  code: string
  crop_name: string
  inbound_date: string
  total_kg: string
  supplier_name: string
  spec_type: string
  grade_level: string
  size_label: string
  origin_name: string
  archived_at: string
  archive_note: string | null
  archived_by_name: string | null
  outbound_count: number
}

export interface DashboardSummary {
  month: string
  prev_month: string
  carryover_kg: string
  inbound_kg: string
  inbound_count: number
  outbound_kg: string
  outbound_count: number
  stock_now_kg: string
}

export interface MonthlyCloseLot {
  lot_id: number
  supplier_name: string
  spec_type: string
  origin_name: string
  inbound_date: string
  theoretical_kg: string
  already_counted: boolean
  counted_kg: string | null
  note: string | null
}

export interface MonthlyClosePreview {
  month: string
  count_date: string
  is_closed: boolean
  lots: MonthlyCloseLot[]
}

export interface MonthlyCloseResult {
  month: string
  closed_count: number
  total_counted_kg: string
  total_theoretical_kg: string
  total_variance_kg: string
  variances: Array<{
    lot_id: number
    counted_kg: number
    theoretical_kg: number
    variance_kg: number
    reason: string | null
    filled: boolean
  }>
  adjustments: Array<{
    lot_id: number
    record_id: number
    quantity_kg: number
    kind: '出庫追加' | '入庫戻し'
  }>
}

export interface CalendarLot {
  lot_id: number
  lot_code: string | null
  selection_id: number | null     // 選別由来のロットなら selection_id (バッジ表示用)
  supplier_name: string
  spec_type: string
  grade_level: string | null
  size_label: string | null
  origin_name: string
  inbound_date: string
  total_kg: string
  kg_per_case: string | null
  unit_price: string | null
  carryover_kg: string
  inbound_kg: string
  outbound_kg: string
  end_kg: string
  daily: Record<string, string> // 日(1..31) -> その日の出庫量（無い日は欠落）
  comments?: Record<string, string> // 日(1..31) -> セルコメント (migration 055)
  // 紙レポート (PDF) 用拡張
  brokerage_fee?: string | null
  freight_fee?: string | null
  prepay_date?: string | null
  prepay_amount?: string | null
  postpay_date?: string | null
  postpay_amount?: string | null
  stocktake_kg?: string | null
  stocktake_diff?: string | null
  stocktake_note?: string | null
}

export interface CalendarView {
  month: string
  days_in_month: number
  lots: CalendarLot[]
  // 紙レポート用
  crop_id?: number | null
  crop_name?: string | null
  prepared_at?: string | null
}

export type ThemeMode = 'light' | 'dark'
export type DensityMode = 'compact' | 'normal' | 'comfortable'
export type EmphasisColor = 'none' | 'blue' | 'green' | 'orange' | 'red' | 'bold'

export interface CalendarColumnPref {
  id: string             // canonical column id (例: 'lot_code', 'total_kg', 'tax_8')
  visible: boolean
  emphasis?: EmphasisColor
}

export interface DashboardColumnPref {
  id: string
  visible: boolean
}

export interface UserPreferences {
  theme?: ThemeMode
  density?: DensityMode
  dashboard?: {
    show_summary?: boolean
    show_products?: boolean
    show_lots?: boolean
    /** 商品別サマリー表の列表示 */
    product_columns?: DashboardColumnPref[]
    /** ロット別在庫表の列表示 */
    lot_columns?: DashboardColumnPref[]
  }
  calendar?: {
    hide_future?: boolean       // デフォルト true
    tax_rate?: number           // 消費税率（生鮮食品なら 0.08）。デフォルト 0.08
    columns?: CalendarColumnPref[]   // 列の表示・順序・強調
  }
}

export interface MaterialStock {
  material_id: number
  code: string
  division: number
  supplier_id: number | null     // migration 025 で追加 (NOT NULL 化後も互換性のため optional)
  supplier_name: string
  item_name: string
  unit: string | null
  is_active: boolean
  unit_price: string | null
  category: string | null
  length_per_roll_cm: string | null
  pack_size: string | null               // 1ケース入り数 (表示用ヘルパー)
  base_qty: string
  base_date: string | null
  movements_since_base: string
  remaining_qty: string                  // 理論在庫
  auto_consumption_cm: string | null
  stock_value: string | null
  // 棚卸ベース (実測) 系
  latest_count_date: string | null
  latest_count_total: string | null      // 集計値 (incomplete でも入る)
  latest_count_complete: boolean | null
  linked_object_count: number | null     // 紐付き object 数
  counted_object_n: number | null        // 棚卸済 object 数
  actual_qty: string | null              // 採用される実在庫 (incomplete=null)
  // 棚卸日時点の理論在庫 (前回棚卸が必要、無いと null)
  theoretical_at_count_date: string | null
  // レシピ登録状況
  recipe_product_count: number
  recipe_estimated_count: number
  // 一般消耗品フラグ (M3 2026-05) — 孤児資材 (=紐付なし AND 非一般消耗品) 判定に使用
  is_general_supply: boolean
}

export interface MaterialCount {
  id: number
  material_id: number
  material_code: string | null
  material_name: string | null
  object_id: number | null
  object_label: string | null
  count_date: string
  counted_qty: string
  source: 'physical_count' | 'migration' | 'layout'
  note: string | null
  confirmed_at: string
  confirmed_by_name: string | null
}

export interface MaterialCategory {
  category: string
  material_count: number
}

export interface MaterialCalendarRow {
  material_id: number
  code: string
  supplier_name: string
  item_name: string
  unit: string | null
  length_per_roll_cm: string | null
  category: string | null
  recipe_product_count: number
  carryover_qty: string
  inbound_qty: string
  outbound_qty: string
  end_qty: string
  daily_in: Record<string, string>
  daily_out: Record<string, string>
}

export interface MaterialCalendar {
  month: string
  days_in_month: number
  rows: MaterialCalendarRow[]
}

export interface AlternativeMaterial {
  material_id: number
  code: string
  item_name: string
  unit: string | null
  supplier_name: string | null
}

export interface RecipeEntry {
  material_id: number
  material_code: string
  material_name: string
  material_unit: string | null
  quantity_per_unit: string
  note: string | null
  is_estimated?: boolean
  estimation_weight?: string
  /** null = 全部署デフォルト, 値あり = 特定部署専用オーバーライド */
  department_code?: string | null
  alternatives?: AlternativeMaterial[]
}

export interface EstimateLine {
  product_id: number
  product_code: string | null
  product_name: string
  pack_size: string | null
  shipment_count: string
  weight: string
  current_qty: string | null
  suggested_qty: string
  is_estimated: boolean
}

export interface EstimateResult {
  material_id: number
  material_code: string
  material_name: string
  material_unit: string | null
  period: string
  real_consumption: string
  explicit_consumption: string
  residual: string
  unit_rate: string
  has_required_counts: boolean
  start_count_date: string | null
  start_count_qty: string | null
  end_count_date: string | null
  end_count_qty: string | null
  inbound_qty: string
  manual_out_qty: string
  missing_reason: string | null
  lines: EstimateLine[]
  applied: boolean
}

export interface ProductWithRecipe {
  product_id: number
  division: number
  name: string
  unit: string | null
  is_active: boolean
  product_code: string | null
  classification_code: string | null
  classification_name: string | null
  pack_size: string | null
  recipes: RecipeEntry[]
  /** 部署別 オーバーライド を 持つ 部署 コード 一覧 */
  override_dept_codes: string[]
  /** 最終出荷日 (ISO YYYY-MM-DD) */
  last_shipped_at: string | null
  /** 直近 30 日 の 出荷件数 */
  monthly_shipment_count: number
}

export interface ShipmentRecord {
  record_id: number
  product_id: number
  product_name: string
  ship_date: string
  quantity: string
  sales_amount: string | null
  weight_kg: string | null
  pack_count: string | null
  pack_size: string | null
  department_code: string | null
  dispatch_from: string | null
  note: string | null
  created_at: string
  created_by_name: string | null
}

export interface ShipmentDepartment {
  department_code: string
  shipment_count: number
  product_count: number
}

export interface ShipmentCalendarRow {
  product_id: number
  name: string
  unit: string | null
  month_total: string
  daily: Record<string, string>
}

export interface ShipmentCalendar {
  month: string
  days_in_month: number
  rows: ShipmentCalendarRow[]
}

export interface ProductStock {
  product_id: number
  spec_type: string
  grade_level: string
  size_label: string
  size_mm: number | null
  origin_name: string
  region: string | null
  active_lot_count: number
  total_remaining_kg: string
  total_stock_value: string | null
  pending_price_lot_count: number
  oldest_lot_date: string | null
}

export interface Supplier {
  id: number
  name: string
  name_kana: string | null
  is_active: boolean
}

// =============================================================================
// 半製品台帳 (拡張#2)
// =============================================================================

export type SemifinishedStatus = 'pending' | 'sorting' | 'soaking' | 'washing'

export interface SemifinishedStock {
  lot_id: number
  code: string
  source_outbound_id: number
  product_id: number
  crop_id: number
  crop_code: string
  crop_name: string
  grade_id: number
  spec_type: string
  grade_level: string
  size_label: string
  size_mm: number | null
  origin_id: number
  origin_name: string
  status: SemifinishedStatus
  source_lot_id: number
  source_lot_code: string
  source_outbound_date: string
  source_outbound_note: string | null
  source_outbound_kg: string
  inbound_date: string
  base_cases: string
  kg_per_case: string
  base_kg: string
  unit_price: string | null
  price_confirmed_at: string | null
  consumed_kg: string
  remaining_kg: string
  stock_value: string | null
  note: string | null
  archived_at: string | null
  archive_note: string | null
  created_at: string | null
  updated_at: string | null
}

export interface SemifinishedSourceOutbound {
  outbound_id: number
  outbound_date: string
  quantity_kg: string
  note: string | null
  lot_id: number
  lot_code: string
  product_id: number
  spec_type: string
  grade_level: string
  size_label: string
  origin_name: string
  supplier_name: string
  crop_id: number
  crop_name: string
  lot_unit_price: string | null
}

export interface SemifinishedOutbound {
  id: number
  semifinished_lot_id: number
  semifinished_code: string | null
  outbound_date: string
  quantity_kg: string
  cases: string | null
  purpose: string | null
  customer: string | null
  note: string | null
  created_at: string | null
}

export interface Origin {
  id: number
  name: string
  name_kana: string | null
  region: string | null
  is_active: boolean
}

export interface Grade {
  id: number
  spec_type: string
  grade_level: string
  size_label: string
  size_mm: number | null
  is_active: boolean
}

export interface Product {
  id: number
  crop_id: number
  crop_code: string
  crop_name: string
  grade_id: number
  origin_id: number
  spec_type: string
  grade_level: string
  size_label: string
  size_mm: number | null
  origin_name: string
  region: string | null
}

export interface PendingPriceLot {
  id: number
  inbound_date: string
  cases: string
  kg_per_case: string
  total_kg: string
  note: string | null
  supplier_name: string
  spec_type: string
  grade_level: string
  size_label: string
  origin_name: string
}

export interface BulkPriceResult {
  confirmed: number[]
  not_found: number[]
  already_confirmed: number[]
}

export interface EligibleCandidate {
  lot_id: number
  lot_code: string
  inbound_date: string
  supplier_name: string
  spec_type: string
  grade_level: string
  size_label: string
  origin_name: string
  remaining_kg: number
  unit_price: number | null
  fifo_rank: number
}

export interface PreviewResult {
  product_id: number
  required_kg: number
  available_kg: number
  is_sufficient: boolean
  auto_select: boolean
  candidate_count: number
  sim_lines: Array<{
    lot_id: number
    lot_code: string
    inbound_date: string
    supplier_name: string
    spec_type: string
    origin_name: string
    remaining_kg: number
    take_kg: number
    is_split: boolean
    unit_price: number | null
    fifo_rank: number
  }>
  needs_user_select: boolean
}

export interface AllocationLine {
  outbound_record_id: number
  lot_id: number
  lot_code: string | null
  quantity_kg: string
  is_split: boolean
  inbound_date: string | null
  supplier_name: string | null
  spec_type: string | null
  grade_level: string | null
  size_label: string | null
  origin_name: string | null
}

export interface AllocationResult {
  product_id: number
  outbound_date: string
  total_kg: string
  is_split: boolean
  lot_ids: number[]
  lines: AllocationLine[]
}

export interface NeedsSelectionResponse {
  needs_selection: true
  candidates: EligibleCandidate[]
}

export interface OutboundRecord {
  record_id: number
  lot_id: number             // 内部 ID (FK 用、UI には基本表示しない)
  lot_code: string           // 整理番号 (業務 ID。例: '01G00001')
  outbound_date: string
  quantity_kg: number
  note: string | null
  created_at: string
  inbound_date: string
  kg_per_case: string | null
  product_id: number
  spec_type: string
  grade_level: string
  size_label: string
  origin_name: string
  supplier_name: string
  created_by_name: string | null
}

export interface InboundHistoryRow {
  lot_id: number
  code: string
  inbound_date: string
  cases: string | null
  kg_per_case: string | null
  total_kg: string
  unit_price: string | null
  total_price: string | null
  note: string | null
  archived_at: string | null
  supplier_name: string
  spec_type: string
  grade_level: string | null
  size_label: string | null
  origin_name: string
  crop_id: number
  crop_name: string
  created_by_name: string | null
  outbound_kg: string
  remaining_kg: string
}

export interface MaterialMovementRow {
  id: number
  material_id: number
  movement_date: string
  quantity: string
  note: string | null
  created_at: string
  code: string
  item_name: string
  supplier_name: string
  unit: string | null
  division: number
  created_by_name: string | null
}

export interface AuditEntry {
  id: number
  event_type: string
  table_name: string | null
  record_id: string | null
  payload: unknown
  actor_id: string | null
  actor_name: string | null
  occurred_at: string
}

// =============================================================================
// 作物 / 選別
// =============================================================================

export interface Crop {
  id: number
  code: string   // '01' / '02' / ...
  name: string
}

export interface Reservation {
  id: number
  code: string
  crop_id: number
  crop_code: string
  crop_name: string
  code_kind: string  // 'G' | 'S'
  note: string | null
  created_by: string
  created_by_name: string | null
  created_at: string
  consumed_at: string | null
  consumed_inbound_id: number | null
  consumed_inbound_code: string | null
}

export interface SourceLot {
  lot_id: number
  code: string
  crop_id: number
  crop_name: string
  inbound_date: string
  supplier_id: number
  supplier_name: string
  spec_type: string
  grade_level: string
  size_label: string
  origin_id: number
  origin_name: string
  remaining_kg: string
  unit_price: string | null
}

export interface ReferencePrice {
  grade_id: number
  spec_type: string
  grade_level: string
  size_label: string
  origin_id: number
  origin_name: string
  product_id: number
  reference_price: string | null
  reference_lot_code: string | null
  reference_lot_date: string | null
}

// 新仕様 (2026-05): 投入は複数ロット可能、 単価は加重平均、 出力は原料台帳へ
export interface SelectionSourceInput {
  lot_id: number
  source_kg: number
}
export interface SelectionOutputInput {
  product_id: number
  quantity_kg: number
  note?: string | null
}

export interface SelectionPerSource {
  lot_id: number
  code: string
  source_kg: number
  consume_kg: number
  disposal_kg: number
}

export interface SelectionComputeResult {
  sources_total_kg: string
  outputs_total_kg: string
  disposal_kg: string
  weighted_unit_price: string | null   // 産出単価 (歩留まり考慮)
  sources_total_value: string          // 投入総価額
  output_total_value: string           // 出力総価額 (= 投入総価額)
  per_source: SelectionPerSource[]
  distinct_supplier_count: number
  distinct_origin_count: number
  earliest_inbound_date: string | null
}

export interface SelectionOperation {
  id: number
  code: string
  crop_id: number
  crop_name: string
  operation_date: string
  weighted_unit_price: string | null
  note: string | null
  created_at: string
  // list endpoint:
  source_count?: number
  sources_total_kg?: string
  disposal_kg?: string
  output_count?: number
  outputs_total_kg?: string
  created_by_name?: string | null
  // detail endpoint:
  sources?: SelectionPerSource[]
  output_lots?: Array<{
    lot_id: number
    code: string
    product_id: number
    total_kg: number
    unit_price: number | null
  }>
}

export interface SelectionSourceInfo {
  selection_code: string
  selection_date: string
  weighted_unit_price: string | null
  sources: Array<{
    source_kg: string
    consume_kg: string
    disposal_kg: string
    lot_code: string
    inbound_date: string
    supplier_name: string
    origin_name: string
  }>
}

// =============================================================================
// 保管レイアウト (storage_layouts)
// =============================================================================

export type StorageTargetKind = 'material' | 'ingredient'
export type StorageDefaultLinkKind = 'ingredient' | 'semifinished'

export interface StorageLayout {
  id: number
  name: string
  division: number | null
  target_kind: StorageTargetKind
  /** ingredient レイアウト内で新規オブジェクトの紐付けデフォルト */
  default_link_kind?: StorageDefaultLinkKind
  image_url: string | null
  image_width: number | null
  image_height: number | null
  note: string | null
  is_active: boolean
  /** 倉庫全体の床面アウトライン (多角形頂点。3 以上で閉じた図形として描画) */
  floor_outline: [number, number][] | null
}

/**
 * 物理 オブジェクト タイプ。
 *   'pallet'          — 既定。 既存 ingredient/material オブジェクト 全て。
 *                       pallet_tiers / orientation を 使用。
 *   'steel_container' — 長芋 用 スチール コンテナ (1000×800×510mm)。
 *                       1 オブジェクト = 複数 コンテナ を 縦 に 積む。
 *                       紐付け 数 = 段数 (動的)。 pallet_tiers / orientation は 無視。
 */
export type StorageObjectType = 'pallet' | 'steel_container'

export interface StorageObject {
  id: number
  layout_id: number
  label: string | null
  x: number
  y: number
  width: number
  height: number
  color: string | null
  note: string | null
  /** 0 = 横長 (default), 90 = 縦長。 pallet 限定で意味を持つ */
  orientation?: number
  /** パレット段数 (6 or 7、 default 7)。 pallet 限定で意味を持つ */
  pallet_tiers?: number
  /** 物理 タイプ。 デフォルト 'pallet' */
  object_type?: StorageObjectType
}

export interface StorageWall {
  id: number
  layout_id: number
  x1: number
  y1: number
  x2: number
  y2: number
  thickness: number
}

export interface StorageObjectItem {
  id: number
  object_id: number
  material_id: number | null
  inbound_lot_id: number | null
  semifinished_lot_id?: number | null
  capacity: number | null
  priority: number
  note: string | null
  /** [旧 model] パレ別 詳細 (各 パレット の {t: 段, c: 端ケ})。 deprecated。
   *  新 model では 1 行 = 1 パレ で 表現 する ため 不要。 */
  pallet_details?: { t: number; c: number }[] | null
  /** [新 model] object 内 の パレット 位置 (0..N-1)。 ingredient pallet object 用。
   *  NULL = 旧 model (= capacity/pallet_details ベース)。 */
  pallet_index?: number | null
  /** [新 model] このパレ の 積み切った 段数 (0..7)。 */
  tier_count?: number | null
  /** [新 model] このパレ の 上の 端ケース 数 (0..6)。 末尾 以外 は 0。 */
  case_count?: number | null
  // 表示用 (バックエンドが JOIN で付加)
  current_stock: string | number | null
  base_qty: string | number | null
  base_date: string | null
  // 資材の場合
  material_code?: string
  material_name?: string
  material_supplier?: string
  material_unit?: string | null
  // 原料ロットの場合
  lot_code?: string
  lot_spec_type?: string
  lot_grade_level?: string
  lot_size_label?: string
  lot_origin_name?: string
  lot_supplier_name?: string
  lot_inbound_date?: string
  // 半製品ロットの場合
  semifin_code?: string
  semifin_spec_type?: string
  semifin_grade_level?: string
  semifin_size_label?: string
  semifin_origin_name?: string
  semifin_base_kg?: string | number
  semifin_status?: string
}

export interface LayoutState {
  layout: StorageLayout
  objects: StorageObject[]
  items: StorageObjectItem[]
  walls?: StorageWall[]
  date: string | null
}

/**
 * 棚卸エントリ (storage_object_inventory_entries) — Phase A1 v2。
 * レイアウト 図 上 で 取った 棚卸 スナップショット。 台帳 と は 非同期。
 *
 * v2 設計:
 *   - 「種別 (kind)」 フィールド 廃止。 集計時 に lot/material 紐付け + crop で
 *     section を 推定 する
 *   - 在庫 ref (inbound_lot_id / material_id / semifinished_lot_id / outbound_id)
 *     は 入力 高速化 用。 ON DELETE SET NULL で snapshot 性 を 保つ (台帳 行 が
 *     消えても entry は 残る)。
 *
 * 同日 同名 上書き: (object_id, inventory_date, COALESCE(name,'')) で UNIQUE。
 *   POST で 衝突 すれば 上書き、 別日 なら 新規 (履歴 残る)。
 */
export type InventoryEntryProcessState = '洗' | '選'

export interface InventoryEntry {
  id: number
  object_id: number
  inventory_date: string                    // 'YYYY-MM-DD'
  // 在庫 由来 ref (snapshot — 自動 同期 は しない)
  inbound_lot_id: number | null
  material_id: number | null
  semifinished_lot_id: number | null
  outbound_id: number | null                // 生姜 半製品 専用 (本来 の 出庫 紐付け)
  // master / free text
  crop_id: number | null
  origin_text: string | null
  spec_text: string | null
  sub_spec_text: string | null              // 規格 override / 補助 規格 (free text)
  supplier_text: string | null              // 仕入先 free text (migration 081)
  category_major: string | null             // memo 用 (大分類)
  category_minor: string | null             // memo 用 (小分類)
  name: string | null
  cases: number | null                      // ケース 数
  kg_per_case: number | null                // ケース 重量
  total_kg: number | null                   // 総 重量 (= cases × kg_per_case 想定)
  process_state: InventoryEntryProcessState | null   // 生姜 半製品 用 (Phase B)
  note: string | null
}

/** POST /storage/objects/{id}/inventory-entries 用 (upsert)。 */
export interface InventoryEntryCreate {
  inventory_date?: string                   // 省略 で CURRENT_DATE
  inbound_lot_id?: number | null
  material_id?: number | null
  semifinished_lot_id?: number | null
  outbound_id?: number | null
  crop_id?: number | null
  origin_text?: string | null
  spec_text?: string | null
  sub_spec_text?: string | null
  supplier_text?: string | null             // 仕入先 free text
  category_major?: string | null
  category_minor?: string | null
  name?: string | null
  cases?: number | null
  kg_per_case?: number | null
  total_kg?: number | null
  process_state?: InventoryEntryProcessState | null
  note?: string | null
}

/** PUT /storage/inventory-entries/{id} 用。 全部 optional。 */
export type InventoryEntryUpdate = Partial<InventoryEntryCreate>

/** GET /storage/inventory-entries/suggestions のレスポンス。 各 Combobox の 候補。 */
export interface EntrySuggestions {
  origins:          string[]
  specs:            string[]
  suppliers:        string[]
  category_majors:  string[]
  category_minors:  string[]
}

/**
 * 棚卸 → 差数 → 調整出庫 (Phase A3)
 * StorageLinkModal の links タブで 紐づけ済 lot/material に 棚卸数 を 入力し、
 * 差数 ぶん 調整出庫 を 立てる。
 */
export interface StocktakeAdjustItem {
  inbound_lot_id?: number | null
  material_id?:    number | null
  counted_kg:      number
}

export interface StocktakeAdjustRequest {
  outbound_date:   string                  // 'YYYY-MM-DD'
  inventory_date?: string | null           // 省略 = CURRENT_DATE
  items:           StocktakeAdjustItem[]
  note?:           string | null
  dry_run:         boolean
}

export interface StocktakeAdjustResultLine {
  inbound_lot_id:      number | null
  material_id:         number | null
  label:               string
  current_kg:          number
  counted_kg:          number
  diff_kg:             number              // current - counted (正: 棚卸が少ない → 出庫候補)
  action:              'outbound' | 'warn_over' | 'noop'
  message:             string | null
  outbound_record_id:  number | null
  movement_id:         number | null
  inventory_entry_id:  number | null
}

export interface StocktakeAdjustResult {
  dry_run: boolean
  lines:   StocktakeAdjustResultLine[]
}

export interface CorrectionRecord {
  id: number
  target_table: string
  target_id: number
  field_name: string
  old_value: string | null
  new_value: string | null
  reason: string
  corrected_by: string
  corrected_by_name: string | null
  corrected_at: string
}
