import { lazy, Suspense, useEffect } from 'react'
import { Navigate, Route, Routes, useParams } from 'react-router-dom'
import { useAuth } from './auth/AuthContext'
import Layout from './components/Layout'

// 認証前 に 表示 する ページ は eager import (初回 ロード で 必ず 1 つは 出す)
import RegisterPage from './pages/RegisterPage'
import PendingPage from './pages/PendingPage'

// 認証後 の ページ は lazy load (bundle code-split で 初期 ロード を 軽く)。
// 初回 アクセス 時 に 該当 ページ の chunk だけ ダウンロード される。
const DashboardPage           = lazy(() => import('./pages/DashboardPage'))
const InboundPage             = lazy(() => import('./pages/InboundPage'))
const OutboundPage            = lazy(() => import('./pages/OutboundPage'))
const CalendarPage            = lazy(() => import('./pages/CalendarPage'))
const MonthlyClosePage        = lazy(() => import('./pages/MonthlyClosePage'))
const MastersPage             = lazy(() => import('./pages/MastersPage'))
const DevicesPage             = lazy(() => import('./pages/DevicesPage'))
const AuditPage               = lazy(() => import('./pages/AuditPage'))
const SettingsPage            = lazy(() => import('./pages/SettingsPage'))
const MaterialsStockPage      = lazy(() => import('./pages/MaterialsStockPage'))
const MaterialsCalendarPage   = lazy(() => import('./pages/MaterialsCalendarPage'))
const MaterialInboundPage     = lazy(() => import('./pages/MaterialInboundPage'))
const ShipmentsListPage       = lazy(() => import('./pages/ShipmentsListPage'))
const ShipmentsCalendarPage   = lazy(() => import('./pages/ShipmentsCalendarPage'))
const ShipmentRegisterPage    = lazy(() => import('./pages/ShipmentRegisterPage'))
const ShipmentRecipesPage     = lazy(() => import('./pages/ShipmentRecipesPage'))
// ShipmentRecipesBulkPage は M3 2026-05 で 廃止 (アンケート調査が 上位互換)
// RecipeEstimationPage は 2026-05 で 廃止 (推定モード = 常時 自動推定 に 統合)
const AssetsManagementPage    = lazy(() => import('./pages/AssetsManagementPage'))
const SelectionPage           = lazy(() => import('./pages/SelectionPage'))
const SemifinishedPage        = lazy(() => import('./pages/SemifinishedPage'))
const RecipeSurveyPublicPage  = lazy(() => import('./pages/RecipeSurveyPublicPage'))
const GarlicNrHubPage         = lazy(() => import('./pages/GarlicNrHubPage'))
const SpecCalendarPage        = lazy(() => import('./pages/SpecCalendarPage'))
const CalendarPrintPage       = lazy(() => import('./pages/CalendarPrintPage'))
const DashboardPrintPage      = lazy(() => import('./pages/DashboardPrintPage'))
const RecipeSurveyReviewPage  = lazy(() => import('./pages/RecipeSurveyReviewPage'))
const ArchivePage             = lazy(() => import('./pages/ArchivePage'))
const StorageLayoutsPage      = lazy(() => import('./pages/StorageLayoutsPage'))
const StorageLayoutEditorPage = lazy(() => import('./pages/StorageLayoutEditorPage'))
const StorageLayoutSheetPage  = lazy(() => import('./pages/StorageLayoutSheetPage'))

// crop_id ↔ 作物 (crops テーブル)
const GINGER     = 1  // 生姜   (1部)
const GARLIC     = 2  // 大蒜
const YAMAIMO    = 3  // 長芋   (3部)
const GOBO       = 4  // 牛蒡   (4部)
const SATSUMAIMO = 5  // 薩摩芋 (5部)
const GARLIC_EXP = 12 // 大蒜(実験) — 2026-05-20 棚卸調整用 (migration 057)

/** 公開 商品別資材使用状況集計 ラッパー — URL の :divisionCode を fixedDivision に 渡す */
function PublicRecipesByProductWrapper() {
  const { divisionCode } = useParams<{ divisionCode: string }>()
  const div = Number(divisionCode)
  if (!Number.isFinite(div) || div < 1) return <Navigate to="/" replace />
  return <ShipmentRecipesPage fixedDivision={div} authMode="public" />
}

