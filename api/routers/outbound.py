"""
api/routers/outbound.py
=======================
出庫・引き当てAPIルーター。

エンドポイント:
  POST /outbound/preview          - 引き当てシミュレーション（コミットなし）
  POST /outbound/allocate         - FIFO自動引き当て実行
  POST /outbound/allocate/manual  - ロット手動指定の引き当て
  GET  /outbound/records          - 出庫履歴一覧
  GET  /outbound/records/{id}     - 出庫レコード詳細
"""

from __future__ import annotations

import logging
from datetime import date
from decimal import Decimal

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from api.audit import write_audit
from api.auth import CurrentUser, OperatorUser
from api.dependencies import DB
from api.services.allocation import (
    AllocationError,
    AllocationResult,
    AllocationService,
    AmbiguousLotError,
    LotNotFoundError,
    StockInsufficientError,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/outbound", tags=["出庫"])


# =============================================================================
# リクエスト / レスポンスモデル
# =============================================================================

class PreviewRequest(BaseModel):
    product_id:          int
    quantity_kg:         Decimal = Field(..., gt=0)
    filter_supplier_id:  int | None = None
    filter_inbound_date: date | None = None
    filter_kg_per_case:  Decimal | None = None


class AllocateRequest(BaseModel):
    product_id:          int
    outbound_date:       date
    quantity_kg:         Decimal = Field(..., gt=0)
    note:                str | None = None
    filter_supplier_id:  int | None = None
    filter_inbound_date: date | None = None
    filter_kg_per_case:  Decimal | None = None


class ManualAllocateRequest(BaseModel):
    """
    ユーザーが AmbiguousLotError を受けてロットを選択した後のリクエスト。
    VBAの UI_SelectStock_Form → targetLedgerRow 確定に相当。

    preferred_lot_id (単一) と preferred_lot_ids (順序付き複数) は 排他。
    複数指定: 先頭ロットを優先消費 → 不足分は次のロットへ → 残れば 自動 FIFO。
    """
    product_id:       int
    outbound_date:    date
    quantity_kg:      Decimal = Field(..., gt=0)
    preferred_lot_id:  int | None = Field(
        None, description="ユーザーが選択したロットID (単一指定。 後方互換用)",
    )
    preferred_lot_ids: list[int] | None = Field(
        None,
        description="順序付き 複数ロット 指定 (preferred + fallback...)。 "
                    "preferred_lot_id と 排他。",
    )
    note:             str | None = None


class AllocationLineOut(BaseModel):
    outbound_record_id: int
    lot_id:             int
    lot_code:           str | None = None    # 表示用整理番号
    quantity_kg:        Decimal
    is_split:           bool
    inbound_date:       date | None
    supplier_name:      str | None
    spec_type:          str | None
    grade_level:        str | None
    size_label:         str | None
    origin_name:        str | None


class AllocationResultOut(BaseModel):
    product_id:    int
    outbound_date: date
    total_kg:      Decimal
    is_split:      bool
    lot_ids:       list[int]
    lines:         list[AllocationLineOut]


class NeedsSelectionResponse(BaseModel):
    """
    候補が複数存在し、ユーザー選択が必要なときのレスポンス。
    フロントエンドはこれを受け取ったらロット選択UIを表示する。
    """
    needs_selection: bool = True
    candidates:      list[dict]


def _to_result_out(result: AllocationResult) -> AllocationResultOut:
    return AllocationResultOut(
        product_id    = result.product_id,
        outbound_date = result.outbound_date,
        total_kg      = result.total_kg,
        is_split      = result.is_split,
        lot_ids       = result.lot_ids,
        lines         = [
            AllocationLineOut(**{
                k: getattr(line, k)
                for k in AllocationLineOut.model_fields
            })
            for line in result.lines
        ],
    )


# =============================================================================
# エンドポイント
# =============================================================================

@router.post("/preview")
async def preview_allocation(body: PreviewRequest, conn: DB, user: CurrentUser):
    """
    引き当てシミュレーション。コミットしない。
    フロントエンドの確認画面表示に使用する。
    """
    svc = AllocationService(conn)
    return await svc.preview(
        product_id          = body.product_id,
        quantity_kg         = body.quantity_kg,
        filter_supplier_id  = body.filter_supplier_id,
        filter_inbound_date = body.filter_inbound_date,
        filter_kg_per_case  = body.filter_kg_per_case,
    )


@router.post(
    "/allocate",
    response_model=AllocationResultOut | NeedsSelectionResponse,
    status_code=status.HTTP_201_CREATED,
)
async def allocate(body: AllocateRequest, request: Request, conn: DB, user: OperatorUser):
    """
    FIFO自動引き当てを実行する。

    正常系:
      - 候補1件、または先頭ロットで充足 → AllocationResultOut (201)

    要ユーザー選択:
      - 候補が複数かつロット指定なし → NeedsSelectionResponse (200)
        フロントはロット選択UIを表示し /outbound/allocate/manual を呼ぶ。

    エラー:
      - 在庫不足  → 409
      - ロット不在 → 404
    """
    actor_id = user["id"]
    svc = AllocationService(conn)

    try:
        result = await svc.allocate(
            product_id          = body.product_id,
            outbound_date       = body.outbound_date,
            quantity_kg         = body.quantity_kg,
            actor_id            = str(actor_id),
            note                = body.note,
            filter_supplier_id  = body.filter_supplier_id,
            filter_inbound_date = body.filter_inbound_date,
            filter_kg_per_case  = body.filter_kg_per_case,
        )
    except StockInsufficientError as e:
        logger.warning("stock_insufficient: %s", e)
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "error":          "在庫不足",
                "required_kg":    float(e.required_kg),
                "available_kg":   float(e.available_kg),
                "candidate_lots": [c.lot_id for c in e.candidates],
            },
        )
    except AmbiguousLotError as e:
        # ユーザーにロット選択を求める（エラーではなく正常フロー）
        return NeedsSelectionResponse(
            candidates=[
                {
                    "lot_id":        c.lot_id,
                    "lot_code":      c.lot_code,
                    "inbound_date":  c.inbound_date.isoformat(),
                    "supplier_name": c.supplier_name,
                    "spec_type":     c.spec_type,
                    "grade_level":   c.grade_level,
                    "size_label":    c.size_label,
                    "origin_name":   c.origin_name,
                    "remaining_kg":  float(c.remaining_kg),
                    "unit_price":    float(c.unit_price) if c.unit_price else None,
                    "fifo_rank":     c.fifo_rank,
                }
                for c in e.candidates
            ]
        )
    except AllocationError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(e))

    await write_audit(conn, "OUTBOUND_ALLOCATE", "outbound_records",
                      ",".join(str(l.outbound_record_id) for l in result.lines),
                      {"product_id": result.product_id, "total_kg": float(result.total_kg),
                       "is_split": result.is_split, "lot_ids": result.lot_ids},
                      actor_id, request)
    return _to_result_out(result)


