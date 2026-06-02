import { useEffect, useState } from 'react'
import { Shuffle, MessageSquare, MessageSquareText, Trash2 } from 'lucide-react'
import Combobox from '../../components/Combobox'
import type { MaterialStock } from '../../api/types'
import { num } from '../../lib/format'
import AlternativesEditor from './AlternativesEditor'

// アイコン ボタン 共通 スタイル
const ICON_BTN_STYLE: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 28, height: 28, padding: 0, lineHeight: 0,
  background: 'transparent', border: 'none', cursor: 'pointer',
  color: '#6b7280', borderRadius: 6,
  transition: 'background-color 0.12s ease, color 0.12s ease',
}
const ICON_BTN_DANGER: React.CSSProperties = { ...ICON_BTN_STYLE, color: '#c0322a' }

/* ===========================================================================
 * Notion 風 セル: 常 に input/select/Combobox を 描画。 普段 は 枠 無し で 表 に
 * 溶け込み、 hover で 薄青 chrome、 focus で さらに 強調。 「view → edit 変身」 は
 * ない (常 に input)。
 * =========================================================================== */

interface CategoryCellProps {
  value: string
  options: string[]
  /** 段ボール 重複 防止 用: 自分以外 の 行 が 既に 段ボール を 使って いるか */
  dampoTakenByOther: boolean
  onCommit: (next: string) => void
  /** 既存行 (= サーバー の 確定 行) では カテゴリ変更 不可 (silent data loss 防止)。 */
  readonly?: boolean
}

export function CategoryCell({ value, options, dampoTakenByOther, onCommit, readonly }: CategoryCellProps) {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])

  if (readonly) {
    return <span style={{ color: '#456', padding: '4px 6px', display: 'inline-block' }}>{value || '—'}</span>
  }

  const opts = options.filter(o => o !== '段ボール' || !dampoTakenByOther || o === value)
  return (
    <select
      className="recipe-cell-native"
      value={draft}
      onChange={e => {
        const next = e.target.value
        setDraft(next)
        if (next !== value) onCommit(next)
      }}
    >
      {!opts.includes(draft) && draft && <option value={draft}>{draft}</option>}
      {!draft && <option value="" disabled>選択…</option>}
      {opts.map(c => <option key={c} value={c}>{c}</option>)}
    </select>
  )
}

interface MaterialPickerProps {
  value: number | null
  materials: MaterialStock[]
  selectedMaterial: MaterialStock | null
  onCommit: (next: number | null) => void
}

/** 材料 選択 (Combobox の inline 表示)。 Combobox 自身 の open/close で 編集 */
export function MaterialPicker({ value, materials, selectedMaterial, onCommit }: MaterialPickerProps) {
  return (
    <Combobox<MaterialStock>
      items={materials}
      getKey={x => x.material_id}
      getLabel={x =>
        x.item_name
        + (x.supplier_name && x.supplier_name !== '未指定'
          ? ` / ${x.supplier_name}` : '')}
      getSearchText={x => `${x.code} ${x.item_name} ${x.supplier_name}`}
      value={value}
      onChange={v => onCommit(v as number | null)}
      placeholder={selectedMaterial ? selectedMaterial.item_name : '資材を選択…'}
      maxResults={50}
      className="inline-style"
    />
  )
}

interface MaterialFooterProps {
  selectedMaterial: MaterialStock | null
  alternativeIds: number[]
  altOpen: boolean
  onToggleAlt: () => void
  /** 既存 行 か pending 行 か (削除 表示 は 両方 で 出す) */
  hasMaterial: boolean
  hasComment: boolean
  onAddAlternative: () => void
  onToggleComment: () => void
  onDelete: () => void
}

/** 材料 セル 下 の 1 行: 左 = hints (1巻=Ncm / 代替N indicator)、
 *  右 = actions (+ 代替 / + コメント / 削除)。 actions は 行 hover 時 のみ 表示。 */
export function MaterialFooter({
  selectedMaterial, alternativeIds, altOpen, onToggleAlt,
  hasMaterial, hasComment, onAddAlternative, onToggleComment, onDelete,
}: MaterialFooterProps) {
  const isLengthBased = selectedMaterial?.length_per_roll_cm != null
  const hasAlt = alternativeIds.length > 0
  return (
    <div className="recipe-material-footer">
      <div className="recipe-material-hints">
        {isLengthBased && (
          <span style={{ color: '#558' }}>
            1巻 = {num(Number(selectedMaterial!.length_per_roll_cm))} cm
          </span>
        )}
        {hasAlt && (
          <span
            onClick={onToggleAlt}
            style={{ cursor: 'pointer', color: '#666' }}
            title="クリックで代替資材の編集"
          >代替{alternativeIds.length} {altOpen ? '▼' : '▶'}</span>
        )}
      </div>
      <div className="recipe-material-actions recipe-row-action"
           style={{ display: 'inline-flex', gap: 2 }}>
        {hasMaterial && !hasAlt && (
          <button type="button" onClick={onAddAlternative}
                  title="代替資材を追加" aria-label="代替を追加"
                  style={ICON_BTN_STYLE}
                  className="recipe-icon-btn">
            <Shuffle size={16} strokeWidth={1.7} />
          </button>
        )}
        {hasMaterial && (
          <button type="button" onClick={onToggleComment}
                  title={hasComment ? 'コメント編集' : 'コメントを追加'}
                  aria-label="コメント"
                  style={{ ...ICON_BTN_STYLE,
                           color: hasComment ? '#3a6dd5' : '#6b7280' }}
                  className="recipe-icon-btn">
            {hasComment
              ? <MessageSquareText size={16} strokeWidth={1.7} />
              : <MessageSquare size={16} strokeWidth={1.7} />}
          </button>
        )}
        <button type="button" onClick={onDelete}
                title="この行を削除" aria-label="削除"
                style={ICON_BTN_DANGER}
                className="recipe-icon-btn recipe-icon-btn-danger">
          <Trash2 size={16} strokeWidth={1.7} />
        </button>
      </div>
    </div>
  )
}

