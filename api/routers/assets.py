"""
api/routers/assets.py
======================
資産管理 (コンテナ・パレット・スチール) ドメイン の REST API。
mig 071 で 追加した 8 テーブル を 操作する。

エンドポイント:
  GET    /assets/types
  GET    /assets/logos?asset_type_id=X
  POST   /assets/logos                      (新規 logo)
  GET    /assets/categories?asset_type_id=X
  GET    /assets/counterparties?kind=...
  POST   /assets/counterparties             (新規 取引先)

  GET    /assets/holdings?asset_type_id=X   理論値 一覧 (logo×category)
  GET    /assets/movements?asset_type_id=X&date_from=...&date_to=...
  POST   /assets/movements
  PATCH  /assets/movements/{id}
  DELETE /assets/movements/{id}

  GET    /assets/loans/open?asset_type_id=X 進行中 貸出 一覧
  POST   /assets/loans/{id}/return          返却

  GET    /assets/stocktakes?asset_type_id=X
  POST   /assets/stocktakes                 棚卸 (理論値 自動 snapshot)
  DELETE /assets/stocktakes/{id}
"""
from __future__ import annotations

import logging
from datetime import date
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from api.audit import write_audit
from api.auth import CurrentUser, OperatorUser
from api.dependencies import DB

router = APIRouter(prefix="/assets", tags=["資産管理"])
logger = logging.getLogger(__name__)


# =============================================================================
# Pydantic models
# =============================================================================

class AssetType(BaseModel):
    id: int
    code: str
    name: str
    sort_order: int


class AssetLogo(BaseModel):
    id: int
    asset_type_id: int
    name: str
    sort_order: int
    is_active: bool


class AssetCategory(BaseModel):
    id: int
    asset_type_id: int
    name: str
    is_default: bool
    sort_order: int


class Counterparty(BaseModel):
    id: int
    code: str | None
    name: str
    kind: str
    sort_order: int
    is_active: bool


class HoldingRow(BaseModel):
    asset_type_id:  int
    asset_type_name: str
    logo_id:        int
    logo_name:      str
    category_id:    int
    category_name:  str
    base_date:      date | None
    base_qty:       int        # 最新棚卸の値、 なければ 0
    movements_since: int       # 棚卸日以降の純増減
    theoretical_qty: int       # base + movements_since
    lent_out_qty:   int        # 現在 貸出中 (asset_loans 累計、 確認用)
    # M2 2026-05 追加 — 推測借入計算 用
    total_purchased: int       # 累計購入数 (asset_purchase_records 合計)
    estimated_borrow_diff: int # 理論在庫 − 累計購入数 (+ = 借入超過、 - = 貸出/紛失)


class Movement(BaseModel):
    id: int
    asset_type_id: int
    logo_id: int
    category_id: int
    movement_date: date
    kind: str
    qty: int
    counterparty_id: int | None
    counterparty_name: str | None
    division_code: int | None
    loan_id: int | None
    note: str | None
    created_at: str


class MovementCreate(BaseModel):
    asset_type_id: int
    logo_id: int
    category_id: int
    movement_date: date
    kind: Literal['stocktake', 'loan_out', 'loan_in', 'in', 'out', 'adjust']
    qty: int = Field(..., gt=0)
    counterparty_id: int | None = None
    division_code: int | None = Field(default=None, ge=1, le=5)
    note: str | None = None
    # loan_in 時に 既存 loan を 明示返却 する場合
    return_loan_id: int | None = None


class LoanOpen(BaseModel):
    id: int
    asset_type_id: int
    logo_id: int
    logo_name: str
    category_id: int
    category_name: str
    counterparty_id: int
    counterparty_name: str
    division_code: int | None
    qty: int
    lent_at: date
    days_lent: int
    note: str | None


class ReturnRequest(BaseModel):
    return_date: date
    note: str | None = None


class Stocktake(BaseModel):
    id: int
    asset_type_id: int
    logo_id: int
    logo_name: str
    category_id: int
    category_name: str
    count_date: date
    counted_qty: int
    theoretical_qty: int | None
    variance: int | None
    variance_note: str | None
    created_at: str


class StocktakeCreate(BaseModel):
    asset_type_id: int
    logo_id: int
    category_id: int
    count_date: date
    counted_qty: int = Field(..., ge=0)
    variance_note: str | None = None


