"""
api/main.py
===========
在庫管理システム API のエントリポイント。

psycopg版（Python 3.14対応）。DB接続プールは api/dependencies.py に一元化。
入庫・在庫照会・マスタ登録・監査ログの各エンドポイントを定義する。
出庫・引き当ては api/routers/outbound.py のルーターに分離。
"""

from __future__ import annotations

import asyncio
import sys

# Windows では既定の ProactorEventLoop で psycopg の async が動かないため、
# uvicorn がイベントループを生成する前に SelectorEventLoop へ切り替える。
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

import re
import os
import unicodedata
from calendar import monthrange
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any
from uuid import UUID

from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, model_validator

from api.audit import write_audit
from api.auth import AdminUser, CurrentUser, OperatorUser
from api.dependencies import DB, lifespan
from api.routers import (
    assets, auth, client_logs, materials, nr_report, outbound, recipe_survey,
    selection, semifinished, shipments, storage, substitution,
)

# =============================================================================
# アプリケーション初期化
# =============================================================================

app = FastAPI(
    title="在庫管理システム API",
    version="1.0.0",
    lifespan=lifespan,
)


# =============================================================================
# /api プレフィックス strip middleware
# =============================================================================
# Frontend (api/client.ts) は `/api/<path>` で呼び、 Vite dev サーバー の
# proxy.rewrite が `/api` を 削除 してから FastAPI に 転送 する 構造。
# 本番 (FastAPI 直接 SPA 配信) では Vite が 介在 しない ので、
# 同じ rewrite を FastAPI 側 ASGI middleware で 行う。
# これにより:
#   - dev: ブラウザ /api/foo → Vite が /foo に rewrite → FastAPI /foo
#   - prod: ブラウザ /api/foo → middleware が /foo に rewrite → FastAPI /foo
# どちらも 同じ ルーティング で 動く。
# =============================================================================
class StripApiPrefixMiddleware:
    """`/api/foo` を `/foo` に rewrite する pure-ASGI middleware。"""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            path: str = scope.get("path", "")
            if path == "/api" or path.startswith("/api/"):
                new_path = path[4:] or "/"
                scope["path"] = new_path
                raw_path = scope.get("raw_path")
                if isinstance(raw_path, (bytes, bytearray)) and raw_path.startswith(b"/api"):
                    scope["raw_path"] = raw_path[4:] or b"/"
        await self.app(scope, receive, send)


app.add_middleware(StripApiPrefixMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("ALLOWED_ORIGINS", "http://localhost:3000").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(materials.router)
app.include_router(outbound.router)
app.include_router(selection.router)
app.include_router(semifinished.router)
app.include_router(shipments.router)
app.include_router(storage.router)
app.include_router(substitution.router)
app.include_router(substitution.report_router)
app.include_router(nr_report.bom_router)
app.include_router(nr_report.nr_router)
app.include_router(recipe_survey.public_router)
app.include_router(recipe_survey.admin_router)
app.include_router(recipe_survey.private_router)
app.include_router(assets.router)
app.include_router(client_logs.router)
app.include_router(client_logs.admin_router)

# アップロード画像の静的配信
_uploads_dir = Path(__file__).resolve().parent.parent / "uploads"
_uploads_dir.mkdir(parents=True, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=str(_uploads_dir)), name="uploads")


# =============================================================================
# Frontend (SPA) を 同一ポート で 配信 — 本番運用 (Tailscale Funnel 等) 用
# =============================================================================
# 環境変数 SERVE_FRONTEND=true で 有効化。
# frontend/dist を `npm run build` で 生成しておく必要あり。
#
# 配信ルール:
#   /api/*       → FastAPI ルーター (既登録)
#   /uploads/*   → 画像 (上で mount 済)
#   /assets/*    → SPA の hashed assets (静的)
#   /*           → SPA の index.html (= React Router で 解決)
#
# 開発時 (Vite dev サーバー 5173 で 動作中) は SERVE_FRONTEND=true を
# 立てない。 本番運用時のみ ON にする。
# =============================================================================
_SERVE_FRONTEND = os.environ.get("SERVE_FRONTEND", "").lower() in ("true", "1", "yes")
if _SERVE_FRONTEND:
    _dist_dir = Path(__file__).resolve().parent.parent / "frontend" / "dist"
    if not _dist_dir.exists():
        import logging as _logging
        _logging.getLogger(__name__).warning(
            "SERVE_FRONTEND=true だが frontend/dist が ない。 "
            "frontend で `npm run build` を 実行 してください: %s", _dist_dir,
        )
        _SERVE_FRONTEND = False
    else:
        # hashed assets (Vite の出力: dist/assets/index-*.js, index-*.css 等)
        _assets_dir = _dist_dir / "assets"
        if _assets_dir.exists():
            app.mount("/assets", StaticFiles(directory=str(_assets_dir)), name="spa_assets")
        # ルート直下の 静的ファイル (favicon 等)
        _public_files = {p.name for p in _dist_dir.iterdir() if p.is_file()}
        # 注意: SPA catch-all (`/{full_path:path}`) の 登録 は main.py の 末尾 で 行う。
        # FastAPI は 登録順 マッチング なので、 ここで 登録 すると 後続の @app.get(...) が
        # 全部 shadow されて 404→index.html に なる ため。


# =============================================================================
# Pydantic モデル
# =============================================================================

class SmartInputRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=500)


class SmartInputResult(BaseModel):
    supplier_name: str | None = None
    origin_name:   str | None = None
    spec_type:     str | None = None      # 規格（新物 / 親生姜 / 慣行（囲い）など）
    cases:         float | None = None    # ケース数
    kg_per_case:   float | None = None    # kg/ケース
    unit_price:    float | None = None    # 単価（円。任意）
    confidence:    str = "low"
    warnings:      list[str] = Field(default_factory=list)


class InboundLotCreate(BaseModel):
    product_id:   int
    supplier_id:  int
    inbound_date: date
    cases:        Decimal = Field(..., gt=0)
    kg_per_case:  Decimal = Field(..., gt=0)
    unit_price:   Decimal | None = Field(None, ge=0)
    note:         str | None = None
    use_reservation_id: int | None = None  # 予約番号を消費する場合に指定

    @model_validator(mode="after")
    def compute_total_kg(self) -> "InboundLotCreate":
        self._total_kg = self.cases * self.kg_per_case
        return self

    @property
    def total_kg(self) -> Decimal:
        return self._total_kg


class InboundLotResponse(BaseModel):
    id:                 int
    product_id:         int
    supplier_id:        int
    inbound_date:       date
    cases:              Decimal
    kg_per_case:        Decimal
    total_kg:           Decimal
    unit_price:         Decimal | None
    price_confirmed_at: datetime | None
    note:               str | None
    created_at:         datetime
    # 支払い関連 (在庫一覧でインライン編集)
    prepay_date:        date    | None = None
    prepay_amount:      Decimal | None = None
    postpay_date:       date    | None = None
    postpay_amount:     Decimal | None = None
    brokerage_fee:      Decimal | None = None
    freight_fee:        Decimal | None = None


class PriceUpdateRequest(BaseModel):
    unit_price: Decimal = Field(..., gt=0)
    note:       str | None = None


class InboundLotPatch(BaseModel):
    """入庫ロットの部分更新。空フィールドは変更しない。
    cases / kg_per_case を変更すると total_kg = cases * kg_per_case で再計算される。
    既に出庫済の数量より少なく出来ないため、出庫合計を下回る変更はバリデーション失敗。"""
    inbound_date:   date | None = None
    cases:          Decimal | None = Field(None, gt=0)
    kg_per_case:    Decimal | None = Field(None, gt=0)
    unit_price:     Decimal | None = Field(None, ge=0,
        description="0 を渡すと未確定に戻す")
    note:           str | None = None
    # 支払い関連 (在庫一覧でインライン編集対象)
    prepay_date:    date | None = None
    prepay_amount:  Decimal | None = Field(None, ge=0)
    postpay_date:   date | None = None
    postpay_amount: Decimal | None = Field(None, ge=0)
    brokerage_fee:  Decimal | None = Field(None, ge=0)
    freight_fee:    Decimal | None = Field(None, ge=0)


# -----------------------------------------------------------------------------
# 規格 (grade) 修正 専用 endpoint 用 (2026-05-30 追加)
# 入庫時 に 規格 を 取り違えた lot を 後 から 正規化 する。 admin のみ。
# product_id を 「(crop, new_grade, origin)」 の 組合 product に 切替 (= 既存
# なら 再利用、 なければ INSERT) し、 下流 (lot_stock view, 出庫レポート 等)
# は JOIN ベース で 自動 反映 する。 outbound_orders.from_grade_id 等 の snapshot
# は 修正 時 の 認識 を 履歴 保護 する ため 触ら ない。
# -----------------------------------------------------------------------------

class GradePatchRequest(BaseModel):
    grade_id: int = Field(..., gt=0)
    dry_run:  bool = False


class AffectedCounts(BaseModel):
    outbound_records:    int   # この lot の 出庫 履歴
    substitution_records: int  # うち 振替 経由 (order_id IS NOT NULL)
    storage_items:       int   # 倉庫 配置 (storage_object_items)
    stock_counts:        int   # 月次棚卸 履歴 (= 月次確定 を 兼ねる)


class GradePatchResponse(BaseModel):
    lot_id:              int
    old_grade_id:        int
    old_grade_label:     str
    new_grade_id:        int
    new_grade_label:     str
    old_product_id:      int
    new_product_id:      int        # dry_run + 新 product 未作成 の とき は 0
    new_product_created: bool
    affected:            AffectedCounts
    committed:           bool       # False = dry_run


class LotStockResponse(BaseModel):
    lot_id:            int
    lot_code:          str | None = None
    product_id:        int
    supplier_id:       int
    inbound_date:      date
    cases:             Decimal
    kg_per_case:       Decimal
    total_kg:          Decimal
    total_outbound_kg: Decimal      # 起点（前月繰越）日より後の出庫合計
    remaining_kg:      Decimal
    stock_status:      str
    stock_value:       Decimal | None
    is_price_pending:  bool
    unit_price:        Decimal | None
    base_kg:           Decimal      # 在庫算出の起点（前月繰越 or 入庫総量）
    base_date:         date | None  # 起点の棚卸日（NULL=棚卸なし）
    # 表示用に JOIN した属性
    selection_id:      int | None = None    # 選別由来のロットなら選別 ID (バッジ表示用)
    supplier_name:     str | None = None
    spec_type:         str | None = None
    grade_level:       str | None = None
    size_label:        str | None = None
    origin_name:       str | None = None
    crop_id:           int | None = None    # 紐付け先絞り込み用
    crop_name:         str | None = None
    # 支払い関連 (在庫一覧でインライン編集対象)
    prepay_date:       date    | None = None
    prepay_amount:     Decimal | None = None
    postpay_date:      date    | None = None
    postpay_amount:    Decimal | None = None
    brokerage_fee:     Decimal | None = None
    freight_fee:       Decimal | None = None
    # 選別由来ロットの 投入元 仕入先 / 産地 数 (>1 なら表示時「複数」 + ホバー詳細)
    selection_source_supplier_count: int | None = None
    selection_source_origin_count:   int | None = None
    # 置場 レイアウト 紐付け 済み 量 (= storage_object_items の capacity 合計)。
    # NULL capacity (無制限) は 0 扱い。 紐付け 可能 残数 = remaining_kg - bound_kg
    bound_kg:          Decimal = Decimal(0)


class DashboardSummary(BaseModel):
    """ダッシュボード用：3つの原始データと当月在庫の合計（仕様の3原始データ監視）。"""
    month:          str
    prev_month:     str
    carryover_kg:   Decimal   # 前月繰越 合計（前月末の棚卸確定値）
    inbound_kg:     Decimal   # 当月入荷 合計
    inbound_count:  int
    outbound_kg:    Decimal   # 当月出庫 合計
    outbound_count: int
    stock_now_kg:   Decimal   # 当月在庫 合計（= 前月繰越 + 当月入荷 − 当月出庫）


# --- Phase: 月次締め（実地棚卸 → 前月繰越の確定）---

class MonthlyCloseLot(BaseModel):
    lot_id:          int
    supplier_name:   str
    spec_type:       str
    origin_name:     str
    inbound_date:    date
    theoretical_kg:  Decimal        # 締め対象月末のシステム計算在庫
    already_counted: bool           # この月の棚卸が確定済みか
    counted_kg:      Decimal | None  # 確定済みなら その値
    note:            str | None


class MonthlyClosePreview(BaseModel):
    month:      str
    count_date: date                # 月末日
    is_closed:  bool                # この月の棚卸が1件でも確定済みか
    lots:       list[MonthlyCloseLot]


class MonthlyCloseItem(BaseModel):
    lot_id:        int
    counted_kg:    Decimal = Field(..., ge=0)  # 実地棚卸数
    reason:        str | None = None           # 差数原因（差数がある場合）
    fill_variance: bool    = False             # 差数を最終日の調整movementで埋める


class MonthlyCloseRequest(BaseModel):
    month: str = Field(..., pattern=r"^\d{4}-\d{2}$")
    items: list[MonthlyCloseItem] = Field(..., min_length=1)


class MonthlyCloseResult(BaseModel):
    month:                str
    closed_count:         int
    total_counted_kg:     Decimal
    total_theoretical_kg: Decimal
    total_variance_kg:    Decimal       # counted − theoretical
    variances:            list[dict]    # 差数≠0 のロット明細
    adjustments:          list[dict]    # 差数を埋める為に作成した outbound_records


# --- Phase: 日次カレンダー（旧Excelのような ロット×日付 グリッド）---

class CalendarLot(BaseModel):
    lot_id:        int
    lot_code:      str | None = None    # 表示用整理番号（NNG/NNS+5桁）
    selection_id:  int | None = None    # 選別由来のロットなら selection_id (バッジ表示用)
    supplier_name: str
    spec_type:     str
    grade_level:   str | None = None
    size_label:    str | None = None
    origin_name:   str
    inbound_date:  date                 # ロットの入荷日（不変。常に表示する重要情報）
    total_kg:      Decimal              # 入庫量（ロット原本の数量）
    kg_per_case:   Decimal | None = None  # 1ケース重量 (C/S)
    unit_price:    Decimal | None = None  # 単価（金額系列の算出に使用）
    carryover_kg:  Decimal              # 前月繰越
    inbound_kg:    Decimal              # 当月入荷 合計（入荷日が当月のロットだけ）
    outbound_kg:   Decimal              # 当月出庫 合計
    end_kg:        Decimal              # 当月在庫（= 前月繰越 + 当月入荷 − 当月出庫）
    daily:         dict[str, Decimal]   # 日(1..31) → その日の出庫量（出庫が無い日は欠落）

    # セルコメント (migration 055) — 日(1..31) → コメント文字列。 紙レポートにも反映される。
    comments:      dict[str, str] = {}

    # ── 紙レポート (PDF エクスポート) 用拡張フィールド ──
    # migration 036 で追加された支払い・諸経費。 値は inbound_lots からそのまま。
    brokerage_fee:  Decimal | None = None   # 仲介手数料
    freight_fee:    Decimal | None = None   # 運賃
    prepay_date:    date    | None = None   # 前払い日付
    prepay_amount:  Decimal | None = None   # 前払い金額
    postpay_date:   date    | None = None   # 後払い日付
    postpay_amount: Decimal | None = None   # 後払い金額
    # 棚卸数 (当月期間の stock_counts.counted_kg) + 差数 (棚卸 − 計算上の在庫)
    stocktake_kg:   Decimal | None = None
    stocktake_diff: Decimal | None = None   # = stocktake_kg − end_kg
    stocktake_note: str    | None = None


class CalendarView(BaseModel):
    month:          str
    days_in_month:  int
    lots:           list[CalendarLot]
    # ── 紙レポート 用 メタ ──
    crop_id:        int    | None = None
    crop_name:      str    | None = None
    prepared_at:    datetime | None = None      # サーバ現在時刻 (PDF の 「更新日」 表示用)


