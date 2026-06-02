// 作物（crop）の URL ベース判定ユーティリティ。
// `/garlic` プレフィックス = 大蒜タブ（crop_id=2）、それ以外 = 生姜タブ（crop_id=1）。

export type CropKind = 'ginger' | 'garlic'

export interface CropInfo {
  kind: CropKind
  id: number       // crops.id（DB の主キー）
  code: string     // crops.code（'01' / '02'）
  name: string
  pathPrefix: string  // '' (ginger=root) | '/garlic'
}

export const CROPS: Record<CropKind, CropInfo> = {
  ginger: { kind: 'ginger', id: 1, code: '01', name: '生姜', pathPrefix: '' },
  garlic: { kind: 'garlic', id: 2, code: '02', name: '大蒜', pathPrefix: '/garlic' },
}

export function currentCrop(pathname: string): CropInfo {
  if (pathname.startsWith('/garlic')) return CROPS.garlic
  return CROPS.ginger
}

// crop_id 定数の一元管理 (NR/振替/出庫レポート 等の 大蒜 固定機能用)。
// 旧: 各ページに `const CROP_ID = 2` がリテラル散在 → 変更が漏れやすい。
// 新: ここから import して使う。
export const GINGER_CROP_ID = 1
export const GARLIC_CROP_ID = 2
export const YAM_CROP_ID    = 3
export const BURDOCK_CROP_ID = 4
export const SWEET_POTATO_CROP_ID = 5
export const GARLIC_EXP_CROP_ID = 12  // 大蒜 実験 sandbox (crop_id=12)
