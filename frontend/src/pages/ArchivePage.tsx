import { useState } from 'react'
import { api } from '../api/client'
import { useFetch } from '../lib/useFetch'
import { useDialog } from '../components/Dialog'
import { LoadingState } from '../components/StatusDisplay'
import { errorText, num, ymd } from '../lib/format'
import type { ArchiveCandidate, ArchivedLot } from '../api/types'

function thisMonth(): string {
  return new Date().toISOString().slice(0, 7)
}

export default function ArchivePage({ cropId }: { cropId?: number }) {
  const dialog = useDialog()
  const [month, setMonth] = useState(thisMonth())
  const candQuery: Record<string, string> = { month }
  if (cropId !== undefined) candQuery.crop_id = String(cropId)
  const archQuery: Record<string, string> = { limit: '500' }
  if (cropId !== undefined) archQuery.crop_id = String(cropId)
  const candidates = useFetch<ArchiveCandidate[]>(
    '/inbound/lots/archive-candidates', candQuery)
  const archived = useFetch<ArchivedLot[]>('/inbound/lots/archived', archQuery)

  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function togglePick(id: number) {
    setPicked((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  function pickAll() {
    if (!candidates.data) return
    setPicked(new Set(candidates.data.map((c) => c.lot_id)))
  }

  function pickNone() {
    setPicked(new Set())
  }

  async function archiveSelected() {
    if (picked.size === 0) return
    if (!(await dialog.confirm({
      title: 'ロットをアーカイブ',
      message: `${picked.size} 件のロットをアーカイブします。よろしいですか？`,
      okLabel: 'アーカイブ',
    }))) return
    setBusy(true); setError(null); setMsg(null)
    try {
      const r = await api.post<{ count: number }>(
        '/inbound/lots/archive-bulk',
        { lot_ids: Array.from(picked), note: '一括アーカイブ' })
      setMsg(`${r.count} 件をアーカイブしました。`)
      setPicked(new Set())
      candidates.reload(); archived.reload()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  async function archiveOne(id: number) {
    setBusy(true); setError(null); setMsg(null)
    try {
      await api.post(`/inbound/lots/${id}/archive`)
      setMsg(`ロット #${id} をアーカイブしました。`)
      candidates.reload(); archived.reload()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  async function restoreOne(id: number) {
    if (!(await dialog.confirm({
      title: 'アーカイブを解除',
      message: 'このロットのアーカイブを解除します。カレンダー・在庫一覧に戻ります。',
      okLabel: '復元する',
    }))) return
    setBusy(true); setError(null); setMsg(null)
    try {
      await api.post(`/inbound/lots/${id}/restore`)
      setMsg(`ロット #${id} を復元しました。`)
      candidates.reload(); archived.reload()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  async function deleteOne(id: number, outCount: number) {
    if (outCount > 0) {
      await dialog.alert({
        title: '削除できません',
        message: 'このロットには出庫履歴が残っているため、物理削除できません。\nまずは復元せず、アーカイブのまま保管してください。',
        variant: 'warn',
      })
      return
    }
    if (!(await dialog.confirm({
      title: 'ロットを物理削除',
      message: 'このロットを物理削除します。元に戻せません。続行しますか？',
      okLabel: '削除する',
      variant: 'danger',
    }))) return
    setBusy(true); setError(null); setMsg(null)
    try {
      await api.delete(`/inbound/lots/${id}`)
      setMsg(`ロット #${id} を削除しました。`)
      archived.reload()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <h2>ロットのアーカイブ管理</h2>
      <p className="subtitle">
        基準月の<strong>前月末で在庫が 0kg</strong>になっており、かつ
        <strong>基準月より前に入荷された</strong>ロットをアーカイブできます。
        当月内に消化されたロットは含みません（前月時点で既に動きの無いものに限る）。
        アーカイブ済みは復元または物理削除が可能です。
      </p>

      {error && <div className="alert error">{error}</div>}
      {msg && <div className="alert success">{msg}</div>}

      <div className="panel">
        <div className="inline" style={{ marginBottom: 12, justifyContent: 'space-between' }}>
          <div className="inline">
            <h3 style={{ margin: 0, border: 'none', padding: 0 }}>
              アーカイブ候補
              {candidates.data && <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
                ({candidates.data.length} 件)
              </span>}
            </h3>
          </div>
          <div className="inline">
            <div>
              <label style={{ display: 'inline-block', marginRight: 6 }}>基準月</label>
              <input
                type="month" value={month}
                onChange={(e) => setMonth(e.target.value)}
                style={{ width: 130, display: 'inline-block' }}
              />
            </div>
            <button className="ghost small" onClick={pickAll}>全選択</button>
            <button className="ghost small" onClick={pickNone}>選択解除</button>
            <button
              onClick={archiveSelected}
              disabled={busy || picked.size === 0}
            >
              選択した {picked.size} 件をアーカイブ
            </button>
          </div>
        </div>
        <p className="muted" style={{ fontSize: 12, margin: '0 0 10px' }}>
          条件: 入荷日 &lt; {month}-01 ∧ 前月末 ({(() => {
            // 文字列ベースで前月を算出（タイムゾーンの影響を受けないよう）
            const [y, m] = month.split('-').map(Number)
            const py = m === 1 ? y - 1 : y
            const pm = m === 1 ? 12 : m - 1
            return `${py}-${String(pm).padStart(2, '0')}`
          })()}) の棚卸 = 0kg
        </p>

        {candidates.loading && <LoadingState />}
        {candidates.data && candidates.data.length === 0 && (
          <div className="muted">アーカイブ候補はありません。</div>
        )}
        {candidates.data && candidates.data.length > 0 && (
          <table>
            <thead>
              <tr>
                <th style={{ width: 30 }}></th>
                <th>整理番号</th>
                <th>作物</th>
                <th>入荷日</th>
                <th>規格 / 産地</th>
                <th>仕入先</th>
                <th className="num">入庫量</th>
                <th className="num">前月末棚卸</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {candidates.data.map((c) => (
                <tr key={c.lot_id}>
                  <td>
                    <input
                      type="checkbox" style={{ width: 'auto' }}
                      checked={picked.has(c.lot_id)}
                      onChange={() => togglePick(c.lot_id)}
                    />
                  </td>
                  <td><code style={{ fontFamily: 'var(--font-mono)' }}>{c.code}</code></td>
                  <td>{c.crop_name}</td>
                  <td>{ymd(c.inbound_date)}</td>
                  <td>
                    {c.spec_type}
                    {c.grade_level && c.grade_level !== '-' ? ` ${c.grade_level}` : ''}
                    {c.size_label && c.size_label !== '-' ? c.size_label : ''}
                    {' / '}{c.origin_name}
                  </td>
                  <td>{c.supplier_name}</td>
                  <td className="num">{num(c.total_kg, 1)}</td>
                  <td className="num">
                    {num(c.carryover_kg, 1)}
                    <span className="muted" style={{ fontSize: 10, marginLeft: 4 }}>
                      ({c.carryover_period})
                    </span>
                  </td>
                  <td>
                    <button
                      className="ghost small"
                      disabled={busy}
                      onClick={() => archiveOne(c.lot_id)}
                    >
                      アーカイブ
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h3>
          アーカイブ済み
          {archived.data && (
            <span className="muted" style={{ fontWeight: 400, marginLeft: 8, fontSize: 13 }}>
              ({archived.data.length} 件)
            </span>
          )}
        </h3>
        {archived.error && <div className="alert error">{archived.error}</div>}
        {archived.data && archived.data.length === 0 && (
          <div className="muted">アーカイブ済みのロットはありません。</div>
        )}
        {archived.data && archived.data.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>整理番号</th>
                <th>作物</th>
                <th>入荷日</th>
                <th>規格 / 産地</th>
                <th>仕入先</th>
                <th className="num">入庫量</th>
                <th>アーカイブ日時</th>
                <th>担当</th>
                <th className="num">出庫履歴</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {archived.data.map((a) => (
                <tr key={a.lot_id}>
                  <td><code style={{ fontFamily: 'var(--font-mono)' }}>{a.code}</code></td>
                  <td>{a.crop_name}</td>
                  <td>{ymd(a.inbound_date)}</td>
                  <td>
                    {a.spec_type}
                    {a.grade_level && a.grade_level !== '-' ? ` ${a.grade_level}` : ''}
                    {a.size_label && a.size_label !== '-' ? a.size_label : ''}
                    {' / '}{a.origin_name}
                  </td>
                  <td>{a.supplier_name}</td>
                  <td className="num">{num(a.total_kg, 1)}</td>
                  <td style={{ fontSize: 11 }}>{a.archived_at?.slice(0, 16).replace('T', ' ') ?? '—'}</td>
                  <td>{a.archived_by_name ?? '—'}</td>
                  <td className="num">{a.outbound_count}</td>
                  <td>
                    <div className="inline" style={{ gap: 4 }}>
                      <button
                        className="ghost small"
                        disabled={busy}
                        onClick={() => restoreOne(a.lot_id)}
                      >
                        復元
                      </button>
                      <button
                        className="danger small"
                        disabled={busy || a.outbound_count > 0}
                        title={a.outbound_count > 0 ? '出庫履歴があるため削除不可' : '物理削除（戻せません）'}
                        onClick={() => deleteOne(a.lot_id, a.outbound_count)}
                      >
                        削除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
