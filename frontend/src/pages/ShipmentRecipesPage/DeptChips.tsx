import type React from 'react'
import { Building2 } from 'lucide-react'

interface Props {
  overrideDeptCodes: string[]
  /** 既存 部署 リスト (オーバーライド を まだ 持たない もの を 追加 する 時 の 選択肢) */
  knownDeptCodes: string[]
  selectedDept: string  // '' = 全部署
  onSelect: (dept: string) => void
  onAddOverride: (dept: string) => Promise<void> | void
}

/** 商品 LEFT セル 内 の 部署別 指定 切替。
 *
 *  引き算 設計:
 *  - override 0 件 → 「+ 部署別 指定 を 追加」 の 控えめ テキスト のみ
 *  - override 1 件 以上 → タブ風 (全部署 / 部署X …) で 切替、 + 追加 リンク も
 *  - バッジ (背景 色 付き 丸) は 使わ ず、 アクティブ は 下線 + 太字 で 示す */
export default function DeptChips({
  overrideDeptCodes, knownDeptCodes, selectedDept, onSelect, onAddOverride,
}: Props) {
  const addable = knownDeptCodes.filter(d => !overrideDeptCodes.includes(d))
  const hasOverride = overrideDeptCodes.length > 0

  function handleAdd(e: React.MouseEvent) {
    e.stopPropagation()
    if (addable.length === 0) {
      window.alert('追加 可能 な 部署 が ありません')
      return
    }
    const choice = window.prompt(
      `部署 を 選んで ください:\n${addable.join('\n')}`,
      addable[0],
    )
    if (choice && addable.includes(choice)) {
      onAddOverride(choice)
    }
  }

  const addLink = (
    <button type="button" onClick={handleAdd}
      title="部署別 の 指定 を 追加 (この 商品 の 特定 部署 向け レシピ override)"
      aria-label="部署別指定を追加"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '4px 8px', fontSize: 11,
        background: '#fffaf0', color: '#a06400',
        border: '1px solid #f0d9b5', borderRadius: 14,
        cursor: 'pointer',
      }}
    >
      <Building2 size={12} strokeWidth={1.8} /> 部署別
    </button>
  )

  if (!hasOverride) {
    // override が 無い 既定 状態 — 静か に 追加 リンク だけ
    return (
      <div onClick={e => e.stopPropagation()} style={{ fontSize: 11 }}>
        {addLink}
      </div>
    )
  }

  // override 1 件 以上 — タブ風 に 切替
  function tabStyle(active: boolean): React.CSSProperties {
    return {
      display: 'inline-block',
      padding: '2px 6px',
      marginRight: 8,
      fontSize: 12,
      cursor: 'pointer',
      color: active ? '#222' : '#789',
      fontWeight: active ? 600 : 400,
      borderBottom: active ? '2px solid #d49000' : '2px solid transparent',
      userSelect: 'none',
    }
  }

  return (
    <div
      onClick={e => e.stopPropagation()}
      style={{
        fontSize: 11,
        display: 'flex', alignItems: 'baseline',
        flexWrap: 'wrap', gap: 4,
      }}
    >
      <span
        style={tabStyle(selectedDept === '')}
        onClick={() => onSelect('')}
      >全部署</span>
      {overrideDeptCodes.map(d => (
        <span
          key={d}
          style={tabStyle(selectedDept === d)}
          onClick={() => onSelect(d)}
        >部署{d}</span>
      ))}
      <span style={{ marginLeft: 8 }}>{addLink}</span>
    </div>
  )
}
