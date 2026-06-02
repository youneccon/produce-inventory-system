/**
 * EditableText — クリック で 編集 開始、 blur or Enter で 確定、 Esc で キャンセル。
 * 印刷 用 の 集計表頁 で タイトル / 自由テキスト の 編集 に 使う。
 *
 * UX:
 *   - 非編集: 通常 テキスト として 描画。 値 が 空 なら placeholder (薄字) を 出す
 *   - hover: 薄い 下線 + 「鉛筆」 風 cursor (鉛筆 アイコン は 隣 に 小さく)
 *   - 編集中: textarea (multiline=true) or input
 *   - 確定: onChange を 呼ぶ。 値 が 変わら なければ 呼ば ない
 *   - 印刷 時: 編集 chrome 非表示 (print-hide クラス で 鉛筆 アイコン 等)
 */

import { useEffect, useRef, useState } from 'react'
import { Pencil } from 'lucide-react'

interface Props {
  value: string
  onChange: (next: string) => void
  placeholder?: string
  multiline?: boolean
  /** タグ ('h1' | 'h2' | 'h3' | 'p' | 'span'); default 'span' */
  as?: 'h1' | 'h2' | 'h3' | 'p' | 'span'
  /** 編集 不可 (= 単に 表示) */
  readOnly?: boolean
  style?: React.CSSProperties
  className?: string
  /** placeholder と 同じ「未入力 時に 印刷 で 何も 出さない」 (default true) */
  hidePlaceholderInPrint?: boolean
}

export default function EditableText({
  value, onChange, placeholder, multiline = false,
  as: Tag = 'span', readOnly = false, style, className,
  hidePlaceholderInPrint = true,
}: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)

  useEffect(() => { if (!editing) setDraft(value) }, [value, editing])
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  function commit() {
    setEditing(false)
    if (draft !== value) onChange(draft)
  }
  function cancel() {
    setEditing(false)
    setDraft(value)
  }
  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); cancel() }
    else if (e.key === 'Enter' && !multiline) { e.preventDefault(); commit() }
    else if (e.key === 'Enter' && multiline && (e.metaKey || e.ctrlKey)) {
      e.preventDefault(); commit()
    }
  }

  if (editing && !readOnly) {
    const commonStyle: React.CSSProperties = {
      width: '100%', font: 'inherit', color: 'inherit',
      background: 'var(--surface-subtle, #fff8e7)',
      border: '1px solid var(--primary)',
      borderRadius: 4, padding: '2px 6px',
      ...style,
    }
    if (multiline) {
      return (
        <textarea
          ref={inputRef as React.RefObject<HTMLTextAreaElement>}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={onKey}
          rows={Math.max(2, draft.split('\n').length)}
          style={{ ...commonStyle, resize: 'vertical' }}
        />
      )
    }
    return (
      <input
        ref={inputRef as React.RefObject<HTMLInputElement>}
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={onKey}
        style={commonStyle}
      />
    )
  }

  const isEmpty = !value || value.trim() === ''
  const displayed = isEmpty ? (placeholder ?? '') : value
  const onClick = readOnly ? undefined : () => setEditing(true)
  const baseStyle: React.CSSProperties = {
    cursor: readOnly ? 'default' : 'text',
    borderBottom: readOnly ? 'none' : '1px dashed transparent',
    transition: 'border-color 0.15s',
    padding: '1px 2px',
    color: isEmpty ? 'var(--muted)' : 'inherit',
    fontStyle: isEmpty ? 'italic' : 'normal',
    whiteSpace: multiline ? 'pre-wrap' : 'nowrap',
    ...style,
  }

  return (
    <Tag
      className={`editable-text${isEmpty && hidePlaceholderInPrint ? ' print-hide' : ''}${className ? ' ' + className : ''}`}
      style={baseStyle}
      onClick={onClick}
      onMouseEnter={(e) => { if (!readOnly) e.currentTarget.style.borderBottomColor = 'var(--border)' }}
      onMouseLeave={(e) => { e.currentTarget.style.borderBottomColor = 'transparent' }}
      title={readOnly ? undefined : 'クリックで編集'}
    >
      {displayed}
      {!readOnly && !isEmpty && (
        <Pencil size={10} strokeWidth={1.6} className="print-hide"
          style={{ marginLeft: 4, opacity: 0.3, verticalAlign: 'middle' }} />
      )}
    </Tag>
  )
}
