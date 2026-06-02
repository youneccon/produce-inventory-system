/**
 * SemifinishedRegisterModal — 半製品レイアウトのオブジェクトに対する 「棚卸登録」 モーダル。
 *
 * 機能:
 *   - 既登録の半製品 (このオブジェクトに紐づく) を一覧表示
 *   - 新規登録 = 出庫レコードを 1 つ選択 → 数量入力 → 半製品作成 + storage_object_items 追加
 *   - 削除 = 解除 (storage_object_items から外す。 半製品ロット自体は残す)
 *
 * 出庫候補: /semifinished/source-outbounds (未登録 + purpose='normal' のみ)
 */
import { useState, useMemo } from 'react'
import { X, Plus, Trash2, Search } from 'lucide-react'
import { api } from '../api/client'
import { useFetch } from '../lib/useFetch'
import { useDialog } from './Dialog'
import { errorText, num, ymd, yen } from '../lib/format'
import { tokenize, matchesAllTokens } from '../lib/search'
import type {
  SemifinishedSourceOutbound, SemifinishedStock,
} from '../api/types'

interface ExistingLink {
  id: number
  semifinished_lot_id: number
  code: string
  base_kg: string
  spec_type: string
  grade_level: string
  size_label: string
  origin_name: string
  status: string
}

interface Props {
  objectId: number
  objectLabel: string
  cropId?: number
  /** 現在オブジェクトに紐付いている半製品ロット (オブジェクト state から渡す) */
  existingLinks: ExistingLink[]
  onClose: () => void
  onChanged: () => void
}

const STATUS_LABEL: Record<string, string> = {
  pending: '処理待ち', sorting: '選別中', soaking: '浸漬中', washing: '洗い中',
}

export default function SemifinishedRegisterModal({
  objectId, objectLabel, cropId, existingLinks, onClose, onChanged,
}: Props) {
  const dialog = useDialog()
  const [tab, setTab] = useState<'add' | 'existing'>(
    existingLinks.length > 0 ? 'existing' : 'add')

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(20,18,14,0.42)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 1000, padding: 20,
    }} onClick={onClose}>
      <div style={{
        background: 'var(--panel)', borderRadius: 8,
        width: 720, maxWidth: '95vw', maxHeight: '85vh',
        display: 'flex', flexDirection: 'column',
        border: '1px solid var(--border)',
        boxShadow: '0 12px 48px rgba(0,0,0,0.22)',
      }} onClick={(e) => e.stopPropagation()}>
        {/* ヘッダ */}
        <div style={{
          padding: '12px 16px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>半製品 棚卸登録</div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>{objectLabel}</div>
          </div>
          <button onClick={onClose} className="ghost small"
            style={{ padding: 6, color: 'var(--muted)' }}><X size={14} /></button>
        </div>

        {/* タブ */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--border)' }}>
          <button onClick={() => setTab('existing')}
            style={{
              flex: 1, padding: '8px 12px', background: 'transparent',
              border: 'none', borderBottom: tab === 'existing'
                ? '2px solid var(--primary)' : '2px solid transparent',
              color: tab === 'existing' ? 'var(--primary)' : 'var(--muted)',
              fontWeight: tab === 'existing' ? 600 : 400,
              cursor: 'pointer', fontSize: 12,
            }}>
            登録済 ({existingLinks.length})
          </button>
          <button onClick={() => setTab('add')}
            style={{
              flex: 1, padding: '8px 12px', background: 'transparent',
              border: 'none', borderBottom: tab === 'add'
                ? '2px solid var(--primary)' : '2px solid transparent',
              color: tab === 'add' ? 'var(--primary)' : 'var(--muted)',
              fontWeight: tab === 'add' ? 600 : 400,
              cursor: 'pointer', fontSize: 12,
            }}>
            <Plus size={12} style={{ verticalAlign: 'middle' }} /> 新規 棚卸登録
          </button>
        </div>

        {tab === 'existing' && (
          <ExistingPanel
            links={existingLinks}
            onUnlink={async (linkId, label) => {
              if (!(await dialog.confirm({
                title: '紐付けを解除',
                message: `${label} をこのオブジェクトから外します。\n半製品ロット自体は残ります (半製品台帳で削除可能)。`,
                okLabel: '解除',
              }))) return
              try {
                await api.delete(`/storage/items/${linkId}`)
                onChanged()
              } catch (e) {
                await dialog.alert({
                  title: '紐付け解除に失敗',
                  message: errorText(e),
                  variant: 'danger',
                })
              }
            }}
          />
        )}

        {tab === 'add' && (
          <AddPanel
            objectId={objectId}
            cropId={cropId}
            onCreated={() => {
              onChanged()
              setTab('existing')
            }}
          />
        )}
      </div>
    </div>
  )
}

