/**
 * LotDetailDrawer
 * ================
 * CalendarPage で 行を クリック した際 に 右側 から 出てくる ロット詳細 drawer。
 * 識別情報 / 数量・単価 / 仕入コスト / 支払い / 月次サマリ / 棚卸 を 表示し、
 * 前払/後払 の 日付・金額 は インライン編集 可。
 *
 * 旧: CalendarPage.tsx 内 に inline 定義 されていたが、 ファイルが 1346 行 に
 *     肥大化 していたため 独立コンポーネント に 切り出した。
 *
 * 内部 sub-components (export しない):
 *   - Section: 見出し付きグループ
 *   - KV: ラベル + 値 の 1 行 (右寄せ)
 *   - EditableDateRow: 日付編集可 行 (前払日 / 後払日)
 *   - EditableMoneyRow: 金額編集可 行 (前払金額 / 後払金額)
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Pin } from 'lucide-react'
import { num, yen, ymd, formatGrade } from '../lib/format'
import type { CalendarLot } from '../api/types'

interface Props {
  lot: CalendarLot | null
  taxRate: number
  pinned: boolean
  onTogglePin: () => void
  onClose: () => void
  onPatch?: (lotId: number, patch: Record<string, unknown>) => Promise<void>
}

export default function LotDetailDrawer({
  lot, taxRate, pinned, onTogglePin, onClose, onPatch,
}: Props) {
  if (!lot) return null

  const numOr0 = (v: string | number | null | undefined): number => {
    if (v == null || v === '') return 0
    const x = typeof v === 'string' ? Number(v) : v
    return Number.isFinite(x) ? x : 0
  }
  const total_kg = numOr0(lot.total_kg)
  const kg_per_case = numOr0(lot.kg_per_case)
  const cases = kg_per_case > 0 ? total_kg / kg_per_case : null
  const unit_price = numOr0(lot.unit_price)
  const subtotal = unit_price > 0 ? total_kg * unit_price : null
  const tax = subtotal != null ? Math.round(subtotal * taxRate) : null
  const brokerage = numOr0(lot.brokerage_fee)
  const freight = numOr0(lot.freight_fee)
  const grand_total = subtotal != null && tax != null
    ? Math.round(subtotal + tax + brokerage + freight) : null
  const end_kg = numOr0(lot.end_kg)
  const end_value = unit_price > 0 ? Math.round(unit_price * end_kg) : null

  return (
    <div
      role="dialog"
      aria-label="ロット詳細"
      style={{
        // z-index: 1500 — 右上アバター (z=999) と FabNav (z=1003) より上
        position: 'fixed', top: 0, right: 0, bottom: 0,
        width: 320, zIndex: 1500,
        background: '#fff',
        borderLeft: '1px solid var(--border)',
        boxShadow: '-4px 0 16px rgba(0,0,0,0.08)',
        display: 'flex', flexDirection: 'column',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* ヘッダー */}
      <div style={{
        padding: '12px 14px',
        borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 8,
        background: 'var(--surface, #f8f9fa)',
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>
            {lot.lot_code ?? `#${lot.lot_id}`}
          </div>
          <div className="muted" style={{ fontSize: 11 }}>
            {formatGrade(lot.spec_type, lot.grade_level, lot.size_label)}
            {' / '}{lot.origin_name}
          </div>
        </div>
        <button type="button" onClick={onTogglePin}
          title={pinned ? 'ピン解除 (他行クリックで自動的に切替)' : 'ピン留め (他行クリックでも閉じない)'}
          aria-label={pinned ? 'ピン解除' : 'ピン留め'}
          style={{
            background: pinned ? 'var(--primary)' : '#fff',
            color: pinned ? '#fff' : 'var(--text, #333)',
            border: '1px solid ' + (pinned ? 'var(--primary)' : 'var(--border)'),
            borderRadius: 6, padding: '6px 8px', cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', minWidth: 32, minHeight: 32,
            justifyContent: 'center',
          }}><Pin size={14} strokeWidth={1.7} aria-hidden /></button>
        <button type="button" onClick={onClose}
          title="閉じる (Esc)"
          aria-label="閉じる"
          style={{
            background: '#fff', color: 'var(--text, #333)',
            border: '1px solid var(--border)',
            borderRadius: 4, padding: '6px 10px', fontSize: 16, fontWeight: 600,
            cursor: 'pointer', lineHeight: 1, minWidth: 32, minHeight: 32,
          }}>✕</button>
      </div>
      {/* キー操作ヒント */}
      <div className="muted" style={{
        fontSize: 10, padding: '4px 14px',
        borderBottom: '1px solid var(--border)',
        background: '#fafbfc',
      }}>
        ↑↓: 前後ロット / Esc: 閉じる
      </div>
      {/* ボディ */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px', fontSize: 13 }}>
        <Section title="識別情報">
          <KV label="整理番号" v={lot.lot_code ?? '—'} />
          <KV label="規格" v={formatGrade(lot.spec_type, lot.grade_level, lot.size_label, { spaces: true })} />
          <KV label="産地" v={lot.origin_name} />
          <KV label="仕入先" v={lot.supplier_name} />
          <KV label="入荷日" v={lot.inbound_date ? ymd(lot.inbound_date) : '—'} />
          {lot.selection_id != null && (
            <KV label="由来" v={`選別 #${lot.selection_id}`} />
          )}
        </Section>

        <Section title="数量・単価">
          <KV label="入庫量" v={`${num(total_kg, 1)} kg`} />
          <KV label="kg/CS" v={kg_per_case > 0 ? num(kg_per_case, 2) : '—'} />
          <KV label="ケース数" v={cases != null ? `${num(cases, 1)} ケース` : '—'} />
          <KV label="単価" v={unit_price > 0 ? `${yen(unit_price)}/kg` : '—'} />
        </Section>

        <Section title="仕入コスト">
          <KV label="税抜小計" v={subtotal != null ? yen(subtotal) : '—'} />
          <KV label="仲介手数料" v={brokerage > 0 ? yen(brokerage) : '—'} />
          <KV label="運賃" v={freight > 0 ? yen(freight) : '—'} />
          <KV label="消費税 (8%)" v={tax != null ? yen(tax) : '—'} />
          <KV label="合計金額" v={grand_total != null ? yen(grand_total) : '—'} highlight />
        </Section>

        <Section title="支払い">
          <EditableDateRow
            label="前払日" value={lot.prepay_date ?? null}
            onSave={v => onPatch?.(lot.lot_id, { prepay_date: v })}
            disabled={!onPatch}
          />
          <EditableMoneyRow
            label="前払金額" value={lot.prepay_amount ?? null}
            onSave={v => onPatch?.(lot.lot_id, { prepay_amount: v })}
            disabled={!onPatch}
          />
          <EditableDateRow
            label="後払日" value={lot.postpay_date ?? null}
            onSave={v => onPatch?.(lot.lot_id, { postpay_date: v })}
            disabled={!onPatch}
          />
          <EditableMoneyRow
            label="後払金額" value={lot.postpay_amount ?? null}
            onSave={v => onPatch?.(lot.lot_id, { postpay_amount: v })}
            disabled={!onPatch}
          />
        </Section>

        <Section title="月次サマリ">
          <KV label="前月繰越" v={`${num(numOr0(lot.carryover_kg), 0)} kg`} />
          <KV label="当月入荷" v={`${num(numOr0(lot.inbound_kg), 0)} kg`} />
          <KV label="当月出庫" v={`${num(numOr0(lot.outbound_kg), 0)} kg`} />
          <KV label="当月在庫" v={`${num(end_kg, 0)} kg`} highlight />
          <KV label="在庫評価額" v={end_value != null ? yen(end_value) : '—'} />
        </Section>

        {(lot.stocktake_kg != null || lot.stocktake_note) && (
          <Section title="月末棚卸">
            <KV label="棚卸数" v={lot.stocktake_kg != null ? `${num(numOr0(lot.stocktake_kg), 0)} kg` : '—'} />
            <KV label="差数" v={lot.stocktake_diff != null ? num(numOr0(lot.stocktake_diff), 0) : '—'} />
            {lot.stocktake_note && (
              <KV label="差数原因" v={lot.stocktake_note} />
            )}
          </Section>
        )}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{
        fontSize: 11, fontWeight: 700, color: 'var(--primary, #1a73e8)',
        textTransform: 'uppercase', letterSpacing: 0.5,
        marginBottom: 4, paddingBottom: 2,
        borderBottom: '1px solid var(--border)',
      }}>{title}</div>
      {children}
    </div>
  )
}