export default function App() {
  const { status, isAdmin } = useAuth()

  // ブラウザ標準の右クリックメニューをアプリ全体で抑止 (業務アプリ仕様)。
  // ただし input / textarea ではコピー&ペースト等のメニューが必要なので除外。
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (!t) return
      const tag = t.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if ((t as HTMLElement).isContentEditable) return
      e.preventDefault()
    }
    document.addEventListener('contextmenu', handler)
    return () => document.removeEventListener('contextmenu', handler)
  }, [])

  // 公開ページ (認証不要) — pathname を見て auth ゲートを通過させる
  // /recipe-survey/{division}             = 担当者向け 資材アンケート 公開フォーム
  // /recipe-survey/{division}/by-product  = 商品別 資材使用状況集計 (公開版) — 2026-05-25
  const publicPath = window.location.pathname.startsWith('/recipe-survey/')
  if (publicPath) {
    return (
      <Suspense fallback={<div className="auth-screen"><div className="muted">読み込み中…</div></div>}>
        <Routes>
          <Route path="/recipe-survey/:divisionCode/by-product"
                 element={<PublicRecipesByProductWrapper />} />
          <Route path="/recipe-survey/:divisionCode" element={<RecipeSurveyPublicPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    )
  }

  if (status === 'loading') {
    return (
      <div className="auth-screen">
        <div className="muted">読み込み中…</div>
      </div>
    )
  }
  if (status === 'anonymous') return <RegisterPage />
  if (status === 'pending') return <PendingPage />

  // /print/* は Layout なし (ナビ・サイドバー無し、 紙レポート専用)
  if (window.location.pathname.startsWith('/print/')) {
    return (
      <Suspense fallback={<div className="auth-screen"><div className="muted">読み込み中…</div></div>}>
        <Routes>
          <Route path="/print/calendar" element={<CalendarPrintPage />} />
          <Route path="/print/dashboard" element={<DashboardPrintPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    )
  }

  // authenticated
  return (
    <Layout>
      <Suspense fallback={<div className="muted" style={{ padding: 20 }}>読み込み中…</div>}>
      <Routes>
        {/* 生姜原料タブ（既存ルート） */}
        <Route path="/" element={<DashboardPage cropId={GINGER} />} />
        <Route path="/calendar" element={<CalendarPage cropId={GINGER} />} />
        <Route path="/inbound" element={<InboundPage cropId={GINGER} />} />
        <Route path="/outbound" element={<OutboundPage cropId={GINGER} />} />
        {/* /prices ルートは廃止 (在庫一覧で直接編集) */}
        <Route path="/semifinished" element={<SemifinishedPage cropId={GINGER} />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route
          path="/monthly-close"
          element={isAdmin ? <MonthlyClosePage /> : <Navigate to="/" replace />}
        />
        <Route
          path="/masters"
          element={isAdmin ? <MastersPage /> : <Navigate to="/" replace />}
        />
        <Route
          path="/devices"
          element={isAdmin ? <DevicesPage /> : <Navigate to="/" replace />}
        />
        <Route
          path="/audit"
          element={isAdmin ? <AuditPage /> : <Navigate to="/" replace />}
        />
        <Route
          path="/archive"
          element={isAdmin ? <ArchivePage cropId={GINGER} /> : <Navigate to="/" replace />}
        />
        <Route
          path="/garlic/archive"
          element={isAdmin ? <ArchivePage cropId={GARLIC} /> : <Navigate to="/" replace />}
        />
        <Route
          path="/yamaimo/archive"
          element={isAdmin ? <ArchivePage cropId={YAMAIMO} /> : <Navigate to="/" replace />}
        />
        <Route
          path="/gobo/archive"
          element={isAdmin ? <ArchivePage cropId={GOBO} /> : <Navigate to="/" replace />}
        />
        <Route
          path="/satsumaimo/archive"
          element={isAdmin ? <ArchivePage cropId={SATSUMAIMO} /> : <Navigate to="/" replace />}
        />
        {/* レシピ提案レビュー (admin) */}
        <Route
          path="/admin/recipe-submissions"
          element={isAdmin ? <RecipeSurveyReviewPage /> : <Navigate to="/" replace />}
        />

        {/* 大蒜原料タブ */}
        {/*   通常 = sub_kind が NULL かつ origin が 田子 以外
                  ・ 黒ニンニク (sub_kind=black) を除外
                  ・ 田子産 (= 「半製品」 名義の別ページ) を除外 */}
        <Route path="/garlic" element={
          <DashboardPage cropId={GARLIC} subKind="normal" excludeOriginName="田子" />
        } />
        <Route path="/garlic/calendar" element={
          <CalendarPage cropId={GARLIC} subKind="normal" excludeOriginName="田子" />
        } />
        <Route path="/garlic/inbound" element={<InboundPage cropId={GARLIC} />} />
        <Route path="/garlic/outbound" element={<OutboundPage cropId={GARLIC} />} />
        {/* 黒ニンニク (sub_kind=black) */}
        <Route path="/garlic/black" element={
          <DashboardPage cropId={GARLIC} subKind="black" pageTitle="黒ニンニク 在庫一覧" />
        } />
        <Route path="/garlic/black/calendar" element={
          <CalendarPage cropId={GARLIC} subKind="black" title="黒ニンニク 日次カレンダー" />
        } />
        {/* 「田子産台帳」 — 田子 origin の 大蒜ロット を 独立表示する 原料台帳。
            (旧称 「半製品」 — Mission 5 で 本来の 半製品台帳 を 別途新設 する ため
             名称衝突 を 避け 「田子産台帳」 に 改名)
            新規入庫の登録は不可 (UI 上 別途禁止)、 出庫は 通常通り 可能。 */}
        <Route path="/garlic/tago" element={
          <DashboardPage cropId={GARLIC} originName="田子" pageTitle="大蒜 田子産台帳" />
        } />
        <Route path="/garlic/tago/calendar" element={
          <CalendarPage cropId={GARLIC} originName="田子" title="田子産台帳 日次カレンダー" />
        } />
        {/* 旧 /garlic/semifin URL を 新 /garlic/tago にリダイレクト (ブックマーク互換) */}
        <Route path="/garlic/semifin" element={<Navigate to="/garlic/tago" replace />} />
        <Route path="/garlic/semifin/calendar" element={<Navigate to="/garlic/tago/calendar" replace />} />
        {/* 大蒜本番から 選別 + 半製品 を 大蒜実験へ 移管 (2026-05) — 旧 URL は実験版にリダイレクト */}
        <Route path="/garlic/semifinished" element={<Navigate to="/garlic-exp/semifinished" replace />} />
        <Route path="/garlic/selection"    element={<Navigate to="/garlic-exp/selection" replace />} />
        <Route
          path="/garlic/monthly-close"
          element={isAdmin ? <MonthlyClosePage /> : <Navigate to="/garlic" replace />}
        />
        {/* 原材料計算・振替出庫 ハブ (1ページ + タブ集約) */}
        <Route
          path="/garlic/nr"
          element={<GarlicNrHubPage isAdmin={isAdmin} />}
        />
        {/* 規格別 日次カレンダー — 作物別 (各作物台帳に1つ) */}
        <Route path="/spec-calendar"            element={<SpecCalendarPage cropId={GINGER} />} />
        <Route path="/garlic/spec-calendar"     element={<SpecCalendarPage cropId={GARLIC} />} />
        <Route path="/garlic-exp/spec-calendar" element={<SpecCalendarPage cropId={GARLIC_EXP} />} />
        <Route path="/yamaimo/spec-calendar"    element={<SpecCalendarPage cropId={YAMAIMO} />} />
        <Route path="/gobo/spec-calendar"       element={<SpecCalendarPage cropId={GOBO} />} />
        <Route path="/satsumaimo/spec-calendar" element={<SpecCalendarPage cropId={SATSUMAIMO} />} />
        {/* 旧 個別ページ URL → ハブ の 該当タブ に リダイレクト (ブックマーク互換) */}
        <Route path="/garlic/nr-report" element={<Navigate to="/garlic/nr?tab=nr" replace />} />
        <Route path="/garlic/substitution-outbound" element={<Navigate to="/garlic/nr?tab=outbound" replace />} />
        <Route path="/garlic/substitution-history" element={<Navigate to="/garlic/nr?tab=history" replace />} />
        <Route path="/garlic/outbound-report" element={<Navigate to="/garlic/nr?tab=report" replace />} />
        <Route path="/garlic/substitution-rules" element={<Navigate to="/garlic/nr?tab=rules" replace />} />
        <Route path="/garlic/bom" element={<Navigate to="/garlic/nr?tab=bom" replace />} />

        {/* ===== 大蒜(実験) crop_id=12 — 棚卸調整 sandbox ===== */}
        {/* ライブの crop_id=2 とは完全独立の複製。 ここでの編集は本番には影響しない。
            ルートは /garlic と同パターンを /garlic-exp プレフィックスで提供。 */}
        <Route path="/garlic-exp" element={
          <DashboardPage cropId={GARLIC_EXP} subKind="normal" excludeOriginName="田子"
                          pageTitle="大蒜(実験) 在庫一覧" />
        } />
        <Route path="/garlic-exp/calendar" element={
          <CalendarPage cropId={GARLIC_EXP} subKind="normal" excludeOriginName="田子"
                         title="大蒜(実験) 日次カレンダー" />
        } />
        <Route path="/garlic-exp/inbound" element={<InboundPage cropId={GARLIC_EXP} />} />
        <Route path="/garlic-exp/outbound" element={<OutboundPage cropId={GARLIC_EXP} />} />
        <Route path="/garlic-exp/black" element={
          <DashboardPage cropId={GARLIC_EXP} subKind="black" pageTitle="大蒜(実験) 黒ニンニク 在庫一覧" />
        } />
        <Route path="/garlic-exp/black/calendar" element={
          <CalendarPage cropId={GARLIC_EXP} subKind="black" title="大蒜(実験) 黒ニンニク 日次カレンダー" />
        } />
        <Route path="/garlic-exp/tago" element={
          <DashboardPage cropId={GARLIC_EXP} originName="田子" pageTitle="大蒜(実験) 田子産台帳" />
        } />
        <Route path="/garlic-exp/tago/calendar" element={
          <CalendarPage cropId={GARLIC_EXP} originName="田子" title="大蒜(実験) 田子産台帳 日次カレンダー" />
        } />
        {/* 旧 /garlic-exp/semifin → /garlic-exp/tago リダイレクト */}
        <Route path="/garlic-exp/semifin" element={<Navigate to="/garlic-exp/tago" replace />} />
        <Route path="/garlic-exp/semifin/calendar" element={<Navigate to="/garlic-exp/tago/calendar" replace />} />
        {/* 半製品台帳 — 選別出力先 (semifinished_lots ベース) */}
        <Route path="/garlic-exp/semifinished" element={<SemifinishedPage cropId={GARLIC_EXP} />} />
        {/* 選別機能 — 大蒜実験のみ (2026-05 で 本番から移管) */}
        <Route
          path="/garlic-exp/selection"
          element={isAdmin ? <SelectionPage cropId={GARLIC_EXP} /> : <Navigate to="/garlic-exp" replace />}
        />
        <Route
          path="/garlic-exp/monthly-close"
          element={isAdmin ? <MonthlyClosePage /> : <Navigate to="/garlic-exp" replace />}
        />
        <Route
          path="/garlic-exp/archive"
          element={isAdmin ? <ArchivePage cropId={GARLIC_EXP} /> : <Navigate to="/garlic-exp" replace />}
        />

        {/* 長芋原料タブ (事業3部) */}
        <Route path="/yamaimo" element={<DashboardPage cropId={YAMAIMO} />} />
        <Route path="/yamaimo/calendar" element={<CalendarPage cropId={YAMAIMO} />} />
        <Route path="/yamaimo/inbound" element={<InboundPage cropId={YAMAIMO} />} />
        <Route path="/yamaimo/outbound" element={<OutboundPage cropId={YAMAIMO} />} />
        {/* 長芋は 半製品台帳 を 持たない (2026-05 仕様変更) — 旧 URL は在庫一覧へ */}
        <Route path="/yamaimo/semifinished" element={<Navigate to="/yamaimo" replace />} />
        <Route
          path="/yamaimo/monthly-close"
          element={isAdmin ? <MonthlyClosePage /> : <Navigate to="/yamaimo" replace />}
        />

        {/* 牛蒡原料タブ (事業4部) */}
        <Route path="/gobo" element={<DashboardPage cropId={GOBO} />} />
        <Route path="/gobo/calendar" element={<CalendarPage cropId={GOBO} />} />
        <Route path="/gobo/inbound" element={<InboundPage cropId={GOBO} />} />
        <Route path="/gobo/outbound" element={<OutboundPage cropId={GOBO} />} />
        {/* 牛蒡は 半製品台帳 を 持たない (2026-05 仕様変更) — 旧 URL は在庫一覧へ */}
        <Route path="/gobo/semifinished" element={<Navigate to="/gobo" replace />} />
        <Route
          path="/gobo/monthly-close"
          element={isAdmin ? <MonthlyClosePage /> : <Navigate to="/gobo" replace />}
        />

        {/* 薩摩芋原料タブ (事業5部) */}
        <Route path="/satsumaimo" element={<DashboardPage cropId={SATSUMAIMO} />} />
        <Route path="/satsumaimo/calendar" element={<CalendarPage cropId={SATSUMAIMO} />} />
        <Route path="/satsumaimo/inbound" element={<InboundPage cropId={SATSUMAIMO} />} />
        <Route path="/satsumaimo/outbound" element={<OutboundPage cropId={SATSUMAIMO} />} />
        {/* 薩摩芋は 半製品台帳 を 持たない (2026-05 仕様変更) — 旧 URL は在庫一覧へ */}
        <Route path="/satsumaimo/semifinished" element={<Navigate to="/satsumaimo" replace />} />
        <Route
          path="/satsumaimo/monthly-close"
          element={isAdmin ? <MonthlyClosePage /> : <Navigate to="/satsumaimo" replace />}
        />

        {/* 資材管理タブ */}
        <Route path="/materials" element={<MaterialsStockPage />} />
        <Route path="/materials/calendar" element={<MaterialsCalendarPage />} />
        <Route path="/materials/inbound" element={<MaterialInboundPage />} />
        {/* 固定資産管理 (M2 2026-05) — コンテナ/パレット/スチール */}
        <Route path="/materials/assets" element={<AssetsManagementPage />} />
        {/* 内部 (認証付き) アンケート — 資材タブから アクセス、 5 事業部別 (M3 2026-05) */}
        <Route path="/materials/survey/:divisionCode"
               element={<RecipeSurveyPublicPage authMode="private" />} />
        <Route
          path="/storage/material"
          element={<StorageLayoutsPage targetKind="material" />}
        />
        <Route
          path="/storage/material/:id"
          element={<StorageLayoutEditorPage targetKind="material" />}
        />
        <Route
          path="/storage/material/:id/sheet"
          element={<StorageLayoutSheetPage targetKind="material" />}
        />

        {/* 原料置き場レイアウト（各作物タブ配下からアクセス。
            半製品も同じレイアウト内でオブジェクト紐付けモード切替で扱う）*/}
        <Route
          path="/storage/ingredient"
          element={<StorageLayoutsPage targetKind="ingredient" />}
        />
        <Route
          path="/storage/ingredient/:id"
          element={<StorageLayoutEditorPage targetKind="ingredient" />}
        />
        <Route
          path="/storage/ingredient/:id/sheet"
          element={<StorageLayoutSheetPage targetKind="ingredient" />}
        />
        {/* 商品出荷タブ */}
        <Route path="/shipments" element={<ShipmentsListPage />} />
        <Route path="/shipments/calendar" element={<ShipmentsCalendarPage />} />
        <Route path="/shipments/register" element={<ShipmentRegisterPage />} />
        <Route
          path="/shipments/recipes"
          element={isAdmin ? <ShipmentRecipesPage /> : <Navigate to="/shipments" replace />}
        />
        {/* 商品レシピ編集 — 5 事業部別 (2026-05 追加)。 各担当 が 自部署 のみ 編集可。
            admin の場合 全事業部 を 個別に 開ける。 */}
        {[1, 2, 3, 4, 5].map((d) => (
          <Route
            key={`recipes-${d}`}
            path={`/shipments/recipes/${d}`}
            element={isAdmin
              ? <ShipmentRecipesPage fixedDivision={d} />
              : <Navigate to="/shipments" replace />}
          />
        ))}
        {/* レシピ一括編集 は 廃止 (アンケート調査 が 上位互換、 M3 2026-05) — 旧URL は アンケート 事業1部 へ */}
        <Route path="/shipments/recipes/bulk"
               element={<Navigate to="/materials/survey/1" replace />} />
        {/* 推定モードは 廃止 (常時 自動推定 に 統合) — 旧URL は 月次締めへ */}
        <Route path="/shipments/recipes/estimate"
               element={<Navigate to="/monthly-close" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </Suspense>
    </Layout>
  )
}
