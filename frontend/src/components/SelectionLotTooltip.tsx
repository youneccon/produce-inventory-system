/**
 * SelectionLotTooltip — 選別由来ロットのバッジ ホバー時の リッチツールチップ。
 *
 * 整理番号バッジ にホバー した時に、 lazy で /selection/lot/{id}/source-info を
 * 取得し、 投入元ロット明細 (lot_code, supplier, origin, source_kg, consume_kg, disposal_kg)
 * を表示する。
 *
 * 使い方:
 *   <SelectionLotTooltip lotId={lot.lot_id}>
 *     <LotCodeBadge code={lot.lot_code} selectionId={lot.selection_id} />
 *   </SelectionLotTooltip>
 *
 * もう一段抽象化: SelectionInfoChip (短い「複数」 ラベル) でも同じデータを使う。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from '../api/client'
import { yen, ymd } from '../lib/format'
import type { SelectionSourceInfo } from '../api/types'

interface Props {
  lotId: number
  children: ReactNode
}

export default function SelectionLotTooltip({ lotId, children }: Props) {
  const [open, setOpen] = useState(false)
  const [info, setInfo] = useState<SelectionSourceInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cacheRef = useRef<Map<number, SelectionSourceInfo>>(new Map())

  useEffect(() => {
    if (!open || info) return
    const cached = cacheRef.current.get(lotId)
    if (cached) { setInfo(cached); return }
    setLoading(true)
    setError(null)
    api.get<SelectionSourceInfo>(`/selection/lot/${lotId}/source-info`)
      .then((r) => {
        cacheRef.current.set(lotId, r)
        setInfo(r)
      })
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setLoading(false))
  }, [open, lotId, info])

  return (
    <span
      style={{ position: 'relative', display: 'inline-block' }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      {children}
      {open && (
        <div
          role="tooltip"
          style={{
            position: 'absolute', top: 'calc(100% + 6px)', left: 0,
            zIndex: 500,
            minWidth: 280, maxWidth: 420,
            background: 'var(--panel, #fff)',
            border: '1px solid var(--border-strong, #999)',
            borderRadius: 6,
            padding: 10,
            boxShadow: '0 4px 12px rgba(20, 18, 14, 0.12)',
            fontSize: 11, lineHeight: 1.4,
            color: 'var(--text)',
            pointerEvents: 'none',
          }}
        >
          {loading && <div className="muted">読み込み中…</div>}
          {error && <div style={{ color: 'var(--danger)' }}>{error}</div>}
          {info && (
            <>
              <div style={{
                fontWeight: 700, color: 'var(--primary, #1F4E79)',
                marginBottom: 6, fontSize: 12,
              }}>
                {info.selection_code} ({ymd(info.selection_date)})
              </div>
              <div style={{ marginBottom: 6 }}>
                加重平均単価:{' '}
                <strong>
                  {info.weighted_unit_price
                    ? `${yen(info.weighted_unit_price)}/kg` : '—'}
                </strong>
              </div>
              <div style={{
                fontSize: 10, color: 'var(--muted)',
                marginBottom: 3, fontWeight: 600,
              }}>投入元 ({info.sources.length} ロット)</div>
              <table style={{ width: '100%', fontSize: 10, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    <th style={{ textAlign: 'left', padding: '2px 4px' }}>整理番号</th>
                    <th style={{ textAlign: 'left', padding: '2px 4px' }}>仕入先 / 産地</th>
                    <th style={{ textAlign: 'right', padding: '2px 4px' }}>投入</th>
                    <th style={{ textAlign: 'right', padding: '2px 4px' }}>有効</th>
                    <th style={{ textAlign: 'right', padding: '2px 4px' }}>ロス</th>
                  </tr>
                </thead>
                <tbody>
                  {info.sources.map((s, i) => (
                    <tr key={i}>
                      <td style={{ padding: '2px 4px', whiteSpace: 'nowrap' }}>
                        <code>{s.lot_code}</code>
                      </td>
                      <td style={{ padding: '2px 4px', whiteSpace: 'nowrap' }}>
                        {s.supplier_name} / {s.origin_name}
                      </td>
                      <td style={{ padding: '2px 4px', textAlign: 'right',
                                   fontVariantNumeric: 'tabular-nums' }}>
                        {Number(s.source_kg).toFixed(1)}
                      </td>
                      <td style={{ padding: '2px 4px', textAlign: 'right',
                                   fontVariantNumeric: 'tabular-nums' }}>
                        {Number(s.consume_kg).toFixed(1)}
                      </td>
                      <td style={{ padding: '2px 4px', textAlign: 'right',
                                   fontVariantNumeric: 'tabular-nums',
                                   color: 'var(--muted)' }}>
                        {Number(s.disposal_kg).toFixed(1)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
    </span>
  )
}