# --- Phase 2: マスタ解決 & スマート入庫（仕様書3.1）---

class ResolveRequest(BaseModel):
    supplier_name: str | None = None
    origin_name:   str | None = None
    spec_type:     str | None = None
    grade_level:   str | None = None   # 任意 (照合時、未指定は '-' 扱い)
    size_label:    str | None = None   # 任意 (照合時、未指定は '-' 扱い)
    crop_id:       int | None = None   # 重要: 大蒜/大蒜実験 等 同 grade+origin 別 crop の 区別 に 必須


class MasterMatch(BaseModel):
    value:   str | None = None   # 入力値（正規化後）
    matched: bool = False        # 既存マスタに一致したか
    id:      int | None = None   # 一致した場合のマスタID


class ResolveResult(BaseModel):
    supplier:     MasterMatch
    origin:       MasterMatch
    grade:        MasterMatch         # 規格 = grades(spec_type)
    product_id:   int | None = None   # grade×origin が両方既存なら解決済み商品ID
    all_resolved: bool = False        # 全マスタ既存。そのまま登録可能


class SmartInboundRequest(BaseModel):
    """
    入荷登録リクエスト。

    入荷量の指定方法は 2 種類対応 (どちらかを送る):
      A. total_kg + kg_per_case  → cases = total_kg / kg_per_case (端数可)
                                  (推奨。 現場での実測 kg ベース)
      B. cases + kg_per_case     → total_kg = cases * kg_per_case
                                  (旧仕様、 後方互換)
    どちらも欠けてる場合は 422。

    use_reservation_id:
      事前予約 (lot_reservations) を消費して登録する場合に指定。
      指定すれば予約のコードを使い、 消費フラグを立てる。
      指定しない場合は、 該当 crop の未使用予約があれば 409 で拒否される
      (運用ポリシー: 未使用予約を放置しない)。
    """
    supplier_name: str
    origin_name:   str
    spec_type:     str
    grade_level:   str | None = None
    size_label:    str | None = None
    inbound_date:  date
    cases:         Decimal | None = Field(None, gt=0)
    total_kg:      Decimal | None = Field(None, gt=0)
    kg_per_case:   Decimal       = Field(..., gt=0)
    unit_price:    Decimal | None = Field(None, ge=0)
    note:          str | None = None
    auto_register: bool = False
    crop_id:       int | None = None
    use_reservation_id: int | None = None

    @model_validator(mode='after')
    def _derive_cases_and_total(self) -> 'SmartInboundRequest':
        # どちらか必須
        if self.cases is None and self.total_kg is None:
            raise ValueError('cases か total_kg のいずれかを指定してください')
        # 両方ある場合は total_kg 優先 (新仕様)
        if self.total_kg is not None:
            # cases = total_kg / kg_per_case (端数許容、 小数 2 桁まで)
            object.__setattr__(self, 'cases',
                (self.total_kg / self.kg_per_case).quantize(Decimal('0.01')))
        else:
            # 旧仕様: cases から total_kg を計算
            object.__setattr__(self, 'total_kg', self.cases * self.kg_per_case)
        return self


# --- Phase 2: 単価の月次一括入力（仕様書3.3）---

class BulkPriceItem(BaseModel):
    lot_id:     int
    unit_price: Decimal = Field(..., gt=0)
    note:       str | None = None


class BulkPriceRequest(BaseModel):
    items: list[BulkPriceItem] = Field(..., min_length=1)


class BulkPriceResult(BaseModel):
    confirmed:         list[int] = Field(default_factory=list)  # 確定したlot_id
    not_found:         list[int] = Field(default_factory=list)  # 存在しないlot_id
    already_confirmed: list[int] = Field(default_factory=list)  # 既に単価確定済み（スキップ）


# --- Phase 3: 訂正履歴（仕様書4.2）---

class CorrectionRequest(BaseModel):
    target_table: str                # 'inbound_lots' | 'outbound_records'
    target_id:    int
    field_name:   str
    new_value:    str | None = None  # 文字列で受け、対象列の型へ変換する
    reason:       str = Field(..., min_length=1)


# =============================================================================
# スマート・メモ・インプット パーサー（仕様書3.1）
# =============================================================================

# 想定入力例: 「西川 高知産 新物 700ケース 16kg 605円」
#   → 仕入先=西川 産地=高知産 規格=新物 ケース=700 kg/ケース=16 単価=605
# マスタとの最終照合は /inbound/resolve が行う。ここでは字面からの推定のみ。

# 既知の規格キーワード（マスタに無くても推定はする。確定は resolve 側）
_SPEC_KEYWORDS = ("慣行（囲い）", "慣行(囲い)", "慣行", "囲い", "新物", "親生姜")

_KGPC_RE  = re.compile(r"^(\d+(?:\.\d+)?)(?:kg|キロ)(?:[/／](?:ケース|箱|c))?$", re.IGNORECASE)
_PRICE_RE = re.compile(r"^[¥￥]?(\d+(?:\.\d+)?)円?$")
_CASES_RE = re.compile(r"^(\d+(?:\.\d+)?)(?:ケース|箱|cs|c)$", re.IGNORECASE)
_NUM_RE   = re.compile(r"^\d+(?:\.\d+)?$")
_ORIG_RE  = re.compile(r"^.+?(?:産|県)$")


def parse_smart_input(raw: str) -> SmartInputResult:
    """
    1行のメモ書きから [仕入先][産地][規格][ケース数][kg/ケース][単価] を推定する。
    全角→半角・空白正規化を強制実施（仕様書3.1 自動正規化）。
    """
    text   = re.sub(r"\s+", " ", unicodedata.normalize("NFKC", raw)).strip()
    tokens = text.split()
    used: set[int] = set()
    r = SmartInputResult()

    def take(pred):
        """未使用トークンのうち pred が真を返す最初の1つを消費して返す。"""
        for i, t in enumerate(tokens):
            if i in used:
                continue
            v = pred(t)
            if v:
                used.add(i)
                return v
        return None

    # 1. kg/ケース: 単位kgが明示されたものを最優先（"16kg" "15.3kg/ケース"）
    if m := take(lambda t: _KGPC_RE.match(t)):
        r.kg_per_case = float(m[1])
    # 2. ケース数: "700ケース" "700箱"
    if m := take(lambda t: _CASES_RE.match(t)):
        r.cases = float(m[1])
    # 3. 単価: 円/¥ が明示されたもの（"605円" "¥605"）
    if m := take(lambda t: _PRICE_RE.match(t) if ("円" in t or "¥" in t or "￥" in t) else None):
        r.unit_price = float(m[1])
    # 4. 産地: "高知産" "熊本県"
    r.origin_name = take(lambda t: t if _ORIG_RE.match(t) else None)
    # 5. 規格: 既知キーワード
    r.spec_type = take(lambda t: t if t in _SPEC_KEYWORDS else None)

    # 6. 残った裸の数字 → ケース数(未確定なら) → kg/ケース(未確定なら)
    for i, t in enumerate(tokens):
        if i in used or not _NUM_RE.match(t):
            continue
        if r.cases is None:
            r.cases = float(t); used.add(i)
        elif r.kg_per_case is None:
            r.kg_per_case = float(t); used.add(i)

    # 7. 残り → 仕入先（先頭1つ。残余は警告）
    rest = [tokens[i] for i in range(len(tokens)) if i not in used]
    if rest:
        r.supplier_name = rest[0]
        if len(rest) > 1:
            r.warnings.append(f"未解釈の語: {' / '.join(rest[1:])}")

    filled = sum(v is not None for v in [
        r.supplier_name, r.origin_name, r.spec_type, r.cases, r.kg_per_case,
    ])
    r.confidence = "high" if filled >= 5 else "medium" if filled >= 3 else "low"
    return r


# =============================================================================
# マスタ解決・入庫ロット登録の共通ヘルパー
# =============================================================================

def _norm_key(s: str | None) -> str | None:
    """マスタ照合用の正規化（NFKC＋trim）。"""
    if s is None:
        return None
    return unicodedata.normalize("NFKC", s).strip() or None


def _norm_origin_key(s: str | None) -> str | None:
    """産地名の正規化: NFKC + trim + 末尾 「産」 を除去。
    (青森県産 → 青森県、 熊本産 → 熊本)
    末尾の 「産」 が複数連続している場合 (異常) も全部削除する。
    """
    nv = _norm_key(s)
    if nv is None:
        return None
    while nv.endswith('産'):
        nv = nv[:-1].rstrip()
    return nv or None


async def _find_supplier(cur, value: str | None) -> int | None:
    """仕入先を正規化キーで照合する。"""
    nv = _norm_key(value)
    if nv is None:
        return None
    await cur.execute("SELECT id, name FROM suppliers")
    return next((r["id"] for r in await cur.fetchall() if _norm_key(r["name"]) == nv), None)


async def _find_origin(cur, value: str | None) -> int | None:
    """産地を正規化キーで照合する (末尾 「産」 は無視)。"""
    nv = _norm_origin_key(value)
    if nv is None:
        return None
    await cur.execute("SELECT id, name FROM origins")
    return next((r["id"] for r in await cur.fetchall() if _norm_origin_key(r["name"]) == nv), None)


async def _find_grade(
    cur,
    spec_type:   str | None,
    grade_level: str | None = None,
    size_label:  str | None = None,
) -> int | None:
    """grades を (規格, 等級, サイズ) の triplet で照合する。
    等級・サイズ未指定 (None または空文字) の場合は '-' として扱う (DB 上 NOT NULL なので)。
    後方互換: 旧コードは spec_type のみで呼ぶケースがあり、その場合は等級/サイズが '-' の行のみマッチ。
    """
    nv_spec  = _norm_key(spec_type)
    if nv_spec is None:
        return None
    nv_grade = _norm_key(grade_level) or '-'
    nv_size  = _norm_key(size_label)  or '-'
    await cur.execute(
        "SELECT id, spec_type, grade_level, size_label FROM grades")
    for r in await cur.fetchall():
        if (_norm_key(r["spec_type"])   == nv_spec
            and _norm_key(r["grade_level"]) == nv_grade
            and _norm_key(r["size_label"])  == nv_size):
            return r["id"]
    return None


async def _find_product(
    cur, grade_id: int, origin_id: int, crop_id: int | None = None,
) -> int | None:
    """(crop_id, grade_id, origin_id) で 一意に products を特定する。

    crop_id が 指定された 場合 は そのcrop 配下のみ から探す (= 重要)。
    crop 跨ぎ で 同じ (grade, origin) products が 複数存在 する 場合、
    crop_id 無指定 だと どれが返るか 非決定的 → 過去バグ の 原因。
    crop_id None は 後方互換のみ (新コードでは 必ず 指定 すべし)。
    """
    if crop_id is not None:
        await cur.execute(
            "SELECT id FROM products "
            "WHERE crop_id=%s AND grade_id=%s AND origin_id=%s",
            (crop_id, grade_id, origin_id),
        )
    else:
        # 後方互換: crop_id 未指定 は ORDER BY id で 安定化 (最古を返す)。
        # ただし 複数 crop ヒット は 望ましくない ので 上位レベルで crop_id を 渡すべき。
        await cur.execute(
            "SELECT id FROM products WHERE grade_id=%s AND origin_id=%s ORDER BY id LIMIT 1",
            (grade_id, origin_id),
        )
    row = await cur.fetchone()
    return row["id"] if row else None


def _next_month_end(d: date) -> date:
    """入荷日 d の 翌月末 を 返す (= 後払日 デフォルト)。 例: 5/2 → 6/30、 12/5 → 翌年1/31。"""
    ny, nm = (d.year + 1, 1) if d.month == 12 else (d.year, d.month + 1)
    return date(ny, nm, monthrange(ny, nm)[1])


async def _insert_inbound_lot(
    cur, *, product_id, supplier_id, inbound_date,
    cases, kg_per_case, total_kg, unit_price, note, actor_id,
    use_reservation_id: int | None = None,
):
    """入庫ロットを1件INSERTする。同一条件の重複は409を送出。INSERT行(dict)を返す。

    整理番号 code:
      - use_reservation_id 指定時: その予約のコードを使い、 消費 mark。
        予約が見つからない/使用済み/crop 不一致なら 4xx エラー。
      - 未指定時: 当該 crop の未使用予約があれば 409 で拒否
        (運用ポリシー: 未使用予約を放置しない)。
      - 未指定 + 予約なしの時のみ next_lot_code() で新規採番。
    """
    await cur.execute("""
        SELECT id, code FROM inbound_lots
        WHERE product_id=%s AND supplier_id=%s AND inbound_date=%s AND total_kg=%s
    """, (product_id, supplier_id, inbound_date, total_kg))
    dup = await cur.fetchone()
    if dup:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            detail=f"同一条件の入庫ロットが既に存在します（整理番号: {dup['code']}）")

    # 商品 → crop_id を解決
    await cur.execute(
        "SELECT crop_id FROM products WHERE id=%s", (product_id,))
    prod_row = await cur.fetchone()
    if prod_row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND,
                            detail=f"商品ID {product_id} が見つかりません")
    crop_id = prod_row["crop_id"]

    # ── 整理番号採番 ──
    if use_reservation_id is not None:
        # 指定予約をロックして取得 (並行登録対策)
        await cur.execute("""
            SELECT id, code, crop_id, consumed_at
            FROM lot_reservations
            WHERE id = %s
            FOR UPDATE
        """, (use_reservation_id,))
        rsv = await cur.fetchone()
        if rsv is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                detail=f"予約 id={use_reservation_id} が見つかりません")
        if rsv["consumed_at"] is not None:
            raise HTTPException(status.HTTP_409_CONFLICT,
                detail=f"予約 {rsv['code']} は既に使用済みです")
        if rsv["crop_id"] != crop_id:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="予約の作物と商品の作物が一致しません")
        new_code = rsv["code"]
    else:
        # 当該 crop の未使用予約がないか確認 (放置防止ポリシー)
        await cur.execute("""
            SELECT id, code FROM lot_reservations
            WHERE crop_id = %s AND code_kind = 'G' AND consumed_at IS NULL
            ORDER BY created_at ASC, id ASC
            LIMIT 1
        """, (crop_id,))
        oldest = await cur.fetchone()
        if oldest is not None:
            raise HTTPException(status.HTTP_409_CONFLICT,
                detail=(f"この作物には未使用予約 {oldest['code']} があります。 "
                        f"先にそちらを使用してください "
                        f"(use_reservation_id={oldest['id']})"))
        # 予約なし → 通常採番
        await cur.execute("""
            SELECT next_lot_code(c.code, 'G') AS code
            FROM crops c WHERE c.id = %s
        """, (crop_id,))
        new_code = (await cur.fetchone())["code"]

    # 後払日 デフォルト = 入荷日 の 翌月末 (登録後 UI で 個別変更可)
    postpay_default = _next_month_end(inbound_date)

    await cur.execute("""
        INSERT INTO inbound_lots
            (code, product_id, supplier_id, inbound_date, cases, kg_per_case,
             total_kg, unit_price, note, created_by, postpay_date)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        RETURNING *
    """, (new_code, product_id, supplier_id, inbound_date, cases, kg_per_case,
          total_kg, unit_price, note, actor_id, postpay_default))
    row = await cur.fetchone()

    # 予約消費 mark (use_reservation_id 指定時のみ)
    if use_reservation_id is not None:
        await cur.execute("""
            UPDATE lot_reservations
            SET consumed_at = now(),
                consumed_inbound_id = %s
            WHERE id = %s
        """, (row["id"], use_reservation_id))

    return row


# 訂正可能なフィールドと型（仕様書4.2）。ホワイトリストに無い列は訂正不可。
_CORRECTABLE: dict[str, dict[str, str]] = {
    "inbound_lots": {
        "inbound_date": "date", "cases": "decimal", "kg_per_case": "decimal",
        "total_kg": "decimal", "unit_price": "decimal", "note": "text",
    },
    "outbound_records": {
        "outbound_date": "date", "quantity_kg": "decimal", "note": "text",
    },
}


