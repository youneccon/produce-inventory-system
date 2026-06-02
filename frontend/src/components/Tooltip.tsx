/**
 * Tooltip
 * =======
 * claude.ai 風 ダークポップオーバー — ホバー/フォーカスで child の下に説明文を表示。
 *
 * 使い方:
 *   <Tooltip content="新しい紐付けを追加">
 *     <button><Plus /></button>
 *   </Tooltip>
 *
 * - 暗色背景 (light/dark mode 共通で暗色 → claude.ai と同じ挙動)
 * - delay 400ms (ホバーが偶然のときは出さない)
 * - 矢印無し、 fade in アニメーション
 * - 横幅は内容に合わせて auto、 max-width で長文時は折り返し
 */
import { useEffect, useRef, useState, cloneElement, type ReactElement, type ReactNode } from 'react'

interface Props {
  content: ReactNode
  children: ReactElement
  /** 表示位置 (default = bottom) */
  side?: 'top' | 'bottom' | 'left' | 'right'
  /** ホバー後の表示 delay (ms, default 400) */
  delay?: number
  /** 強制的に non-interactive にする (例: disabled button をラップする時 wrapper を <span> にしたい) */
  asChild?: boolean
}

export default function Tooltip({ content, children, side = 'bottom', delay = 400, asChild = false }: Props) {
  const [visible, setVisible] = useState(false)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  const timerRef = useRef<number | null>(null)

  function compute() {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const gap = 8
    let x = r.left + r.width / 2
    let y = r.bottom + gap
    if (side === 'top') { y = r.top - gap }
    if (side === 'left') { x = r.left - gap; y = r.top + r.height / 2 }
    if (side === 'right') { x = r.right + gap; y = r.top + r.height / 2 }
    setPos({ x, y })
  }

  function show() {
    if (timerRef.current) return
    timerRef.current = window.setTimeout(() => {
      compute()
      setVisible(true)
      timerRef.current = null
    }, delay)
  }
  function hide() {
    if (timerRef.current) { window.clearTimeout(timerRef.current); timerRef.current = null }
    setVisible(false)
  }

  useEffect(() => () => { if (timerRef.current) window.clearTimeout(timerRef.current) }, [])

  // タッチ用 長押し state (iPad など hover が無い環境で tooltip を呼び出す)
  const longPressTimerRef = useRef<number | null>(null)
  const touchPosRef = useRef<{ x: number; y: number } | null>(null)
  function showFromTouch() {
    compute()
    setVisible(true)
  }
  function startLongPress(e: { clientX?: number; clientY?: number; touches?: { clientX: number; clientY: number }[] }) {
    const cx = e.clientX ?? e.touches?.[0]?.clientX ?? 0
    const cy = e.clientY ?? e.touches?.[0]?.clientY ?? 0
    touchPosRef.current = { x: cx, y: cy }
    if (longPressTimerRef.current) window.clearTimeout(longPressTimerRef.current)
    // 500ms ホールドで表示。 タップで離す or 動かすとキャンセル
    longPressTimerRef.current = window.setTimeout(() => {
      showFromTouch()
      longPressTimerRef.current = null
    }, 500)
  }
  function cancelLongPress() {
    if (longPressTimerRef.current) { window.clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null }
    // 表示中であれば短い時間後に隠す (タッチで読みたい時間を確保)
    if (visible) {
      window.setTimeout(() => setVisible(false), 1500)
    }
  }
  function handleTouchMove(e: { touches?: { clientX: number; clientY: number }[] }) {
    if (!touchPosRef.current) return
    const t = e.touches?.[0]
    if (!t) return
    const dx = t.clientX - touchPosRef.current.x
    const dy = t.clientY - touchPosRef.current.y
    if (dx * dx + dy * dy > 100) {  // 10px 以上動いたらキャンセル
      if (longPressTimerRef.current) { window.clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null }
      setVisible(false)
    }
  }

  useEffect(() => () => {
    if (longPressTimerRef.current) window.clearTimeout(longPressTimerRef.current)
  }, [])

  // 子要素にイベントを付与
  const trigger = cloneElement(children, {
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node
      const original = (children as ReactElement & { ref?: unknown }).ref
      if (typeof original === 'function') original(node)
      else if (original && typeof original === 'object' && 'current' in original) {
        ;(original as { current: HTMLElement | null }).current = node
      }
    },
    onMouseEnter: (e: unknown) => {
      show()
      const orig = (children.props as { onMouseEnter?: (e: unknown) => void }).onMouseEnter
      if (typeof orig === 'function') orig(e)
    },
    onMouseLeave: (e: unknown) => {
      hide()
      const orig = (children.props as { onMouseLeave?: (e: unknown) => void }).onMouseLeave
      if (typeof orig === 'function') orig(e)
    },
    onFocus: (e: unknown) => {
      show()
      const orig = (children.props as { onFocus?: (e: unknown) => void }).onFocus
      if (typeof orig === 'function') orig(e)
    },
    onBlur: (e: unknown) => {
      hide()
      const orig = (children.props as { onBlur?: (e: unknown) => void }).onBlur
      if (typeof orig === 'function') orig(e)
    },
    // タッチ: 500ms ホールドで tooltip 表示、 タップ/移動で キャンセル
    onTouchStart: (e: unknown) => {
      startLongPress(e as { touches: { clientX: number; clientY: number }[] })
      const orig = (children.props as { onTouchStart?: (e: unknown) => void }).onTouchStart
      if (typeof orig === 'function') orig(e)
    },
    onTouchMove: (e: unknown) => {
      handleTouchMove(e as { touches: { clientX: number; clientY: number }[] })
      const orig = (children.props as { onTouchMove?: (e: unknown) => void }).onTouchMove
      if (typeof orig === 'function') orig(e)
    },
    onTouchEnd: (e: unknown) => {
      cancelLongPress()
      const orig = (children.props as { onTouchEnd?: (e: unknown) => void }).onTouchEnd
      if (typeof orig === 'function') orig(e)
    },
    onTouchCancel: (e: unknown) => {
      cancelLongPress()
      const orig = (children.props as { onTouchCancel?: (e: unknown) => void }).onTouchCancel
      if (typeof orig === 'function') orig(e)
    },
  } as Record<string, unknown>)

  // asChild=true でも今は子要素そのままで返す (props 経由付与のため変わらない)
  void asChild

  return (
    <>
      {trigger}
      {visible && pos && (
        <div
          role="tooltip"
          style={{
            position: 'fixed',
            left: pos.x,
            top: pos.y,
            transform:
              side === 'top'    ? 'translate(-50%, -100%)' :
              side === 'bottom' ? 'translate(-50%, 0)' :
              side === 'left'   ? 'translate(-100%, -50%)' :
                                  'translate(0, -50%)',
            zIndex: 9999,
            pointerEvents: 'none',
            background: 'var(--tooltip-bg, #2D2A24)',
            color: 'var(--tooltip-fg, #FAF9F5)',
            fontSize: 12,
            lineHeight: 1.4,
            padding: '6px 10px',
            borderRadius: 8,
            maxWidth: 280,
            boxShadow: '0 4px 12px rgba(0,0,0,0.15), 0 1px 3px rgba(0,0,0,0.1)',
            animation: 'tooltipFadeIn 120ms ease-out',
            whiteSpace: 'normal',
            fontWeight: 500,
            letterSpacing: '0.005em',
          }}
        >
          {content}
        </div>
      )}
    </>
  )
}