class LogoCreate(BaseModel):
    asset_type_id: int
    name: str = Field(..., min_length=1)
    sort_order: int = 99


class CounterpartyCreate(BaseModel):
    name: str = Field(..., min_length=1)
    kind: Literal['external_factory', 'vendor'] = 'vendor'
    sort_order: int = 99


# =============================================================================
# Master GETs
# =============================================================================

@router.get("/types", response_model=list[AssetType])
async def list_types(conn: DB, user: CurrentUser):
    cur = await conn.execute(
        "SELECT id, code, name, sort_order FROM asset_types "
        "WHERE is_active ORDER BY sort_order, id")
    return [AssetType(**r) for r in await cur.fetchall()]


@router.get("/logos", response_model=list[AssetLogo])
async def list_logos(conn: DB, user: CurrentUser,
                     asset_type_id: int | None = Query(None)):
    where = ["is_active"]
    params: list = []
    if asset_type_id is not None:
        where.append("asset_type_id = %s")
        params.append(asset_type_id)
    cur = await conn.execute(
        f"SELECT id, asset_type_id, name, sort_order, is_active "
        f"FROM asset_logos WHERE {' AND '.join(where)} "
        f"ORDER BY asset_type_id, sort_order, name",
        tuple(params) if params else None)
    return [AssetLogo(**r) for r in await cur.fetchall()]


@router.post("/logos", response_model=AssetLogo,
             status_code=status.HTTP_201_CREATED)
async def create_logo(body: LogoCreate, conn: DB, user: OperatorUser):
    cur = await conn.execute(
        "INSERT INTO asset_logos (asset_type_id, name, sort_order) "
        "VALUES (%s, %s, %s) "
        "ON CONFLICT (asset_type_id, name) DO NOTHING "
        "RETURNING id, asset_type_id, name, sort_order, is_active",
        (body.asset_type_id, body.name.strip(), body.sort_order))
    row = await cur.fetchone()
    if not row:
        raise HTTPException(409, "同 (種別, 名前) の ロゴ が 既存")
    return AssetLogo(**row)


@router.get("/categories", response_model=list[AssetCategory])
async def list_categories(conn: DB, user: CurrentUser,
                          asset_type_id: int | None = Query(None)):
    where = ["is_active"]
    params: list = []
    if asset_type_id is not None:
        where.append("asset_type_id = %s")
        params.append(asset_type_id)
    cur = await conn.execute(
        f"SELECT id, asset_type_id, name, is_default, sort_order "
        f"FROM asset_categories WHERE {' AND '.join(where)} "
        f"ORDER BY asset_type_id, sort_order",
        tuple(params) if params else None)
    return [AssetCategory(**r) for r in await cur.fetchall()]


@router.get("/counterparties", response_model=list[Counterparty])
async def list_counterparties(conn: DB, user: CurrentUser,
                              kind: str | None = Query(None)):
    where = ["is_active"]
    params: list = []
    if kind:
        where.append("kind = %s")
        params.append(kind)
    cur = await conn.execute(
        f"SELECT id, code, name, kind, sort_order, is_active "
        f"FROM counterparties WHERE {' AND '.join(where)} "
        f"ORDER BY sort_order, name",
        tuple(params) if params else None)
    return [Counterparty(**r) for r in await cur.fetchall()]


@router.post("/counterparties", response_model=Counterparty,
             status_code=status.HTTP_201_CREATED)
async def create_counterparty(body: CounterpartyCreate, conn: DB, user: OperatorUser):
    cur = await conn.execute(
        "INSERT INTO counterparties (name, kind, sort_order) "
        "VALUES (%s, %s, %s) "
        "ON CONFLICT (name) DO NOTHING "
        "RETURNING id, code, name, kind, sort_order, is_active",
        (body.name.strip(), body.kind, body.sort_order))
    row = await cur.fetchone()
    if not row:
        raise HTTPException(409, "同名 の 取引先 が 既存")
    return Counterparty(**row)


# =============================================================================
# Holdings (理論値) — 1 クエリで logo×category 単位 集計
# =============================================================================