def _coerce(value: str | None, kind: str):
    """訂正値の文字列を対象列の型へ変換する。"""
    if value is None or value == "":
        return None
    if kind == "decimal":
        return Decimal(value)
    if kind == "date":
        return date.fromisoformat(value)
    return value  # text


def _month_last_day(month: str) -> date:
    """'YYYY-MM' から月末日を返す。"""
    first = datetime.strptime(month + "-01", "%Y-%m-%d").date()
    return (first.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)


# =============================================================================
# エンドポイント
# =============================================================================

@app.post("/inbound/parse", response_model=SmartInputResult, tags=["入庫"])
async def parse_inbound_text(body: SmartInputRequest, user: CurrentUser):
    """スマート・メモ・インプットの解析プレビュー（DB書き込みなし）。"""
    return parse_smart_input(body.text)


# =============================================================================
# 整理番号の事前予約 (lot_reservations)
# =============================================================================

class ReservationCreate(BaseModel):
    crop_id:   int
    code_kind: str = Field('G', pattern='^[GS]$')
    note:      str | None = Field(None, max_length=200)


class ReservationOut(BaseModel):
    id:           int
    code:         str
    crop_id:      int
    crop_code:    str
    crop_name:    str
    code_kind:    str
    note:         str | None
    created_by:   str
    created_by_name: str | None = None
    created_at:   datetime
    consumed_at:  datetime | None = None
    consumed_inbound_id:   int | None = None
    consumed_inbound_code: str | None = None


@app.post("/reservations", response_model=ReservationOut,
          status_code=status.HTTP_201_CREATED, tags=["予約"])
async def create_reservation(body: ReservationCreate, db: DB,
                             user: OperatorUser, request: Request):
    """整理番号を事前予約する。 内容は後追い登録時に入力。"""
    async with db.cursor() as cur:
        # crop 存在チェック + crop_code 取得
        await cur.execute(
            "SELECT code, name FROM crops WHERE id=%s AND is_active",
            (body.crop_id,))
        crop = await cur.fetchone()
        if crop is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                detail=f"作物 id={body.crop_id} が見つかりません")
        # 次番号採番 (inbound_lots と lot_reservations 両方の MAX を考慮した関数)
        await cur.execute(
            "SELECT next_lot_code(%s, %s) AS code",
            (crop["code"], body.code_kind))
        new_code = (await cur.fetchone())["code"]
        # 予約 INSERT
        await cur.execute("""
            INSERT INTO lot_reservations (code, crop_id, code_kind, note, created_by)
            VALUES (%s, %s, %s, %s, %s)
            RETURNING id, code, crop_id, code_kind, note, created_by, created_at,
                      consumed_at, consumed_inbound_id
        """, (new_code, body.crop_id, body.code_kind,
              (body.note or '').strip() or None, user["id"]))
        rsv = await cur.fetchone()

    await write_audit(db, "RESERVATION_CREATE", "lot_reservations", str(rsv["id"]),
                      dict(rsv), user["id"], request)
    return ReservationOut(
        id=rsv["id"], code=rsv["code"], crop_id=rsv["crop_id"],
        crop_code=crop["code"], crop_name=crop["name"],
        code_kind=rsv["code_kind"], note=rsv["note"],
        created_by=str(rsv["created_by"]),
        created_by_name=user.get("display_name"),
        created_at=rsv["created_at"],
        consumed_at=rsv["consumed_at"],
        consumed_inbound_id=rsv["consumed_inbound_id"],
        consumed_inbound_code=None,
    )


@app.get("/reservations", response_model=list[ReservationOut], tags=["予約"])
async def list_reservations(db: DB, user: CurrentUser,
                            crop_id: int | None = None,
                            code_kind: str | None = None,
                            unused_only: bool = False,
                            limit: int = 100):
    """予約一覧。 unused_only=True で未消費のみ。"""
    conds = ["1=1"]
    params: list = []
    if crop_id is not None:
        conds.append("lr.crop_id = %s")
        params.append(crop_id)
    if code_kind is not None:
        conds.append("lr.code_kind = %s")
        params.append(code_kind)
    if unused_only:
        conds.append("lr.consumed_at IS NULL")
    params.append(limit)
    async with db.cursor() as cur:
        await cur.execute(f"""
            SELECT lr.*, c.code AS crop_code, c.name AS crop_name,
                   u.display_name AS created_by_name,
                   il.code AS consumed_inbound_code
            FROM lot_reservations lr
            JOIN crops c ON c.id = lr.crop_id
            LEFT JOIN users u ON u.id = lr.created_by
            LEFT JOIN inbound_lots il ON il.id = lr.consumed_inbound_id
            WHERE {' AND '.join(conds)}
            ORDER BY lr.consumed_at IS NULL DESC, lr.created_at ASC
            LIMIT %s
        """, params)
        rows = await cur.fetchall()
    return [ReservationOut(
        id=r["id"], code=r["code"], crop_id=r["crop_id"],
        crop_code=r["crop_code"], crop_name=r["crop_name"],
        code_kind=r["code_kind"], note=r["note"],
        created_by=str(r["created_by"]),
        created_by_name=r["created_by_name"],
        created_at=r["created_at"],
        consumed_at=r["consumed_at"],
        consumed_inbound_id=r["consumed_inbound_id"],
        consumed_inbound_code=r["consumed_inbound_code"],
    ) for r in rows]


@app.delete("/reservations/{rsv_id}", status_code=status.HTTP_204_NO_CONTENT,
            tags=["予約"])
async def cancel_reservation(rsv_id: int, db: DB,
                             admin: AdminUser, request: Request):
    """未使用の予約を削除 (admin 専用)。 既に使用済の予約は削除不可。"""
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT id, code, consumed_at FROM lot_reservations WHERE id=%s",
            (rsv_id,))
        rsv = await cur.fetchone()
        if rsv is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                detail=f"予約 id={rsv_id} が見つかりません")
        if rsv["consumed_at"] is not None:
            raise HTTPException(status.HTTP_409_CONFLICT,
                detail=f"予約 {rsv['code']} は既に使用済みのため削除できません")
        await cur.execute("DELETE FROM lot_reservations WHERE id=%s", (rsv_id,))
    await write_audit(db, "RESERVATION_DELETE", "lot_reservations", str(rsv_id),
                      {"code": rsv["code"]}, admin["id"], request)
    return None


@app.post("/inbound/lots", response_model=InboundLotResponse,
          status_code=status.HTTP_201_CREATED, tags=["入庫"])
async def create_inbound_lot(body: InboundLotCreate, db: DB, user: OperatorUser, request: Request):
    """入庫ロットを登録する（ID指定。VBAの整理番号採番に相当）。"""
    async with db.cursor() as cur:
        await cur.execute("SELECT 1 FROM products WHERE id=%s", (body.product_id,))
        if not await cur.fetchone():
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                detail=f"商品ID {body.product_id} が見つかりません")

        await cur.execute("SELECT 1 FROM suppliers WHERE id=%s", (body.supplier_id,))
        if not await cur.fetchone():
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                detail=f"仕入先ID {body.supplier_id} が見つかりません")

        actor_id = user["id"]
        row = await _insert_inbound_lot(
            cur, product_id=body.product_id, supplier_id=body.supplier_id,
            inbound_date=body.inbound_date, cases=body.cases,
            kg_per_case=body.kg_per_case, total_kg=body.total_kg,
            unit_price=body.unit_price, note=body.note, actor_id=actor_id,
            use_reservation_id=body.use_reservation_id,
        )

    await write_audit(db, "INBOUND_CREATE", "inbound_lots", str(row["id"]),
                      dict(row), actor_id, request)
    return InboundLotResponse(**row)


@app.post("/inbound/resolve", response_model=ResolveResult, tags=["入庫"])
async def resolve_masters(body: ResolveRequest, db: DB, user: CurrentUser):
    """
    入力された名前を既存マスタと照合する（書き込みなしのプレビュー。仕様書3.1）。
    未一致のものは matched=false で返り、フロントは登録確認を出せる。
    """
    async with db.cursor() as cur:
        sup_id = await _find_supplier(cur, body.supplier_name)
        ori_id = await _find_origin(cur, body.origin_name)
        grd_id = await _find_grade(cur, body.spec_type, body.grade_level, body.size_label)
        prod_id = None
        if grd_id is not None and ori_id is not None:
            # crop_id 指定 (大蒜/大蒜実験 等を 区別) — 未指定 でも 動作 する が 警告
            prod_id = await _find_product(cur, grd_id, ori_id, crop_id=body.crop_id)

    return ResolveResult(
        supplier   = MasterMatch(value=_norm_key(body.supplier_name),
                                 matched=sup_id is not None, id=sup_id),
        origin     = MasterMatch(value=_norm_key(body.origin_name),
                                 matched=ori_id is not None, id=ori_id),
        grade      = MasterMatch(value=_norm_key(body.spec_type),
                                 matched=grd_id is not None, id=grd_id),
        product_id = prod_id,
        all_resolved = all(x is not None for x in (sup_id, ori_id, grd_id)),
    )


@app.post("/inbound/lots/smart", response_model=InboundLotResponse,
          status_code=status.HTTP_201_CREATED, tags=["入庫"])
async def create_inbound_lot_smart(body: SmartInboundRequest, db: DB,
                                   user: OperatorUser, request: Request):
    """
    名前ベースで入庫ロットを登録する（仕様書3.1）。
    auto_register=True なら未登録の仕入先・産地・規格・商品をその場で作成する
    （オンザフライ登録）。False で未登録があれば 409 で不足を返す。
    """
    sup, ori, spec = _norm_key(body.supplier_name), _norm_origin_key(body.origin_name), _norm_key(body.spec_type)
    if not (sup and ori and spec):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="仕入先・産地・規格は必須です")
    # 等級・サイズは任意。空欄/None は '-' (DB 上の "未指定" マーカー) に正規化。
    grade = _norm_key(body.grade_level) or '-'
    size  = _norm_key(body.size_label)  or '-'

    async with db.cursor() as cur:
        sup_id = await _find_supplier(cur, sup)
        ori_id = await _find_origin(cur, ori)
        grd_id = await _find_grade(cur, spec, grade, size)

        missing = []
        if sup_id is None: missing.append(f"仕入先「{sup}」")
        if ori_id is None: missing.append(f"産地「{ori}」")
        if grd_id is None:
            label = f"規格「{spec}」"
            if grade != '-' or size != '-':
                label += f" / 等級「{grade}」 / サイズ「{size}」"
            missing.append(label)
        if missing and not body.auto_register:
            raise HTTPException(status.HTTP_409_CONFLICT, detail={
                "error":   "未登録のマスタがあります",
                "missing": missing,
                "hint":    "auto_register=true で自動登録できます",
            })

        # オンザフライ登録（不足分のみ。値は正規化済みで登録）
        if sup_id is None:
            await cur.execute("INSERT INTO suppliers (name) VALUES (%s) RETURNING id", (sup,))
            sup_id = (await cur.fetchone())["id"]
        if ori_id is None:
            await cur.execute("INSERT INTO origins (name) VALUES (%s) RETURNING id", (ori,))
            ori_id = (await cur.fetchone())["id"]
        if grd_id is None:
            await cur.execute(
                "INSERT INTO grades (spec_type, grade_level, size_label) "
                "VALUES (%s, %s, %s) RETURNING id", (spec, grade, size))
            grd_id = (await cur.fetchone())["id"]

        # crop_id 解決 (lookup と create 両方 で 同じ crop_id を 使う)。
        # body.crop_id 指定があれば それ、 なければ デフォルト '01' (生姜)。
        crop_id = body.crop_id
        if crop_id is None:
            await cur.execute("SELECT id FROM crops WHERE code='01'")
            crop_id = (await cur.fetchone())["id"]
        # 必ず crop_id を渡す (= 大蒜 / 大蒜実験 が 別 product として 正しく 区別)
        prod_id = await _find_product(cur, grd_id, ori_id, crop_id=crop_id)
        if prod_id is None:
            await cur.execute(
                "INSERT INTO products (crop_id, grade_id, origin_id) "
                "VALUES (%s,%s,%s) RETURNING id",
                (crop_id, grd_id, ori_id))
            prod_id = (await cur.fetchone())["id"]

        actor_id = user["id"]
        row = await _insert_inbound_lot(
            cur, product_id=prod_id, supplier_id=sup_id,
            inbound_date=body.inbound_date, cases=body.cases,
            kg_per_case=body.kg_per_case, total_kg=body.cases * body.kg_per_case,
            unit_price=body.unit_price, note=body.note, actor_id=actor_id,
            use_reservation_id=body.use_reservation_id,
        )

    await write_audit(db, "INBOUND_CREATE_SMART", "inbound_lots", str(row["id"]),
                      dict(row), actor_id, request)
    return InboundLotResponse(**row)


@app.patch("/inbound/lots/{lot_id}/price", response_model=InboundLotResponse, tags=["入庫"])
async def confirm_lot_price(lot_id: int, body: PriceUpdateRequest, db: DB,
                            user: OperatorUser, request: Request):
    """入庫ロットの単価を後追いで確定する（仕様書3.3 単価の後追い入力）。"""
    async with db.cursor() as cur:
        await cur.execute("SELECT * FROM inbound_lots WHERE id=%s", (lot_id,))
        existing = await cur.fetchone()
        if not existing:
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                detail=f"整理番号 {lot_id} が見つかりません")

        actor_id = user["id"]
        await cur.execute("""
            UPDATE inbound_lots
            SET unit_price=%s, price_confirmed_at=now(),
                price_confirmed_by=%s, note=COALESCE(%s, note), updated_at=now()
            WHERE id=%s RETURNING *
        """, (body.unit_price, actor_id, body.note, lot_id))
        row = await cur.fetchone()

    await write_audit(db, "PRICE_CONFIRM", "inbound_lots", str(lot_id),
                      {"old_price": str(existing["unit_price"]), "new_price": str(body.unit_price)},
                      actor_id, request)
    return InboundLotResponse(**row)


@app.patch("/inbound/lots/{lot_id}", response_model=InboundLotResponse, tags=["入庫"])
async def patch_inbound_lot(
    lot_id: int, body: InboundLotPatch, db: DB,
    user: OperatorUser, request: Request,
):
    """入庫ロットの部分更新 (入荷日 / ケース数 / kg/ケース / 単価 / 備考)。
    出庫済の合計を下回る数量変更は拒否。"""
    fields = body.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="更新するフィールドが指定されていません")

    async with db.cursor() as cur:
        await cur.execute("SELECT * FROM inbound_lots WHERE id=%s", (lot_id,))
        existing = await cur.fetchone()
        if not existing:
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                detail=f"整理番号 {lot_id} が見つかりません")
        if existing["archived_at"] is not None:
            raise HTTPException(status.HTTP_409_CONFLICT,
                                detail="アーカイブ済ロットは編集できません。先に復元してください。")

        # 新しい cases / kg_per_case で total_kg を再計算
        new_cases = fields.get("cases", existing["cases"])
        new_kpc   = fields.get("kg_per_case", existing["kg_per_case"])
        new_total = Decimal(str(new_cases)) * Decimal(str(new_kpc))

        # 出庫済合計と比較 (下回ったら拒否)
        await cur.execute(
            "SELECT COALESCE(SUM(quantity_kg), 0) AS out_kg, "
            "       MIN(outbound_date)            AS first_out "
            "FROM outbound_records WHERE lot_id = %s", (lot_id,))
        out_row = await cur.fetchone()
        out_kg = Decimal(str(out_row["out_kg"]))
        if new_total < out_kg:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail=f"出庫済合計 {out_kg} kg を下回る数量には変更できません "
                       f"(新 total_kg = {new_total})。先に出庫履歴を修正してください。",
            )

        # 入荷日を出庫より後ろにずらそうとしている → 拒否
        # (出庫日より入荷日が後だと「未入荷品を出庫した」状態になる)
        if "inbound_date" in fields and out_row["first_out"] is not None:
            new_inbound = fields["inbound_date"]
            if new_inbound > out_row["first_out"]:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    detail=f"入荷日 {new_inbound} は最初の出庫日 {out_row['first_out']} "
                           f"より後ろにできません。先に該当出庫を修正/削除してください。",
                )

        sets: list[str] = []
        params: list[Any] = []
        if "inbound_date" in fields:
            sets.append("inbound_date = %s"); params.append(fields["inbound_date"])
        if "cases" in fields or "kg_per_case" in fields:
            sets.append("cases = %s");        params.append(new_cases)
            sets.append("kg_per_case = %s");  params.append(new_kpc)
            sets.append("total_kg = %s");     params.append(new_total)
        if "unit_price" in fields:
            v = fields["unit_price"]
            if v is not None and v == 0:
                # 0 → 未確定に戻す
                sets.append("unit_price = NULL")
                sets.append("price_confirmed_at = NULL")
                sets.append("price_confirmed_by = NULL")
            else:
                sets.append("unit_price = %s"); params.append(v)
                sets.append("price_confirmed_at = now()")
                sets.append("price_confirmed_by = %s"); params.append(user["id"])
        if "note" in fields:
            sets.append("note = %s"); params.append(fields["note"])
        # 支払い関連 (在庫一覧のインライン編集対象)
        for f in ("prepay_date", "prepay_amount",
                  "postpay_date", "postpay_amount",
                  "brokerage_fee", "freight_fee"):
            if f in fields:
                sets.append(f"{f} = %s"); params.append(fields[f])
        sets.append("updated_at = now()")
        params.append(lot_id)

        await cur.execute(
            f"UPDATE inbound_lots SET {', '.join(sets)} WHERE id = %s RETURNING *",
            params)
        row = await cur.fetchone()

    await write_audit(db, "LOT_PATCH", "inbound_lots", str(lot_id),
                      {k: (float(v) if isinstance(v, Decimal) else str(v) if v is not None else None)
                       for k, v in fields.items()},
                      user["id"], request)
    return InboundLotResponse(**row)


