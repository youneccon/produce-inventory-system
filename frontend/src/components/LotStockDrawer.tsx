/**
 * LotStockDrawer
 * ===============
 * 在庫一覧 (DashboardPage) で 行を クリック した際 に 右側 から 出てくる
 * ロット詳細 drawer。 識別情報・数量・単価・ステータス を 縦に 並べて 表示。
 *
 * 旧: DashboardPage.tsx 内 に inline 定義 されていたが、 ファイルが 1300+ 行 に
 *     肥大化 していたため 独立コンポーネント に 切り出した。
 *
 * 使い方:
 *   {selectedLot && <LotStockDrawer lot={selectedLot} onClose={() => setLot(null)} />}
 *
 * 内部 sub-components:
 *   - DrawerSection: 「識別情報」 等の 見出し付きグループ
 *   - DrawerKV: ラベル + 値 の 1 行 (右寄せ)
 */
import type { ReactNode } from 'react'
import { num, yen, ymd, formatGrade } from '../lib/format'
import LotCodeBadge from './LotCodeBadge'
import type { LotStock } from '../api/types'

interface Props {
  lot: LotStock | null
  onClose: () => void
}

export default function LotStockDrawer({ lot, onClose }: Props) {
  if (!lot) return null

  const n = (v: string | number | null | undefined): number => {
    if (v == null || v === '') return 0
    const x = typeof v === 'string' ? Number(v) : v
    return Number.isFinite(x) ? x : 0
  }
  const total_kg = n(lot.total_kg)
  const kg_per_case = n(lot.kg_per_case)
  const cases = n(lot.cases)
  const remaining = n(lot.remaining_kg)
  const base_kg = n(lot.base_kg)
  const outbound = n(lot.total_outbound_kg)
  const unit_price = n(lot.unit_price)
  const stock_value = lot.stock_value ? n(lot.stock_value) : null
  // 入荷日からの経過日数
  let daysOld: number | null = null
  if (lot.inbound_date) {
    daysOld = Math.floor((Date.now() - new Date(lot.inbound_date).getTime()) / 86_400_000)
  }

  return (
    <div
      role="dialog"
      aria-label="ロット詳細"
      style={{
        // z-index: 1500 — 右上アバター (.user-pill-avatar, z=999) と FabNav (z=1003) より上
        // でないと 閉じるボタン が アバター に被られて押せない
        position: 'fixed', top: 0, right: 0, bottom: 0,
        width: 320, zIndex: 1500, background: '#fff',
        borderLeft: '1px solid var(--border)',
        boxShadow: '-4px 0 16px rgba(0,0,0,0.08)',
        display: 'flex', flexDirection: 'column',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div style={{
        padding: '12px 14px',
        borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 8,
        background: 'var(--surface, #f8f9fa)',
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>
            <LotCodeBadge code={lot.lot_code ?? String(lot.lot_id)}
              selectionId={lot.selection_id} />
          </div>
          <div className="muted" style={{ fontSize: 11 }}>
            {formatGrade(lot.spec_type, lot.grade_level, lot.size_label)}
            {' / '}{lot.origin_name ?? '—'}
          </div>
        </div>
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
      <div className="muted" style={{
        fontSize: 10, padding: '4px 14px',
        borderBottom: '1px solid var(--border)',
        background: '#fafbfc',
      }}>
        ↑↓: 前後ロット / Esc: 閉じる
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px', fontSize: 13 }}>
        <DrawerSection title="識別情報">
          <DrawerKV label="整理番号" v={lot.lot_code ?? `#${lot.lot_id}`} />
          <DrawerKV label="仕入先" v={lot.supplier_name ?? '—'} />
          <DrawerKV label="産地" v={lot.origin_name ?? '—'} />
          <DrawerKV label="規格" v={formatGrade(lot.spec_type, lot.grade_level, lot.size_label, { spaces: true })} />
          <DrawerKV label="入荷日" v={lot.inbound_date ? ymd(lot.inbound_date) : '—'} />
          {daysOld != null && (
            <DrawerKV label="経過日数" v={`${daysOld} 日`}
              highlight={daysOld >= 60} />
          )}
        </DrawerSection>

        <DrawerSection title="数量">
          <DrawerKV label="入庫量" v={`${num(total_kg, 0)} kg`} />
          <DrawerKV label="ケース数" v={cases > 0 ? `${num(cases, 1)} ケース` : '—'} />
          <DrawerKV label="kg/CS" v={kg_per_case > 0 ? num(kg_per_case, 2) : '—'} />
          {lot.base_date && (
            <DrawerKV label={`起点 (${ymd(lot.base_date)})`} v={`${num(base_kg, 0)} kg`} />
          )}
          <DrawerKV label="累計出庫" v={`${num(outbound, 0)} kg`} />
          <DrawerKV label="残量" v={`${num(remaining, 0)} kg`} highlight />
        </DrawerSection>

        <DrawerSection title="単価・在庫金額">
          {lot.is_price_pending ? (
            <DrawerKV label="単価" v="未確定" highlight />
          ) : (
            <>
              <DrawerKV label="単価" v={unit_price > 0 ? `${yen(unit_price)}/kg` : '—'} />
              <DrawerKV label="在庫評価額" v={stock_value != null ? yen(stock_value) : '—'} highlight />
            </>
          )}
        </DrawerSection>

        <DrawerSection title="ステータス">
          <DrawerKV label="在庫状態" v={
            lot.stock_status === 'available' ? '在庫あり'
            : lot.stock_status === 'low' ? '残少'
            : '在庫切れ'
          } />
          {lot.selection_id != null && (
            <DrawerKV label="由来" v={`選別 #${lot.selection_id}`} />
          )}
        </DrawerSection>
      </div>
    </div>
  )
}

function DrawerSection({ title, children }: { title: string; children: ReactNode }) {
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

function DrawerKV({ label, v, highlight }: { label: string; v: string; highlight?: boolean }) {
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
