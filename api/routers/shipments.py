"""
api/routers/shipments.py
========================
商品出荷台帳API。

  GET  /shipments/products            - 商品一覧（レシピ含む）
  GET  /shipments/records             - 出荷履歴
  GET  /shipments/calendar            - 日次カレンダー（商品×日付の出荷数）
  POST /shipments/records             - 出荷を1件登録
  POST /shipments/products            - 商品マスタ登録（管理者）
  POST /shipments/recipes             - 商品⇄資材レシピを登録/更新（管理者）
"""

from __future__ import annotations

import io
import re
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path

import openpyxl
from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile, status
from pydantic import BaseModel, Field

from api.audit import write_audit
from api.auth import AdminUser, CurrentUser, OperatorUser
from api.dependencies import DB


# 商品分類名 → 事業部 (キーワードベース、import_shipments_xlsx.py と同一ロジック)
# ※ 先頭から順にチェックし、最初にマッチしたキーワードの事業部を返す。
#    特定キーワードを優先したい場合は前に置く (例: ニン芽は大蒜より先に物流判定)。
_DIV_KEYWORDS: list[tuple[int, tuple[str, ...]]] = [
    # 分類名に「(中)」「（中）」が含まれる商品は物流扱い (中身ではなく梱包形態に着目)。
    # 大蒜 (div 2) より前に置いて先に判定させる。
    (6, ("(中)", "（中）")),
    # ニンニクの芽 (ﾆﾝ芽 / ニン芽 / ニンニクの芽) も物流扱い。
    # 大蒜 (div 2) の前に置くことで「ﾆﾝ芽」が「ニンニク」より先に拾われる。
    (6, ("ﾆﾝ芽", "ニン芽", "ニンニクの芽")),
    (1, ("生姜", "ジンジャー", "ｼﾞﾝｼﾞｬｰ")),
    (2, ("大蒜", "にんにく", "ニンニク", "ﾆﾝﾆｸ", "ガーリック")),
    (3, ("長芋", "ナガイモ", "ながいも", "山芋", "ヤマイモ")),
    (4, ("牛蒡", "ごぼう", "ゴボウ", "ｺﾞﾎﾞｳ")),
    # 薩摩芋: 干し芋・ほし芋・ホシイモ・干いも・干芋など加工品も含む
    (5, ("薩摩芋", "さつまいも", "サツマイモ", "ｻﾂﾏｲﾓ", "甘藷",
         "干し芋", "干芋", "ほし芋", "ホシイモ", "干いも", "ほしいも", "ｻﾂﾏ")),
]
_LOGISTICS_DIV = 6


def _classify_division(class_name: str | None) -> int:
    if not class_name:
        return _LOGISTICS_DIV
    for div, kws in _DIV_KEYWORDS:
        if any(kw in class_name for kw in kws):
            return div
    return _LOGISTICS_DIV


def _parse_filename_date(fname: str) -> date | None:
    """'260515商品期間集計.xlsx' → date(2026,5,15)"""
    stem = Path(fname).stem
    if len(stem) >= 6 and stem[:6].isdigit():
        yy, mm, dd = int(stem[0:2]), int(stem[2:4]), int(stem[4:6])
        try:
            return date(2000 + yy, mm, dd)
        except ValueError:
            return None
    # YYYY-MM-DD 形式や他のパターンも許容
    m = re.match(r"(\d{4})[-_]?(\d{2})[-_]?(\d{2})", stem)
    if m:
        try:
            return date(int(m[1]), int(m[2]), int(m[3]))
        except ValueError:
            return None
    return None


def _norm_str(v) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def _to_dec(v) -> Decimal | None:
    if v is None or v == "":
        return None
    try:
        return Decimal(str(v))
    except Exception:
        return None

router = APIRouter(prefix="/shipments", tags=["商品出荷"])


# =============================================================================
# モデル
# =============================================================================

class AlternativeMaterial(BaseModel):
    material_id:   int
    code:          str
    item_name:     str
    unit:          str | None = None
    supplier_name: str | None = None


class RecipeEntry(BaseModel):
    material_id:      int
    material_code:    str
    material_name:    str
    material_unit:    str | None
    quantity_per_unit: Decimal
    note:             str | None = None
    is_estimated:     bool = False         # 推定モード
    estimation_weight: Decimal = Decimal(1)  # 推定の重み
    # 部署別オーバーライド (NULL=全部署デフォルト)。出荷の部署と一致時に優先採用。
    department_code:  str | None = None
    # 代替資材 (優先順)。仕入先変更で旧資材を使い切ってから新資材に swap する用。
    alternatives:     list[AlternativeMaterial] = Field(default_factory=list)


class ProductWithRecipe(BaseModel):
    product_id: int
    division:   int
    name:       str
    unit:       str | None
    is_active:  bool
    product_code:          str | None = None
    classification_code:   str | None = None
    classification_name:   str | None = None
    pack_size:             Decimal | None = None  # 入り数
    recipes:    list[RecipeEntry]
    # ↓ レシピ最終チェック ページ 改修 用 (Phase: redesign)
    override_dept_codes: list[str] = Field(default_factory=list)
    last_shipped_at: str | None = None         # ISO YYYY-MM-DD
    monthly_shipment_count: int = 0            # 直近 30 日 の shipment_records 件数


class ShipmentRecord(BaseModel):
    record_id:    int
    product_id:   int
    product_name: str
    ship_date:    date
    quantity:     Decimal
    sales_amount: Decimal | None = None
    weight_kg:    Decimal | None = None
    pack_count:   Decimal | None = None
    pack_size:    Decimal | None = None  # 入り数 (JOIN by product)
    department_code: str | None = None
    dispatch_from: str | None = None
    note:         str | None
    created_at:   datetime
    created_by_name: str | None


class ShipmentCalendarRow(BaseModel):
    product_id:   int
    name:         str
    unit:         str | None
    month_total:  Decimal
    daily:        dict[str, Decimal]   # 日 → 出荷数


class ShipmentCalendar(BaseModel):
    month:         str
    days_in_month: int
    rows:          list[ShipmentCalendarRow]


class ShipmentCreate(BaseModel):
    product_id: int
    ship_date:  date
    quantity:   Decimal = Field(..., gt=0)
    note:       str | None = None


class ProductCreate(BaseModel):
    division: int = Field(..., ge=1, le=99)
    name:     str = Field(..., min_length=1)
    unit:     str | None = None


class RecipeCreate(BaseModel):
    product_id:        int
    material_id:       int
    quantity_per_unit: Decimal = Field(..., gt=0)
    note:              str | None = None
    department_code:   str | None = None    # None=全部署デフォルト
    alternative_material_ids: list[int] = Field(default_factory=list)


def _month_last_day(month: str) -> date:
    first = datetime.strptime(month + "-01", "%Y-%m-%d").date()
    return (first.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)


# =============================================================================
# エンドポイント
# =============================================================================