@router.get("/holdings", response_model=list[HoldingRow])
async def list_holdings(conn: DB, user: CurrentUser,
                         asset_type_id: int | None = Query(None)):
    """各 (種別, ロゴ, 規格) の 理論値 = 最新棚卸 + 以降の movements 純増減。"""
    type_filter = ""
    params: list = []
    if asset_type_id is not None:
        type_filter = "WHERE t.id = %s"
        params.append(asset_type_id)

    cur = await conn.execute(f"""
        WITH key_universe AS (
            SELECT t.id AS asset_type_id, t.sort_order AS t_sort, t.name AS t_name,
                   l.id AS logo_id, l.sort_order AS l_sort, l.name AS l_name,
                   c.id AS category_id, c.sort_order AS c_sort, c.name AS c_name
            FROM asset_types t
            JOIN asset_logos l ON l.asset_type_id = t.id AND l.is_active
            JOIN asset_categories c ON c.asset_type_id = t.id AND c.is_active
            {type_filter.replace('WHERE', 'WHERE t.is_active AND' if type_filter else 'WHERE t.is_active')}
        ),
        latest_stocktake AS (
            SELECT DISTINCT ON (asset_type_id, logo_id, category_id)
                asset_type_id, logo_id, category_id, count_date, counted_qty
            FROM asset_stocktakes
            ORDER BY asset_type_id, logo_id, category_id, count_date DESC, id DESC
        ),
        movements_after AS (
            SELECT ku.asset_type_id, ku.logo_id, ku.category_id,
                   COALESCE(SUM(CASE
                       WHEN m.kind IN ('in', 'loan_in', 'adjust') THEN m.qty
                       WHEN m.kind IN ('out', 'loan_out') THEN -m.qty
                       ELSE 0
                   END), 0)::INT AS net_qty
            FROM key_universe ku
            LEFT JOIN latest_stocktake ls
              ON ls.asset_type_id = ku.asset_type_id
             AND ls.logo_id = ku.logo_id
             AND ls.category_id = ku.category_id
            LEFT JOIN asset_movements m
              ON m.asset_type_id = ku.asset_type_id
             AND m.logo_id = ku.logo_id
             AND m.category_id = ku.category_id
             AND m.kind <> 'stocktake'
             AND m.movement_date > COALESCE(ls.count_date, '1900-01-01'::date)
            GROUP BY ku.asset_type_id, ku.logo_id, ku.category_id
        ),
        open_loans AS (
            SELECT asset_type_id, logo_id, category_id,
                   COALESCE(SUM(qty), 0)::INT AS qty
            FROM asset_loans WHERE returned_at IS NULL
            GROUP BY asset_type_id, logo_id, category_id
        ),
        purchases_total AS (
            SELECT asset_type_id, logo_id, category_id,
                   COALESCE(SUM(qty), 0)::INT AS total_qty
            FROM asset_purchase_records
            GROUP BY asset_type_id, logo_id, category_id
        )
        SELECT
            ku.asset_type_id, ku.t_name AS asset_type_name,
            ku.logo_id, ku.l_name AS logo_name,
            ku.category_id, ku.c_name AS category_name,
            ls.count_date AS base_date,
            COALESCE(ls.counted_qty, 0)::INT AS base_qty,
            ma.net_qty AS movements_since,
            (COALESCE(ls.counted_qty, 0) + ma.net_qty)::INT AS theoretical_qty,
            COALESCE(ol.qty, 0)::INT AS lent_out_qty,
            COALESCE(pt.total_qty, 0)::INT AS total_purchased,
            ((COALESCE(ls.counted_qty, 0) + ma.net_qty)
              - COALESCE(pt.total_qty, 0))::INT AS estimated_borrow_diff
        FROM key_universe ku
        LEFT JOIN latest_stocktake ls
          ON ls.asset_type_id=ku.asset_type_id
         AND ls.logo_id=ku.logo_id
         AND ls.category_id=ku.category_id
        LEFT JOIN movements_after ma
          ON ma.asset_type_id=ku.asset_type_id
         AND ma.logo_id=ku.logo_id
         AND ma.category_id=ku.category_id
        LEFT JOIN open_loans ol
          ON ol.asset_type_id=ku.asset_type_id
         AND ol.logo_id=ku.logo_id
         AND ol.category_id=ku.category_id
        LEFT JOIN purchases_total pt
          ON pt.asset_type_id=ku.asset_type_id
         AND pt.logo_id=ku.logo_id
         AND pt.category_id=ku.category_id
        ORDER BY ku.t_sort, ku.l_sort, ku.c_sort
    """, tuple(params) if params else None)
    return [HoldingRow(**r) for r in await cur.fetchall()]


# =============================================================================
# Movements
# =============================================================================