@app.patch("/inbound/lots/{lot_id}/grade", response_model=GradePatchResponse, tags=["入庫"])
async def patch_lot_grade(
    lot_id: int, body: GradePatchRequest, db: DB,
    admin: AdminUser, request: Request,
):
    """規格 (grade) のみ を 修正 する admin 専用 endpoint。

    内部 で (crop, new_grade, origin) の product を find or create し、
    inbound_lots.product_id を 切替。 下流 (lot_stock view, 出庫レポート, NR,
    倉庫 等) は JOIN ベース で 自動 反映 する。 outbound_orders.from_grade_id
    等 の snapshot 列 は 「修正前 の 認識 で 操作 した」 履歴 として 触らない。

    dry_run=true で 副作用 ゼロ の 試算 (影響件数 表示 用)。
    """
    async with db.cursor() as cur:
        # 1. lot + 現 product 情報 取得
        await cur.execute("""
            SELECT l.id, l.product_id, l.archived_at,
                   p.crop_id, p.grade_id AS old_grade_id, p.origin_id
              FROM inbound_lots l
              JOIN products p ON p.id = l.product_id
             WHERE l.id = %s
        """, (lot_id,))
        lot = await cur.fetchone()
        if not lot:
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                detail=f"ロット {lot_id} が見つかりません")
        if lot["archived_at"] is not None:
            raise HTTPException(status.HTTP_409_CONFLICT,
                                detail="アーカイブ済ロットは編集できません。先に復元してください。")
        old_product_id = lot["product_id"]
        old_grade_id   = lot["old_grade_id"]
        crop_id        = lot["crop_id"]
        origin_id      = lot["origin_id"]
        new_grade_id   = body.grade_id

        if old_grade_id == new_grade_id:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                                detail="現在 と 同じ 規格 です。 変更 ありません。")

        # 2. 新 grade 検証 + label
        async def grade_label(gid: int) -> str:
            await cur.execute(
                "SELECT spec_type, grade_level, size_label FROM grades WHERE id=%s", (gid,))
            r = await cur.fetchone()
            if not r:
                raise HTTPException(status.HTTP_404_NOT_FOUND,
                                    detail=f"grade_id {gid} が見つかりません")
            return f"{r['spec_type']}/{r['grade_level'] or '-'}/{r['size_label'] or '-'}"
        old_label = await grade_label(old_grade_id)
        new_label = await grade_label(new_grade_id)

        # 3. 影響件数 集計
        await cur.execute(
            "SELECT COUNT(*) AS n FROM outbound_records WHERE lot_id=%s", (lot_id,))
        ob_total = (await cur.fetchone())["n"]
        await cur.execute(
            "SELECT COUNT(*) AS n FROM outbound_records "
            "WHERE lot_id=%s AND order_id IS NOT NULL", (lot_id,))
        ob_sub = (await cur.fetchone())["n"]
        await cur.execute(
            "SELECT COUNT(*) AS n FROM storage_object_items WHERE inbound_lot_id=%s",
            (lot_id,))
        soi_n = (await cur.fetchone())["n"]
        await cur.execute(
            "SELECT COUNT(*) AS n FROM stock_counts WHERE lot_id=%s", (lot_id,))
        sc_n = (await cur.fetchone())["n"]
        affected = AffectedCounts(
            outbound_records=ob_total, substitution_records=ob_sub,
            storage_items=soi_n, stock_counts=sc_n,
        )

        # 4. dry_run: product を 既存 検索 のみ (= INSERT しない)
        if body.dry_run:
            await cur.execute("""
                SELECT id FROM products
                 WHERE crop_id=%s AND grade_id=%s AND origin_id=%s
            """, (crop_id, new_grade_id, origin_id))
            r = await cur.fetchone()
            return GradePatchResponse(
                lot_id=lot_id,
                old_grade_id=old_grade_id, old_grade_label=old_label,
                new_grade_id=new_grade_id, new_grade_label=new_label,
                old_product_id=old_product_id,
                new_product_id=r["id"] if r else 0,
                new_product_created=r is None,
                affected=affected, committed=False,
            )

        # 5. find or create new product
        await cur.execute("""
            SELECT id FROM products
             WHERE crop_id=%s AND grade_id=%s AND origin_id=%s
        """, (crop_id, new_grade_id, origin_id))
        existing = await cur.fetchone()
        if existing:
            new_product_id = existing["id"]
            new_created = False
        else:
            await cur.execute("""
                INSERT INTO products (crop_id, grade_id, origin_id)
                VALUES (%s, %s, %s) RETURNING id
            """, (crop_id, new_grade_id, origin_id))
            new_product_id = (await cur.fetchone())["id"]
            new_created = True

        # 6. UPDATE lot.product_id (= 規格 切替 反映)
        await cur.execute(
            "UPDATE inbound_lots SET product_id=%s, updated_at=now() WHERE id=%s",
            (new_product_id, lot_id))

    # 7. audit log (旧/新 grade + 影響件数 を 全部 記録)
    await write_audit(db, "LOT_PRODUCT_PATCH", "inbound_lots", str(lot_id),
                      {"old_product_id": old_product_id,
                       "new_product_id": new_product_id,
                       "old_grade_id": old_grade_id, "new_grade_id": new_grade_id,
                       "old_grade_label": old_label, "new_grade_label": new_label,
                       "new_product_created": new_created,
                       "affected": affected.model_dump()},
                      admin["id"], request)

    return GradePatchResponse(
        lot_id=lot_id,
        old_grade_id=old_grade_id, old_grade_label=old_label,
        new_grade_id=new_grade_id, new_grade_label=new_label,
        old_product_id=old_product_id, new_product_id=new_product_id,
        new_product_created=new_created,
        affected=affected, committed=True,
    )


# =============================================================================
# 入庫ロットのアーカイブ（仕様: 「前月繰越=0 かつ過去月入荷」など、動きの無いロット）
# =============================================================================

class ArchiveRequest(BaseModel):
    lot_ids: list[int] = Field(..., min_length=1)
    note:    str | None = None


@app.post("/inbound/lots/{lot_id}/archive", tags=["アーカイブ"])
async def archive_lot(lot_id: int, db: DB, admin: AdminUser, request: Request,
                      note: str | None = None):
    """単一ロットをアーカイブする（管理者のみ）。"""
    async with db.cursor() as cur:
        await cur.execute(
            """UPDATE inbound_lots
                  SET archived_at = now(), archived_by = %s, archive_note = %s
                WHERE id = %s
                  AND archived_at IS NULL
                RETURNING id, code""",
            (admin["id"], note, lot_id))
        row = await cur.fetchone()
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                detail=f"ロット {lot_id} が見つからない、または既にアーカイブ済み")
    await write_audit(db, "LOT_ARCHIVE", "inbound_lots", str(lot_id),
                      {"note": note}, admin["id"], request)
    return {"id": row["id"], "code": row["code"]}


@app.post("/inbound/lots/{lot_id}/restore", tags=["アーカイブ"])
async def restore_lot(lot_id: int, db: DB, admin: AdminUser, request: Request):
    """アーカイブを解除する（管理者のみ）。"""
    async with db.cursor() as cur:
        await cur.execute(
            """UPDATE inbound_lots
                  SET archived_at = NULL, archived_by = NULL, archive_note = NULL
                WHERE id = %s AND archived_at IS NOT NULL
                RETURNING id, code""",
            (lot_id,))
        row = await cur.fetchone()
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                detail=f"ロット {lot_id} が見つからない、またはアーカイブされていない")
    await write_audit(db, "LOT_RESTORE", "inbound_lots", str(lot_id),
                      {}, admin["id"], request)
    return {"id": row["id"], "code": row["code"]}


@app.delete("/inbound/lots/{lot_id}", tags=["アーカイブ"])
async def delete_lot(lot_id: int, db: DB, admin: AdminUser, request: Request):
    """アーカイブ済みロットを物理削除する（管理者のみ）。
    出庫レコード・棚卸・選別関連を伴うロットは安全のためカスケードしない。"""
    async with db.cursor() as cur:
        await cur.execute("SELECT id, code, archived_at FROM inbound_lots WHERE id=%s",
                          (lot_id,))
        lot = await cur.fetchone()
        if lot is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="ロットが見つかりません")
        if lot["archived_at"] is None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail="アーカイブ済みでないロットは削除できません。先にアーカイブしてください。")
        # 関連レコード（出庫/棚卸/選別）が残っていれば削除しない
        await cur.execute(
            "SELECT COUNT(*) AS c FROM outbound_records WHERE lot_id=%s", (lot_id,))
        if (await cur.fetchone())["c"] > 0:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail="このロットには出庫記録が残っています。削除を続行するには出庫履歴の整理が必要です。")
        await cur.execute("DELETE FROM stock_counts WHERE lot_id=%s", (lot_id,))
        await cur.execute("DELETE FROM inbound_lots WHERE id=%s", (lot_id,))

    await write_audit(db, "LOT_DELETE", "inbound_lots", str(lot_id),
                      {"code": lot["code"]}, admin["id"], request)
    return {"id": lot_id, "code": lot["code"], "deleted": True}


@app.post("/inbound/lots/archive-bulk", tags=["アーカイブ"])
async def archive_lots_bulk(body: ArchiveRequest, db: DB,
                            admin: AdminUser, request: Request):
    """複数ロットを一括アーカイブ（管理者のみ）。"""
    async with db.cursor() as cur:
        await cur.execute(
            """UPDATE inbound_lots
                  SET archived_at = now(), archived_by = %s,
                      archive_note = COALESCE(%s, archive_note)
                WHERE id = ANY(%s) AND archived_at IS NULL
                RETURNING id, code""",
            (admin["id"], body.note, body.lot_ids))
        rows = await cur.fetchall()
    await write_audit(db, "LOT_ARCHIVE_BULK", "inbound_lots",
                      ",".join(str(r["id"]) for r in rows),
                      {"count": len(rows), "note": body.note},
                      admin["id"], request)
    return {"archived": [{"id": r["id"], "code": r["code"]} for r in rows],
            "count": len(rows)}


@app.get("/inbound/lots/archive-candidates", tags=["アーカイブ"])
async def archive_candidates(
    db: DB, admin: AdminUser,
    crop_id: int | None = Query(None),
    month: str | None = Query(None,
        description="基準月 (YYYY-MM)。省略時は現在月。"),
):
    """アーカイブ候補ロットを返す。
    条件:
      - 未アーカイブ
      - 入荷日が基準月より前
      - 前月（基準月-1）の棚卸 (stock_counts.counted_kg) が 0
        ※ 当月内に消化されたロットは候補に含まない（前月時点で既に動きが無いものに限る）。
    """
    if not month:
        month = datetime.now().strftime("%Y-%m")
    first = datetime.strptime(month + "-01", "%Y-%m-%d").date()
    prev_month = (first - timedelta(days=1)).strftime("%Y-%m")
    crop_clause = "AND p.crop_id = %s" if crop_id is not None else ""
    # SQL の %s 順: 1) sc.period 2) il.inbound_date 3) p.crop_id (optional)
    params: list = [prev_month, first]
    if crop_id is not None:
        params.append(crop_id)
    async with db.cursor() as cur:
        await cur.execute(f"""
            SELECT il.id AS lot_id, il.code, il.inbound_date, il.total_kg,
                   s.name AS supplier_name,
                   g.spec_type, g.grade_level, g.size_label,
                   o.name AS origin_name, c.name AS crop_name,
                   ls.remaining_kg, ls.base_kg, ls.base_date,
                   sc.counted_kg AS carryover_kg,
                   sc.period     AS carryover_period
            FROM inbound_lots il
            JOIN products  p ON p.id = il.product_id
            JOIN crops     c ON c.id = p.crop_id
            JOIN grades    g ON g.id = p.grade_id
            JOIN origins   o ON o.id = p.origin_id
            JOIN suppliers s ON s.id = il.supplier_id
            JOIN lot_stock ls ON ls.lot_id = il.id
            JOIN stock_counts sc ON sc.lot_id = il.id AND sc.period = %s
            WHERE il.archived_at IS NULL
              AND il.inbound_date < %s
              AND sc.counted_kg = 0
              {crop_clause}
            ORDER BY il.inbound_date, il.id
        """, params)
        rows = await cur.fetchall()
    return [dict(r) for r in rows]


@app.get("/inbound/lots/archived", tags=["アーカイブ"])
async def list_archived(
    db: DB, admin: AdminUser,
    crop_id: int | None = Query(None),
    limit: int = Query(200, ge=1, le=1000),
):
    """アーカイブ済みロット一覧。"""
    conds = ["il.archived_at IS NOT NULL"]
    params: list = []
    if crop_id is not None:
        params.append(crop_id); conds.append("p.crop_id = %s")
    params.append(limit)
    async with db.cursor() as cur:
        await cur.execute(f"""
            SELECT il.id AS lot_id, il.code, il.inbound_date, il.total_kg,
                   il.archived_at, il.archive_note,
                   s.name AS supplier_name,
                   g.spec_type, g.grade_level, g.size_label,
                   o.name AS origin_name, c.name AS crop_name,
                   u.display_name AS archived_by_name,
                   (SELECT COUNT(*) FROM outbound_records WHERE lot_id = il.id)
                                  AS outbound_count
            FROM inbound_lots il
            JOIN products  p ON p.id = il.product_id
            JOIN crops     c ON c.id = p.crop_id
            JOIN grades    g ON g.id = p.grade_id
            JOIN origins   o ON o.id = p.origin_id
            JOIN suppliers s ON s.id = il.supplier_id
            LEFT JOIN users u ON u.id = il.archived_by
            WHERE {' AND '.join(conds)}
            ORDER BY il.archived_at DESC, il.id
            LIMIT %s
        """, params)
        rows = await cur.fetchall()
    return [dict(r) for r in rows]