@router.get("/departments")
async def list_departments(db: DB, user: CurrentUser):
    """出荷で使われている部署コード一覧（件数付き）。"""
    async with db.cursor() as cur:
        await cur.execute("""
            SELECT department_code, COUNT(*) AS shipment_count,
                   COUNT(DISTINCT product_id) AS product_count
            FROM shipment_records
            WHERE department_code IS NOT NULL
            GROUP BY department_code
            ORDER BY department_code
        """)
        return [dict(r) for r in await cur.fetchall()]


async def _list_products_impl(
    db, division: int | None = None, department: str | None = None,
) -> list[ProductWithRecipe]:
    """商品一覧 (資材レシピ込み) の 実体。 auth 抜き、 公開 mirror 用 ヘルパー。"""
    conds = ["is_active"]
    params: list = []
    if division is not None:
        params.append(division); conds.append("division = %s")
    if department is not None:
        params.append(department)
        conds.append(
            "id IN (SELECT product_id FROM shipment_records "
            "WHERE department_code = %s)")
    async with db.cursor() as cur:
        await cur.execute(
            f"SELECT * FROM products_shipped WHERE {' AND '.join(conds)} ORDER BY id",
            params or None)
        products = await cur.fetchall()

        await cur.execute("""
            SELECT pmu.product_id, pmu.material_id, pmu.quantity_per_unit, pmu.note,
                   pmu.is_estimated, pmu.estimation_weight,
                   pmu.alternative_material_ids, pmu.department_code,
                   m.code AS material_code, m.item_name AS material_name, m.unit AS material_unit
            FROM product_material_usage pmu
            JOIN materials m ON m.id = pmu.material_id
            ORDER BY pmu.product_id, m.code,
                     pmu.department_code NULLS FIRST  -- デフォルト → 部署別の順
        """)
        recipes = await cur.fetchall()

        # 代替資材の materials 詳細を一括取得
        all_alt_ids: set[int] = set()
        for r in recipes:
            for aid in r.get("alternative_material_ids") or []:
                all_alt_ids.add(aid)
        alt_detail: dict[int, AlternativeMaterial] = {}
        if all_alt_ids:
            await cur.execute(
                """SELECT id, code, item_name, unit, supplier_name
                   FROM materials WHERE id = ANY(%s)""",
                [list(all_alt_ids)],
            )
            for row in await cur.fetchall():
                alt_detail[row["id"]] = AlternativeMaterial(
                    material_id=row["id"], code=row["code"],
                    item_name=row["item_name"], unit=row["unit"],
                    supplier_name=row["supplier_name"],
                )

        # ↓ 新規: 各商品 の 最終出荷日 + 直近 30 日 件数 + override 部署 一覧
        product_ids = [p["id"] for p in products]
        last_ship: dict[int, str | None] = {pid: None for pid in product_ids}
        monthly: dict[int, int] = {pid: 0 for pid in product_ids}
        override_depts: dict[int, list[str]] = {pid: [] for pid in product_ids}

        if product_ids:
            cutoff = date.today() - timedelta(days=30)

            # 最終出荷日
            await cur.execute("""
                SELECT product_id, MAX(ship_date) AS last_ship
                FROM shipment_records
                WHERE product_id = ANY(%s)
                GROUP BY product_id
            """, (product_ids,))
            for r in await cur.fetchall():
                last_ship[r["product_id"]] = (
                    r["last_ship"].isoformat() if r["last_ship"] else None
                )

            # 直近 30 日 件数
            await cur.execute("""
                SELECT product_id, COUNT(*) AS cnt
                FROM shipment_records
                WHERE product_id = ANY(%s) AND ship_date >= %s
                GROUP BY product_id
            """, (product_ids, cutoff))
            for r in await cur.fetchall():
                monthly[r["product_id"]] = int(r["cnt"])

            # オーバーライド 部署 (DISTINCT)
            await cur.execute("""
                SELECT product_id, department_code
                FROM product_material_usage
                WHERE product_id = ANY(%s) AND department_code IS NOT NULL
                GROUP BY product_id, department_code
                ORDER BY product_id, department_code
            """, (product_ids,))
            for r in await cur.fetchall():
                override_depts[r["product_id"]].append(r["department_code"])

    by_product: dict[int, list[RecipeEntry]] = {}
    for r in recipes:
        alts: list[AlternativeMaterial] = []
        for aid in r.get("alternative_material_ids") or []:
            if aid in alt_detail:
                alts.append(alt_detail[aid])
        by_product.setdefault(r["product_id"], []).append(RecipeEntry(
            material_id=r["material_id"],
            material_code=r["material_code"],
            material_name=r["material_name"],
            material_unit=r["material_unit"],
            quantity_per_unit=r["quantity_per_unit"],
            note=r["note"],
            is_estimated=r["is_estimated"],
            estimation_weight=r["estimation_weight"],
            department_code=r.get("department_code"),
            alternatives=alts,
        ))

    return [
        ProductWithRecipe(
            product_id=p["id"], division=p["division"], name=p["name"],
            unit=p["unit"], is_active=p["is_active"],
            product_code=p.get("product_code"),
            classification_code=p.get("classification_code"),
            classification_name=p.get("classification_name"),
            pack_size=p.get("pack_size"),
            recipes=by_product.get(p["id"], []),
            override_dept_codes=override_depts.get(p["id"], []),   # 新
            last_shipped_at=last_ship.get(p["id"]),                # 新
            monthly_shipment_count=monthly.get(p["id"], 0),        # 新
        )
        for p in products
    ]


@router.get("/products", response_model=list[ProductWithRecipe])
async def list_products(
    db: DB, user: CurrentUser,
    division:   int | None = Query(None),
    department: str | None = Query(None,
        description="部署コード。指定時は当該部署に出荷した商品のみ"),
):
    """商品一覧（資材レシピ込み）。"""
    return await _list_products_impl(db, division=division, department=department)


@router.get("/records", response_model=list[ShipmentRecord])
async def list_records(
    db: DB,
    user: CurrentUser,
    date_from:  date | None = Query(None),
    date_to:    date | None = Query(None),
    division:   int | None = Query(None),
    department: str | None = Query(None),
    limit:      int = Query(100, ge=1, le=500),
):
    """出荷履歴。"""
    conds = ["1=1"]
    params: list = []
    if date_from is not None:
        params.append(date_from); conds.append("sr.ship_date >= %s")
    if date_to is not None:
        params.append(date_to); conds.append("sr.ship_date <= %s")
    if division is not None:
        params.append(division); conds.append("p.division = %s")
    if department is not None:
        params.append(department); conds.append("sr.department_code = %s")
    params.append(limit)
    async with db.cursor() as cur:
        await cur.execute(f"""
            SELECT sr.id AS record_id, sr.product_id, sr.ship_date, sr.quantity,
                   sr.sales_amount, sr.weight_kg, sr.pack_count,
                   p.pack_size,
                   sr.department_code, sr.dispatch_from,
                   sr.note, sr.created_at, p.name AS product_name,
                   u.display_name AS created_by_name
            FROM shipment_records sr
            JOIN products_shipped p ON p.id = sr.product_id
            LEFT JOIN users u ON u.id = sr.created_by
            WHERE {' AND '.join(conds)}
            ORDER BY sr.ship_date DESC, sr.id DESC
            LIMIT %s
        """, params)
        return [ShipmentRecord(**r) for r in await cur.fetchall()]


