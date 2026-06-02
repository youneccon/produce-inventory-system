"""
api/routers/storage.py
======================
資材/原料の保管レイアウト機能 API。

エンドポイント:
  GET    /storage/layouts                        - レイアウト一覧
  POST   /storage/layouts                        - レイアウト作成
  GET    /storage/layouts/{id}                   - レイアウト1件
  PUT    /storage/layouts/{id}                   - レイアウト更新
  DELETE /storage/layouts/{id}                   - レイアウト削除
  POST   /storage/layouts/{id}/image             - 画像アップロード（multipart）
  GET    /storage/layouts/{id}/state             - 全オブジェクト + 在庫を含む状態
  POST   /storage/objects                        - オブジェクト追加
  PUT    /storage/objects/{id}                   - オブジェクト更新（位置・サイズ・ラベル等）
  DELETE /storage/objects/{id}                   - オブジェクト削除
  POST   /storage/objects/{id}/items             - リンク追加（資材または原料ロット）
  PUT    /storage/items/{id}                     - リンク更新（capacity / priority）
  DELETE /storage/items/{id}                     - リンク解除
"""

import json
import os
import uuid
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, Query, Request, UploadFile, status
from pydantic import BaseModel, Field

from api.audit import write_audit
from api.auth import AdminUser, CurrentUser, OperatorUser
from api.dependencies import DB

router = APIRouter(prefix="/storage", tags=["保管レイアウト"])

UPLOADS_DIR = Path(__file__).resolve().parents[2] / "uploads" / "storage_layouts"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}
MAX_UPLOAD_BYTES = 8 * 1024 * 1024  # 8MB


# =============================================================================
# モデル
# =============================================================================

class LayoutCreate(BaseModel):
    name: str = Field(..., min_length=1)
    division: int | None = None
    target_kind: str = Field("material", pattern=r"^(material|ingredient)$")
    note: str | None = None


class LayoutUpdate(BaseModel):
    name: str | None = None
    division: int | None = None
    note: str | None = None
    is_active: bool | None = None
    floor_outline: list[list[float]] | None = None    # [[x, y], ...]


class LayoutOut(BaseModel):
    id: int
    name: str
    division: int | None
    target_kind: str
    image_url: str | None
    image_width: int | None
    image_height: int | None
    note: str | None
    is_active: bool
    floor_outline: list[list[float]] | None = None


class ObjectCreate(BaseModel):
    layout_id: int
    label: str | None = None
    x: float = Field(..., ge=0)
    y: float = Field(..., ge=0)
    width:  float = Field(80, gt=0)
    height: float = Field(60, gt=0)
    color: str | None = None
    note: str | None = None
    orientation: int = Field(0, ge=0, le=90)   # 0 or 90 (ingredient パレット用)
    pallet_tiers: int = Field(7, ge=6, le=7)   # 6 or 7 (パレット段数)
    # 物理 タイプ: 'pallet' (既定) or 'steel_container' (長芋 用 スチール 籠)。
    # steel_container は pallet_tiers / orientation を 無視 し、 紐付け 数 = 段数。
    object_type: str = Field('pallet', pattern=r'^(pallet|steel_container)$')


class ObjectUpdate(BaseModel):
    label: str | None = None
    x: float | None = None
    y: float | None = None
    width: float | None = None
    height: float | None = None
    color: str | None = None
    note: str | None = None
    orientation: int | None = Field(None, ge=0, le=90)
    pallet_tiers: int | None = Field(None, ge=6, le=7)
    object_type: str | None = Field(None, pattern=r'^(pallet|steel_container)$')


class PalletDetail(BaseModel):
    """1 パレット の 「積み切った 段数」 + 「上の 端ケース 数」"""
    t: int = Field(..., ge=0, le=7)
    c: int = Field(..., ge=0, le=6)


class ItemCreate(BaseModel):
    object_id: int
    material_id: int | None = None
    inbound_lot_id: int | None = None
    semifinished_lot_id: int | None = None
    capacity: float | None = None
    priority: int = Field(50, ge=0, le=100)
    note: str | None = None
    # 旧 model: pallet_details 配列 (= 1 binding に 複数パレ 集約)。 deprecated。
    pallet_details: list[PalletDetail] | None = None
    # 新 model (= 構造-主、 紐付け-従、 1 行 = 1 パレ):
    pallet_index: int | None = Field(None, ge=0)
    tier_count: int | None = Field(None, ge=0, le=7)
    case_count: int | None = Field(None, ge=0, le=6)


class ItemUpdate(BaseModel):
    capacity: float | None = None
    priority: int | None = Field(None, ge=0, le=100)
    note: str | None = None
    pallet_details: list[PalletDetail] | None = None
    pallet_index: int | None = Field(None, ge=0)
    tier_count: int | None = Field(None, ge=0, le=7)
    case_count: int | None = Field(None, ge=0, le=6)
    # 紐付け を 後から 変更 / 解除 する 用 (= 空パレ ↔ 紐付け の 往復)。 全 NULL
    # で 「紐付け 解除」、 単一値 指定 で 「その target に 切替」。
    material_id: int | None = None
    inbound_lot_id: int | None = None
    semifinished_lot_id: int | None = None


class WallCreate(BaseModel):
    layout_id: int
    x1: float = Field(..., ge=0)
    y1: float = Field(..., ge=0)
    x2: float = Field(..., ge=0)
    y2: float = Field(..., ge=0)
    thickness: float = Field(8, gt=0, le=80)


class WallUpdate(BaseModel):
    x1: float | None = None
    y1: float | None = None
    x2: float | None = None
    y2: float | None = None
    thickness: float | None = Field(None, gt=0, le=80)


class WallOut(BaseModel):
    id: int
    layout_id: int
    x1: float
    y1: float
    x2: float
    y2: float
    thickness: float


class BulkWallsRequest(BaseModel):
    """1回のリクエストで全壁を置き換える (編集効率のため)"""
    walls: list[WallCreate]


# -----------------------------------------------------------------------------
# 棚卸エントリ (storage_object_inventory_entries) — Phase A1 v2
# レイアウト 図 上 で 取った 棚卸 スナップショット。 既存 storage_object_items
# とは 独立 経路 で、 台帳 と は 非同期 (user 合意 2026-05-24)。
# v2: 「種別」 フィールド 廃止。 lot/material/semifin 紐付け (= 由来 ref) を
# データ に 持たせ、 集計時 に section を 推定。 入力 高速化 の ため 在庫 ref
# 4 種 (inbound_lot / material / semifinished_lot / outbound) を NULL 許容 で 保持。
# -----------------------------------------------------------------------------

ENTRY_PROCESS_PATTERN = r"^(洗|選)$"


class InventoryEntryBase(BaseModel):
    """棚卸エントリ 入力 共通 部分。 全フィールド optional。 POST も 同じ shape。"""
    inventory_date: str | None = None      # 'YYYY-MM-DD'、 省略時 CURRENT_DATE
    # 在庫 由来 ref (1 つ だけ 入る 想定 だが 強制 制約 は しない — 全部 NULL = 完全 free)
    inbound_lot_id: int | None = None
    material_id: int | None = None
    semifinished_lot_id: int | None = None
    outbound_id: int | None = None         # 生姜 半製品 専用 (本来 の 運用)
    # master / free text
    crop_id: int | None = None
    origin_text: str | None = None
    spec_text: str | None = None
    sub_spec_text: str | None = None
    supplier_text: str | None = None       # 仕入先 (migration 081)
    category_major: str | None = None
    category_minor: str | None = None
    name: str | None = None
    cases: float | None = Field(None, ge=0)
    kg_per_case: float | None = Field(None, ge=0)
    total_kg: float | None = Field(None, ge=0)
    process_state: str | None = Field(None, pattern=ENTRY_PROCESS_PATTERN)
    note: str | None = None


class InventoryEntryCreate(InventoryEntryBase):
    """POST /storage/objects/{id}/inventory-entries 用 (upsert)。
    (object_id, inventory_date, name) が 衝突 し たら 上書き、 別日 なら 新規。"""


class InventoryEntryOut(BaseModel):
    id: int
    object_id: int
    inventory_date: str                    # 'YYYY-MM-DD'
    inbound_lot_id: int | None
    material_id: int | None
    semifinished_lot_id: int | None
    outbound_id: int | None
    crop_id: int | None
    origin_text: str | None
    spec_text: str | None
    sub_spec_text: str | None
    supplier_text: str | None              # migration 081
    category_major: str | None
    category_minor: str | None
    name: str | None
    cases: float | None
    kg_per_case: float | None
    total_kg: float | None
    process_state: str | None
    note: str | None