interface QuantityCellProps {
  value: string
  /** 表示用 単位: 長さベース なら 'cm'、 そうでなければ 材料の unit */
  unit: string | null
  /** 長さベース 資材 か (cm 入力、 step=1) */
  isLengthBased: boolean
  onCommit: (next: string) => void
}

/** 数量 セル: 整数 表示 ＋ ±1 ステッパー。
 *  ほとんど の レシピ 数量 は 1〜3 の 整数 (1 商品 あたり 何 枚 など) なので、
 *  「click → input → type → blur」 の 4 アクション を ±ボタン 1 クリック に 短縮。
 *  特殊 値 (例: 12) は 中央 の input に 直接 タイプ も 可能。
 *  既存 データ の "1.0000" など は 整数化 (Math.round) して 表示。 */
export function QuantityCell({ value, unit, isLengthBased, onCommit }: QuantityCellProps) {
  // 表示 / 編集 中 の draft (常 に 整数 文字列、 ただし 編集 中 は 任意 文字)
  const [draft, setDraft] = useState(() => formatInt(value))
  useEffect(() => { setDraft(formatInt(value)) }, [value])

  const intCurrent = Math.max(0, Math.round(Number(value) || 0))

  function bump(delta: number) {
    const next = Math.max(0, intCurrent + delta)
    const s = String(next)
    setDraft(s)
    if (s !== formatInt(value)) onCommit(s)
  }

  function commitTyped() {
    const normalized = formatInt(draft)
    setDraft(normalized)
    if (normalized !== formatInt(value)) onCommit(normalized)
  }

  return (
    <span className="recipe-quantity-stepper">
      <button
        type="button"
        className="qty-step"
        onClick={() => bump(-1)}
        disabled={intCurrent <= 0}
        title="−1"
      >−</button>
      <input
        type="number"
        className="recipe-cell-native num qty-num"
        step={isLengthBased ? '1' : '1'}
        min="0"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commitTyped}
        onKeyDown={e => {
          if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
          if (e.key === 'Escape') { setDraft(formatInt(value)); (e.currentTarget as HTMLInputElement).blur() }
        }}
      />
      <button
        type="button"
        className="qty-step"
        onClick={() => bump(+1)}
        title="+1"
      >+</button>
      <span className="qty-unit">{unit ?? ''}</span>
    </span>
  )
}

/** 文字列 数値 を 整数 文字列 へ 正規化 (空 / NaN は そのまま) */
function formatInt(v: string): string {
  if (!v || v.trim() === '') return ''
  const n = Number(v)
  if (Number.isNaN(n)) return v
  return String(Math.max(0, Math.round(n)))
}

/* ===========================================================================
 * コメント エリア (サブ 行)
 * 「+ コメント」 リンク click で 開く サブ <tr> 内 の textarea + 操作 ボタン
 * =========================================================================== */

interface CommentAreaProps {
  /** strip 済み 表示用 文字列 */
  value: string
  open: boolean
  onClose: () => void
  onCommit: (next: string) => void
}

export function CommentArea({ value, open, onClose, onCommit }: CommentAreaProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value); setEditing(false) }, [value, open])

  if (!open) return null

  if (editing) {
    return (
      <div className="recipe-comment-area" style={{ padding: '8px 12px' }}>
        <textarea
          autoFocus
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder="コメントを入力…"
        />
        <div style={{ marginTop: 6, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={() => { setEditing(false); setDraft(value) }}
            style={{ fontSize: 11, padding: '4px 10px' }}
          >キャンセル</button>
          <button
            type="button"
            className="primary"
            onClick={() => {
              if (draft !== value) onCommit(draft)
              setEditing(false)
            }}
            style={{ fontSize: 11, padding: '4px 10px' }}
          >保存</button>
          {value && (
            <button
              type="button"
              onClick={() => { onCommit(''); setEditing(false); onClose() }}
              style={{ fontSize: 11, padding: '4px 10px', color: '#c33' }}
            >コメント削除</button>
          )}
        </div>
      </div>
    )
  }
  return (
    <div className="recipe-comment-area" style={{ padding: '6px 12px' }}>
      {value ? (
        <div
          className="recipe-comment-display"
          onClick={() => setEditing(true)}
          title="クリックで編集"
        >{value}</div>
      ) : (
        <div
          className="recipe-comment-display"
          onClick={() => setEditing(true)}
          style={{ fontStyle: 'italic', color: '#789' }}
        >クリックしてコメントをどうぞ</div>
      )}
      <div style={{ marginTop: 4, textAlign: 'right' }}>
        <span
          onClick={onClose}
          style={{ fontSize: 10, color: '#789', cursor: 'pointer' }}
        >閉じる</span>
      </div>
    </div>
  )
}

/* AlternativesEditor は そのまま 別 ファイル の もの を 使う (parent が インライン
 *  展開 する) */
export { AlternativesEditor }
