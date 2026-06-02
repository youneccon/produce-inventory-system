"""
api/routers/materials.py
========================
資材管理台帳API（ロット管理なし。1つの整理番号がずっと増減する設計）。

  GET  /materials/stock             - 現在在庫一覧
  GET  /materials/calendar          - 日次カレンダー（資材×日付）
  POST /materials/movements         - 入出庫を記録（正=入荷, 負=出庫）
  POST /materials                   - 資材マスタの登録（管理者）
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from decimal import Decimal

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from api.audit import write_audit
from api.auth import AdminUser, CurrentUser, OperatorUser
from api.dependencies import DB

router = APIRouter(prefix="/materials", tags=["資材"])


# =============================================================================
# モデル
# =============================================================================

class MaterialStock(BaseModel):
    material_id:          int
    code:                 str
    division:             int
    supplier_id:          int | None = None    # migration 025 で追加 (NOT NULL 化済み)
    supplier_name:        str
    item_name:            str
    unit:                 str | None
    is_active:            bool
    unit_price:           Decimal | None = None
    category:             str | None = None
    length_per_roll_cm:   Decimal | None = None
    pack_size:            Decimal | None = None     # 1ケース入り数 (表示用)
    base_qty:             Decimal
    base_date:            date | None
    movements_since_base: Decimal
    remaining_qty:        Decimal             # 理論在庫
    auto_consumption_cm:  Decimal | None = None
    stock_value:          Decimal | None = None
    # 棚卸ベース (実測) 系列
    latest_count_date:    date | None = None
    latest_count_total:   Decimal | None = None     # 集計値 (incomplete でも入る)
    latest_count_complete: bool | None = None
    linked_object_count:  int | None = None          # 紐付き object 数
    counted_object_n:     int | None = None          # 棚卸済 object 数
    actual_qty:           Decimal | None = None     # 採用される実在庫 (incomplete=NULL)
    # 棚卸日時点の理論在庫 (前回棚卸が必要、無いと NULL)
    theoretical_at_count_date: Decimal | None = None
    # レシピ登録状況
    recipe_product_count:  int = 0
    recipe_estimated_count: int = 0
    # 一般消耗品フラグ (M3 2026-05) — 孤児資材判定に使用
    is_general_supply: bool = False


class MaterialCountCreate(BaseModel):
    material_id:  int
    count_date:   date
    counted_qty:  Decimal = Field(..., ge=0)
    object_id:    int | None = None     # 配置場所 (NULL = 全体合計)
    note:         str | None = None
    overwrite:    bool = False           # 既存重複を上書き


class MaterialCountOut(BaseModel):
    id:           int
    material_id:  int
    material_code: str | None = None
    material_name: str | None = None
    object_id:    int | None = None
    object_label: str | None = None
    count_date:   date
    counted_qty:  Decimal
    source:       str
    note:         str | None = None
    confirmed_at: datetime
    confirmed_by_name: str | None = None


class MaterialPatch(BaseModel):
    """資材マスタの部分更新。"""
    length_per_roll_cm: Decimal | None = Field(None, ge=0,
        description="1巻(本)あたりの長さ(cm)。0 を渡すと NULL に戻す")
    unit_price:         Decimal | None = Field(None, ge=0)
    category:           str | None = None
    division:           int | None = Field(None, ge=0, le=99)
    pack_size:          Decimal | None = Field(None, ge=0,
        description="1ケース当たりの入り数 (表示用)。0 で NULL に戻す")


class MaterialCreate(BaseModel):
    """資材マスタ新規登録リクエスト。
    仕入先は supplier_id (推奨) または supplier_name (後方互換) で指定可。
    両方未指定なら 422。supplier_name のみ指定時は suppliers から名前で解決し、
    無ければ自動作成する。"""
    division:      int    = Field(..., ge=0, le=99,
        description="0=未割当 (後で資材一覧画面から変更可能)")
    supplier_id:   int | None = Field(None,
        description="仕入先 ID。指定時はこちらが優先。")
    supplier_name: str | None = Field(None, min_length=1,
        description="後方互換。supplier_id 未指定時に名前で解決 (無ければ自動作成)。")
    item_name:     str    = Field(..., min_length=1)
    unit:          str | None = None
    pack_size:     Decimal | None = Field(None, ge=0,
        description="1ケース当たりの入り数 (任意・後から設定可)")


class MovementCreate(BaseModel):
    material_id:   int
    movement_date: date
    quantity:      Decimal = Field(..., description="正=入荷 / 負=出庫")
    note:          str | None = None


class MaterialCalendarRow(BaseModel):
    material_id:        int
    code:               str
    supplier_id:        int | None = None    # migration 025 で追加
    supplier_name:      str
    item_name:          str
    unit:               str | None
    length_per_roll_cm: Decimal | None = None
    category:           str | None = None       # フィルタ用
    recipe_product_count: int = 0               # 何商品でレシピ登録されているか (0=未登録)
    carryover_qty:      Decimal               # 前月繰越
    inbound_qty:        Decimal               # 当月入荷合計
    outbound_qty:       Decimal               # 当月出庫合計（負値movement の絶対値合計）
    end_qty:            Decimal               # 当月在庫
    daily_in:           dict[str, Decimal]    # 日 → 入荷
    daily_out:          dict[str, Decimal]    # 日 → 出庫（絶対値）


class MaterialCalendar(BaseModel):
    month:         str
    days_in_month: int
    rows:          list[MaterialCalendarRow]


def _month_last_day(month: str) -> date:
    first = datetime.strptime(month + "-01", "%Y-%m-%d").date()
    return (first.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)


def _next_code(cur, division: int) -> str:
    """SZ + 2桁部門 + 3桁連番。空きを使う簡易実装。"""
    cur_result = cur.execute(
        "SELECT code FROM materials WHERE division=%s ORDER BY code",
        (division,),
    )
    # cur.execute は同期的にカーソルを返す
    return ""  # 下で実際にawaitして使う


# =============================================================================
# エンドポイント
# =============================================================================

@router.get("/categories")
async def list_categories(db: DB, user: CurrentUser):
    """資材カテゴリ一覧（distinct, 件数付き）。"""
    async with db.cursor() as cur:
        await cur.execute("""
            SELECT category, COUNT(*) AS material_count
              FROM materials
             WHERE category IS NOT NULL AND is_active
             GROUP BY category
             ORDER BY category
        """)
        return [dict(r) for r in await cur.fetchall()]


@router.get("/stock", response_model=list[MaterialStock])
async def list_material_stock(
    db: DB, user: CurrentUser,
    division: int | None = Query(None),
    category: str | None = Query(None,
        description="カテゴリで絞り込み（段ボール/袋/ラベル/フィルム/ネット/容器/...）"),
    include_unassigned: bool = Query(False,
        description="division 指定時に、division=0 (未割当) も含める"),
):
    """現在在庫一覧（material_stock VIEW）。"""
    conds: list[str] = ["1=1"]
    params: list = []

    if division is not None:
        if include_unassigned:
            params.append(division)
            conds.append("(division=%s OR division=0)")
        else:
            params.append(division); conds.append("division=%s")

    if category:
        params.append(category); conds.append("category=%s")

    async with db.cursor() as cur:
        await cur.execute(
            f"SELECT * FROM material_stock WHERE {' AND '.join(conds)} ORDER BY code",
            params or None,
        )
        return [MaterialStock(**r) for r in await cur.fetchall()]


@router.get("/calendar", response_model=MaterialCalendar)
async def get_material_calendar(
    db: DB,
    user: CurrentUser,
    month: str | None = Query(None, description="YYYY-MM。省略時は最新の活動月"),
    division: int | None = Query(None),
):
    """資材×日付のグリッド。入荷と出庫を別々に保持。"""
    async with db.cursor() as cur:
        if not month:
            await cur.execute("""
                SELECT to_char(
                    COALESCE((SELECT MAX(movement_date) FROM material_movements), CURRENT_DATE),
                    'YYYY-MM') AS m
            """)
            month = (await cur.fetchone())["m"]

        first = datetime.strptime(month + "-01", "%Y-%m-%d").date()
        last = _month_last_day(month)
        prev_month = (first - timedelta(days=1)).strftime("%Y-%m")

        # 資材一覧（前月繰越と一緒に）
        # m.category + レシピ登録数も付加 (フロント側フィルタ用)
        div_filter = "AND m.division = %(division)s" if division is not None else ""
        params = {"prev": prev_month, "division": division}
        await cur.execute(f"""
            SELECT
                m.id AS material_id, m.code, m.supplier_id, m.supplier_name,
                m.item_name, m.unit,
                m.length_per_roll_cm, m.category,
                COALESCE(mc.counted_qty, 0) AS carryover_qty,
                COALESCE(rc.recipe_product_count, 0) AS recipe_product_count
            FROM materials m
            LEFT JOIN material_counts mc
              ON mc.material_id = m.id AND mc.period = %(prev)s
            LEFT JOIN (
                SELECT material_id, COUNT(DISTINCT product_id) AS recipe_product_count
                FROM product_material_usage GROUP BY material_id
            ) rc ON rc.material_id = m.id
            WHERE m.is_active {div_filter}
            ORDER BY m.code
        """, params)
        rows = await cur.fetchall()

        # 当月の手動 movement
        await cur.execute("""
            SELECT material_id, movement_date, quantity
            FROM material_movements
            WHERE movement_date BETWEEN %s AND %s
            ORDER BY movement_date
        """, (first, last))
        movements = await cur.fetchall()

        # 当月の商品出荷から導出される資材消耗（material × day で合算）
        # 長さ管理資材 (length_per_roll_cm 設定済み) は cm 合計 ÷ 長さ で巻数換算
        await cur.execute("""
            SELECT pmu.material_id, sr.ship_date,
                   SUM(sr.quantity * pmu.quantity_per_unit) AS consumed_raw,
                   CASE
                     WHEN m.length_per_roll_cm IS NOT NULL AND m.length_per_roll_cm > 0
                     THEN SUM(sr.quantity * pmu.quantity_per_unit) / m.length_per_roll_cm
                     ELSE SUM(sr.quantity * pmu.quantity_per_unit)
                   END AS consumed
            FROM shipment_records sr
            JOIN product_material_usage pmu ON pmu.product_id = sr.product_id
            JOIN materials m ON m.id = pmu.material_id
            WHERE sr.ship_date BETWEEN %s AND %s
            GROUP BY pmu.material_id, sr.ship_date, m.length_per_roll_cm
        """, (first, last))
        consumptions = await cur.fetchall()

    in_by_mat: dict[int, dict[int, Decimal]] = {}
    out_by_mat: dict[int, dict[int, Decimal]] = {}
    for mv in movements:
        mid = mv["material_id"]
        d = mv["movement_date"].day
        if mv["quantity"] > 0:
            in_by_mat.setdefault(mid, {})[d] = in_by_mat.get(mid, {}).get(d, Decimal(0)) + mv["quantity"]
        else:
            out_by_mat.setdefault(mid, {})[d] = out_by_mat.get(mid, {}).get(d, Decimal(0)) + (-mv["quantity"])
    # 商品出荷からの自動消耗を出庫側へ合算
    for c in consumptions:
        mid = c["material_id"]
        d = c["ship_date"].day
        out_by_mat.setdefault(mid, {})[d] = out_by_mat.get(mid, {}).get(d, Decimal(0)) + c["consumed"]

    out_rows: list[MaterialCalendarRow] = []
    for r in rows:
        mid = r["material_id"]
        in_map = in_by_mat.get(mid, {})
        out_map = out_by_mat.get(mid, {})
        inbound = sum(in_map.values(), Decimal(0))
        outbound = sum(out_map.values(), Decimal(0))
        carry = r["carryover_qty"]
        out_rows.append(MaterialCalendarRow(
            material_id=mid, code=r["code"],
            supplier_id=r.get("supplier_id"),
            supplier_name=r["supplier_name"], item_name=r["item_name"], unit=r["unit"],
            length_per_roll_cm=r["length_per_roll_cm"],
            category=r.get("category"),
            recipe_product_count=int(r.get("recipe_product_count") or 0),
            carryover_qty=carry, inbound_qty=inbound, outbound_qty=outbound,
            end_qty=carry + inbound - outbound,
            daily_in={str(k): v for k, v in in_map.items()},
            daily_out={str(k): v for k, v in out_map.items()},
        ))

    return MaterialCalendar(month=month, days_in_month=last.day, rows=out_rows)


@router.get("/movements")
async def list_movements(
    db: DB, user: CurrentUser,
    material_id: int | None = Query(None),
    division:    int | None = Query(None, description="事業部で絞り込み"),
    include_unassigned: bool = Query(True,
        description="division 指定時、事業部=0 (未割当) も含めるか"),
    direction:   str | None = Query(None, pattern="^(in|out)$",
        description="in=入荷のみ / out=出庫のみ / None=両方"),
    date_from:   str | None = Query(None, description="YYYY-MM-DD"),
    date_to:     str | None = Query(None, description="YYYY-MM-DD"),
    limit:       int = Query(500, ge=1, le=5000),
):
    """資材の入出庫履歴。日付範囲・資材・事業部・方向で絞り込み可。
    resp は materials の表示用属性 (code, item_name, supplier_name, unit) も含む。"""
    conds: list[str] = ["1=1"]
    params: list = []
    if material_id is not None:
        params.append(material_id); conds.append("mv.material_id = %s")
    if division is not None:
        if include_unassigned:
            params.append(division)
            conds.append("(m.division = %s OR m.division = 0)")
        else:
            params.append(division)
            conds.append("m.division = %s")
    if direction == "in":
        conds.append("mv.quantity > 0")
    elif direction == "out":
        conds.append("mv.quantity < 0")
    if date_from:
        params.append(date_from);   conds.append("mv.movement_date >= %s")
    if date_to:
        params.append(date_to);     conds.append("mv.movement_date <= %s")
    params.append(limit)
    async with db.cursor() as cur:
        await cur.execute(
            f"""SELECT mv.id, mv.material_id, mv.movement_date,
                       mv.quantity, mv.note, mv.created_at,
                       m.code, m.item_name, m.supplier_name, m.unit, m.division,
                       u.display_name AS created_by_name
                  FROM material_movements mv
                  JOIN materials m ON m.id = mv.material_id
                  LEFT JOIN users u ON u.id = mv.created_by
                 WHERE {' AND '.join(conds)}
                 ORDER BY mv.movement_date DESC, mv.id DESC
                 LIMIT %s""", params)
        return [dict(r) for r in await cur.fetchall()]


class MovementPatch(BaseModel):
    """資材入出庫レコードの部分更新。material_id は変更不可。"""
    movement_date: date | None = None
    quantity:      Decimal | None = None    # 正=入荷 / 負=出庫, 0 は不可
    note:          str | None = None


async def _simulate_material_balance(
    cur, material_id: int,
    exclude_movement_id: int | None,
    new_event: tuple[date, Decimal] | None,
) -> tuple[date, Decimal] | None:
    """資材の理論在庫タイムラインをシミュレーション。
    最新有効棚卸を起点に、対象 movement を除外し、提案変更を注入した上で
    日毎の累積残量を計算する。最初に負になる (日付, 残量) を返す。安全なら None。

    対象イベント:
      - manual movements (material_movements) ※ exclude_movement_id を除外
      - 自動消耗 (shipment_records × product_material_usage)
        ※ length_per_roll_cm が有効な資材は cm を巻数に換算
    """
    # 起点 = material_stock VIEW から base_qty + base_date を取得
    # base_date は最新の棚卸日。未棚卸の資材では NULL なので epoch (1900-01-01) で代用。
    await cur.execute(
        "SELECT base_qty, base_date FROM material_stock WHERE material_id = %s",
        (material_id,))
    base = await cur.fetchone()
    if not base:
        return None
    base_qty = Decimal(str(base["base_qty"] or 0))
    base_date = base["base_date"] or date(1900, 1, 1)

    await cur.execute(
        """
        WITH manual AS (
            SELECT mv.movement_date AS d, mv.quantity::numeric AS q
            FROM material_movements mv
            WHERE mv.material_id = %s
              AND mv.movement_date > %s
              AND (%s::int IS NULL OR mv.id <> %s::int)
        ),
        auto AS (
            SELECT sr.ship_date AS d,
                   -(sr.quantity * pmu.quantity_per_unit
                     / CASE WHEN m.length_per_roll_cm IS NOT NULL
                                 AND m.length_per_roll_cm > 0
                            THEN m.length_per_roll_cm ELSE 1 END)::numeric AS q
            FROM shipment_records sr
            JOIN product_material_usage pmu ON pmu.product_id = sr.product_id
            JOIN materials m ON m.id = %s
            WHERE pmu.material_id = %s
              AND sr.ship_date > %s
        )
        SELECT d, SUM(q) AS net FROM (
            SELECT d, q FROM manual
            UNION ALL
            SELECT d, q FROM auto
        ) e
        GROUP BY d
        ORDER BY d
        """,
        (material_id, base_date,
         exclude_movement_id, exclude_movement_id,
         material_id, material_id, base_date),
    )
    daily: dict = {r["d"]: Decimal(str(r["net"])) for r in await cur.fetchall()}

    if new_event is not None:
        new_date, new_qty = new_event
        if new_date > base_date:
            daily[new_date] = daily.get(new_date, Decimal(0)) + new_qty

    balance = base_qty
    for d in sorted(daily.keys()):
        balance += daily[d]
        if balance < 0:
            return (d, balance)
    return None


@router.patch("/movements/{movement_id}")
async def patch_movement(movement_id: int, body: MovementPatch, db: DB,
                         user: OperatorUser, request: Request):
    """資材入出庫レコードの部分更新 (日付 / 数量 / 備考)。

    安全規則:
      - 備考のみ変更 → 常に許可 (在庫計算に影響しないため)
      - 日付 / 数量変更 → 変更日以降のどの時点でも理論在庫が負にならない場合のみ許可
        (下流の出庫/自動消耗が成立するか forward simulation で検証)
    """
    fields = body.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="更新するフィールドが指定されていません")
    if "quantity" in fields and fields["quantity"] == 0:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="quantity は 0 以外で指定してください")

    async with db.cursor() as cur:
        await cur.execute(
            "SELECT material_id, movement_date, quantity, note "
            "FROM material_movements WHERE id = %s", (movement_id,))
        existing = await cur.fetchone()
        if not existing:
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                detail=f"資材入出庫レコード(id={movement_id})が見つかりません")

        # 日付 / 数量変更が含まれる場合のみ forward simulation を実行
        if "movement_date" in fields or "quantity" in fields:
            new_date = fields.get("movement_date", existing["movement_date"])
            new_qty  = Decimal(str(fields.get("quantity", existing["quantity"])))
            neg = await _simulate_material_balance(
                cur, existing["material_id"],
                exclude_movement_id=movement_id,
                new_event=(new_date, new_qty),
            )
            if neg is not None:
                bad_date, bad_balance = neg
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    detail=f"この変更を適用すると {bad_date} 時点の理論在庫が "
                           f"{bad_balance} になり、下流の出庫/自動消耗が成立しません。"
                           f"先に下流のデータを修正してください。",
                )

        sets: list[str] = []
        params: list = []
        if "movement_date" in fields:
            sets.append("movement_date = %s"); params.append(fields["movement_date"])
        if "quantity" in fields:
            sets.append("quantity = %s"); params.append(fields["quantity"])
        if "note" in fields:
            sets.append("note = %s"); params.append(fields["note"])
        params.append(movement_id)

        await cur.execute(
            f"UPDATE material_movements SET {', '.join(sets)} "
            f"WHERE id = %s RETURNING *",
            params)
        row = await cur.fetchone()
    await write_audit(db, "MATERIAL_MOVEMENT_PATCH", "material_movements",
                      str(movement_id),
                      {k: (float(v) if isinstance(v, Decimal) else str(v) if v is not None else None)
                       for k, v in fields.items()},
                      user["id"], request)
    return dict(row)


@router.delete("/movements/{movement_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_movement(movement_id: int, db: DB,
                          user: OperatorUser, request: Request):
    """資材入出庫レコードを削除 (取り消し)。
    削除によって下流のどこかで理論在庫が負になる場合は拒否。"""
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT material_id, quantity, movement_date "
            "FROM material_movements WHERE id = %s", (movement_id,))
        existing = await cur.fetchone()
        if not existing:
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                detail=f"資材入出庫レコード(id={movement_id})が見つかりません")

        neg = await _simulate_material_balance(
            cur, existing["material_id"],
            exclude_movement_id=movement_id,
            new_event=None,
        )
        if neg is not None:
            bad_date, bad_balance = neg
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail=f"このレコードを削除すると {bad_date} 時点の理論在庫が "
                       f"{bad_balance} になり、下流の出庫/自動消耗が成立しません。"
                       f"先に下流のデータを修正してください。",
            )

        await cur.execute(
            "DELETE FROM material_movements WHERE id = %s",
            (movement_id,))
    await write_audit(db, "MATERIAL_MOVEMENT_DELETE", "material_movements",
                      str(movement_id),
                      {"material_id": existing["material_id"],
                       "quantity": float(existing["quantity"]),
                       "date": str(existing["movement_date"])},
                      user["id"], request)


@router.post("/movements", status_code=status.HTTP_201_CREATED)
async def create_movement(body: MovementCreate, db: DB,
                          user: OperatorUser, request: Request):
    """資材の入出庫を記録する。正=入荷 / 負=出庫。"""
    if body.quantity == 0:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="quantity は 0 以外で指定してください")
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT 1 FROM materials WHERE id=%s", (body.material_id,))
        if not await cur.fetchone():
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                detail=f"資材ID {body.material_id} が見つかりません")
        await cur.execute("""
            INSERT INTO material_movements
                (material_id, movement_date, quantity, note, created_by)
            VALUES (%s, %s, %s, %s, %s)
            RETURNING *
        """, (body.material_id, body.movement_date, body.quantity,
              body.note, user["id"]))
        row = await cur.fetchone()
    await write_audit(db, "MATERIAL_MOVEMENT", "material_movements",
                      str(row["id"]),
                      {"material_id": body.material_id,
                       "quantity": float(body.quantity),
                       "date": str(body.movement_date)},
                      user["id"], request)
    return dict(row)


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_material(body: MaterialCreate, db: DB,
                          admin: AdminUser, request: Request):
    """資材マスタを新規登録（管理者）。code は SZ + 2桁部門 + 3桁連番で自動採番。

    仕入先解決ロジック (migration 025 以降):
      1. supplier_id 指定あり → そのまま使用 (存在確認のみ)
      2. supplier_id 未指定 + supplier_name あり → suppliers から名前で SELECT、
         無ければ INSERT して id を取得
      3. 両方未指定 → 422
    supplier_name カラムは表示キャッシュとして併用 (FK の name と同期)。
    """
    if body.supplier_id is None and not (body.supplier_name and body.supplier_name.strip()):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="supplier_id または supplier_name のいずれかを指定してください")

    async with db.cursor() as cur:
        # ─── 仕入先解決 ───
        if body.supplier_id is not None:
            await cur.execute(
                "SELECT id, name FROM suppliers WHERE id = %s", (body.supplier_id,))
            sup = await cur.fetchone()
            if not sup:
                raise HTTPException(status.HTTP_404_NOT_FOUND,
                    detail=f"supplier_id={body.supplier_id} が存在しません")
            supplier_id = sup["id"]
            supplier_name = sup["name"]
        else:
            sname = body.supplier_name.strip()
            await cur.execute(
                "SELECT id FROM suppliers WHERE name = %s", (sname,))
            sup = await cur.fetchone()
            if sup:
                supplier_id = sup["id"]
            else:
                # 自動作成
                await cur.execute(
                    "INSERT INTO suppliers (name) VALUES (%s) RETURNING id",
                    (sname,))
                supplier_id = (await cur.fetchone())["id"]
            supplier_name = sname

        # ─── code 採番 ───
        await cur.execute(
            "SELECT code FROM materials WHERE division=%s ORDER BY code DESC LIMIT 1",
            (body.division,))
        last = await cur.fetchone()
        n = (int(last["code"][-3:]) + 1) if last else 1
        code = f"SZ{body.division:02d}{n:03d}"

        # ─── INSERT (supplier_id と supplier_name を併記) ───
        await cur.execute("""
            INSERT INTO materials
                (code, division, supplier_id, supplier_name, item_name, unit, pack_size)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            RETURNING *
        """, (code, body.division, supplier_id, supplier_name,
              body.item_name.strip(), body.unit,
              body.pack_size if body.pack_size else None))
        row = await cur.fetchone()
    await write_audit(db, "MATERIAL_CREATE", "materials", str(row["id"]),
                      {"code": code, "item_name": body.item_name,
                       "supplier_id": supplier_id},
                      admin["id"], request)
    return dict(row)


@router.patch("/{material_id}")
async def patch_material(material_id: int, body: MaterialPatch,
                         db: DB, admin: AdminUser, request: Request):
    """資材マスタの部分更新（長さ・単価・カテゴリ・事業部）。"""
    sets: list[str] = []
    params: list = []
    audit: dict = {"material_id": material_id}

    fields = body.model_dump(exclude_unset=True)
    if "length_per_roll_cm" in fields:
        v = fields["length_per_roll_cm"]
        # 0 を NULL 扱いにする (長さ管理を解除)
        if v is not None and v == 0:
            v = None
        sets.append("length_per_roll_cm = %s")
        params.append(v)
        audit["length_per_roll_cm"] = None if v is None else float(v)
    if "unit_price" in fields:
        sets.append("unit_price = %s")
        params.append(fields["unit_price"])
        audit["unit_price"] = None if fields["unit_price"] is None else float(fields["unit_price"])
    if "category" in fields:
        sets.append("category = %s")
        params.append(fields["category"])
        audit["category"] = fields["category"]
    if "division" in fields:
        sets.append("division = %s")
        params.append(fields["division"])
        audit["division"] = fields["division"]
    if "pack_size" in fields:
        v = fields["pack_size"]
        # 0 を NULL 扱い (入り数未設定に戻す)
        if v is not None and v == 0:
            v = None
        sets.append("pack_size = %s")
        params.append(v)
        audit["pack_size"] = None if v is None else float(v)

    if not sets:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="更新するフィールドが指定されていません")
    sets.append("updated_at = now()")
    params.append(material_id)

    async with db.cursor() as cur:
        await cur.execute(
            f"UPDATE materials SET {', '.join(sets)} WHERE id = %s RETURNING *",
            params)
        row = await cur.fetchone()
        if not row:
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                detail=f"資材ID {material_id} が見つかりません")
    await write_audit(db, "MATERIAL_PATCH", "materials", str(material_id),
                      audit, admin["id"], request)
    return dict(row)


@router.delete("/{material_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_material(material_id: int, db: DB,
                          admin: AdminUser, request: Request):
    """資材マスタを物理削除 (管理者)。
    参照あり (入出庫履歴・棚卸・レシピ・配置) の場合は 409 で拒否。
    レスポンス body に「何件残っているか」を含めるためエラー時のみ詳細を返す。

    storage_object_items は ON DELETE CASCADE なので参照ありでも実際は削除可能だが、
    意図しないデータ削除を防ぐため明示的にブロック。"""
    async with db.cursor() as cur:
        # 存在チェック + 表示用名前
        await cur.execute(
            "SELECT id, code, item_name FROM materials WHERE id = %s",
            (material_id,))
        existing = await cur.fetchone()
        if not existing:
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                detail=f"資材ID {material_id} が見つかりません")

        # 参照件数を一括取得
        await cur.execute(
            """
            SELECT
              (SELECT COUNT(*) FROM material_movements   WHERE material_id = %s) AS movements,
              (SELECT COUNT(*) FROM material_counts      WHERE material_id = %s) AS counts,
              (SELECT COUNT(*) FROM product_material_usage
                                                          WHERE material_id = %s) AS recipes_primary,
              (SELECT COUNT(*) FROM product_material_usage
                                          WHERE %s = ANY(alternative_material_ids)) AS recipes_alt,
              (SELECT COUNT(*) FROM storage_object_items WHERE material_id = %s) AS placements
            """,
            (material_id,) * 5,
        )
        refs = await cur.fetchone()

        blockers = []
        if refs["movements"]:        blockers.append(f"入出庫履歴 {refs['movements']} 件")
        if refs["counts"]:           blockers.append(f"棚卸 {refs['counts']} 件")
        if refs["recipes_primary"]:  blockers.append(f"レシピ主資材 {refs['recipes_primary']} 件")
        if refs["recipes_alt"]:      blockers.append(f"レシピ代替資材 {refs['recipes_alt']} 件")
        if refs["placements"]:       blockers.append(f"配置 {refs['placements']} 件")

        if blockers:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail=(
                    f"資材 {existing['code']} ({existing['item_name']}) は "
                    f"参照されているため削除できません: {' / '.join(blockers)}。"
                    "先に各参照を削除してください。"
                ),
            )

        await cur.execute("DELETE FROM materials WHERE id = %s", (material_id,))

    await write_audit(db, "MATERIAL_DELETE", "materials", str(material_id),
                      {"code": existing["code"], "item_name": existing["item_name"]},
                      admin["id"], request)


# =============================================================================
# 棚卸 (counts) CRUD
# =============================================================================

@router.get("/counts", response_model=list[MaterialCountOut])
async def list_counts(
    db: DB, user: CurrentUser,
    material_id: int | None = Query(None),
    object_id:   int | None = Query(None),
    date_from:   date | None = Query(None),
    date_to:     date | None = Query(None),
    layout_id:   int | None = Query(None,
        description="このレイアウト内 (objects 経由) の棚卸だけ"),
    limit:       int = Query(200, ge=1, le=2000),
):
    """棚卸履歴。フィルタで絞り込み可能。"""
    conds: list[str] = ["1=1"]
    params: list = []
    if material_id is not None:
        params.append(material_id); conds.append("c.material_id = %s")
    if object_id is not None:
        params.append(object_id); conds.append("c.object_id = %s")
    if date_from is not None:
        params.append(date_from); conds.append("c.count_date >= %s")
    if date_to is not None:
        params.append(date_to); conds.append("c.count_date <= %s")
    if layout_id is not None:
        params.append(layout_id)
        conds.append("c.object_id IN (SELECT id FROM storage_objects WHERE layout_id = %s)")
    params.append(limit)
    async with db.cursor() as cur:
        await cur.execute(f"""
            SELECT c.id, c.material_id, c.object_id, c.count_date, c.counted_qty,
                   c.source, c.note, c.confirmed_at,
                   m.code AS material_code, m.item_name AS material_name,
                   o.label AS object_label,
                   u.display_name AS confirmed_by_name
            FROM material_counts c
            JOIN materials m ON m.id = c.material_id
            LEFT JOIN storage_objects o ON o.id = c.object_id
            LEFT JOIN users u ON u.id = c.confirmed_by
            WHERE {' AND '.join(conds)}
            ORDER BY c.count_date DESC, c.id DESC
            LIMIT %s
        """, params)
        return [MaterialCountOut(**r) for r in await cur.fetchall()]


@router.post("/counts", status_code=status.HTTP_201_CREATED,
             response_model=MaterialCountOut)
async def create_count(body: MaterialCountCreate, db: DB,
                       user: OperatorUser, request: Request):
    """
    棚卸を記録する。同 (material_id, count_date, object_id) の重複は
    body.overwrite=true なら既存を削除して上書き、false なら 409。
    """
    async with db.cursor() as cur:
        # 重複チェック
        await cur.execute("""
            SELECT id FROM material_counts
            WHERE material_id = %s AND count_date = %s
              AND COALESCE(object_id, 0) = COALESCE(%s, 0)
        """, (body.material_id, body.count_date, body.object_id))
        existing = await cur.fetchone()
        if existing:
            if not body.overwrite:
                raise HTTPException(status.HTTP_409_CONFLICT, detail={
                    "error": "duplicate",
                    "message": "同日同場所の棚卸が既に存在します。"
                               "上書きする場合は overwrite=true を指定してください",
                    "existing_id": existing["id"],
                })
            await cur.execute("DELETE FROM material_counts WHERE id = %s",
                              (existing["id"],))

        # period (YYYY-MM) を count_date から導出 (旧仕様互換)
        period = body.count_date.strftime("%Y-%m")
        await cur.execute("""
            INSERT INTO material_counts
                (material_id, period, count_date, counted_qty,
                 object_id, source, note, confirmed_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id, material_id, object_id, count_date, counted_qty,
                      source, note, confirmed_at
        """, (body.material_id, period, body.count_date, body.counted_qty,
              body.object_id,
              'layout' if body.object_id is not None else 'physical_count',
              body.note, user["id"]))
        row = dict(await cur.fetchone())

        # join 用の表示属性を補完
        await cur.execute(
            "SELECT code, item_name FROM materials WHERE id = %s",
            (body.material_id,))
        m = await cur.fetchone()
        row["material_code"] = m["code"]; row["material_name"] = m["item_name"]
        if body.object_id is not None:
            await cur.execute("SELECT label FROM storage_objects WHERE id = %s",
                              (body.object_id,))
            o = await cur.fetchone()
            row["object_label"] = o["label"] if o else None
        else:
            row["object_label"] = None
        row["confirmed_by_name"] = user["display_name"]

    await write_audit(db, "MATERIAL_COUNT_CREATE", "material_counts",
                      str(row["id"]),
                      {"material_id": body.material_id,
                       "object_id": body.object_id,
                       "date": str(body.count_date),
                       "qty": float(body.counted_qty)},
                      user["id"], request)
    return MaterialCountOut(**row)


@router.delete("/counts/{count_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_count(count_id: int, db: DB,
                       admin: AdminUser, request: Request):
    """棚卸を削除 (管理者のみ、誤入力の取消想定)。"""
    async with db.cursor() as cur:
        await cur.execute(
            "DELETE FROM material_counts WHERE id = %s RETURNING material_id",
            (count_id,))
        r = await cur.fetchone()
        if not r:
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                detail="棚卸レコードが見つかりません")
    await write_audit(db, "MATERIAL_COUNT_DELETE", "material_counts",
                      str(count_id),
                      {"material_id": r["material_id"]},
                      admin["id"], request)


@router.get("/{material_id}/counts/check-duplicate")
async def check_duplicate_count(
    material_id: int, db: DB, user: CurrentUser,
    count_date: date = Query(...),
    object_id: int | None = Query(None),
):
    """指定日に同 (material, object) の棚卸が既にあるか確認する (UI 警告用)。"""
    async with db.cursor() as cur:
        await cur.execute("""
            SELECT id, counted_qty, source, confirmed_at
            FROM material_counts
            WHERE material_id = %s AND count_date = %s
              AND COALESCE(object_id, 0) = COALESCE(%s, 0)
        """, (material_id, count_date, object_id))
        r = await cur.fetchone()
    return {"exists": r is not None, "existing": dict(r) if r else None}