def _entry_row_to_out(row: dict) -> InventoryEntryOut:
    """DB 行 → InventoryEntryOut 変換 (Decimal → float、 date → str)"""
    return InventoryEntryOut(
        id=row["id"],
        object_id=row["object_id"],
        inventory_date=row["inventory_date"].isoformat(),
        inbound_lot_id=row["inbound_lot_id"],
        material_id=row["material_id"],
        semifinished_lot_id=row["semifinished_lot_id"],
        outbound_id=row["outbound_id"],
        crop_id=row["crop_id"],
        origin_text=row["origin_text"],
        spec_text=row["spec_text"],
        sub_spec_text=row["sub_spec_text"],
        supplier_text=row.get("supplier_text"),
        category_major=row["category_major"],
        category_minor=row["category_minor"],
        name=row["name"],
        cases=float(row["cases"]) if row["cases"] is not None else None,
        kg_per_case=float(row["kg_per_case"]) if row["kg_per_case"] is not None else None,
        total_kg=float(row["total_kg"]) if row["total_kg"] is not None else None,
        process_state=row["process_state"],
        note=row["note"],
    )


# =============================================================================
# レイアウト CRUD
# =============================================================================

@router.get("/layouts", response_model=list[LayoutOut])
async def list_layouts(
    db: DB, user: CurrentUser,
    target_kind: str | None = Query(None, pattern=r"^(material|ingredient)$"),
    division: int | None = Query(None),
):
    conds, params = ["is_active = true"], []
    if target_kind is not None:
        params.append(target_kind); conds.append("target_kind = %s")
    if division is not None:
        params.append(division);    conds.append("division = %s")
    async with db.cursor() as cur:
        await cur.execute(
            f"SELECT * FROM storage_layouts WHERE {' AND '.join(conds)} ORDER BY id",
            params or None)
        return [LayoutOut(**r) for r in await cur.fetchall()]


@router.post("/layouts", response_model=LayoutOut,
             status_code=status.HTTP_201_CREATED)
async def create_layout(body: LayoutCreate, db: DB,
                        admin: AdminUser, request: Request):
    async with db.cursor() as cur:
        await cur.execute("""
            INSERT INTO storage_layouts (name, division, target_kind, note, created_by)
            VALUES (%s, %s, %s, %s, %s)
            RETURNING *
        """, (body.name, body.division, body.target_kind, body.note, admin["id"]))
        row = await cur.fetchone()
    await write_audit(db, "STORAGE_LAYOUT_CREATE", "storage_layouts",
                      str(row["id"]), dict(row), admin["id"], request)
    return LayoutOut(**row)


@router.get("/layouts/{layout_id}", response_model=LayoutOut)
async def get_layout(layout_id: int, db: DB, user: CurrentUser):
    async with db.cursor() as cur:
        await cur.execute("SELECT * FROM storage_layouts WHERE id=%s", (layout_id,))
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="レイアウトが見つかりません")
    return LayoutOut(**row)


@router.put("/layouts/{layout_id}", response_model=LayoutOut)
async def update_layout(layout_id: int, body: LayoutUpdate, db: DB,
                        admin: AdminUser, request: Request):
    # model_dump(exclude_unset=True) で「明示的に渡されたフィールド」だけ拾う
    # (= floor_outline を null に戻したい場合も対応できる)
    fields: dict[str, Any] = body.model_dump(exclude_unset=True)
    if not fields:
        return await get_layout(layout_id, db, admin)  # type: ignore
    sets_parts: list[str] = []
    params: list[Any] = []
    for k, v in fields.items():
        if k == "floor_outline":
            sets_parts.append("floor_outline = %s::jsonb")
            params.append(json.dumps(v) if v is not None else None)
        else:
            sets_parts.append(f"{k} = %s")
            params.append(v)
    sets = ", ".join(sets_parts)
    params.append(layout_id)
    async with db.cursor() as cur:
        await cur.execute(
            f"UPDATE storage_layouts SET {sets}, updated_at = now() "
            f"WHERE id = %s RETURNING *", params)
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="レイアウトが見つかりません")
    # JSONB は dict/list で返るのでそのまま LayoutOut に渡せる
    await write_audit(db, "STORAGE_LAYOUT_UPDATE", "storage_layouts",
                      str(layout_id), fields, admin["id"], request)
    return LayoutOut(**row)


@router.delete("/layouts/{layout_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_layout(layout_id: int, db: DB, admin: AdminUser, request: Request):
    async with db.cursor() as cur:
        await cur.execute("SELECT image_url FROM storage_layouts WHERE id=%s",
                          (layout_id,))
        row = await cur.fetchone()
        if not row:
            raise HTTPException(status.HTTP_404_NOT_FOUND)
        await cur.execute("DELETE FROM storage_layouts WHERE id=%s", (layout_id,))
    # 画像ファイル削除
    if row["image_url"]:
        try:
            fname = Path(row["image_url"]).name
            (UPLOADS_DIR / fname).unlink(missing_ok=True)
        except Exception:
            pass
    await write_audit(db, "STORAGE_LAYOUT_DELETE", "storage_layouts",
                      str(layout_id), {}, admin["id"], request)


@router.post("/layouts/{layout_id}/image", response_model=LayoutOut)
async def upload_layout_image(
    layout_id: int, db: DB, admin: AdminUser, request: Request,
    file: UploadFile = File(...),
    width: int = Form(...),
    height: int = Form(...),
):
    """画像をアップロードして layout に紐付ける。
    フロントは画像の原寸 width/height を抽出してフォームに同梱する。"""
    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_IMAGE_EXT:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
                            detail=f"対応していない拡張子: {ext}")
    content = await file.read()
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                            detail=f"画像サイズが大きすぎます ({len(content):,} bytes > {MAX_UPLOAD_BYTES:,})")
    fname = f"{layout_id}_{uuid.uuid4().hex[:8]}{ext}"
    (UPLOADS_DIR / fname).write_bytes(content)
    image_url = f"/uploads/storage_layouts/{fname}"

    async with db.cursor() as cur:
        # 既存画像があれば削除（古いファイルが残らないように）
        await cur.execute("SELECT image_url FROM storage_layouts WHERE id=%s",
                          (layout_id,))
        old = await cur.fetchone()
        if not old:
            raise HTTPException(status.HTTP_404_NOT_FOUND)
        if old["image_url"] and old["image_url"] != image_url:
            try:
                (UPLOADS_DIR / Path(old["image_url"]).name).unlink(missing_ok=True)
            except Exception:
                pass
        await cur.execute("""
            UPDATE storage_layouts
               SET image_url = %s, image_width = %s, image_height = %s, updated_at = now()
             WHERE id = %s RETURNING *
        """, (image_url, width, height, layout_id))
        row = await cur.fetchone()

    await write_audit(db, "STORAGE_IMAGE_UPLOAD", "storage_layouts",
                      str(layout_id),
                      {"file": fname, "size": len(content)},
                      admin["id"], request)
    return LayoutOut(**row)


# =============================================================================
# オブジェクト CRUD
# =============================================================================

@router.post("/objects", status_code=status.HTTP_201_CREATED)
async def create_object(body: ObjectCreate, db: DB,
                        admin: AdminUser, request: Request):
    async with db.cursor() as cur:
        await cur.execute("""
            INSERT INTO storage_objects
                (layout_id, label, x, y, width, height, color, note,
                 orientation, pallet_tiers, object_type)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            RETURNING *
        """, (body.layout_id, body.label, body.x, body.y,
              body.width, body.height, body.color, body.note,
              body.orientation, body.pallet_tiers, body.object_type))
        row = await cur.fetchone()
    await write_audit(db, "STORAGE_OBJECT_CREATE", "storage_objects",
                      str(row["id"]), dict(row), admin["id"], request)
    return dict(row)


@router.put("/objects/{object_id}")
async def update_object(object_id: int, body: ObjectUpdate, db: DB,
                        admin: AdminUser, request: Request):
    fields: dict[str, Any] = {k: v for k, v in body.model_dump().items() if v is not None}
    if not fields:
        async with db.cursor() as cur:
            await cur.execute("SELECT * FROM storage_objects WHERE id=%s", (object_id,))
            row = await cur.fetchone()
        if not row:
            raise HTTPException(status.HTTP_404_NOT_FOUND)
        return dict(row)
    sets = ", ".join(f"{k} = %s" for k in fields)
    params = list(fields.values()) + [object_id]
    async with db.cursor() as cur:
        await cur.execute(
            f"UPDATE storage_objects SET {sets}, updated_at = now() "
            f"WHERE id = %s RETURNING *", params)
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    await write_audit(db, "STORAGE_OBJECT_UPDATE", "storage_objects",
                      str(object_id), fields, admin["id"], request)
    return dict(row)


@router.delete("/objects/{object_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_object(object_id: int, db: DB,
                        admin: AdminUser, request: Request):
    async with db.cursor() as cur:
        await cur.execute("DELETE FROM storage_objects WHERE id=%s RETURNING id",
                          (object_id,))
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    await write_audit(db, "STORAGE_OBJECT_DELETE", "storage_objects",
                      str(object_id), {}, admin["id"], request)


