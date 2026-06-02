/**
 * GarlicLedgerSyncPage
 * ====================
 * 大蒜 事業2部 の 旧 Excel 仕入管理台帳 (.xlsm) を システム在庫データ で 同期。
 *
 * 操作 フロー:
 *   1. .xlsm を 選択
 *   2. 月 を 指定 (デフォルト = 当月)
 *   3. 「プレビュー」 ボタン → dry_run=true で 警告 ・ サマリ確認
 *   4. 「実行」 ボタン → dry_run=false で 同期 + .xlsm ダウンロード
 *
 * 触る 列  : col 17 (前月繰越/当月入荷) col 18 (出庫) col 19 (在庫) col 20 (在庫額) col 24-54 (日付列)
 * 触らない列: col 21 (棚卸数 数式) col 22 (差数 数式) col 23 (差数原因 手入力)
 * 既存 VBA マクロ は 保持。
 */
import { useState, type ChangeEvent } from 'react'
import { Upload, Download, FileSpreadsheet, CheckCircle, AlertTriangle } from 'lucide-react'
import { api } from '../api/client'
import { errorText } from '../lib/format'

interface SheetSummary {
  updated: number
  appended: number
  unmatched_excel: number
  system_total: number
  excel_total: number
}

interface SyncResult {
  sheets: Record<string, SheetSummary>
  warnings: string[]
  master_warnings: string[]
}

function currentMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export default function GarlicLedgerSyncPage() {
  const [file, setFile] = useState<File | null>(null)
  const [month, setMonth] = useState<string>(currentMonth())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<SyncResult | null>(null)
  const [executed, setExecuted] = useState<SyncResult | null>(null)

  function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null
    setFile(f)
    setPreview(null); setExecuted(null); setError(null)
  }

  async function doPreview() {
    if (!file) return
    setBusy(true); setError(null); setExecuted(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('month', month)
      fd.append('dry_run', 'true')
      const result = await api.upload<SyncResult>('/garlic/ledger-sync', fd)
      setPreview(result)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  async function doExecute() {
    if (!file) return
    setBusy(true); setError(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('month', month)
      fd.append('dry_run', 'false')
      // バイナリ返却 (xlsm) → blob で受け取り、 ヘッダから サマリ JSON を 取得
      const { blob, headers } = await api.postBlobWithHeaders('/garlic/ledger-sync', fd)
      // X-Sync-Result-Base64 ヘッダ から サマリ復元
      const b64 = headers.get('X-Sync-Result-Base64')
      if (b64) {
        try {
          const decoded = decodeURIComponent(escape(atob(b64)))
          setExecuted(JSON.parse(decoded))
        } catch { /* ignore */ }
      }
      // ダウンロード トリガー
      const fname = extractFilename(headers.get('Content-Disposition')) ?? `garlic_ledger_synced_${month}.xlsm`
      triggerDownload(blob, fname)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const total = preview ?? executed
  return (
    <div style={{ maxWidth: 920, margin: '0 auto', padding: 16 }}>
      <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <FileSpreadsheet size={20} /> 大蒜 仕入管理台帳 同期
      </h2>
      <p className="muted" style={{ fontSize: 13 }}>
        旧 Excel ファイル (.xlsm) を アップロード し、 システム の 在庫データ で 当月分 を 更新。
        棚卸列 (S/T/U) や VBA マクロ は 触りません。
      </p>

      {/* 入力 */}
      <div className="card" style={{ marginTop: 12 }}>
        <div className="row" style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="field" style={{ flex: 2, minWidth: 280 }}>
            <label>Excel ファイル (.xlsm) *</label>
            <input
              type="file" accept=".xlsm,.xlsx"
              onChange={onFileChange} disabled={busy}
              style={{ fontSize: 13 }}
            />
            {file && (
              <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                {file.name} ({(file.size / 1024).toFixed(1)} KB)
              </div>
            )}
          </div>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label>同期対象月 *</label>
            <input
              type="month" value={month}
              onChange={(e) => setMonth(e.target.value)}
              disabled={busy}
            />
          </div>
        </div>

        <div className="inline" style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <button
            type="button" className="secondary"
            onClick={doPreview} disabled={!file || busy || !month}
          >
            <Upload size={14} style={{ marginRight: 4 }} />
            {busy ? '処理中…' : 'プレビュー (dry-run)'}
          </button>
          <button
            type="button"
            onClick={doExecute} disabled={!file || busy || !month}
          >
            <Download size={14} style={{ marginRight: 4 }} />
            実行 (.xlsm ダウンロード)
          </button>
        </div>

        {error && (
          <div className="alert error" style={{ marginTop: 10, fontSize: 12 }}>
            {error}
          </div>
        )}
      </div>

      {/* 結果 */}
      {total && (
        <div className="card" style={{ marginTop: 12 }}>
          <h3 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
            <CheckCircle size={16} color="#16a34a" />
            {executed ? '同期完了' : 'プレビュー結果'}
          </h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--surface-soft, #F1F5F9)' }}>
                <th style={{ padding: '6px 8px', textAlign: 'left' }}>シート</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>システム lot</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>Excel 既存行</th>
                <th style={{ padding: '6px 8px', textAlign: 'right', color: '#0369a1' }}>更新</th>
                <th style={{ padding: '6px 8px', textAlign: 'right', color: '#16a34a' }}>追加</th>
                <th style={{ padding: '6px 8px', textAlign: 'right', color: 'var(--muted)' }}>Excel のみ</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(total.sheets).map(([name, s]) => (
                <tr key={name} style={{ borderTop: '1px solid var(--divider)' }}>
                  <td style={{ padding: '6px 8px', fontWeight: 600 }}>{name}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right' }}>{s.system_total}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right' }}>{s.excel_total}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 600 }}>{s.updated}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 600 }}>{s.appended}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right' }}>{s.unmatched_excel}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {total.master_warnings.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#92400E', fontWeight: 600, fontSize: 13 }}>
                <AlertTriangle size={14} /> マスタ未登録 警告 ({total.master_warnings.length} 件)
              </div>
              <div style={{
                background: '#FEF3C7', padding: '8px 12px', borderRadius: 6,
                marginTop: 4, fontSize: 11.5, maxHeight: 200, overflowY: 'auto',
              }}>
                {total.master_warnings.map((w, i) => (
                  <div key={i} style={{ padding: '2px 0' }}>・{w}</div>
                ))}
              </div>
              <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                Excel 側 の M仕入先 / M産地 / M規格 シート に 該当値 が ないため、
                VBA マクロ が これらを 参照 する 場合 lookup が 失敗 する 可能性。
                Excel を 開いて M シート を 編集するか、 システム側 表記を 修正してください。
              </div>
            </div>
          )}

          {total.warnings.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ color: '#DC2626', fontWeight: 600, fontSize: 13 }}>
                エラー ({total.warnings.length})
              </div>
              <ul style={{ marginTop: 4, fontSize: 12 }}>
                {total.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          )}

          {!preview && executed && (
            <div className="muted" style={{ fontSize: 11.5, marginTop: 10 }}>
              ダウンロードされた .xlsm を 開いて 内容を 確認してください。 オリジナル ファイル は 変更されません。
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function extractFilename(disposition: string | null): string | null {
  if (!disposition) return null
  // RFC 5987 形式: filename*=UTF-8''xxx
  const m1 = disposition.match(/filename\*=UTF-8''([^;]+)/i)
  if (m1) {
    try { return decodeURIComponent(m1[1]) } catch { /* ignore */ }
  }
  const m2 = disposition.match(/filename="?([^";]+)"?/i)
  return m2 ? m2[1] : null
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
