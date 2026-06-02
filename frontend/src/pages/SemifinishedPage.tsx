/**
 * SemifinishedPage — 半製品台帳 (新仕様 2026-05〜)。
 *
 * 簡素化方針:
 *   - 増減記録は廃止 (出庫モーダル/履歴セクション削除)
 *   - 新規登録はレイアウト棚卸モードのみ (このページからは登録しない)
 *   - 一覧 + 処理状態の編集のみ
 *
 * 列:
 *   整理番号 / 規格 / 産地 / 数量 / 単価 / 評価額 / 処理状態 / 入荷日 / 元出庫
 *
 * 処理状態 (status):
 *   pending=処理待ち / sorting=選別中 / soaking=浸漬中 / washing=洗い中
 */
import { useMemo, useState } from 'react'
import { api } from '../api/client'
import { useFetch } from '../lib/useFetch'
import { useDialog } from '../components/Dialog'
import { LoadingState, ErrorBanner } from '../components/StatusDisplay'
import { errorText, num, yen, ymd } from '../lib/format'
import { GARLIC_EXP_CROP_ID } from '../lib/crop'
import type { SemifinishedStock, SemifinishedStatus } from '../api/types'

const GARBAGE_SPEC_TYPE = '選別ゴミ'

const STATUS_LABELS: Record<SemifinishedStatus, string> = {
  pending: '処理待ち',
  sorting: '選別中',
  soaking: '浸漬中',
  washing: '洗い中',
}

const STATUS_COLORS: Record<SemifinishedStatus, { bg: string; fg: string; border: string }> = {
  pending: { bg: '#F5F4ED', fg: '#5C5644', border: '#BFC4B8' },
  sorting: { bg: '#E4F0DF', fg: '#3E6B2E', border: '#A9D08E' },
  soaking: { bg: '#E0E7F3', fg: '#1F4E79', border: '#A6BEDF' },
  washing: { bg: '#FFE5D9', fg: '#9B4A18', border: '#E8A772' },
}

