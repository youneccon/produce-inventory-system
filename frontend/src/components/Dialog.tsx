/**
 * Dialog — ブラウザ既定の window.confirm / window.alert の代替。
 *
 * 使い方:
 *   const dialog = useDialog()
 *   if (!(await dialog.confirm({ message: '本当に削除しますか?' }))) return
 *   await dialog.alert({ message: '完了しました' })
 *
 * 旧 confirm() 移行マッピング:
 *   confirm(msg)          → await dialog.confirm({ message: msg })
 *   alert(msg)            → await dialog.alert({ message: msg })
 *
 * 提供される UI:
 *   - 中央モーダル、半透明オーバーレイ
 *   - Esc キーで「キャンセル」、Enter で「OK」
 *   - 危険操作向け variant ('danger') で OK ボタンを赤
 *   - title / message / okLabel / cancelLabel / variant を指定可能
 */
import {
  createContext, useCallback, useContext, useEffect,
  useRef, useState, type ReactNode,
} from 'react'
import { haptic } from '../lib/haptic'

export type DialogVariant = 'default' | 'danger' | 'warn'

export interface ConfirmOptions {
  title?: string
  message: string | ReactNode
  okLabel?: string
  cancelLabel?: string
  variant?: DialogVariant
}

export interface AlertOptions {
  title?: string
  message: string | ReactNode
  okLabel?: string
  variant?: DialogVariant
}

export interface PromptOptions {
  title?: string
  message: string | ReactNode
  defaultValue?: string
  placeholder?: string
  inputType?: 'text' | 'date' | 'number'
  okLabel?: string
  cancelLabel?: string
  variant?: DialogVariant
  /** 入力検証。 falsy を返せば OK 可、 string ならエラー表示 */
  validate?: (value: string) => string | null | undefined
}

interface DialogState {
  open: boolean
  kind: 'confirm' | 'alert' | 'prompt'
  title?: string
  message: string | ReactNode
  okLabel: string
  cancelLabel: string
  variant: DialogVariant
  // prompt 用
  inputType?: 'text' | 'date' | 'number'
  inputValue?: string
  placeholder?: string
  validate?: (value: string) => string | null | undefined
  resolve?: (v: any) => void
}

interface DialogContextValue {
  confirm: (opts: ConfirmOptions) => Promise<boolean>
  alert: (opts: AlertOptions) => Promise<void>
  /** OK で値を返す。 キャンセル時は null */
  prompt: (opts: PromptOptions) => Promise<string | null>
}

const DialogContext = createContext<DialogContextValue | null>(null)