function ExistingPanel({ links, onUnlink }: {
  links: ExistingLink[]
  onUnlink: (linkId: number, label: string) => void
}) {
  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
      {links.length === 0 ? (
        <div className="muted" style={{ textAlign: 'center', padding: 30, fontSize: 12 }}>
          まだ何も登録されていません。 「新規棚卸登録」 タブから追加してください。
        </div>
      ) : (
        <table style={{ width: '100%', fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              <th style={{ textAlign: 'left', padding: 6 }}>整理番号</th>
              <th style={{ textAlign: 'left', padding: 6 }}>規格 / 産地</th>
              <th style={{ textAlign: 'right', padding: 6 }}>数量</th>
              <th style={{ textAlign: 'left', padding: 6 }}>状態</th>
              <th style={{ padding: 6 }}></th>
            </tr>
          </thead>
          <tbody>
            {links.map((l) => (
              <tr key={l.id} style={{ borderBottom: '1px solid var(--divider)' }}>
                <td style={{ padding: 6 }}><code>{l.code}</code></td>
                <td style={{ padding: 6 }}>
                  {l.spec_type}
                  {l.grade_level !== '-' ? ` ${l.grade_level}` : ''}
                  {l.size_label !== '-' ? ` ${l.size_label}` : ''}
                  <div className="muted" style={{ fontSize: 10 }}>{l.origin_name}</div>
                </td>
                <td style={{ padding: 6, textAlign: 'right',
                             fontVariantNumeric: 'tabular-nums' }}>
                  {num(l.base_kg, 1)} kg
                </td>
                <td style={{ padding: 6 }}>{STATUS_LABEL[l.status] ?? l.status}</td>
                <td style={{ padding: 6 }}>
                  <button onClick={() => onUnlink(l.id, l.code)}
                    className="ghost small"
                    style={{ padding: '3px 6px', color: 'var(--danger)' }}
                    title="このオブジェクトから外す">
                    <Trash2 size={11} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function AddPanel({ objectId, cropId, onCreated }: {
  objectId: number
  cropId?: number
  onCreated: () => void
}) {
  const params: Record<string, string> = { days: '365' }
  if (cropId !== undefined) params.crop_id = String(cropId)
  const sources = useFetch<SemifinishedSourceOutbound[]>(
    '/semifinished/source-outbounds', params)
  const [query, setQuery] = useState('')
  const tokens = useMemo(() => tokenize(query), [query])
  const filtered = useMemo(() => {
    if (!sources.data) return []
    if (tokens.length === 0) return sources.data
    return sources.data.filter(s => {
      const txt = `${s.lot_code} ${s.supplier_name} ${s.spec_type} ${s.origin_name}`
      return matchesAllTokens(txt, tokens)
    })
  }, [sources.data, tokens])

  const [selected, setSelected] = useState<SemifinishedSourceOutbound | null>(null)
  const [casesStr, setCasesStr] = useState('')
  const [kpcStr, setKpcStr] = useState('')
  const totalKg = useMemo(() => {
    const c = Number(casesStr) || 0
    const k = Number(kpcStr) || 0
    return c * k
  }, [casesStr, kpcStr])
  const exceedsOutbound = selected && totalKg > Number(selected.quantity_kg)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!selected) return
    if (totalKg <= 0) { setError('数量を入力してください'); return }
    if (exceedsOutbound) { setError('元出庫の数量を超えています'); return }
    setBusy(true); setError(null)
    try {
      // 1) 半製品ロット作成
      const lot = await api.post<SemifinishedStock>('/semifinished/lots', {
        source_outbound_id: selected.outbound_id,
        inbound_date: selected.outbound_date,
        cases: Number(casesStr),
        kg_per_case: Number(kpcStr),
        total_kg: totalKg,
        unit_price: selected.lot_unit_price ? Number(selected.lot_unit_price) : null,
        note: '棚卸登録 (レイアウト)',
      })
      // 2) オブジェクトに紐付け
      await api.post(`/storage/objects/${objectId}/items`, {
        object_id: objectId,
        semifinished_lot_id: lot.lot_id,
        priority: 50,
      })
      setSelected(null)
      setCasesStr(''); setKpcStr('')
      sources.reload()
      onCreated()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* 検索バー */}
      <div style={{
        padding: '8px 12px', borderBottom: '1px solid var(--border)',
        display: 'flex', gap: 6, alignItems: 'center',
      }}>
        <Search size={12} style={{ color: 'var(--muted)' }} />
        <input value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="整理番号 / 仕入先 / 規格 で絞り込み"
          style={{ flex: 1, padding: '3px 8px', fontSize: 12 }} />
      </div>

      {/* 出庫レコード一覧 */}
      <div style={{ flex: 1, overflow: 'auto', padding: 0 }}>
        {sources.loading && <div className="muted" style={{ padding: 16 }}>読み込み中…</div>}
        {sources.error && <div className="alert error">{sources.error}</div>}
        {sources.data && filtered.length === 0 && (
          <div className="muted" style={{ padding: 16, fontSize: 12, textAlign: 'center' }}>
            候補の出庫レコードがありません。
            {tokens.length > 0 ? ' 検索条件を緩めてみてください。'
             : ' (出庫済みかつ半製品未登録のもの)'}
          </div>
        )}
        {filtered.map((s) => {
          const isSelected = selected?.outbound_id === s.outbound_id
          return (
            <div key={s.outbound_id}
              onClick={() => setSelected(s)}
              style={{
                padding: '6px 12px',
                cursor: 'pointer',
                background: isSelected ? 'var(--accent-bg, #eaf1f8)' : undefined,
                borderLeft: isSelected ? '3px solid var(--primary)' : '3px solid transparent',
                borderBottom: '1px solid var(--divider)',
                fontSize: 12,
              }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
                <code style={{ fontWeight: 600 }}>{s.lot_code}</code>
                <span style={{ color: 'var(--muted)', fontSize: 11 }}>
                  {ymd(s.outbound_date)} 出庫
                </span>
                <span style={{ marginLeft: 'auto', fontWeight: 600 }}>
                  {num(s.quantity_kg, 1)} kg
                </span>
              </div>
              <div style={{ color: 'var(--muted)', fontSize: 11 }}>
                {s.spec_type}
                {s.grade_level !== '-' ? ` ${s.grade_level}` : ''}
                {s.size_label !== '-' ? ` ${s.size_label}` : ''}
                {' / '}{s.origin_name} / {s.supplier_name}
                {s.lot_unit_price && ` · ${yen(s.lot_unit_price)}/kg`}
              </div>
            </div>
          )
        })}
      </div>

      {/* 選択中の出庫レコード — 数量入力 + 確定ボタン */}
      {selected && (
        <div style={{
          padding: 12, borderTop: '2px solid var(--primary)',
          background: 'var(--accent-bg, #eaf1f8)',
        }}>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>
            選択中: <code>{selected.lot_code}</code> ({num(selected.quantity_kg, 1)}kg 出庫済) — 残り棚卸可能量内で入力
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
            <div>
              <div style={{ fontSize: 10, color: 'var(--muted)' }}>ケース数</div>
              <input type="number" step="0.01" value={casesStr}
                onChange={(e) => setCasesStr(e.target.value)}
                style={{ width: 90, padding: '4px 6px' }} />
            </div>
            <div>
              <div style={{ fontSize: 10, color: 'var(--muted)' }}>kg/CS</div>
              <input type="number" step="0.01" value={kpcStr}
                onChange={(e) => setKpcStr(e.target.value)}
                style={{ width: 90, padding: '4px 6px' }} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 10, color: 'var(--muted)' }}>合計</div>
              <div style={{
                fontSize: 16, fontWeight: 600,
                color: exceedsOutbound ? 'var(--danger)' : 'var(--text)',
                fontVariantNumeric: 'tabular-nums',
              }}>
                {num(totalKg, 2)} kg
                {exceedsOutbound && (
                  <span style={{ fontSize: 10, marginLeft: 6, color: 'var(--danger)' }}>
                    超過
                  </span>
                )}
              </div>
            </div>
            <button onClick={submit}
              disabled={busy || !selected || totalKg <= 0 || !!exceedsOutbound}
              style={{ padding: '6px 14px' }}>
              {busy ? '登録中…' : '棚卸登録'}
            </button>
          </div>
          {error && (
            <div style={{ color: 'var(--danger)', fontSize: 11, marginTop: 6 }}>{error}</div>
          )}
        </div>
      )}
    </div>
  )
}
