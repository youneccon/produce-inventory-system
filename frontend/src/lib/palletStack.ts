/**
 * パレット階層モデル
 * ==================
 *
 * 倉庫業務における「数えの単位」 は厳密な階層を持つ:
 *
 *     ケース  ──[×7]──  段  ──[×7]──  パレット
 *     1       ──        7    ──       49
 *
 * このモジュールは任意の case 数 N に対し、 2 つの異なる分解を提供する:
 *
 *   1. **形 (shape)** — スタックの見た目。 「満パレット + 部分パレット (満段 + 端数)」
 *      → 例 N=57: 「1パレ満 + 1段 + 1ケ」
 *
 *   2. **数 (counts)** — 棚卸で物理的に数える単位。 「物体としてのパレット数 / 段数 / ケース端数」
 *      → 例 N=57: パレット 2、 段 9、 端数 1
 *
 *  ─── 数式 ───
 *    全パレット数  = ceil(N / 49)          # 部分使用中のも 1 として数える
 *    全段数        = ceil(N / 7)            # 端数があれば最上段も 1 として数える
 *    ケース端数    = N % 7
 *    満パレット数  = floor(N / 49)
 *    部分パレ満段  = floor((N % 49) / 7)
 *
 *  仕様変更が将来あり得るので、 段/パレット容量は引数で上書き可能。
 */

export interface PalletConfig {
  /** 1 段に乗るケース数 (default 7) */
  casesPerTier: number
  /** 1 パレットの段数 (default 7) */
  tiersPerPallet: number
}

const DEFAULT_CFG: PalletConfig = { casesPerTier: 7, tiersPerPallet: 7 }


/** スタックの「形」 分解: 満パレ + 部分パレット内訳 */
export interface StackShape {
  total: number
  fullPallets: number              // 完全に満タンのパレット数
  partialPallet: null | {
    fullTiers: number              // 部分パレット内の満段数
    looseCases: number             // 最上段の端数ケース (1..6)
  }
  /** 全体に占める空き割合 (0=空, 1=満タン)。 ただし「現在使用しているパレットの容量」 比 */
  fillRatio: number
}

/** 棚卸用の「数」 内訳 */
export interface StackCounts {
  total: number
  /** 物体としてのパレット数 (部分使用中も 1 と数える) */
  totalPallets: number
  /** 段数合計 (部分段も 1 と数える) */
  totalTiers: number
  /** 最上段のケース端数 (0..6) */
  looseCases: number
}

export function palletCapacity(cfg: PalletConfig = DEFAULT_CFG): number {
  return cfg.casesPerTier * cfg.tiersPerPallet
}


/** 形分解 */
export function decomposeStackShape(
  cases: number,
  cfg: PalletConfig = DEFAULT_CFG,
): StackShape {
  const n = Math.max(0, Math.floor(cases))
  const cap = palletCapacity(cfg)
  const fullPallets = Math.floor(n / cap)
  const remainder = n - fullPallets * cap
  if (remainder === 0) {
    return { total: n, fullPallets, partialPallet: null, fillRatio: n > 0 ? 1 : 0 }
  }
  const fullTiers = Math.floor(remainder / cfg.casesPerTier)
  const looseCases = remainder - fullTiers * cfg.casesPerTier
  return {
    total: n,
    fullPallets,
    partialPallet: { fullTiers, looseCases },
    fillRatio: remainder / cap,
  }
}


/** 棚卸用の数値分解 */
export function inventoryCounts(
  cases: number,
  cfg: PalletConfig = DEFAULT_CFG,
): StackCounts {
  const n = Math.max(0, Math.floor(cases))
  const cap = palletCapacity(cfg)
  if (n === 0) return { total: 0, totalPallets: 0, totalTiers: 0, looseCases: 0 }
  return {
    total: n,
    totalPallets: Math.ceil(n / cap),
    totalTiers: Math.ceil(n / cfg.casesPerTier),
    looseCases: n % cfg.casesPerTier,
  }
}


/** 形を「1パレ満 + 1段 + 1ケ」 という人間語に */
export function stackShapeText(cases: number, cfg: PalletConfig = DEFAULT_CFG): string {
  const s = decomposeStackShape(cases, cfg)
  if (s.total === 0) return '空'
  const parts: string[] = []
  if (s.fullPallets > 0) {
    parts.push(s.fullPallets === 1 ? '1パレ満' : `${s.fullPallets}パレ満`)
  }
  if (s.partialPallet) {
    const { fullTiers, looseCases } = s.partialPallet
    if (s.fullPallets > 0) {
      // 「+ 1段 + 1ケ」 形式
      if (fullTiers > 0) parts.push(`${fullTiers}段`)
      if (looseCases > 0) parts.push(`${looseCases}ケ`)
    } else {
      // 1パレ未満
      if (fullTiers > 0) parts.push(`${fullTiers}段`)
      if (looseCases > 0) parts.push(`${looseCases}ケ`)
    }
  }
  return parts.join(' + ')
}


