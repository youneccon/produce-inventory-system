import { useState, type ChangeEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../api/client'
import { useFetch } from '../lib/useFetch'
import { errorText } from '../lib/format'
import { useAuth } from '../auth/AuthContext'
import type { StorageLayout, StorageTargetKind } from '../api/types'

const TARGET_LABEL: Record<StorageTargetKind, string> = {
  material:   '資材',
  ingredient: '原料',
}

// 作物名 → division 番号
const CROP_DIVISION: Record<string, number> = {
  ginger:     1,
  garlic:     2,
  yamaimo:    3,
  gobo:       4,
  satsumaimo: 5,
}
const CROP_NAME: Record<string, string> = {
  ginger: '生姜', garlic: '大蒜', yamaimo: '長芋', gobo: '牛蒡', satsumaimo: '薩摩芋',
}

export default function StorageLayoutsPage({
  targetKind,
}: { targetKind: StorageTargetKind }) {
  const { isAdmin } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const cropFrom = searchParams.get('from')  // 原料版で作物タブから来た場合
  const division = cropFrom && CROP_DIVISION[cropFrom]
                   ? CROP_DIVISION[cropFrom] : null

  const queryParams: Record<string, string> = { target_kind: targetKind }
  if (division !== null) queryParams.division = String(division)
  const layouts = useFetch<StorageLayout[]>('/storage/layouts', queryParams)

  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function createLayout() {
    if (!name.trim()) return
    setBusy(true); setError(null)
    try {
      const r = await api.post<StorageLayout>('/storage/layouts', {
        name: name.trim(),
        target_kind: targetKind,
        division: division,
      })
      setName('')
      layouts.reload()
      const suffix = cropFrom ? `?from=${cropFrom}` : ''
      navigate(`/storage/${targetKind}/${r.id}${suffix}`)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const cropLabel = cropFrom ? CROP_NAME[cropFrom] : null

  return (
    <div>
      <h2>
        {cropLabel
          ? `${cropLabel} 原料 置き場レイアウト`
          : `${TARGET_LABEL[targetKind]} 置き場レイアウト`}
      </h2>
      <p className="subtitle">
        間取り図上に保管場所を配置し、
        {cropLabel ?? TARGET_LABEL[targetKind]}との対応関係を可視化します。
        管理者は新規レイアウト作成・配置編集が可能です。
      </p>

      {error && <div className="alert error">{error}</div>}

      {isAdmin && (
        <div className="panel">
          <h3>新規レイアウト作成</h3>
          <div className="inline">
            <input
              type="text"
              placeholder="例: 事業1部 倉庫A"
              value={name}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
              style={{ maxWidth: 320 }}
            />
            <button onClick={createLayout} disabled={busy || !name.trim()}>
              {busy ? '作成中…' : 'レイアウトを作成'}
            </button>
          </div>
        </div>
      )}

      <div className="panel">
        <h3>レイアウト一覧</h3>
        {layouts.loading && <div className="muted">読み込み中…</div>}
        {layouts.data && layouts.data.length === 0 && (
          <div className="muted">レイアウトがまだありません。</div>
        )}
        {layouts.data && layouts.data.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>事業部</th>
                <th>画像</th>
                <th>備考</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {layouts.data.map((l) => (
                <tr key={l.id}>
                  <td>{l.name}</td>
                  <td>{l.division ?? '—'}</td>
                  <td>
                    {l.image_url
                      ? <span className="badge ok">あり ({l.image_width}×{l.image_height})</span>
                      : <span className="badge pending">未設定</span>}
                  </td>
                  <td className="muted" style={{ fontSize: 12 }}>{l.note ?? ''}</td>
                  <td>
                    <button
                      className="secondary small"
                      onClick={() => {
                        const suffix = cropFrom ? `?from=${cropFrom}` : ''
                        navigate(`/storage/${targetKind}/${l.id}${suffix}`)
                      }}
                    >
                      開く →
                    </button>
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
