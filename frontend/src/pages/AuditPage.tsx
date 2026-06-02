import { useFetch } from '../lib/useFetch'
import { datetime } from '../lib/format'
import type { AuditEntry, CorrectionRecord } from '../api/types'

export default function AuditPage() {
  const audit = useFetch<AuditEntry[]>('/audit/log', { limit: 100 })
  const corrections = useFetch<CorrectionRecord[]>('/corrections')

  return (
    <div>
      <h2>監査ログ・訂正履歴</h2>
      <p className="subtitle">
        いつ・誰が・何をしたかの記録（管理者のみ）。改ざん防止のため追記専用。
      </p>

      <div className="panel">
        <h3>訂正履歴</h3>
        {corrections.error && (
          <div className="alert error">{corrections.error}</div>
        )}
        {corrections.data && corrections.data.length === 0 && (
          <div className="muted">訂正履歴はありません。</div>
        )}
        {corrections.data && corrections.data.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>日時</th>
                <th>対象</th>
                <th>項目</th>
                <th>変更前</th>
                <th>変更後</th>
                <th>理由</th>
                <th>実施者</th>
              </tr>
            </thead>
            <tbody>
              {corrections.data.map((c) => (
                <tr key={c.id}>
                  <td>{datetime(c.corrected_at)}</td>
                  <td>
                    {c.target_table} #{c.target_id}
                  </td>
                  <td>{c.field_name}</td>
                  <td>{c.old_value ?? '—'}</td>
                  <td>{c.new_value ?? '—'}</td>
                  <td>{c.reason}</td>
                  <td>{c.corrected_by_name ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h3>監査ログ（直近100件）</h3>
        {audit.error && <div className="alert error">{audit.error}</div>}
        {audit.loading && <div className="muted">読み込み中…</div>}
        {audit.data && (
          <table>
            <thead>
              <tr>
                <th>日時</th>
                <th>イベント</th>
                <th>対象</th>
                <th>レコード</th>
                <th>実施者</th>
              </tr>
            </thead>
            <tbody>
              {audit.data.map((a) => (
                <tr key={a.id}>
                  <td>{datetime(a.occurred_at)}</td>
                  <td>{a.event_type}</td>
                  <td>{a.table_name ?? '—'}</td>
                  <td>{a.record_id ?? '—'}</td>
                  <td>{a.actor_name ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
