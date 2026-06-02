import { useState } from 'react'
import Combobox from '../../components/Combobox'
import type { MaterialStock } from '../../api/types'

interface RecipeRowForAlt {
  material_id: number | null
  alternative_material_ids: number[]
}

interface Props {
  row: RecipeRowForAlt
  mainMaterial: MaterialStock | null
  candidates: MaterialStock[]
  onChange: (ids: number[]) => void
}

/** 旧 ShipmentRecipesPage.tsx の AlternativesEditor を そのまま 移植。
 *  代替資材 の 追加 + 削除 (同 カテゴリ 内 から 選択)。 */
export default function AlternativesEditor(p: Props) {
  const [adding, setAdding] = useState(false)
  const altIds = p.row.alternative_material_ids
  // 候補 = 同カテゴリ - (主資材 + 既選択代替)
  const exclude = new Set<number>([
    ...(p.row.material_id != null ? [p.row.material_id] : []),
    ...altIds,
  ])
  const available = p.candidates.filter((m) => !exclude.has(m.material_id))

  return (
    <div style={{
      marginTop: 6, padding: '4px 8px',
      background: 'var(--surface-soft, #f5f7fa)',
      borderRadius: 4, fontSize: 11,
    }}>
      <div className="inline" style={{ gap: 4, flexWrap: 'wrap' }}>
        <span className="muted">代替資材:</span>
        {altIds.length === 0 && !adding && (
          <span className="muted" style={{ fontStyle: 'italic' }}>なし</span>
        )}
        {altIds.map((aid, idx) => {
          const m = p.candidates.find((x) => x.material_id === aid)
          return (
            <span key={aid} style={{
              display: 'inline-flex', alignItems: 'center', gap: 3,
              padding: '1px 6px', borderRadius: 10,
              background: 'var(--chip-bg, #e0e7ef)',
            }}>
              <span style={{ fontWeight: 500 }}>
                #{idx + 1} {m ? `${m.code} ${m.item_name}` : `id=${aid}`}
              </span>
              <button
                type="button"
                onClick={() => p.onChange(altIds.filter((x) => x !== aid))}
                style={{
                  background: 'none', border: 'none', color: 'var(--danger)',
                  cursor: 'pointer', padding: 0, fontSize: 13, lineHeight: 1,
                }}
                title="この代替を外す"
              >×</button>
            </span>
          )
        })}
        {!adding ? (
          <button
            type="button"
            className="ghost small"
            onClick={() => setAdding(true)}
            disabled={available.length === 0}
            style={{ padding: '1px 8px', fontSize: 11 }}
            title={available.length === 0
              ? '同カテゴリに追加可能な資材がありません'
              : '代替資材を追加'}
          >＋ 追加</button>
        ) : (
          <span style={{ minWidth: 220 }}>
            <Combobox<MaterialStock>
              items={available}
              getKey={(m) => m.material_id}
              getLabel={(m) => `${m.code} ${m.item_name}`
                + (m.supplier_name && m.supplier_name !== '未指定'
                  ? ` / ${m.supplier_name}` : '')}
              getSearchText={(m) => `${m.code} ${m.item_name} ${m.supplier_name}`}
              value={null}
              onChange={(v) => {
                if (v != null) p.onChange([...altIds, v as number])
                setAdding(false)
              }}
              placeholder="代替を検索…"
              maxResults={30}
            />
          </span>
        )}
      </div>
      {p.mainMaterial && altIds.length > 0 && (
        <div className="muted" style={{ fontSize: 10, marginTop: 2 }}>
          ※ 在庫運用は主資材 (#{p.mainMaterial.code}) のみ消耗。
          旧在庫が無くなったら一覧の「↕ 昇格」で代替を主に切り替えできます。
        </div>
      )}
    </div>
  )
}