@app.get("/inbound/history", tags=["入庫"])
async def list_inbound_history(
    db: DB, user: CurrentUser,
    crop_id:   int | None = Query(None, description="作物 ID で絞り込み"),
    date_from: str | None = Query(None, description="YYYY-MM-DD"),
    date_to:   str | None = Query(None, description="YYYY-MM-DD"),
    include_archived: bool = Query(False),
    include_selection_output: bool = Query(False,
        description="選別から生成された出力ロットも含める (デフォルト false)"),
    limit:     int = Query(500, ge=1, le=2000),
):
    """入庫履歴 (inbound_lots) 一覧。
    デフォルトでは外部仕入のみ (selection_id IS NULL)、未アーカイブ。
    選別出力ロットを含めて見たい時は include_selection_output=true を指定。
    InboundPage の「最近の入荷履歴」セクション用 (作物単位・期間指定可)。"""
    conds = ["1=1"]
    params: list[Any] = []
    if crop_id is not None:
        params.append(crop_id); conds.append("p.crop_id = %s")
    if date_from:
        params.append(date_from); conds.append("il.inbound_date >= %s")
    if date_to:
        params.append(date_to); conds.append("il.inbound_date <= %s")
    if not include_archived:
        conds.append("il.archived_at IS NULL")
    if not include_selection_output:
        conds.append("il.selection_id IS NULL")
    params.append(limit)
    async with db.cursor() as cur:
        await cur.execute(f"""
            SELECT il.id AS lot_id, il.code, il.inbound_date,
                   il.cases, il.kg_per_case, il.total_kg,
                   il.unit_price,
                   (il.unit_price * il.total_kg) AS total_price,
                   il.note,
                   il.archived_at,
                   il.selection_id,    -- 選別由来か (NULL=外部仕入, 非NULL=選別出力)
                   s.name AS supplier_name,
                   g.spec_type, g.grade_level, g.size_label,
                   o.name AS origin_name,
                   c.id   AS crop_id, c.name AS crop_name,
                   u.display_name AS created_by_name,
                   (SELECT COALESCE(SUM(quantity_kg), 0)
                      FROM outbound_records WHERE lot_id = il.id) AS outbound_kg,
                   (il.total_kg
                    - COALESCE((SELECT SUM(quantity_kg)
                                  FROM outbound_records WHERE lot_id = il.id), 0)
                   ) AS remaining_kg
              FROM inbound_lots il
              JOIN products  p ON p.id = il.product_id
              JOIN crops     c ON c.id = p.crop_id
              JOIN grades    g ON g.id = p.grade_id
              JOIN origins   o ON o.id = p.origin_id
              JOIN suppliers s ON s.id = il.supplier_id
              LEFT JOIN users u ON u.id = il.created_by
             WHERE {' AND '.join(conds)}
             ORDER BY il.inbound_date DESC, il.id DESC
             LIMIT %s
        """, params)
        return [dict(r) for r in await cur.fetchall()]


@app.get("/inbound/patterns", tags=["入庫"])
async def list_inbound_patterns(
    db: DB,
    user: CurrentUser,
    crop_id: int | None = Query(None,
        description="作物 ID。指定時はその作物の入庫履歴のみで集計"),
):
    """過去の入庫履歴から「(仕入先, 産地, 規格, 等級, サイズ)」の distinct パターンを返す。

    InboundPage のカスケードフィルタ用:
      - 全 supplier 候補 = patterns の distinct supplier_name
      - supplier 選択後の origin 候補 = supplier 一致のもの
      - supplier+origin 選択後の spec 候補 = 両方一致のもの
      - + 規格 選択後の grade 候補 = 3つ一致のもの
      - + 規格+等級 選択後の size 候補 = 4つ一致のもの

    作物指定で **その作物だけの組合せ** に絞れる (生姜画面で大蒜の規格が出ない)。

    レスポンス形式 (後方互換):
      { triplets: [...] }  # ← 旧名のまま (実態は 5 フィールド = quintuplet)
    """
    conds = ["1=1"]
    params: list[Any] = []
    if crop_id is not None:
        params.append(crop_id)
        conds.append("p.crop_id = %s")
    async with db.cursor() as cur:
        await cur.execute(f"""
            SELECT DISTINCT
                s.name AS supplier_name,
                o.name AS origin_name,
                g.spec_type,
                g.grade_level,
                g.size_label
            FROM inbound_lots il
            JOIN suppliers s ON s.id = il.supplier_id
            JOIN products  p ON p.id = il.product_id
            JOIN grades    g ON g.id = p.grade_id
            JOIN origins   o ON o.id = p.origin_id
            WHERE {' AND '.join(conds)}
            ORDER BY s.name, o.name, g.spec_type, g.grade_level, g.size_label
        """, params or None)
        return {"triplets": [dict(r) for r in await cur.fetchall()]}


@app.get("/inbound/lots/pending-price", tags=["入庫"])
async def list_pending_price_lots(
    db: DB,
    user: CurrentUser,
    month:       str | None = Query(None, description="YYYY-MM 形式。入荷月で絞り込み"),
    supplier_id: int | None = Query(None),
):
    """単価未確定の入庫ロット一覧（仕様書3.3 月次一括入力画面用）。"""
    conds: list[str] = ["il.unit_price IS NULL"]
    params: list[Any] = []
    if month:
        params.append(month)
        conds.append("to_char(il.inbound_date, 'YYYY-MM') = %s")
    if supplier_id is not None:
        params.append(supplier_id)
        conds.append("il.supplier_id = %s")

    async with db.cursor() as cur:
        await cur.execute(f"""
            SELECT il.id, il.inbound_date, il.cases, il.kg_per_case, il.total_kg,
                   il.note, s.name AS supplier_name,
                   g.spec_type, g.grade_level, g.size_label, o.name AS origin_name
            FROM inbound_lots il
            JOIN suppliers s ON s.id = il.supplier_id
            JOIN products  p ON p.id = il.product_id
            JOIN grades    g ON g.id = p.grade_id
            JOIN origins   o ON o.id = p.origin_id
            WHERE {' AND '.join(conds)}
            ORDER BY il.inbound_date, il.id
        """, params or None)
        return [dict(r) for r in await cur.fetchall()]


@app.post("/inbound/lots/prices/bulk", response_model=BulkPriceResult, tags=["入庫"])
async def bulk_confirm_prices(body: BulkPriceRequest, db: DB,
                              user: OperatorUser, request: Request):
    """
    複数ロットの単価を一括確定する（仕様書3.3 月次一括入力）。
    既に単価確定済みのロットはスキップ（訂正は /corrections で扱う）。
    在庫評価額は lot_stock VIEW が自動で再計算する。
    """
    result = BulkPriceResult()
    actor_id = user["id"]
    async with db.cursor() as cur:
        for item in body.items:
            await cur.execute(
                "SELECT id, unit_price FROM inbound_lots WHERE id=%s", (item.lot_id,))
            lot = await cur.fetchone()
            if lot is None:
                result.not_found.append(item.lot_id)
                continue
            if lot["unit_price"] is not None:
                result.already_confirmed.append(item.lot_id)
                continue
            await cur.execute("""
                UPDATE inbound_lots
                SET unit_price=%s, price_confirmed_at=now(),
                    price_confirmed_by=%s, note=COALESCE(%s, note), updated_at=now()
                WHERE id=%s
            """, (item.unit_price, actor_id, item.note, item.lot_id))
            result.confirmed.append(item.lot_id)

    if result.confirmed:
        await write_audit(db, "PRICE_CONFIRM_BULK", "inbound_lots",
                          ",".join(map(str, result.confirmed)),
                          {"confirmed": result.confirmed,
                           "prices": {str(i.lot_id): str(i.unit_price)
                                      for i in body.items if i.lot_id in result.confirmed}},
                          actor_id, request)
    return result


@app.get("/stock/lots", response_model=list[LotStockResponse], tags=["在庫"])
async def get_lot_stock(
    db: DB,
    user: CurrentUser,
    product_id:    int | None = Query(None),
    crop_id:       int | None = Query(None),
    status_filter: str | None = Query(None, alias="status"),
    pending_price: bool = Query(False),
    include_archived: bool = Query(False),
    sub_kind:      str | None = Query(None, description="'black'=黒ニンニクのみ, 'semifinished'=半製品のみ, 'normal'=通常のみ (sub_kind=NULL)"),
    origin_name:   str | None = Query(None, description="産地名で絞り込み (例: 田子)"),
    exclude_origin_name: str | None = Query(None, description="指定産地を除外 (例: 田子)"),
):
    """ロット別在庫残の一覧（lot_stock VIEW から動的算出）。
    仕入先名・規格・産地等の表示用属性も JOIN して返す。

    新仕様の絞り込み:
      - sub_kind='black': 黒ニンニクのみ
      - sub_kind='semifinished': 半製品 (大蒜独自) のみ
      - sub_kind='normal': 通常のみ (sub_kind IS NULL)
      - origin_name='田子': 田子産のみ
      - exclude_origin_name='田子': 田子産を除外
    """
    conds, params = ["1=1"], []
    if product_id is not None:
        params.append(product_id);    conds.append("ls.product_id=%s")
    if crop_id is not None:
        params.append(crop_id);       conds.append("p.crop_id=%s")
    if status_filter:
        params.append(status_filter); conds.append("ls.stock_status=%s")
    if pending_price:
        conds.append("ls.is_price_pending=true")
    if not include_archived:
        conds.append("il.archived_at IS NULL")
    if sub_kind == 'black':
        conds.append("p.sub_kind = 'black'")
    elif sub_kind == 'semifinished':
        conds.append("p.sub_kind = 'semifinished'")
    elif sub_kind == 'normal':
        conds.append("p.sub_kind IS NULL")
    if origin_name is not None:
        params.append(origin_name);   conds.append("o.name = %s")
    if exclude_origin_name is not None:
        params.append(exclude_origin_name);  conds.append("o.name <> %s")

    async with db.cursor() as cur:
        await cur.execute(
            f"""
            SELECT
                ls.*,
                il.code     AS lot_code,
                il.selection_id,           -- バッジ表示用 (NOT NULL なら「選別」由来)
                s.name      AS supplier_name,
                g.spec_type, g.grade_level, g.size_label,
                o.name      AS origin_name,
                p.crop_id, c.name AS crop_name,
                il.prepay_date, il.prepay_amount,
                il.postpay_date, il.postpay_amount,
                il.brokerage_fee, il.freight_fee,
                -- 選別由来ロットの 投入元 仕入先数 / 産地数 (バッジ表示用)
                CASE WHEN il.selection_id IS NOT NULL THEN (
                    SELECT COUNT(DISTINCT src_il.supplier_id)
                    FROM selection_sources ss
                    JOIN inbound_lots src_il ON src_il.id = ss.lot_id
                    WHERE ss.selection_id = il.selection_id
                ) END AS selection_source_supplier_count,
                CASE WHEN il.selection_id IS NOT NULL THEN (
                    SELECT COUNT(DISTINCT src_p.origin_id)
                    FROM selection_sources ss
                    JOIN inbound_lots src_il ON src_il.id = ss.lot_id
                    JOIN products src_p ON src_p.id = src_il.product_id
                    WHERE ss.selection_id = il.selection_id
                ) END AS selection_source_origin_count,
                -- 置場 レイアウト 紐付け 済み kg (全 layout / 全 object 横断 で 集計)。
                -- capacity NULL (= 無制限) は 0 扱い → 「紐付け 可能 残数」 算出 用。
                COALESCE((
                    SELECT SUM(COALESCE(soi.capacity, 0))
                    FROM storage_object_items soi
                    WHERE soi.inbound_lot_id = ls.lot_id
                ), 0) AS bound_kg
            FROM lot_stock ls
            JOIN inbound_lots il ON il.id = ls.lot_id
            JOIN products  p ON p.id = ls.product_id
            JOIN crops     c ON c.id = p.crop_id
            JOIN grades    g ON g.id = p.grade_id
            JOIN origins   o ON o.id = p.origin_id
            JOIN suppliers s ON s.id = ls.supplier_id
            WHERE {' AND '.join(conds)}
            ORDER BY ls.lot_id
            """,
            params or None,
        )
        rows = await cur.fetchall()
    return [LotStockResponse(**r) for r in rows]


@app.get("/stock/products", tags=["在庫"])
async def get_product_stock(
    db: DB, user: CurrentUser,
    crop_id: int | None = Query(None, description="作物で絞り込み"),
    sub_kind: str | None = Query(None, description="'black' / 'semifinished' / 'normal'"),
    origin_name: str | None = Query(None, description="産地名で絞り込み"),
    exclude_origin_name: str | None = Query(None, description="指定産地を除外"),
):
    """商品別在庫サマリー（product_stock_summary VIEW）。在庫一覧画面用。"""
    conds = []
    params: list = []
    if crop_id is not None:
        conds.append("product_id IN (SELECT id FROM products WHERE crop_id = %s)")
        params.append(crop_id)
    if sub_kind == 'black':
        conds.append("product_id IN (SELECT id FROM products WHERE sub_kind='black')")
    elif sub_kind == 'semifinished':
        conds.append("product_id IN (SELECT id FROM products WHERE sub_kind='semifinished')")
    elif sub_kind == 'normal':
        conds.append("product_id IN (SELECT id FROM products WHERE sub_kind IS NULL)")
    if origin_name is not None:
        conds.append("product_id IN (SELECT p.id FROM products p JOIN origins o ON o.id=p.origin_id WHERE o.name = %s)")
        params.append(origin_name)
    if exclude_origin_name is not None:
        conds.append("product_id IN (SELECT p.id FROM products p JOIN origins o ON o.id=p.origin_id WHERE o.name <> %s)")
        params.append(exclude_origin_name)
    where = (" WHERE " + " AND ".join(conds)) if conds else ""
    async with db.cursor() as cur:
        await cur.execute(
            f"SELECT * FROM product_stock_summary{where} "
            "ORDER BY total_remaining_kg DESC",
            params or None)
        return [dict(r) for r in await cur.fetchall()]


