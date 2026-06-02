import { useMemo, useState } from 'react'
import { usePreferences } from '../auth/PreferencesContext'
import { useAuth } from '../auth/AuthContext'
import { useDialog } from '../components/Dialog'
import { getToken } from '../api/client'
import { COLUMN_DEFS } from '../lib/calendarColumns'
import type {
  CalendarColumnPref,
  DensityMode,
  EmphasisColor,
  ThemeMode,
} from '../api/types'

const themes: { value: ThemeMode; label: string; desc: string }[] = [
  { value: 'light', label: 'ライト', desc: '明るい背景。日中の作業向け' },
  { value: 'dark',  label: 'ダーク', desc: '暗い背景。長時間作業向け' },
]

const densities: { value: DensityMode; label: string; desc: string }[] = [
  { value: 'compact',     label: 'コンパクト', desc: '行間を詰めて、一画面により多くの情報を表示' },
  { value: 'normal',      label: '標準',       desc: '視認性と情報量のバランス（推奨）' },
  { value: 'comfortable', label: 'ゆったり',   desc: 'ゆとりある余白で長時間でも疲れにくい' },
]

const emphasisOptions: { value: EmphasisColor; label: string }[] = [
  { value: 'none',   label: 'なし' },
  { value: 'blue',   label: '青' },
  { value: 'green',  label: '緑' },
  { value: 'orange', label: '橙' },
  { value: 'red',    label: '赤' },
  { value: 'bold',   label: '太字' },
]

/** 現在の prefs から、すべての列を表示しているとみなしたフル設定列を構築 */
function resolveFullColumns(prefCols?: CalendarColumnPref[]): CalendarColumnPref[] {
  const known = new Map<string, CalendarColumnPref>(
    (prefCols ?? []).map((c) => [c.id, c])
  )
  // ユーザー設定の順序を尊重しつつ、未登録のカラムは末尾に追加
  const result: CalendarColumnPref[] = []
  for (const c of prefCols ?? []) {
    if (COLUMN_DEFS.some((d) => d.id === c.id)) result.push(c)
  }
  for (const def of COLUMN_DEFS) {
    if (!known.has(def.id)) {
      result.push({
        id: def.id,
        visible: !!def.defaultVisible,
        emphasis: 'none',
      })
    }
  }
  return result
}