export function useDialog(): DialogContextValue {
  const ctx = useContext(DialogContext)
  if (!ctx) {
    // 安全フォールバック (Provider 未配置時): ネイティブにフォールバック
    // 本番ではここに到達しない設計
    return {
      confirm: async (o) => window.confirm(typeof o.message === 'string' ? o.message : '確認'),
      alert: async (o) => { window.alert(typeof o.message === 'string' ? o.message : ''); },
      prompt: async (o) => window.prompt(typeof o.message === 'string' ? o.message : '', o.defaultValue ?? ''),
    }
  }
  return ctx
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DialogState>({
    open: false, kind: 'alert',
    message: '', okLabel: 'OK', cancelLabel: 'キャンセル', variant: 'default',
  })
  const okBtnRef = useRef<HTMLButtonElement>(null)

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      setState({
        open: true, kind: 'confirm',
        title: opts.title,
        message: opts.message,
        okLabel: opts.okLabel ?? 'OK',
        cancelLabel: opts.cancelLabel ?? 'キャンセル',
        variant: opts.variant ?? 'default',
        resolve,
      })
    })
  }, [])

  const alertFn = useCallback((opts: AlertOptions): Promise<void> => {
    return new Promise<void>((resolve) => {
      setState({
        open: true, kind: 'alert',
        title: opts.title,
        message: opts.message,
        okLabel: opts.okLabel ?? 'OK',
        cancelLabel: '',
        variant: opts.variant ?? 'default',
        resolve: () => resolve(),
      })
    })
  }, [])

  const promptFn = useCallback((opts: PromptOptions): Promise<string | null> => {
    return new Promise<string | null>((resolve) => {
      setState({
        open: true, kind: 'prompt',
        title: opts.title,
        message: opts.message,
        okLabel: opts.okLabel ?? 'OK',
        cancelLabel: opts.cancelLabel ?? 'キャンセル',
        variant: opts.variant ?? 'default',
        inputType: opts.inputType ?? 'text',
        inputValue: opts.defaultValue ?? '',
        placeholder: opts.placeholder,
        validate: opts.validate,
        resolve: (v: string | null) => resolve(v),
      })
    })
  }, [])

  const [promptError, setPromptError] = useState<string | null>(null)

  const close = useCallback((result: boolean) => {
    // ハプティック: OK は軽め、 cancel は微小 (variant=danger なら警告強度)
    setState((s) => {
      // prompt: OK → 値を返す + 検証, Cancel → null
      if (s.kind === 'prompt') {
        if (result) {
          const v = s.inputValue ?? ''
          const err = s.validate?.(v)
          if (err) {
            setPromptError(err)
            return s   // 閉じない
          }
          haptic.tap()
          s.resolve?.(v)
        } else {
          haptic.tap()
          s.resolve?.(null)
        }
        setPromptError(null)
        return { ...s, open: false, resolve: undefined }
      }
      // confirm / alert
      if (result) {
        if (s.variant === 'danger') haptic.error()
        else if (s.variant === 'warn') haptic.select()
        else haptic.tap()
      } else {
        haptic.tap()
      }
      s.resolve?.(result)
      return { ...s, open: false, resolve: undefined }
    })
  }, [])

  // Focus the OK button when dialog opens
  useEffect(() => {
    if (state.open) {
      setTimeout(() => okBtnRef.current?.focus(), 50)
    }
  }, [state.open])

  // Esc / Enter ハンドラ
  useEffect(() => {
    if (!state.open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        // confirm はキャンセル扱い、alert は OK 扱い (Esc で閉じれる)
        close(state.kind === 'alert')
      } else if (e.key === 'Enter') {
        // テキスト入力中などは無視
        const t = e.target as HTMLElement | null
        if (t?.tagName === 'TEXTAREA') return
        e.preventDefault()
        close(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state.open, state.kind, close])

  const okBtnBg =
    state.variant === 'danger' ? 'var(--danger, #c8362d)'
    : state.variant === 'warn' ? 'var(--warn, #c99744)'
    : 'var(--primary, #1F4E79)'
  const iconChar =
    state.variant === 'danger' ? '⚠'
    : state.variant === 'warn'  ? '!'
    : 'i'
  const iconColor =
    state.variant === 'danger' ? '#c8362d'
    : state.variant === 'warn' ? '#c99744'
    : '#1F4E79'

  return (
    <DialogContext.Provider value={{ confirm, alert: alertFn, prompt: promptFn }}>
      {children}
      {state.open && (
        <div
          role="dialog" aria-modal="true"
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            background: 'rgba(20, 18, 14, 0.42)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 20,
            animation: 'dialog-fade-in 0.12s ease-out',
          }}
          onClick={(e) => {
            // 背景クリックでキャンセル相当 (alert は OK)
            if (e.target === e.currentTarget) close(state.kind === 'alert')
          }}
        >
          <div
            style={{
              background: 'var(--panel, #fff)',
              color: 'var(--text, #1f1e1b)',
              border: '1px solid var(--border, #d7d3c4)',
              borderRadius: 8,
              boxShadow: '0 12px 48px rgba(20, 18, 14, 0.22)',
              minWidth: 360, maxWidth: 480,
              padding: '20px 22px 16px',
              animation: 'dialog-pop-in 0.16s cubic-bezier(.16,.84,.4,1)',
            }}
          >
            {/* ヘッダ: アイコン + タイトル */}
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 10 }}>
              <div style={{
                width: 28, height: 28, borderRadius: '50%',
                background: iconColor + '22',
                color: iconColor,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontWeight: 700, fontSize: 14,
                flexShrink: 0,
              }}>
                {iconChar}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                {state.title && (
                  <div style={{
                    fontSize: 15, fontWeight: 600,
                    color: 'var(--text)',
                    marginBottom: 4,
                  }}>{state.title}</div>
                )}
                <div style={{
                  fontSize: 13, lineHeight: 1.55,
                  color: state.title ? 'var(--muted, #5C5644)' : 'var(--text)',
                  whiteSpace: 'pre-wrap',
                }}>
                  {state.message}
                </div>
                {/* prompt 入力欄 */}
                {state.kind === 'prompt' && (
                  <div style={{ marginTop: 10 }}>
                    <input
                      type={state.inputType ?? 'text'}
                      value={state.inputValue ?? ''}
                      onChange={(e) => {
                        const v = e.target.value
                        setState((s) => ({ ...s, inputValue: v }))
                        if (promptError) setPromptError(null)
                      }}
                      autoFocus
                      placeholder={state.placeholder}
                      style={{
                        width: '100%', boxSizing: 'border-box',
                        padding: '6px 10px',
                        fontSize: 14,
                        border: '1px solid var(--border, #d7d3c4)',
                        borderRadius: 4,
                        background: 'var(--panel, #fff)',
                        color: 'var(--text)',
                        fontFamily: 'inherit',
                      }}
                    />
                    {promptError && (
                      <div style={{
                        marginTop: 4, fontSize: 12,
                        color: 'var(--danger, #c8362d)',
                      }}>{promptError}</div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* ボタン行 */}
            <div style={{
              display: 'flex', justifyContent: 'flex-end',
              gap: 8, marginTop: 16,
            }}>
              {(state.kind === 'confirm' || state.kind === 'prompt') && (
                <button
                  type="button"
                  onClick={() => close(false)}
                  style={{
                    padding: '7px 16px',
                    background: 'transparent',
                    border: '1px solid var(--border, #d7d3c4)',
                    color: 'var(--text, #1f1e1b)',
                    borderRadius: 5,
                    fontSize: 13, cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  {state.cancelLabel}
                </button>
              )}
              <button
                ref={okBtnRef}
                type="button"
                onClick={() => close(true)}
                style={{
                  padding: '7px 18px',
                  background: okBtnBg,
                  border: 'none',
                  color: '#fff',
                  borderRadius: 5,
                  fontSize: 13, fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.12)',
                }}
              >
                {state.okLabel}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes dialog-fade-in {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes dialog-pop-in {
          from { opacity: 0; transform: translateY(8px) scale(0.96); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </DialogContext.Provider>
  )
}