@router.get("/calendar", response_model=ShipmentCalendar)
async def get_shipment_calendar(
    db: DB,
    user: CurrentUser,
    month: str | None = Query(None),
    division:   int | None = Query(None),
    department: str | None = Query(None,
        description="部署コード。指定時は当該部署への出荷だけを集計し、当該部署に出荷した商品だけを表示"),
):
    """商品×日付の出荷グリッド。"""
    async with db.cursor() as cur:
        if not month:
            await cur.execute("""
                SELECT to_char(
                    COALESCE((SELECT MAX(ship_date) FROM shipment_records), CURRENT_DATE),
                    'YYYY-MM') AS m
            """)
            month = (await cur.fetchone())["m"]
        first = datetime.strptime(month + "-01", "%Y-%m-%d").date()
        last = _month_last_day(month)

        params = {"first": first, "last": last,
                  "division": division, "department": department}
        div_filter  = "AND p.division = %(division)s" if division is not None else ""
        # 部署指定時は、その部署に当該月で出荷があった商品だけに絞る
        dept_filter = ""
        if department is not None:
            dept_filter = (
                "AND p.id IN (SELECT product_id FROM shipment_records "
                "WHERE department_code = %(department)s "
                "AND ship_date BETWEEN %(first)s AND %(last)s)"
            )
        await cur.execute(f"""
            SELECT p.id AS product_id, p.name, p.unit
            FROM products_shipped p
            WHERE p.is_active {div_filter} {dept_filter}
            ORDER BY p.id
        """, params)
        products = await cur.fetchall()

        # 部署フィルタが指定されていれば、出荷集計もその部署のみ
        ship_dept = ""
        if department is not None:
            ship_dept = "AND department_code = %(department)s"
        await cur.execute(f"""
            SELECT product_id, ship_date, SUM(quantity) AS qty
            FROM shipment_records
            WHERE ship_date BETWEEN %(first)s AND %(last)s
              {ship_dept}
            GROUP BY product_id, ship_date
        """, params)
        shipments = await cur.fetchall()

    by_product: dict[int, dict[int, Decimal]] = {}
    for s in shipments:
        by_product.setdefault(s["product_id"], {})[s["ship_date"].day] = s["qty"]

    rows = []
    for p in products:
        daily = by_product.get(p["product_id"], {})
        rows.append(ShipmentCalendarRow(
            product_id=p["product_id"], name=p["name"], unit=p["unit"],
            month_total=sum(daily.values(), Decimal(0)),
            daily={str(k): v for k, v in daily.items()},
        ))
    return ShipmentCalendar(month=month, days_in_month=last.day, rows=rows)