# =============================================================================
# Items (object ⇄ material/lot リンク)
# =============================================================================

@router.post("/objects/{object_id}/items", status_code=status.HTTP_201_CREATED)
async def create_item(object_id: int, body: ItemCreate, db: DB,
                      admin: AdminUser, request: Request):
    # material / inbound_lot / semifinished_lot は 3 排他 (1 つだけ or 全部 NULL = 空 row)
    set_count = sum([
        body.material_id is not None,
        body.inbound_lot_id is not None,
        body.semifinished_lot_id is not None,
    ])
    if set_count > 1:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="material_id / inbound_lot_id / semifinished_lot_id は 1 つ までです")
    # 全 NULL (= 空 構造 row) は 許可 (構造-主 model 2026-05-27)。
    # 旧 「tier_count 必須」 ガード は 撤廃 — スチール コンテナ で tier_count を 使わ ない
    # 空 row を 拒否 して しまう 問題 (POST 422) を 解消。 DB constraint zero_or_one_target
    # で 排他性 は 担保 され、 material layout は フロント の addItemViaModal が targetId
    # を 必ず 送る ため、 実害 は ない。
    # pallet_details は JSONB に 渡す ため json.dumps で 整形
    pd_json = json.dumps([d.model_dump() for d in body.pallet_details]) if body.pallet_details else None
    async with db.cursor() as cur:
        await cur.execute("""
            INSERT INTO storage_object_items
                (object_id, material_id, inbound_lot_id, semifinished_lot_id,
                 capacity, priority, note, pallet_details,
                 pallet_index, tier_count, case_count)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s,%s)
            RETURNING *
        """, (object_id, body.material_id, body.inbound_lot_id,
              body.semifinished_lot_id,
              body.capacity, body.priority, body.note, pd_json,
              body.pallet_index, body.tier_count, body.case_count))
        row = await cur.fetchone()
    await write_audit(db, "STORAGE_ITEM_CREATE", "storage_object_items",
                      str(row["id"]), dict(row), admin["id"], request)
    return dict(row)


@router.put("/items/{item_id}")
async def update_item(item_id: int, body: ItemUpdate, db: DB,
                      admin: AdminUser, request: Request):
    fields: dict[str, Any] = {k: v for k, v in body.model_dump().items() if v is not None}
    if not fields:
        async with db.cursor() as cur:
            await cur.execute("SELECT * FROM storage_object_items WHERE id=%s", (item_id,))
            row = await cur.fetchone()
        if not row:
            raise HTTPException(status.HTTP_404_NOT_FOUND)
        return dict(row)
    # pallet_details が ある なら JSONB として cast (= 文字列 で 渡す と TEXT に なる)
    if "pallet_details" in fields:
        fields["pallet_details"] = json.dumps(
            [d.model_dump() if hasattr(d, "model_dump") else d for d in fields["pallet_details"]]
        )
    set_parts: list[str] = []
    for k in fields:
        if k == "pallet_details":
            set_parts.append("pallet_details = %s::jsonb")
        else:
            set_parts.append(f"{k} = %s")
    sets = ", ".join(set_parts)
    params = list(fields.values()) + [item_id]
    async with db.cursor() as cur:
        await cur.execute(
            f"UPDATE storage_object_items SET {sets} WHERE id = %s RETURNING *", params)
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    await write_audit(db, "STORAGE_ITEM_UPDATE", "storage_object_items",
                      str(item_id), fields, admin["id"], request)
    return dict(row)


@router.delete("/items/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_item(item_id: int, db: DB,
                      admin: AdminUser, request: Request):
    async with db.cursor() as cur:
        await cur.execute("DELETE FROM storage_object_items WHERE id=%s RETURNING id",
                          (item_id,))
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    await write_audit(db, "STORAGE_ITEM_DELETE", "storage_object_items",
                      str(item_id), {}, admin["id"], request)


# =============================================================================
# レイアウト状態（全オブジェクト + 紐付き資材/ロットの在庫）
# =============================================================================

@router.get("/layouts/{layout_id}/state")
async def get_layout_state(
    layout_id: int, db: DB, user: CurrentUser,
    date: str | None = Query(None,
        description="YYYY-MM-DD。指定時はその日付時点の在庫を計算。省略時は現在。"),
):
    """レイアウト + 全オブジェクト + アイテム + 各アイテムの在庫量を返す。

    在庫の取得方針:
      - 資材 (target_kind='material'): material_stock VIEW の remaining_qty
      - 原料 (target_kind='ingredient'): lot_stock VIEW の remaining_kg
      - date が指定された場合: 指定日までの movements/outbound のみを集計して再計算

    各オブジェクトでの実表示量は、合計残量を priority DESC で分配して算出する。
    （フロントで分配する。バックエンドは「合計残量」と「アイテムの容量・優先度」を返す）
    """
    async with db.cursor() as cur:
        # レイアウト
        await cur.execute("SELECT * FROM storage_layouts WHERE id=%s", (layout_id,))
        layout = await cur.fetchone()
        if not layout:
            raise HTTPException(status.HTTP_404_NOT_FOUND)
        target_kind = layout["target_kind"]

        # オブジェクト一覧
        await cur.execute(
            "SELECT * FROM storage_objects WHERE layout_id=%s ORDER BY id",
            (layout_id,))
        objects = [dict(r) for r in await cur.fetchall()]
        obj_ids = [o["id"] for o in objects]

        # アイテム一覧（必要な属性を JOIN）
        items: list[dict] = []
        if obj_ids:
            if target_kind == "material":
                await cur.execute("""
                    SELECT
                        i.id, i.object_id, i.material_id, i.inbound_lot_id,
                        i.capacity, i.priority, i.note,
                        m.code         AS material_code,
                        m.item_name    AS material_name,
                        m.supplier_name AS material_supplier,
                        m.unit         AS material_unit,
                        ms.remaining_qty AS current_stock,
                        ms.base_qty,
                        ms.base_date
                    FROM storage_object_items i
                    JOIN materials       m  ON m.id = i.material_id
                    LEFT JOIN material_stock ms ON ms.material_id = i.material_id
                    WHERE i.object_id = ANY(%s) AND i.material_id IS NOT NULL
                    ORDER BY i.id
                """, (obj_ids,))
                items = [dict(r) for r in await cur.fetchall()]
            else:  # ingredient (原料 + 半製品 を 1 レイアウト内で扱う)
                # 原料ロット紐付け
                await cur.execute("""
                    SELECT
                        i.id, i.object_id, i.material_id, i.inbound_lot_id,
                        i.semifinished_lot_id,
                        i.capacity, i.priority, i.note, i.pallet_details,
                        i.pallet_index, i.tier_count, i.case_count,
                        il.code        AS lot_code,
                        il.inbound_date AS lot_inbound_date,
                        g.spec_type    AS lot_spec_type,
                        g.grade_level  AS lot_grade_level,
                        g.size_label   AS lot_size_label,
                        o.name         AS lot_origin_name,
                        s.name         AS lot_supplier_name,
                        ls.remaining_kg AS current_stock,
                        ls.base_kg     AS base_qty,
                        ls.base_date
                    FROM storage_object_items i
                    JOIN inbound_lots il ON il.id = i.inbound_lot_id
                    JOIN products  p ON p.id = il.product_id
                    JOIN grades    g ON g.id = p.grade_id
                    JOIN origins   o ON o.id = p.origin_id
                    JOIN suppliers s ON s.id = il.supplier_id
                    LEFT JOIN lot_stock ls ON ls.lot_id = i.inbound_lot_id
                    WHERE i.object_id = ANY(%s) AND i.inbound_lot_id IS NOT NULL
                    ORDER BY i.id
                """, (obj_ids,))
                items = [dict(r) for r in await cur.fetchall()]
                # 半製品ロット紐付けも含める (1 レイアウト = 原料/半製品 混在可能)
                await cur.execute("""
                    SELECT
                        i.id, i.object_id, i.material_id, i.inbound_lot_id,
                        i.semifinished_lot_id,
                        i.capacity, i.priority, i.note,
                        sl.code         AS semifin_code,
                        g.spec_type     AS semifin_spec_type,
                        g.grade_level   AS semifin_grade_level,
                        g.size_label    AS semifin_size_label,
                        o.name          AS semifin_origin_name,
                        sl.total_kg     AS semifin_base_kg,
                        sl.status       AS semifin_status,
                        sl.total_kg     AS current_stock,
                        sl.total_kg     AS base_qty,
                        sl.inbound_date AS base_date
                    FROM storage_object_items i
                    JOIN semifinished_lots sl ON sl.id = i.semifinished_lot_id
                    JOIN products p ON p.id = sl.product_id
                    JOIN grades   g ON g.id = p.grade_id
                    JOIN origins  o ON o.id = p.origin_id
                    WHERE i.object_id = ANY(%s) AND i.semifinished_lot_id IS NOT NULL
                    ORDER BY i.id
                """, (obj_ids,))
                items.extend(dict(r) for r in await cur.fetchall())
                # 空 行 (= 構造 だけ あって 紐付け なし)。 構造-主 model:
                # ・パレット 用 空 行: tier_count あり (pallet_index も あり)
                # ・スチール コンテナ 用 空 行 (2026-05-27): tier_count NULL (= 単純 1 row=1 container)
                # どちら も lot/material/semifin 全 NULL で 識別。 表示属性 は 全 NULL で 返す。
                # → フロント ExistingRow が isEmptyPallet / isEmptyContainer 判定 して 表示。
                await cur.execute("""
                    SELECT
                        i.id, i.object_id, i.material_id, i.inbound_lot_id,
                        i.semifinished_lot_id,
                        i.capacity, i.priority, i.note, i.pallet_details,
                        i.pallet_index, i.tier_count, i.case_count,
                        NULL::text AS lot_code,
                        NULL::text AS lot_spec_type,
                        NULL::text AS lot_grade_level,
                        NULL::text AS lot_size_label,
                        NULL::text AS lot_origin_name,
                        NULL::text AS lot_supplier_name,
                        NULL::numeric AS current_stock,
                        NULL::numeric AS base_qty,
                        NULL::date    AS base_date
                    FROM storage_object_items i
                    WHERE i.object_id = ANY(%s)
                      AND i.inbound_lot_id IS NULL
                      AND i.material_id IS NULL
                      AND i.semifinished_lot_id IS NULL
                    ORDER BY i.id
                """, (obj_ids,))
                items.extend(dict(r) for r in await cur.fetchall())

            # 過去日付指定時は、その日までの動きで再計算（簡易実装。重い場合は別 API に分離）
            if date and items:
                for it in items:
                    if target_kind == "material":
                        await cur.execute("""
                            SELECT COALESCE(SUM(quantity), 0) AS v
                            FROM material_movements
                            WHERE material_id = %s AND movement_date <= %s
                              AND (%s::date IS NULL OR movement_date > %s)
                        """, (it["material_id"], date, it["base_date"], it["base_date"]))
                        delta_manual = (await cur.fetchone())["v"]
                        # 商品出荷自動消耗も合算
                        await cur.execute("""
                            SELECT COALESCE(SUM(sr.quantity * pmu.quantity_per_unit), 0) AS v
                            FROM product_material_usage pmu
                            JOIN shipment_records sr ON sr.product_id = pmu.product_id
                            WHERE pmu.material_id = %s AND sr.ship_date <= %s
                              AND (%s::date IS NULL OR sr.ship_date > %s)
                        """, (it["material_id"], date, it["base_date"], it["base_date"]))
                        delta_auto = (await cur.fetchone())["v"]
                        base = it["base_qty"] or Decimal(0)
                        it["current_stock"] = base + delta_manual - delta_auto
                    else:
                        await cur.execute("""
                            SELECT COALESCE(SUM(quantity_kg), 0) AS v
                            FROM outbound_records
                            WHERE lot_id = %s AND outbound_date <= %s
                              AND (%s::date IS NULL OR outbound_date > %s)
                        """, (it["inbound_lot_id"], date, it["base_date"], it["base_date"]))
                        out = (await cur.fetchone())["v"]
                        base = it["base_qty"] or Decimal(0)
                        it["current_stock"] = base - out

        # 壁 (間取り) 一覧
        await cur.execute(
            "SELECT id, layout_id, x1, y1, x2, y2, thickness "
            "FROM storage_walls WHERE layout_id=%s ORDER BY id",
            (layout_id,))
        walls = [dict(r) for r in await cur.fetchall()]

    return {
        "layout": dict(layout),
        "objects": objects,
        "items": items,
        "walls": walls,
        "date": date,
    }