export default function SettingsPage() {
  const { prefs, update } = usePreferences()

  const dash = prefs.dashboard ?? {}
  const cal  = prefs.calendar ?? {}

  const columns: CalendarColumnPref[] = useMemo(
    () => resolveFullColumns(cal.columns),
    [cal.columns],
  )

  function updateColumns(next: CalendarColumnPref[]) {
    update({ calendar: { columns: next } })
  }

  function setVisible(id: string, visible: boolean) {
    updateColumns(columns.map((c) => c.id === id ? { ...c, visible } : c))
  }

  function setEmphasis(id: string, emphasis: EmphasisColor) {
    updateColumns(columns.map((c) => c.id === id ? { ...c, emphasis } : c))
  }

  function moveCol(id: string, dir: -1 | 1) {
    const idx = columns.findIndex((c) => c.id === id)
    const def = COLUMN_DEFS.find((d) => d.id === id)
    if (idx < 0 || !def) return
    // 同じ side 内でしか移動しない
    let swapIdx = idx + dir
    while (swapIdx >= 0 && swapIdx < columns.length) {
      const otherDef = COLUMN_DEFS.find((d) => d.id === columns[swapIdx].id)
      if (otherDef && otherDef.side === def.side) break
      swapIdx += dir
    }
    if (swapIdx < 0 || swapIdx >= columns.length) return
    const next = columns.slice()
    ;[next[idx], next[swapIdx]] = [next[swapIdx], next[idx]]
    updateColumns(next)
  }

  function resetColumns() {
    update({ calendar: { columns: [] } })
  }

  function setTaxRate(rate: number) {
    update({ calendar: { tax_rate: rate } })
  }

  function setHideFuture(v: boolean) {
    update({ calendar: { hide_future: v } })
  }

  const leftCount  = columns.filter((c) =>
    c.visible && COLUMN_DEFS.find((d) => d.id === c.id)?.side === 'left').length
  const rightCount = columns.filter((c) =>
    c.visible && COLUMN_DEFS.find((d) => d.id === c.id)?.side === 'right').length

  return (
    <div>
      <h2>カスタマイズ</h2>
      <p className="subtitle">
        テーマ・密度・ダッシュボード・日次カレンダーの表示を自分用に調整できます。
        設定はサーバに保存され、次回ログイン時にも引き継がれます。
      </p>

      <DeviceTokenPanel />

      <div className="panel">
        <h3>テーマ</h3>
        <div className="row">
          {themes.map((t) => (
            <label
              key={t.value}
              className={'option-card ' + (prefs.theme === t.value ? 'selected' : '')}
            >
              <input
                type="radio"
                name="theme"
                checked={prefs.theme === t.value}
                onChange={() => update({ theme: t.value })}
              />
              <div className="opt-body">
                <div className="opt-title">{t.label}</div>
                <div className="opt-desc">{t.desc}</div>
              </div>
            </label>
          ))}
        </div>
      </div>

      <div className="panel">
        <h3>表示密度</h3>
        <div className="row">
          {densities.map((d) => (
            <label
              key={d.value}
              className={'option-card ' + (prefs.density === d.value ? 'selected' : '')}
            >
              <input
                type="radio"
                name="density"
                checked={prefs.density === d.value}
                onChange={() => update({ density: d.value })}
              />
              <div className="opt-body">
                <div className="opt-title">{d.label}</div>
                <div className="opt-desc">{d.desc}</div>
              </div>
            </label>
          ))}
        </div>
      </div>

      <div className="panel">
        <h3>ダッシュボードの表示内容</h3>
        <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
          在庫一覧（ダッシュボード）に表示するセクションを選べます。
        </p>
        <div className="field">
          <label className="inline" style={{ gap: 6 }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={dash.show_summary !== false}
              onChange={(e) => update({ dashboard: { show_summary: e.target.checked } })}
            />
            当月サマリー（前月繰越・当月入荷・当月出庫・当月在庫）
          </label>
        </div>
        <div className="field">
          <label className="inline" style={{ gap: 6 }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={dash.show_products !== false}
              onChange={(e) => update({ dashboard: { show_products: e.target.checked } })}
            />
            商品別サマリー
          </label>
        </div>
        <div className="field">
          <label className="inline" style={{ gap: 6 }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={dash.show_lots !== false}
              onChange={(e) => update({ dashboard: { show_lots: e.target.checked } })}
            />
            ロット別在庫
          </label>
        </div>
      </div>

      <div className="panel">
        <h3>日次カレンダー</h3>
        <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
          固定列の有無・順序・色強調をカスタマイズできます。日次出庫グリッドは中央に常時表示されます。
        </p>

        <div className="row" style={{ marginBottom: 14 }}>
          <div className="field" style={{ flex: 1, minWidth: 200 }}>
            <label className="inline" style={{ gap: 6 }}>
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={cal.hide_future !== false}
                onChange={(e) => setHideFuture(e.target.checked)}
              />
              未来日付をデフォルトで非表示（カレンダー側のトグルで切替可能）
            </label>
          </div>
          <div className="field" style={{ minWidth: 200 }}>
            <label>消費税率（金額列の計算に使用）</label>
            <select
              value={String(cal.tax_rate ?? 0.08)}
              onChange={(e) => setTaxRate(Number(e.target.value))}
              style={{ width: 200 }}
            >
              <option value="0.08">8%（生鮮食品 軽減税率）</option>
              <option value="0.10">10%（標準税率）</option>
              <option value="0">非課税（0%）</option>
            </select>
          </div>
        </div>

        <div className="inline" style={{ marginBottom: 10, justifyContent: 'space-between' }}>
          <strong style={{ fontSize: 13 }}>
            カラム設定 — 左固定 {leftCount} 列 / 右サマリ {rightCount} 列
          </strong>
          <button className="ghost small" onClick={resetColumns}>
            初期状態に戻す
          </button>
        </div>

        <div className="row" style={{ gap: 18 }}>
          <div style={{ flex: 1, minWidth: 280 }}>
            <div className="muted" style={{ fontSize: 11, fontWeight: 600, marginBottom: 6, letterSpacing: '0.05em' }}>
              左固定列（横スクロール時に張り付き）
            </div>
            <div className="column-list">
              {columns
                .filter((c) => COLUMN_DEFS.find((d) => d.id === c.id)?.side === 'left')
                .map((c) => {
                  const def = COLUMN_DEFS.find((d) => d.id === c.id)!
                  return (
                    <div key={c.id} className={'column-row ' + (c.visible ? '' : 'disabled')}>
                      <input
                        type="checkbox"
                        style={{ width: 'auto' }}
                        checked={c.visible}
                        onChange={(e) => setVisible(c.id, e.target.checked)}
                      />
                      <span className="col-label">{def.label}</span>
                      <select
                        className="emphasis"
                        value={c.emphasis ?? 'none'}
                        onChange={(e) => setEmphasis(c.id, e.target.value as EmphasisColor)}
                      >
                        {emphasisOptions.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                      <div className="order-btns">
                        <button className="secondary" onClick={() => moveCol(c.id, -1)} title="上へ">▲</button>
                        <button className="secondary" onClick={() => moveCol(c.id, +1)} title="下へ">▼</button>
                      </div>
                    </div>
                  )
                })}
            </div>
          </div>

          <div style={{ flex: 1, minWidth: 280 }}>
            <div className="muted" style={{ fontSize: 11, fontWeight: 600, marginBottom: 6, letterSpacing: '0.05em' }}>
              右サマリ列
            </div>
            <div className="column-list">
              {columns
                .filter((c) => COLUMN_DEFS.find((d) => d.id === c.id)?.side === 'right')
                .map((c) => {
                  const def = COLUMN_DEFS.find((d) => d.id === c.id)!
                  return (
                    <div key={c.id} className={'column-row ' + (c.visible ? '' : 'disabled')}>
                      <input
                        type="checkbox"
                        style={{ width: 'auto' }}
                        checked={c.visible}
                        onChange={(e) => setVisible(c.id, e.target.checked)}
                      />
                      <span className="col-label">{def.label}</span>
                      <select
                        className="emphasis"
                        value={c.emphasis ?? 'none'}
                        onChange={(e) => setEmphasis(c.id, e.target.value as EmphasisColor)}
                      >
                        {emphasisOptions.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                      <div className="order-btns">
                        <button className="secondary" onClick={() => moveCol(c.id, -1)} title="上へ">▲</button>
                        <button className="secondary" onClick={() => moveCol(c.id, +1)} title="下へ">▼</button>
                      </div>
                    </div>
                  )
                })}
            </div>
          </div>
        </div>
      </div>

    </div>
  )
}

/** デバイストークン表示・引継ぎ用 URL 生成・ログアウト */
function DeviceTokenPanel() {
  const { user, logout } = useAuth()
  const dialog = useDialog()
  const token = getToken() ?? ''
  const [show, setShow] = useState(false)
  const [copyMsg, setCopyMsg] = useState<string | null>(null)

  // 引継ぎ URL = 現在ドメイン + /?token=XXX
  const handoverUrl = token
    ? `${window.location.origin}/?token=${encodeURIComponent(token)}`
    : ''
  const maskedToken = token
    ? token.slice(0, 4) + '・'.repeat(8) + token.slice(-4)
    : ''

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopyMsg(`${label} をコピーしました`)
      setTimeout(() => setCopyMsg(null), 2000)
    } catch {
      setCopyMsg('コピーに失敗しました (手動で選択してください)')
    }
  }

  return (
    <div className="panel">
      <h3>デバイス認証</h3>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        ログイン中: <strong>{user?.display_name ?? '不明'}</strong>
        {user?.role && ` (${user.role})`}
      </div>
      {copyMsg && <div className="alert info" style={{ marginBottom: 10 }}>{copyMsg}</div>}

      <div className="field">
        <label>このデバイスのトークン</label>
        <div className="inline" style={{ gap: 6 }}>
          <input
            readOnly
            value={show ? token : maskedToken}
            style={{ fontFamily: 'var(--font-mono)', flex: 1 }}
            onClick={(e) => show && (e.target as HTMLInputElement).select()}
          />
          <button type="button" className="secondary small"
            onClick={() => setShow((s) => !s)}>
            {show ? '隠す' : '表示'}
          </button>
          <button type="button" className="secondary small"
            onClick={() => copy(token, 'トークン')}
            disabled={!token}>
            📋 コピー
          </button>
        </div>
      </div>

      <div className="field">
        <label>引継ぎ URL (別ブラウザ・別端末で 1 回開けばログイン状態を引き継げます)</label>
        <div className="inline" style={{ gap: 6 }}>
          <input
            readOnly
            value={show ? handoverUrl : handoverUrl.replace(/token=.*$/, 'token=・・・')}
            style={{ fontFamily: 'var(--font-mono)', flex: 1, fontSize: 11 }}
            onClick={(e) => show && (e.target as HTMLInputElement).select()}
          />
          <button type="button" className="secondary small"
            onClick={() => copy(handoverUrl, '引継ぎ URL')}
            disabled={!handoverUrl}>
            📋 コピー
          </button>
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
          ※ この URL を開くと自動でログインされます。共有相手が同じ権限になるので、信頼できる端末でのみ使ってください。
        </div>
      </div>

      <div className="inline" style={{ marginTop: 12 }}>
        <button type="button" className="ghost small"
          onClick={async () => {
            if (await dialog.confirm({
              title: 'ログアウト',
              message: 'このデバイスからログアウトします。\n再度入るには新規登録またはトークン貼り付けが必要です。',
              okLabel: 'ログアウト',
              variant: 'warn',
            })) logout()
          }}
        >
          🚪 このデバイスからログアウト
        </button>
      </div>
    </div>
  )
}
