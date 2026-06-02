/**
 * StatusDisplay — 読込中 / エラー表示の 共通 コンポーネント。
 *
 * 旧コード では 各ページで `<div className="muted">読み込み中…</div>` や
 * `<div className="error">{String(err)}</div>` が 散在 して 表現ブレ が
 * 起きていた (色・余白・文言)。 このモジュール に 集約する。
 *
 * 既存 className (.muted / .error) は そのまま 使用 — CSS 側を 変えれば
 * 全頁 一括 変更可能。
 */
import type { ReactNode, CSSProperties } from 'react'
import { errorText } from '../lib/format'

interface LoadingStateProps {
  /** 表示する 文言。 未指定で「読み込み中…」 */
  message?: string
  /** style 追加 (主に padding/margin) */
  style?: CSSProperties
  /** 余白 inline で 入れたい時の 簡易プロップ */
  inset?: boolean
}

export function LoadingState({ message = '読み込み中…', style, inset }: LoadingStateProps) {
  return (
    <div
      className="muted"
      style={inset ? { padding: 16, ...style } : style}
      role="status"
      aria-live="polite"
    >
      {message}
    </div>
  )
}

interface ErrorBannerProps {
  /** Error / unknown / string いずれも 受ける */
  error: unknown
  /** 上下マージン 制御 (default: 上 8px) */
  style?: CSSProperties
  /** タイトル prefix (例: "保存に失敗") */
  title?: string
}

export function ErrorBanner({ error, style, title }: ErrorBannerProps) {
  if (!error) return null
  const msg = errorText(error)
  return (
    <div
      className="error"
      style={{ marginTop: 8, ...style }}
      role="alert"
    >
      {title ? <strong>{title}: </strong> : null}
      {msg}
    </div>
  )
}

/**
 * <FetchState fetch={someUseFetchResult}>
 *   {(data) => <表示>}
 * </FetchState>
 *
 * useFetch の結果 (loading / error / data) を 一気に 扱える 補助。
 * loading 中は LoadingState、 error 時は ErrorBanner、 data ない時は null。
 */
interface FetchLike<T> {
  loading?: boolean
  error?: unknown
  data?: T | null
}

interface FetchStateProps<T> {
  fetch: FetchLike<T>
  children: (data: T) => ReactNode
  /** loading 文言 (default: "読み込み中…") */
  loadingText?: string
  /** error の prefix */
  errorTitle?: string
}

export function FetchState<T>({ fetch, children, loadingText, errorTitle }: FetchStateProps<T>) {
  if (fetch.loading && !fetch.data) return <LoadingState message={loadingText} />
  if (fetch.error) return <ErrorBanner error={fetch.error} title={errorTitle} />
  if (fetch.data == null) return null
  return <>{children(fetch.data)}</>
}
