/**
 * FabNav — 十字アコーディオン式 ナビゲーション
 *
 * 仕様:
 *   - 左上に 1 つの トリガー ボタン (Menu アイコン)
 *   - クリックで 半透明オーバーレイ展開、 横に 部門アイコン列
 *   - 部門選択中はその下に 縦に ページ メニューが垂れ下がる
 *   - 別の部門を選ぶと 前のメニューが折り畳まれ、 新部門の下に展開
 *   - 現在ページのセルをハイライト、 タップで遷移 + オーバーレイ閉じる
 *   - Esc / 背景クリックで閉じる
 */
import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Menu, X } from 'lucide-react'
import Tooltip from './Tooltip'
import { NavIcon, NAV_ICONS } from './NavIcon'

type IconName = keyof typeof NAV_ICONS
import { useAuth } from '../auth/AuthContext'
import { currentTab, type LedgerTab } from './TabBar'

interface PageItem {
  to: string
  label: string
  icon: IconName
  /** true なら admin のみ表示 */
  adminOnly?: boolean
  /** ホバー / タップで横に展開するサブメニュー (例: 黒ニンニク / 田子産) */
  flyout?: { to: string; label: string; icon: IconName }[]
}

interface Division {
  key: LedgerTab
  label: string
  shortLabel: string         // 部門アイコン下の短い名 (生姜・大蒜 等)
  icon: IconName
  basePath: string           // 部門のトップ ('/garlic' 等)
  pages: PageItem[]
  /** ingredient タブ系 (生姜〜薩摩芋) で、 選別あり = 大蒜のみ */
  hasSelection?: boolean
}

/** ingredient (作物) 系の共通ページ ファクトリ
 *
 * 半製品台帳の運用方針 (2026-05 仕様変更):
 *   - 表示するのは 生姜 (cropFromKey='ginger') と 大蒜実験 ('garlic_exp') のみ
 *   - 大蒜本番 / 長芋 / 牛蒡 / 薩摩芋 では 非表示
 *   - 運用方法も作物別:
 *     - 生姜: 出庫済 lot から手動登録 (中間保管用)
 *     - 大蒜実験: 選別出力先 (自動登録)
 *
 * 選別機能 (hasSelection):
 *   - 大蒜実験 のみ (旧 大蒜本番 にあったが 2026-05 で 移管)
 */
function ingredientPages(base: string, opts: {
  hasSelection?: boolean
  cropFromKey: string
  showSemifinished?: boolean   // false → 半製品台帳 nav 項目を出さない
}): PageItem[] {
  const b = base === '/' ? '' : base
  const from = `?from=${opts.cropFromKey}`
  // 規格別 日次カレンダー は 在庫一覧 ページ内 の 折りたたみ セクション に 移設済み
  // (独立ナビ項目 は 持たない)
  const showSemi = opts.showSemifinished ?? false
  return [
    { to: base,                       label: '在庫一覧',         icon: 'inventory' },
    { to: `${b}/calendar`,            label: '日次カレンダー',   icon: 'calendar' },
    { to: `${b}/inbound`,             label: '入庫登録',         icon: 'inbound' },
    { to: `${b}/outbound`,            label: '出庫・引き当て',   icon: 'outbound' },
    ...(showSemi
      ? [{ to: `${b}/semifinished`, label: '半製品台帳', icon: 'semifinished' as IconName }]
      : []),
    { to: `/storage/ingredient${from}`, label: '置き場レイアウト', icon: 'storage' },
    ...(opts.hasSelection
      ? [{ to: `${b}/selection`, label: '選別（仕分け）', icon: 'selection' as IconName, adminOnly: true }]
      : []),
    { to: `${b}/monthly-close`,       label: '月次締め',         icon: 'monthlyClose', adminOnly: true },
    { to: `${b}/archive`,             label: 'ロットのアーカイブ', icon: 'archive', adminOnly: true },
  ]
}

