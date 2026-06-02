"""
api/routers/nr_report.py
=========================
NR 原材料使用計算 + 商品 BOM マスタ の API。

エンドポイント:
  GET    /bom                       — 商品 BOM 一覧
  POST   /bom                       — 1 件 upsert
  PATCH  /bom/{code}                — 編集
  DELETE /bom/{code}                — 削除

  POST   /nr-report/expand          — 商品期間集計 Excel アップロード → JSON プレビュー
  POST   /nr-report/export.xlsx     — 同 Excel → 合計表 Excel ダウンロード
"""
from __future__ import annotations

import logging
from decimal import Decimal

from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from datetime import date

from api.audit import write_audit
from api.auth import CurrentUser, OperatorUser
from api.dependencies import DB
from api.services.grade_label import compact_grade_label, compact_grade_label_opt
from api.services.nr_report import (
    ExpansionResult, expand_from_xlsx, build_summary_xlsx,
)
from api.services.substitution import (
    InsufficientSubstitutionStockError,
    NoSubstitutionRulesError,
    SubstitutionService,
)

logger = logging.getLogger(__name__)


# =============================================================================
# BOM CRUD
# =============================================================================
bom_router = APIRouter(prefix="/bom", tags=["商品BOM"])


class BomOut(BaseModel):
    product_code: str
    product_name: str
    crop_id: int
    origin_id: int | None
    origin_text: str | None
    origin_name: str | None       # マスタ突合できた場合 の 正規 origin name
    grade_id_1: int | None
    grade_text_1: str | None
    grade_label_1: str | None     # マスタ突合 表示用
    ratio_1: Decimal
    grade_id_2: int | None
    grade_text_2: str | None
    grade_label_2: str | None
    ratio_2: Decimal | None
    note: str | None
    is_resolved: bool


class BomUpsertRequest(BaseModel):
    product_code: str
    product_name: str
    crop_id: int = 2
    origin_id: int | None = None
    origin_text: str | None = None
    grade_id_1: int | None = None
    grade_text_1: str | None = None
    ratio_1: Decimal = Field(default=Decimal(100), ge=0, le=100)
    grade_id_2: int | None = None
    grade_text_2: str | None = None
    ratio_2: Decimal | None = Field(default=None, ge=0, le=100)
    note: str | None = None


class BomPatchRequest(BaseModel):
    product_name: str | None = None
    origin_id: int | None = None
    grade_id_1: int | None = None
    ratio_1: Decimal | None = Field(default=None, ge=0, le=100)
    grade_id_2: int | None = None
    ratio_2: Decimal | None = Field(default=None, ge=0, le=100)
    note: str | None = None




async def _get_bom(conn, code: str) -> BomOut | None:
    cur = await conn.execute("""
        SELECT pb.*, o.name AS origin_name,
               g1.spec_type AS g1_s, g1.grade_level AS g1_g, g1.size_label AS g1_sz,
               g2.spec_type AS g2_s, g2.grade_level AS g2_g, g2.size_label AS g2_sz
        FROM product_bom pb
        LEFT JOIN origins o  ON o.id  = pb.origin_id
        LEFT JOIN grades  g1 ON g1.id = pb.grade_id_1
        LEFT JOIN grades  g2 ON g2.id = pb.grade_id_2
        WHERE pb.product_code = %s
    """, (code,))
    r = await cur.fetchone()
    if not r: return None
    return BomOut(
        product_code=r['product_code'], product_name=r['product_name'], crop_id=r['crop_id'],
        origin_id=r['origin_id'], origin_text=r['origin_text'], origin_name=r['origin_name'],
        grade_id_1=r['grade_id_1'], grade_text_1=r['grade_text_1'],
        grade_label_1=compact_grade_label_opt(r['g1_s'], r['g1_g'], r['g1_sz']),
        ratio_1=r['ratio_1'],
        grade_id_2=r['grade_id_2'], grade_text_2=r['grade_text_2'],
        grade_label_2=compact_grade_label_opt(r['g2_s'], r['g2_g'], r['g2_sz']),
        ratio_2=r['ratio_2'],
        note=r['note'], is_resolved=r['is_resolved'],
    )