@router.get("/movements", response_model=list[Movement])
async def list_movements(
    conn: DB, user: CurrentUser,
    asset_type_id: int | None = Query(None),
    date_from: date | None = Query(None),
    date_to:   date | None = Query(None),
    kind:      str | None = Query(None),
    limit:     int = Query(500, ge=1, le=2000),
):
    where = ["1=1"]
    params: list = []
    if asset_type_id is not None:
        where.append("m.asset_type_id = %s"); params.append(asset_type_id)
    if date_from:
        where.append("m.movement_date >= %s"); params.append(date_from)
    if date_to:
        where.append("m.movement_date <= %s"); params.append(date_to)
    if kind:
        where.append("m.kind = %s"); params.append(kind)
    params.append(limit)
    cur = await conn.execute(f"""
        SELECT m.id, m.asset_type_id, m.logo_id, m.category_id,
               m.movement_date, m.kind, m.qty,
               m.counterparty_id, cp.name AS counterparty_name,
               m.division_code, m.loan_id, m.note,
               m.created_at::TEXT AS created_at
        FROM asset_movements m
        LEFT JOIN counterparties cp ON cp.id = m.counterparty_id
        WHERE {' AND '.join(where)}
        ORDER BY m.movement_date DESC, m.id DESC
        LIMIT %s
    """, tuple(params))
    return [Movement(**r) for r in await cur.fetchall()]


@router.post("/movements", response_model=Movement,
             status_code=status.HTTP_201_CREATED)
async def create_movement(body: MovementCreate, request: Request,
                          conn: DB, user: OperatorUser):
    # loan_in 系の バリデーション
    if body.kind in ('loan_out', 'loan_in') and body.counterparty_id is None:
        raise HTTPException(422, f"kind={body.kind} は counterparty_id 必須")

    async with conn.transaction():
        cur = await conn.execute("""
            INSERT INTO asset_movements
                (asset_type_id, logo_id, category_id, movement_date,
                 kind, qty, counterparty_id, division_code, note, created_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id, asset_type_id, logo_id, category_id, movement_date,
                      kind, qty, counterparty_id, division_code, loan_id, note,
                      created_at::TEXT AS created_at
        """, (body.asset_type_id, body.logo_id, body.category_id,
              body.movement_date, body.kind, body.qty,
              body.counterparty_id, body.division_code, body.note, user["id"]))
        mov = await cur.fetchone()

        # loan_out → asset_loans 同時 INSERT
        if body.kind == 'loan_out':
            await conn.execute("""
                INSERT INTO asset_loans
                    (asset_type_id, logo_id, category_id, counterparty_id,
                     division_code, qty, lent_at, out_movement_id, note, created_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """, (body.asset_type_id, body.logo_id, body.category_id,
                  body.counterparty_id, body.division_code, body.qty,
                  body.movement_date, mov["id"], body.note, user["id"]))

        # loan_in → 既存 loan を 返却紐付
        elif body.kind == 'loan_in':
            target_loan_id = body.return_loan_id
            if target_loan_id is None:
                # 直近 未返却 loan を 自動選択
                lcur = await conn.execute("""
                    SELECT id FROM asset_loans
                    WHERE asset_type_id=%s AND logo_id=%s AND counterparty_id=%s
                      AND returned_at IS NULL
                    ORDER BY lent_at ASC LIMIT 1
                """, (body.asset_type_id, body.logo_id, body.counterparty_id))
                lrow = await lcur.fetchone()
                target_loan_id = lrow["id"] if lrow else None
            if target_loan_id is not None:
                await conn.execute("""
                    UPDATE asset_loans
                    SET returned_at=%s, return_movement_id=%s
                    WHERE id=%s
                """, (body.movement_date, mov["id"], target_loan_id))
                await conn.execute(
                    "UPDATE asset_movements SET loan_id=%s WHERE id=%s",
                    (target_loan_id, mov["id"]))
                mov["loan_id"] = target_loan_id

        # counterparty_name 補完
        cp_name = None
        if mov["counterparty_id"]:
            cpcur = await conn.execute(
                "SELECT name FROM counterparties WHERE id=%s",
                (mov["counterparty_id"],))
            cp = await cpcur.fetchone()
            cp_name = cp["name"] if cp else None
        mov["counterparty_name"] = cp_name

    await write_audit(conn, "ASSET_MOVEMENT_CREATE", "asset_movements",
                      str(mov["id"]), body.model_dump(mode='json'),
                      user["id"], request)
    return Movement(**mov)