@app.get("/dashboard/summary", response_model=DashboardSummary, tags=["在庫"])
async def get_dashboard_summary(
    db: DB,
    user: CurrentUser,
    month: str | None = Query(None, description="YYYY-MM。省略時は最新の活動月"),
    crop_id: int | None = Query(None, description="作物で絞り込み"),
    include_archived: bool = Query(False),
    sub_kind: str | None = Query(None, description="'black' / 'semifinished' / 'normal'"),
    origin_name: str | None = Query(None, description="産地名で絞り込み"),
    exclude_origin_name: str | None = Query(None, description="指定産地を除外"),
):
    """
    3つの原始データ（前月繰越・当月入荷・当月出庫）と当月在庫の合計を返す。
    当月在庫 = 前月繰越 + 当月入荷 − 当月出庫 が常に成り立つ（信頼性の起点）。
    crop_id 指定で作物別に絞り込める。
    """
    # crop_id + sub_kind + origin_name フィルタ を 1 つの product 絞り込み句にまとめる
    prod_conds: list[str] = []
    prod_params: list = []
    if crop_id is not None:
        prod_conds.append("p.crop_id = %s")
        prod_params.append(crop_id)
    if sub_kind == 'black':
        prod_conds.append("p.sub_kind = 'black'")
    elif sub_kind == 'semifinished':
        prod_conds.append("p.sub_kind = 'semifinished'")
    elif sub_kind == 'normal':
        prod_conds.append("p.sub_kind IS NULL")
    if origin_name is not None:
        prod_conds.append("p.origin_id IN (SELECT id FROM origins WHERE name = %s)")
        prod_params.append(origin_name)
    if exclude_origin_name is not None:
        prod_conds.append("p.origin_id IN (SELECT id FROM origins WHERE name <> %s)")
        prod_params.append(exclude_origin_name)

    crop_filter_sc  = ""
    crop_filter_il  = ""
    crop_filter_ob  = ""
    params_sc: list = []
    params_il: list = []
    params_ob: list = []
    if prod_conds:
        prod_where = " AND ".join(prod_conds)
        crop_filter_sc = (f" AND sc.lot_id IN (SELECT il.id FROM inbound_lots il "
                          f"JOIN products p ON p.id = il.product_id "
                          f"WHERE {prod_where})")
        crop_filter_il = (f" AND product_id IN (SELECT p.id FROM products p WHERE {prod_where})")
        crop_filter_ob = (f" AND lot_id IN (SELECT il.id FROM inbound_lots il "
                          f"JOIN products p ON p.id = il.product_id "
                          f"WHERE {prod_where})")
        params_sc = list(prod_params)
        params_il = list(prod_params)
        params_ob = list(prod_params)

    async with db.cursor() as cur:
        if not month:
            await cur.execute("""
                SELECT to_char(GREATEST(
                    COALESCE((SELECT MAX(inbound_date)  FROM inbound_lots),     DATE '1900-01-01'),
                    COALESCE((SELECT MAX(outbound_date) FROM outbound_records), DATE '1900-01-01')
                ), 'YYYY-MM') AS m
            """)
            month = (await cur.fetchone())["m"]

        first = datetime.strptime(month + "-01", "%Y-%m-%d").date()
        prev_month = (first - timedelta(days=1)).strftime("%Y-%m")

        # アーカイブ除外条件
        arch_count = " AND il.archived_at IS NULL" if not include_archived else ""
        arch_inbound = " AND archived_at IS NULL" if not include_archived else ""
        arch_lot_subq = (
            "lot_id IN (SELECT id FROM inbound_lots WHERE archived_at IS NULL)"
            if not include_archived else "TRUE"
        )

        carry_prod_filter = ""
        if prod_conds:
            carry_prod_filter = (f" AND il.product_id IN (SELECT p.id FROM products p "
                                 f"WHERE {' AND '.join(prod_conds)})")
        await cur.execute(
            f"SELECT COALESCE(SUM(counted_kg),0) AS v FROM stock_counts sc "
            f"JOIN inbound_lots il ON il.id = sc.lot_id "
            f"WHERE period=%s{arch_count}{carry_prod_filter}",
            [prev_month] + list(prod_params))
        carryover = (await cur.fetchone())["v"]

        # 「当月入荷」は外部仕入のみを集計 (selection_id IS NULL)。
        # 選別出力ロット (selection_id IS NOT NULL) は内部資産変換であり、
        # 外部からの新規仕入ではないので、当月入荷には含めない。
        await cur.execute(
            f"SELECT COALESCE(SUM(total_kg),0) AS v, COUNT(*) AS c FROM inbound_lots "
            f"WHERE to_char(inbound_date,'YYYY-MM')=%s "
            f"  AND selection_id IS NULL"
            f"  {arch_inbound}{crop_filter_il}",
            [month] + params_il)
        r = await cur.fetchone()
        inbound, inbound_count = r["v"], r["c"]

        # 「当月出庫」は選別出庫 (consume + disposal) も含めて 全出庫を集計。
        # 新仕様: 選別は出庫扱い、 産出は inbound (selection_id 付き = 入荷集計除外)。
        # → 重量バランス: 投入分は出庫として落ち、 産出分は新規ロットの remaining として残る。
        ob_arch = (f" AND {arch_lot_subq}") if not include_archived else ""
        await cur.execute(
            f"SELECT COALESCE(SUM(quantity_kg),0) AS v, COUNT(*) AS c FROM outbound_records "
            f"WHERE to_char(outbound_date,'YYYY-MM')=%s "
            f"  {crop_filter_ob}{ob_arch}",
            [month] + params_ob)
        r = await cur.fetchone()
        outbound, outbound_count = r["v"], r["c"]

        ls_conds: list[str] = []
        ls_params: list = []
        if prod_conds:
            ls_conds.append(f"product_id IN (SELECT p.id FROM products p WHERE {' AND '.join(prod_conds)})")
            ls_params.extend(prod_params)
        if not include_archived:
            ls_conds.append("lot_id IN (SELECT id FROM inbound_lots WHERE archived_at IS NULL)")
        ls_where = (" WHERE " + " AND ".join(ls_conds)) if ls_conds else ""
        await cur.execute(
            f"SELECT COALESCE(SUM(remaining_kg),0) AS v FROM lot_stock{ls_where}",
            ls_params or None)
        stock_now = (await cur.fetchone())["v"]

    return DashboardSummary(
        month=month, prev_month=prev_month,
        carryover_kg=carryover,
        inbound_kg=inbound, inbound_count=inbound_count,
        outbound_kg=outbound, outbound_count=outbound_count,
        stock_now_kg=stock_now,
    )


@app.get("/calendar", response_model=CalendarView, tags=["在庫"])
async def get_calendar(
    db: DB,
    user: CurrentUser,
    month: str | None = Query(None, description="YYYY-MM。省略時は最新の活動月"),
    crop_id: int | None = Query(None, description="作物で絞り込み"),
    include_archived: bool = Query(False, description="アーカイブ済みも含める"),
    sub_kind: str | None = Query(None, description="'black'=黒ニンニクのみ, 'semifinished'=半製品, 'normal'=通常のみ"),
    origin_name: str | None = Query(None, description="産地名で絞り込み"),
    exclude_origin_name: str | None = Query(None, description="指定産地を除外"),
):
    """
    旧Excel台帳のような「ロット × 日付」グリッド。各ロットの前月繰越と、月内の
    日ごとの純増減（+入荷 / −出庫）、当月在庫を返す。
    crop_id 指定で作物別に絞り込める。

    新仕様の絞り込み:
      - sub_kind='black': 黒ニンニクのみ
      - sub_kind='semifinished': 半製品 (大蒜独自) のみ
      - sub_kind='normal': 通常のみ (sub_kind IS NULL)
      - origin_name='田子': 田子産のみ
      - exclude_origin_name='田子': 田子産を除外
    """
    async with db.cursor() as cur:
        if not month:
            await cur.execute("""
                SELECT to_char(GREATEST(
                    COALESCE((SELECT MAX(inbound_date)  FROM inbound_lots),     DATE '1900-01-01'),
                    COALESCE((SELECT MAX(outbound_date) FROM outbound_records), DATE '1900-01-01')
                ), 'YYYY-MM') AS m
            """)
            month = (await cur.fetchone())["m"]

        first = datetime.strptime(month + "-01", "%Y-%m-%d").date()
        last = _month_last_day(month)
        prev_month = (first - timedelta(days=1)).strftime("%Y-%m")

        crop_clause = "AND p.crop_id = %(crop)s" if crop_id is not None else ""
        arch_clause = "" if include_archived else "AND il.archived_at IS NULL"
        # サブ分類 / 産地 絞り込み
        sub_clauses = []
        if sub_kind == 'black':
            sub_clauses.append("AND p.sub_kind = 'black'")
        elif sub_kind == 'semifinished':
            sub_clauses.append("AND p.sub_kind = 'semifinished'")
        elif sub_kind == 'normal':
            sub_clauses.append("AND p.sub_kind IS NULL")
        if origin_name is not None:
            sub_clauses.append("AND o.name = %(origin_name)s")
        if exclude_origin_name is not None:
            sub_clauses.append("AND o.name <> %(exclude_origin_name)s")
        sub_clause = " ".join(sub_clauses)

        # 月末までに存在したロット。前月繰越 = 前月を period とする棚卸確定値。
        # 当月棚卸 (sc_now) は紙レポート用 (棚卸数 / 差数原因) に LEFT JOIN。
        await cur.execute(f"""
            SELECT
                il.id            AS lot_id,
                il.code          AS lot_code,
                il.selection_id,                  -- バッジ表示用 (migration 028)
                s.name           AS supplier_name,
                g.spec_type,
                g.grade_level,
                g.size_label,
                o.name           AS origin_name,
                il.inbound_date,
                il.total_kg,
                il.kg_per_case,
                il.unit_price,
                il.brokerage_fee,
                il.freight_fee,
                il.prepay_date,
                il.prepay_amount,
                il.postpay_date,
                il.postpay_amount,
                COALESCE(sc.counted_kg, 0) AS carryover_kg,
                sc_now.counted_kg AS stocktake_kg,
                sc_now.note       AS stocktake_note
            FROM inbound_lots il
            JOIN suppliers s ON s.id = il.supplier_id
            JOIN products  p ON p.id = il.product_id
            JOIN grades    g ON g.id = p.grade_id
            JOIN origins   o ON o.id = p.origin_id
            LEFT JOIN stock_counts sc     ON sc.lot_id = il.id AND sc.period = %(prev)s
            LEFT JOIN stock_counts sc_now ON sc_now.lot_id = il.id AND sc_now.period = %(month)s
            WHERE il.inbound_date <= %(last)s
              {crop_clause}
              {arch_clause}
              {sub_clause}
            ORDER BY il.inbound_date, il.id
        """, {"prev": prev_month, "last": last, "month": month, "crop": crop_id,
              "origin_name": origin_name, "exclude_origin_name": exclude_origin_name})
        lot_rows = await cur.fetchall()

        # 作物名取得 (紙レポートのタイトル用)
        crop_name = None
        if crop_id is not None:
            await cur.execute("SELECT name FROM crops WHERE id=%s", (crop_id,))
            r = await cur.fetchone()
            if r:
                crop_name = r["name"]

        # 月内の出庫を ロット×日 で集計
        await cur.execute("""
            SELECT lot_id, outbound_date, SUM(quantity_kg) AS qty
            FROM outbound_records
            WHERE outbound_date BETWEEN %(first)s AND %(last)s
            GROUP BY lot_id, outbound_date
        """, {"first": first, "last": last})
        out_rows = await cur.fetchall()

        # セルコメント (migration 055) — 月内の (lot, date) ごとに 1 件
        await cur.execute("""
            SELECT lot_id, comment_date, comment
            FROM calendar_cell_comments
            WHERE comment_date BETWEEN %(first)s AND %(last)s
        """, {"first": first, "last": last})
        comment_rows = await cur.fetchall()

    out_by_lot: dict[int, dict[int, Decimal]] = {}
    for r in out_rows:
        out_by_lot.setdefault(r["lot_id"], {})[r["outbound_date"].day] = r["qty"]

    comments_by_lot: dict[int, dict[str, str]] = {}
    for r in comment_rows:
        comments_by_lot.setdefault(r["lot_id"], {})[str(r["comment_date"].day)] = r["comment"]

    lots: list[CalendarLot] = []
    for r in lot_rows:
        # 当月出庫: 日 → その日の出庫量
        daily: dict[str, Decimal] = {}
        outbound_kg = Decimal(0)
        for day, qty in out_by_lot.get(r["lot_id"], {}).items():
            daily[str(day)] = qty
            outbound_kg += qty
        # 当月入荷: 入荷日が当月にあるロットだけ
        inbound_kg = r["total_kg"] if first <= r["inbound_date"] <= last else Decimal(0)

        carryover = r["carryover_kg"]
        end_kg = carryover + inbound_kg - outbound_kg
        stocktake_kg = r.get("stocktake_kg")
        stocktake_diff = (stocktake_kg - end_kg) if stocktake_kg is not None else None
        lots.append(CalendarLot(
            lot_id=r["lot_id"], lot_code=r.get("lot_code"),
            selection_id=r.get("selection_id"),
            supplier_name=r["supplier_name"],
            spec_type=r["spec_type"],
            grade_level=r.get("grade_level"), size_label=r.get("size_label"),
            origin_name=r["origin_name"],
            inbound_date=r["inbound_date"], total_kg=r["total_kg"],
            kg_per_case=r.get("kg_per_case"),
            unit_price=r.get("unit_price"),
            carryover_kg=carryover, inbound_kg=inbound_kg, outbound_kg=outbound_kg,
            end_kg=end_kg, daily=daily,
            comments=comments_by_lot.get(r["lot_id"], {}),
            # 紙レポート用拡張
            brokerage_fee=r.get("brokerage_fee"),
            freight_fee=r.get("freight_fee"),
            prepay_date=r.get("prepay_date"),
            prepay_amount=r.get("prepay_amount"),
            postpay_date=r.get("postpay_date"),
            postpay_amount=r.get("postpay_amount"),
            stocktake_kg=stocktake_kg,
            stocktake_diff=stocktake_diff,
            stocktake_note=r.get("stocktake_note"),
        ))

    return CalendarView(
        month=month, days_in_month=last.day, lots=lots,
        crop_id=crop_id, crop_name=crop_name,
        prepared_at=datetime.now(),
    )


