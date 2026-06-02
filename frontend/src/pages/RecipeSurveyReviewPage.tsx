/**
 * RecipeSurveyReviewPage
 * =======================
 * 管理者用 レシピ提案レビュー画面 (admin 専用)。
 *
 * 機能:
 *   - 提案一覧 (status / 事業部 でフィルタ)
 *   - 提案詳細 (lines)
 *   - 承認 → product_material_usage に流し込み
 *   - 却下
 *   - 削除
 *   - 公開 URL の QR コード生成 (各事業部)
 */
import { useMemo, useState } from 'react'
import { api } from '../api/client'
import { useFetch } from '../lib/useFetch'
import { useDialog } from '../components/Dialog'
import { errorText, num, ymd } from '../lib/format'

interface SubmissionSummary {
  id: number
  division_code: number
  division_name: string
  submitter_name: string | null
  submitter_note: string | null
  submitted_at: string
  status: 'pending' | 'approved' | 'rejected'
  reviewed_at: string | null
  review_note: string | null
  line_count: number
}
interface SubmissionLine {
  id: number
  product_id: number | null
  product_text: string | null
  product_name: string | null
  material_id: number | null
  material_text: string | null
  material_code: string | null
  material_name: string | null
  quantity_per_unit: string
  unit_note: string | null
  line_note: string | null
  is_uncertain: boolean
  line_status: string
}
interface SubmissionDetail extends SubmissionSummary {
  lines: SubmissionLine[]
}

const DIVISIONS = [
  { code: 1, name: '生姜' },
  { code: 2, name: '大蒜' },
  { code: 3, name: '長芋' },
  { code: 4, name: '牛蒡' },
  { code: 5, name: '薩摩芋' },
  { code: 6, name: '物流' },
]

const PUBLIC_BASE_KEY = 'recipe_survey_public_base_url_v1'

/**
 * クリップボードコピー (HTTP/Tailscale 内部 URL でも動く fallback 付き)。
 * - navigator.clipboard は HTTPS or localhost のみ有効。
 *   外部レビュアーが内部ホスト (例 http://internal-host:5173, Tailscale 等) からアクセスするとブロックされる。
 * - fallback として document.execCommand('copy') を使う。 これは古いが
 *   HTTP でも動作する。 textarea を一時生成して selection → execCommand。
 */
async function copyToClipboard(
  text: string,
  onSuccess: () => void,
  onError: (msg: string) => void,
) {
  // 1) まず modern API を試す
  if (typeof navigator !== 'undefined'
      && navigator.clipboard
      && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text)
      onSuccess()
      return
    } catch { /* fall through to legacy */ }
  }
  // 2) Legacy fallback (HTTP でも動く)
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    ta.style.left = '-9999px'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    if (ok) onSuccess()
    else onError('クリップボード API が使えず、 コピー失敗しました。 URL を手動でコピーしてください。')
  } catch (e) {
    onError(`コピー失敗: ${(e as Error).message}`)
  }
}