export default function SemifinishedPage({ cropId }: { cropId: number }) {
  const dialog = useDialog()
  const lots = useFetch<SemifinishedStock[]>(
    '/semifinished/lots', { crop_id: String(cropId) })

  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  // 選別ゴミ表示切替 (default off — 大蒜実験 で 選別から 生成された ゴミ規格 は 既定 非表示)
  const [showGarbage, setShowGarbage] = useState(false)

  const isGarlicExp = cropId === GARLIC_EXP_CROP_ID

  // ゴミ規格 を フィルタ。 lots.data に ゴミが ない 作物では カウントも 0
  const filteredLots = useMemo(() => {
    if (!lots.data) return []
    if (showGarbage) return lots.data
    return lots.data.filter(l => l.spec_type !== GARBAGE_SPEC_TYPE)
  }, [lots.data, showGarbage])

  const garbageCount = useMemo(() => {
    if (!lots.data) return 0
    return lots.data.filter(l => l.spec_type === GARBAGE_SPEC_TYPE).length
  }, [lots.data])

  async function changeStatus(lot: SemifinishedStock, next: SemifinishedStatus) {
    if (lot.status === next) return
    setBusyId(lot.lot_id)
    setError(null)
    setMsg(null)
    try {
      await api.patch(`/semifinished/lots/${lot.lot_id}`, { status: next })
      setMsg(`${lot.code} の状態を「${STATUS_LABELS[next]}」に変更しました`)
      lots.reload()
    } catch (e) { setError(errorText(e)) }
    finally { setBusyId(null) }
  }

  async function deleteLot(lot: SemifinishedStock) {
    const ok = await dialog.confirm({
      title: '半製品を削除',
      message: `${lot.code} (${num(lot.base_kg, 1)}kg) を削除します。\n出庫履歴がある場合は削除できません。`,
      okLabel: '削除',
      variant: 'danger',
    })
    if (!ok) return
    setBusyId(lot.lot_id)
    setError(null)
    try {
      await api.delete(`/semifinished/lots/${lot.lot_id}`)
      setMsg(`${lot.code} を削除しました`)
      lots.reload()
    } catch (e) { setError(errorText(e)) }
    finally { setBusyId(null) }
  }

  return (
    <div>
      <h2>半製品台帳</h2>
      <p className="subtitle">
        {isGarlicExp ? (
          <>
            選別機能で 生成された 半製品 lot の 一覧。
            新規登録は <strong>選別（仕分け）ページ</strong> から 行います。
            ここでは 閲覧と 「処理状態」 の 更新ができます。
          </>
        ) : (
          <>
            出庫済み原料の現物在庫を棚卸登録した一覧。
            新規登録は <strong>レイアウト図のオブジェクト棚卸モード</strong>から行います。
            ここでは閲覧と「処理状態」の更新ができます。
            完了したらレイアウトのオブジェクトを削除してください。
          </>
        )}
      </p>

      <ErrorBanner error={error} />
      {msg && <div className="alert success">{msg}</div>}

      {/* 選別ゴミ表示切替 — 大蒜実験 で ゴミ規格 が ある場合のみ 意味あり */}
      {isGarlicExp && garbageCount > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
          background: 'var(--surface, #f8f9fa)', borderRadius: 4, marginBottom: 8,
          fontSize: 13,
        }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={showGarbage}
              onChange={(e) => setShowGarbage(e.target.checked)}
              style={{ width: 'auto' }}
            />
            <span>選別ゴミも表示する</span>
          </label>
          <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>
            {showGarbage
              ? `選別ゴミ ${garbageCount} 件 を 表示中`
              : `選別ゴミ ${garbageCount} 件 を 非表示`}
          </span>
        </div>
      )}

      <div className="panel">
        {lots.loading && <LoadingState />}
        <ErrorBanner error={lots.error} />
        {lots.data && filteredLots.length === 0 && (
          <div style={{ padding: 24, textAlign: 'center' }}>
            <div className="muted" style={{ fontSize: 14, marginBottom: 8 }}>
              {lots.data.length > 0 && garbageCount === lots.data.length
                ? '選別ゴミ のみ。 上の「選別ゴミも表示する」 を ON にしてください。'
                : '半製品の登録がまだありません。'}
            </div>
            {isGarlicExp ? (
              <div className="muted" style={{ fontSize: 12 }}>
                選別（仕分け）ページ で 投入原料 → 半製品 を 生成してください。
              </div>
            ) : (
              <div className="muted" style={{ fontSize: 12 }}>
                レイアウト図 → オブジェクト棚卸モード から、 出庫済みの原料を登録できます。
              </div>
            )}
          </div>
        )}
        {filteredLots.length > 0 && (
          <div className="table-scroll">
            <table className="sticky-head">
              <thead>
                <tr>
                  <th>整理番号</th>
                  <th>規格 / 産地</th>
                  <th className="num">数量 (kg)</th>
                  <th className="num">単価/kg</th>
                  <th className="num">評価額</th>
                  <th>処理状態</th>
                  <th>入荷日</th>
                  <th>元出庫</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filteredLots.map((l) => {
                  const c = STATUS_COLORS[l.status]
                  const isGarbage = l.spec_type === GARBAGE_SPEC_TYPE
                  return (
                    <tr key={l.lot_id}
                        style={isGarbage ? { background: '#fff7e6' } : undefined}
                        title={isGarbage ? '選別ゴミ (単価0円、 量のみ記録)' : undefined}>
                      <td><code>{l.code}</code></td>
                      <td>
                        {l.spec_type}
                        {l.grade_level !== '-' ? ` ${l.grade_level}` : ''}
                        {l.size_label !== '-' ? ` ${l.size_label}` : ''}
                        <div className="muted" style={{ fontSize: 11 }}>{l.origin_name}</div>
                      </td>
                      <td className="num">{num(l.base_kg, 1)}</td>
                      <td className="num">{l.unit_price ? yen(l.unit_price) : '—'}</td>
                      <td className="num">{l.stock_value ? yen(l.stock_value) : '—'}</td>
                      <td>
                        <select
                          value={l.status}
                          onChange={(e) => changeStatus(l, e.target.value as SemifinishedStatus)}
                          disabled={busyId === l.lot_id}
                          style={{
                            background: c.bg, color: c.fg, border: `1px solid ${c.border}`,
                            padding: '3px 8px', borderRadius: 4, fontSize: 12,
                            fontWeight: 500, cursor: 'pointer',
                          }}>
                          {(Object.keys(STATUS_LABELS) as SemifinishedStatus[]).map((s) => (
                            <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                          ))}
                        </select>
                      </td>
                      <td>{ymd(l.inbound_date)}</td>
                      <td>
                        <span title={l.source_outbound_note ?? undefined}>
                          <code style={{ fontSize: 11 }}>{l.source_lot_code}</code>
                          <span className="muted" style={{ fontSize: 11, marginLeft: 4 }}>
                            {ymd(l.source_outbound_date)}
                          </span>
                        </span>
                      </td>
                      <td>
                        <button className="ghost small" onClick={() => deleteLot(l)}
                          disabled={busyId === l.lot_id}
                          style={{ padding: '3px 6px', color: 'var(--danger)' }}
                          title="削除">
                          ✕
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