# =============================================================================
# 壁 (間取り) CRUD
# =============================================================================

@router.get("/layouts/{layout_id}/walls", response_model=list[WallOut])
async def list_walls(layout_id: int, db: DB, user: CurrentUser):
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT id, layout_id, x1, y1, x2, y2, thickness "
            "FROM storage_walls WHERE layout_id=%s ORDER BY id",
            (layout_id,))
        return [WallOut(**r) for r in await cur.fetchall()]


@router.post("/walls", response_model=WallOut,
             status_code=status.HTTP_201_CREATED)
async def create_wall(body: WallCreate, db: DB, admin: AdminUser, request: Request):
    async with db.cursor() as cur:
        await cur.execute("""
            INSERT INTO storage_walls (layout_id, x1, y1, x2, y2, thickness)
            VALUES (%s, %s, %s, %s, %s, %s)
            RETURNING id, layout_id, x1, y1, x2, y2, thickness
        """, (body.layout_id, body.x1, body.y1, body.x2, body.y2, body.thickness))
        row = await cur.fetchone()
    await write_audit(db, "STORAGE_WALL_CREATE", "storage_walls",
                      str(row["id"]), dict(row), admin["id"], request)
    return WallOut(**row)


@router.patch("/walls/{wall_id}", response_model=WallOut)
async def update_wall(wall_id: int, body: WallUpdate, db: DB,
                      admin: AdminUser, request: Request):
    fields = body.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="更新するフィールドが指定されていません")
    sets = ", ".join(f"{k}=%s" for k in fields) + ", updated_at=now()"
    params = list(fields.values()) + [wall_id]
    async with db.cursor() as cur:
        await cur.execute(
            f"UPDATE storage_walls SET {sets} WHERE id=%s "
            f"RETURNING id, layout_id, x1, y1, x2, y2, thickness",
            params)
        row = await cur.fetchone()
        if not row:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="壁が見つかりません")
    await write_audit(db, "STORAGE_WALL_UPDATE", "storage_walls",
                      str(wall_id), fields, admin["id"], request)
    return WallOut(**row)


@router.delete("/walls/{wall_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_wall(wall_id: int, db: DB, admin: AdminUser, request: Request):
    async with db.cursor() as cur:
        await cur.execute("DELETE FROM storage_walls WHERE id=%s", (wall_id,))
    await write_audit(db, "STORAGE_WALL_DELETE", "storage_walls",
                      str(wall_id), {}, admin["id"], request)


@router.put("/layouts/{layout_id}/walls", response_model=list[WallOut])
async def replace_walls(layout_id: int, body: BulkWallsRequest,
                        db: DB, admin: AdminUser, request: Request):
    """このレイアウトの壁を body の内容で全置換 (編集ページからのバルク保存用)"""
    # body 内の layout_id がパスと一致するか軽くチェック
    for w in body.walls:
        if w.layout_id != layout_id:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                                detail="walls 内の layout_id がパスと一致しません")
    async with db.cursor() as cur:
        await cur.execute("DELETE FROM storage_walls WHERE layout_id=%s", (layout_id,))
        rows: list[dict] = []
        for w in body.walls:
            await cur.execute("""
                INSERT INTO storage_walls (layout_id, x1, y1, x2, y2, thickness)
                VALUES (%s, %s, %s, %s, %s, %s)
                RETURNING id, layout_id, x1, y1, x2, y2, thickness
            """, (layout_id, w.x1, w.y1, w.x2, w.y2, w.thickness))
            rows.append(dict(await cur.fetchone()))
    await write_audit(db, "STORAGE_WALLS_REPLACE", "storage_walls",
                      str(layout_id), {"count": len(rows)}, admin["id"], request)
    return [WallOut(**r) for r in rows]