# =============================================================================
# 日次カレンダー Excel エクスポート (紙レポートの xlsx 版)
# =============================================================================
@app.get("/calendar/export.xlsx", tags=["在庫"])
async def export_calendar_xlsx(
    db: DB, user: CurrentUser,
    month: str | None = Query(None),
    crop_id: int | None = Query(None),
    include_archived: bool = Query(False),
    sub_kind: str | None = Query(None),
    origin_name: str | None = Query(None),
    exclude_origin_name: str | None = Query(None),
):
    """日次カレンダー の Excel (.xlsx) 版 紙レポート 出力。

    /calendar と同じ クエリパラメータ を取り、 同じデータを Excel ファイルとして返す。
    レイアウトは CalendarPrintPage.tsx (HTML) と等価。

    2 枚目シート 「在庫集計」 仕様:
      ・在庫一覧セクション: (産地, 規格) 別に 月末在庫 (end_kg) で集計
      ・棚卸セクション: layout.division = crop_id の layout 配下 entries のみ
        を (大分類×小分類) 別表に集計。 crop_id 未指定 なら 全 layout から集約。
        在庫紐づけあり (inbound_lot_id 等) のものは 除外、 大分類か小分類が
        入力されている フリー棚卸のみ 対象。
    """
    # /calendar と同じロジックでデータ取得 (既存関数を再利用)
    cal: CalendarView = await get_calendar(
        db=db, user=user, month=month, crop_id=crop_id,
        include_archived=include_archived, sub_kind=sub_kind,
        origin_name=origin_name, exclude_origin_name=exclude_origin_name,
    )

    # タイトル組立 (紙レポートと同じパターン)
    division_no = cal.crop_id if cal.crop_id is not None else "?"
    month_no = int(cal.month[5:7]) if cal.month else 0
    sub_label = ""
    if sub_kind == 'black':         sub_label = "黒ニンニク"
    elif sub_kind == 'semifinished': sub_label = "半製品"
    elif origin_name:                sub_label = f"{origin_name}産"
    elif exclude_origin_name or sub_kind == 'normal': sub_label = "通常"
    title = f"みどり物産事業{division_no}部{month_no}月仕入管理台帳"
    if sub_label:
        title += f"「{sub_label}」"

    # 表示日数 (当月なら今日まで、 過去月なら 末日まで)
    today_local = datetime.now().date()
    is_current = cal.month == today_local.strftime("%Y-%m")
    days = today_local.day if is_current else cal.days_in_month
    days = min(days, cal.days_in_month)

    # 在庫に紐づかない棚卸エントリ を 取得 (2 枚目シート 用 集計)。
    # 「最新分のみ」 = 各 (object_id, name) で 最新 1 件 (棚卸 し直す と 古いのは
    # 削除/上書き される 運用 前提)。 ref 系 (inbound_lot_id, material_id,
    # semifinished_lot_id, outbound_id) が 全て NULL の エントリ のみ 対象。
    # さらに 大分類 または 小分類 が 入力されている もの だけ 集計 (フリー棚卸タブから
    # 入力されたものの 代理指標)。 両方 NULL は 入れ違い とみなして 除外。
    #
    # 重要: crop_id が 指定 されている 場合、 layout.division = crop_id の layout
    #       配下 entries のみ に 絞る。 storage_layouts.division は crops.id と
    #       同じ番号 (= 事業部 = 作物 division)。 これ により 長芋 (crop_id=3) の
    #       カレンダー で 生姜 (division=1) 棚卸 が 混ざる 問題 を 防ぐ。
    #       (置き場借り 機能 は 未導入 のため、 entries は 必ず 自部署 layout に 属する)
    # crop_id IS NULL (= 全作物) の場合 は division フィルタ なし (全 layout から 集約)。
    inventory_entries_summary: list[dict] = []
    async with db.cursor() as cur:
        await cur.execute("""
            WITH latest AS (
                SELECT DISTINCT ON (e.object_id, COALESCE(e.name, '')) e.*
                  FROM storage_object_inventory_entries e
                  JOIN storage_objects o ON o.id = e.object_id
                  JOIN storage_layouts l ON l.id = o.layout_id
                 WHERE e.inbound_lot_id      IS NULL
                   AND e.material_id         IS NULL
                   AND e.semifinished_lot_id IS NULL
                   AND e.outbound_id         IS NULL
                   AND (NULLIF(TRIM(e.category_major), '') IS NOT NULL
                     OR NULLIF(TRIM(e.category_minor), '') IS NOT NULL)
                   AND (%(crop)s::int IS NULL OR l.division = %(crop)s::int)
                 ORDER BY e.object_id, COALESCE(e.name, ''),
                          e.inventory_date DESC, e.id DESC
            )
            SELECT
                COALESCE(NULLIF(TRIM(category_major), ''), NULL) AS category_major,
                COALESCE(NULLIF(TRIM(category_minor), ''), NULL) AS category_minor,
                COALESCE(NULLIF(TRIM(origin_text),    ''), NULL) AS origin,
                COALESCE(NULLIF(TRIM(spec_text),      ''), NULL) AS spec,
                COALESCE(NULLIF(TRIM(sub_spec_text),  ''), NULL) AS sub_spec,
                SUM(cases)    AS cases,
                SUM(total_kg) AS total_kg
              FROM latest
             GROUP BY category_major, category_minor, origin, spec, sub_spec
             ORDER BY category_major NULLS LAST, category_minor NULLS LAST,
                      origin NULLS LAST, spec NULLS LAST, sub_spec NULLS LAST
        """, {"crop": crop_id})
        for r in await cur.fetchall():
            inventory_entries_summary.append({
                "category_major": r["category_major"],
                "category_minor": r["category_minor"],
                "origin":         r["origin"],
                "spec":           r["spec"],
                "sub_spec":       r["sub_spec"],
                "cases":          float(r["cases"]) if r["cases"] is not None else None,
                "total_kg":       float(r["total_kg"]) if r["total_kg"] is not None else None,
            })

        # raw entries (= GROUP BY 前): Excel 集計表 を SUMIFS 数式 化 する 用 の
        # 参照 元 hidden sheet 行 (2026-05-30 user 要望)。 集計 と 同 latest 抽出
        # ロジック で 行 単位 で 取得。
        await cur.execute("""
            WITH latest AS (
                SELECT DISTINCT ON (e.object_id, COALESCE(e.name, '')) e.*
                  FROM storage_object_inventory_entries e
                  JOIN storage_objects o ON o.id = e.object_id
                  JOIN storage_layouts l ON l.id = o.layout_id
                 WHERE e.inbound_lot_id      IS NULL
                   AND e.material_id         IS NULL
                   AND e.semifinished_lot_id IS NULL
                   AND e.outbound_id         IS NULL
                   AND (NULLIF(TRIM(e.category_major), '') IS NOT NULL
                     OR NULLIF(TRIM(e.category_minor), '') IS NOT NULL)
                   AND (%(crop)s::int IS NULL OR l.division = %(crop)s::int)
                 ORDER BY e.object_id, COALESCE(e.name, ''),
                          e.inventory_date DESC, e.id DESC
            )
            SELECT
                COALESCE(NULLIF(TRIM(category_major), ''), '') AS category_major,
                COALESCE(NULLIF(TRIM(category_minor), ''), '') AS category_minor,
                COALESCE(NULLIF(TRIM(origin_text),    ''), '') AS origin,
                COALESCE(NULLIF(TRIM(spec_text),      ''), '') AS spec,
                COALESCE(NULLIF(TRIM(sub_spec_text),  ''), '') AS sub_spec,
                cases, total_kg, kg_per_case, name, inventory_date
              FROM latest
             ORDER BY category_major, category_minor, origin, spec, sub_spec
        """, {"crop": crop_id})
        inventory_entries_raw: list[dict] = []
        for r in await cur.fetchall():
            inventory_entries_raw.append({
                "category_major": r["category_major"],
                "category_minor": r["category_minor"],
                "origin":         r["origin"],
                "spec":           r["spec"],
                "sub_spec":       r["sub_spec"],
                "cases":          float(r["cases"]) if r["cases"] is not None else None,
                "total_kg":       float(r["total_kg"]) if r["total_kg"] is not None else None,
                "kg_per_case":    float(r["kg_per_case"]) if r["kg_per_case"] is not None else None,
                "name":           r["name"],
                "inventory_date": r["inventory_date"].isoformat() if r["inventory_date"] else None,
            })

    # CalendarView は pydantic BaseModel → dict 化
    from api.services.calendar_excel import build_calendar_xlsx
    data_dict = cal.model_dump(mode="json")
    xlsx_bytes = build_calendar_xlsx(
        data_dict, title=title, days=days,
        inventory_entries_summary=inventory_entries_summary,
        inventory_entries_raw=inventory_entries_raw,
    )

    fname_part = f"crop{crop_id}" if crop_id else "all"
    if sub_kind:
        fname_part += f"_{sub_kind}"
    elif origin_name:
        fname_part += f"_{origin_name}"
    filename = f"calendar_{cal.month}_{fname_part}.xlsx"

    return StreamingResponse(
        iter([xlsx_bytes]),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            # RFC 5987: 日本語ファイル名を UTF-8 で安全に渡す
            "Content-Disposition": f"attachment; filename=\"{filename}\"; filename*=UTF-8''{filename}",
        },
    )


# =============================================================================
# 大蒜 Excel 仕入管理台帳 同期 (旧 .xlsm を システム在庫データで 更新)
# =============================================================================

@app.post("/garlic/ledger-sync", tags=["大蒜"])
async def garlic_ledger_sync_endpoint(
    db: DB, user: OperatorUser, request: Request,
    file: UploadFile = File(..., description="入力 .xlsm (大蒜 仕入管理台帳)"),
    month: str = Form(..., description="同期対象月 'YYYY-MM'"),
    dry_run: bool = Form(False, description="True=プレビュー(警告のみ返す) / False=実行+.xlsm返却"),
):
    """大蒜 (事業2部) の Excel 仕入管理台帳 を システム在庫データで同期。

    入力: 旧 .xlsm をアップロード + 月指定
    処理: 3 シート (仕入管理台帳/半製品/黒にんにく) を 当月分 (col17-20, col24-54) 同期
          棚卸列 (col21-23) は触らない、 既存 VBA マクロは保持
    返り値:
        dry_run=True : JSON {sheets, warnings, master_warnings}
        dry_run=False: .xlsm バイナリ (Content-Disposition で ダウンロード)
                       + ヘッダ X-Sync-Result に サマリ JSON
    """
    if not re.fullmatch(r"\d{4}-\d{2}", month):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="month は YYYY-MM 形式で指定してください")
    try:
        raw = await file.read()
    except Exception as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=f"ファイル読込み失敗: {e}")

    from api.services.garlic_ledger_sync import sync_garlic_ledger
    try:
        xlsm_bytes, result = await sync_garlic_ledger(raw, month, db, dry_run=dry_run)
    except Exception as e:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR,
                            detail=f"同期処理失敗: {e}")

    await write_audit(
        db, "GARLIC_LEDGER_SYNC", "inbound_lots", month,
        {"month": month, "dry_run": dry_run,
         "sheets": result["sheets"],
         "warnings_count": len(result["warnings"]),
         "master_warnings_count": len(result["master_warnings"])},
        user["id"], request,
    )

    if dry_run:
        return JSONResponse(content=result)

    # 実行: ファイル返却 + サマリは ヘッダ にも 入れる (frontend で 警告を 表示)
    import json, base64
    from urllib.parse import quote
    src_name = file.filename or "garlic_ledger.xlsm"
    base = src_name.rsplit(".", 1)[0]
    out_name = f"{base}_synced_{month}.xlsm"
    # Content-Disposition の filename フィールド は latin-1 制約。
    # 日本語名 は URL エンコード (RFC 5987) で 渡す。 fallback の filename= も ASCII 化。
    out_name_quoted = quote(out_name)
    summary_b64 = base64.b64encode(json.dumps(result, ensure_ascii=False).encode("utf-8")).decode("ascii")
    return StreamingResponse(
        iter([xlsm_bytes]),
        media_type="application/vnd.ms-excel.sheet.macroEnabled.12",
        headers={
            "Content-Disposition":
                f"attachment; filename=\"garlic_ledger_synced_{month}.xlsm\"; "
                f"filename*=UTF-8''{out_name_quoted}",
            "X-Sync-Result-Base64": summary_b64,
            "Access-Control-Expose-Headers": "X-Sync-Result-Base64, Content-Disposition",
        },
    )


# =============================================================================
# 日次カレンダー セル コメント (migration 055)
# =============================================================================
# 「(lot_id, comment_date) に対して 1 コメント」 を upsert/delete。
# 紙レポートにも反映される (CalendarView.lots[].comments)。

class CellCommentUpsertRequest(BaseModel):
    lot_id:       int
    comment_date: date
    comment:      str


@app.put("/calendar/comments", tags=["在庫"])
async def upsert_cell_comment(
    body: CellCommentUpsertRequest, db: DB, user: CurrentUser,
):
    """セルコメントを upsert (新規 / 上書き)。 空文字なら 400。"""
    txt = (body.comment or "").strip()
    if not txt:
        raise HTTPException(status_code=400, detail="コメント本文が空です")
    async with db.cursor() as cur:
        # lot 存在チェック
        await cur.execute("SELECT 1 FROM inbound_lots WHERE id=%s", (body.lot_id,))
        if not await cur.fetchone():
            raise HTTPException(status_code=404, detail=f"lot_id={body.lot_id} が見つかりません")
        await cur.execute(
            """
            INSERT INTO calendar_cell_comments (lot_id, comment_date, comment, created_by)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (lot_id, comment_date)
                DO UPDATE SET comment = EXCLUDED.comment,
                              updated_at = NOW()
            RETURNING id, lot_id, comment_date, comment, created_at, updated_at
            """,
            (body.lot_id, body.comment_date, txt, user["id"]),
        )
        r = await cur.fetchone()
        await db.commit()
    return dict(r)


class CellCommentDeleteRequest(BaseModel):
    lot_id:       int
    comment_date: date


@app.delete("/calendar/comments", tags=["在庫"])
async def delete_cell_comment(
    body: CellCommentDeleteRequest, db: DB, user: CurrentUser,
):
    """セルコメントを削除。 存在しなくても 204 (idempotent)。"""
    async with db.cursor() as cur:
        await cur.execute(
            "DELETE FROM calendar_cell_comments WHERE lot_id=%s AND comment_date=%s",
            (body.lot_id, body.comment_date),
        )
        await db.commit()
    return {"deleted": True}


# =============================================================================
# (廃止) 半製品 日次カレンダー
# =============================================================================
# 新仕様 (2026-05) で半製品の増減記録は廃止。 棚卸登録のみ運用。
# 旧 /semifinished/calendar エンドポイントは削除済み。
# 半製品台帳画面は SemifinishedPage と /semifinished/stock 等の単純な VIEW で対応。


@app.get("/monthly-close/preview", response_model=MonthlyClosePreview, tags=["月次締め"])
async def monthly_close_preview(
    db: DB,
    user: CurrentUser,
    month: str | None = Query(None, description="YYYY-MM。省略時は最新の活動月"),
):
    """
    月次締めのプレビュー。締め対象月の各ロットについて、システム計算在庫（理論値）と
    既存の棚卸確定値を返す。ユーザーはこれに実地棚卸数を入力して締める。
    """
    async with db.cursor() as cur:
        if not month:
            await cur.execute("""
                SELECT to_char(GREATEST(
                    COALESCE((SELECT MAX(inbound_date)  FROM inbound_lots),     DATE '1900-01-01'),
                    COALESCE((SELECT MAX(outbound_date) FROM outbound_records), DATE '1900-01-01')
                ), 'YYYY-MM') AS m
            """)
            month = (await cur.fetchone())["m"]
        last_day = _month_last_day(month)

        # 締め対象月末までに存在したロット。理論値 = 起点 − 起点日〜月末の出庫。
        await cur.execute("""
            SELECT
                il.id                AS lot_id,
                s.name               AS supplier_name,
                g.spec_type,
                o.name               AS origin_name,
                il.inbound_date,
                ls.base_kg - COALESCE((
                    SELECT SUM(ob.quantity_kg) FROM outbound_records ob
                    WHERE ob.lot_id = il.id
                      AND (ls.base_date IS NULL OR ob.outbound_date > ls.base_date)
                      AND ob.outbound_date <= %(last_day)s
                ), 0)                AS theoretical_kg,
                sc.counted_kg,
                sc.note,
                (sc.id IS NOT NULL)  AS already_counted
            FROM inbound_lots il
            JOIN suppliers  s  ON s.id = il.supplier_id
            JOIN products   p  ON p.id = il.product_id
            JOIN grades     g  ON g.id = p.grade_id
            JOIN origins    o  ON o.id = p.origin_id
            JOIN lot_stock  ls ON ls.lot_id = il.id
            LEFT JOIN stock_counts sc ON sc.lot_id = il.id AND sc.period = %(month)s
            WHERE il.inbound_date <= %(last_day)s
            ORDER BY il.id
        """, {"month": month, "last_day": last_day})
        rows = await cur.fetchall()

    return MonthlyClosePreview(
        month=month,
        count_date=last_day,
        is_closed=any(r["already_counted"] for r in rows),
        lots=[MonthlyCloseLot(**r) for r in rows],
    )


@app.post("/monthly-close", response_model=MonthlyCloseResult, tags=["月次締め"])
async def monthly_close(body: MonthlyCloseRequest, db: DB,
                        admin: AdminUser, request: Request):
    """
    月次締めを確定する（管理者のみ）。各ロットの実地棚卸数を stock_counts に確定登録し、
    翌月の前月繰越とする。差数（実地 − 理論）を theoretical_kg として併せて保存する。
    既に確定済みの月を再度締めた場合は上書き（訂正）する。

    fill_variance=true のロットでは、差数を埋める調整 movement を outbound_records に
    最終日付で自動作成する。
        差数 > 0（実地多）→ quantity_kg = 負値（逆出庫＝未記録入荷）
        差数 < 0（実地少）→ quantity_kg = 正値（未記録出庫）
    これにより締め後の計算在庫が実地と一致する。
    """
    last_day = _month_last_day(body.month)
    variances: list[dict] = []
    adjustments: list[dict] = []
    total_counted = Decimal(0)
    total_theoretical = Decimal(0)

    async with db.cursor() as cur:
        for item in body.items:
            # 締め時点の理論在庫 = 起点 − 起点日〜月末の出庫
            await cur.execute(
                "SELECT base_kg, base_date FROM lot_stock WHERE lot_id=%s", (item.lot_id,))
            lot = await cur.fetchone()
            if lot is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND,
                                    detail=f"ロット {item.lot_id} が見つかりません")
            await cur.execute("""
                SELECT COALESCE(SUM(quantity_kg), 0) AS v FROM outbound_records
                WHERE lot_id=%s
                  AND (%s::date IS NULL OR outbound_date > %s)
                  AND outbound_date <= %s
            """, (item.lot_id, lot["base_date"], lot["base_date"], last_day))
            outbound_to_date = (await cur.fetchone())["v"]
            theoretical = lot["base_kg"] - outbound_to_date  # 締め時点の元の理論値
            var = item.counted_kg - theoretical              # 差数（counted − theoretical）

            # 差数を埋める調整 movement（fill_variance && 差数≠0）
            if item.fill_variance and var != 0:
                adj_qty = -var  # 差数を打ち消す向き
                await cur.execute("""
                    INSERT INTO outbound_records
                        (lot_id, outbound_date, quantity_kg, note, created_by)
                    VALUES (%s, %s, %s, %s, %s)
                    RETURNING id
                """, (item.lot_id, last_day, adj_qty,
                      f"棚卸調整 ({body.month} 差数{float(var):+.4f}kg)", admin["id"]))
                adj_id = (await cur.fetchone())["id"]
                adjustments.append({
                    "lot_id":      item.lot_id,
                    "record_id":   adj_id,
                    "quantity_kg": float(adj_qty),
                    "kind":        "出庫追加" if adj_qty > 0 else "入庫戻し",
                })

            # stock_counts には元の理論値を保存（差数は監査として残す）。
            # 調整 movement を作成した場合は計算上 remaining = counted_kg に揃っている。
            await cur.execute("""
                INSERT INTO stock_counts
                    (lot_id, period, count_date, counted_kg, theoretical_kg,
                     source, note, confirmed_by)
                VALUES (%s, %s, %s, %s, %s, 'physical_count', %s, %s)
                ON CONFLICT (lot_id, period) DO UPDATE SET
                    count_date     = EXCLUDED.count_date,
                    counted_kg     = EXCLUDED.counted_kg,
                    theoretical_kg = EXCLUDED.theoretical_kg,
                    note           = EXCLUDED.note,
                    confirmed_by   = EXCLUDED.confirmed_by,
                    confirmed_at   = now()
            """, (item.lot_id, body.month, last_day, item.counted_kg,
                  theoretical, item.reason, admin["id"]))

            total_counted += item.counted_kg
            total_theoretical += theoretical
            if var != 0:
                variances.append({
                    "lot_id":         item.lot_id,
                    "counted_kg":     float(item.counted_kg),
                    "theoretical_kg": float(theoretical),
                    "variance_kg":    float(var),
                    "reason":         item.reason,
                    "filled":         item.fill_variance,
                })

        await write_audit(db, "MONTHLY_CLOSE", "stock_counts", body.month,
                          {"month": body.month, "lots": len(body.items),
                           "total_counted": float(total_counted),
                           "variance_count": len(variances),
                           "adjustments": len(adjustments)},
                          admin["id"], request)

    return MonthlyCloseResult(
        month=body.month,
        closed_count=len(body.items),
        total_counted_kg=total_counted,
        total_theoretical_kg=total_theoretical,
        total_variance_kg=total_counted - total_theoretical,
        variances=variances,
        adjustments=adjustments,
    )


