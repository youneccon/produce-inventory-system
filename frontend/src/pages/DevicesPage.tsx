import { useState } from 'react'
import { api } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { useFetch } from '../lib/useFetch'
import { useDialog } from '../components/Dialog'
import { datetime, errorText } from '../lib/format'
import type { DeviceRow, Role } from '../api/types'

const ROLE_LABEL: Record<Role, string> = {
  viewer:   '閲覧者',
  operator: 'オペレータ',
  admin:    '管理者',
}
const ROLE_DESC: Record<Role, string> = {
  viewer:   '読み取り専用。書き込み系の操作は一切不可',
  operator: '入出庫の記録、出荷登録、資材入出庫など日常業務が可能',
  admin:    'マスタ・倉庫レイアウト・人員管理を含む全権限',
}
const ROLES: Role[] = ['viewer', 'operator', 'admin']

export default function DevicesPage() {
  const dialog = useDialog()
  const { user } = useAuth()
  const devices = useFetch<DeviceRow[]>('/auth/devices')
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  async function approve(id: string, role: Role) {
    setBusyId(id)
    setError(null)
    try {
      await api.post(`/auth/devices/${id}/approve`, { role })
      devices.reload()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusyId(null)
    }
  }

  async function changeRole(id: string, role: Role) {
    setBusyId(id)
    setError(null)
    try {
      await api.patch(`/auth/devices/${id}/role`, { role })
      devices.reload()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusyId(null)
    }
  }

  async function revoke(id: string) {
    setBusyId(id)
    setError(null)
    try {
      await api.post(`/auth/devices/${id}/revoke`)
      devices.reload()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusyId(null)
    }
  }

  async function remove(id: string, displayName: string) {
    if (!(await dialog.confirm({
      title: 'デバイスを削除',
      message: `デバイス「${displayName}」を削除します。\n操作履歴がある場合は履歴を残したまま一覧から外します。`,
      okLabel: '削除',
      variant: 'danger',
    }))) return
    setBusyId(id)
    setError(null)
    try {
      await api.delete(`/auth/devices/${id}`)
      devices.reload()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div>
      <h2>デバイス管理</h2>
      <p className="subtitle">
        登録デバイスの承認・権限変更・無効化（管理者のみ）。
        承認時にロールを選択し、後でいつでもプルダウンから変更可能。
      </p>
      {error && <div className="alert error">{error}</div>}

      {/* ロール説明 */}
      <div className="panel" style={{ paddingTop: 14, paddingBottom: 14 }}>
        <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 13 }}>
          ロール体系
        </div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {ROLES.map((r) => (
            <div key={r} style={{ minWidth: 180, flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2 }}>
                <span className={'badge ' + (
                  r === 'admin' ? 'pending' : r === 'operator' ? 'ok' : 'available'
                )}>{ROLE_LABEL[r]}</span>
                <span className="muted" style={{ marginLeft: 6, fontSize: 11, fontWeight: 400 }}>
                  ({r})
                </span>
              </div>
              <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.45 }}>
                {ROLE_DESC[r]}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        <h3>登録デバイス（{devices.data?.length ?? 0}）</h3>
        {devices.loading && <div className="muted">読み込み中…</div>}
        {devices.data && (
          <table>
            <thead>
              <tr>
                <th>表示名</th>
                <th>権限</th>
                <th>状態</th>
                <th>最終ログイン</th>
                <th>登録日時</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {devices.data.map((d) => {
                const isSelf = d.id === user?.id
                return (
                  <tr key={d.id}>
                    <td>
                      {d.display_name}
                      {isSelf && <span className="muted"> (自分)</span>}
                    </td>
                    <td>
                      {d.is_active ? (
                        <select
                          value={d.role}
                          disabled={busyId === d.id}
                          onChange={(e) => changeRole(d.id, e.target.value as Role)}
                          style={{ width: 120, fontSize: 12 }}
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                          ))}
                        </select>
                      ) : (
                        <span className="muted">{ROLE_LABEL[d.role as Role] ?? d.role}</span>
                      )}
                    </td>
                    <td>
                      {d.is_active ? (
                        <span className="badge ok">有効</span>
                      ) : (
                        <span className="badge pending">承認待ち</span>
                      )}
                    </td>
                    <td>{datetime(d.last_login_at)}</td>
                    <td>{datetime(d.created_at)}</td>
                    <td>
                      <div className="inline">
                        {!d.is_active && (
                          <>
                            {ROLES.map((r) => (
                              <button
                                key={r}
                                className={'small ' + (r === 'admin' ? 'secondary' : '')}
                                disabled={busyId === d.id}
                                onClick={() => approve(d.id, r)}
                                title={`${ROLE_LABEL[r]} として承認`}
                              >
                                {ROLE_LABEL[r]}で承認
                              </button>
                            ))}
                            {!isSelf && (
                              <button
                                className="small danger"
                                disabled={busyId === d.id}
                                onClick={() => remove(d.id, d.display_name)}
                              >
                                削除
                              </button>
                            )}
                          </>
                        )}
                        {d.is_active && !isSelf && (
                          <button
                            className="small danger"
                            disabled={busyId === d.id}
                            onClick={() => revoke(d.id)}
                          >
                            無効化
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
