/**
 * printMode — PDF 出力 (印刷) 時に一時的な「PDF 出力モード」を有効化するヘルパー。
 *
 * 業務フローとしては「ブラウザの印刷ダイアログから『PDF として保存』を選ぶ」ので、
 * 機能名としては印刷だが UI 上は「PDF 出力」と呼んでいる。
 *
 * 使い方:
 *   const { isPrintMode, startPrint } = usePrintMode()
 *   <button onClick={startPrint}>📄 PDF出力</button>
 *   const cols = isPrintMode ? pdfCols : screenCols
 *
 * 仕組み:
 *   1. startPrint() を呼ぶと state を true にし、再描画させてから window.print() を発火
 *   2. afterprint イベント or 一定時間経過で state を false に戻す
 *   3. @media print の CSS と組み合わせて UI クロームを非表示にする
 */
import { useEffect, useState } from 'react'

export function usePrintMode() {
  const [isPrintMode, setIsPrintMode] = useState(false)

  useEffect(() => {
    if (!isPrintMode) return
    // React の再描画を待ってから印刷ダイアログを開く
    const t = setTimeout(() => {
      window.print()
    }, 50)
    // ダイアログが閉じたら印刷モードを解除
    const onAfter = () => setIsPrintMode(false)
    window.addEventListener('afterprint', onAfter)
    return () => {
      clearTimeout(t)
      window.removeEventListener('afterprint', onAfter)
    }
  }, [isPrintMode])

  return {
    isPrintMode,
    startPrint: () => setIsPrintMode(true),
    cancelPrint: () => setIsPrintMode(false),
  }
}