@router.post("/bulk-import", status_code=status.HTTP_201_CREATED)
async def bulk_import_shipments(
    db: DB, user: OperatorUser, request: Request,
    file: UploadFile = File(..., description="商品集計 XLSX (例: 260515商品期間集計.xlsx)"),
):
    """商品集計 XLSX を一括取り込みする。
    フォーマット (1 シート、ヘッダー行は R1):
      [0]部署 [1]商品分類コード [2]商品分類名 [3]商品コード [4]品名1 [5]品名2
      [6]販売金額 [7]販売数量 [8]重量Kg [9]合計 [10]出庫区分 [11]保管料 [12]保管料計
      [13]入数 [14]パック数量
    ファイル名 'YYMMDD...' から出荷日を抽出する。
    同日・同商品・同部署・同出庫元の既存レコードは UPDATE される（冪等）。"""
    if not (file.filename or "").lower().endswith(".xlsx"):
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
                            detail=".xlsx 形式のみ対応しています")
    content = await file.read()
    if len(content) > 5 * 1024 * 1024:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                            detail="ファイルサイズは 5MB 以下にしてください")
    ship_date = _parse_filename_date(file.filename or "")
    if ship_date is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="ファイル名から日付を抽出できません。'YYMMDD商品...' 形式にしてください")

    try:
        wb = openpyxl.load_workbook(io.BytesIO(content), data_only=True, read_only=True)
    except Exception as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail=f"XLSX 解析失敗: {e}")
    ws = wb.active

    new_products: list[dict] = []
    inserted_records = 0
    updated_records = 0
    skipped_rows = 0
    errors: list[str] = []

    async with db.cursor() as cur:
        for ri, row in enumerate(ws.iter_rows(min_row=2, values_only=True), start=2):
            if row is None or all(c is None or c == "" for c in row):
                continue
            dept_code   = _norm_str(row[0]  if len(row) > 0  else None)
            class_code  = _norm_str(row[1]  if len(row) > 1  else None)
            class_name  = _norm_str(row[2]  if len(row) > 2  else None)
            prod_code   = _norm_str(row[3]  if len(row) > 3  else None)
            name1       = _norm_str(row[4]  if len(row) > 4  else None)
            name2       = _norm_str(row[5]  if len(row) > 5  else None)
            sales_amt   = _to_dec(row[6]   if len(row) > 6  else None)
            qty         = _to_dec(row[7]   if len(row) > 7  else None)
            weight_kg   = _to_dec(row[8]   if len(row) > 8  else None)
            dispatch    = _norm_str(row[10] if len(row) > 10 else None)
            pack_count  = _to_dec(row[14]  if len(row) > 14 else None)

            if not prod_code or not name1:
                skipped_rows += 1
                continue
            if qty is None or qty <= 0:
                skipped_rows += 1
                continue

            name = name1 + (" " + name2 if name2 else "")
            division = _classify_division(class_name)

            await cur.execute(
                "SELECT id FROM products_shipped WHERE product_code = %s", (prod_code,))
            existing = await cur.fetchone()
            if existing:
                product_id = existing["id"]
            else:
                await cur.execute(
                    """INSERT INTO products_shipped
                         (division, name, unit, product_code,
                          classification_code, classification_name)
                       VALUES (%s, %s, %s, %s, %s, %s)
                       RETURNING id""",
                    (division, name, None, prod_code, class_code, class_name))
                product_id = (await cur.fetchone())["id"]
                new_products.append({
                    "product_code": prod_code, "name": name, "division": division,
                })

            await cur.execute(
                """SELECT id FROM shipment_records
                   WHERE ship_date = %s AND product_id = %s
                     AND department_code IS NOT DISTINCT FROM %s
                     AND dispatch_from   IS NOT DISTINCT FROM %s""",
                (ship_date, product_id, dept_code, dispatch))
            rec = await cur.fetchone()
            if rec:
                await cur.execute(
                    """UPDATE shipment_records
                          SET quantity = %s, sales_amount = %s,
                              weight_kg = %s, pack_count = %s
                        WHERE id = %s""",
                    (qty, sales_amt, weight_kg, pack_count, rec["id"]))
                updated_records += 1
            else:
                await cur.execute(
                    """INSERT INTO shipment_records
                         (product_id, ship_date, quantity,
                          sales_amount, weight_kg, pack_count,
                          department_code, dispatch_from, created_by)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                    (product_id, ship_date, qty, sales_amt, weight_kg, pack_count,
                     dept_code, dispatch, user["id"]))
                inserted_records += 1

    wb.close()

    await write_audit(db, "SHIPMENT_BULK_IMPORT", "shipment_records",
                      str(ship_date),
                      {"file": file.filename, "date": str(ship_date),
                       "new_products": len(new_products),
                       "inserted": inserted_records,
                       "updated": updated_records,
                       "skipped": skipped_rows},
                      user["id"], request)

    return {
        "filename": file.filename,
        "ship_date": str(ship_date),
        "new_products": len(new_products),
        "new_product_samples": new_products[:5],
        "inserted_records": inserted_records,
        "updated_records": updated_records,
        "skipped_rows": skipped_rows,
        "errors": errors,
    }


@router.post("/records", status_code=status.HTTP_201_CREATED)
async def create_shipment(body: ShipmentCreate, db: DB,
                          user: OperatorUser, request: Request):
    """出荷を1件登録する。資材消耗は material_stock VIEW が自動算出する。"""
    async with db.cursor() as cur:
        await cur.execute("SELECT 1 FROM products_shipped WHERE id=%s", (body.product_id,))
        if not await cur.fetchone():
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                detail=f"商品ID {body.product_id} が見つかりません")
        await cur.execute("""
            INSERT INTO shipment_records (product_id, ship_date, quantity, note, created_by)
            VALUES (%s, %s, %s, %s, %s)
            RETURNING *
        """, (body.product_id, body.ship_date, body.quantity, body.note, user["id"]))
        row = await cur.fetchone()
    await write_audit(db, "SHIPMENT_CREATE", "shipment_records", str(row["id"]),
                      {"product_id": body.product_id,
                       "quantity": float(body.quantity),
                       "date": str(body.ship_date)},
                      user["id"], request)
    return dict(row)


@router.post("/products", status_code=status.HTTP_201_CREATED)
async def create_product(body: ProductCreate, db: DB,
                         admin: AdminUser, request: Request):
    async with db.cursor() as cur:
        await cur.execute("""
            INSERT INTO products_shipped (division, name, unit)
            VALUES (%s, %s, %s)
            ON CONFLICT (division, name) DO UPDATE SET unit=EXCLUDED.unit, updated_at=now()
            RETURNING *
        """, (body.division, body.name.strip(), body.unit))
        row = await cur.fetchone()
    await write_audit(db, "PRODUCT_SHIPPED_CREATE", "products_shipped",
                      str(row["id"]), {"name": body.name}, admin["id"], request)
    return dict(row)


@router.post("/recipes", status_code=status.HTTP_201_CREATED)
async def upsert_recipe(body: RecipeCreate, db: DB,
                        admin: AdminUser, request: Request):
    """商品⇄資材のレシピを登録/更新（管理者）。
    department_code が指定されていればその部署専用、None なら全部署デフォルト。"""
    alt_ids = [aid for aid in body.alternative_material_ids if aid != body.material_id]
    dept = body.department_code.strip() if body.department_code else None
    async with db.cursor() as cur:
        # UNIQUE INDEX が (product_id, material_id, COALESCE(department_code, '__DEFAULT__'))
        # なので ON CONFLICT を使えない (式インデックスは未対応)。先に SELECT で判定。
        await cur.execute(
            "SELECT id FROM product_material_usage "
            "WHERE product_id=%s AND material_id=%s "
            "  AND COALESCE(department_code, '__DEFAULT__') = COALESCE(%s, '__DEFAULT__')",
            (body.product_id, body.material_id, dept),
        )
        existing = await cur.fetchone()
        if existing:
            await cur.execute("""
                UPDATE product_material_usage
                SET quantity_per_unit = %s, note = %s,
                    alternative_material_ids = %s
                WHERE id = %s
                RETURNING *
            """, (body.quantity_per_unit, body.note, alt_ids, existing["id"]))
        else:
            await cur.execute("""
                INSERT INTO product_material_usage
                    (product_id, material_id, quantity_per_unit, note,
                     department_code, alternative_material_ids)
                VALUES (%s, %s, %s, %s, %s, %s)
                RETURNING *
            """, (body.product_id, body.material_id, body.quantity_per_unit, body.note,
                  dept, alt_ids))
        row = await cur.fetchone()
    await write_audit(db, "RECIPE_UPSERT", "product_material_usage",
                      str(row["id"]),
                      {"product_id": body.product_id, "material_id": body.material_id,
                       "qty_per_unit": float(body.quantity_per_unit)},
                      admin["id"], request)
    return dict(row)


class RecipeEntryIn(BaseModel):
    material_id:       int
    quantity_per_unit: Decimal = Field(..., ge=0)   # 推定モード時は 0 (未定) OK
    note:              str | None = None
    is_estimated:      bool = False
    estimation_weight: Decimal = Field(Decimal(1), gt=0)
    department_code:   str | None = None    # None=全部署デフォルト, 値あり=部署別オーバーライド
    alternative_material_ids: list[int] = Field(default_factory=list)


class ReplaceRecipesRequest(BaseModel):
    entries: list[RecipeEntryIn] = Field(default_factory=list)


async def _replace_recipes_impl(
    product_id: int, body: ReplaceRecipesRequest, db,
) -> dict:
    """商品のレシピ一括置換 の 実体 (auth 抜き)。
    public router (recipe_survey 経由 の 公開アクセス) と auth router の 共通 ヘルパー。"""
    def key_of(e: RecipeEntryIn) -> tuple[int, str]:
        return (e.material_id, e.department_code or '__DEFAULT__')
    seen: set[tuple[int, str]] = set()
    for e in body.entries:
        k = key_of(e)
        if k in seen:
            label = f"id={e.material_id}" + (
                f" / 部署={e.department_code}" if e.department_code else " / デフォルト")
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"同じレシピ ({label}) が複数指定されています")
        seen.add(k)

    async with db.cursor() as cur:
        # 商品存在チェック
        await cur.execute("SELECT id FROM products_shipped WHERE id=%s", (product_id,))
        if not await cur.fetchone():
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                detail=f"商品ID {product_id} が見つかりません")

        # 既存レシピ取得 (id 付き、(material_id, dept) で索引)
        await cur.execute(
            "SELECT id, material_id, department_code, quantity_per_unit, note, "
            "       is_estimated, estimation_weight, alternative_material_ids "
            "FROM product_material_usage WHERE product_id=%s",
            (product_id,))
        existing: dict[tuple[int, str], dict] = {}
        for r in await cur.fetchall():
            existing[(r["material_id"], r["department_code"] or '__DEFAULT__')] = r

        # default を 「material_id」 → 比較用 dict として 索引化
        defaults: dict[int, dict] = {}    # material_id -> entry-shaped dict
        for e in body.entries:
            if e.department_code is None:
                defaults[e.material_id] = {
                    "quantity_per_unit": Decimal(str(e.quantity_per_unit)),
                    "is_estimated": bool(e.is_estimated),
                    "estimation_weight": Decimal(str(e.estimation_weight)),
                    "note": e.note or "",
                    "alt_ids": sorted([aid for aid in (e.alternative_material_ids or [])
                                       if aid != e.material_id]),
                }

        def _override_matches_default(e: RecipeEntryIn) -> bool:
            """override entry が 対応 する default と 完全 一致 か。"""
            d = defaults.get(e.material_id)
            if d is None:
                return False
            alt = sorted([aid for aid in (e.alternative_material_ids or [])
                          if aid != e.material_id])
            return (
                Decimal(str(e.quantity_per_unit)) == d["quantity_per_unit"]
                and bool(e.is_estimated) == d["is_estimated"]
                and Decimal(str(e.estimation_weight)) == d["estimation_weight"]
                and (e.note or "") == d["note"]
                and alt == d["alt_ids"]
            )

        # entry を 自動クリーン: override で default と 完全一致 なら 除外
        cleaned_entries = [
            e for e in body.entries
            if e.department_code is None or not _override_matches_default(e)
        ]
        auto_cleaned = len(body.entries) - len(cleaned_entries)

        new_keys = {key_of(e) for e in cleaned_entries}
        to_delete_keys = set(existing.keys()) - new_keys
        inserted, updated = 0, 0

        # 削除 (id 単位)
        del_ids = [existing[k]["id"] for k in to_delete_keys]
        if del_ids:
            await cur.execute(
                "DELETE FROM product_material_usage WHERE id = ANY(%s)",
                (del_ids,))

        # 追加 / 更新
        for e in cleaned_entries:
            alt_ids = [aid for aid in (e.alternative_material_ids or [])
                       if aid != e.material_id]
            dept = e.department_code.strip() if e.department_code else None
            k = key_of(e)
            ex = existing.get(k)
            if ex is None:
                await cur.execute(
                    "INSERT INTO product_material_usage "
                    "(product_id, material_id, quantity_per_unit, note, "
                    " is_estimated, estimation_weight, department_code, "
                    " alternative_material_ids) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                    (product_id, e.material_id, e.quantity_per_unit, e.note,
                     e.is_estimated, e.estimation_weight, dept, alt_ids))
                inserted += 1
            else:
                old_alt = list(ex.get("alternative_material_ids") or [])
                changed = (
                    ex["quantity_per_unit"] != e.quantity_per_unit
                    or (ex["note"] or "") != (e.note or "")
                    or bool(ex.get("is_estimated")) != e.is_estimated
                    or Decimal(ex.get("estimation_weight") or 1) != e.estimation_weight
                    or old_alt != alt_ids
                )
                if changed:
                    await cur.execute(
                        "UPDATE product_material_usage "
                        "SET quantity_per_unit=%s, note=%s, "
                        "    is_estimated=%s, estimation_weight=%s, "
                        "    alternative_material_ids=%s "
                        "WHERE id=%s",
                        (e.quantity_per_unit, e.note,
                         e.is_estimated, e.estimation_weight, alt_ids,
                         ex["id"]))
                    updated += 1

    return {
        "product_id": product_id,
        "inserted":   inserted,
        "updated":    updated,
        "deleted":    len(to_delete_keys),
        "total_now":  len(cleaned_entries),
        "auto_cleaned_overrides": auto_cleaned,
    }


@router.put("/products/{product_id}/recipes")
async def replace_recipes(
    product_id: int, body: ReplaceRecipesRequest, db: DB,
    admin: AdminUser, request: Request,
):
    """商品のレシピを一括置換（管理者）。
    レシピは (material_id, department_code) ペアで一意。
    body.entries に含まれていない既存レシピは削除される（atomic）。
    新規 = INSERT / 既存維持 = UPDATE / リクエストに無い = DELETE。"""
    result = await _replace_recipes_impl(product_id, body, db)
    await write_audit(db, "RECIPE_REPLACE", "product_material_usage",
                      str(product_id),
                      {"product_id": product_id,
                       "inserted": result["inserted"],
                       "updated":  result["updated"],
                       "deleted":  result["deleted"]},
                      admin["id"], request)
    return result


# =============================================================================
# 代替資材 — 単独更新 / 主↔代替の swap
# =============================================================================

class RecipeAlternativesUpdate(BaseModel):
    alternative_material_ids: list[int] = Field(default_factory=list)


@router.put("/products/{product_id}/recipes/{material_id}/alternatives")
async def set_recipe_alternatives(
    product_id: int, material_id: int,
    body: RecipeAlternativesUpdate, db: DB,
    admin: AdminUser, request: Request,
):
    """既存レシピ (デフォルト行) の代替資材リストを差し替える (管理者)。
    部署別オーバーライド行の代替は別途 PUT /products/{id}/recipes で編集。"""
    alt_ids = [aid for aid in body.alternative_material_ids if aid != material_id]
    async with db.cursor() as cur:
        await cur.execute(
            "UPDATE product_material_usage "
            "SET alternative_material_ids=%s "
            "WHERE product_id=%s AND material_id=%s AND department_code IS NULL "
            "RETURNING alternative_material_ids",
            (alt_ids, product_id, material_id),
        )
        row = await cur.fetchone()
        if not row:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                detail=f"レシピ (product={product_id}, material={material_id}) が存在しません")
    await write_audit(db, "RECIPE_ALT_UPDATE", "product_material_usage",
                      f"{product_id}:{material_id}",
                      {"product_id": product_id, "material_id": material_id,
                       "alternatives": alt_ids}, admin["id"], request)
    return {"alternative_material_ids": list(row["alternative_material_ids"])}


class RecipeSwapRequest(BaseModel):
    """主資材と「先頭の代替資材」(または指定した代替) を入れ替える。
    旧主資材は代替リストの末尾に降格させる (履歴を消さない為)。

    department_code:
      None  → デフォルト行 (全部署) を swap
      値あり → 指定部署のオーバーライド行を swap
    """
    promote_material_id: int | None = None
    department_code:     str | None = None


@router.post("/products/{product_id}/recipes/{material_id}/swap-with-alternative")
async def swap_with_alternative(
    product_id: int, material_id: int,
    body: RecipeSwapRequest, db: DB,
    admin: AdminUser, request: Request,
):
    """主資材と代替資材を入れ替える。旧主は新しい代替リストの末尾に移動。
    例: 主=A, 代替=[B, C] + promote=B → 主=B, 代替=[C, A]
    """
    dept = body.department_code.strip() if body.department_code else None
    dept_match = "COALESCE(department_code, '__DEFAULT__') = COALESCE(%s, '__DEFAULT__')"
    dept_label = f" (部署={dept})" if dept else " (デフォルト)"
    async with db.cursor() as cur:
        await cur.execute(
            f"SELECT quantity_per_unit, note, is_estimated, estimation_weight, "
            f"       alternative_material_ids "
            f"FROM product_material_usage WHERE product_id=%s AND material_id=%s "
            f"  AND {dept_match}",
            (product_id, material_id, dept),
        )
        cur_row = await cur.fetchone()
        if not cur_row:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                detail=f"レシピ{dept_label} (product={product_id}, material={material_id}) が存在しません")

        old_alts = list(cur_row["alternative_material_ids"] or [])
        if not old_alts:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                detail="代替資材が登録されていないため swap できません")

        promote = body.promote_material_id if body.promote_material_id is not None else old_alts[0]
        if promote not in old_alts:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                detail=f"資材 {promote} は代替リストに含まれていません")

        new_alts = [aid for aid in old_alts if aid != promote] + [material_id]

        # 同じ部署スコープで既に新主資材のレシピがあるとユニーク制約で衝突
        await cur.execute(
            f"SELECT 1 FROM product_material_usage "
            f"WHERE product_id=%s AND material_id=%s AND {dept_match}",
            (product_id, promote, dept),
        )
        if await cur.fetchone():
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail=f"商品 {product_id} には既に資材 {promote} がレシピ登録されています{dept_label}。"
                       "swap 前に重複登録を解消してください")

        await cur.execute(
            f"DELETE FROM product_material_usage "
            f"WHERE product_id=%s AND material_id=%s AND {dept_match}",
            (product_id, material_id, dept),
        )
        await cur.execute(
            "INSERT INTO product_material_usage "
            "(product_id, material_id, quantity_per_unit, note, "
            " is_estimated, estimation_weight, department_code, "
            " alternative_material_ids) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
            (product_id, promote,
             cur_row["quantity_per_unit"], cur_row["note"],
             cur_row["is_estimated"], cur_row["estimation_weight"], dept, new_alts),
        )

    await write_audit(db, "RECIPE_SWAP_ALT", "product_material_usage",
                      f"{product_id}:{material_id}->{promote}",
                      {"product_id": product_id,
                       "old_main": material_id, "new_main": promote,
                       "department_code": dept,
                       "new_alternatives": new_alts}, admin["id"], request)
    return {
        "product_id":      product_id,
        "old_main":        material_id,
        "new_main":        promote,
        "department_code": dept,
        "alternatives":    new_alts,
    }


# =============================================================================
# 資材起点 一括レシピ更新
# =============================================================================

class EstimateRequest(BaseModel):
    """月次推定リクエスト。
    period: 'YYYY-MM' (この月の使用実績から推定)
    apply : true なら推定値を quantity_per_unit に書き込む
    department_code:
      None  → 全社視点 (デフォルト行を推定対象、shipment 全件で消費 R を算出)
      値あり → その部署のオーバーライド行のみを推定対象、shipment は当該部署のみで算出
              ※注: 単一部署のみの実消費 R は全社 R より小さいため、shipment も
                   その部署でフィルタしないと過大評価になる
    """
    material_id:     int
    period:          str = Field(..., pattern=r"^\d{4}-\d{2}$")
    apply:           bool = False
    department_code: str | None = None


class EstimateLine(BaseModel):
    product_id:       int
    product_code:     str | None = None
    product_name:     str
    pack_size:        Decimal | None = None
    shipment_count:   Decimal      # 月内出荷点数の合計
    weight:           Decimal      # 推定重み
    current_qty:      Decimal | None = None    # 現在の quantity_per_unit
    suggested_qty:    Decimal      # 推定によって提案する qty
    is_estimated:     bool


class EstimateResult(BaseModel):
    material_id:        int
    material_code:      str
    material_name:      str
    material_unit:      str | None
    period:             str
    # 計算詳細
    real_consumption:   Decimal     # R: レシピ由来の実消耗
    explicit_consumption: Decimal   # E: 明示qty側の消費
    residual:           Decimal     # R - E (推定対象に分配)
    unit_rate:          Decimal     # r: 単位レート
    has_required_counts: bool       # 必要な棚卸 (前月末・当月末) が両方あるか
    # 集計期間 (棚卸日に合わせた実際の範囲)
    start_count_date:   date | None = None
    start_count_qty:    Decimal | None = None
    end_count_date:     date | None = None
    end_count_qty:      Decimal | None = None
    inbound_qty:        Decimal     # 期間内 入庫 (movements > 0)
    manual_out_qty:     Decimal     # 期間内 手動出庫 (movements < 0 の絶対値)
    missing_reason:     str | None = None   # 推定不可なら理由文
    lines:              list[EstimateLine]
    applied:            bool


@router.post("/recipes/estimate", response_model=EstimateResult)
async def estimate_recipe(body: EstimateRequest, db: DB,
                          admin: AdminUser, request: Request):
    """
    指定資材の指定月の消耗実績から、推定モード商品の qty を計算する。

    数式:
        R = start_count + in_qty − end_count − manual_out
        (= レシピ由来の実消耗)
        E = Σ(明示qty商品の qty × 期間内出荷数)
        residual = R − E  (推定対象に分配)
        unit_rate r = residual / Σ(weight × pack_size × 期間内出荷数)  [推定対象のみ]
        各推定商品の suggested_qty = weight × r × pack_size

    必須棚卸 (前月内に 1 件以上 + 当月内に 1 件以上の有効棚卸) が無いと
    推定不可で missing_reason を返す。apply=true で quantity_per_unit に書込み。
    """
    from datetime import datetime as _dt
    first = _dt.strptime(body.period + "-01", "%Y-%m-%d").date()
    nxt_month = (first.replace(day=28) + timedelta(days=4)).replace(day=1)
    last = nxt_month - timedelta(days=1)
    prev_first = (first.replace(day=1) - timedelta(days=1)).replace(day=1)
    prev_last = first - timedelta(days=1)

    async with db.cursor() as cur:
        # 資材確認
        await cur.execute(
            "SELECT id, code, item_name, unit FROM materials WHERE id=%s",
            (body.material_id,))
        mat = await cur.fetchone()
        if not mat:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="資材が見つかりません")

        # ─── 必須棚卸の取得 ───
        # 前月内の最終有効棚卸 (start_count): 範囲 [prev_first, prev_last]
        # 当月内の最終有効棚卸 (end_count)  : 範囲 [first, last]
        # 「有効」= 紐付き全 object に同日 count があるか、紐付き無し資材の場合は単一 count
        def _build_valid_count_query():
            return """
                WITH dc AS (
                    SELECT count_date, SUM(counted_qty) AS total_qty,
                           COUNT(*) FILTER (WHERE object_id IS NOT NULL) AS oc,
                           BOOL_OR(object_id IS NULL) AS has_total
                    FROM material_counts
                    WHERE material_id = %s AND count_date BETWEEN %s AND %s
                    GROUP BY count_date
                ),
                mlc AS (
                    SELECT COALESCE(
                        (SELECT COUNT(DISTINCT object_id) FROM storage_object_items
                         WHERE material_id = %s), 0) AS linked_n
                ),
                valid AS (
                    SELECT dc.*,
                           CASE WHEN mlc.linked_n = 0 THEN dc.has_total
                                ELSE dc.oc >= mlc.linked_n END AS is_valid
                    FROM dc CROSS JOIN mlc
                )
                SELECT count_date, total_qty FROM valid
                WHERE is_valid ORDER BY count_date DESC LIMIT 1
            """
        await cur.execute(_build_valid_count_query(),
                          (body.material_id, prev_first, prev_last, body.material_id))
        start_count = await cur.fetchone()
        await cur.execute(_build_valid_count_query(),
                          (body.material_id, first, last, body.material_id))
        end_count = await cur.fetchone()

        has_required = start_count is not None and end_count is not None
        missing_reason: str | None = None
        if not start_count and not end_count:
            missing_reason = (f"{prev_first.strftime('%Y-%m')} と {body.period} "
                              "両方の有効棚卸が未登録です")
        elif not start_count:
            missing_reason = (f"{prev_first.strftime('%Y-%m')} の有効棚卸が未登録です "
                              "(前月繰越の元データ)")
        elif not end_count:
            missing_reason = (f"{body.period} の有効棚卸が未登録です "
                              "(月末棚卸の元データ)")

        # ─── Phase 2: 部署スコープ設定 ───
        dept = body.department_code.strip() if body.department_code else None
        # 推定対象レシピ行のフィルタ
        # dept=None → デフォルト行 (department_code IS NULL)
        # dept=値   → 部署オーバーライド行 (department_code = dept)
        if dept is None:
            recipe_dept_filter = "pmu.department_code IS NULL"
            recipe_dept_params: tuple = ()
        else:
            recipe_dept_filter = "pmu.department_code = %s"
            recipe_dept_params = (dept,)
        # 出荷フィルタ — 部署指定時はその部署の出荷のみで R / shipment_count を算出
        # (部署オーバーライド分の実消費 = その部署向け出荷だけで起こる)
        if dept is None:
            ship_dept_filter = ""
            ship_dept_params: tuple = ()
        else:
            ship_dept_filter = " AND sr.department_code = %s"
            ship_dept_params = (dept,)

        # ─── 推定可能なら集計期間を確定 ───
        if has_required:
            period_start = start_count["count_date"]  # この日の値が起点
            period_end   = end_count["count_date"]    # この日の値が終点
            # 入庫 / 手動出庫 を (period_start, period_end] で集計
            # NOTE: material_movements は部署を持たないので dept フィルタは未適用。
            # 部署スコープでは「全体の入出庫が部署消費を含む前提」で R を計算する。
            await cur.execute("""
                SELECT
                  COALESCE(SUM(CASE WHEN quantity > 0 THEN quantity END), 0) AS in_qty,
                  COALESCE(SUM(CASE WHEN quantity < 0 THEN -quantity END), 0) AS out_qty
                FROM material_movements
                WHERE material_id = %s
                  AND movement_date > %s AND movement_date <= %s
            """, (body.material_id, period_start, period_end))
            mv = await cur.fetchone()
            in_qty = mv["in_qty"]
            manual_out = mv["out_qty"]
            # 全体 R (起点−終点+入庫−手動出庫)
            R_total = (start_count["total_qty"] + in_qty
                       - end_count["total_qty"] - manual_out)
            # 部署スコープ時は R を出荷比率で按分:
            #   部署 R = 全体 R × (部署向け出荷比率)
            # 出荷比率 = Σ(部署出荷 × デフォルト qty) / Σ(全出荷 × デフォルト qty)
            # これは粗い近似だが、レシピ駆動消費のため出荷の "重み" で按分するのが自然。
            if dept is not None:
                await cur.execute(f"""
                    WITH r AS (
                        SELECT pmu.product_id, pmu.quantity_per_unit AS def_qty
                        FROM product_material_usage pmu
                        WHERE pmu.material_id = %s AND pmu.department_code IS NULL
                    )
                    SELECT
                      COALESCE(SUM(sr.quantity * r.def_qty), 0)
                        FILTER (WHERE sr.department_code = %s) AS dept_w,
                      COALESCE(SUM(sr.quantity * r.def_qty), 0) AS total_w
                    FROM shipment_records sr
                    JOIN r ON r.product_id = sr.product_id
                    WHERE sr.ship_date > %s AND sr.ship_date <= %s
                """, (body.material_id, dept, period_start, period_end))
                rw = await cur.fetchone()
                ratio = (Decimal(rw["dept_w"]) / Decimal(rw["total_w"])
                         if rw and rw["total_w"] and Decimal(rw["total_w"]) > 0
                         else Decimal(0))
                R = R_total * ratio
            else:
                R = R_total
        else:
            period_start = None
            period_end   = None
            in_qty = Decimal(0)
            manual_out = Decimal(0)
            R = Decimal(0)

        # ─── 各商品の期間内出荷数 + 現在のレシピ取得 ───
        # has_required=False のときも UI で参考表示できるよう、当月範囲で集計
        sc_start = period_start if has_required else first
        sc_end   = period_end   if has_required else last
        sql = f"""
            SELECT pmu.product_id, p.product_code, p.name AS product_name,
                   p.pack_size,
                   pmu.quantity_per_unit, pmu.is_estimated, pmu.estimation_weight,
                   COALESCE((
                     SELECT SUM(sr.quantity) FROM shipment_records sr
                     WHERE sr.product_id = pmu.product_id
                       AND sr.ship_date > %s AND sr.ship_date <= %s
                       {ship_dept_filter}
                   ), 0) AS shipment_count
            FROM product_material_usage pmu
            JOIN products_shipped p ON p.id = pmu.product_id
            WHERE pmu.material_id = %s
              AND {recipe_dept_filter}
            ORDER BY pmu.product_id
        """
        await cur.execute(sql,
            (sc_start, sc_end) + ship_dept_params
            + (body.material_id,) + recipe_dept_params)
        recipe_rows = await cur.fetchall()

        # E: 明示qty側の消費
        E = Decimal(0)
        for r in recipe_rows:
            if not r["is_estimated"]:
                E += Decimal(r["quantity_per_unit"]) * Decimal(r["shipment_count"])

        residual = R - E

        # 推定対象の Σ(weight × pack_size × shipment_count)
        denom = Decimal(0)
        for r in recipe_rows:
            if r["is_estimated"]:
                ps = Decimal(r["pack_size"] or 1)
                w  = Decimal(r["estimation_weight"])
                sc = Decimal(r["shipment_count"])
                denom += w * ps * sc
        unit_rate = (residual / denom) if (has_required and denom > 0) else Decimal(0)

        # 各商品の suggested_qty
        lines: list[EstimateLine] = []
        for r in recipe_rows:
            ps = Decimal(r["pack_size"] or 1)
            w  = Decimal(r["estimation_weight"])
            if r["is_estimated"] and has_required and denom > 0:
                suggested = w * unit_rate * ps
            else:
                suggested = Decimal(r["quantity_per_unit"])   # 推定不可なら現状維持
            lines.append(EstimateLine(
                product_id     = r["product_id"],
                product_code   = r["product_code"],
                product_name   = r["product_name"],
                pack_size      = r["pack_size"],
                shipment_count = r["shipment_count"],
                weight         = r["estimation_weight"],
                current_qty    = r["quantity_per_unit"],
                suggested_qty  = suggested,
                is_estimated   = r["is_estimated"],
            ))

        # 適用 (推定可能 + denom > 0 + apply フラグの 3 条件)
        # dept スコープと一致する行に書き込む (UNIQUE INDEX と同形の COALESCE)
        will_apply = body.apply and has_required and denom > 0
        if will_apply:
            for ln in lines:
                if ln.is_estimated and ln.suggested_qty > 0:
                    await cur.execute("""
                        UPDATE product_material_usage
                        SET quantity_per_unit = %s,
                            estimated_at = now()
                        WHERE product_id = %s AND material_id = %s
                          AND COALESCE(department_code, '__DEFAULT__') = COALESCE(%s, '__DEFAULT__')
                    """, (ln.suggested_qty, ln.product_id, body.material_id, dept))

    if will_apply:
        await write_audit(db, "RECIPE_ESTIMATE_APPLY", "product_material_usage",
                          str(body.material_id),
                          {"period": body.period,
                           "department_code": dept,
                           "real_consumption": float(R),
                           "applied_lines": sum(
                               1 for l in lines
                               if l.is_estimated and l.suggested_qty > 0),
                          },
                          admin["id"], request)
    return EstimateResult(
        material_id  = body.material_id,
        material_code = mat["code"],
        material_name = mat["item_name"],
        material_unit = mat["unit"],
        period        = body.period,
        real_consumption     = R,
        explicit_consumption = E,
        residual             = residual,
        unit_rate            = unit_rate,
        has_required_counts  = has_required,
        start_count_date     = start_count["count_date"] if start_count else None,
        start_count_qty      = start_count["total_qty"]  if start_count else None,
        end_count_date       = end_count["count_date"]   if end_count   else None,
        end_count_qty        = end_count["total_qty"]    if end_count   else None,
        inbound_qty          = in_qty,
        manual_out_qty       = manual_out,
        missing_reason       = missing_reason,
        lines                = lines,
        applied              = will_apply,
    )


class BulkRecipeItem(BaseModel):
    """1 商品分の指定。quantity_per_unit/note を指定すれば商品別オーバーライド。
    省略時はリクエストの共通値 (quantity_per_unit/note) を使う。"""
    product_id:        int
    quantity_per_unit: Decimal | None = Field(None, ge=0)
    note:              str | None = None


class BulkRecipeRequest(BaseModel):
    """同じ資材を複数商品にまとめて適用/削除する。
    action='set'   : 各商品の (product, material, department_code) を UPSERT (重複は更新)
    action='delete': 各商品の (product, material, department_code) を削除
    is_estimated=true のときは qty 未定 (0) でも登録可能。

    department_code:
      None  → デフォルト行 (全部署適用) を編集
      値あり → 指定部署のオーバーライド行を編集

    入力形式は 2 通り (後方互換):
      A. items=[{product_id, quantity_per_unit?, note?}]  ← 商品別 qty を指定できる
      B. product_ids=[...] + 共通 quantity_per_unit  ← 全商品同じ qty (旧版互換)
    """
    material_id:       int
    action:            str = Field(..., pattern="^(set|delete)$")
    items:             list[BulkRecipeItem] | None = None
    product_ids:       list[int] | None = None      # 後方互換
    quantity_per_unit: Decimal | None = Field(None, ge=0,
        description="共通 qty。item で省略のときに使用 (action=set 時に必要)")
    note:              str | None = None
    is_estimated:      bool = False
    estimation_weight: Decimal = Field(Decimal(1), gt=0)
    department_code:   str | None = None

    def normalized_items(self) -> list[BulkRecipeItem]:
        """items または product_ids → BulkRecipeItem リストへ正規化"""
        if self.items:
            return self.items
        if self.product_ids:
            return [BulkRecipeItem(product_id=pid) for pid in self.product_ids]
        return []


@router.put("/recipes/bulk")
async def bulk_update_recipes(body: BulkRecipeRequest, db: DB,
                              admin: AdminUser, request: Request):
    """資材起点で複数商品のレシピを一括変更 (admin)。"""
    items = body.normalized_items()
    if not items:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="items または product_ids を 1 件以上指定してください")

    # 各 item の最終 qty を解決 (item の qty が指定されてなければ共通値を使う)
    def resolve_qty(it: BulkRecipeItem) -> Decimal | None:
        return it.quantity_per_unit if it.quantity_per_unit is not None else body.quantity_per_unit

    # 検証 (set のとき)
    if body.action == 'set':
        for it in items:
            qty = resolve_qty(it)
            if qty is None:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=f"商品 {it.product_id} の quantity_per_unit が未指定です")
            if not body.is_estimated and not (qty > 0):
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=f"商品 {it.product_id} の quantity_per_unit は 0 より大きい必要があります "
                           "(推定モードなら 0 可)")

    # Phase 2: department_code を一意キーの一部として扱う。
    # None → デフォルト行を編集、値あり → 部署オーバーライド行を編集
    dept = body.department_code.strip() if body.department_code else None
    # WHERE 句: COALESCE で NULL を '__DEFAULT__' に揃え、UNIQUE INDEX と同形にする
    dept_match = "COALESCE(department_code, '__DEFAULT__') = COALESCE(%s, '__DEFAULT__')"

    n_inserted = 0; n_updated = 0; n_deleted = 0
    async with db.cursor() as cur:
        await cur.execute("SELECT 1 FROM materials WHERE id=%s", (body.material_id,))
        if not await cur.fetchone():
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="資材が存在しません")
        if body.action == 'set':
            for it in items:
                qty = resolve_qty(it)
                note = it.note if it.note is not None else body.note
                await cur.execute(
                    f"SELECT 1 FROM product_material_usage "
                    f"WHERE product_id=%s AND material_id=%s AND {dept_match}",
                    (it.product_id, body.material_id, dept))
                exists = await cur.fetchone() is not None
                if exists:
                    await cur.execute(
                        f"UPDATE product_material_usage "
                        f"SET quantity_per_unit=%s, note=%s, "
                        f"    is_estimated=%s, estimation_weight=%s "
                        f"WHERE product_id=%s AND material_id=%s AND {dept_match}",
                        (qty, note, body.is_estimated, body.estimation_weight,
                         it.product_id, body.material_id, dept))
                    n_updated += 1
                else:
                    await cur.execute(
                        "INSERT INTO product_material_usage "
                        "(product_id, material_id, quantity_per_unit, note, "
                        " is_estimated, estimation_weight, department_code) "
                        "VALUES (%s, %s, %s, %s, %s, %s, %s)",
                        (it.product_id, body.material_id, qty, note,
                         body.is_estimated, body.estimation_weight, dept))
                    n_inserted += 1
        else:  # delete
            pids = [it.product_id for it in items]
            await cur.execute(
                f"DELETE FROM product_material_usage "
                f"WHERE material_id=%s AND product_id = ANY(%s) "
                f"  AND {dept_match}",
                (body.material_id, pids, dept))
            n_deleted = cur.rowcount or 0

    await write_audit(db, "RECIPE_BULK", "product_material_usage",
                      str(body.material_id),
                      {"action": body.action,
                       "n_products": len(items),
                       "inserted": n_inserted, "updated": n_updated,
                       "deleted": n_deleted,
                       "department_code": dept,
                       "common_qty": float(body.quantity_per_unit) if body.quantity_per_unit else None},
                      admin["id"], request)
    return {
        "material_id":     body.material_id,
        "action":          body.action,
        "department_code": dept,
        "inserted":        n_inserted,
        "updated":         n_updated,
        "deleted":         n_deleted,
        "n_products":      len(items),
    }