/** 棚卸用の数値内訳を文字列に */
export function inventoryCountsText(cases: number, cfg: PalletConfig = DEFAULT_CFG): string {
  const c = inventoryCounts(cases, cfg)
  if (c.total === 0) return '0 ケース'
  return `${c.totalPallets}パレ · ${c.totalTiers}段 · 端 ${c.looseCases}ケ`
}


/** kg から ケース数を算出 (kg_per_case が 0/NULL なら null) */
export function kgToCases(kg: number | string | null | undefined, kgPerCase: number | string | null | undefined): number | null {
  const kpc = Number(kgPerCase)
  if (!Number.isFinite(kpc) || kpc <= 0) return null
  const k = Number(kg)
  if (!Number.isFinite(k)) return null
  return k / kpc
}


/** ロットの残量 (kg) と kg/ケース からそのまま shape を出す */
export function lotShapeFromKg(
  remainingKg: number | string | null | undefined,
  kgPerCase: number | string | null | undefined,
  cfg: PalletConfig = DEFAULT_CFG,
): StackShape | null {
  const cases = kgToCases(remainingKg, kgPerCase)
  if (cases == null) return null
  return decomposeStackShape(cases, cfg)
}


/**
 * 棚卸用 3 値入力 (P, T, C) からケース数を逆算
 *
 * ※ セマンティック 変更 (2026-05-26): 「段 = 積み切った 段 のみ」 に 統一。
 *   旧: T = 最上段 を 含む 総 段数 (= 部分段 も 1 と 数える)
 *   新: T = 完全 に 積み切った 段数 (= 部分段 は C で 表現)
 *
 *   P = 総パレット数 (部分使用中も 1 と数える, 0 OK)
 *   T = 最上 パレット内 で **積み切った** 段数 (0..tiersPerPallet)
 *   C = T の 上 の 端ケース 数 (0..casesPerTier-1)
 *
 *   N = (P-1)·casesPerTier·tiersPerPallet + T·casesPerTier + C
 *
 *   例: P=1, T=3, C=3 → N = 0 + 21 + 3 = 24 (= 3 段 完全積み + 4 段目 に 3 ケ)
 *   例: P=2, T=0, C=1 → N = 49 + 0 + 1 = 50 (= 1 パレ 満 + 次パレ の 1 ケ)
 */
export function casesFromPalletTiersLoose(
  pallets: number,
  fullTiersOnTopPallet: number,
  looseCases: number,
  cfg: PalletConfig = DEFAULT_CFG,
): number {
  const P = Math.max(0, Math.floor(pallets))
  if (P === 0) return 0
  const T = Math.max(0, Math.min(cfg.tiersPerPallet, Math.floor(fullTiersOnTopPallet)))
  const C = Math.max(0, Math.min(cfg.casesPerTier - 1, Math.floor(looseCases)))
  const fullPalletCases = (P - 1) * cfg.casesPerTier * cfg.tiersPerPallet
  return fullPalletCases + T * cfg.casesPerTier + C
}


/**
 * ケース数 → (P, T, C) 内訳 (NEW セマンティック)
 *   P = ceil(cases / 49)        — 使用中 パレット 数
 *   T = floor(remainder / 7)    — 最上 パレット内 の 積み切った 段
 *   C = remainder % 7           — その 上 の 端ケース
 *
 * 例: 24 ケース → P=1, T=3, C=3
 * 例: 49 ケース → P=1, T=7, C=0
 * 例: 50 ケース → P=2, T=0, C=1
 * 注意: T=tiersPerPallet (7) は 「最後 の パレット が ぴったり 満」 を 意味する。
 *      P を +1 する のは N > P * 49 の とき のみ。
 *
 * 旧 名 prop は `lastPalletTiers` (= 部分 段 含む) だった が、 セマンティック 変更 に
 * 伴い `fullTiersOnTopPallet` (= 積み切った 段 のみ) に 改名。 既存 caller (modal)
 * は 同名 import で 使う ため、 戻り値 key 名 は 互換性 のため `lastPalletTiers`
 * を 維持 する が、 値 は 新 セマンティック (= full tiers)。
 */
export function palletInputsFromCases(
  cases: number,
  cfg: PalletConfig = DEFAULT_CFG,
): { pallets: number; lastPalletTiers: number; lastTierCases: number } {
  const n = Math.max(0, Math.floor(cases))
  if (n === 0) return { pallets: 0, lastPalletTiers: 0, lastTierCases: 0 }
  const cap = palletCapacity(cfg)
  const P = Math.ceil(n / cap)
  const remainder = n - (P - 1) * cap       // 最上 パレット の ケース数 (1..cap)
  const T = Math.floor(remainder / cfg.casesPerTier)
  const C = remainder - T * cfg.casesPerTier
  return {
    pallets: P,
    lastPalletTiers: T,        // ← 新セマンティック: 積み切った 段 数
    lastTierCases: C,
  }
}
