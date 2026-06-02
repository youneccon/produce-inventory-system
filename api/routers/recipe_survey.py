"""
api/routers/recipe_survey.py
=============================
担当者向け公開レシピ提案 + 管理者向けレビュー API。

公開エンドポイント (認証不要):
  GET  /public/recipe-survey/{division_code}/seed
      フォーム描画用シードデータ (事業部名、 商品リスト、 資材リスト)
  POST /public/recipe-survey/{division_code}
      提案セッション送信 (recipe_submissions + lines に staging 保存)

管理者エンドポイント (admin 認証必須):
  GET    /admin/recipe-submissions
      提案一覧 (status / division でフィルタ)
  GET    /admin/recipe-submissions/{id}
      詳細 (lines も含む)
  POST   /admin/recipe-submissions/{id}/approve
      承認 → 正規 product_material_usage に流し込み
  POST   /admin/recipe-submissions/{id}/reject
      却下
  DELETE /admin/recipe-submissions/{id}
      物理削除 (掃除用)

公開エンドポイントは認証ゲートが無いため、 念のため以下のガードを入れている:
  - division_code は 1..99 の範囲
  - 1 セッションあたり line 数 200 まで
  - 自由テキストは 200 文字まで
  - submitter_name は 50 文字まで
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from api.audit import write_audit
from api.auth import AdminUser, CurrentUser, assert_can_edit_recipe
from api.dependencies import DB

# 公開 router (認証不要) と 管理 router (認証必須) と 内部 router (認証必須) を分離
public_router = APIRouter(prefix="/public/recipe-survey", tags=["公開レシピ提案"])
admin_router = APIRouter(prefix="/admin/recipe-submissions", tags=["公開レシピ提案"])
# 内部 router: 2026-05 で 追加 — 認証付き で アンケート頁を 操作 (権限ベース)
# 公開と機能は 同じ だが、 write は assert_can_edit_recipe(user, division) で 権限チェック
private_router = APIRouter(prefix="/recipe-survey", tags=["レシピ提案 (内部)"])

DIVISION_NAMES: dict[int, str] = {
    1: "生姜", 2: "大蒜", 3: "長芋", 4: "牛蒡", 5: "薩摩芋", 6: "物流",
}


# =============================================================================
# モデル
# =============================================================================

class SurveyProduct(BaseModel):
    id:        int
    name:      str
    unit:      str | None = None
    pack_size: Decimal | None = None      # 1 ケース入り数 (表示用、 例: "20入")


class SurveyMaterial(BaseModel):
    id:            int
    code:          str
    item_name:     str
    supplier_name: str
    unit:          str | None = None
    category:      str | None = None
    division:      int | None = None
    has_length:    bool        # length_per_roll_cm が設定されているか (cm/巻 単位指定)
    length_per_roll_cm: Decimal | None = None     # 1巻 あたりの cm (担当者へのヒント表示用)
    is_general_supply: bool = False  # 一般消耗品 (どの商品にも紐付けない、 担当者は判定不要)


class ExistingRecipeEntry(BaseModel):
    """既存 product_material_usage の 1 行 (公開シードに含めて担当者が確認できるように)"""
    product_id:        int
    product_name:      str
    material_id:       int
    quantity_per_unit: Decimal
    note:              str | None = None


class SurveySeed(BaseModel):
    """公開フォーム描画用シード"""
    division_code:    int
    division_name:    str
    products:         list[SurveyProduct]
    materials:        list[SurveyMaterial]
    # material_id ごとの既存レシピリスト (PMU = 承認済み)。
    # 公開アンケート画面には反映しない (真っ白アンケート方針)。 admin / 将来機能向けに参考送信。
    existing_recipes: dict[int, list[ExistingRecipeEntry]] = {}
    # pending 提案 (= 他担当者がまだ申請中) を含む material_id 集合。
    # 「未編集の資材へ」 ジャンプで 「他担当者がもう触った資材」 をスキップするのに使う。
    pending_material_ids: list[int] = []


class SubmissionLineIn(BaseModel):
    """1 行 = 1 商品 × 1 資材ペア"""
    product_id:        int | None = None
    product_text:      str | None = Field(None, max_length=200)
    material_id:       int | None = None
    material_text:     str | None = Field(None, max_length=200)
    quantity_per_unit: Decimal     = Field(..., ge=0)
    unit_note:         str | None  = Field(None, max_length=50)
    line_note:         str | None  = Field(None, max_length=200)
    is_uncertain:      bool        = False


class SubmissionIn(BaseModel):
    submitter_name: str | None = Field(None, max_length=50)
    submitter_note: str | None = Field(None, max_length=500)
    lines:          list[SubmissionLineIn] = Field(..., min_length=1, max_length=200)
    # 担当者が長さ未設定資材に対して提案する 1 巻あたり cm 値 (任意)
    suggested_length_per_roll_cm: Decimal | None = Field(None, ge=0)


class ProductState(BaseModel):
    """material-state エンドポイント用 1 商品の状態。
    公開アンケート画面では PMU (承認済みレシピ) を 「真っ白」 にするため、
    本フィールドは pending 提案 (担当者同士の進行中作業) のみを反映する。
    PMU は admin 画面・編集済み検出 (seed.existing_recipes) で別途利用する。"""
    id: int
    name: str
    unit: str | None = None
    pack_size: Decimal | None = None              # 1 ケース入り数
    # この資材に対する 「他担当者の pending 提案」 の最新 qty (PMU は含めない)
    linked_qty: Decimal | None = None
    # 同カテゴリの別資材で 「他担当者の pending 提案」 があり、 自動 無関係配置するヒント
    # (PMU は含めない)
    linked_in_same_category: bool = False


class MaterialStateOut(BaseModel):
    material_id:   int
    material_name: str
    category:      str | None
    unit:          str | None
    has_length:    bool
    length_per_roll_cm: Decimal | None = None
    products:      list[ProductState]


class SubmissionAck(BaseModel):
    submission_id: int
    line_count:    int
    message:       str = "ご協力ありがとうございました。 管理者の確認後、 反映されます。"


class SubmissionLineOut(BaseModel):
    id:                int
    product_id:        int | None
    product_text:      str | None
    product_name:      str | None    # 表示用 (マスタからの解決)
    material_id:       int | None
    material_text:     str | None
    material_code:     str | None
    material_name:     str | None
    quantity_per_unit: Decimal
    unit_note:         str | None
    line_note:         str | None
    is_uncertain:      bool
    line_status:       str


class SubmissionOut(BaseModel):
    id:             int
    division_code:  int
    division_name:  str
    submitter_name: str | None
    submitter_note: str | None
    submitted_at:   datetime
    status:         str
    reviewed_at:    datetime | None
    review_note:    str | None
    line_count:     int
    lines:          list[SubmissionLineOut] | None = None


# =============================================================================
# 公開エンドポイント (認証不要)
# =============================================================================

@public_router.get("/{division_code}/seed", response_model=SurveySeed)
async def get_survey_seed(division_code: int, db: DB):
    """公開フォーム描画用のシード (事業部名 + 商品 + 資材 リスト)。
    認証不要。 攻撃面を狭めるため返却情報は最小限。"""
    if not (1 <= division_code <= 99):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="該当事業部 (division_code) はありません")

    async with db.cursor() as cur:
        # 商品 (事業部一致 + 有効分のみ)
        await cur.execute("""
            SELECT id, name, unit, pack_size
            FROM products_shipped
            WHERE division = %s AND is_active = TRUE
            ORDER BY name
        """, (division_code,))
        products = [SurveyProduct(**r) for r in await cur.fetchall()]

        # 資材 (事業部一致 + 0=未割当 も含む)
        await cur.execute("""
            SELECT id, code, item_name, supplier_name, unit, category, division,
                   (length_per_roll_cm IS NOT NULL) AS has_length,
                   length_per_roll_cm,
                   is_general_supply
            FROM materials
            WHERE is_active = TRUE
              AND (division = %s OR division = 0)
            ORDER BY code
        """, (division_code,))
        materials = [SurveyMaterial(**r) for r in await cur.fetchall()]

        # 既存レシピ (事業部の商品に紐付くもの・デフォルト行 only)
        # 担当者が「既に登録されているものを修正・確認」 できるようにする
        await cur.execute("""
            SELECT pmu.product_id,
                   ps.name AS product_name,
                   pmu.material_id,
                   pmu.quantity_per_unit,
                   pmu.note
            FROM product_material_usage pmu
            JOIN products_shipped ps ON ps.id = pmu.product_id
            JOIN materials m         ON m.id  = pmu.material_id
            WHERE ps.is_active = TRUE
              AND ps.division = %s
              AND pmu.department_code IS NULL    -- デフォルト行のみ
            ORDER BY pmu.material_id, ps.name
        """, (division_code,))
        existing_rows = await cur.fetchall()

    existing_recipes: dict[int, list[ExistingRecipeEntry]] = {}
    for r in existing_rows:
        existing_recipes.setdefault(r["material_id"], []).append(
            ExistingRecipeEntry(**r))

    # pending 提案がある material_id を収集 (この事業部に紐付くもの)
    async with db.cursor() as cur:
        await cur.execute("""
            SELECT DISTINCT sl.material_id
            FROM recipe_submission_lines sl
            JOIN recipe_submissions rs ON rs.id = sl.submission_id
            WHERE rs.division_code = %s
              AND rs.status = 'pending'
              AND sl.material_id IS NOT NULL
        """, (division_code,))
        pending_material_ids = [r["material_id"] for r in await cur.fetchall()]

    return SurveySeed(
        division_code=division_code,
        division_name=DIVISION_NAMES.get(division_code, f"事業{division_code}部"),
        products=products,
        materials=materials,
        existing_recipes=existing_recipes,
        pending_material_ids=pending_material_ids,
    )


@public_router.get("/{division_code}/material/{material_id}/state",
                    response_model=MaterialStateOut)
async def get_material_state(division_code: int, material_id: int, db: DB):
    """指定資材に対する商品ごとの「リンク状態」 を返す。
    フェイズ別 UI のフィルタに使う。 認証不要。

    各商品の linked_qty:
      product_material_usage に登録されている qty (admin が承認した正規レシピ)
      + 過去 pending 提案の (この資材 × この商品) の最終提案 qty
      (最新の pending 提案を採用、 admin 承認待ちでも担当者には見える)
    各商品の linked_in_same_category:
      同カテゴリの「別資材」 と既にリンクされている (= 自動 無関係エリアに置く)。"""
    if not (1 <= division_code <= 99):
        raise HTTPException(status.HTTP_404_NOT_FOUND)

    async with db.cursor() as cur:
        # この資材の情報
        await cur.execute("""
            SELECT id, item_name AS material_name, category, unit,
                   (length_per_roll_cm IS NOT NULL) AS has_length,
                   length_per_roll_cm
            FROM materials WHERE id = %s AND is_active = TRUE
        """, (material_id,))
        mat = await cur.fetchone()
        if not mat:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="資材が見つかりません")

        # 事業部の商品リスト
        await cur.execute("""
            SELECT id, name, unit, pack_size
            FROM products_shipped
            WHERE division = %s AND is_active = TRUE
            ORDER BY name
        """, (division_code,))
        products = await cur.fetchall()

        # M3 2026-05 修正: 承認済 PMU を 反映する (旧 「真っ白アンケート方針」 を 撤回)。
        # ユーザー要望:「承認済みの提案はちゃんとアンケート調査頁に反映」

        # PMU (承認済 正規レシピ) — デフォルト 行 のみ
        await cur.execute("""
            SELECT product_id, quantity_per_unit
            FROM product_material_usage
            WHERE material_id = %s AND department_code IS NULL
        """, (material_id,))
        pmu_linked = {r["product_id"]: r["quantity_per_unit"]
                       for r in await cur.fetchall()}

        # 他担当者の pending 提案で この資材にリンクされてる最新 qty (上書き優先)
        await cur.execute("""
            SELECT DISTINCT ON (sl.product_id)
                sl.product_id, sl.quantity_per_unit
            FROM recipe_submission_lines sl
            JOIN recipe_submissions rs ON rs.id = sl.submission_id
            WHERE sl.material_id = %s
              AND rs.division_code = %s
              AND rs.status = 'pending'
              AND sl.product_id IS NOT NULL
            ORDER BY sl.product_id, rs.submitted_at DESC
        """, (material_id, division_code))
        pending_linked = {r["product_id"]: r["quantity_per_unit"]
                         for r in await cur.fetchall()}

        # 同カテゴリの「別資材」 で 既にリンクされている商品 (自動 無関係エリア表示用)
        # PMU + pending 提案 両方 を 反映。 category が NULL の場合は NULL 同士で グループ化
        cat = mat["category"]
        if cat is not None:
            await cur.execute("""
                SELECT DISTINCT product_id FROM (
                    SELECT pmu.product_id
                    FROM product_material_usage pmu
                    JOIN materials m ON m.id = pmu.material_id
                    JOIN products_shipped ps ON ps.id = pmu.product_id
                    WHERE m.category = %s
                      AND m.id <> %s
                      AND ps.division = %s
                      AND pmu.department_code IS NULL
                    UNION
                    SELECT sl.product_id
                    FROM recipe_submission_lines sl
                    JOIN recipe_submissions rs ON rs.id = sl.submission_id
                    JOIN materials m ON m.id = sl.material_id
                    JOIN products_shipped ps ON ps.id = sl.product_id
                    WHERE m.category = %s
                      AND m.id <> %s
                      AND ps.division = %s
                      AND rs.status = 'pending'
                      AND sl.product_id IS NOT NULL
                ) sub
            """, (cat, material_id, division_code, cat, material_id, division_code))
        else:
            await cur.execute("""
                SELECT DISTINCT product_id FROM (
                    SELECT pmu.product_id
                    FROM product_material_usage pmu
                    JOIN materials m ON m.id = pmu.material_id
                    JOIN products_shipped ps ON ps.id = pmu.product_id
                    WHERE m.category IS NULL
                      AND m.id <> %s
                      AND ps.division = %s
                      AND pmu.department_code IS NULL
                    UNION
                    SELECT sl.product_id
                    FROM recipe_submission_lines sl
                    JOIN recipe_submissions rs ON rs.id = sl.submission_id
                    JOIN materials m ON m.id = sl.material_id
                    JOIN products_shipped ps ON ps.id = sl.product_id
                    WHERE m.category IS NULL
                      AND m.id <> %s
                      AND ps.division = %s
                      AND rs.status = 'pending'
                      AND sl.product_id IS NOT NULL
                ) sub
            """, (material_id, division_code, material_id, division_code))
        same_cat_linked = {r["product_id"] for r in await cur.fetchall()}

    states: list[ProductState] = []
    for p in products:
        pid = p["id"]
        # 優先: pending (進行中) > PMU (承認済) > なし
        linked_qty = pending_linked.get(pid) or pmu_linked.get(pid)
        states.append(ProductState(
            id=pid, name=p["name"], unit=p["unit"],
            pack_size=p["pack_size"],
            linked_qty=linked_qty,
            linked_in_same_category=(pid in same_cat_linked),
        ))

    return MaterialStateOut(
        material_id=mat["id"],
        material_name=mat["material_name"],
        category=mat["category"],
        unit=mat["unit"],
        has_length=mat["has_length"],
        length_per_roll_cm=mat["length_per_roll_cm"],
        products=states,
    )


@public_router.post("/{division_code}", response_model=SubmissionAck,
                     status_code=status.HTTP_201_CREATED)
async def submit_recipe_survey(
    division_code: int, body: SubmissionIn, db: DB, request: Request,
):
    """提案を staging に保存。 認証不要。
    本番テーブルには直接反映されず、 管理者承認後に流し込まれる。"""
    if not (1 <= division_code <= 99):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="該当事業部はありません")

    # 簡易監視用に IP / UA を残す
    client_ip = request.client.host if request.client else None
    user_agent = request.headers.get("user-agent", "")[:500]

    # 長さ提案がある場合は submitter_note に追記 (admin が確認できる)
    notes_parts = []
    if body.submitter_note and body.submitter_note.strip():
        notes_parts.append(body.submitter_note.strip())
    if body.suggested_length_per_roll_cm is not None and body.suggested_length_per_roll_cm > 0:
        notes_parts.append(
            f'【長さ提案】 1巻 = {body.suggested_length_per_roll_cm}cm '
            '(担当者がアンケートで申告)'
        )
    note_combined = '\n'.join(notes_parts) or None

    async with db.cursor() as cur:
        await cur.execute("""
            INSERT INTO recipe_submissions
                (division_code, submitter_name, submitter_note, client_ip, user_agent)
            VALUES (%s, %s, %s, %s, %s)
            RETURNING id
        """, (division_code,
              (body.submitter_name or '').strip() or None,
              note_combined,
              client_ip, user_agent))
        submission_id = (await cur.fetchone())["id"]

        for ln in body.lines:
            # product / material のいずれか必須 (model_validator では難しいので backend で検証)
            if ln.product_id is None and not (ln.product_text and ln.product_text.strip()):
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="各行の商品 (product_id または product_text) は必須です")
            if ln.material_id is None and not (ln.material_text and ln.material_text.strip()):
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="各行の資材 (material_id または material_text) は必須です")
            await cur.execute("""
                INSERT INTO recipe_submission_lines
                    (submission_id, product_id, product_text, material_id, material_text,
                     quantity_per_unit, unit_note, line_note, is_uncertain)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """, (submission_id, ln.product_id,
                  (ln.product_text or '').strip() or None,
                  ln.material_id,
                  (ln.material_text or '').strip() or None,
                  ln.quantity_per_unit, ln.unit_note, ln.line_note, ln.is_uncertain))

    return SubmissionAck(submission_id=submission_id, line_count=len(body.lines))


class GeneralSupplyToggle(BaseModel):
    """一般消耗品フラグの ON/OFF。"""
    is_general_supply: bool


@public_router.post("/{division_code}/material/{material_id}/general-supply")
async def mark_material_general_supply(
    division_code: int, material_id: int,
    body: GeneralSupplyToggle, db: DB,
):
    """資材を「一般消耗品 (どの商品にも紐付けない)」 としてマーク。
    認証不要。 ON にすると、 公開アンケート画面で 「編集済み」 扱いとなり、
    「次の未編集の資材へ」 ナビゲーションでスキップされる。"""
    if not (1 <= division_code <= 99):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="該当事業部はありません")
    async with db.cursor() as cur:
        await cur.execute("""
            UPDATE materials
               SET is_general_supply = %s
             WHERE id = %s AND is_active = TRUE
            RETURNING id, is_general_supply
        """, (body.is_general_supply, material_id))
        row = await cur.fetchone()
        if not row:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="資材が見つかりません")
    return {"material_id": row["id"], "is_general_supply": row["is_general_supply"]}


# =============================================================================
# 公開 商品別資材使用状況集計 (Phase 2026-05-25) — ShipmentRecipesPage 用
# =============================================================================
# user 仕様 2026-05-25: 「資材アンケート 画面 から 商品別資材使用状況集計 へ ボタン
# で 飛ぶ。 こちら も 認証不要 + 編集可能 にしたい」
# 設計:
#   - 既存 /shipments/* + /materials/* と SAME 形 で 返す (frontend が 共通 component
#     ShipmentRecipesPage を 再利用 する ため)
#   - division_code 必須 (URL path) → 公開 でも スコープ が 限定 される (本人 が
#     担当 する 部署 だけ 触れる、 他 部署 の データ は 触れない)
#   - PUT も 公開: 編集対象 product が division_code に 属する か 検証 してから 実行
#   - shipments.py の _list_products_impl / _replace_recipes_impl を 再利用

from .shipments import (
    _list_products_impl as _shipments_list_products_impl,
    _replace_recipes_impl as _shipments_replace_recipes_impl,
    ReplaceRecipesRequest as _ShipmentsReplaceRecipesRequest,
)

@public_router.get("/{division_code}/by-product/products")
async def public_by_product_list(division_code: int, db: DB):
    """商品一覧 (レシピ込み) — 公開、 division 必須。"""
    if not (1 <= division_code <= 99):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="該当事業部はありません")
    return await _shipments_list_products_impl(db, division=division_code)

@public_router.get("/{division_code}/by-product/materials")
async def public_by_product_materials(division_code: int, db: DB):
    """資材在庫 一覧 — 公開、 division 必須。 division_code に 属する + 未割当(0)。"""
    if not (1 <= division_code <= 99):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="該当事業部はありません")
    from .materials import MaterialStock as _MaterialStock
    async with db.cursor() as cur:
        await cur.execute("""
            SELECT * FROM material_stock
             WHERE is_active = TRUE
               AND (division = %s OR division = 0)
             ORDER BY code
        """, (division_code,))
        return [_MaterialStock(**r) for r in await cur.fetchall()]

@public_router.get("/{division_code}/by-product/categories")
async def public_by_product_categories(division_code: int, db: DB):
    """資材カテゴリ 一覧 — 公開。 materials から distinct 集計。"""
    if not (1 <= division_code <= 99):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="該当事業部はありません")
    async with db.cursor() as cur:
        await cur.execute("""
            SELECT category, COUNT(*) AS material_count
              FROM materials
             WHERE category IS NOT NULL AND is_active
             GROUP BY category
             ORDER BY category
        """)
        return [dict(r) for r in await cur.fetchall()]

@public_router.get("/{division_code}/by-product/departments")
async def public_by_product_departments(division_code: int, db: DB):
    """部署 一覧 — 公開。 既存 /shipments/departments と 同じ shape を 返す。"""
    if not (1 <= division_code <= 99):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="該当事業部はありません")
    async with db.cursor() as cur:
        await cur.execute("""
            SELECT DISTINCT department_code
              FROM shipment_records
             WHERE department_code IS NOT NULL
             ORDER BY department_code
        """)
        return [{"department_code": r["department_code"]} for r in await cur.fetchall()]

@public_router.put("/{division_code}/by-product/products/{product_id}/recipes")
async def public_by_product_replace_recipes(
    division_code: int, product_id: int,
    body: _ShipmentsReplaceRecipesRequest, db: DB, request: Request,
):
    """商品レシピ一括置換 — 公開。 product が division_code に 属する か 検証。"""
    if not (1 <= division_code <= 99):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="該当事業部はありません")
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT division FROM products_shipped WHERE id = %s AND is_active = TRUE",
            (product_id,))
        row = await cur.fetchone()
        if not row:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="商品が見つかりません")
        if row["division"] != division_code:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                detail=f"商品 {product_id} は 事業{division_code}部 の 商品 で は ありません")
    result = await _shipments_replace_recipes_impl(product_id, body, db)
    # audit (user_id は None で 公開 識別)
    ip = request.client.host if request.client else None
    await write_audit(db, "PUBLIC_RECIPE_REPLACE", "product_material_usage",
                      str(product_id),
                      {"product_id": product_id, "division": division_code,
                       "ip": ip, **result},
                      None, request)
    return result


# =============================================================================
# 管理者エンドポイント (admin 認証)
# =============================================================================

@admin_router.get("", response_model=list[SubmissionOut])
async def list_submissions(
    db: DB, admin: AdminUser,
    division_code: int | None = Query(None),
    status_filter: str | None = Query(None, alias="status",
                                       pattern="^(pending|approved|rejected)$"),
):
    """提案一覧。 デフォルトは全件、 status / division でフィルタ可。"""
    where = []
    params: list = []
    if division_code is not None:
        where.append("rs.division_code = %s")
        params.append(division_code)
    if status_filter is not None:
        where.append("rs.status = %s")
        params.append(status_filter)
    sql = """
        SELECT rs.id, rs.division_code, rs.submitter_name, rs.submitter_note,
               rs.submitted_at, rs.status, rs.reviewed_at, rs.review_note,
               (SELECT COUNT(*) FROM recipe_submission_lines
                WHERE submission_id = rs.id) AS line_count
        FROM recipe_submissions rs
    """
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY rs.submitted_at DESC LIMIT 200"
    async with db.cursor() as cur:
        await cur.execute(sql, params)
        rows = await cur.fetchall()
    return [SubmissionOut(
        id=r["id"], division_code=r["division_code"],
        division_name=DIVISION_NAMES.get(r["division_code"], f"事業{r['division_code']}部"),
        submitter_name=r["submitter_name"], submitter_note=r["submitter_note"],
        submitted_at=r["submitted_at"], status=r["status"],
        reviewed_at=r["reviewed_at"], review_note=r["review_note"],
        line_count=r["line_count"], lines=None,
    ) for r in rows]


@admin_router.get("/{submission_id}", response_model=SubmissionOut)
async def get_submission(submission_id: int, db: DB, admin: AdminUser):
    async with db.cursor() as cur:
        await cur.execute("""
            SELECT id, division_code, submitter_name, submitter_note,
                   submitted_at, status, reviewed_at, review_note
            FROM recipe_submissions WHERE id = %s
        """, (submission_id,))
        rs = await cur.fetchone()
        if not rs:
            raise HTTPException(status.HTTP_404_NOT_FOUND)

        await cur.execute("""
            SELECT sl.id, sl.product_id, sl.product_text,
                   sl.material_id, sl.material_text,
                   sl.quantity_per_unit, sl.unit_note, sl.line_note,
                   sl.is_uncertain, sl.line_status,
                   ps.name AS product_name,
                   m.code  AS material_code,
                   m.item_name AS material_name
            FROM recipe_submission_lines sl
            LEFT JOIN products_shipped ps ON ps.id = sl.product_id
            LEFT JOIN materials m         ON m.id  = sl.material_id
            WHERE sl.submission_id = %s
            ORDER BY sl.id
        """, (submission_id,))
        lines = [SubmissionLineOut(**r) for r in await cur.fetchall()]

    return SubmissionOut(
        id=rs["id"], division_code=rs["division_code"],
        division_name=DIVISION_NAMES.get(rs["division_code"], f"事業{rs['division_code']}部"),
        submitter_name=rs["submitter_name"], submitter_note=rs["submitter_note"],
        submitted_at=rs["submitted_at"], status=rs["status"],
        reviewed_at=rs["reviewed_at"], review_note=rs["review_note"],
        line_count=len(lines), lines=lines,
    )


class ApproveRequest(BaseModel):
    """承認時のオプション。 line_ids 指定で行単位の選択承認も可。"""
    line_ids:    list[int] | None = None
    review_note: str | None       = None


@admin_router.post("/{submission_id}/approve", response_model=dict)
async def approve_submission(
    submission_id: int, body: ApproveRequest, db: DB,
    admin: AdminUser, request: Request,
):
    """提案を承認 → product_material_usage に流し込み。
    product_id / material_id が両方マスタにある行のみ反映。
    *_text のみの行は skip して理由を返す (admin が手動マスタ追加してから再承認)。"""
    inserted = 0
    deleted = 0
    skipped: list[dict] = []
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT id, status, division_code FROM recipe_submissions WHERE id = %s",
            (submission_id,))
        rs = await cur.fetchone()
        if not rs:
            raise HTTPException(status.HTTP_404_NOT_FOUND)
        division_code = rs["division_code"]

        # 対象行
        line_filter = ""
        params: list = [submission_id]
        if body.line_ids:
            line_filter = " AND id = ANY(%s)"
            params.append(body.line_ids)
        await cur.execute(f"""
            SELECT id, product_id, product_text, material_id, material_text,
                   quantity_per_unit, line_note
            FROM recipe_submission_lines
            WHERE submission_id = %s{line_filter}
        """, params)
        lines = await cur.fetchall()

        for ln in lines:
            # 両方マスタ ID が揃ってる行のみ流し込み
            if ln["product_id"] is None or ln["material_id"] is None:
                skipped.append({
                    "line_id": ln["id"],
                    "reason": ("商品マスタ未登録" if ln["product_id"] is None
                               else "資材マスタ未登録"),
                    "product_text":  ln["product_text"],
                    "material_text": ln["material_text"],
                })
                # 行状態は pending のままにして、 admin が手動でマスタ追加後に再承認
                continue
            # UPSERT (既存ペアは更新、 新規は INSERT)
            # UNIQUE INDEX (product, material, COALESCE(dept, __DEFAULT__))
            await cur.execute("""
                SELECT id FROM product_material_usage
                WHERE product_id = %s AND material_id = %s
                  AND department_code IS NULL
            """, (ln["product_id"], ln["material_id"]))
            existing = await cur.fetchone()
            if existing:
                await cur.execute("""
                    UPDATE product_material_usage
                    SET quantity_per_unit = %s,
                        note = COALESCE(note, '') || %s
                    WHERE id = %s
                """, (ln["quantity_per_unit"],
                      f" [提案#{submission_id}#{ln['id']}承認: {ln['line_note'] or ''}]",
                      existing["id"]))
            else:
                await cur.execute("""
                    INSERT INTO product_material_usage
                        (product_id, material_id, quantity_per_unit, note)
                    VALUES (%s, %s, %s, %s)
                """, (ln["product_id"], ln["material_id"],
                      ln["quantity_per_unit"],
                      f"[提案#{submission_id}#{ln['id']}承認: {ln['line_note'] or ''}]"))
            inserted += 1
            # 行ステータス更新
            await cur.execute(
                "UPDATE recipe_submission_lines SET line_status = 'approved' WHERE id = %s",
                (ln["id"],))

        # ── sync delete: submission に含まれない (material, product) の 紐付け を 削除 ──
        # user 仕様 2026-05-25: 「資材アンケート で 商品を 外して 保存 → master からも 消える」
        # 条件:
        #   1. 部分 承認 (body.line_ids 指定) で は スキップ (= 「これだけ 承認」 意図 と 矛盾)
        #   2. submission に 出現 した material のみ 対象 (= 言及 なし material は 触らない)
        #   3. 削除 対象: PMU 行 で material_id が 該当、 product が この division の products、
        #      かつ submission の 該当 material lines に 含まれない product
        #   4. department_code IS NULL (デフォルト 行) のみ — 部署 override は 触らない
        if not body.line_ids:
            # material_id → set(product_ids in submission) を 集計
            submitted_by_mat: dict[int, set[int]] = {}
            for ln in lines:
                if ln["material_id"] is None or ln["product_id"] is None:
                    continue
                submitted_by_mat.setdefault(ln["material_id"], set()).add(ln["product_id"])
            for mat_id, kept_pids in submitted_by_mat.items():
                kept_list = list(kept_pids)
                await cur.execute("""
                    DELETE FROM product_material_usage
                    WHERE material_id = %s
                      AND department_code IS NULL
                      AND product_id IN (
                        SELECT id FROM products_shipped
                        WHERE division = %s AND is_active = TRUE
                      )
                      AND product_id <> ALL(%s::int[])
                    RETURNING id
                """, (mat_id, division_code, kept_list))
                deleted += len(await cur.fetchall())

        # submission 全体のステータス
        # 全行 approve できたら 'approved'、 一部だけなら 'pending' のまま
        all_approved = (inserted == len(lines)) and not skipped
        if all_approved:
            await cur.execute("""
                UPDATE recipe_submissions
                SET status = 'approved', reviewed_at = now(), reviewed_by = %s,
                    review_note = %s
                WHERE id = %s
            """, (admin["id"], body.review_note, submission_id))

    await write_audit(db, "RECIPE_SUBMISSION_APPROVE", "recipe_submissions",
                      str(submission_id),
                      {"inserted": inserted, "deleted": deleted, "skipped": len(skipped)},
                      admin["id"], request)
    return {
        "submission_id": submission_id,
        "inserted":      inserted,
        "deleted":       deleted,
        "skipped":       skipped,
        "all_approved":  all_approved,
    }


class RejectRequest(BaseModel):
    review_note: str | None = None


@admin_router.post("/{submission_id}/reject", response_model=SubmissionOut)
async def reject_submission(
    submission_id: int, body: RejectRequest, db: DB,
    admin: AdminUser, request: Request,
):
    async with db.cursor() as cur:
        await cur.execute("""
            UPDATE recipe_submissions
            SET status = 'rejected', reviewed_at = now(), reviewed_by = %s,
                review_note = %s
            WHERE id = %s AND status = 'pending'
        """, (admin["id"], body.review_note, submission_id))
        if cur.rowcount == 0:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="保留中の提案ではありません")
        await cur.execute("""
            SELECT id, division_code, submitter_name, submitter_note,
                   submitted_at, status, reviewed_at, review_note
            FROM recipe_submissions WHERE id = %s
        """, (submission_id,))
        rs = await cur.fetchone()
    await write_audit(db, "RECIPE_SUBMISSION_REJECT", "recipe_submissions",
                      str(submission_id), {"note": body.review_note}, admin["id"], request)
    return SubmissionOut(
        id=rs["id"], division_code=rs["division_code"],
        division_name=DIVISION_NAMES.get(rs["division_code"], f"事業{rs['division_code']}部"),
        submitter_name=rs["submitter_name"], submitter_note=rs["submitter_note"],
        submitted_at=rs["submitted_at"], status=rs["status"],
        reviewed_at=rs["reviewed_at"], review_note=rs["review_note"],
        line_count=0, lines=None,
    )


@admin_router.delete("/{submission_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_submission(
    submission_id: int, db: DB, admin: AdminUser, request: Request,
):
    async with db.cursor() as cur:
        await cur.execute(
            "DELETE FROM recipe_submissions WHERE id = %s", (submission_id,))
        if cur.rowcount == 0:
            raise HTTPException(status.HTTP_404_NOT_FOUND)
    await write_audit(db, "RECIPE_SUBMISSION_DELETE", "recipe_submissions",
                      str(submission_id), {}, admin["id"], request)


# =============================================================================
# 内部 router (認証必須 + 担当事業部 権限チェック) — 2026-05 追加
# =============================================================================
# 公開エンドポイントと 同じ機能 を 提供。 違い:
#   - 認証必須 (X-Device-Token 経由)
#   - write 操作 (POST) は assert_can_edit_recipe(user, division) で 権限チェック
#     - admin: 全事業部 編集可
#     - recipe_editor + division ∈ divisions: そこだけ
#     - その他: 403
#   - 提案 INSERT 時、 submitter_name を 認証済 user.display_name で 自動充填
#
# 公開 router は 並行 運用 (旧 URL の ブックマーク 等 のため、 仕様変更まで 残置)。
# =============================================================================

@private_router.get("/{division_code}/seed", response_model=SurveySeed)
async def get_survey_seed_authed(division_code: int, db: DB, user: CurrentUser):
    """認証付き seed 取得。 閲覧は 全 認証ユーザー OK。"""
    return await get_survey_seed(division_code, db)


@private_router.get("/{division_code}/material/{material_id}/state",
                    response_model=MaterialStateOut)
async def get_material_state_authed(
    division_code: int, material_id: int, db: DB, user: CurrentUser,
):
    return await get_material_state(division_code, material_id, db)


@private_router.post("/{division_code}", response_model=SubmissionAck,
                     status_code=status.HTTP_201_CREATED)
async def submit_recipe_survey_authed(
    division_code: int, body: SubmissionIn, db: DB, request: Request,
    user: CurrentUser,
):
    """認証付き 提案送信。 担当事業部 のみ 投稿可。"""
    await assert_can_edit_recipe(user, division_code)
    # submitter_name を 認証 user で 自動充填 (空 or 未指定 の場合)
    if not (body.submitter_name and body.submitter_name.strip()):
        body = body.model_copy(update={"submitter_name": user["display_name"]})
    return await submit_recipe_survey(division_code, body, db, request)


@private_router.post("/{division_code}/material/{material_id}/general-supply")
async def mark_material_general_supply_authed(
    division_code: int, material_id: int,
    body: GeneralSupplyToggle, db: DB, user: CurrentUser,
):
    """一般消耗品 フラグ ON/OFF (担当事業部 のみ)。"""
    await assert_can_edit_recipe(user, division_code)
    return await mark_material_general_supply(division_code, material_id, body, db)