@router.post(
    "/allocate/manual",
    response_model=AllocationResultOut,
    status_code=status.HTTP_201_CREATED,
)
async def allocate_manual(body: ManualAllocateRequest, request: Request,
                          conn: DB, user: OperatorUser):
    """
    ユーザーがロットを選択した後の引き当て実行。
    /outbound/allocate が NeedsSelectionResponse を返した場合に呼ぶ。
    VBAの UI_SelectStock_Form 選択後の Execute_Allocation 呼び出しに相当。
    """
    actor_id = user["id"]
    svc = AllocationService(conn)

    # preferred_lot_id / preferred_lot_ids の どちら かは 必須。 両方 NG。
    if body.preferred_lot_id is None and not body.preferred_lot_ids:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="preferred_lot_id か preferred_lot_ids のどちらかを指定してください",
        )

    try:
        result = await svc.allocate(
            product_id        = body.product_id,
            outbound_date     = body.outbound_date,
            quantity_kg       = body.quantity_kg,
            actor_id          = str(actor_id),
            note              = body.note,
            preferred_lot_id  = body.preferred_lot_id,
            preferred_lot_ids = body.preferred_lot_ids,
        )
    except StockInsufficientError as e:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "error":        "在庫不足",
                "required_kg":  float(e.required_kg),
                "available_kg": float(e.available_kg),
            },
        )
    except LotNotFoundError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail=str(e))
    except AllocationError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(e))
    except ValueError as e:
        # AllocationService が「preferred_lot_id / preferred_lot_ids 両方指定」を 弾いた場合
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(e))

    chosen_lots = body.preferred_lot_ids or [body.preferred_lot_id]
    await write_audit(conn, "OUTBOUND_ALLOCATE_MANUAL", "outbound_records",
                      ",".join(str(l.outbound_record_id) for l in result.lines),
                      {"product_id": result.product_id, "preferred_lot_ids": chosen_lots},
                      actor_id, request)
    return _to_result_out(result)


