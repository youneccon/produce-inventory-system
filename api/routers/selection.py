"""
api/routers/selection.py
========================
選別（仕分け）API — 新仕様 (2026-05 〜)。

新仕様:
  - 投入は 1 つまたは複数のロット (selection_sources で記録)
  - 出力は 半製品台帳 (semifinished_lots) に新規ロットとして登録 (mig 065〜)
    * inbound_date = 投入ロットの入荷日 (複数なら最古)
    * unit_price   = 投入の加重平均 (全出力規格で同じ)
    * source_outbound_id = NULL (選別由来)、 selection_id = この選別の id
    * code         = 半製品コード (例 '02H00001')
  - 投入ロットの total_kg は変えない、 代わりに outbound_records に出庫を 2 行記録
    * 有効産出分 (consume): purpose='selection', kind='selection_consume'
    * ロス分     (disposal): purpose='selection', kind='selection_disposal'
    * → 過去月の前月繰越 (stock_counts) は不変
  - サマリー集計: 入荷量/件数は selection_id IS NULL でフィルタ (二重計上防止)

エンドポイント:
  GET  /crops                          - 作物一覧
  GET  /selection/source-lots          - ソース候補（残量 > 0）
  GET  /selection/reference-prices     - 出力候補の参考単価 (互換維持)
  GET  /selection/output-spec-types    - 出力候補規格一覧
  POST /selection/compute              - 加重平均単価プレビュー
  POST /selection/operations           - 選別を確定登録
  GET  /selection/operations           - 選別履歴一覧
  GET  /selection/operations/{id}      - 選別詳細
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from api.audit import write_audit
from api.auth import AdminUser, CurrentUser
from api.dependencies import DB

router = APIRouter(tags=["選別"])


# =============================================================================
# モデル
# =============================================================================

class CropOut(BaseModel):
    id:   int
    code: str
    name: str


class SourceLotOut(BaseModel):
    lot_id:        int
    code:          str
    crop_id:       int
    crop_name:     str
    inbound_date:  date
    supplier_id:   int
    supplier_name: str
    spec_type:     str
    grade_level:   str
    size_label:    str
    origin_id:     int
    origin_name:   str
    remaining_kg:  Decimal
    unit_price:    Decimal | None


class ReferencePriceOut(BaseModel):
    grade_id:      int
    spec_type:     str
    grade_level:   str
    size_label:    str
    origin_id:     int
    origin_name:   str
    product_id:    int
    reference_price: Decimal | None
    reference_lot_code: str | None
    reference_lot_date: date | None


class SelectionSourceInput(BaseModel):
    lot_id:    int
    source_kg: Decimal = Field(..., gt=0)


class SelectionOutputInput(BaseModel):
    product_id: int
    quantity_kg: Decimal = Field(..., gt=0)
    note: str | None = None


class SelectionComputeRequest(BaseModel):
    sources: list[SelectionSourceInput] = Field(..., min_length=1)
    outputs: list[SelectionOutputInput] = Field(..., min_length=1)


class SelectionComputeResult(BaseModel):
    sources_total_kg:      Decimal      # = Σ source_kg
    outputs_total_kg:      Decimal      # = Σ output_kg
    disposal_kg:           Decimal      # = sources − outputs (>= 0)
    weighted_unit_price:   Decimal | None   # 産出単価 (非ゴミ output 共通の単価)
    sources_total_value:   Decimal      # 投入総価額 = Σ(投入kg × 単価)
    output_total_value:    Decimal      # 出力総価額 (= 投入総価額、 整合性保証)
    per_source: list[dict]              # 各投入の按分内訳 (consume_kg, disposal_kg)
    # 2026-05: 選別ゴミ 仕様追加
    output_unit_prices:    list[Decimal] = []   # 各 output の単価 (ゴミ=0)
    garbage_total_kg:      Decimal = Decimal(0)
    non_garbage_total_kg:  Decimal = Decimal(0)
    distinct_supplier_count: int
    distinct_origin_count:   int
    earliest_inbound_date:   date | None


class SelectionOperationCreate(BaseModel):
    sources:        list[SelectionSourceInput] = Field(..., min_length=1)
    outputs:        list[SelectionOutputInput] = Field(..., min_length=1)
    operation_date: date
    note:           str | None = None


class SelectionOperationOut(BaseModel):
    id:                int
    code:              str
    crop_id:           int
    crop_name:         str
    operation_date:    date
    weighted_unit_price: Decimal | None
    note:              str | None
    created_at:        str
    sources:           list[dict]
    output_lots:       list[dict]


# =============================================================================
# 作物
# =============================================================================

@router.get("/crops", response_model=list[CropOut])
async def list_crops(db: DB, user: CurrentUser):
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT id, code, name FROM crops WHERE is_active ORDER BY code"
        )
        return [CropOut(**r) for r in await cur.fetchall()]


# =============================================================================
# 選別ソース候補
# =============================================================================

@router.get("/selection/source-lots", response_model=list[SourceLotOut])
async def list_source_lots(
    db: DB,
    user: CurrentUser,
    crop_id: int = Query(..., description="対象作物ID"),
    spec_type: str | None = Query(None, description="規格でフィルタ"),
):
    """選別ソース候補。 crop で絞り、残量>0 の (= まだ選別可能な) ロットのみ。"""
    conds = ["p.crop_id = %s", "ls.remaining_kg > 0"]
    params: list = [crop_id]
    if spec_type:
        conds.append("g.spec_type = %s")
        params.append(spec_type)

    async with db.cursor() as cur:
        await cur.execute(f"""
            SELECT
                il.id            AS lot_id,
                il.code,
                p.crop_id,
                c.name           AS crop_name,
                il.inbound_date,
                s.id             AS supplier_id,
                s.name           AS supplier_name,
                g.spec_type, g.grade_level, g.size_label,
                o.id             AS origin_id,
                o.name           AS origin_name,
                ls.remaining_kg,
                il.unit_price
            FROM inbound_lots il
            JOIN products  p  ON p.id = il.product_id
            JOIN crops     c  ON c.id = p.crop_id
            JOIN grades    g  ON g.id = p.grade_id
            JOIN origins   o  ON o.id = p.origin_id
            JOIN suppliers s  ON s.id = il.supplier_id
            JOIN lot_stock ls ON ls.lot_id = il.id
            WHERE {' AND '.join(conds)}
            ORDER BY il.inbound_date ASC, il.id ASC
        """, params)
        rows = await cur.fetchall()
    return [SourceLotOut(**r) for r in rows]


# =============================================================================
# 参考単価 (互換維持: フロントの参考価格表示用)
# =============================================================================

@router.get("/selection/reference-prices", response_model=list[ReferencePriceOut])
async def get_reference_prices(
    db: DB,
    user: CurrentUser,
    crop_id: int = Query(...),
    origin_id: int = Query(...),
    target_spec_type: str | None = Query('標準'),
):
    """出力候補 (同 crop × origin × spec_type) の参考単価。
    新仕様では単価は投入加重平均で自動算出されるため、 これは表示のみ。"""
    show_all_spec = (target_spec_type is None
                     or target_spec_type == ''
                     or target_spec_type == '__all__')
    spec_filter_clause = '' if show_all_spec else 'AND g.spec_type = %(spec)s'
    params: dict = {'crop_id': crop_id, 'origin_id': origin_id}
    if not show_all_spec:
        params['spec'] = target_spec_type
    async with db.cursor() as cur:
        await cur.execute(f"""
            WITH candidates AS (
                SELECT
                    g.id           AS grade_id,
                    g.spec_type, g.grade_level, g.size_label,
                    o.id           AS origin_id,
                    o.name         AS origin_name,
                    p.id           AS product_id
                FROM products p
                JOIN grades   g ON g.id = p.grade_id
                JOIN origins  o ON o.id = p.origin_id
                WHERE p.crop_id   = %(crop_id)s
                  AND p.origin_id = %(origin_id)s
                  {spec_filter_clause}
                  AND p.is_active
            ),
            latest_price AS (
                SELECT DISTINCT ON (il.product_id)
                    il.product_id,
                    il.unit_price,
                    il.code AS lot_code,
                    il.inbound_date
                FROM inbound_lots il
                WHERE il.unit_price IS NOT NULL
                ORDER BY il.product_id, il.inbound_date DESC, il.id DESC
            )
            SELECT
                c.*,
                lp.unit_price   AS reference_price,
                lp.lot_code     AS reference_lot_code,
                lp.inbound_date AS reference_lot_date
            FROM candidates c
            LEFT JOIN latest_price lp ON lp.product_id = c.product_id
            ORDER BY c.spec_type, c.grade_level, c.size_label
        """, params)
        rows = await cur.fetchall()
    return [ReferencePriceOut(**r) for r in rows]


@router.get("/selection/output-spec-types", response_model=list[str])
async def list_output_spec_types(
    db: DB, user: CurrentUser,
    crop_id: int | None = Query(None),
):
    async with db.cursor() as cur:
        if crop_id is not None:
            await cur.execute("""
                SELECT DISTINCT g.spec_type
                FROM grades g
                JOIN products p ON p.grade_id = g.id
                WHERE p.crop_id = %s AND p.is_active
                ORDER BY g.spec_type
            """, (crop_id,))
        else:
            await cur.execute(
                "SELECT DISTINCT spec_type FROM grades ORDER BY spec_type")
        out = [r["spec_type"] for r in await cur.fetchall()]
    if "標準" not in out:
        out.insert(0, "標準")
    return out


# =============================================================================
# 計算ヘルパー
# =============================================================================

# =============================================================================
# 選別ゴミ 規格 の 識別 (2026-05 仕様)
# =============================================================================
# 「選別ゴミ」 grade を 持つ product は 出力 lot の 単価を 0 に 強制 し、
# 半製品台帳 では 既定 非表示 にする。 mig 068 で grade を 追加 済み。
GARBAGE_SPEC_TYPE = '選別ゴミ'


async def _fetch_outputs_meta(cur, outputs: list[SelectionOutputInput]) -> list[dict]:
    """各 output の product から grade.spec_type を 取得し is_garbage を 判定。
    返却 dict: { product_id, quantity_kg, note, is_garbage }
    """
    product_ids = list({o.product_id for o in outputs})
    if not product_ids:
        return []
    await cur.execute("""
        SELECT p.id AS product_id, g.spec_type
        FROM products p
        JOIN grades g ON g.id = p.grade_id
        WHERE p.id = ANY(%s)
    """, (product_ids,))
    rows = await cur.fetchall()
    spec_by_pid = {r["product_id"]: r["spec_type"] for r in rows}
    missing = set(product_ids) - set(spec_by_pid.keys())
    if missing:
        raise HTTPException(status.HTTP_404_NOT_FOUND,
                            detail=f"出力先商品が見つかりません: {sorted(missing)}")
    return [
        {
            "product_id":  o.product_id,
            "quantity_kg": o.quantity_kg,
            "note":        o.note,
            "is_garbage":  spec_by_pid.get(o.product_id) == GARBAGE_SPEC_TYPE,
        }
        for o in outputs
    ]


async def _fetch_sources_meta(cur, sources: list[SelectionSourceInput]) -> list[dict]:
    """投入ロットの メタ情報 + 残量 を一括取得。"""
    lot_ids = [s.lot_id for s in sources]
    await cur.execute("""
        SELECT il.id, il.code, il.unit_price, il.inbound_date,
               il.supplier_id, p.origin_id, p.crop_id,
               ls.remaining_kg,
               c.code AS crop_code
        FROM inbound_lots il
        JOIN products p  ON p.id = il.product_id
        JOIN crops    c  ON c.id = p.crop_id
        JOIN lot_stock ls ON ls.lot_id = il.id
        WHERE il.id = ANY(%s)
    """, (lot_ids,))
    rows = {r["id"]: r for r in await cur.fetchall()}
    if len(rows) != len(set(lot_ids)):
        missing = set(lot_ids) - set(rows.keys())
        raise HTTPException(status.HTTP_404_NOT_FOUND,
                            detail=f"投入ロットが見つかりません: {sorted(missing)}")
    # 残量チェック
    for s in sources:
        rem = rows[s.lot_id]["remaining_kg"]
        if s.source_kg > rem:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail=f"在庫不足: ロット {rows[s.lot_id]['code']} 残量 {rem}kg < 投入 {s.source_kg}kg")
    return [{**rows[s.lot_id], "input_kg": s.source_kg} for s in sources]


def _compute(sources_meta: list[dict], outputs_meta: list[dict]) -> dict:
    """投入総評価額 = 出力総評価額 を 保証する 単価計算。
    各投入の consume/disposal kg は 産出比 で 按分。

    2026-05 仕様変更:
      - 「選別ゴミ」 grade の output は 単価 強制 0
      - 非ゴミ output は 全部 同単価 = 投入総評価額 / 非ゴミ出力総量
      - 全部ゴミ の 場合 は shared_price=None (= 投入価値は ロス計上)

    引数:
      outputs_meta: [{product_id, quantity_kg, note, is_garbage}, ...]
        (is_garbage は _fetch_outputs_meta で 算出 済み)
    """
    sources_total = sum((Decimal(s["input_kg"]) for s in sources_meta), Decimal(0))
    outputs_total = sum((Decimal(o["quantity_kg"]) for o in outputs_meta), Decimal(0))
    if outputs_total > sources_total:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"出力総量 {outputs_total}kg が投入総量 {sources_total}kg を超えています")
    disposal_total = sources_total - outputs_total

    # 投入総評価額 = Σ(投入kg × 単価)。 NULL 単価は 0 として扱う。
    sum_value = Decimal(0)
    has_price = False
    for s in sources_meta:
        up = s["unit_price"]
        if up is not None:
            sum_value += Decimal(up) * Decimal(s["input_kg"])
            has_price = True

    # 非ゴミ出力総量 で 投入総評価額 を 按分 (= shared_price)
    non_garbage_total = sum(
        (Decimal(o["quantity_kg"]) for o in outputs_meta if not o["is_garbage"]),
        Decimal(0),
    )
    if has_price and non_garbage_total > 0:
        shared_price = (sum_value / non_garbage_total).quantize(Decimal("0.01"))
    else:
        # 全部ゴミ or 投入単価 なし → 出力単価は 0
        shared_price = None

    # 各 output の 単価: ゴミ=0、 非ゴミ=shared_price
    output_unit_prices = [
        Decimal(0) if o["is_garbage"]
        else (shared_price if shared_price is not None else Decimal(0))
        for o in outputs_meta
    ]

    # 各投入の按分 (投入量に比例して consume/disposal を分ける)
    per_source = []
    consume_ratio = outputs_total / sources_total if sources_total > 0 else Decimal(0)
    sum_consume = Decimal(0)
    sum_disposal = Decimal(0)
    for i, s in enumerate(sources_meta):
        is_last = (i == len(sources_meta) - 1)
        input_kg = Decimal(s["input_kg"])
        if is_last:
            # 丸め誤差を最後の行で吸収
            c_kg = (outputs_total - sum_consume).quantize(Decimal("0.0001"))
            d_kg = (disposal_total - sum_disposal).quantize(Decimal("0.0001"))
        else:
            c_kg = (input_kg * consume_ratio).quantize(Decimal("0.0001"))
            d_kg = (input_kg - c_kg).quantize(Decimal("0.0001"))
        sum_consume += c_kg
        sum_disposal += d_kg
        per_source.append({
            "lot_id":      s["id"],
            "code":        s["code"],
            "source_kg":   float(input_kg),
            "consume_kg":  float(c_kg),
            "disposal_kg": float(d_kg),
        })

    distinct_supplier = len({s["supplier_id"] for s in sources_meta})
    distinct_origin   = len({s["origin_id"] for s in sources_meta})
    earliest_date     = min(s["inbound_date"] for s in sources_meta) if sources_meta else None

    # 投入総評価額 = Σ(投入kg × 単価)
    # 出力総評価額 = Σ(各output.qty × 各output.unit_price)
    #              = 非ゴミ合計×shared_price + ゴミ×0
    #              = non_garbage_total × shared_price
    #              = sum_value  (整合性 保証)
    return {
        "sources_total_kg":    sources_total,
        "outputs_total_kg":    outputs_total,
        "disposal_kg":         disposal_total,
        "weighted_unit_price": shared_price,
        "sources_total_value": sum_value.quantize(Decimal("0.01")),
        "output_total_value":  sum_value.quantize(Decimal("0.01")),  # 投入総評価額と一致
        "per_source":          per_source,
        "output_unit_prices":  output_unit_prices,                   # ★ 新規 (各output 単価)
        "garbage_total_kg":    (outputs_total - non_garbage_total),  # ★ 新規 (ゴミ量合計)
        "non_garbage_total_kg": non_garbage_total,                   # ★ 新規 (非ゴミ量合計)
        "distinct_supplier_count": distinct_supplier,
        "distinct_origin_count":   distinct_origin,
        "earliest_inbound_date":   earliest_date,
    }


@router.post("/selection/compute", response_model=SelectionComputeResult)
async def compute_selection(body: SelectionComputeRequest, db: DB, user: CurrentUser):
    """加重平均単価 + 投入按分プレビュー (コミット無し)。
    2026-05: 出力に 「選別ゴミ」 grade product が 含まれる場合 単価強制 0。"""
    async with db.cursor() as cur:
        sources_meta = await _fetch_sources_meta(cur, body.sources)
        outputs_meta = await _fetch_outputs_meta(cur, body.outputs)
    # 作物一致チェック
    crop_ids = {s["crop_id"] for s in sources_meta}
    if len(crop_ids) > 1:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail=f"投入ロットの作物が混在しています: {crop_ids}")
    result = _compute(sources_meta, outputs_meta)
    return SelectionComputeResult(**result)


# =============================================================================
# 選別の確定登録
# =============================================================================

@router.post(
    "/selection/operations",
    response_model=SelectionOperationOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_selection(body: SelectionOperationCreate, db: DB,
                           admin: AdminUser, request: Request):
    """選別を確定登録する (admin only)。 1 トランザクションで:
       1. selection_operations ヘッダー INSERT (代表 source = 最古 lot)
       2. selection_sources INSERT (投入ごと, consume_kg/disposal_kg)
       3. outbound_records INSERT × N×2 (consume + disposal を投入比で按分)
       4. inbound_lots INSERT (出力規格ごと、 selection_id 付き、 加重平均単価)
    """
    async with db.cursor() as cur:
        sources_meta = await _fetch_sources_meta(cur, body.sources)
        outputs_meta = await _fetch_outputs_meta(cur, body.outputs)

        # 作物一致チェック
        crop_ids = {s["crop_id"] for s in sources_meta}
        if len(crop_ids) > 1:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                                detail=f"投入ロットの作物が混在しています: {crop_ids}")
        crop_id = crop_ids.pop()
        crop_code = sources_meta[0]["crop_code"]
        await cur.execute("SELECT name FROM crops WHERE id=%s", (crop_id,))
        crop_name = (await cur.fetchone())["name"]

        # 出力先 product の crop 整合性
        product_ids = [o.product_id for o in body.outputs]
        await cur.execute(
            "SELECT id, crop_id FROM products WHERE id = ANY(%s)",
            (product_ids,))
        prods = {p["id"]: p for p in await cur.fetchall()}
        if len(prods) != len(set(product_ids)):
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                detail="出力先商品の一部が見つかりません")
        for pid in product_ids:
            if prods[pid]["crop_id"] != crop_id:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=f"出力先商品 (id={pid}) の作物がソースと一致しません")

        # 計算 — 2026-05: outputs_meta (is_garbage 含む) を渡し、 ゴミ単価は 0 強制
        comp = _compute(sources_meta, outputs_meta)
        weighted = comp["weighted_unit_price"]
        per_output_prices = comp["output_unit_prices"]   # list[Decimal] — body.outputs と 同順

        # 代表ソース = 最古入荷日のロット
        primary = min(sources_meta, key=lambda s: (s["inbound_date"], s["id"]))
        primary_supplier_id = primary["supplier_id"]
        earliest_date = comp["earliest_inbound_date"]

        # 1) selection_operations
        await cur.execute("SELECT next_selection_code() AS c")
        sel_code = (await cur.fetchone())["c"]
        await cur.execute("""
            INSERT INTO selection_operations
                (code, crop_id, operation_date,
                 source_lot_id, source_kg, source_unit_price,
                 total_cost, weighted_unit_price,
                 note, created_by)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            RETURNING id, created_at
        """, (sel_code, crop_id, body.operation_date,
              primary["id"], comp["sources_total_kg"], primary["unit_price"],
              comp["output_total_value"], weighted,
              body.note, admin["id"]))
        op = await cur.fetchone()
        op_id = op["id"]

        # 2) selection_sources + 3) outbound_records (consume + disposal)
        sources_out: list[dict] = []
        for ps in comp["per_source"]:
            consume_kg = Decimal(str(ps["consume_kg"]))
            disposal_kg = Decimal(str(ps["disposal_kg"]))

            consume_id = None
            disposal_id = None

            if consume_kg > 0:
                await cur.execute("""
                    INSERT INTO outbound_records
                        (lot_id, selection_id, outbound_date, quantity_kg,
                         purpose, kind, note, created_by)
                    VALUES (%s, %s, %s, %s, 'selection', 'selection_consume', %s, %s)
                    RETURNING id
                """, (ps["lot_id"], op_id, body.operation_date,
                      consume_kg, f'選別投入 ({sel_code})', admin["id"]))
                consume_id = (await cur.fetchone())["id"]

            if disposal_kg > 0:
                await cur.execute("""
                    INSERT INTO outbound_records
                        (lot_id, selection_id, outbound_date, quantity_kg,
                         purpose, kind, note, created_by)
                    VALUES (%s, %s, %s, %s, 'selection', 'selection_disposal', %s, %s)
                    RETURNING id
                """, (ps["lot_id"], op_id, body.operation_date,
                      disposal_kg, f'選別ロス ({sel_code})', admin["id"]))
                disposal_id = (await cur.fetchone())["id"]

            await cur.execute("""
                INSERT INTO selection_sources
                    (selection_id, lot_id, source_kg, consume_kg, disposal_kg,
                     consume_outbound_id, disposal_outbound_id)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
            """, (op_id, ps["lot_id"], Decimal(str(ps["source_kg"])),
                  consume_kg, disposal_kg, consume_id, disposal_id))
            sources_out.append({
                "lot_id": ps["lot_id"], "code": ps["code"],
                "source_kg": ps["source_kg"],
                "consume_kg": ps["consume_kg"],
                "disposal_kg": ps["disposal_kg"],
            })

        # 4) 出力ロットを 半製品台帳 (semifinished_lots) に新規登録
        #    (mig 065 で source_outbound_id nullable 化 + selection_id 追加 済み)
        #    cases / kg_per_case は 人工的に 1 × qty。
        #    単価: 通常 output = shared_price、 ゴミ output = 0 (per_output_prices[i] を採用)
        output_lots: list[dict] = []
        for i, o in enumerate(body.outputs):
            this_price = per_output_prices[i]
            is_garbage = outputs_meta[i]["is_garbage"]
            await cur.execute("SELECT next_semifinished_code(%s) AS c", (crop_code,))
            new_code = (await cur.fetchone())["c"]
            note_tag = "選別ゴミ生成" if is_garbage else "選別生成"
            await cur.execute("""
                INSERT INTO semifinished_lots
                    (code, source_outbound_id, selection_id, product_id,
                     inbound_date, cases, kg_per_case, total_kg, unit_price,
                     price_confirmed_at, price_confirmed_by, note, created_by)
                VALUES (%s, NULL, %s, %s, %s, %s, %s, %s, %s, now(), %s, %s, %s)
                RETURNING id, code
            """, (new_code, op_id, o.product_id, earliest_date,
                  Decimal("1"), o.quantity_kg, o.quantity_kg, this_price,
                  admin["id"],
                  f"{note_tag} ({sel_code})" + (f" / {o.note}" if o.note else ""),
                  admin["id"]))
            new_lot = await cur.fetchone()
            output_lots.append({
                "lot_id":       new_lot["id"],
                "code":         new_lot["code"],
                "product_id":   o.product_id,
                "total_kg":     float(o.quantity_kg),
                "unit_price":   float(this_price),
                "is_garbage":   is_garbage,
            })

    await write_audit(db, "SELECTION_CREATE", "selection_operations", str(op_id),
                      {"selection_code": sel_code,
                       "source_count":   len(sources_out),
                       "output_count":   len(output_lots),
                       "sources_total_kg": float(comp["sources_total_kg"]),
                       "outputs_total_kg": float(comp["outputs_total_kg"]),
                       "disposal_kg":    float(comp["disposal_kg"])},
                      admin["id"], request)

    return SelectionOperationOut(
        id=op_id, code=sel_code,
        crop_id=crop_id, crop_name=crop_name,
        operation_date=body.operation_date,
        weighted_unit_price=weighted,
        note=body.note,
        created_at=op["created_at"].isoformat(),
        sources=sources_out,
        output_lots=output_lots,
    )


# =============================================================================
# 履歴照会
# =============================================================================

@router.get("/selection/operations")
async def list_selection_operations(
    db: DB,
    user: CurrentUser,
    crop_id: int | None = Query(None),
    date_from: date | None = Query(None),
    date_to:   date | None = Query(None),
    limit:     int = Query(50, ge=1, le=200),
):
    conds, params = ["1=1"], []
    if crop_id is not None:
        params.append(crop_id); conds.append("so.crop_id = %s")
    if date_from is not None:
        params.append(date_from); conds.append("so.operation_date >= %s")
    if date_to is not None:
        params.append(date_to);   conds.append("so.operation_date <= %s")
    params.append(limit)

    async with db.cursor() as cur:
        await cur.execute(f"""
            SELECT so.id, so.code, so.crop_id, so.operation_date,
                   so.weighted_unit_price, so.note, so.created_at,
                   c.name AS crop_name,
                   u.display_name AS created_by_name,
                   (SELECT COUNT(*)            FROM selection_sources WHERE selection_id = so.id) AS source_count,
                   (SELECT COALESCE(SUM(source_kg), 0)
                                              FROM selection_sources WHERE selection_id = so.id) AS sources_total_kg,
                   (SELECT COALESCE(SUM(disposal_kg), 0)
                                              FROM selection_sources WHERE selection_id = so.id) AS disposal_kg,
                   (SELECT COUNT(*)           FROM semifinished_lots WHERE selection_id = so.id) AS output_count,
                   (SELECT COALESCE(SUM(total_kg), 0)
                                              FROM semifinished_lots WHERE selection_id = so.id) AS outputs_total_kg
            FROM selection_operations so
            JOIN crops c  ON c.id = so.crop_id
            LEFT JOIN users u ON u.id = so.created_by
            WHERE {' AND '.join(conds)}
            ORDER BY so.operation_date DESC, so.id DESC
            LIMIT %s
        """, params)
        rows = await cur.fetchall()
    return [dict(r) for r in rows]


@router.get("/selection/operations/{op_id}")
async def get_selection_operation(op_id: int, db: DB, user: CurrentUser):
    """選別 1 件の詳細 (ヘッダー + 投入明細 + 出力ロット明細)。"""
    async with db.cursor() as cur:
        await cur.execute("""
            SELECT so.*, c.name AS crop_name,
                   u.display_name AS created_by_name
            FROM selection_operations so
            JOIN crops c ON c.id = so.crop_id
            LEFT JOIN users u ON u.id = so.created_by
            WHERE so.id = %s
        """, (op_id,))
        op = await cur.fetchone()
        if op is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                detail=f"選別 id={op_id} が見つかりません")

        # 投入明細
        await cur.execute("""
            SELECT ss.lot_id, ss.source_kg, ss.consume_kg, ss.disposal_kg,
                   il.code, il.inbound_date,
                   s.id AS supplier_id, s.name AS supplier_name,
                   g.spec_type, g.grade_level, g.size_label,
                   o.id AS origin_id, o.name AS origin_name,
                   il.unit_price
            FROM selection_sources ss
            JOIN inbound_lots il ON il.id = ss.lot_id
            JOIN products p ON p.id = il.product_id
            JOIN grades g ON g.id = p.grade_id
            JOIN origins o ON o.id = p.origin_id
            JOIN suppliers s ON s.id = il.supplier_id
            WHERE ss.selection_id = %s
            ORDER BY il.inbound_date, ss.id
        """, (op_id,))
        sources = [dict(r) for r in await cur.fetchall()]

        # 出力明細 (semifinished_lots — 選別出力先、 mig 065〜)
        await cur.execute("""
            SELECT sl.id AS lot_id, sl.code, sl.total_kg, sl.unit_price,
                   sl.inbound_date, sl.note,
                   g.spec_type, g.grade_level, g.size_label,
                   o.name AS origin_name
            FROM semifinished_lots sl
            JOIN products p ON p.id = sl.product_id
            JOIN grades   g ON g.id = p.grade_id
            JOIN origins  o ON o.id = p.origin_id
            WHERE sl.selection_id = %s
            ORDER BY sl.id
        """, (op_id,))
        outputs = [dict(r) for r in await cur.fetchall()]

    return {
        **dict(op),
        "sources": sources,
        "outputs": outputs,
    }


# =============================================================================
# 選別由来ロットの 投入情報サマリ (在庫一覧の バッジ ホバー用)
# =============================================================================

@router.get("/selection/lot/{lot_id}/source-info")
async def get_selection_source_info(lot_id: int, db: DB, user: CurrentUser):
    """ある選別由来 inbound_lot について、 投入元の情報サマリを返す。
       バッジ ホバー時のツールチップ表示用。"""
    async with db.cursor() as cur:
        await cur.execute("""
            SELECT il.selection_id, so.code AS selection_code,
                   so.operation_date AS selection_date,
                   so.weighted_unit_price
            FROM inbound_lots il
            LEFT JOIN selection_operations so ON so.id = il.selection_id
            WHERE il.id = %s
        """, (lot_id,))
        r = await cur.fetchone()
        if r is None or r["selection_id"] is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                detail="選別由来ロットではありません")
        sel_id = r["selection_id"]

        await cur.execute("""
            SELECT ss.source_kg, ss.consume_kg, ss.disposal_kg,
                   src.code AS lot_code, src.inbound_date,
                   s.name AS supplier_name, o.name AS origin_name
            FROM selection_sources ss
            JOIN inbound_lots src ON src.id = ss.lot_id
            JOIN suppliers s ON s.id = src.supplier_id
            JOIN products p ON p.id = src.product_id
            JOIN origins  o ON o.id = p.origin_id
            WHERE ss.selection_id = %s
            ORDER BY src.inbound_date, ss.id
        """, (sel_id,))
        sources = [dict(row) for row in await cur.fetchall()]

    return {
        "selection_code": r["selection_code"],
        "selection_date": r["selection_date"],
        "weighted_unit_price": r["weighted_unit_price"],
        "sources": sources,
    }
