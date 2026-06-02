/**
 * haptic.ts — モバイル / iPad 用 軽量触覚 フィードバック ヘルパ
 *
 * 使用方針:
 *   - Web Vibration API は Android Chrome で動く (iOS Safari は無音)
 *   - iOS 17.4+ の Safari は <input type="range"> 等で limited haptics をサポート
 *   - 多くの iPad ユーザーには「視覚 フィードバック」 が主で、 触覚は補助
 *   - ここでは Vibration API を試し、 失敗時は noop
 *
 * 使い分け:
 *   - haptic.tap()    — 軽いタップ確認 (10ms)
 *   - haptic.select() — 選択完了 (15ms)
 *   - haptic.success() — 操作成功 (短-長 パルス)
 *   - haptic.error()   — エラー (3 連短パルス)
 */

const supported = typeof navigator !== 'undefined' && 'vibrate' in navigator

function safeVibrate(pattern: number | number[]): boolean {
  if (!supported) return false
  try {
    return (navigator as Navigator & { vibrate: (p: number | number[]) => boolean })
      .vibrate(pattern)
  } catch {
    return false
  }
}

export const haptic = {
  /** ボタンタップ確認 (10ms) — 軽いフィードバック */
  tap: () => safeVibrate(10),
  /** オブジェクト選択 / 移動完了 (15ms) */
  select: () => safeVibrate(15),
  /** 操作成功 (短い 2 連パルス) */
  success: () => safeVibrate([15, 40, 25]),
  /** エラー / 警告 (3 連) */
  error: () => safeVibrate([40, 60, 40, 60, 40]),
}