@router.get("/records")
async def list_outbound_records(
    conn:        DB,
    user:        CurrentUser,
    product_id:  int | None = Query(None),
    lot_id:      int | None = Query(None),
    crop_id:     int | None = Query(None, description="作物 ID で絞り込み"),
    date_from:   date | None = Query(None),
    date_to:     date | None = Query(None),
    limit:       int = Query(100, ge=1, le=500),
    offset:      int = Query(0, ge=0),
):
    """
    出庫履歴一覧。VBAの出庫シートに相当するが、正規化されたロング形式で返す。
    """
    conditions: list[str] = ["1=1"]
    params: list = []

    if lot_id is not None:
        params.append(lot_id)
        conditions.append("ob.lot_id = %s")
    if product_id is not None:
        params.append(product_id)
        conditions.append("il.product_id = %s")
    if crop_id is not None:
        params.append(crop_id)
        conditions.append("p.crop_id = %s")
    if date_from is not None:
        params.append(date_from)
        conditions.append("ob.outbound_date >= %s")
    if date_to is not None:
        params.append(date_to)
        conditions.append("ob.outbound_date <= %s")

    where = " AND ".join(conditions)
    params += [limit, offset]

    async with conn.cursor() as cur:
        await cur.execute(f"""
            SELECT
                ob.id               AS record_id,
                ob.lot_id,
                il.code             AS lot_code,
                ob.outbound_date,
                ob.quantity_kg,
                ob.note,
                ob.created_at,
                il.inbound_date,
                il.kg_per_case,
                il.product_id,
                g.spec_type,
                g.grade_level,
                g.size_label,
                o.name              AS origin_name,
                s.name              AS supplier_name,
                u.display_name      AS created_by_name
            FROM outbound_records ob
            JOIN inbound_lots il ON il.id = ob.lot_id
            JOIN products     p  ON p.id  = il.product_id
            JOIN grades       g  ON g.id  = p.grade_id
            JOIN origins      o  ON o.id  = p.origin_id
            JOIN suppliers    s  ON s.id  = il.supplier_id
            LEFT JOIN users   u  ON u.id  = ob.created_by
            WHERE {where}
            ORDER BY ob.outbound_date DESC, ob.id DESC
            LIMIT %s OFFSET %s
        """, params)
        rows = await cur.fetchall()

    return [dict(r) for r in rows]


class OutboundRecordPatch(BaseModel):
    """出庫レコードの部分更新。lot_id は変更不可 (FIFO 整合性のため)。"""
    outbound_date: date | None = None
    quantity_kg:   Decimal | None = Field(None, gt=0)
    note:          str | None = None


