/**
 * GarlicNrHubPage
 * ================
 * NR 原材料計算 を ハブ に、 振替系 機能 を 1 ページ + タブ に 集約。
 *
 * タブ:
 *   原材料計算   — 商品期間集計 取込 → BOM展開 → 振替シミュレーション (NrReportPage)
 *   振替出庫     — 単発 振替出庫 (SubstitutionOutboundPage)
 *   出庫履歴     — 振替出庫 履歴 / グループ管理 (SubstitutionHistoryPage)
 *   出庫レポート — 過去日付 の 日次出庫レポート (OutboundReportPage)
 *   振替ルール   — 振替ルール マスタ (SubstitutionRulesPage, admin)
 *   商品BOM      — 商品 BOM マスタ (ProductBomPage, admin)
 *
 * URL: /garlic/nr?tab=<id>  (タブ は クエリパラメータ で 深リンク可)
 *
 * UX 設計:
 *   - lazy mount + keep-alive: 一度開いた タブ は アンマウント せず、
 *     display:none で 隠す。 これにより NR で 取込 した Excel ファイル や
 *     振替出庫 の 入力中 フォーム が タブ切替 で 消えない。
 *     初期負荷 対策: 訪問前 の タブ は マウント しない (Set で 追跡)。
 *   - ARIA tablist 準拠: role=tablist / tab / tabpanel + 矢印キー で 移動可
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import NrReportPage from './NrReportPage'
import SubstitutionOutboundPage from './SubstitutionOutboundPage'
import SubstitutionHistoryPage from './SubstitutionHistoryPage'
import OutboundReportPage from './OutboundReportPage'
import SubstitutionRulesPage from './SubstitutionRulesPage'
import ProductBomPage from './ProductBomPage'
import GarlicLedgerSyncPage from './GarlicLedgerSyncPage'

interface TabDef {
  id: string
  label: string
  render: () => React.ReactNode
  adminOnly?: boolean
}

const TABS: TabDef[] = [
  { id: 'nr',         label: 'NR 原材料計算',  render: () => <NrReportPage /> },
  { id: 'outbound',   label: '振替出庫',       render: () => <SubstitutionOutboundPage /> },
  { id: 'history',    label: '振替出庫履歴',   render: () => <SubstitutionHistoryPage /> },
  { id: 'report',     label: '出庫レポート',   render: () => <OutboundReportPage /> },
  { id: 'ledger-sync',label: 'Excel 台帳同期', render: () => <GarlicLedgerSyncPage /> },
  { id: 'rules',      label: '振替ルール',     render: () => <SubstitutionRulesPage />, adminOnly: true },
  { id: 'bom',        label: '商品 BOM',       render: () => <ProductBomPage />,        adminOnly: true },
]

export default function GarlicNrHubPage({ isAdmin = true }: { isAdmin?: boolean }) {
  const [params, setParams] = useSearchParams()
  const visibleTabs = useMemo(
    () => TABS.filter(t => !t.adminOnly || isAdmin),
    [isAdmin],
  )
  const activeId = params.get('tab') ?? visibleTabs[0].id
  const active = visibleTabs.find(t => t.id === activeId) ?? visibleTabs[0]

  // 既に訪問した タブ ID の Set (lazy mount のため)
  // 初回は active タブ のみ。 タブ切替 ごとに 追加されていく。
  const [visited, setVisited] = useState<Set<string>>(() => new Set([active.id]))
  useEffect(() => {
    setVisited(prev => {
      if (prev.has(active.id)) return prev
      const next = new Set(prev)
      next.add(active.id)
      return next
    })
  }, [active.id])

  function selectTab(id: string) {
    const next = new URLSearchParams(params)
    next.set('tab', id)
    setParams(next, { replace: false })
  }

  // 矢印キー で タブ移動 (ARIA tablist 準拠)
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map())
  function onTabKeyDown(e: KeyboardEvent<HTMLButtonElement>, idx: number) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault()
    let nextIdx = idx
    if (e.key === 'ArrowLeft')  nextIdx = (idx - 1 + visibleTabs.length) % visibleTabs.length
    if (e.key === 'ArrowRight') nextIdx = (idx + 1) % visibleTabs.length
    if (e.key === 'Home')       nextIdx = 0
    if (e.key === 'End')        nextIdx = visibleTabs.length - 1
    const next = visibleTabs[nextIdx]
    selectTab(next.id)
    tabRefs.current.get(next.id)?.focus()
  }

  return (
    <div className="page" style={{ paddingTop: 0 }}>
      <h2 style={{ marginBottom: 8 }}>大蒜 原材料計算・振替出庫</h2>

      {/* サブタブ バー (ARIA tablist) */}
      <div
        role="tablist"
        aria-label="大蒜 原材料計算 機能"
        style={{
          display: 'flex', gap: 2, borderBottom: '2px solid #ccc',
          marginBottom: 12, flexWrap: 'wrap',
        }}
      >
        {visibleTabs.map((t, idx) => {
          const isActive = t.id === active.id
          return (
            <button
              key={t.id}
              ref={(el) => {
                if (el) tabRefs.current.set(t.id, el)
                else tabRefs.current.delete(t.id)
              }}
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={isActive}
              aria-controls={`tabpanel-${t.id}`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => selectTab(t.id)}
              onKeyDown={(e) => onTabKeyDown(e, idx)}
              style={{
                padding: '8px 16px', fontSize: 14,
                border: 'none', cursor: 'pointer',
                borderBottom: isActive ? '3px solid #c0392b' : '3px solid transparent',
                background: isActive ? '#fff' : '#f0f0f0',
                fontWeight: isActive ? 700 : 400,
                color: isActive ? '#c0392b' : '#555',
                marginBottom: -2,
                borderRadius: '6px 6px 0 0',
              }}
            >
              {t.label}
            </button>
          )
        })}
      </div>

      {/* タブ内容: 訪問済 の タブは アンマウント せず display で 切替 */}
      {visibleTabs.map(t => {
        if (!visited.has(t.id)) return null
        const isActive = t.id === active.id
        return (
          <div
            key={t.id}
            role="tabpanel"
            id={`tabpanel-${t.id}`}
            aria-labelledby={`tab-${t.id}`}
            hidden={!isActive}
            style={{ display: isActive ? 'block' : 'none' }}
          >
            {t.render()}
          </div>
        )
      })}
    </div>
  )
}