const DIVISIONS: Division[] = [
  {
    key: 'ginger', label: '生姜原料', shortLabel: '生姜', icon: 'inventory', basePath: '/',
    pages: ingredientPages('/', { cropFromKey: 'ginger', showSemifinished: true }),
  },
  {
    key: 'garlic', label: '大蒜原料', shortLabel: '大蒜', icon: 'inventory', basePath: '/garlic',
    // 2026-05 仕様変更: 大蒜本番 から 選別 / 半製品 機能を 削除 (= 大蒜実験 に 移管)。
    // hasSelection / showSemifinished は false (= 出さない)。
    // 大蒜は サブ分類 (通常 / 黒ニンニク / 田子産) を「在庫一覧」 / 「日次カレンダー」 に
    // 横展開サブメニュー として アタッチ。
    pages: (() => {
      const base = ingredientPages('/garlic', { cropFromKey: 'garlic' })
      // base[0] = 在庫一覧, base[1] = 日次カレンダー に flyout を付与
      const withFlyout = base.map((p, i): PageItem => {
        if (i === 0) {
          return {
            ...p,
            // 通常も flyout の一員 (= 親クリック=flyout、 明示選択を強制)
            flyout: [
              { to: '/garlic',         label: '通常 (黒・田子除外)', icon: 'inventory' as IconName },
              { to: '/garlic/black',   label: '黒ニンニク',            icon: 'inventory' as IconName },
              { to: '/garlic/tago',    label: '田子産台帳',            icon: 'inventory' as IconName },
            ],
          }
        }
        if (i === 1) {
          return {
            ...p,
            flyout: [
              { to: '/garlic/calendar',          label: '通常 (黒・田子除外)', icon: 'calendar' as IconName },
              { to: '/garlic/black/calendar',    label: '黒ニンニク',            icon: 'calendar' as IconName },
              { to: '/garlic/tago/calendar',     label: '田子産台帳',            icon: 'calendar' as IconName },
            ],
          }
        }
        return p
      })
      // 原材料計算・振替出庫 ハブ (= NR/振替/履歴/レポート/ルール/BOM を 1 ページに集約)
      // を archive の 直前に 挿入
      const archiveIdx = withFlyout.findIndex(p => p.to === '/garlic/archive')
      const subItems: PageItem[] = [
        { to: '/garlic/nr', label: '原材料計算・振替', icon: 'recipesEstimate' as IconName },
      ]
      if (archiveIdx >= 0) {
        withFlyout.splice(archiveIdx, 0, ...subItems)
      } else {
        withFlyout.push(...subItems)
      }
      return withFlyout
    })(),
  },
  {
    key: 'garlic_exp', label: '大蒜(実験)', shortLabel: '実験', icon: 'inventory', basePath: '/garlic-exp',
    // 大蒜の棚卸調整用 sandbox (migration 057)。
    // 2026-05 仕様変更: 大蒜本番 から 選別 + 半製品台帳 を 移管。
    pages: (() => {
      const base = ingredientPages('/garlic-exp', {
        cropFromKey: 'garlic_exp',
        hasSelection: true,      // 選別機能 は 実験 で のみ 稼働
        showSemifinished: true,  // 半製品台帳 = 選別出力先 として 利用
      })
      const withFlyout = base.map((p, i): PageItem => {
        if (i === 0) {
          return {
            ...p,
            flyout: [
              { to: '/garlic-exp',         label: '通常 (黒・田子除外)', icon: 'inventory' as IconName },
              { to: '/garlic-exp/black',   label: '黒ニンニク',            icon: 'inventory' as IconName },
              { to: '/garlic-exp/tago',    label: '田子産台帳',            icon: 'inventory' as IconName },
            ],
          }
        }
        if (i === 1) {
          return {
            ...p,
            flyout: [
              { to: '/garlic-exp/calendar',          label: '通常 (黒・田子除外)', icon: 'calendar' as IconName },
              { to: '/garlic-exp/black/calendar',    label: '黒ニンニク',            icon: 'calendar' as IconName },
              { to: '/garlic-exp/tago/calendar',     label: '田子産台帳',            icon: 'calendar' as IconName },
            ],
          }
        }
        return p
      })
      return withFlyout
    })(),
  },
  {
    key: 'yamaimo', label: '長芋原料', shortLabel: '長芋', icon: 'inventory', basePath: '/yamaimo',
    pages: ingredientPages('/yamaimo', { cropFromKey: 'yamaimo' }),
  },
  {
    key: 'gobo', label: '牛蒡原料', shortLabel: '牛蒡', icon: 'inventory', basePath: '/gobo',
    pages: ingredientPages('/gobo', { cropFromKey: 'gobo' }),
  },
  {
    key: 'satsumaimo', label: '薩摩芋原料', shortLabel: '薩摩芋', icon: 'inventory', basePath: '/satsumaimo',
    pages: ingredientPages('/satsumaimo', { cropFromKey: 'satsumaimo' }),
  },
  {
    key: 'materials', label: '資材管理', shortLabel: '資材', icon: 'materials', basePath: '/materials',
    pages: [
      { to: '/materials',          label: '資材一覧',       icon: 'materials' },
      { to: '/materials/calendar', label: '日次カレンダー', icon: 'calendar' },
      { to: '/materials/inbound',  label: '入荷登録',       icon: 'inbound' },
      { to: '/storage/material',   label: '置き場レイアウト', icon: 'storage' },
      // 固定資産管理 (M2 2026-05) — コンテナ/パレット/スチール
      { to: '/materials/assets',   label: '固定資産管理', icon: 'materials' },
      // 2026-05 追加: アンケート調査 (5 事業部別 ドリルダウン)。 旧公開URL は 並行運用。
      {
        to: '/materials/survey/1', label: 'アンケート調査', icon: 'recipesBulk',
        flyout: [
          { to: '/materials/survey/1', label: '事業1部 (生姜)',   icon: 'recipesBulk' as IconName },
          { to: '/materials/survey/2', label: '事業2部 (大蒜)',   icon: 'recipesBulk' as IconName },
          { to: '/materials/survey/3', label: '事業3部 (長芋)',   icon: 'recipesBulk' as IconName },
          { to: '/materials/survey/4', label: '事業4部 (牛蒡)',   icon: 'recipesBulk' as IconName },
          { to: '/materials/survey/5', label: '事業5部 (薩摩芋)', icon: 'recipesBulk' as IconName },
        ],
      },
      // 「レシピ一括編集」 は M3 2026-05 で 廃止 (アンケート調査 が 上位互換)
    ],
  },
  {
    key: 'shipments', label: '商品出荷', shortLabel: '商品', icon: 'shipments', basePath: '/shipments',
    pages: [
      { to: '/shipments',                    label: '出荷一覧',       icon: 'shipments' },
      { to: '/shipments/calendar',           label: '日次カレンダー', icon: 'calendar' },
      { to: '/shipments/register',           label: '出荷登録',       icon: 'register' },
      {
        to: '/shipments/recipes/1', label: '商品別資材使用状況調査', icon: 'recipes', adminOnly: true,
        flyout: [
          { to: '/shipments/recipes/1', label: '事業1部 (生姜)',   icon: 'recipes' as IconName },
          { to: '/shipments/recipes/2', label: '事業2部 (大蒜)',   icon: 'recipes' as IconName },
          { to: '/shipments/recipes/3', label: '事業3部 (長芋)',   icon: 'recipes' as IconName },
          { to: '/shipments/recipes/4', label: '事業4部 (牛蒡)',   icon: 'recipes' as IconName },
          { to: '/shipments/recipes/5', label: '事業5部 (薩摩芋)', icon: 'recipes' as IconName },
          { to: '/shipments/recipes',   label: '全事業部 (admin)', icon: 'recipes' as IconName },
        ],
      },
      // 「レシピ推定」 nav は 廃止 (2026-05 で 月次棚卸 が 自動推定に 統合)
    ],
  },
  {
    key: 'masters', label: 'マスタ管理', shortLabel: 'マスタ', icon: 'masters', basePath: '/masters',
    pages: [
      { to: '/masters', label: 'マスタ一覧', icon: 'masters' },
    ],
  },
]