@router.delete("/movements/{movement_id}",
               status_code=status.HTTP_204_NO_CONTENT)
async def delete_movement(movement_id: int, request: Request,
                          conn: DB, user: OperatorUser):
    """movement 削除。 loan_out なら 関連 loan も 削除 (= 一括取消)。"""
    async with conn.transaction():
        # 紐づく loan を 削除
        await conn.execute(
            "DELETE FROM asset_loans WHERE out_movement_id=%s OR return_movement_id=%s",
            (movement_id, movement_id))
        cur = await conn.execute(
            "DELETE FROM asset_movements WHERE id=%s RETURNING id", (movement_id,))
        if not await cur.fetchone():
            raise HTTPException(404, "movement が ありません")
    await write_audit(conn, "ASSET_MOVEMENT_DELETE", "asset_movements",
                      str(movement_id), {}, user["id"], request)


# =============================================================================
# Loans (進行中 / 返却)
# =============================================================================

@router.get("/loans/open", response_model=list[LoanOpen])
async def list_open_loans(conn: DB, user: CurrentUser,
                           asset_type_id: int | None = Query(None)):
    where = ["l.returned_at IS NULL"]
    params: list = []
    if asset_type_id is not None:
        where.append("l.asset_type_id = %s"); params.append(asset_type_id)
    cur = await conn.execute(f"""
        SELECT l.id, l.asset_type_id, l.logo_id, lg.name AS logo_name,
               l.category_id, c.name AS category_name,
               l.counterparty_id, cp.name AS counterparty_name,
               l.division_code, l.qty, l.lent_at,
               (CURRENT_DATE - l.lent_at)::INT AS days_lent,
               l.note
        FROM asset_loans l
        JOIN asset_logos lg ON lg.id = l.logo_id
        JOIN asset_categories c ON c.id = l.category_id
        JOIN counterparties cp ON cp.id = l.counterparty_id
        WHERE {' AND '.join(where)}
        ORDER BY l.lent_at, l.id
    """, tuple(params) if params else None)
    return [LoanOpen(**r) for r in await cur.fetchall()]


@router.post("/loans/{loan_id}/return")
async def return_loan(loan_id: int, body: ReturnRequest, request: Request,
                      conn: DB, user: OperatorUser):
    """貸出 を 返却 する (= loan_in movement を 作成 + loan に returned_at)。"""
    async with conn.transaction():
        cur = await conn.execute(
            "SELECT * FROM asset_loans WHERE id=%s AND returned_at IS NULL",
            (loan_id,))
        loan = await cur.fetchone()
        if not loan:
            raise HTTPException(404, "貸出が見つからない or 既に返却済")

        # loan_in movement
        mcur = await conn.execute("""
            INSERT INTO asset_movements
                (asset_type_id, logo_id, category_id, movement_date, kind, qty,
                 counterparty_id, division_code, loan_id, note, created_by)
            VALUES (%s, %s, %s, %s, 'loan_in', %s, %s, %s, %s, %s, %s)
            RETURNING id
        """, (loan["asset_type_id"], loan["logo_id"], loan["category_id"],
              body.return_date, loan["qty"], loan["counterparty_id"],
              loan["division_code"], loan_id, body.note, user["id"]))
        mov_id = (await mcur.fetchone())["id"]

        await conn.execute(
            "UPDATE asset_loans SET returned_at=%s, return_movement_id=%s "
            "WHERE id=%s",
            (body.return_date, mov_id, loan_id))

    await write_audit(conn, "ASSET_LOAN_RETURN", "asset_loans",
                      str(loan_id), body.model_dump(mode='json'),
                      user["id"], request)
    return {"loan_id": loan_id, "return_movement_id": mov_id,
            "returned_at": body.return_date.isoformat()}


# =============================================================================
# Stocktakes
# =============================================================================