@router.get("/layouts/{layout_id}/activity")
async def get_layout_activity(
    layout_id: int, db: DB, user: CurrentUser,
    days: int = Query(7, ge=1, le=365, description="過去何日分の活動量を集計するか"),
):
    """指定期間における 紐付き material/lot の総活動量 (|出入 kg|) を返す。
    ヒートマップ表示用。"""
    async with db.cursor() as cur:
        await cur.execute("SELECT target_kind FROM storage_layouts WHERE id=%s",
                          (layout_id,))
        row = await cur.fetchone()
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND)
        target_kind = row["target_kind"]

        if target_kind == "material":
            # 資材: material_movements (手動) + 商品出荷 (自動消耗)
            await cur.execute("""
                WITH lo AS (
                    SELECT i.object_id, i.material_id
                    FROM storage_object_items i
                    JOIN storage_objects o ON o.id = i.object_id
                    WHERE o.layout_id = %s AND i.material_id IS NOT NULL
                ),
                manual AS (
                    SELECT lo.object_id, COALESCE(SUM(ABS(mm.quantity)), 0) AS amt
                    FROM lo
                    LEFT JOIN material_movements mm
                      ON mm.material_id = lo.material_id
                      AND mm.movement_date >= CURRENT_DATE - %s::int
                    GROUP BY lo.object_id
                ),
                auto AS (
                    SELECT lo.object_id, COALESCE(SUM(sr.quantity * pmu.quantity_per_unit), 0) AS amt
                    FROM lo
                    LEFT JOIN product_material_usage pmu
                      ON pmu.material_id = lo.material_id
                    LEFT JOIN shipment_records sr
                      ON sr.product_id = pmu.product_id
                      AND sr.ship_date >= CURRENT_DATE - %s::int
                    GROUP BY lo.object_id
                )
                SELECT o.id AS object_id,
                       COALESCE(manual.amt, 0) + COALESCE(auto.amt, 0) AS activity
                FROM storage_objects o
                LEFT JOIN manual ON manual.object_id = o.id
                LEFT JOIN auto   ON auto.object_id = o.id
                WHERE o.layout_id = %s
            """, (layout_id, days, days, layout_id))
        else:
            # 原料: outbound_records
            await cur.execute("""
                WITH lo AS (
                    SELECT i.object_id, i.inbound_lot_id
                    FROM storage_object_items i
                    JOIN storage_objects o ON o.id = i.object_id
                    WHERE o.layout_id = %s AND i.inbound_lot_id IS NOT NULL
                )
                SELECT o.id AS object_id,
                       COALESCE(SUM(ABS(ob.quantity_kg)), 0) AS activity
                FROM storage_objects o
                LEFT JOIN lo ON lo.object_id = o.id
                LEFT JOIN outbound_records ob
                  ON ob.lot_id = lo.inbound_lot_id
                  AND ob.outbound_date >= CURRENT_DATE - %s::int
                WHERE o.layout_id = %s
                GROUP BY o.id
            """, (layout_id, days, layout_id))
        rows = await cur.fetchall()

    return {
        "days": days,
        "activity": [{"object_id": r["object_id"], "activity": float(r["activity"])}
                     for r in rows],
    }


# =============================================================================
# 棚卸エントリ CRUD (Phase A1)
# =============================================================================

@router.get("/objects/{object_id}/inventory-entries",
            response_model=list[InventoryEntryOut])
async def list_inventory_entries(
    object_id: int, db: DB, user: CurrentUser,
    date: str | None = Query(None,
        description="YYYY-MM-DD。指定時は その日以前 で 各 name の 最新 のみ。 省略時は 全件 (履歴 含む) を 新しい順 で 返す"),
):
    """object の 棚卸エントリ 一覧。
    date 指定時: 各 (object, name) で inventory_date <= date を 満たす 最新 1 件 のみ。
    date 省略: 履歴 含めて 全件 (canvas/集計表 で 最新 を 使う 場合 は date 指定 を 推奨)。"""
    async with db.cursor() as cur:
        if date:
            # 各 name (NULL は '' 扱い) ごと に 指定日 以前 の 最新 を 1 件
            await cur.execute("""
                SELECT DISTINCT ON (COALESCE(name, '')) *
                  FROM storage_object_inventory_entries
                 WHERE object_id = %s AND inventory_date <= %s::date
                 ORDER BY COALESCE(name, ''), inventory_date DESC, id DESC
            """, (object_id, date))
        else:
            await cur.execute("""
                SELECT * FROM storage_object_inventory_entries
                 WHERE object_id = %s
                 ORDER BY inventory_date DESC, id DESC
            """, (object_id,))
        rows = await cur.fetchall()
    return [_entry_row_to_out(r) for r in rows]


@router.post("/objects/{object_id}/inventory-entries",
             response_model=InventoryEntryOut,
             status_code=status.HTTP_201_CREATED)
async def create_inventory_entry(
    object_id: int, body: InventoryEntryCreate, db: DB,
    user: CurrentUser, request: Request,
):
    """エントリ 作成 (= upsert)。 (object_id, inventory_date, name) が 既に あれば 上書き。
    inventory_date 省略 で CURRENT_DATE 適用。"""
    # オブジェクト 存在 チェック (404 を 確実に 返す ため)
    async with db.cursor() as cur:
        await cur.execute("SELECT id FROM storage_objects WHERE id=%s", (object_id,))
        if not await cur.fetchone():
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="オブジェクトが見つかりません")
        # ON CONFLICT に 部分式 (COALESCE) を 使う ため、 同じ 式 を 列挙
        await cur.execute("""
            INSERT INTO storage_object_inventory_entries
                (object_id, inventory_date,
                 inbound_lot_id, material_id, semifinished_lot_id, outbound_id,
                 crop_id, origin_text, spec_text, sub_spec_text, supplier_text,
                 category_major, category_minor, name,
                 cases, kg_per_case, total_kg, process_state, note)
            VALUES (
                %s,
                COALESCE(%s::date, CURRENT_DATE),
                %s, %s, %s, %s,
                %s, %s, %s, %s, %s,
                %s, %s, %s,
                %s, %s, %s, %s, %s
            )
            ON CONFLICT (object_id, inventory_date, (COALESCE(name, '')))
            DO UPDATE SET
                inbound_lot_id      = EXCLUDED.inbound_lot_id,
                material_id         = EXCLUDED.material_id,
                semifinished_lot_id = EXCLUDED.semifinished_lot_id,
                outbound_id         = EXCLUDED.outbound_id,
                crop_id             = EXCLUDED.crop_id,
                origin_text         = EXCLUDED.origin_text,
                spec_text           = EXCLUDED.spec_text,
                sub_spec_text       = EXCLUDED.sub_spec_text,
                supplier_text       = EXCLUDED.supplier_text,
                category_major      = EXCLUDED.category_major,
                category_minor      = EXCLUDED.category_minor,
                cases               = EXCLUDED.cases,
                kg_per_case         = EXCLUDED.kg_per_case,
                total_kg            = EXCLUDED.total_kg,
                process_state       = EXCLUDED.process_state,
                note                = EXCLUDED.note,
                updated_at          = now()
            RETURNING *
        """, (
            object_id, body.inventory_date,
            body.inbound_lot_id, body.material_id,
            body.semifinished_lot_id, body.outbound_id,
            body.crop_id, body.origin_text, body.spec_text, body.sub_spec_text, body.supplier_text,
            body.category_major, body.category_minor, body.name,
            body.cases, body.kg_per_case, body.total_kg, body.process_state, body.note,
        ))
        row = await cur.fetchone()
    await write_audit(db, "STORAGE_INV_ENTRY_UPSERT",
                      "storage_object_inventory_entries",
                      str(row["id"]), dict(body), user["id"], request)
    return _entry_row_to_out(row)


@router.put("/inventory-entries/{entry_id}", response_model=InventoryEntryOut)
async def update_inventory_entry(
    entry_id: int, body: InventoryEntryBase, db: DB,
    user: CurrentUser, request: Request,
):
    """エントリ 更新 (= 任意 field のみ 部分更新)。 name/inventory_date を 変えると
    UNIQUE 制約 で 衝突 する 可能性 あり (= 422 で 戻す)。"""
    fields = body.model_dump(exclude_unset=True)
    if not fields:
        async with db.cursor() as cur:
            await cur.execute(
                "SELECT * FROM storage_object_inventory_entries WHERE id=%s",
                (entry_id,))
            row = await cur.fetchone()
        if not row:
            raise HTTPException(status.HTTP_404_NOT_FOUND)
        return _entry_row_to_out(row)
    sets_parts: list[str] = []
    params: list[Any] = []
    for k, v in fields.items():
        if k == "inventory_date":
            sets_parts.append("inventory_date = %s::date")
        else:
            sets_parts.append(f"{k} = %s")
        params.append(v)
    sets = ", ".join(sets_parts) + ", updated_at = now()"
    params.append(entry_id)
    async with db.cursor() as cur:
        try:
            await cur.execute(
                f"UPDATE storage_object_inventory_entries SET {sets} "
                f"WHERE id = %s RETURNING *", params)
        except Exception as e:
            # UNIQUE 衝突 (同日 同名 が 既に ある) は 422 で 戻す
            if "storage_obj_inv_entries_unique_idx" in str(e):
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="同 オブジェクト 同日 で 同名 エントリ が 既に あります") from e
            raise
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    await write_audit(db, "STORAGE_INV_ENTRY_UPDATE",
                      "storage_object_inventory_entries",
                      str(entry_id), fields, user["id"], request)
    return _entry_row_to_out(row)


@router.delete("/inventory-entries/{entry_id}",
               status_code=status.HTTP_204_NO_CONTENT)
async def delete_inventory_entry(
    entry_id: int, db: DB, user: CurrentUser, request: Request,
):
    async with db.cursor() as cur:
        await cur.execute(
            "DELETE FROM storage_object_inventory_entries WHERE id=%s RETURNING id",
            (entry_id,))
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    await write_audit(db, "STORAGE_INV_ENTRY_DELETE",
                      "storage_object_inventory_entries",
                      str(entry_id), {}, user["id"], request)


@router.get("/layouts/{layout_id}/inventory-entries",
            response_model=list[InventoryEntryOut])
