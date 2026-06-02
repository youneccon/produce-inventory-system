/**
 * LotCodeBadge
 * =============
 * 整理番号 (lot_code) の表示用ラッパー。 選別由来のロットに「選別」 バッジを付ける。
 *
 * 使い方:
 *   <LotCodeBadge code="01G00001" selectionId={null} />
 *   <LotCodeBadge code="02G00012" selectionId={42} />   // → "02G00012 [選別]"
 */

interface Props {
  code: string | null | undefined
  selectionId?: number | null
  /** 半製品由来ロットを示すバッジを別途追加したい場合用 (将来拡張) */
  semifinished?: boolean
  style?: React.CSSProperties
}

export default function LotCodeBadge({ code, selectionId, semifinished, style }: Props) {
  return (
    <span style={{ whiteSpace: 'nowrap', ...style }}>
      <strong>{code ?? '—'}</strong>
      {selectionId != null && (
        <span
          title={`選別由来 (selection_id=${selectionId})`}
          style={{
            display: 'inline-block',
            marginLeft: 6,
            padding: '1px 6px',
            fontSize: 10,
            fontWeight: 700,
            color: '#fff',
            background: 'var(--primary, #1a73e8)',
            borderRadius: 3,
            verticalAlign: 'middle',
            lineHeight: 1.4,
          }}
        >選別</span>
      )}
      {semifinished && (
        <span
          title="半製品"
          style={{
            display: 'inline-block',
            marginLeft: 4,
            padding: '1px 6px',
            fontSize: 10,
            fontWeight: 700,
            color: '#fff',
            background: 'var(--warning, #f5a623)',
            borderRadius: 3,
            verticalAlign: 'middle',
            lineHeight: 1.4,
          }}
        >半製品</span>
      )}
    </span>
  )
}