@router.get("/stocktakes", response_model=list[Stocktake])
async def list_stocktakes(conn: DB, user: CurrentUser,
                           asset_type_id: int | None = Query(None),
                           limit: int = Query(200, ge=1, le=1000)):
    where = ["1=1"]
    params: list = []
    if asset_type_id is not None:
        where.append("s.asset_type_id = %s"); params.append(asset_type_id)
    params.append(limit)
    cur = await conn.execute(f"""
        SELECT s.id, s.asset_type_id, s.logo_id, lg.name AS logo_name,
               s.category_id, c.name AS category_name,
               s.count_date, s.counted_qty, s.theoretical_qty, s.variance,
               s.variance_note,
               s.created_at::TEXT AS created_at
        FROM asset_stocktakes s
        JOIN asset_logos lg      ON lg.id = s.logo_id
        JOIN asset_categories c  ON c.id = s.category_id
        WHERE {' AND '.join(where)}
        ORDER BY s.count_date DESC, s.id DESC
        LIMIT %s
    """, tuple(params))
    return [Stocktake(**r) for r in await cur.fetchall()]


@router.post("/stocktakes", response_model=Stocktake,
             status_code=status.HTTP_201_CREATED)
async def create_stocktake(body: StocktakeCreate, request: Request,
                            conn: DB, user: OperatorUser):
    """棚卸登録。 同 (種別, ロゴ, 規格, 日付) が あれば 上書き。
       theoretical_qty を 自動 snapshot (= その時点の 理論値)。"""
    async with conn.transaction():
        # theoretical_qty を 算出 (count_date 時点)
        tcur = await conn.execute("""
            WITH latest_st AS (
                SELECT count_date, counted_qty
                FROM asset_stocktakes
                WHERE asset_type_id=%s AND logo_id=%s AND category_id=%s
                  AND count_date < %s
                ORDER BY count_date DESC, id DESC LIMIT 1
            ),
            net_after AS (
                SELECT COALESCE(SUM(CASE
                    WHEN kind IN ('in', 'loan_in', 'adjust') THEN qty
                    WHEN kind IN ('out', 'loan_out') THEN -qty
                    ELSE 0
                END), 0)::INT AS net_qty
                FROM asset_movements
                WHERE asset_type_id=%s AND logo_id=%s AND category_id=%s
                  AND kind <> 'stocktake'
                  AND movement_date > COALESCE((SELECT count_date FROM latest_st), '1900-01-01'::date)
                  AND movement_date <= %s
            )
            SELECT (COALESCE((SELECT counted_qty FROM latest_st), 0)
                    + (SELECT net_qty FROM net_after))::INT AS theory
        """, (body.asset_type_id, body.logo_id, body.category_id, body.count_date,
              body.asset_type_id, body.logo_id, body.category_id, body.count_date))
        theoretical = (await tcur.fetchone())["theory"]

        # 上書き or INSERT
        await conn.execute("""
            DELETE FROM asset_stocktakes
            WHERE asset_type_id=%s AND logo_id=%s AND category_id=%s
              AND count_date=%s
        """, (body.asset_type_id, body.logo_id, body.category_id, body.count_date))

        cur = await conn.execute("""
            INSERT INTO asset_stocktakes
                (asset_type_id, logo_id, category_id, count_date, counted_qty,
                 theoretical_qty, variance_note, created_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
        """, (body.asset_type_id, body.logo_id, body.category_id, body.count_date,
              body.counted_qty, theoretical, body.variance_note, user["id"]))
        sid = (await cur.fetchone())["id"]

        # 表示用 join
        rcur = await conn.execute("""
            SELECT s.id, s.asset_type_id, s.logo_id, lg.name AS logo_name,
                   s.category_id, c.name AS category_name,
                   s.count_date, s.counted_qty, s.theoretical_qty, s.variance,
                   s.variance_note, s.created_at::TEXT AS created_at
            FROM asset_stocktakes s
            JOIN asset_logos lg     ON lg.id = s.logo_id
            JOIN asset_categories c ON c.id = s.category_id
            WHERE s.id = %s
        """, (sid,))
        row = await rcur.fetchone()

    await write_audit(conn, "ASSET_STOCKTAKE_CREATE", "asset_stocktakes",
                      str(sid), body.model_dump(mode='json'), user["id"], request)
    return Stocktake(**row)


@router.delete("/stocktakes/{stocktake_id}",
               status_code=status.HTTP_204_NO_CONTENT)
async def delete_stocktake(stocktake_id: int, request: Request,
                            conn: DB, user: OperatorUser):
    cur = await conn.execute(
        "DELETE FROM asset_stocktakes WHERE id=%s RETURNING id", (stocktake_id,))
    if not await cur.fetchone():
        raise HTTPException(404, "棚卸が ありません")
    await write_audit(conn, "ASSET_STOCKTAKE_DELETE", "asset_stocktakes",
                      str(stocktake_id), {}, user["id"], request)