async def list_layout_inventory_entries(
    layout_id: int, db: DB, user: CurrentUser,
    date: str | None = Query(None,
        description="YYYY-MM-DD。 指定時 は その日以前 で 各 (object, name) の 最新 のみ"),
):
    """layout 配下 全 object の 棚卸エントリ を まとめて 返す (集計表 / canvas 表示 用)。"""
    async with db.cursor() as cur:
        if date:
            await cur.execute("""
                SELECT DISTINCT ON (e.object_id, COALESCE(e.name, '')) e.*
                  FROM storage_object_inventory_entries e
                  JOIN storage_objects o ON o.id = e.object_id
                 WHERE o.layout_id = %s AND e.inventory_date <= %s::date
                 ORDER BY e.object_id, COALESCE(e.name, ''),
                          e.inventory_date DESC, e.id DESC
            """, (layout_id, date))
        else:
            await cur.execute("""
                SELECT e.*
                  FROM storage_object_inventory_entries e
                  JOIN storage_objects o ON o.id = e.object_id
                 WHERE o.layout_id = %s
                 ORDER BY e.object_id, e.inventory_date DESC, e.id DESC
            """, (layout_id,))
        rows = await cur.fetchall()
    return [_entry_row_to_out(r) for r in rows]


# =============================================================================
# 棚卸エントリ 入力 候補 suggestions API
# =============================================================================
# StorageLinkModal 棚卸フォーム の Combobox 候補 を まとめて返す。
# 過去 entries の DISTINCT + master テーブル (suppliers / origins / grades) を
# 結合 し、 重複 除去 ・ 短い順 / 50音順 で 返す。

class EntrySuggestions(BaseModel):
    origins:          list[str]
    specs:            list[str]
    suppliers:        list[str]
    category_majors:  list[str]
    category_minors:  list[str]


@router.get("/inventory-entries/suggestions", response_model=EntrySuggestions)
async def get_entry_suggestions(db: DB, user: CurrentUser):
    """棚卸エントリ入力フォーム の Combobox 用 候補 を まとめて返す。

    各リスト の ソース:
      origins         : origins.name (master) + storage_object_inventory_entries.origin_text
      specs           : grades.spec_type DISTINCT (master) + entries.spec_text
      suppliers       : suppliers.name (master) + entries.supplier_text
      category_majors : entries.category_major DISTINCT
      category_minors : entries.category_minor DISTINCT
    """
    async with db.cursor() as cur:
        await cur.execute("""
            SELECT name FROM origins WHERE is_active = true
             UNION
            SELECT origin_text FROM storage_object_inventory_entries
             WHERE NULLIF(TRIM(origin_text), '') IS NOT NULL
            ORDER BY 1
        """)
        origins = [r["name"] for r in await cur.fetchall()]

        await cur.execute("""
            SELECT DISTINCT spec_type AS name FROM grades WHERE is_active = true
             UNION
            SELECT spec_text FROM storage_object_inventory_entries
             WHERE NULLIF(TRIM(spec_text), '') IS NOT NULL
            ORDER BY 1
        """)
        specs = [r["name"] for r in await cur.fetchall()]

        await cur.execute("""
            SELECT name FROM suppliers WHERE is_active = true
             UNION
            SELECT supplier_text FROM storage_object_inventory_entries
             WHERE NULLIF(TRIM(supplier_text), '') IS NOT NULL
            ORDER BY 1
        """)
        suppliers = [r["name"] for r in await cur.fetchall()]

        await cur.execute("""
            SELECT DISTINCT category_major AS name FROM storage_object_inventory_entries
             WHERE NULLIF(TRIM(category_major), '') IS NOT NULL
             ORDER BY 1
        """)
        category_majors = [r["name"] for r in await cur.fetchall()]

        await cur.execute("""
            SELECT DISTINCT category_minor AS name FROM storage_object_inventory_entries
             WHERE NULLIF(TRIM(category_minor), '') IS NOT NULL
             ORDER BY 1
        """)
        category_minors = [r["name"] for r in await cur.fetchall()]

    return EntrySuggestions(
        origins=origins, specs=specs, suppliers=suppliers,
        category_majors=category_majors, category_minors=category_minors,
    )


# =============================================================================
# 棚卸 → 差数 → 調整出庫 (Phase A3 — 在庫紐づけ あり object 用)
# =============================================================================
# StorageLinkModal の links タブ で 紐づけ済 lot/material に 棚卸数 を 入れて、
# 差数 ぶん 出庫 を 自動 で 立てる フロー。
#
#  ・棚卸 < 在庫 (差 > 0) → 「調整出庫」 を 提案 (outbound_records insert)
#  ・棚卸 > 在庫 (差 < 0) → 警告 のみ (操作 しない)
#  ・棚卸 = 在庫           → 何 も しない
#
# dry_run = True (preview) : DB 触らず、 計算結果 のみ 返す
# dry_run = False (commit) : outbound_records / material_movements を 実 INSERT
#                            + storage_object_inventory_entries に snapshot upsert

class StocktakeAdjustItem(BaseModel):
    inbound_lot_id: int | None = None   # ingredient (lot) の 場合
    material_id:    int | None = None   # material の 場合
    counted_kg:     Decimal             # 棚卸数 (kg)


class StocktakeAdjustRequest(BaseModel):
    outbound_date:  date                # 出庫日付 (commit 時のみ意味あり)
    inventory_date: str | None = None   # snapshot の inventory_date (省略 = CURRENT_DATE)
    items:          list[StocktakeAdjustItem]
    note:           str | None = None   # 出庫レコードに 書く メモ (省略 で デフォルト)
    dry_run:        bool = True


class StocktakeAdjustResultLine(BaseModel):
    inbound_lot_id:    int | None
    material_id:       int | None
    label:             str
    current_kg:        float
    counted_kg:        float
    diff_kg:           float            # current - counted (正: 棚卸が少ない → 出庫候補)
    action:            str              # 'outbound' | 'warn_over' | 'noop'
    message:           str | None = None
    # commit 時のみ 値が入る
    outbound_record_id:  int | None = None
    movement_id:         int | None = None
    inventory_entry_id:  int | None = None


class StocktakeAdjustResult(BaseModel):
    dry_run:  bool
    lines:    list[StocktakeAdjustResultLine]


@router.post("/objects/{object_id}/stocktake-adjust",
             response_model=StocktakeAdjustResult)
async def stocktake_adjust(
    object_id: int, body: StocktakeAdjustRequest, db: DB,
    user: OperatorUser, request: Request,
):
    """object 配下 の 紐づけ lot/material に 対して 棚卸数 を 受け取り、 差数 分
    の 「棚卸調整出庫」 を プレビュー / 確定 する。

    返り値 lines は items と 同じ順番 (frontend で マッピング 可能)。
    """
    # オブジェクト 存在 チェック
    async with db.cursor() as cur:
        await cur.execute("SELECT id FROM storage_objects WHERE id=%s", (object_id,))
        if not await cur.fetchone():
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="オブジェクトが見つかりません")

    note_default = f"棚卸調整 ({body.outbound_date.isoformat()})"
    note = body.note or note_default
    inv_date = body.inventory_date  # None で SQL 側 CURRENT_DATE

    lines: list[StocktakeAdjustResultLine] = []

    for item in body.items:
        # 1 つだけ ref が 入っている 想定 (両方/両方 NULL は 422)
        if (item.inbound_lot_id is None) == (item.material_id is None):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="inbound_lot_id か material_id の どちらか 1 つ を 指定してください",
            )

        if item.inbound_lot_id is not None:
            line = await _process_lot_adjust(
                db, object_id, item.inbound_lot_id, item.counted_kg,
                body.outbound_date, inv_date, note, body.dry_run, user["id"],
            )
        else:
            assert item.material_id is not None
            line = await _process_material_adjust(
                db, object_id, item.material_id, item.counted_kg,
                body.outbound_date, inv_date, note, body.dry_run, user["id"],
            )
        lines.append(line)

    # commit 時のみ audit (preview は ノイズ なので 書かない)
    if not body.dry_run:
        await write_audit(
            db, "STORAGE_STOCKTAKE_ADJUST", "storage_objects",
            str(object_id),
            {"items": [i.model_dump(mode="json") for i in body.items],
             "outbound_date": body.outbound_date.isoformat()},
            user["id"], request,
        )

    return StocktakeAdjustResult(dry_run=body.dry_run, lines=lines)