@app.get("/stock/eligible", tags=["在庫"])
async def get_eligible_lots(
    db: DB,
    user: CurrentUser,
    product_id:   int   = Query(...),
    quantity_kg:  float = Query(...),
    supplier_id:  int | None = Query(None),
    inbound_date: date | None = Query(None),
    kg_per_case:  float | None = Query(None),
):
    """FIFOで引き当て可能なロット候補を返す（fifo_eligible_lots VIEW）。"""
    conds: list[str] = ["fel.product_id=%s", "fel.remaining_kg>0"]
    params: list[Any] = [product_id]
    if supplier_id is not None:
        params.append(supplier_id);  conds.append("fel.supplier_id=%s")
    if inbound_date is not None:
        params.append(inbound_date); conds.append("fel.inbound_date=%s")
    if kg_per_case is not None:
        params.append(kg_per_case);  conds.append("il.kg_per_case=%s")

    async with db.cursor() as cur:
        await cur.execute(f"""
            SELECT fel.*, il.kg_per_case, il.cases, s.name AS supplier_name,
                   g.spec_type, g.grade_level, g.size_label, o.name AS origin_name
            FROM fifo_eligible_lots fel
            JOIN inbound_lots il ON il.id = fel.lot_id
            JOIN products     p  ON p.id  = fel.product_id
            JOIN grades       g  ON g.id  = p.grade_id
            JOIN origins      o  ON o.id  = p.origin_id
            JOIN suppliers    s  ON s.id  = fel.supplier_id
            WHERE {' AND '.join(conds)}
            ORDER BY fel.fifo_rank
        """, params)
        rows = await cur.fetchall()

    total = sum(float(r["remaining_kg"]) for r in rows)
    return {
        "candidates":         [dict(r) for r in rows],
        "total_available_kg": total,
        "is_sufficient":      total >= quantity_kg,
        "auto_select":        len(rows) == 1,
    }


@app.post("/masters/origins", status_code=status.HTTP_201_CREATED, tags=["マスタ"])
async def create_origin(name: str, db: DB, admin: AdminUser, region: str | None = None):
    """産地マスタを登録（既存名はregionを更新）。管理者のみ（仕様書4.1）。

    正規化ルール:
      - 末尾の 「産」 は自動で取り除く (青森県産 → 青森県)
      - 重複登録防止のため、 同名 (正規化後) があれば region のみ更新
    """
    normalized = name.strip()
    # 末尾 「産」 を取り除く (青森県産 → 青森県、 北海道産 → 北海道)
    while normalized.endswith('産'):
        normalized = normalized[:-1].rstrip()
    if not normalized:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="産地名が空、 または 「産」 のみです")
    async with db.cursor() as cur:
        await cur.execute("""
            INSERT INTO origins (name, region) VALUES (%s,%s)
            ON CONFLICT (name) DO UPDATE SET region=EXCLUDED.region
            RETURNING *
        """, (normalized, region))
        row = await cur.fetchone()
    return dict(row)


@app.post("/masters/grades", status_code=status.HTTP_201_CREATED, tags=["マスタ"])
async def create_grade(
    spec_type: str, grade_level: str, size_label: str,
    db: DB, admin: AdminUser, size_mm: int | None = None,
):
    """規格マスタを登録（規格種別+等級+サイズで一意）。管理者のみ（仕様書4.1）。"""
    async with db.cursor() as cur:
        await cur.execute("""
            INSERT INTO grades (spec_type, grade_level, size_label, size_mm)
            VALUES (%s,%s,%s,%s)
            ON CONFLICT (spec_type, grade_level, size_label) DO NOTHING
            RETURNING *
        """, (spec_type.strip(), grade_level.strip(), size_label.strip(), size_mm))
        row = await cur.fetchone()
    return dict(row)


@app.post("/masters/suppliers", status_code=status.HTTP_201_CREATED, tags=["マスタ"])
async def create_supplier(name: str, db: DB, admin: AdminUser, name_kana: str | None = None):
    """仕入先マスタを登録（既存名は読み仮名を補完）。管理者のみ（仕様書4.1）。"""
    async with db.cursor() as cur:
        await cur.execute("""
            INSERT INTO suppliers (name, name_kana) VALUES (%s,%s)
            ON CONFLICT (name) DO UPDATE
              SET name_kana=COALESCE(EXCLUDED.name_kana, suppliers.name_kana)
            RETURNING *
        """, (name.strip(), name_kana))
        row = await cur.fetchone()
    return dict(row)


@app.post("/masters/products", status_code=status.HTTP_201_CREATED, tags=["マスタ"])
async def create_product(grade_id: int, origin_id: int, db: DB, admin: AdminUser,
                         crop_id: int | None = None):
    """商品マスタを登録（規格ID×産地IDで一意）。管理者のみ（仕様書3.2 / 4.1）。
    crop_id 省略時は '01' (生姜) を割り当てる。"""
    async with db.cursor() as cur:
        await cur.execute("SELECT 1 FROM grades WHERE id=%s", (grade_id,))
        if not await cur.fetchone():
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                detail=f"規格ID {grade_id} が見つかりません")
        await cur.execute("SELECT 1 FROM origins WHERE id=%s", (origin_id,))
        if not await cur.fetchone():
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                detail=f"産地ID {origin_id} が見つかりません")

        if crop_id is None:
            await cur.execute("SELECT id FROM crops WHERE code='01'")
            crop_id = (await cur.fetchone())["id"]

        await cur.execute("""
            INSERT INTO products (crop_id, grade_id, origin_id) VALUES (%s,%s,%s)
            ON CONFLICT (grade_id, origin_id) DO NOTHING
            RETURNING *
        """, (crop_id, grade_id, origin_id))
        row = await cur.fetchone()
        if row is None:  # 既存。既存行を返す
            await cur.execute(
                "SELECT * FROM products WHERE grade_id=%s AND origin_id=%s",
                (grade_id, origin_id))
            row = await cur.fetchone()
    return dict(row)


@app.get("/masters/suppliers", tags=["マスタ"])
async def list_suppliers(db: DB, user: CurrentUser):
    """仕入先マスタ一覧。"""
    async with db.cursor() as cur:
        await cur.execute("SELECT * FROM suppliers WHERE is_active ORDER BY name")
        return [dict(r) for r in await cur.fetchall()]


@app.get("/masters/origins", tags=["マスタ"])
async def list_origins(db: DB, user: CurrentUser):
    """産地マスタ一覧。"""
    async with db.cursor() as cur:
        await cur.execute("SELECT * FROM origins WHERE is_active ORDER BY name")
        return [dict(r) for r in await cur.fetchall()]


@app.get("/masters/grades", tags=["マスタ"])
async def list_grades(
    db: DB, user: CurrentUser,
    crop_id: int | None = Query(None,
        description="指定すると、 その作物の商品で使われている規格のみ返す"),
):
    """規格マスタ一覧。 crop_id を渡すとその作物で使用中の規格に絞る。"""
    async with db.cursor() as cur:
        if crop_id is not None:
            await cur.execute("""
                SELECT DISTINCT g.*
                FROM grades g
                JOIN products p ON p.grade_id = g.id
                WHERE g.is_active AND p.is_active AND p.crop_id = %s
                ORDER BY g.spec_type, g.grade_level, g.size_label
            """, (crop_id,))
        else:
            await cur.execute("""
                SELECT * FROM grades WHERE is_active
                ORDER BY spec_type, grade_level, size_label
            """)
        return [dict(r) for r in await cur.fetchall()]


@app.get("/masters/products", tags=["マスタ"])
async def list_products(
    db: DB, user: CurrentUser,
    crop_id: int | None = Query(None),
):
    """商品マスタ一覧（規格・産地・作物を結合した表示用）。"""
    conds, params = ["p.is_active"], []
    if crop_id is not None:
        params.append(crop_id); conds.append("p.crop_id = %s")
    async with db.cursor() as cur:
        await cur.execute(f"""
            SELECT p.id, p.crop_id, p.grade_id, p.origin_id,
                   c.name AS crop_name, c.code AS crop_code,
                   g.spec_type, g.grade_level, g.size_label, g.size_mm,
                   o.name AS origin_name, o.region
            FROM products p
            JOIN crops   c ON c.id = p.crop_id
            JOIN grades  g ON g.id = p.grade_id
            JOIN origins o ON o.id = p.origin_id
            WHERE {' AND '.join(conds)}
            ORDER BY c.code, g.spec_type, o.name
        """, params or None)
        return [dict(r) for r in await cur.fetchall()]


@app.get("/audit/log", tags=["監査"])
async def get_audit_log(
    db: DB,
    admin: AdminUser,
    table_name: str | None  = Query(None),
    actor_id:   UUID | None = Query(None),
    limit:      int = Query(100, ge=1, le=1000),
    offset:     int = Query(0, ge=0),
):
    """監査ログの時系列照会（管理者のみ。仕様書4.2 Immutable Log）。"""
    conds, params = ["1=1"], []
    if table_name:
        params.append(table_name); conds.append("al.table_name=%s")
    if actor_id:
        params.append(str(actor_id)); conds.append("al.actor_id=%s")
    params += [limit, offset]

    async with db.cursor() as cur:
        await cur.execute(f"""
            SELECT al.*, u.display_name AS actor_name
            FROM audit_log al
            LEFT JOIN users u ON u.id=al.actor_id
            WHERE {' AND '.join(conds)}
            ORDER BY occurred_at DESC
            LIMIT %s OFFSET %s
        """, params)
        rows = await cur.fetchall()
    return [dict(r) for r in rows]


# =============================================================================
# 訂正履歴（仕様書4.2）— 過去データの修正。修正前の値を必ず保存する。
# =============================================================================

@app.post("/corrections", status_code=status.HTTP_201_CREATED, tags=["訂正"])
async def create_correction(body: CorrectionRequest, db: DB,
                            admin: AdminUser, request: Request):
    """
    過去データを訂正する（管理者のみ）。
    対象列を更新し、修正前の値を correction_records に保存する（仕様書4.2）。
    訂正可能な列はテーブルごとのホワイトリストに限る。
    """
    table = body.target_table
    if table not in _CORRECTABLE:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail=f"訂正対象テーブルが不正です: {table}")
    fields = _CORRECTABLE[table]
    if body.field_name not in fields:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{table} で訂正できない項目です: {body.field_name}"
                   f"（訂正可: {', '.join(fields)}）")
    kind = fields[body.field_name]
    try:
        new_typed = _coerce(body.new_value, kind)
    except (ValueError, ArithmeticError):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail=f"値の形式が不正です（期待型: {kind}）: {body.new_value}")

    # table / field_name はホワイトリスト済みのため SQL に埋め込んで安全
    async with db.cursor() as cur:
        await cur.execute(
            f"SELECT {body.field_name} AS v FROM {table} WHERE id=%s", (body.target_id,))
        target = await cur.fetchone()
        if target is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                detail=f"{table} id={body.target_id} が見つかりません")
        old_value = target["v"]

        await cur.execute(
            f"UPDATE {table} SET {body.field_name}=%s WHERE id=%s",
            (new_typed, body.target_id))

        await cur.execute("""
            INSERT INTO correction_records
                (target_table, target_id, field_name, old_value, new_value,
                 reason, corrected_by)
            VALUES (%s,%s,%s,%s,%s,%s,%s)
            RETURNING *
        """, (table, body.target_id, body.field_name,
              None if old_value is None else str(old_value),
              body.new_value, body.reason, admin["id"]))
        rec = await cur.fetchone()

    await write_audit(db, "CORRECTION", table, str(body.target_id),
                      {"field": body.field_name,
                       "old": None if old_value is None else str(old_value),
                       "new": body.new_value, "reason": body.reason},
                      admin["id"], request)
    return dict(rec)


@app.get("/corrections", tags=["訂正"])
async def list_corrections(
    db: DB,
    user: CurrentUser,
    target_table: str | None = Query(None),
    target_id:    int | None = Query(None),
):
    """訂正履歴の照会（仕様書4.2 修正履歴）。"""
    conds, params = ["1=1"], []
    if target_table:
        params.append(target_table); conds.append("cr.target_table=%s")
    if target_id is not None:
        params.append(target_id);    conds.append("cr.target_id=%s")

    async with db.cursor() as cur:
        await cur.execute(f"""
            SELECT cr.*, u.display_name AS corrected_by_name
            FROM correction_records cr
            LEFT JOIN users u ON u.id = cr.corrected_by
            WHERE {' AND '.join(conds)}
            ORDER BY cr.corrected_at DESC
        """, params or None)
        return [dict(r) for r in await cur.fetchall()]


# =============================================================================
# SPA catch-all 登録 — ファイル末尾 (全 API ルート定義の 後) に 置く
# =============================================================================
# FastAPI は 登録順 マッチング。 `/{full_path:path}` は どの パス にも マッチ する ので、
# 必ず 他 の 全ルート 登録 の 「後」 に 置か ない と、 後続 ルート が shadow される。
# =============================================================================
if _SERVE_FRONTEND:
    from fastapi.responses import FileResponse

    # index.html は **no-cache** で 返す:
    # vite build は JS / CSS の ファイル名 に ハッシュ を 入れる ので、 これら は
    # 強い キャッシュ で OK。 ただし index.html を キャッシュ すると ブラウザ が
    # 古い HTML → 古い ハッシュ JS を 取りに行って 404 → 白画面 になる。
    # 「index.html だけ no-cache、 assets は long cache」 が SPA 配信 の 王道。
    _NO_CACHE_HEADERS = {
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
    }

    async def _spa_fallback(full_path: str):
        """API/uploads/assets 以外の 全パス は index.html を 返す (React Router 任せ)。"""
        if full_path in _public_files:
            # favicon 等 の 静的 ファイル: 軽め の キャッシュ (1 時間) — index.html 以外
            return FileResponse(_dist_dir / full_path,
                                headers={"Cache-Control": "public, max-age=3600"})
        return FileResponse(_dist_dir / "index.html", headers=_NO_CACHE_HEADERS)

    app.add_api_route(
        "/{full_path:path}",
        _spa_fallback,
        methods=["GET"],
        include_in_schema=False,
    )