export default function RecipeSurveyReviewPage() {
  const dialog = useDialog()
  const [filterStatus, setFilterStatus] = useState<'pending' | 'approved' | 'rejected' | 'all'>('pending')
  const [filterDivision, setFilterDivision] = useState<number | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // 公開ベース URL (Cloudflare Tunnel 等のドメイン)
  // localStorage に保存して、 QR ターゲットに使う
  const [publicBaseUrl, setPublicBaseUrl] = useState<string>(() => {
    try { return localStorage.getItem(PUBLIC_BASE_KEY) ?? '' } catch { return '' }
  })
  function applyPublicBase(v: string) {
    setPublicBaseUrl(v)
    try {
      if (v) localStorage.setItem(PUBLIC_BASE_KEY, v)
      else localStorage.removeItem(PUBLIC_BASE_KEY)
    } catch { /* ignore */ }
  }
  // 有効な base URL を解決 (空欄なら現在の origin、 末尾スラッシュ削除)
  const effectiveBase = (publicBaseUrl || window.location.origin).replace(/\/+$/, '')

  const list = useFetch<SubmissionSummary[]>('/admin/recipe-submissions', {
    ...(filterStatus !== 'all' ? { status: filterStatus } : {}),
    ...(filterDivision != null ? { division_code: String(filterDivision) } : {}),
  })
  const detail = useFetch<SubmissionDetail>(
    selectedId != null ? `/admin/recipe-submissions/${selectedId}` : null)

  async function approve() {
    if (selectedId == null) return
    if (!(await dialog.confirm({
      title: 'レシピ提案を承認',
      message: 'この提案を承認して、 正規レシピに反映しますか?\nマスタ未登録の項目はスキップされます。',
      okLabel: '承認',
    }))) return
    setBusy(true); setError(null); setMsg(null)
    try {
      const r = await api.post<{ inserted: number; skipped: any[]; all_approved: boolean }>(
        `/admin/recipe-submissions/${selectedId}/approve`, { review_note: null })
      setMsg(`${r.inserted} 件のレシピを正規 product_material_usage に反映しました。`
        + (r.skipped.length > 0 ? ` (${r.skipped.length} 件はマスタ未登録のためスキップ)` : ''))
      list.reload(); detail.reload()
    } catch (e) { setError(errorText(e)) }
    finally { setBusy(false) }
  }
  async function reject() {
    if (selectedId == null) return
    const note = prompt('却下理由 (任意)') || null
    if (!(await dialog.confirm({
      title: 'レシピ提案を却下',
      message: '却下します。よろしいですか?',
      okLabel: '却下',
      variant: 'warn',
    }))) return
    setBusy(true); setError(null); setMsg(null)
    try {
      await api.post(`/admin/recipe-submissions/${selectedId}/reject`, { review_note: note })
      setMsg('却下しました')
      list.reload(); detail.reload()
    } catch (e) { setError(errorText(e)) }
    finally { setBusy(false) }
  }
  async function removeSubmission() {
    if (selectedId == null) return
    if (!(await dialog.confirm({
      title: 'レシピ提案を物理削除',
      message: 'この提案を物理削除します。元に戻せません。',
      okLabel: '削除',
      variant: 'danger',
    }))) return
    setBusy(true); setError(null); setMsg(null)
    try {
      await api.delete(`/admin/recipe-submissions/${selectedId}`)
      setMsg('削除しました')
      setSelectedId(null)
      list.reload()
    } catch (e) { setError(errorText(e)) }
    finally { setBusy(false) }
  }

  const pendingCount = useMemo(
    () => (list.data ?? []).filter((s) => s.status === 'pending').length,
    [list.data])

  return (
    <div className="page">
      <h2>レシピ提案 レビュー</h2>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        各事業部の担当者が公開 URL から提案したレシピをここで確認・承認します。
        マスタ未登録の商品/資材を含む行はスキップされ、 admin が手動で対応した後に再承認できます。
      </p>

      {/* 公開 URL & QR */}
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>📲 公開アンケート URL</h3>
        <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
          各事業部に渡す URL。 QR コード画像 (印刷用) も生成可能。
        </p>

        {/* 公開ベース URL 設定 (Cloudflare Tunnel 等の外部公開ドメイン) */}
        <div className="field" style={{ marginTop: 8, marginBottom: 4 }}>
          <label>
            公開ベース URL
            <span className="muted" style={{ fontWeight: 400, fontSize: 11, marginLeft: 6 }}>
              (Cloudflare Tunnel ドメイン等。 空欄は現在の origin: <code>{window.location.origin}</code>)
            </span>
          </label>
          <div className="inline" style={{ gap: 6 }}>
            <input
              type="url"
              value={publicBaseUrl}
              onChange={(e) => applyPublicBase(e.target.value)}
              placeholder="例: https://random.trycloudflare.com"
              style={{ flex: 1, fontSize: 13 }}
            />
            {publicBaseUrl && (
              <button
                type="button"
                className="ghost small"
                onClick={() => applyPublicBase('')}
                title="ベース URL をリセット"
              >×</button>
            )}
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
            ※ 担当者は社外スマホからアクセスするため、 LAN/Tailscale 内部 URL ではなく
            公開ドメインを設定 (現状の origin が localhost や Tailscale 名のままだと QR スキャンしても繋がりません)
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginTop: 12 }}>
          {DIVISIONS.map((d) => {
            const url = `${effectiveBase}/recipe-survey/${d.code}`
            const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(url)}`
            return (
              <div key={d.code} style={{
                padding: 12, background: 'var(--surface, #f8f9fa)',
                border: '1px solid var(--border)', borderRadius: 6,
                textAlign: 'center',
              }}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>{d.name} (事業{d.code}部)</div>
                <a href={url} target="_blank" rel="noreferrer"
                   style={{ fontSize: 11, wordBreak: 'break-all', color: 'var(--primary)' }}>
                  {url}
                </a>
                <div style={{ marginTop: 6 }}>
                  <img src={qrSrc} alt={`QR ${d.name}`} width={140} height={140}
                       style={{ border: '1px solid var(--border)', borderRadius: 4 }} />
                </div>
                <button
                  type="button"
                  onClick={() => copyToClipboard(url, () => setMsg(`URL をコピーしました (${d.name})`),
                                                       (msg) => setError(msg))}
                  className="ghost small"
                  style={{ marginTop: 6 }}
                >URL コピー</button>
              </div>
            )
          })}
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
          ※ QR は外部サービス (qrserver.com) を使って描画。 ネット接続が必要。 印刷時は右クリックで画像保存。
        </div>
      </div>

      {/* フィルタ */}
      <div className="panel">
        <div className="row" style={{ gap: 12, alignItems: 'flex-end' }}>
          <div className="field" style={{ minWidth: 140 }}>
            <label>状態</label>
            <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as any)}>
              <option value="pending">保留中 ({pendingCount})</option>
              <option value="approved">承認済み</option>
              <option value="rejected">却下</option>
              <option value="all">全部</option>
            </select>
          </div>
          <div className="field" style={{ minWidth: 140 }}>
            <label>事業部</label>
            <select
              value={filterDivision ?? ''}
              onChange={(e) => setFilterDivision(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">全部</option>
              {DIVISIONS.map((d) => (
                <option key={d.code} value={d.code}>{d.name}</option>
              ))}
            </select>
          </div>
          <button type="button" onClick={() => list.reload()} className="ghost">再読み込み</button>
        </div>
      </div>

      {error && <div className="alert error">{error}</div>}
      {msg && <div className="alert success">{msg}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 1.5fr', gap: 16 }}>
        {/* 一覧 */}
        <div className="panel" style={{ overflow: 'auto', maxHeight: '70vh' }}>
          <h3 style={{ marginTop: 0 }}>提案一覧 ({list.data?.length ?? 0})</h3>
          {list.loading && <div className="muted">読み込み中…</div>}
          {list.data && list.data.length === 0 && (
            <div className="muted">該当する提案はありません。</div>
          )}
          {list.data?.map((s) => (
            <div
              key={s.id}
              onClick={() => setSelectedId(s.id)}
              style={{
                padding: 10, marginBottom: 6,
                border: '1px solid ' + (selectedId === s.id ? 'var(--primary)' : 'var(--border)'),
                background: selectedId === s.id ? 'rgba(26,115,232,0.05)' : '#fff',
                borderRadius: 6, cursor: 'pointer',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong>{s.division_name}</strong>
                <span style={{
                  fontSize: 10, padding: '2px 6px', borderRadius: 3,
                  background: s.status === 'pending' ? 'var(--warning, #f5a623)' :
                             s.status === 'approved' ? 'var(--success, #28a745)' : 'var(--muted)',
                  color: '#fff',
                }}>{s.status}</span>
              </div>
              <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                {ymd(s.submitted_at)} {s.submitter_name && `/ ${s.submitter_name}`}
              </div>
              <div style={{ fontSize: 12, marginTop: 4 }}>
                {s.line_count} 件のレシピ提案
              </div>
            </div>
          ))}
        </div>

        {/* 詳細 */}
        <div className="panel" style={{ overflow: 'auto', maxHeight: '70vh' }}>
          {!selectedId && (
            <div className="muted" style={{ textAlign: 'center', padding: 32 }}>
              左の一覧から提案を選択してください
            </div>
          )}
          {detail.loading && <div className="muted">読み込み中…</div>}
          {detail.data && (
            <>
              <h3 style={{ marginTop: 0 }}>
                {detail.data.division_name} 事業部の提案
                <span style={{ marginLeft: 8, fontSize: 12, padding: '2px 8px',
                  background: detail.data.status === 'pending' ? 'var(--warning, #f5a623)' :
                              detail.data.status === 'approved' ? 'var(--success, #28a745)' : 'var(--muted)',
                  color: '#fff', borderRadius: 3 }}>
                  {detail.data.status}
                </span>
              </h3>
              <div className="muted" style={{ fontSize: 12 }}>
                送信: {ymd(detail.data.submitted_at)}
                {detail.data.submitter_name && ` / ${detail.data.submitter_name}`}
              </div>
              {detail.data.submitter_note && (
                <div style={{ marginTop: 6, padding: 8, background: 'var(--surface, #f8f9fa)', borderRadius: 4, fontSize: 13 }}>
                  💬 {detail.data.submitter_note}
                </div>
              )}
              {detail.data.review_note && (
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  レビューメモ: {detail.data.review_note}
                </div>
              )}

              {/* アクション */}
              {detail.data.status === 'pending' && (
                <div className="inline" style={{ marginTop: 12, gap: 8 }}>
                  <button onClick={approve} disabled={busy}
                    style={{ background: 'var(--success, #28a745)', color: '#fff', fontWeight: 700 }}>
                    ✅ 承認 → 正規レシピへ反映
                  </button>
                  <button onClick={reject} disabled={busy}
                    style={{ background: 'transparent', color: 'var(--danger)', border: '1px solid var(--danger)' }}>
                    ❌ 却下
                  </button>
                </div>
              )}
              <div className="inline" style={{ marginTop: 8 }}>
                <button onClick={removeSubmission} disabled={busy} className="ghost small">
                  🗑 削除
                </button>
              </div>

              {/* 行一覧 */}
              <h4 style={{ marginTop: 16 }}>提案内容 ({detail.data.lines.length} 件)</h4>
              <table style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>商品</th>
                    <th>資材</th>
                    <th className="num">数量</th>
                    <th>備考</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.data.lines.map((l) => {
                    const productOk = l.product_id != null
                    const materialOk = l.material_id != null
                    return (
                      <tr key={l.id}>
                        <td>
                          {productOk ? (
                            <span>{l.product_name}</span>
                          ) : (
                            <span style={{ color: 'var(--warning, #f5a623)' }}>
                              ⚠ {l.product_text} (マスタ未登録)
                            </span>
                          )}
                        </td>
                        <td>
                          {materialOk ? (
                            <span><code>{l.material_code}</code> {l.material_name}</span>
                          ) : (
                            <span style={{ color: 'var(--warning, #f5a623)' }}>
                              ⚠ {l.material_text} (マスタ未登録)
                            </span>
                          )}
                        </td>
                        <td className="num">
                          <strong>{num(l.quantity_per_unit, 2)}</strong>
                          {l.unit_note && <span className="muted" style={{ fontSize: 11 }}> {l.unit_note}</span>}
                          {l.is_uncertain && <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--warning, #f5a623)' }}>?</span>}
                        </td>
                        <td>
                          <span className="muted" style={{ fontSize: 11 }}>{l.line_note}</span>
                          {l.line_status !== 'pending' && (
                            <span style={{ marginLeft: 4, fontSize: 10, padding: '1px 4px',
                              background: l.line_status === 'approved' ? 'var(--success)' : 'var(--muted)',
                              color: '#fff', borderRadius: 2 }}>
                              {l.line_status}
                            </span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