async def _process_lot_adjust(
    db, object_id: int, lot_id: int, counted_kg: Decimal,
    outbound_date: date, inventory_date: str | None,
    note: str, dry_run: bool, actor_id: str,
) -> StocktakeAdjustResultLine:
    """ロット 1 つ の 棚卸調整を 処理。 在庫照会 + 差数計算 + (commit なら) 出庫 INSERT。"""
    async with db.cursor() as cur:
        # ロットの 残量 を 取得 (= 全 inbound - 全 outbound)。 lot_stock_view が 想定。
        # 念のため 動的に SUM で 計算 (view 名 に 依存 しない)。
        await cur.execute("""
            SELECT
                il.id,
                il.code,
                il.total_kg AS inbound_kg,
                COALESCE((SELECT SUM(quantity_kg) FROM outbound_records ob
                          WHERE ob.lot_id = il.id), 0) AS outbound_kg,
                g.spec_type, g.grade_level, g.size_label,
                o.name AS origin_name
              FROM inbound_lots il
              LEFT JOIN grades g ON g.id = il.grade_id
              LEFT JOIN origins o ON o.id = il.origin_id
             WHERE il.id = %s
        """, (lot_id,))
        row = await cur.fetchone()
        if not row:
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                detail=f"ロット ID {lot_id} が見つかりません")
        current_kg = Decimal(row["inbound_kg"]) - Decimal(row["outbound_kg"])
        diff = current_kg - counted_kg  # > 0 = 棚卸が少ない → 出庫候補

        # ラベル 組立
        label_parts = [row["code"] or f"#{lot_id}"]
        spec_parts = [row["spec_type"], row["grade_level"], row["size_label"]]
        spec_parts = [s for s in spec_parts if s and s != "-"]
        if spec_parts:
            label_parts.append(" ".join(spec_parts))
        if row["origin_name"]:
            label_parts.append(row["origin_name"])
        label = " · ".join(label_parts)

        result = StocktakeAdjustResultLine(
            inbound_lot_id=lot_id, material_id=None,
            label=label,
            current_kg=float(current_kg),
            counted_kg=float(counted_kg),
            diff_kg=float(diff),
            action="noop",
        )

        if diff < 0:
            result.action = "warn_over"
            result.message = f"棚卸数 が 在庫より {abs(diff):.2f} kg 多い ため 調整出庫 は 提案しません"
        elif diff == 0:
            result.action = "noop"
            result.message = "差数なし"
        else:
            result.action = "outbound"
            result.message = f"{diff:.2f} kg を 調整出庫 と して 登録 します"
            if not dry_run:
                # 出庫 record 直 INSERT
                await cur.execute("""
                    INSERT INTO outbound_records
                        (lot_id, outbound_date, quantity_kg, note, created_by, purpose)
                    VALUES (%s, %s, %s, %s, %s, 'normal')
                    RETURNING id
                """, (lot_id, outbound_date, diff, note, actor_id))
                result.outbound_record_id = (await cur.fetchone())["id"]
                # snapshot upsert (refs 付き)。 inventory_date 衝突 → 上書き
                await cur.execute("""
                    INSERT INTO storage_object_inventory_entries
                        (object_id, inventory_date, inbound_lot_id, total_kg, note)
                    VALUES (%s, COALESCE(%s::date, CURRENT_DATE), %s, %s, %s)
                    ON CONFLICT (object_id, inventory_date, (COALESCE(name, '')))
                    DO UPDATE SET
                        inbound_lot_id = EXCLUDED.inbound_lot_id,
                        total_kg       = EXCLUDED.total_kg,
                        note           = EXCLUDED.note,
                        updated_at     = now()
                    RETURNING id
                """, (object_id, inventory_date, lot_id, counted_kg,
                      f"棚卸 {counted_kg} kg → {diff:.2f} kg 出庫"))
                result.inventory_entry_id = (await cur.fetchone())["id"]
        return result


async def _process_material_adjust(
    db, object_id: int, material_id: int, counted_qty: Decimal,
    outbound_date: date, inventory_date: str | None,
    note: str, dry_run: bool, actor_id: str,
) -> StocktakeAdjustResultLine:
    """資材 1 つ の 棚卸調整を 処理。"""
    async with db.cursor() as cur:
        # 残量 = 入荷-出庫 (= movements の SUM)
        await cur.execute("""
            SELECT m.id, m.code, m.item_name,
                   COALESCE(SUM(mv.quantity), 0) AS remaining
              FROM materials m
              LEFT JOIN material_movements mv ON mv.material_id = m.id
             WHERE m.id = %s
             GROUP BY m.id
        """, (material_id,))
        row = await cur.fetchone()
        if not row:
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                detail=f"資材 ID {material_id} が見つかりません")
        current = Decimal(row["remaining"])
        diff = current - counted_qty

        label = f"{row['code']} {row['item_name']}"
        result = StocktakeAdjustResultLine(
            inbound_lot_id=None, material_id=material_id,
            label=label,
            current_kg=float(current),
            counted_kg=float(counted_qty),
            diff_kg=float(diff),
            action="noop",
        )

        if diff < 0:
            result.action = "warn_over"
            result.message = f"棚卸数 が 在庫より {abs(diff):.2f} 多い ため 調整出庫 は 提案しません"
        elif diff == 0:
            result.action = "noop"
            result.message = "差数なし"
        else:
            result.action = "outbound"
            result.message = f"{diff:.2f} を 調整出庫 (material_movement -) と して 登録 します"
            if not dry_run:
                # material_movements に 負数 で INSERT
                await cur.execute("""
                    INSERT INTO material_movements
                        (material_id, movement_date, quantity, note, created_by)
                    VALUES (%s, %s, %s, %s, %s)
                    RETURNING id
                """, (material_id, outbound_date, -diff, note, actor_id))
                result.movement_id = (await cur.fetchone())["id"]
                # snapshot upsert
                await cur.execute("""
                    INSERT INTO storage_object_inventory_entries
                        (object_id, inventory_date, material_id, total_kg, note)
                    VALUES (%s, COALESCE(%s::date, CURRENT_DATE), %s, %s, %s)
                    ON CONFLICT (object_id, inventory_date, (COALESCE(name, '')))
                    DO UPDATE SET
                        material_id = EXCLUDED.material_id,
                        total_kg    = EXCLUDED.total_kg,
                        note        = EXCLUDED.note,
                        updated_at  = now()
                    RETURNING id
                """, (object_id, inventory_date, material_id, counted_qty,
                      f"棚卸 {counted_qty} → {diff:.2f} 出庫"))
                result.inventory_entry_id = (await cur.fetchone())["id"]
        return result


# =============================================================================
# 一括取り込み (Phase A3.1 v2 — 2026-05-25 改訂)
# =============================================================================
# 旧 v1 (= path query で 起動して backend が 自前で 計算) は 重大バグ あり:
#   同じ lot が 4 object に 紐付け されてる 場合、 全 object に lot の 「総 在庫」
#   を 入れて しまい 4 重 計上。
#
# 修正 (v2): frontend で 既存 distributeStock (priority + capacity ベース) で
# per-object 数量 を 計算 → POST body で 渡す。 backend は snapshot insert のみ。
# 「等分」 で は ない (priority/capacity 反映) ので 物理的 配置 と 整合 する。

class InventoryEntryBulkItem(BaseModel):
    object_id: int
    inbound_lot_id: int | None = None
    material_id: int | None = None
    semifinished_lot_id: int | None = None
    crop_id: int | None = None
    origin_text: str | None = None
    spec_text: str | None = None
    name: str | None = None
    cases: Decimal | None = None
    kg_per_case: Decimal | None = None
    total_kg: Decimal | None = None

class InventoryEntryBulkBody(BaseModel):
    inventory_date: str | None = None
    items: list[InventoryEntryBulkItem]

