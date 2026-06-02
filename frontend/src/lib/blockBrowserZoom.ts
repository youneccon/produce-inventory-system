// ブラウザのズーム機能を抑制する。アプリ内 SVG キャンバスのズームと
// 干渉してしまうのを防ぐ。
//
// 抑制対象:
//   - Ctrl + マウスホイール / トラックパッドのピンチ操作（wheel + ctrlKey）
//   - Ctrl + '+' / Ctrl + '-' / Ctrl + '='
//   - モバイルのピンチズーム（meta viewport で別途設定済）
//
// 抑制しない:
//   - Ctrl + '0'（ズームリセットは妨害しない方が安全）
//   - 通常のホイールスクロール

export function installBrowserZoomBlocker(): () => void {
  function onWheel(e: WheelEvent) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
    }
  }
  function onKey(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      if (e.key === '+' || e.key === '-' || e.key === '=') {
        e.preventDefault()
      }
    }
  }
  // wheel は passive:false で preventDefault が効くようにする
  window.addEventListener('wheel', onWheel, { passive: false })
  window.addEventListener('keydown', onKey)
  return () => {
    window.removeEventListener('wheel', onWheel)
    window.removeEventListener('keydown', onKey)
  }
}