@bom_router.get("", response_model=list[BomOut])
async def list_bom(
    conn: DB, user: CurrentUser,
    crop_id: int = Query(2),
    unresolved_only: bool = Query(False, description="true で 未解決 のみ"),
    search: str | None = Query(None, description="商品コード or 品名 で 部分一致"),
):
    where = ["pb.crop_id = %s"]
    params: list = [crop_id]
    if unresolved_only:
        where.append("pb.is_resolved = false")
    if search:
        where.append("(pb.product_code ILIKE %s OR pb.product_name ILIKE %s)")
        params.append(f"%{search}%"); params.append(f"%{search}%")
    cur = await conn.execute(f"""
        SELECT pb.*, o.name AS origin_name,
               g1.spec_type AS g1_s, g1.grade_level AS g1_g, g1.size_label AS g1_sz,
               g2.spec_type AS g2_s, g2.grade_level AS g2_g, g2.size_label AS g2_sz
        FROM product_bom pb
        LEFT JOIN origins o  ON o.id  = pb.origin_id
        LEFT JOIN grades  g1 ON g1.id = pb.grade_id_1
        LEFT JOIN grades  g2 ON g2.id = pb.grade_id_2
        WHERE {' AND '.join(where)}
        ORDER BY pb.product_code
        LIMIT 500
    """, tuple(params))
    rows = await cur.fetchall()
    return [
        BomOut(
            product_code=r['product_code'], product_name=r['product_name'], crop_id=r['crop_id'],
            origin_id=r['origin_id'], origin_text=r['origin_text'], origin_name=r['origin_name'],
            grade_id_1=r['grade_id_1'], grade_text_1=r['grade_text_1'],
            grade_label_1=compact_grade_label_opt(r['g1_s'], r['g1_g'], r['g1_sz']),
            ratio_1=r['ratio_1'],
            grade_id_2=r['grade_id_2'], grade_text_2=r['grade_text_2'],
            grade_label_2=compact_grade_label_opt(r['g2_s'], r['g2_g'], r['g2_sz']),
            ratio_2=r['ratio_2'],
            note=r['note'], is_resolved=r['is_resolved'],
        )
        for r in rows
    ]


@bom_router.post("", response_model=BomOut)
async def upsert_bom(body: BomUpsertRequest, request: Request, conn: DB, user: OperatorUser):
    # 厳密: grade_id_2 と ratio_2 は両方セットか両方 None
    if body.grade_id_2 is not None and body.ratio_2 is None:
        raise HTTPException(400, "原料2 を 設定する なら ratio_2 も 必須")
    if body.grade_id_2 is None and body.ratio_2 is not None:
        raise HTTPException(400, "ratio_2 を 設定する なら grade_id_2 も 必須")
    # is_resolved = origin と grade_id_1 が両方解決していれば True。
    # (grade_id_2/ratio_2 の整合性は上の validation で保証済み)
    is_resolved = (
        body.origin_id is not None and body.grade_id_1 is not None
    )

    await conn.execute("""
        INSERT INTO product_bom (
            product_code, product_name, crop_id,
            origin_id, origin_text, grade_id_1, grade_text_1, ratio_1,
            grade_id_2, grade_text_2, ratio_2,
            note, is_resolved
        ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        ON CONFLICT (product_code) DO UPDATE SET
            product_name = EXCLUDED.product_name,
            crop_id      = EXCLUDED.crop_id,
            origin_id    = EXCLUDED.origin_id,
            origin_text  = EXCLUDED.origin_text,
            grade_id_1   = EXCLUDED.grade_id_1,
            grade_text_1 = EXCLUDED.grade_text_1,
            ratio_1      = EXCLUDED.ratio_1,
            grade_id_2   = EXCLUDED.grade_id_2,
            grade_text_2 = EXCLUDED.grade_text_2,
            ratio_2      = EXCLUDED.ratio_2,
            note         = EXCLUDED.note,
            is_resolved  = EXCLUDED.is_resolved,
            updated_at   = now()
    """, (
        body.product_code, body.product_name, body.crop_id,
        body.origin_id, body.origin_text, body.grade_id_1, body.grade_text_1, body.ratio_1,
        body.grade_id_2, body.grade_text_2, body.ratio_2,
        body.note, is_resolved,
    ))
    await write_audit(conn, "BOM_UPSERT", "product_bom", body.product_code,
                      body.model_dump(mode='json'), user["id"], request)
    bom = await _get_bom(conn, body.product_code)
    if not bom: raise HTTPException(500, "upsert後に取得失敗")
    return bom