@router.patch("/records/{record_id}")
async def patch_outbound_record(
    record_id: int, body: OutboundRecordPatch, conn: DB,
    user: OperatorUser, request: Request,
):
    """出庫レコードの部分更新 (出庫日 / 数量 / 備考)。
    ロット残量を超える数量変更は拒否。"""
    fields = body.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="更新するフィールドが指定されていません")

    async with conn.cursor() as cur:
        await cur.execute("SELECT * FROM outbound_records WHERE id=%s", (record_id,))
        existing = await cur.fetchone()
        if not existing:
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                detail=f"出庫レコード(id={record_id})が見つかりません")

        # ロット情報 (数量・日付チェック共通で使う)
        await cur.execute(
            "SELECT total_kg, inbound_date FROM inbound_lots WHERE id=%s",
            (existing["lot_id"],))
        lot = await cur.fetchone()

        # 数量変更時、ロット残量で検証
        if "quantity_kg" in fields:
            new_qty = Decimal(str(fields["quantity_kg"]))
            await cur.execute(
                "SELECT COALESCE(SUM(quantity_kg), 0) AS other_out "
                "FROM outbound_records WHERE lot_id=%s AND id <> %s",
                (existing["lot_id"], record_id))
            other = await cur.fetchone()
            available = Decimal(str(lot["total_kg"])) - Decimal(str(other["other_out"]))
            if new_qty > available:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    detail=f"ロット残量 {available} kg を超えます (要求: {new_qty} kg)。",
                )

        # 出庫日変更時、入荷日より前にずらせない
        if "outbound_date" in fields:
            new_out = fields["outbound_date"]
            if new_out < lot["inbound_date"]:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    detail=f"出庫日 {new_out} は入荷日 {lot['inbound_date']} より "
                           "前にできません。",
                )

        sets: list[str] = []
        params: list = []
        if "outbound_date" in fields:
            sets.append("outbound_date = %s"); params.append(fields["outbound_date"])
        if "quantity_kg" in fields:
            sets.append("quantity_kg = %s"); params.append(fields["quantity_kg"])
        if "note" in fields:
            sets.append("note = %s"); params.append(fields["note"])
        params.append(record_id)

        await cur.execute(
            f"UPDATE outbound_records SET {', '.join(sets)} WHERE id = %s RETURNING *",
            params)
        row = await cur.fetchone()

    await write_audit(conn, "OUTBOUND_PATCH", "outbound_records", str(record_id),
                      {k: (float(v) if isinstance(v, Decimal) else str(v) if v is not None else None)
                       for k, v in fields.items()},
                      user["id"], request)
    return dict(row)


@router.delete("/records/{record_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_outbound_record(
    record_id: int, conn: DB, user: OperatorUser, request: Request,
):
    """出庫レコードを削除 (取り消し)。ロット残量が回復します。"""
    async with conn.cursor() as cur:
        await cur.execute(
            "DELETE FROM outbound_records WHERE id=%s RETURNING lot_id, quantity_kg",
            (record_id,))
        row = await cur.fetchone()
        if not row:
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                detail=f"出庫レコード(id={record_id})が見つかりません")
    await write_audit(conn, "OUTBOUND_DELETE", "outbound_records", str(record_id),
                      {"lot_id": row["lot_id"], "quantity_kg": float(row["quantity_kg"])},
                      user["id"], request)


@router.get("/records/{record_id}")
async def get_outbound_record(record_id: int, conn: DB, user: CurrentUser):
    """出庫レコード詳細。"""
    async with conn.cursor() as cur:
        await cur.execute("""
            SELECT
                ob.*,
                il.inbound_date,
                il.product_id,
                il.total_kg         AS lot_total_kg,
                il.unit_price,
                g.spec_type,
                g.grade_level,
                g.size_label,
                o.name              AS origin_name,
                s.name              AS supplier_name
            FROM outbound_records ob
            JOIN inbound_lots il ON il.id = ob.lot_id
            JOIN products     p  ON p.id  = il.product_id
            JOIN grades       g  ON g.id  = p.grade_id
            JOIN origins      o  ON o.id  = p.origin_id
            JOIN suppliers    s  ON s.id  = il.supplier_id
            WHERE ob.id = %s
        """, (record_id,))
        row = await cur.fetchone()

    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND,
                            detail=f"出庫レコード(id={record_id})が見つかりません")

    return dict(row)