/** 共通ナビ (タブ非依存) を 「共通」 部門として 9 番目に追加 */
const COMMON_DIVISION: Division = {
  key: 'common' as LedgerTab,   // 型は強引だが特殊扱い
  label: '共通', shortLabel: '共通', icon: 'settings', basePath: '',
  pages: [
    { to: '/settings',                    label: 'カスタマイズ',       icon: 'settings' },
    { to: '/admin/recipe-submissions',    label: 'レシピ提案レビュー', icon: 'recipeReview', adminOnly: true },
    { to: '/devices',                     label: 'デバイス管理',       icon: 'devices', adminOnly: true },
    { to: '/audit',                       label: '監査ログ・訂正履歴', icon: 'audit', adminOnly: true },
  ],
}

const ALL_DIVISIONS = [...DIVISIONS, COMMON_DIVISION]

export default function FabNav() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const { isAdmin } = useAuth()
  const activeTab = currentTab(pathname)
  const [open, setOpen] = useState(false)
  // 展開中の部門 (open 時は activeTab がデフォルト)
  const [expandedKey, setExpandedKey] = useState<string>(activeTab)
  const containerRef = useRef<HTMLDivElement>(null)
  // 各部門ボタンの ref (ドロップダウンの位置計算用)
  const btnRefs = useRef<Map<string, HTMLButtonElement>>(new Map())
  // ドロップダウンの位置 (px、 viewport 座標)
  const [dropdownPos, setDropdownPos] = useState<{ left: number; top: number } | null>(null)

  // open 時に expandedKey をリセット (activeTab に合わせる)
  useEffect(() => {
    if (open) setExpandedKey(activeTab)
  }, [open, activeTab])

  // expandedKey 変化 / open 時に ドロップダウン位置を計算
  useEffect(() => {
    if (!open) { setDropdownPos(null); return }
    // 次フレームで btn ref の rect を取得 (DOM 反映後)
    const id = window.requestAnimationFrame(() => {
      const btn = btnRefs.current.get(expandedKey)
      if (!btn) return
      const r = btn.getBoundingClientRect()
      setDropdownPos({ left: r.left, top: r.bottom + 8 })
    })
    return () => window.cancelAnimationFrame(id)
  }, [open, expandedKey])

  // Esc で閉じる
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  function goTo(to: string) {
    navigate(to)
    setOpen(false)
  }

  // 展開中の部門の pages を取得
  const expandedDiv = ALL_DIVISIONS.find(d => d.key === expandedKey) ?? ALL_DIVISIONS[0]
  const visiblePages = expandedDiv.pages.filter(p => !p.adminOnly || isAdmin)

  return (
    <>
      {/* トリガー (左上 FAB) */}
      <Tooltip content={open ? 'メニューを閉じる (Esc)' : 'メニューを開く'} side="right">
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          aria-label="メイン ナビゲーション"
          aria-expanded={open}
          style={{
            position: 'fixed', top: 14, left: 14, zIndex: 1001,
            width: 44, height: 44, borderRadius: 12,
            background: open ? 'var(--primary, #1F4E79)' : 'var(--panel)',
            color: open ? '#fff' : 'var(--text)',
            border: '1px solid var(--border-strong, #999)',
            boxShadow: '0 2px 8px rgba(20, 18, 14, 0.10)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer',
            transition: 'background 0.15s, color 0.15s',
          }}
        >
          {open ? <X size={20} strokeWidth={1.8} /> : <Menu size={20} strokeWidth={1.8} />}
        </button>
      </Tooltip>

      {open && (
        <div
          ref={containerRef}
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false) }}
          style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'rgba(20, 18, 14, 0.42)',
            backdropFilter: 'blur(4px)',
            WebkitBackdropFilter: 'blur(4px)',
            animation: 'fabnav-fade-in 0.16s ease-out',
          }}
        >
          {/* 部門 横帯 (FAB ボタンに干渉しない位置に固定) */}
          <div
            style={{
              position: 'absolute', top: 72, left: 14, right: 14,
              display: 'flex', gap: 6,
              overflowX: 'auto', overflowY: 'visible',
              padding: '4px 2px',
              scrollbarWidth: 'thin',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {ALL_DIVISIONS.map((d) => {
              const isExpanded = d.key === expandedKey
              const isActive = d.key === activeTab
              return (
                <button
                  key={d.key}
                  ref={(el) => {
                    if (el) btnRefs.current.set(d.key, el)
                    else    btnRefs.current.delete(d.key)
                  }}
                  type="button"
                  onClick={() => setExpandedKey(d.key)}
                  aria-pressed={isExpanded}
                  aria-current={isActive ? 'page' : undefined}
                  style={{
                    width: 76, height: 76, borderRadius: 12,
                    background: isExpanded ? 'var(--primary, #1F4E79)' : 'var(--panel)',
                    color: isExpanded ? '#fff' : 'var(--text)',
                    border: '2px solid ' + (isActive ? 'var(--primary, #1F4E79)' : 'transparent'),
                    cursor: 'pointer',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                    gap: 4, padding: 6,
                    transition: 'background 0.15s, color 0.15s',
                    boxShadow: isExpanded ? '0 4px 12px rgba(20, 18, 14, 0.16)' : '0 1px 3px rgba(0,0,0,0.08)',
                    flex: '0 0 auto',
                  }}
                >
                  <NavIcon name={d.icon} />
                  <span style={{ fontSize: 11, fontWeight: 600, lineHeight: 1 }}>{d.shortLabel}</span>
                </button>
              )
            })}
          </div>

          {/* ドロップダウン (部門の下、 viewport 座標で 自由配置 — strip の overflow に影響されない) */}
          {dropdownPos && (
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                position: 'fixed',
                left: dropdownPos.left,
                top: dropdownPos.top,
                background: 'var(--panel)',
                border: '1px solid var(--border-strong, #999)',
                borderRadius: 10,
                boxShadow: '0 8px 24px rgba(20, 18, 14, 0.18)',
                minWidth: 220, maxWidth: 'min(360px, calc(100vw - 32px))',
                maxHeight: 'calc(100vh - ' + (dropdownPos.top + 24) + 'px)',
                overflowY: 'auto',
                overflowX: 'visible',
                padding: 4,
                animation: 'fabnav-drop 0.18s cubic-bezier(.16,.84,.4,1)',
                transformOrigin: 'top left',
                zIndex: 1002,
              }}
            >
              {visiblePages.length === 0 && (
                <div style={{ padding: 12, color: 'var(--muted)', fontSize: 12, textAlign: 'center' }}>
                  メニュー無し
                </div>
              )}
              {visiblePages.map((p) => (
                <PageRow
                  key={p.to}
                  page={p}
                  pathname={pathname}
                  onNavigate={goTo}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <style>{`
        @keyframes fabnav-fade-in {
          from { opacity: 0; } to { opacity: 1; }
        }
        @keyframes fabnav-drop {
          from { opacity: 0; transform: translateY(-8px) scaleY(0.9); }
          to   { opacity: 1; transform: translateY(0) scaleY(1); }
        }
        @keyframes fabnav-flyout {
          from { opacity: 0; transform: translateX(-8px); }
          to   { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </>
  )
}


/**
 * PageRow — ページ行 (+ 横展開 サブメニュー対応)
 *
 * page.flyout がある場合、 ホバー / クリック で 右側に サブメニューが現れる。
 * 親ページ自体をクリックすると 親ページに遷移。
 * サブメニューを ホバーしながら 親ページから離れても サブメニューが消えないように
 * 開閉制御。
 */
function PageRow({ page, pathname, onNavigate }: {
  page: PageItem
  pathname: string
  onNavigate: (to: string) => void
}) {
  const hasFlyout = !!page.flyout
  // flyout 親の場合 isCurrent は flyout のいずれかが現在ページかどうか
  const isCurrent = hasFlyout
    ? page.flyout!.some(sub => pathname === sub.to
        || (sub.to !== '/' && pathname.startsWith(sub.to + '/')))
    : pathname === page.to
      || (page.to !== '/' && pathname.startsWith(page.to + '/'))
      || (page.to === '/' && pathname === '/')
  const [flyoutOpen, setFlyoutOpen] = useState(false)
  const [flyoutPos, setFlyoutPos] = useState<{ left: number; top: number } | null>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const closeTimerRef = useRef<number | null>(null)

  function computeAndOpen() {
    if (closeTimerRef.current) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
    const el = rowRef.current
    if (el) {
      const r = el.getBoundingClientRect()
      // 右側に flyout を出す、 ただし viewport 右端を超えそうなら 親の上に
      const flyoutWidth = 200
      const left = r.right + 6 + flyoutWidth < window.innerWidth
        ? r.right + 6
        : Math.max(8, r.left - flyoutWidth - 6)
      setFlyoutPos({ left, top: r.top })
    }
    setFlyoutOpen(true)
  }
  function scheduleClose() {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = window.setTimeout(() => {
      setFlyoutOpen(false)
      closeTimerRef.current = null
    }, 200)
  }

  // 親クリック動作: flyout があれば flyout を toggle、 無ければ navigate
  function handleParentClick() {
    if (hasFlyout) {
      if (flyoutOpen) {
        setFlyoutOpen(false)
        if (closeTimerRef.current) { window.clearTimeout(closeTimerRef.current); closeTimerRef.current = null }
      } else {
        computeAndOpen()
      }
    } else {
      onNavigate(page.to)
    }
  }

  return (
    <div
      ref={rowRef}
      onMouseEnter={hasFlyout ? computeAndOpen : undefined}
      onMouseLeave={hasFlyout ? scheduleClose : undefined}
    >
      <button
        type="button"
        onClick={handleParentClick}
        aria-current={isCurrent ? 'page' : undefined}
        aria-expanded={hasFlyout ? flyoutOpen : undefined}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          width: '100%',
          padding: '10px 12px',
          border: 'none',
          borderRadius: 6,
          background: isCurrent ? 'var(--primary, #1F4E79)' : 'transparent',
          color: isCurrent ? '#fff' : 'var(--text)',
          fontSize: 13, fontWeight: isCurrent ? 600 : 400,
          cursor: 'pointer',
          textAlign: 'left',
          transition: 'background 0.12s',
        }}
        onMouseEnter={(e) => {
          if (!isCurrent) e.currentTarget.style.background = 'var(--hover-bg, rgba(0,0,0,0.06))'
        }}
        onMouseLeave={(e) => {
          if (!isCurrent) e.currentTarget.style.background = 'transparent'
        }}
      >
        <NavIcon name={page.icon} />
        <span style={{ flex: 1 }}>{page.label}</span>
        {page.flyout && (
          <span aria-hidden style={{ fontSize: 12, color: isCurrent ? '#fff' : 'var(--muted)' }}>▸</span>
        )}
      </button>
      {/* 横展開 サブメニュー — position: fixed で 親 overflow 影響なし */}
      {page.flyout && flyoutOpen && flyoutPos && (
        <div
          onMouseEnter={computeAndOpen}
          onMouseLeave={scheduleClose}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            left: flyoutPos.left,
            top: flyoutPos.top,
            background: 'var(--panel)',
            border: '1px solid var(--border-strong, #999)',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(20, 18, 14, 0.18)',
            minWidth: 180,
            padding: 4,
            animation: 'fabnav-flyout 0.14s cubic-bezier(.16,.84,.4,1)',
            zIndex: 1003,
          }}
        >
          {page.flyout.map((sub) => {
            const subCurrent = pathname === sub.to
              || (sub.to !== '/' && pathname.startsWith(sub.to + '/'))
            return (
              <button
                key={sub.to}
                type="button"
                onClick={() => onNavigate(sub.to)}
                aria-current={subCurrent ? 'page' : undefined}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  width: '100%',
                  padding: '9px 12px',
                  border: 'none',
                  borderRadius: 5,
                  background: subCurrent ? 'var(--primary)' : 'transparent',
                  color: subCurrent ? '#fff' : 'var(--text)',
                  fontSize: 12, fontWeight: subCurrent ? 600 : 400,
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
                onMouseEnter={(e) => {
                  if (!subCurrent) e.currentTarget.style.background = 'var(--hover-bg, rgba(0,0,0,0.06))'
                }}
                onMouseLeave={(e) => {
                  if (!subCurrent) e.currentTarget.style.background = 'transparent'
                }}
              >
                <NavIcon name={sub.icon} />
                <span style={{ flex: 1 }}>{sub.label}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