@bom_router.patch("/{code}", response_model=BomOut)
async def patch_bom(code: str, body: BomPatchRequest, request: Request,
                    conn: DB, user: OperatorUser):
    sets, params = [], []
    if body.product_name is not None: sets.append("product_name = %s"); params.append(body.product_name)
    if body.origin_id is not None: sets.append("origin_id = %s"); params.append(body.origin_id)
    if body.grade_id_1 is not None: sets.append("grade_id_1 = %s"); params.append(body.grade_id_1)
    if body.ratio_1 is not None: sets.append("ratio_1 = %s"); params.append(body.ratio_1)
    if body.grade_id_2 is not None: sets.append("grade_id_2 = %s"); params.append(body.grade_id_2)
    if body.ratio_2 is not None: sets.append("ratio_2 = %s"); params.append(body.ratio_2)
    if body.note is not None: sets.append("note = %s"); params.append(body.note)
    if not sets: raise HTTPException(400, "変更項目なし")
    sets.append("updated_at = now()")
    params.append(code)
    cur = await conn.execute(
        f"UPDATE product_bom SET {', '.join(sets)} WHERE product_code = %s RETURNING product_code",
        tuple(params),
    )
    if not await cur.fetchone(): raise HTTPException(404, "BOM 未発見")

    # is_resolved 再計算
    await conn.execute("""
        UPDATE product_bom SET is_resolved = (
            origin_id IS NOT NULL AND grade_id_1 IS NOT NULL AND
            (grade_id_2 IS NULL OR grade_id_2 IS NOT NULL)
        ) WHERE product_code = %s
    """, (code,))

    await write_audit(conn, "BOM_PATCH", "product_bom", code,
                      body.model_dump(exclude_none=True, mode='json'), user["id"], request)
    bom = await _get_bom(conn, code)
    if not bom: raise HTTPException(404, "BOM 未発見")
    return bom


@bom_router.delete("/{code}")
async def delete_bom(code: str, request: Request, conn: DB, user: OperatorUser):
    cur = await conn.execute("DELETE FROM product_bom WHERE product_code = %s RETURNING product_code", (code,))
    if not await cur.fetchone(): raise HTTPException(404, "BOM 未発見")
    await write_audit(conn, "BOM_DELETE", "product_bom", code, {}, user["id"], request)
    return {"ok": True}


# =============================================================================
# NR レポート (Excel 取込 → BOM 展開)
# =============================================================================
nr_router = APIRouter(prefix="/nr-report", tags=["NR原材料使用計算"])


class NrAggRow(BaseModel):
    origin_id: int | None
    origin_text: str
    raw_grade_id: int | None
    raw_grade_label: str
    total_kg: Decimal


class NrWarning(BaseModel):
    excel_row: int
    code: str
    name: str | None
    total_kg: Decimal
    reason: str


class NrExpansionOut(BaseModel):
    input_rows: int
    processed_rows: int
    warning_rows: int
    grand_total_kg: Decimal
    rows: list[NrAggRow]
    warnings: list[NrWarning]


