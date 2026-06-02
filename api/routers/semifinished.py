"""
api/routers/semifinished.py
============================
半製品台帳 API (拡張#2)。

半製品 = 出庫後に使い切れず手元に戻ってきた在庫。元の outbound_records から
1:1 で生まれ、独自に出庫履歴を持つ独立した在庫レコード。

エンドポイント:
  GET  /semifinished/lots                  - 半製品ロット一覧 (作物別フィルタ可)
  GET  /semifinished/lots/{id}             - 半製品ロット詳細
  GET  /semifinished/source-outbounds      - 半製品ソース候補 (まだ半製品化されてない出庫)
  POST /semifinished/lots                  - 出庫レコードから半製品を新規作成
  PATCH /semifinished/lots/{id}            - 半製品の編集 (数量・単価・備考)
  DELETE /semifinished/lots/{id}           - 半製品の削除 (出庫履歴があれば 409)
  POST /semifinished/lots/{id}/archive     - アーカイブ (動きの無いロットを一覧から外す)
  POST /semifinished/lots/{id}/unarchive   - アーカイブ解除
  POST /semifinished/outbound              - 半製品から出庫を記録
  GET  /semifinished/outbound              - 半製品の出庫履歴一覧
  DELETE /semifinished/outbound/{id}       - 出庫記録の取消
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from api.audit import write_audit
from api.auth import AdminUser, CurrentUser, OperatorUser
from api.dependencies import DB

router = APIRouter(prefix="/semifinished", tags=["半製品"])


# =============================================================================
# モデル
# =============================================================================

SemifinishedStatus = str  # 'pending' | 'sorting' | 'soaking' | 'washing'


class SemifinishedStockOut(BaseModel):
    lot_id:               int
    code:                 str
    source_outbound_id:   int
    product_id:           int
    crop_id:              int
    crop_code:            str
    crop_name:            str
    grade_id:             int
    spec_type:            str
    grade_level:          str
    size_label:           str
    size_mm:              int | None = None
    origin_id:            int
    origin_name:          str
    status:               SemifinishedStatus = 'pending'
    # 元ロット情報
    source_lot_id:        int
    source_lot_code:      str
    source_outbound_date: date
    source_outbound_note: str | None = None
    source_outbound_kg:   Decimal | None = None
    # 入庫
    inbound_date:         date
    base_cases:           Decimal
    kg_per_case:          Decimal
    base_kg:              Decimal
    unit_price:           Decimal | None = None
    price_confirmed_at:   str | None = None
    # 出庫累積
    consumed_kg:          Decimal
    remaining_kg:         Decimal
    stock_value:          Decimal | None = None
    # メタ
    note:                 str | None = None
    archived_at:          str | None = None
    archive_note:         str | None = None
    created_at:           str | None = None
    updated_at:           str | None = None


class SourceOutboundOut(BaseModel):
    """半製品ソース候補 = まだ半製品化されてない出庫"""
    outbound_id:      int
    outbound_date:    date
    quantity_kg:      Decimal
    note:             str | None = None
    # 元ロット情報
    lot_id:           int
    lot_code:         str
    product_id:       int
    spec_type:        str
    grade_level:      str
    size_label:       str
    origin_name:      str
    supplier_name:    str
    crop_id:          int
    crop_name:        str
    lot_unit_price:   Decimal | None = None


class SemifinishedCreateRequest(BaseModel):
    """半製品を新規登録。 元の出庫から派生。
    cases × kg_per_case = total_kg を満たすこと。
    total_kg <= source_outbound.quantity_kg であること (アプリ層で検証)。"""
    source_outbound_id: int
    inbound_date:       date
    cases:              Decimal = Field(..., gt=0)
    kg_per_case:        Decimal = Field(..., gt=0)
    total_kg:           Decimal = Field(..., gt=0)
    unit_price:         Decimal | None = None    # NULL = 元ロット単価を継承
    # 規格再格付けする場合のみ指定 (省略時は元ロットの product_id を継承)
    product_id:         int | None = None
    note:               str | None = None


class SemifinishedPatchRequest(BaseModel):
    """半製品の部分更新 (出庫履歴があれば total_kg は制限あり)。
    新仕様: 処理状態 (status) もここで更新可能。"""
    inbound_date: date | None    = None
    cases:        Decimal | None = Field(None, gt=0)
    kg_per_case:  Decimal | None = Field(None, gt=0)
    total_kg:     Decimal | None = Field(None, gt=0)
    unit_price:   Decimal | None = None
    note:         str | None     = None
    status:       str | None     = None  # 'pending'/'sorting'/'soaking'/'washing'


class SemifinishedOutboundCreateRequest(BaseModel):
    semifinished_lot_id: int
    outbound_date:       date
    quantity_kg:         Decimal = Field(..., gt=0)
    cases:               Decimal | None = None
    purpose:             str | None = None    # 'shipment' / 'selection' / 'disposal' / 'other'
    customer:            str | None = None
    note:                str | None = None


class SemifinishedOutboundOut(BaseModel):
    id:                  int
    semifinished_lot_id: int
    semifinished_code:   str | None = None
    outbound_date:       date
    quantity_kg:         Decimal
    cases:               Decimal | None = None
    purpose:             str | None = None
    customer:            str | None = None
    note:                str | None = None
    created_at:          str | None = None


# =============================================================================
# 一覧 / 詳細
# =============================================================================

@router.get("/lots", response_model=list[SemifinishedStockOut])
async def list_semifinished_lots(
    db: DB,
    user: CurrentUser,
    crop_id: int | None = Query(None, description="作物 ID フィルタ"),
    include_archived: bool = Query(False),
):
    """半製品ロット一覧。デフォルトは未アーカイブのみ。"""
    where = []
    params: list = []
    if crop_id is not None:
        where.append("crop_id = %s")
        params.append(crop_id)
    if not include_archived:
        where.append("archived_at IS NULL")
    sql = "SELECT * FROM semifinished_stock"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY inbound_date DESC, code DESC"
    async with db.cursor() as cur:
        await cur.execute(sql, params)
        rows = await cur.fetchall()
    return [SemifinishedStockOut(**_row_to_out(r)) for r in rows]


@router.get("/lots/{lot_id}", response_model=SemifinishedStockOut)
async def get_semifinished_lot(lot_id: int, db: DB, user: CurrentUser):
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT * FROM semifinished_stock WHERE lot_id = %s", (lot_id,))
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND,
                            detail=f"半製品ロット {lot_id} が見つかりません")
    return SemifinishedStockOut(**_row_to_out(row))


@router.get("/source-outbounds", response_model=list[SourceOutboundOut])
async def list_source_outbounds(
    db: DB,
    user: CurrentUser,
    crop_id: int | None = Query(None, description="作物 ID フィルタ"),
    days: int = Query(90, description="過去 N 日以内の出庫"),
):
    """半製品のソースになりうる出庫候補一覧。
    - まだ半製品化されてない (semifinished_lots に source_outbound_id として未登録)
    - purpose IS NULL or 'normal' (= 通常出庫のみ。 選別由来 selection は除外)
    - 過去 N 日以内
    """
    where_parts = [
        "ob.id NOT IN (SELECT source_outbound_id FROM semifinished_lots WHERE source_outbound_id IS NOT NULL)",
        "(ob.purpose IS NULL OR ob.purpose = 'normal')",
        "ob.outbound_date >= CURRENT_DATE - %s::int",
    ]
    params: list = [days]
    if crop_id is not None:
        where_parts.append("p.crop_id = %s")
        params.append(crop_id)
    sql = f"""
        SELECT
            ob.id           AS outbound_id,
            ob.outbound_date,
            ob.quantity_kg,
            ob.note,
            il.id           AS lot_id,
            il.code         AS lot_code,
            p.id            AS product_id,
            g.spec_type, g.grade_level, g.size_label,
            o.name          AS origin_name,
            s.name          AS supplier_name,
            p.crop_id,
            c.name          AS crop_name,
            il.unit_price   AS lot_unit_price
        FROM outbound_records ob
        JOIN inbound_lots il ON il.id = ob.lot_id
        JOIN products p ON p.id = il.product_id
        JOIN crops c    ON c.id = p.crop_id
        JOIN grades g   ON g.id = p.grade_id
        JOIN origins o  ON o.id = p.origin_id
        JOIN suppliers s ON s.id = il.supplier_id
        WHERE {' AND '.join(where_parts)}
        ORDER BY ob.outbound_date DESC, ob.id DESC
        LIMIT 200
    """
    async with db.cursor() as cur:
        await cur.execute(sql, params)
        rows = await cur.fetchall()
    return [SourceOutboundOut(**dict(r)) for r in rows]


# =============================================================================
# 半製品作成 / 更新 / 削除
# =============================================================================

EPS = Decimal('0.001')


@router.post("/lots", status_code=status.HTTP_201_CREATED,
             response_model=SemifinishedStockOut)
async def create_semifinished_lot(
    body: SemifinishedCreateRequest, db: DB,
    user: OperatorUser, request: Request,
):
    """出庫から半製品を作成 (1 出庫 = 1 半製品)。"""
    # 入力検証: cases × kg_per_case ≈ total_kg
    if abs(body.cases * body.kg_per_case - body.total_kg) > EPS:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"cases × kg_per_case ({body.cases}×{body.kg_per_case}) "
                   f"が total_kg ({body.total_kg}) と一致しません")

    async with db.cursor() as cur:
        # 元出庫を取得 + 検証
        await cur.execute("""
            SELECT ob.id, ob.lot_id, ob.quantity_kg, ob.selection_id, ob.purpose,
                   il.product_id, il.unit_price AS lot_unit_price,
                   p.crop_id, c.code AS crop_code
            FROM outbound_records ob
            JOIN inbound_lots il ON il.id = ob.lot_id
            JOIN products p ON p.id = il.product_id
            JOIN crops c    ON c.id = p.crop_id
            WHERE ob.id = %s
        """, (body.source_outbound_id,))
        src = await cur.fetchone()
        if not src:
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                detail=f"出庫レコード {body.source_outbound_id} が存在しません")
        if src["purpose"] == 'selection':
            raise HTTPException(status.HTTP_409_CONFLICT,
                                detail="選別出庫からは半製品を作れません")
        if body.total_kg > Decimal(str(src["quantity_kg"])) + EPS:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail=f"半製品 total_kg ({body.total_kg}kg) が"
                       f"元出庫 ({src['quantity_kg']}kg) を超えています")

        # 重複チェック (UNIQUE 制約があるが事前にわかりやすいエラーで)
        await cur.execute(
            "SELECT id, code FROM semifinished_lots WHERE source_outbound_id = %s",
            (body.source_outbound_id,))
        existing = await cur.fetchone()
        if existing:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail=f"出庫 {body.source_outbound_id} からは既に半製品 "
                       f"{existing['code']} が作成済みです")

        # product_id 解決 (未指定なら元ロット由来)
        product_id = body.product_id or src["product_id"]
        # 単価: 未指定なら元ロット単価を継承 (NULL の場合も NULL のまま継承)
        unit_price = body.unit_price if body.unit_price is not None else src["lot_unit_price"]

        # 採番
        await cur.execute("SELECT next_semifinished_code(%s) AS code",
                          (src["crop_code"],))
        code = (await cur.fetchone())["code"]

        # INSERT
        await cur.execute("""
            INSERT INTO semifinished_lots
              (code, source_outbound_id, product_id, inbound_date,
               cases, kg_per_case, total_kg, unit_price, note, created_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
        """, (code, body.source_outbound_id, product_id, body.inbound_date,
              body.cases, body.kg_per_case, body.total_kg, unit_price,
              body.note, user["id"]))
        new_id = (await cur.fetchone())["id"]

        # VIEW から再取得して返す
        await cur.execute(
            "SELECT * FROM semifinished_stock WHERE lot_id = %s", (new_id,))
        row = await cur.fetchone()

    await write_audit(db, "SEMIFINISHED_CREATE", "semifinished_lots",
                      str(new_id),
                      {"code": code, "source_outbound_id": body.source_outbound_id,
                       "total_kg": float(body.total_kg)},
                      user["id"], request)
    return SemifinishedStockOut(**_row_to_out(row))


@router.patch("/lots/{lot_id}", response_model=SemifinishedStockOut)
async def patch_semifinished_lot(
    lot_id: int, body: SemifinishedPatchRequest, db: DB,
    user: OperatorUser, request: Request,
):
    fields = body.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="更新するフィールドが指定されていません")

    async with db.cursor() as cur:
        # 既存取得
        await cur.execute(
            "SELECT * FROM semifinished_lots WHERE id = %s", (lot_id,))
        cur_row = await cur.fetchone()
        if not cur_row:
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                detail=f"半製品 {lot_id} が存在しません")
        if cur_row["archived_at"] is not None:
            raise HTTPException(status.HTTP_409_CONFLICT,
                                detail="アーカイブ済みの半製品は編集できません")

        # status のみ更新の場合は数量検証スキップ (UI から status トグル用)
        only_status = set(fields.keys()) == {"status"}

        if not only_status:
            # 出庫累計を取得
            await cur.execute(
                "SELECT COALESCE(SUM(quantity_kg), 0) AS s "
                "FROM semifinished_outbound_records WHERE semifinished_lot_id = %s",
                (lot_id,))
            consumed = Decimal(str((await cur.fetchone())["s"]))

            # 新 total_kg の検証 (出庫累計を下回ってはいけない)
            new_total = Decimal(str(fields.get("total_kg", cur_row["total_kg"])))
            if new_total + EPS < consumed:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    detail=f"total_kg ({new_total}kg) が既出庫累計 ({consumed}kg) を下回ります")

            # cases × kg_per_case ≈ total_kg を再検証 (3 つ全て指定された場合)
            new_cases = Decimal(str(fields.get("cases", cur_row["cases"])))
            new_kpc   = Decimal(str(fields.get("kg_per_case", cur_row["kg_per_case"])))
            if abs(new_cases * new_kpc - new_total) > EPS:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=f"cases × kg_per_case ({new_cases}×{new_kpc}) が "
                           f"total_kg ({new_total}) と一致しません")

        # UPDATE SQL 組み立て
        sets = []
        params: list = []
        for k, v in fields.items():
            sets.append(f"{k} = %s")
            params.append(v)
        sets.append("updated_at = now()")
        params.append(lot_id)
        await cur.execute(
            f"UPDATE semifinished_lots SET {', '.join(sets)} WHERE id = %s",
            params)

        # 返却
        await cur.execute(
            "SELECT * FROM semifinished_stock WHERE lot_id = %s", (lot_id,))
        row = await cur.fetchone()

    await write_audit(db, "SEMIFINISHED_PATCH", "semifinished_lots",
                      str(lot_id), {k: (float(v) if isinstance(v, Decimal) else str(v))
                                    for k, v in fields.items()},
                      user["id"], request)
    return SemifinishedStockOut(**_row_to_out(row))


@router.delete("/lots/{lot_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_semifinished_lot(
    lot_id: int, db: DB, admin: AdminUser, request: Request,
):
    """半製品を削除 (admin のみ)。出庫履歴があれば 409。"""
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT id, code FROM semifinished_lots WHERE id = %s", (lot_id,))
        cur_row = await cur.fetchone()
        if not cur_row:
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                detail=f"半製品 {lot_id} が存在しません")
        await cur.execute(
            "SELECT COUNT(*) AS c FROM semifinished_outbound_records "
            "WHERE semifinished_lot_id = %s", (lot_id,))
        if (await cur.fetchone())["c"] > 0:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail="出庫履歴があるため削除できません (先に出庫記録を取消してください)")
        await cur.execute("DELETE FROM semifinished_lots WHERE id = %s", (lot_id,))
    await write_audit(db, "SEMIFINISHED_DELETE", "semifinished_lots",
                      str(lot_id), {"code": cur_row["code"]}, admin["id"], request)


@router.post("/lots/{lot_id}/archive", response_model=SemifinishedStockOut)
async def archive_semifinished_lot(
    lot_id: int, db: DB, admin: AdminUser, request: Request,
    archive_note: str | None = Query(None),
):
    async with db.cursor() as cur:
        await cur.execute("""
            UPDATE semifinished_lots
            SET archived_at = now(), archived_by = %s,
                archive_note = %s, updated_at = now()
            WHERE id = %s AND archived_at IS NULL
        """, (admin["id"], archive_note, lot_id))
        if cur.rowcount == 0:
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                detail="該当 ID 無し、または既にアーカイブ済み")
        await cur.execute(
            "SELECT * FROM semifinished_stock WHERE lot_id = %s", (lot_id,))
        row = await cur.fetchone()
    await write_audit(db, "SEMIFINISHED_ARCHIVE", "semifinished_lots",
                      str(lot_id), {"note": archive_note}, admin["id"], request)
    return SemifinishedStockOut(**_row_to_out(row))


@router.post("/lots/{lot_id}/unarchive", response_model=SemifinishedStockOut)
async def unarchive_semifinished_lot(
    lot_id: int, db: DB, admin: AdminUser, request: Request,
):
    async with db.cursor() as cur:
        await cur.execute("""
            UPDATE semifinished_lots
            SET archived_at = NULL, archived_by = NULL, archive_note = NULL,
                updated_at = now()
            WHERE id = %s
        """, (lot_id,))
        if cur.rowcount == 0:
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                detail="該当 ID 無し")
        await cur.execute(
            "SELECT * FROM semifinished_stock WHERE lot_id = %s", (lot_id,))
        row = await cur.fetchone()
    await write_audit(db, "SEMIFINISHED_UNARCHIVE", "semifinished_lots",
                      str(lot_id), {}, admin["id"], request)
    return SemifinishedStockOut(**_row_to_out(row))


# =============================================================================
# 半製品の出庫
# =============================================================================

@router.post("/outbound", status_code=status.HTTP_201_CREATED,
             response_model=SemifinishedOutboundOut)
async def create_semifinished_outbound(
    body: SemifinishedOutboundCreateRequest, db: DB,
    user: OperatorUser, request: Request,
):
    """半製品からの出庫を記録。在庫不足は 409。"""
    async with db.cursor() as cur:
        # 半製品ロット取得 (残量チェック)
        await cur.execute("""
            SELECT sl.id, sl.code, sl.total_kg, sl.archived_at,
                   COALESCE(so.consumed, 0) AS consumed
            FROM semifinished_lots sl
            LEFT JOIN (
                SELECT semifinished_lot_id, SUM(quantity_kg) AS consumed
                FROM semifinished_outbound_records GROUP BY semifinished_lot_id
            ) so ON so.semifinished_lot_id = sl.id
            WHERE sl.id = %s
        """, (body.semifinished_lot_id,))
        lot = await cur.fetchone()
        if not lot:
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                detail=f"半製品 {body.semifinished_lot_id} が存在しません")
        if lot["archived_at"] is not None:
            raise HTTPException(status.HTTP_409_CONFLICT,
                                detail="アーカイブ済みの半製品からは出庫できません")
        remaining = Decimal(str(lot["total_kg"])) - Decimal(str(lot["consumed"]))
        if body.quantity_kg > remaining + EPS:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail=f"出庫量 ({body.quantity_kg}kg) が残量 ({remaining}kg) を超えます")

        # INSERT
        await cur.execute("""
            INSERT INTO semifinished_outbound_records
              (semifinished_lot_id, outbound_date, quantity_kg, cases,
               purpose, customer, note, created_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id, created_at
        """, (body.semifinished_lot_id, body.outbound_date, body.quantity_kg,
              body.cases, body.purpose, body.customer, body.note, user["id"]))
        new = await cur.fetchone()

    await write_audit(db, "SEMIFINISHED_OUTBOUND", "semifinished_outbound_records",
                      str(new["id"]),
                      {"semifinished_lot_id": body.semifinished_lot_id,
                       "quantity_kg": float(body.quantity_kg),
                       "date": str(body.outbound_date)},
                      user["id"], request)
    return SemifinishedOutboundOut(
        id=new["id"],
        semifinished_lot_id=body.semifinished_lot_id,
        semifinished_code=lot["code"],
        outbound_date=body.outbound_date,
        quantity_kg=body.quantity_kg,
        cases=body.cases,
        purpose=body.purpose,
        customer=body.customer,
        note=body.note,
        created_at=str(new["created_at"]) if new.get("created_at") else None,
    )


@router.get("/outbound", response_model=list[SemifinishedOutboundOut])
async def list_semifinished_outbounds(
    db: DB,
    user: CurrentUser,
    semifinished_lot_id: int | None = Query(None),
    crop_id: int | None = Query(None),
    date_from: date | None = Query(None),
    date_to: date | None = Query(None),
    limit: int = Query(200, le=1000),
):
    """半製品の出庫履歴一覧。"""
    where = []
    params: list = []
    if semifinished_lot_id is not None:
        where.append("sor.semifinished_lot_id = %s")
        params.append(semifinished_lot_id)
    if crop_id is not None:
        where.append("p.crop_id = %s")
        params.append(crop_id)
    if date_from is not None:
        where.append("sor.outbound_date >= %s")
        params.append(date_from)
    if date_to is not None:
        where.append("sor.outbound_date <= %s")
        params.append(date_to)
    sql = """
        SELECT sor.id, sor.semifinished_lot_id, sl.code AS semifinished_code,
               sor.outbound_date, sor.quantity_kg, sor.cases,
               sor.purpose, sor.customer, sor.note, sor.created_at
        FROM semifinished_outbound_records sor
        JOIN semifinished_lots sl ON sl.id = sor.semifinished_lot_id
        JOIN products p ON p.id = sl.product_id
    """
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY sor.outbound_date DESC, sor.id DESC LIMIT %s"
    params.append(limit)
    async with db.cursor() as cur:
        await cur.execute(sql, params)
        rows = await cur.fetchall()
    return [SemifinishedOutboundOut(
        id=r["id"],
        semifinished_lot_id=r["semifinished_lot_id"],
        semifinished_code=r["semifinished_code"],
        outbound_date=r["outbound_date"],
        quantity_kg=Decimal(str(r["quantity_kg"])),
        cases=Decimal(str(r["cases"])) if r["cases"] is not None else None,
        purpose=r["purpose"],
        customer=r["customer"],
        note=r["note"],
        created_at=str(r["created_at"]) if r["created_at"] else None,
    ) for r in rows]


@router.delete("/outbound/{outbound_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_semifinished_outbound(
    outbound_id: int, db: DB, user: OperatorUser, request: Request,
):
    """半製品の出庫レコードを取り消す。"""
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT id, semifinished_lot_id, quantity_kg "
            "FROM semifinished_outbound_records WHERE id = %s", (outbound_id,))
        cur_row = await cur.fetchone()
        if not cur_row:
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                detail=f"出庫 {outbound_id} が存在しません")
        await cur.execute(
            "DELETE FROM semifinished_outbound_records WHERE id = %s",
            (outbound_id,))
    await write_audit(db, "SEMIFINISHED_OUTBOUND_DELETE",
                      "semifinished_outbound_records",
                      str(outbound_id),
                      {"semifinished_lot_id": cur_row["semifinished_lot_id"],
                       "quantity_kg": float(cur_row["quantity_kg"])},
                      user["id"], request)


# =============================================================================
# 内部ヘルパー
# =============================================================================

def _row_to_out(row: dict) -> dict:
    """DB row → SemifinishedStockOut 用の dict 変換。
    日時列を str に揃え、None は None のまま保持。"""
    out = dict(row)
    for k in ("price_confirmed_at", "archived_at", "created_at", "updated_at"):
        v = out.get(k)
        out[k] = str(v) if v is not None else None
    return out
