/**
 * Combobox — 入力テキストで候補をフィルターするオートコンプリート。
 *
 * 仕様:
 *   - text-input の下にドロップダウン
 *   - 候補は items から、searchText(item) 文字列に対し部分一致 (小文字化, NFKC)
 *   - ↑↓ で選択移動、Enter で確定、Esc で閉じる
 *   - 外側クリックで閉じる
 *   - 選択された値は value (id) / 表示は label(item)
 *
 * 使用例:
 *   <Combobox
 *     items={materials}
 *     getKey={(m) => m.material_id}
 *     getLabel={(m) => `${m.code} ${m.item_name}`}
 *     getSearchText={(m) => `${m.code} ${m.item_name} ${m.supplier_name}`}
 *     value={selectedId}
 *     onChange={setSelectedId}
 *     placeholder="資材コード or 品名で検索"
 *   />
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { tokenize, matchesAllTokens } from '../lib/search'

interface Props<T> {
  items: T[]
  getKey: (item: T) => number | string
  getLabel: (item: T) => string
  /** マッチ用テキスト（複数フィールドを連結して渡す） */
  getSearchText: (item: T) => string
  value: number | string | null
  onChange: (id: number | string | null) => void
  placeholder?: string
  disabled?: boolean
  className?: string
  /** 候補上限 (大量データ対策) */
  maxResults?: number
  /**
   * 「未登録 → 新規作成」フロー:
   *   指定すると候補リストの末尾に「➕ 「{入力}」を新規作成」項目が表示される。
   *   クリック or Enter (リスト末尾選択時) で呼び出され、入力テキストを渡す。
   *   createLabel で項目ラベルをカスタマイズ可 (default: 「➕ 「{q}」を新規作成」)。
   */
  onCreateNew?: (queryText: string) => void
  createLabel?: (queryText: string) => string
  /**
   * 自由テキストモード: items に無い任意の文字列も value として受け入れる。
   *   - value は string として表示される (items に該当があれば getLabel、無ければ value 文字列をそのまま表示)
   *   - 通常は onCreateNew と組み合わせて、未登録名を直接 value にセットして使う
   *   (原料入庫の supplier/origin/spec_type のような「既存サジェスト + 新規可」フィールド用)
   */
  freeText?: boolean
  /**
   * クリア (×) ボタンを 表示 する。 value がセット されている時 のみ 表示。
   *   - クリック で onChange(null) を 呼ぶ (dropdown は 開かない)
   *   - 任意フィルター (絞り込み 系) 用。 必須選択 では false (default) のまま
   */
  clearable?: boolean
}

// 検索ロジックは ../lib/search.ts に集約。Combobox はそれを呼ぶだけ。
// 「c-5k」「Ｃー5Ｋ」が同じ、「生姜 100」がスペース AND 検索になるなどの仕様。