def _result_to_out(result: ExpansionResult) -> NrExpansionOut:
    return NrExpansionOut(
        input_rows=result.meta.input_rows,
        processed_rows=result.meta.processed_rows,
        warning_rows=result.meta.warning_rows,
        grand_total_kg=result.meta.grand_total_kg,
        rows=[
            NrAggRow(
                origin_id=r.origin_id, origin_text=r.origin_text,
                raw_grade_id=r.raw_grade_id, raw_grade_label=r.raw_grade_label,
                total_kg=r.total_kg,
            )
            for r in result.rows
        ],
        warnings=[
            NrWarning(excel_row=w.excel_row, code=w.code, name=w.name,
                      total_kg=w.total_kg, reason=w.reason)
            for w in result.warnings
        ],
    )


@nr_router.post("/expand", response_model=NrExpansionOut)
async def expand(
    conn: DB, user: CurrentUser,
    file: UploadFile = File(...),
    crop_id: int = Query(2),
):
    """商品期間集計 Excel を 取込 → BOM 展開 → 集計結果 JSON。"""
    content = await file.read()
    from io import BytesIO
    result = await expand_from_xlsx(conn, BytesIO(content), crop_id=crop_id)
    return _result_to_out(result)


@nr_router.post("/export.xlsx")
async def export_xlsx(
    conn: DB, user: CurrentUser, request: Request,
    file: UploadFile = File(...),
    crop_id: int = Query(2),
    title: str = Query('原材料使用計算'),
):
    """商品期間集計 Excel を 取込 → 合計表 Excel を ダウンロード。"""
    content = await file.read()
    from io import BytesIO
    result = await expand_from_xlsx(conn, BytesIO(content), crop_id=crop_id)
    xlsx_bytes = build_summary_xlsx(result, title=title)
    filename = f"NR_summary_crop{crop_id}.xlsx"
    return StreamingResponse(
        iter([xlsx_bytes]),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# =============================================================================
# 振替出庫 一括実行 (NR 集計結果 → 全行 を substitution.execute)
# =============================================================================
class BulkRow(BaseModel):
    origin_id:      int
    from_grade_id:  int
    product_qty_kg: Decimal = Field(..., gt=0)
    # 表示用 (audit log / レスポンス で 使う、 オプション)
    label:          str | None = None


class BulkExecuteRequest(BaseModel):
    crop_id:       int = 2
    outbound_date: date
    note:          str | None = None
    rows:          list[BulkRow]


class BulkConsumption(BaseModel):
    lot_id:                 int
    lot_code:               str
    priority_used:          int
    to_grade_id:            int
    to_grade_label:         str
    yield_applied:          Decimal
    raw_qty_kg:             Decimal
    product_qty_covered_kg: Decimal


class BulkLineResult(BaseModel):
    row_index:      int
    label:          str | None
    origin_id:      int
    from_grade_id:  int
    product_qty_kg: Decimal
    order_id:       int | None
    consumption_count: int
    consumptions:   list[BulkConsumption] = []
    covered_product_kg: Decimal | None = None
    is_complete:    bool = True
    error:          str | None = None


class GroupSummary(BaseModel):
    """(origin, to_grade) 単位 の 平均単価 + 残在庫 (= 当該規格 の 在庫情報)"""
    origin_id:           int
    to_grade_id:         int
    avg_unit_price:      Decimal | None
    remaining_after_kg:  Decimal


class BulkExecuteResult(BaseModel):
    total_rows:    int
    success_rows:  int
    failed_rows:   int
    lines:         list[BulkLineResult]
    group_summaries: list[GroupSummary] = []   # NEW: 平均単価 + 残在庫


async def _fetch_grade_labels(conn, ids: set[int]) -> dict[int, str]:
    if not ids: return {}
    cur = await conn.execute(
        "SELECT id, spec_type, grade_level, size_label FROM grades WHERE id = ANY(%s)",
        (list(ids),),
    )
    return {
        r["id"]: compact_grade_label(r["spec_type"], r["grade_level"], r["size_label"])
        for r in await cur.fetchall()
    }


async def _fetch_group_summaries(
    conn, crop_id: int, group_keys: set[tuple[int, int]],
) -> list[GroupSummary]:
    """
    (origin_id, to_grade_id) ごと の:
      ・avg_unit_price = total_kg 加重 平均 unit_price (active lot のみ)
      ・remaining_after_kg = fifo_eligible_lots.remaining_kg 合計
        (substitution 計算後 の 状態 — トランザクション 内で 計算)

    実装: N+1 を 避けるため、 group_keys を 一括 で VALUES に 投げて
    1 クエリで 全 グループ の 集計値を 取得する。
    """
    if not group_keys:
        return []

    # group_keys を parallel array に 展開して unnest で VALUES と 結合
    origin_ids = [g[0] for g in group_keys]
    grade_ids  = [g[1] for g in group_keys]

    cur = await conn.execute("""
        WITH targets AS (
            SELECT * FROM unnest(%s::int[], %s::int[]) AS t(origin_id, grade_id)
        )
        SELECT
            t.origin_id,
            t.grade_id,
            COALESCE(SUM(il.total_kg * il.unit_price)
                     FILTER (WHERE il.unit_price IS NOT NULL), 0) AS price_sum,
            COALESCE(SUM(il.total_kg)
                     FILTER (WHERE il.unit_price IS NOT NULL), 0) AS price_weight,
            COALESCE(SUM(fel.remaining_kg), 0) AS remaining_kg
        FROM targets t
        LEFT JOIN products p
               ON p.crop_id = %s
              AND p.origin_id = t.origin_id
              AND p.grade_id  = t.grade_id
        LEFT JOIN inbound_lots il
               ON il.product_id = p.id
              AND il.archived_at IS NULL
        LEFT JOIN fifo_eligible_lots fel ON fel.lot_id = il.id
        GROUP BY t.origin_id, t.grade_id
    """, (origin_ids, grade_ids, crop_id))

    rows = await cur.fetchall()
    out: list[GroupSummary] = []
    for r in rows:
        weight = Decimal(r['price_weight'] or 0)
        avg = Decimal(r['price_sum']) / weight if weight > 0 else None
        out.append(GroupSummary(
            origin_id=r['origin_id'],
            to_grade_id=r['grade_id'],
            avg_unit_price=avg,
            remaining_after_kg=Decimal(r['remaining_kg'] or 0),
        ))
    return out


def _result_to_bulk_line(i: int, label: str | None, r: BulkRow, res, label_map: dict[int, str]) -> BulkLineResult:
    return BulkLineResult(
        row_index=i, label=label,
        origin_id=r.origin_id, from_grade_id=r.from_grade_id,
        product_qty_kg=r.product_qty_kg,
        order_id=res.order_id,
        consumption_count=len(res.lines),
        covered_product_kg=res.covered_product_kg,
        is_complete=res.is_complete,
        consumptions=[
            BulkConsumption(
                lot_id=l.lot_id, lot_code=l.lot_code,
                priority_used=l.priority_used,
                to_grade_id=l.to_grade_id,
                to_grade_label=label_map.get(l.to_grade_id, ''),
                yield_applied=l.yield_applied,
                raw_qty_kg=l.raw_qty_kg,
                product_qty_covered_kg=l.product_qty_covered_kg,
            )
            for l in res.lines
        ],
        error=None,
    )


@nr_router.post("/preview-as-outbound", response_model=BulkExecuteResult)
async def preview_as_outbound(body: BulkExecuteRequest, conn: DB, user: CurrentUser):
    """
    NR 一括振替 の プレビュー (DB に 一切 書込み しない)。

    実装: substitution.execute() を 各行 で 実行 (= 実 INSERT) → 最後に conn.rollback()。
    SAVEPOINT で 1 行 失敗 しても 他行 を 評価 し続け、 全エラー を まとめて 返す。
    INSERT で 在庫 view (fifo_eligible_lots) の 残量 が 減る ため、
    後行 が 「実際の 実行 と 同じ 順 で lot 消費」 を 正しく 反映 する。
    """
    svc = SubstitutionService(conn)
    results: list[BulkLineResult] = []
    all_to_grade_ids: set[int] = set()

    for i, r in enumerate(body.rows):
        sp = f"sp_nr_preview_{i}"
        await conn.execute(f"SAVEPOINT {sp}")
        try:
            res = await svc.execute(
                crop_id=body.crop_id, origin_id=r.origin_id,
                from_grade_id=r.from_grade_id,
                outbound_date=body.outbound_date,
                product_qty_kg=r.product_qty_kg,
                note='__nr_preview__',  # ローカル文字列 (どうせ rollback)
                actor_id=user["id"],
            )
            # SAVEPOINT 解放 (= 後行 の execute 時に 在庫 反映)
            await conn.execute(f"RELEASE SAVEPOINT {sp}")
            for l in res.lines:
                all_to_grade_ids.add(l.to_grade_id)
            results.append(BulkLineResult(
                row_index=i, label=r.label,
                origin_id=r.origin_id, from_grade_id=r.from_grade_id,
                product_qty_kg=r.product_qty_kg,
                order_id=None,  # preview なので 未確定
                consumption_count=len(res.lines),
                covered_product_kg=res.covered_product_kg,
                is_complete=res.is_complete,
                # consumptions は label_map 取得後に セット
                consumptions=[
                    BulkConsumption(
                        lot_id=l.lot_id, lot_code=l.lot_code,
                        priority_used=l.priority_used,
                        to_grade_id=l.to_grade_id,
                        to_grade_label='',  # 後で 書き換え
                        yield_applied=l.yield_applied,
                        raw_qty_kg=l.raw_qty_kg,
                        product_qty_covered_kg=l.product_qty_covered_kg,
                    )
                    for l in res.lines
                ],
                error=None,
            ))
        except NoSubstitutionRulesError as e:
            await conn.execute(f"ROLLBACK TO SAVEPOINT {sp}")
            results.append(BulkLineResult(
                row_index=i, label=r.label,
                origin_id=r.origin_id, from_grade_id=r.from_grade_id,
                product_qty_kg=r.product_qty_kg,
                order_id=None, consumption_count=0,
                covered_product_kg=Decimal(0), is_complete=False,
                error=f'振替ルール未設定 (origin_id={e.origin_id}, from_grade_id={e.from_grade_id})',
            ))
        except InsufficientSubstitutionStockError as e:
            await conn.execute(f"ROLLBACK TO SAVEPOINT {sp}")
            results.append(BulkLineResult(
                row_index=i, label=r.label,
                origin_id=r.origin_id, from_grade_id=r.from_grade_id,
                product_qty_kg=r.product_qty_kg,
                order_id=None, consumption_count=0,
                covered_product_kg=e.covered_kg, is_complete=False,
                error=f'在庫不足: 要求={e.requested_kg}kg 充足={e.covered_kg}kg 残={e.remaining_kg}kg',
            ))

    # to_grade ラベル 解決 + 結果 に セット
    label_map = await _fetch_grade_labels(conn, all_to_grade_ids)
    for line in results:
        for c in line.consumptions:
            c.to_grade_label = label_map.get(c.to_grade_id, '')

    # (origin, to_grade) 単位 の 平均単価 + 残在庫 を 計算 (rollback 前)
    group_keys: set[tuple[int, int]] = set()
    for line in results:
        for c in line.consumptions:
            group_keys.add((line.origin_id, c.to_grade_id))
    group_summaries = await _fetch_group_summaries(conn, body.crop_id, group_keys)

    # ★ 全 ロールバック (プレビュー = DB 変更なし)
    await conn.rollback()

    return BulkExecuteResult(
        total_rows=len(body.rows),
        success_rows=sum(1 for r in results if r.error is None),
        failed_rows=sum(1 for r in results if r.error is not None),
        lines=results,
        group_summaries=group_summaries,
    )


@nr_router.post("/execute-as-outbound", response_model=BulkExecuteResult,
                status_code=status.HTTP_201_CREATED)
async def execute_as_outbound(body: BulkExecuteRequest, request: Request,
                              conn: DB, user: OperatorUser):
    """
    NR レポートの 集計結果 (各 行 = origin × raw_grade × kg) を まとめて
    振替出庫 として 一括登録 する。

    内部で 各 行 を substitution.execute() に 渡す:
      ・rows[i].from_grade_id = NR の raw_grade_id (= 原料規格)
      ・substitution_rules で priority 1→2→3 フォールバック で 実 lot 引当
      ・全 行 同一トランザクション → 1 行 失敗 = 全部 ロールバック

    在庫不足 / ルール未設定 で 失敗 した 場合 409 + 詳細 を 返す。
    """
    svc = SubstitutionService(conn)
    results: list[BulkLineResult] = []
    all_to_grade_ids: set[int] = set()

    for i, r in enumerate(body.rows):
        try:
            res = await svc.execute(
                crop_id       = body.crop_id,
                origin_id     = r.origin_id,
                from_grade_id = r.from_grade_id,
                outbound_date = body.outbound_date,
                product_qty_kg = r.product_qty_kg,
                note          = body.note or 'NR一括振替',
                actor_id      = user["id"],
            )
            for l in res.lines:
                all_to_grade_ids.add(l.to_grade_id)
            results.append(_result_to_bulk_line(i, r.label, r, res, {}))
        except NoSubstitutionRulesError as e:
            raise HTTPException(status_code=400, detail={
                "code": "NO_SUBSTITUTION_RULES",
                "message": "振替ルール 未設定 — マスタを 先に 設定",
                "row_index": i, "label": r.label,
                "origin_id": e.origin_id, "from_grade_id": e.from_grade_id,
            }) from e
        except InsufficientSubstitutionStockError as e:
            raise HTTPException(status_code=409, detail={
                "code": "INSUFFICIENT_STOCK",
                "message": "振替後 も 在庫不足 — 全 行 ロールバック",
                "row_index": i, "label": r.label,
                "requested_kg": str(e.requested_kg),
                "covered_kg":   str(e.covered_kg),
                "remaining_kg": str(e.remaining_kg),
                "attempted_priorities": e.attempted_priorities,
            }) from e

    # 一括登録 batch_id を 全 order に セット (= 履歴画面 で グループ表示用)
    import uuid
    batch_id = uuid.uuid4()
    order_ids = [l.order_id for l in results if l.order_id is not None]
    if order_ids:
        await conn.execute(
            "UPDATE outbound_orders SET batch_id = %s WHERE id = ANY(%s)",
            (batch_id, order_ids),
        )

    # ラベル 反映 (execute 時 は consumptions が _result_to_bulk_line で 入っているので 再充填)
    label_map = await _fetch_grade_labels(conn, all_to_grade_ids)
    for line in results:
        for c in line.consumptions:
            c.to_grade_label = label_map.get(c.to_grade_id, '')

    # (origin, to_grade) 単位 の 平均単価 + 残在庫
    group_keys: set[tuple[int, int]] = set()
    for line in results:
        for c in line.consumptions:
            group_keys.add((line.origin_id, c.to_grade_id))
    group_summaries = await _fetch_group_summaries(conn, body.crop_id, group_keys)

    await write_audit(conn, "NR_BULK_OUTBOUND", "outbound_orders",
                      ",".join(str(o) for o in order_ids),
                      {"crop_id": body.crop_id, "outbound_date": body.outbound_date.isoformat(),
                       "row_count": len(body.rows), "note": body.note,
                       "batch_id": str(batch_id)},
                      user["id"], request)

    return BulkExecuteResult(
        total_rows=len(body.rows),
        success_rows=sum(1 for r in results if r.error is None),
        failed_rows=sum(1 for r in results if r.error is not None),
        lines=results,
        group_summaries=group_summaries,
    )
