"""
api/routers/substitution.py
============================
振替ルール マスタ + 振替出庫 (商品レベル) の API ルーター。

エンドポイント:
  GET    /substitution/rules                  — ルール 一覧 (crop_id 必須)
  POST   /substitution/rules                  — 1 行 upsert
  PATCH  /substitution/rules/{id}             — 編集
  DELETE /substitution/rules/{id}             — 削除
  POST   /substitution/preview                — 振替出庫 プレビュー (DB 書込みなし)
  POST   /substitution/execute                — 振替出庫 実行 (outbound_orders + outbound_records 作成)
  GET    /substitution/orders/{id}            — 出庫オーダー 詳細 (含む 消化明細)
  GET    /report/outbound/{date}              — 日次 出庫レポート (JSON)
  GET    /report/outbound/{date}.xlsx         — 日次 出庫レポート (Excel ダウンロード)
"""
from __future__ import annotations

import logging
from datetime import date
from decimal import Decimal

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from api.audit import write_audit
from api.auth import CurrentUser, OperatorUser
from api.dependencies import DB
from api.services.grade_label import compact_grade_label
from api.services.outbound_report import build_report_data, build_report_xlsx
from api.services.substitution import (
    InsufficientSubstitutionStockError,
    NoSubstitutionRulesError,
    SubstitutionError,
    SubstitutionService,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/substitution", tags=["振替出庫"])


# =============================================================================
# リクエスト/レスポンス モデル
# =============================================================================
class RuleOut(BaseModel):
    id: int
    crop_id: int
    origin_id: int
    origin_name: str
    from_grade_id: int
    from_grade_label: str           # 表示用 (例: "標準/A/L")
    priority: int
    to_grade_id: int
    to_grade_label: str
    yield_factor: Decimal
    is_active: bool
    note: str | None


class RuleUpsertRequest(BaseModel):
    crop_id: int
    origin_id: int
    from_grade_id: int
    priority: int = Field(..., ge=1, le=3)
    to_grade_id: int
    yield_factor: Decimal = Field(..., gt=0, le=1)
    is_active: bool = True
    note: str | None = None


class RulePatchRequest(BaseModel):
    to_grade_id:  int | None = None
    yield_factor: Decimal | None = Field(default=None, gt=0, le=1)
    is_active:    bool | None = None
    note:         str | None = None


class PreviewRequest(BaseModel):
    crop_id:        int
    origin_id:      int
    from_grade_id:  int
    outbound_date:  date
    product_qty_kg: Decimal = Field(..., gt=0)


class ExecuteRequest(BaseModel):
    crop_id:        int
    origin_id:      int
    from_grade_id:  int
    outbound_date:  date
    product_qty_kg: Decimal = Field(..., gt=0)
    note:           str | None = None


class ConsumptionLineOut(BaseModel):
    outbound_record_id: int | None
    lot_id: int
    lot_code: str
    priority_used: int
    to_grade_id: int
    to_grade_label: str
    yield_applied: Decimal
    raw_qty_kg: Decimal
    product_qty_covered_kg: Decimal


class SubstitutionResultOut(BaseModel):
    order_id: int | None
    crop_id: int
    origin_id: int
    from_grade_id: int
    outbound_date: date
    requested_product_kg: Decimal
    covered_product_kg: Decimal
    is_complete: bool
    lines: list[ConsumptionLineOut]


# =============================================================================
# ヘルパー
# =============================================================================
async def _fetch_grade_label_map(conn, grade_ids: set[int]) -> dict[int, str]:
    if not grade_ids:
        return {}
    cur = await conn.execute("""
        SELECT id, spec_type, grade_level, size_label
        FROM grades
        WHERE id = ANY(%s)
    """, (list(grade_ids),))
    rows = await cur.fetchall()
    return {r["id"]: compact_grade_label(r["spec_type"], r["grade_level"], r["size_label"]) for r in rows}


# =============================================================================
# ルール マスタ CRUD
# =============================================================================
@router.get("/rules", response_model=list[RuleOut])
async def list_rules(
    conn: DB,
    user: CurrentUser,
    crop_id: int = Query(...),
    origin_id: int | None = Query(None),
    from_grade_id: int | None = Query(None),
    include_inactive: bool = Query(False),
):
    """振替ルール 一覧 を 取得。"""
    where = ["sr.crop_id = %s"]
    params: list = [crop_id]
    if origin_id is not None:
        where.append("sr.origin_id = %s")
        params.append(origin_id)
    if from_grade_id is not None:
        where.append("sr.from_grade_id = %s")
        params.append(from_grade_id)
    if not include_inactive:
        where.append("sr.is_active = true")
    where_sql = " AND ".join(where)

    cur = await conn.execute(f"""
        SELECT sr.id, sr.crop_id, sr.origin_id, o.name AS origin_name,
               sr.from_grade_id, fg.spec_type AS f_spec, fg.grade_level AS f_grade, fg.size_label AS f_size,
               sr.priority,
               sr.to_grade_id,   tg.spec_type AS t_spec, tg.grade_level AS t_grade, tg.size_label AS t_size,
               sr.yield_factor, sr.is_active, sr.note
        FROM substitution_rules sr
        JOIN origins o   ON o.id  = sr.origin_id
        JOIN grades  fg  ON fg.id = sr.from_grade_id
        JOIN grades  tg  ON tg.id = sr.to_grade_id
        WHERE {where_sql}
        ORDER BY o.name, fg.spec_type, fg.grade_level, fg.size_label, sr.priority
    """, tuple(params))
    rows = await cur.fetchall()
    return [
        RuleOut(
            id=r["id"], crop_id=r["crop_id"],
            origin_id=r["origin_id"], origin_name=r["origin_name"],
            from_grade_id=r["from_grade_id"],
            from_grade_label=compact_grade_label(r["f_spec"], r["f_grade"], r["f_size"]),
            priority=r["priority"],
            to_grade_id=r["to_grade_id"],
            to_grade_label=compact_grade_label(r["t_spec"], r["t_grade"], r["t_size"]),
            yield_factor=r["yield_factor"],
            is_active=r["is_active"],
            note=r["note"],
        )
        for r in rows
    ]


@router.post("/rules", response_model=RuleOut)
async def upsert_rule(body: RuleUpsertRequest, request: Request, conn: DB, user: OperatorUser):
    """ルール 1 行 を upsert (crop, origin, from_grade, priority で 一意)。"""
    cur = await conn.execute("""
        INSERT INTO substitution_rules
            (crop_id, origin_id, from_grade_id, priority, to_grade_id, yield_factor, is_active, note)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (crop_id, origin_id, from_grade_id, priority) DO UPDATE SET
            to_grade_id  = EXCLUDED.to_grade_id,
            yield_factor = EXCLUDED.yield_factor,
            is_active    = EXCLUDED.is_active,
            note         = EXCLUDED.note,
            updated_at   = now()
        RETURNING id
    """, (body.crop_id, body.origin_id, body.from_grade_id, body.priority,
          body.to_grade_id, body.yield_factor, body.is_active, body.note))
    rid = (await cur.fetchone())["id"]
    await write_audit(conn, "SUBSTITUTION_RULE_UPSERT", "substitution_rules", str(rid),
                      body.model_dump(mode='json'), user["id"], request)
    return await _get_rule(conn, rid)


@router.patch("/rules/{rule_id}", response_model=RuleOut)
async def patch_rule(rule_id: int, body: RulePatchRequest, request: Request,
                     conn: DB, user: OperatorUser):
    sets = []
    params = []
    if body.to_grade_id is not None:
        sets.append("to_grade_id = %s"); params.append(body.to_grade_id)
    if body.yield_factor is not None:
        sets.append("yield_factor = %s"); params.append(body.yield_factor)
    if body.is_active is not None:
        sets.append("is_active = %s"); params.append(body.is_active)
    if body.note is not None:
        sets.append("note = %s"); params.append(body.note)
    if not sets:
        raise HTTPException(status_code=400, detail="変更項目 なし")
    sets.append("updated_at = now()")
    params.append(rule_id)
    cur = await conn.execute(
        f"UPDATE substitution_rules SET {', '.join(sets)} WHERE id = %s RETURNING id",
        tuple(params),
    )
    if not await cur.fetchone():
        raise HTTPException(status_code=404, detail="ルール 未発見")
    await write_audit(conn, "SUBSTITUTION_RULE_PATCH", "substitution_rules", str(rule_id),
                      body.model_dump(exclude_none=True, mode='json'), user["id"], request)
    return await _get_rule(conn, rule_id)


@router.delete("/rules/{rule_id}")
async def delete_rule(rule_id: int, request: Request, conn: DB, user: OperatorUser):
    cur = await conn.execute("DELETE FROM substitution_rules WHERE id = %s RETURNING id", (rule_id,))
    if not await cur.fetchone():
        raise HTTPException(status_code=404, detail="ルール 未発見")
    await write_audit(conn, "SUBSTITUTION_RULE_DELETE", "substitution_rules", str(rule_id),
                      {}, user["id"], request)
    return {"ok": True}


async def _get_rule(conn, rule_id: int) -> RuleOut:
    cur = await conn.execute("""
        SELECT sr.id, sr.crop_id, sr.origin_id, o.name AS origin_name,
               sr.from_grade_id, fg.spec_type AS f_spec, fg.grade_level AS f_grade, fg.size_label AS f_size,
               sr.priority,
               sr.to_grade_id,   tg.spec_type AS t_spec, tg.grade_level AS t_grade, tg.size_label AS t_size,
               sr.yield_factor, sr.is_active, sr.note
        FROM substitution_rules sr
        JOIN origins o  ON o.id  = sr.origin_id
        JOIN grades  fg ON fg.id = sr.from_grade_id
        JOIN grades  tg ON tg.id = sr.to_grade_id
        WHERE sr.id = %s
    """, (rule_id,))
    r = await cur.fetchone()
    if not r:
        raise HTTPException(status_code=404, detail="ルール 未発見")
    return RuleOut(
        id=r["id"], crop_id=r["crop_id"],
        origin_id=r["origin_id"], origin_name=r["origin_name"],
        from_grade_id=r["from_grade_id"],
        from_grade_label=compact_grade_label(r["f_spec"], r["f_grade"], r["f_size"]),
        priority=r["priority"],
        to_grade_id=r["to_grade_id"],
        to_grade_label=compact_grade_label(r["t_spec"], r["t_grade"], r["t_size"]),
        yield_factor=r["yield_factor"],
        is_active=r["is_active"],
        note=r["note"],
    )


# =============================================================================
# 振替出庫
# =============================================================================
def _wrap_substitution_errors(e: Exception) -> HTTPException:
    if isinstance(e, NoSubstitutionRulesError):
        return HTTPException(status_code=400, detail={
            "code": "NO_SUBSTITUTION_RULES",
            "message": "振替ルール が マスタ に 未設定",
            "crop_id": e.crop_id, "origin_id": e.origin_id, "from_grade_id": e.from_grade_id,
        })
    if isinstance(e, InsufficientSubstitutionStockError):
        return HTTPException(status_code=409, detail={
            "code": "INSUFFICIENT_STOCK",
            "message": "振替後 も 在庫不足 — 優先順位/歩留まり を 確認",
            "requested_kg": str(e.requested_kg),
            "covered_kg":   str(e.covered_kg),
            "remaining_kg": str(e.remaining_kg),
            "attempted_priorities": e.attempted_priorities,
        })
    if isinstance(e, SubstitutionError):
        return HTTPException(status_code=400, detail=str(e))
    return HTTPException(status_code=500, detail=f"unexpected: {e}")


def _result_to_out(result, label_map: dict[int, str]) -> SubstitutionResultOut:
    return SubstitutionResultOut(
        order_id=result.order_id,
        crop_id=result.crop_id, origin_id=result.origin_id,
        from_grade_id=result.from_grade_id,
        outbound_date=result.outbound_date,
        requested_product_kg=result.requested_product_kg,
        covered_product_kg=result.covered_product_kg,
        is_complete=result.is_complete,
        lines=[
            ConsumptionLineOut(
                outbound_record_id=l.outbound_record_id,
                lot_id=l.lot_id, lot_code=l.lot_code,
                priority_used=l.priority_used,
                to_grade_id=l.to_grade_id,
                to_grade_label=label_map.get(l.to_grade_id, ""),
                yield_applied=l.yield_applied,
                raw_qty_kg=l.raw_qty_kg,
                product_qty_covered_kg=l.product_qty_covered_kg,
            )
            for l in result.lines
        ],
    )


@router.post("/preview", response_model=SubstitutionResultOut)
async def preview(body: PreviewRequest, conn: DB, user: CurrentUser):
    """振替計算 プレビュー (DB 書込みなし)。"""
    svc = SubstitutionService(conn)
    try:
        result = await svc.preview(
            crop_id=body.crop_id,
            origin_id=body.origin_id,
            from_grade_id=body.from_grade_id,
            outbound_date=body.outbound_date,
            product_qty_kg=body.product_qty_kg,
        )
    except Exception as e:
        raise _wrap_substitution_errors(e) from e
    label_map = await _fetch_grade_label_map(conn, {l.to_grade_id for l in result.lines})
    return _result_to_out(result, label_map)


@router.post("/execute", response_model=SubstitutionResultOut, status_code=status.HTTP_201_CREATED)
async def execute(body: ExecuteRequest, request: Request, conn: DB, user: OperatorUser):
    """
    振替出庫 実行: outbound_orders 1 件 + outbound_records 複数件 を 作成。
    在庫不足 の 場合 409 を 返し DB は 変更されない (トランザクション ロールバック)。
    """
    svc = SubstitutionService(conn)
    try:
        result = await svc.execute(
            crop_id=body.crop_id,
            origin_id=body.origin_id,
            from_grade_id=body.from_grade_id,
            outbound_date=body.outbound_date,
            product_qty_kg=body.product_qty_kg,
            note=body.note,
            actor_id=user["id"],
        )
    except Exception as e:
        raise _wrap_substitution_errors(e) from e

    await write_audit(conn, "SUBSTITUTION_ORDER_CREATE", "outbound_orders", str(result.order_id),
                      {"crop_id": body.crop_id, "origin_id": body.origin_id,
                       "from_grade_id": body.from_grade_id,
                       "product_qty_kg": str(body.product_qty_kg),
                       "covered_kg": str(result.covered_product_kg),
                       "lot_ids": [l.lot_id for l in result.lines]},
                      user["id"], request)
    label_map = await _fetch_grade_label_map(conn, {l.to_grade_id for l in result.lines})
    return _result_to_out(result, label_map)


@router.get("/orders/{order_id}", response_model=SubstitutionResultOut)
async def get_order(order_id: int, conn: DB, user: CurrentUser):
    cur = await conn.execute("""
        SELECT id, crop_id, outbound_date, origin_id, from_grade_id, product_qty_kg, note
        FROM outbound_orders WHERE id = %s
    """, (order_id,))
    o = await cur.fetchone()
    if not o:
        raise HTTPException(status_code=404, detail="出庫オーダー 未発見")
    cur = await conn.execute("""
        SELECT r.id AS outbound_record_id, r.lot_id, il.code AS lot_code,
               r.priority_used, r.yield_applied, r.quantity_kg AS raw_qty_kg,
               r.product_qty_covered AS product_qty_covered_kg,
               p.grade_id AS to_grade_id
        FROM outbound_records r
        JOIN inbound_lots il ON il.id = r.lot_id
        JOIN products p ON p.id = il.product_id
        WHERE r.order_id = %s
        ORDER BY r.priority_used NULLS LAST, r.id
    """, (order_id,))
    lines_data = await cur.fetchall()
    label_map = await _fetch_grade_label_map(conn, {r["to_grade_id"] for r in lines_data})
    covered = sum((Decimal(r["product_qty_covered_kg"] or 0) for r in lines_data), Decimal(0))
    return SubstitutionResultOut(
        order_id=o["id"], crop_id=o["crop_id"],
        origin_id=o["origin_id"], from_grade_id=o["from_grade_id"],
        outbound_date=o["outbound_date"],
        requested_product_kg=o["product_qty_kg"],
        covered_product_kg=covered,
        is_complete=covered >= Decimal(o["product_qty_kg"]),
        lines=[
            ConsumptionLineOut(
                outbound_record_id=r["outbound_record_id"],
                lot_id=r["lot_id"], lot_code=r["lot_code"],
                priority_used=r["priority_used"] or 0,
                to_grade_id=r["to_grade_id"],
                to_grade_label=label_map.get(r["to_grade_id"], ""),
                yield_applied=Decimal(r["yield_applied"] or 0),
                raw_qty_kg=Decimal(r["raw_qty_kg"]),
                product_qty_covered_kg=Decimal(r["product_qty_covered_kg"] or 0),
            )
            for r in lines_data
        ],
    )


# =============================================================================
# 出庫履歴 / グループ管理 (Phase 4)
# =============================================================================
class OrderHistoryOut(BaseModel):
    id:              int
    crop_id:         int
    outbound_date:   date
    origin_id:       int
    origin_name:     str
    from_grade_id:   int
    from_grade_label: str
    product_qty_kg:  Decimal
    note:            str | None
    created_at:      str
    batch_id:        str | None
    record_count:    int          # この order に 紐付く outbound_records 件数


class BatchHistoryOut(BaseModel):
    """NR 一括登録 の グループ単位 (batch_id で 集約) または 単発 order。"""
    batch_id:        str | None    # None = 単発 (= 1 order だけ)
    outbound_date:   date          # batch 内 で 同一
    crop_id:         int
    note:            str | None    # batch 内 で 同一
    created_at:      str
    order_count:     int
    total_product_kg: Decimal
    total_record_count: int
    orders:          list[OrderHistoryOut]


@router.get("/orders", response_model=list[BatchHistoryOut])
async def list_orders(
    conn: DB, user: CurrentUser,
    crop_id: int = Query(...),
    limit: int = Query(50, ge=1, le=500),
    date_from: date | None = Query(None),
    date_to:   date | None = Query(None),
):
    """
    振替出庫履歴 を batch 単位 (= 同一 batch_id) で 集約 して 返す。
    batch_id IS NULL の order は 単発 として 1 件 ずつ 表示。
    """
    where = ["oo.crop_id = %s"]
    params: list = [crop_id]
    if date_from is not None:
        where.append("oo.outbound_date >= %s"); params.append(date_from)
    if date_to is not None:
        where.append("oo.outbound_date <= %s"); params.append(date_to)
    where_sql = " AND ".join(where)

    cur = await conn.execute(f"""
        SELECT
            oo.id, oo.crop_id, oo.outbound_date,
            oo.origin_id, o.name AS origin_name,
            oo.from_grade_id,
            fg.spec_type AS f_spec, fg.grade_level AS f_grade, fg.size_label AS f_size,
            oo.product_qty_kg, oo.note, oo.created_at, oo.batch_id,
            (SELECT COUNT(*) FROM outbound_records WHERE order_id=oo.id) AS rec_count
        FROM outbound_orders oo
        JOIN origins o  ON o.id  = oo.origin_id
        JOIN grades  fg ON fg.id = oo.from_grade_id
        WHERE {where_sql}
        ORDER BY oo.created_at DESC, oo.id DESC
        LIMIT %s
    """, tuple(params) + (limit,))
    rows = await cur.fetchall()

    # batch_id ごと に 集約 (NULL は 個別 batch として 扱う = order.id を 代理キー)
    batches: dict[str, dict] = {}
    for r in rows:
        bkey = str(r["batch_id"]) if r["batch_id"] else f"single_{r['id']}"
        o = OrderHistoryOut(
            id=r["id"], crop_id=r["crop_id"],
            outbound_date=r["outbound_date"],
            origin_id=r["origin_id"], origin_name=r["origin_name"],
            from_grade_id=r["from_grade_id"],
            from_grade_label=compact_grade_label(r["f_spec"], r["f_grade"], r["f_size"]),
            product_qty_kg=r["product_qty_kg"], note=r["note"],
            created_at=r["created_at"].isoformat(),
            batch_id=str(r["batch_id"]) if r["batch_id"] else None,
            record_count=r["rec_count"],
        )
        if bkey not in batches:
            batches[bkey] = {
                "batch_id": o.batch_id, "outbound_date": o.outbound_date,
                "crop_id": o.crop_id, "note": o.note, "created_at": o.created_at,
                "orders": [], "total_product_kg": Decimal(0), "total_record_count": 0,
            }
        b = batches[bkey]
        b["orders"].append(o)
        b["total_product_kg"] += Decimal(o.product_qty_kg)
        b["total_record_count"] += o.record_count
        # 最古 created_at を 採用 (= バッチ作成時刻)
        if r["created_at"].isoformat() < b["created_at"]:
            b["created_at"] = r["created_at"].isoformat()

    # 結果 を created_at 降順で
    result = sorted(batches.values(), key=lambda b: b["created_at"], reverse=True)
    return [
        BatchHistoryOut(
            batch_id=b["batch_id"], outbound_date=b["outbound_date"],
            crop_id=b["crop_id"], note=b["note"], created_at=b["created_at"],
            order_count=len(b["orders"]),
            total_product_kg=b["total_product_kg"],
            total_record_count=b["total_record_count"],
            orders=b["orders"],
        )
        for b in result
    ]


class OrderDatePatchRequest(BaseModel):
    outbound_date: date


@router.patch("/orders/{order_id}/date")
async def patch_order_date(order_id: int, body: OrderDatePatchRequest, request: Request,
                           conn: DB, user: OperatorUser):
    """1 order と 関連 outbound_records の 出庫日 を 変更。"""
    cur = await conn.execute("""
        SELECT id, outbound_date FROM outbound_orders WHERE id = %s
    """, (order_id,))
    o = await cur.fetchone()
    if not o:
        raise HTTPException(404, "order 未発見")
    old_date = o["outbound_date"]
    await conn.execute(
        "UPDATE outbound_orders SET outbound_date = %s WHERE id = %s",
        (body.outbound_date, order_id),
    )
    cur = await conn.execute(
        "UPDATE outbound_records SET outbound_date = %s WHERE order_id = %s",
        (body.outbound_date, order_id),
    )
    await write_audit(conn, "OUTBOUND_ORDER_DATE_PATCH", "outbound_orders", str(order_id),
                      {"old": old_date.isoformat(), "new": body.outbound_date.isoformat()},
                      user["id"], request)
    return {"ok": True, "order_id": order_id, "old_date": old_date.isoformat(), "new_date": body.outbound_date.isoformat()}


@router.delete("/orders/{order_id}")
async def cancel_order(order_id: int, request: Request, conn: DB, user: OperatorUser):
    """1 order を キャンセル (= 関連 outbound_records + outbound_order を 削除)。"""
    cur = await conn.execute("""
        SELECT id, crop_id, outbound_date, product_qty_kg FROM outbound_orders WHERE id = %s
    """, (order_id,))
    o = await cur.fetchone()
    if not o:
        raise HTTPException(404, "order 未発見")
    cur = await conn.execute(
        "DELETE FROM outbound_records WHERE order_id = %s",
        (order_id,),
    )
    deleted_records = cur.rowcount
    await conn.execute("DELETE FROM outbound_orders WHERE id = %s", (order_id,))
    await write_audit(conn, "OUTBOUND_ORDER_CANCEL", "outbound_orders", str(order_id),
                      {"crop_id": o["crop_id"],
                       "outbound_date": o["outbound_date"].isoformat(),
                       "product_qty_kg": str(o["product_qty_kg"]),
                       "deleted_records": deleted_records},
                      user["id"], request)
    return {"ok": True, "order_id": order_id, "deleted_records": deleted_records}


class BatchDatePatchRequest(BaseModel):
    outbound_date: date


@router.patch("/batches/{batch_id}/date")
async def patch_batch_date(batch_id: str, body: BatchDatePatchRequest, request: Request,
                           conn: DB, user: OperatorUser):
    """batch_id 単位 で 全 order + 関連 records の 日付 を 一括変更。"""
    cur = await conn.execute(
        "SELECT id, outbound_date FROM outbound_orders WHERE batch_id = %s::uuid",
        (batch_id,),
    )
    orders = await cur.fetchall()
    if not orders:
        raise HTTPException(404, "batch 未発見")
    order_ids = [o["id"] for o in orders]
    await conn.execute(
        "UPDATE outbound_orders SET outbound_date = %s WHERE batch_id = %s::uuid",
        (body.outbound_date, batch_id),
    )
    await conn.execute(
        "UPDATE outbound_records SET outbound_date = %s WHERE order_id = ANY(%s)",
        (body.outbound_date, order_ids),
    )
    await write_audit(conn, "OUTBOUND_BATCH_DATE_PATCH", "outbound_orders",
                      ",".join(str(o) for o in order_ids),
                      {"batch_id": batch_id, "new_date": body.outbound_date.isoformat(),
                       "order_count": len(orders)},
                      user["id"], request)
    return {"ok": True, "batch_id": batch_id, "order_count": len(orders),
            "new_date": body.outbound_date.isoformat()}


@router.delete("/batches/{batch_id}")
async def cancel_batch(batch_id: str, request: Request, conn: DB, user: OperatorUser):
    """batch_id 単位 で 全 order + records を キャンセル。"""
    cur = await conn.execute(
        "SELECT id, crop_id, outbound_date, product_qty_kg FROM outbound_orders WHERE batch_id = %s::uuid",
        (batch_id,),
    )
    orders = await cur.fetchall()
    if not orders:
        raise HTTPException(404, "batch 未発見")
    order_ids = [o["id"] for o in orders]
    cur = await conn.execute(
        "DELETE FROM outbound_records WHERE order_id = ANY(%s)",
        (order_ids,),
    )
    deleted_records = cur.rowcount
    await conn.execute(
        "DELETE FROM outbound_orders WHERE batch_id = %s::uuid",
        (batch_id,),
    )
    await write_audit(conn, "OUTBOUND_BATCH_CANCEL", "outbound_orders",
                      ",".join(str(o) for o in order_ids),
                      {"batch_id": batch_id, "order_count": len(orders),
                       "deleted_records": deleted_records,
                       "total_kg": str(sum(Decimal(o["product_qty_kg"]) for o in orders))},
                      user["id"], request)
    return {"ok": True, "batch_id": batch_id, "deleted_orders": len(orders),
            "deleted_records": deleted_records}


# =============================================================================
# 日次 出庫レポート (Phase 2)
# =============================================================================
class ReportSubRowOut(BaseModel):
    product_grade_label: str
    raw_qty_kg: Decimal
    yield_applied: Decimal


class ReportRowOut(BaseModel):
    origin_id: int
    origin_name: str
    raw_grade_id: int
    raw_grade_label: str
    prev_kg: Decimal
    weight_kg: Decimal
    month_out_kg: Decimal
    balance_kg: Decimal
    avg_price: Decimal | None
    today_out_kg: Decimal
    sub_rows: list[ReportSubRowOut]


class ReportDataOut(BaseModel):
    target_date: date
    crop_id: int
    crop_name: str
    rows: list[ReportRowOut]


# 出庫レポート は 別 prefix で 公開 (= /report/outbound)
report_router = APIRouter(prefix="/report", tags=["出庫レポート"])


@report_router.get("/outbound/{target_date}", response_model=ReportDataOut)
async def get_outbound_report(
    target_date: date,
    conn: DB,
    user: CurrentUser,
    crop_id: int = Query(2, description="対象 作物 (デフォルト 大蒜=2)"),
):
    """日次 出庫レポート を JSON で 取得。"""
    data = await build_report_data(conn, target_date, crop_id)
    return ReportDataOut(
        target_date=data.target_date,
        crop_id=data.crop_id, crop_name=data.crop_name,
        rows=[
            ReportRowOut(
                origin_id=r.origin_id, origin_name=r.origin_name,
                raw_grade_id=r.raw_grade_id, raw_grade_label=r.raw_grade_label,
                prev_kg=r.prev_kg, weight_kg=r.weight_kg,
                month_out_kg=r.month_out_kg, balance_kg=r.balance_kg,
                avg_price=r.avg_price, today_out_kg=r.today_out_kg,
                sub_rows=[
                    ReportSubRowOut(
                        product_grade_label=s.product_grade_label,
                        raw_qty_kg=s.raw_qty_kg,
                        yield_applied=s.yield_applied,
                    ) for s in r.sub_rows
                ],
            )
            for r in data.rows
        ],
    )


@report_router.get("/outbound/{target_date}.xlsx")
async def get_outbound_report_xlsx(
    target_date: date,
    conn: DB,
    user: CurrentUser,
    crop_id: int = Query(2),
):
    """日次 出庫レポート を Excel (.xlsx) で ダウンロード。"""
    data = await build_report_data(conn, target_date, crop_id)
    xlsx_bytes = build_report_xlsx(data)
    filename = f"{target_date.strftime('%Y%m%d')}_outbound_report_crop{crop_id}.xlsx"
    return StreamingResponse(
        iter([xlsx_bytes]),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