export default function Combobox<T>(p: Props<T>) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const maxResults = p.maxResults ?? 30

  // 現在の選択を表示するためのラベル
  const selectedItem = useMemo(
    () => p.items.find((it) => p.getKey(it) === p.value) ?? null,
    [p.items, p.value, p.getKey],
  )

  // 検索結果 — スペース区切りで複数トークン AND 検索 (順不同)
  // 例: 「生姜 100」で「中国産生姜100gピロ」がヒット (どちらの順番でもOK)
  const filtered = useMemo(() => {
    const tokens = tokenize(query)
    if (tokens.length === 0) return p.items.slice(0, maxResults)
    return p.items
      .filter((it) => matchesAllTokens(p.getSearchText(it), tokens))
      .slice(0, maxResults)
  }, [p.items, query, maxResults, p.getSearchText])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [open])

  // 開いたとき、検索ボックスにフォーカス
  // freeText モードかつ value が文字列のときは、その値をシードとして表示
  // (編集の流れがスムーズ — テキスト一部だけ修正で済む)
  useEffect(() => {
    if (open) {
      const seed = (p.freeText && p.value && !selectedItem) ? String(p.value) : ''
      setQuery(seed)
      setHighlight(0)
      setTimeout(() => {
        inputRef.current?.focus()
        // 全選択しておくと上書き入力しやすい
        if (seed) inputRef.current?.select()
      }, 10)
    }
  }, [open])

  // 「新規作成」スロットを末尾に出すかどうか:
  //   - onCreateNew が指定されている
  //   - 入力テキストが空でない (空 = 検索のみ、作成の意図無し)
  //   - 完全一致するアイテムが既存に無い (重複作成を防ぐ)
  const showCreateSlot = !!p.onCreateNew && query.trim().length > 0
    && !p.items.some((it) => p.getSearchText(it).trim() === query.trim())
  const totalRows = filtered.length + (showCreateSlot ? 1 : 0)

  function triggerCreate() {
    if (p.onCreateNew && query.trim()) {
      p.onCreateNew(query.trim())
      setOpen(false)
    }
  }

  function pickByIndex(idx: number) {
    // 末尾の「新規作成」スロット
    if (showCreateSlot && idx === filtered.length) {
      triggerCreate()
      return
    }
    const item = filtered[idx]
    if (item) {
      p.onChange(p.getKey(item))
      setOpen(false)
    }
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((h) => Math.min(totalRows - 1, h + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(0, h - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      // 候補ゼロかつ作成可能 → そのまま作成
      if (filtered.length === 0 && showCreateSlot) {
        triggerCreate()
      } else {
        pickByIndex(highlight)
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    }
  }

  return (
    <div ref={ref} className={'combobox ' + (p.className ?? '')} style={{ position: 'relative' }}>
      {!open && (
        <button
          type="button"
          className="combobox-trigger"
          onClick={() => !p.disabled && setOpen(true)}
          disabled={p.disabled}
          style={{
            display: 'block',
            width: '100%',
            textAlign: 'left',
            padding: '8px 11px',
            border: '1px solid var(--border-strong)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--input-bg)',
            color: selectedItem ? 'var(--text)' : 'var(--muted-light)',
            cursor: p.disabled ? 'not-allowed' : 'pointer',
            fontWeight: 400,
            fontSize: 'inherit',
          }}
        >
          {selectedItem
            ? p.getLabel(selectedItem)
            : (p.freeText && p.value
              ? <span style={{ color: 'var(--text)' }}>{String(p.value)}</span>
              : (p.placeholder ?? '選択してください'))}
          {p.clearable && p.value != null && p.value !== '' && !p.disabled && (
            <span
              role="button"
              aria-label="クリア"
              title="クリア"
              // button 内 nested button を 避ける ため span + stopPropagation
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation() }}
              onClick={(e) => {
                e.preventDefault(); e.stopPropagation()
                p.onChange(null)
              }}
              style={{
                float: 'right', marginRight: 6,
                color: 'var(--muted)',
                cursor: 'pointer',
                fontSize: '0.9em', lineHeight: 1,
                padding: '0 4px',
                userSelect: 'none',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLSpanElement).style.color = 'var(--danger, #DC2626)' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLSpanElement).style.color = 'var(--muted)' }}
            >✕</span>
          )}
          <span style={{ float: 'right', color: 'var(--muted)' }}>▾</span>
        </button>
      )}
      {open && (
        <>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setHighlight(0) }}
            onKeyDown={onKey}
            placeholder={p.placeholder ?? '検索…'}
            style={{ width: '100%' }}
          />
          <div className="combobox-dropdown">
            {filtered.length === 0 && !showCreateSlot && (
              <div className="combobox-empty">該当なし</div>
            )}
            {filtered.map((item, i) => (
              <div
                key={String(p.getKey(item))}
                className={'combobox-option ' + (i === highlight ? 'highlight' : '')}
                onMouseEnter={() => setHighlight(i)}
                onMouseDown={(e) => { e.preventDefault(); pickByIndex(i) }}
              >
                {p.getLabel(item)}
              </div>
            ))}
            {showCreateSlot && (
              <div
                className={'combobox-option combobox-create '
                  + (highlight === filtered.length ? 'highlight' : '')}
                onMouseEnter={() => setHighlight(filtered.length)}
                onMouseDown={(e) => { e.preventDefault(); triggerCreate() }}
                style={{
                  borderTop: filtered.length > 0 ? '1px solid var(--divider)' : undefined,
                  color: 'var(--primary)', fontWeight: 500,
                }}
              >
                {p.createLabel
                  ? p.createLabel(query.trim())
                  : `➕ 「${query.trim()}」を新規作成`}
              </div>
            )}
            {p.items.length > maxResults && filtered.length === maxResults && (
              <div className="combobox-more">
                + 候補 {p.items.length - maxResults} 件は検索で絞り込み
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
