// ダッシュボード表のカラム定義
//   - 商品別サマリー (ProductStock)
//   - ロット別在庫    (LotStock)
//
// カスタマイズはレイアウト崩れを避けるため、表示・非表示のみとする
// （順序固定、強調なし）。

import type { LotStock, ProductStock } from '../api/types'

export interface DashColumn<T> {
  id: string
  label: string
  numeric?: boolean
  /** デフォルト表示 */
  defaultVisible?: boolean
  /** 値の取り出しと文字列化はページ側で行うため、ここでは id のみ持つ */
  _phantom?: T
}

// 商品別サマリー
//   ※ 規格・等級・サイズ は データ構造上は別フィールドだが、 業務上は 1 つの
//     「規格」 として塊で見るのが自然なので、 デフォルトは合体列 'spec_combined'
//     を表示する。 3 つの個別列は カスタマイズで ON にすれば従来どおり表示可能。
export const PRODUCT_COLUMNS: DashColumn<ProductStock>[] = [
  { id: 'spec_combined',       label: '規格',          defaultVisible: true },
  { id: 'spec_type',           label: '規格種別 (個別)',  defaultVisible: false },
  { id: 'grade_level',         label: '等級 (個別)',     defaultVisible: false },
  { id: 'size_label',          label: 'サイズ (個別)',    defaultVisible: false },
  { id: 'origin_name',         label: '産地',          defaultVisible: true },
  { id: 'active_lot_count',    label: '在庫ロット数',  numeric: true, defaultVisible: true },
  { id: 'total_remaining_kg',  label: '在庫量(kg)',    numeric: true, defaultVisible: true },
  { id: 'total_stock_value',   label: '評価額',        numeric: true, defaultVisible: true },
  { id: 'pending_price_lot_count', label: '単価未確定', numeric: true, defaultVisible: true },
  { id: 'oldest_lot_date',     label: '最古入荷日',    defaultVisible: true },
]

// ロット別在庫
//   ※ 規格・等級・サイズ の合体表示は 'spec_combined' (default ON)、
//     個別列は default OFF (必要なら 列設定 で ON)。
export const LOT_COLUMNS: DashColumn<LotStock>[] = [
  { id: 'lot_id',               label: '整理番号',      defaultVisible: true },
  { id: 'inbound_date',         label: '入荷日',        defaultVisible: true },
  // 属性（仕入先・規格・産地等。デフォルト非表示、必要な人だけ表示）
  { id: 'supplier_name',        label: '仕入先',        defaultVisible: false },
  { id: 'spec_combined',        label: '規格',          defaultVisible: true },
  { id: 'spec_type',            label: '規格種別 (個別)', defaultVisible: false },
  { id: 'grade_level',          label: '等級 (個別)',    defaultVisible: false },
  { id: 'size_label',           label: 'サイズ (個別)',  defaultVisible: false },
  { id: 'origin_name',          label: '産地',          defaultVisible: true },
  // 数量・金額
  { id: 'kg_per_case',          label: 'C/S重量(kg)',    numeric: true, defaultVisible: true },
  { id: 'total_kg',             label: '入庫量',        numeric: true, defaultVisible: true },
  { id: 'base_kg',              label: '起点（前月繰越）', numeric: true, defaultVisible: true },
  { id: 'total_outbound_kg',    label: '当月出庫',      numeric: true, defaultVisible: true },
  { id: 'remaining_kg',         label: '残量',          numeric: true, defaultVisible: true },
  { id: 'stock_status',         label: '状態',          defaultVisible: true },
  { id: 'unit_price',           label: '単価',          numeric: true, defaultVisible: true },
  { id: 'stock_value',          label: '在庫評価額',    numeric: true, defaultVisible: true },
  // 支払い関連 (default OFF — カスタマイズで ON にして使う)
  { id: 'prepay_date',           label: '前払日',        defaultVisible: false },
  { id: 'prepay_amount',         label: '前払金額',      numeric: true, defaultVisible: false },
  { id: 'postpay_date',          label: '後払日',        defaultVisible: false },
  { id: 'postpay_amount',        label: '後払金額',      numeric: true, defaultVisible: false },
  { id: 'brokerage_fee',         label: '手数料',        numeric: true, defaultVisible: false },
  { id: 'freight_fee',           label: '送料',          numeric: true, defaultVisible: false },
]