function KV({ label, v, highlight }: { label: string; v: string; highlight?: boolean }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'baseline', gap: 8,
      padding: '3px 0', fontSize: 12,
    }}>
      <span className="muted" style={{ minWidth: 80, fontSize: 11 }}>{label}</span>
      <span style={{
        flex: 1, textAlign: 'right',
        fontWeight: highlight ? 700 : 400,
        color: highlight ? 'var(--primary, #1a73e8)' : 'inherit',
        wordBreak: 'break-all',
      }}>{v}</span>
    </div>
  )
}

/** 詳細ドロワー の 編集可能 日付行 (= 前払日 / 後払日 用) */
function EditableDateRow({
  label, value, onSave, disabled,
}: {
  label: string
  value: string | null
  onSave: (v: string | null) => void | Promise<void>
  disabled?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [v, setV] = useState(value ?? '')
  useEffect(() => { setV(value ?? '') }, [value])

  if (disabled || !editing) {
    return (
      <div
        onClick={() => !disabled && setEditing(true)}
        style={{
          display: 'flex', alignItems: 'baseline', gap: 8,
          padding: '3px 0', fontSize: 12,
          cursor: disabled ? 'default' : 'pointer',
        }}
        title={disabled ? '' : 'クリックで編集'}
      >
        <span className="muted" style={{ minWidth: 80, fontSize: 11 }}>{label}</span>
        <span style={{ flex: 1, textAlign: 'right' }}>
          {value ? ymd(value) : <span className="muted">—</span>}
        </span>
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', fontSize: 12 }}>
      <span className="muted" style={{ minWidth: 80, fontSize: 11 }}>{label}</span>
      <input
        type="date" value={v} onChange={e => setV(e.target.value)}
        autoFocus style={{ flex: 1, fontSize: 12 }}
      />
      <button
        onClick={async () => { await onSave(v || null); setEditing(false) }}
        style={{ fontSize: 11 }}
      >保存</button>
      <button onClick={() => { setV(value ?? ''); setEditing(false) }} style={{ fontSize: 11 }}>×</button>
    </div>
  )
}

/** 詳細ドロワー の 編集可能 金額行 (= 前払金額 / 後払金額 用) */
function EditableMoneyRow({
  label, value, onSave, disabled,
}: {
  label: string
  value: string | null
  onSave: (v: number | null) => void | Promise<void>
  disabled?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [v, setV] = useState(value ?? '')
  useEffect(() => { setV(value ?? '') }, [value])

  if (disabled || !editing) {
    const n = value == null || value === '' ? null : Number(value)
    return (
      <div
        onClick={() => !disabled && setEditing(true)}
        style={{
          display: 'flex', alignItems: 'baseline', gap: 8,
          padding: '3px 0', fontSize: 12,
          cursor: disabled ? 'default' : 'pointer',
        }}
        title={disabled ? '' : 'クリックで編集'}
      >
        <span className="muted" style={{ minWidth: 80, fontSize: 11 }}>{label}</span>
        <span style={{ flex: 1, textAlign: 'right' }}>
          {n != null ? yen(n) : <span className="muted">—</span>}
        </span>
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', fontSize: 12 }}>
      <span className="muted" style={{ minWidth: 80, fontSize: 11 }}>{label}</span>
      <input
        type="number" value={v} onChange={e => setV(e.target.value)} step="1"
        autoFocus style={{ flex: 1, fontSize: 12, textAlign: 'right' }}
      />
      <button
        onClick={async () => {
          const n = v === '' ? null : Number(v)
          await onSave(Number.isFinite(n as number) ? n : null)
          setEditing(false)
        }}
        style={{ fontSize: 11 }}
      >保存</button>
      <button onClick={() => { setV(value ?? ''); setEditing(false) }} style={{ fontSize: 11 }}>×</button>
    </div>
  )
}