@router.post("/layouts/{layout_id}/inventory-entries/bulk-import-from-items")
async def bulk_import_inventory_entries_from_items(
    layout_id: int, body: InventoryEntryBulkBody,
    db: DB, user: CurrentUser, request: Request,
):
    """layout の 紐付け から entry を 一括 UPSERT。
    frontend で 計算した per-object 配分 を そのまま 保存。"""
    async with db.cursor() as cur:
        # layout 存在 確認 + 渡された object_id が この layout に 属する か 検証
        await cur.execute("SELECT id FROM storage_layouts WHERE id=%s", (layout_id,))
        if not await cur.fetchone():
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="レイアウトが見つかりません")
        valid_object_ids = set()
        await cur.execute(
            "SELECT id FROM storage_objects WHERE layout_id=%s", (layout_id,))
        for r in await cur.fetchall():
            valid_object_ids.add(r["id"])

        imported = 0
        skipped = 0
        for it in body.items:
            if it.object_id not in valid_object_ids:
                skipped += 1
                continue
            name = it.name or f"item#obj{it.object_id}"
            await cur.execute("""
                INSERT INTO storage_object_inventory_entries
                    (object_id, inventory_date,
                     inbound_lot_id, material_id, semifinished_lot_id, outbound_id,
                     crop_id, origin_text, spec_text, sub_spec_text,
                     category_major, category_minor, name,
                     cases, kg_per_case, total_kg, process_state, note)
                VALUES (
                    %s, COALESCE(%s::date, CURRENT_DATE),
                    %s, %s, %s, NULL,
                    %s, %s, %s, NULL,
                    NULL, NULL, %s,
                    %s, %s, %s, NULL, '一括取り込み (' || NOW()::date || ')'
                )
                ON CONFLICT (object_id, inventory_date, (COALESCE(name, '')))
                DO UPDATE SET
                    inbound_lot_id      = EXCLUDED.inbound_lot_id,
                    material_id         = EXCLUDED.material_id,
                    semifinished_lot_id = EXCLUDED.semifinished_lot_id,
                    crop_id             = EXCLUDED.crop_id,
                    origin_text         = EXCLUDED.origin_text,
                    spec_text           = EXCLUDED.spec_text,
                    cases               = EXCLUDED.cases,
                    kg_per_case         = EXCLUDED.kg_per_case,
                    total_kg            = EXCLUDED.total_kg,
                    note                = EXCLUDED.note,
                    updated_at          = now()
            """, (
                it.object_id, body.inventory_date,
                it.inbound_lot_id, it.material_id, it.semifinished_lot_id,
                it.crop_id, it.origin_text, it.spec_text,
                name,
                it.cases, it.kg_per_case, it.total_kg,
            ))
            imported += 1

    await write_audit(db, "STORAGE_INV_ENTRY_BULK_IMPORT",
                      "storage_object_inventory_entries",
                      str(layout_id),
                      {"layout_id": layout_id, "date": body.inventory_date,
                       "imported": imported, "skipped": skipped},
                      user["id"], request)
    return {"imported": imported, "skipped": skipped,
            "inventory_date": body.inventory_date}


# =============================================================================
# 集計表頁 メタデータ (Phase A2.3) — タイトル / 自由テキスト の 編集 保存
# =============================================================================

class SheetMetaData(BaseModel):
    report_title:    str | None = None
    report_subtitle: str | None = None
    header_note:     str | None = None
    footer_note:     str | None = None
    # key: "{cat_major or ''}|{cat_minor or ''}"
    group_titles:    dict[str, str] | None = None
    group_notes:     dict[str, str] | None = None

@router.get("/layouts/{layout_id}/sheet-meta", response_model=SheetMetaData)
async def get_layout_sheet_meta(layout_id: int, db: DB, user: CurrentUser):
    """layout の 集計表頁 メタ を 取得。 未保存 なら 空 dict を 返す。"""
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT data FROM storage_layout_sheet_meta WHERE layout_id=%s",
            (layout_id,))
        row = await cur.fetchone()
    if not row:
        return SheetMetaData()
    return SheetMetaData(**(row["data"] or {}))

@router.put("/layouts/{layout_id}/sheet-meta", response_model=SheetMetaData)
async def put_layout_sheet_meta(
    layout_id: int, body: SheetMetaData,
    db: DB, user: CurrentUser, request: Request,
):
    """layout の 集計表頁 メタ を 上書き 保存 (UPSERT)。"""
    # layout 存在 確認
    async with db.cursor() as cur:
        await cur.execute("SELECT id FROM storage_layouts WHERE id=%s", (layout_id,))
        if not await cur.fetchone():
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="レイアウトが見つかりません")

        data_json = body.model_dump(exclude_none=True)
        await cur.execute("""
            INSERT INTO storage_layout_sheet_meta (layout_id, data, updated_by)
            VALUES (%s, %s::jsonb, %s)
            ON CONFLICT (layout_id) DO UPDATE SET
              data = EXCLUDED.data,
              updated_by = EXCLUDED.updated_by,
              updated_at = now()
        """, (layout_id, json.dumps(data_json, ensure_ascii=False), user["id"]))

    await write_audit(db, "STORAGE_SHEET_META_PUT",
                      "storage_layout_sheet_meta", str(layout_id),
                      {"layout_id": layout_id}, user["id"], request)
    return body


# =============================================================================
# 集計表頁 sheet-data (Phase A2.1)
# =============================================================================
# 棚卸エントリ のみ を ソース と し、 (大分類, 小分類) で サブ表 を 分け、
# サブ表 内 で (産地, 規格, サブ規格) に groupby + sum (cases / total_kg)。
# 既存 storage_object_items (lot/material 紐付け) は ソース に 含めない 方針:
# 集計表 は あくまで 「棚卸 スナップショット」 の 集計 (user 合意 2026-05-24)。
# canvas (左 ペイン) は 別途 既存 状態 を そのまま 表示 する。

@router.get("/layouts/{layout_id}/sheet-data")
async def get_layout_sheet_data(
    layout_id: int, db: DB, user: CurrentUser,
    date: str | None = Query(None,
        description="YYYY-MM-DD。 指定時 は その日以前 の 最新 entries を 集計。 省略時 は 今日"),
):
    """集計表頁 用 データ。 戻り 形式:
        {
          "layout": { ... },
          "date": "2026-05-24",
          "groups": [
            {
              "category_major": "原料" or null,
              "category_minor": "生姜" or null,
              "rows": [
                {
                  "origin": "中国",
                  "spec": "100g",
                  "sub_spec": null or "L 寸 のみ",
                  "cases_sum": 12.0,
                  "kg_per_case_repr": 10.0,   # 最頻値 / 代表値 (混在 時 注意)
                  "total_kg_sum": 120.0,
                  "entry_count": 2,           # 何 件 の entry を 集約 したか
                }
              ]
            }
          ]
        }
    """
    eff_date = date or None
    async with db.cursor() as cur:
        await cur.execute("SELECT * FROM storage_layouts WHERE id=%s", (layout_id,))
        layout = await cur.fetchone()
        if not layout:
            raise HTTPException(status.HTTP_404_NOT_FOUND)

        # date 指定時: 各 (object, name) で その日以前 の 最新 1 件 のみ
        # 省略時: 今日 以前 を 同様 (= レポート は 「今日 時点 の 棚卸」 を 出す のが 普通)
        await cur.execute("""
            WITH latest AS (
                SELECT DISTINCT ON (e.object_id, COALESCE(e.name, '')) e.*
                  FROM storage_object_inventory_entries e
                  JOIN storage_objects o ON o.id = e.object_id
                 WHERE o.layout_id = %s
                   AND e.inventory_date <= COALESCE(%s::date, CURRENT_DATE)
                 ORDER BY e.object_id, COALESCE(e.name, ''),
                          e.inventory_date DESC, e.id DESC
            )
            SELECT
                COALESCE(NULLIF(TRIM(category_major), ''), NULL) AS cmaj,
                COALESCE(NULLIF(TRIM(category_minor), ''), NULL) AS cmin,
                COALESCE(NULLIF(TRIM(origin_text),    ''), NULL) AS origin,
                COALESCE(NULLIF(TRIM(spec_text),      ''), NULL) AS spec,
                COALESCE(NULLIF(TRIM(sub_spec_text),  ''), NULL) AS sub_spec,
                SUM(cases)    AS cases_sum,
                SUM(total_kg) AS total_kg_sum,
                COUNT(*)      AS entry_count,
                -- kg_per_case は 行 ごと に 異なる 可能性 → 代表 値 と して 加重 平均 (total_kg / cases)
                CASE WHEN COALESCE(SUM(cases), 0) > 0
                     THEN ROUND(SUM(total_kg) / NULLIF(SUM(cases), 0), 4)
                     ELSE NULL END AS kg_per_case_repr
              FROM latest
             GROUP BY cmaj, cmin, origin, spec, sub_spec
             ORDER BY cmaj NULLS LAST, cmin NULLS LAST,
                      origin NULLS LAST, spec NULLS LAST, sub_spec NULLS LAST
        """, (layout_id, eff_date))
        rows = await cur.fetchall()

    # (大分類, 小分類) で サブ表 に 分割
    groups: list[dict] = []
    current_key: tuple[str | None, str | None] | None = None
    current_rows: list[dict] = []
    for r in rows:
        k = (r["cmaj"], r["cmin"])
        if k != current_key:
            if current_key is not None:
                groups.append({
                    "category_major": current_key[0],
                    "category_minor": current_key[1],
                    "rows": current_rows,
                })
            current_key = k
            current_rows = []
        current_rows.append({
            "origin":           r["origin"],
            "spec":             r["spec"],
            "sub_spec":         r["sub_spec"],
            "cases_sum":        float(r["cases_sum"]) if r["cases_sum"] is not None else None,
            "kg_per_case_repr": float(r["kg_per_case_repr"]) if r["kg_per_case_repr"] is not None else None,
            "total_kg_sum":     float(r["total_kg_sum"]) if r["total_kg_sum"] is not None else None,
            "entry_count":      int(r["entry_count"]),
        })
    if current_key is not None:
        groups.append({
            "category_major": current_key[0],
            "category_minor": current_key[1],
            "rows": current_rows,
        })

    return {
        "layout": dict(layout),
        "date": eff_date,
        "groups": groups,
    }
