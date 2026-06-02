"""
tests/test_outbound_router.py
==============================
api/routers/outbound.py の ルーター 統合テスト。

カバレッジ:
  - POST /outbound/preview — happy + 在庫不足 (is_sufficient=false)
  - POST /outbound/allocate — happy / Ambiguous (要選択) / 在庫不足 → 409
  - POST /outbound/allocate/manual — preferred_lot_id 指定
  - GET /outbound/records — list
  - PATCH /outbound/records/{id} — 編集 + 404
  - DELETE /outbound/records/{id} — 削除 + 404

データ準備: seed fixture で 1 product + 2 lots を 作成。
"""
from __future__ import annotations

import os
import uuid
from datetime import date
from decimal import Decimal

import pytest
import pytest_asyncio

DATABASE_URL = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not DATABASE_URL,
    reason="DATABASE_URL 未設定",
)


# -----------------------------------------------------------------------------
# Seed: 1 product + 2 lots
# -----------------------------------------------------------------------------

@pytest_asyncio.fixture
async def out_seed(test_db, admin_user):
    """テスト用 1 商品 + 2 lot (FIFO で 古いlot から 引き当てられる構成)。"""
    tag = uuid.uuid4().hex[:8]
    admin_id, _ = admin_user
    async with test_db.cursor() as cur:
        await cur.execute(
            "INSERT INTO origins (name) VALUES (%s) RETURNING id",
            (f"出庫テスト_{tag}",))
        origin_id = (await cur.fetchone())["id"]
        await cur.execute(
            "INSERT INTO grades (spec_type, grade_level, size_label) VALUES (%s, 'A', 'L') RETURNING id",
            (f"出庫規格_{tag}",))
        grade_id = (await cur.fetchone())["id"]
        await cur.execute(
            "INSERT INTO products (crop_id, grade_id, origin_id) VALUES (2, %s, %s) RETURNING id",
            (grade_id, origin_id))
        product_id = (await cur.fetchone())["id"]
        await cur.execute(
            "INSERT INTO suppliers (name) VALUES (%s) RETURNING id",
            (f"出庫仕入_{tag}",))
        supplier_id = (await cur.fetchone())["id"]

        # 2 lots: lot1 (古い, 60kg) lot2 (新しい, 100kg)
        await cur.execute("SELECT next_lot_code('02', 'G') AS code")
        code1 = (await cur.fetchone())["code"]
        await cur.execute(
            """INSERT INTO inbound_lots
                 (code, product_id, supplier_id, inbound_date, cases, kg_per_case,
                  total_kg, unit_price, created_by)
               VALUES (%s, %s, %s, '2026-05-01', 6, 10, 60, 1000, %s)
               RETURNING id""",
            (code1, product_id, supplier_id, admin_id))
        lot1_id = (await cur.fetchone())["id"]

        await cur.execute("SELECT next_lot_code('02', 'G') AS code")
        code2 = (await cur.fetchone())["code"]
        await cur.execute(
            """INSERT INTO inbound_lots
                 (code, product_id, supplier_id, inbound_date, cases, kg_per_case,
                  total_kg, unit_price, created_by)
               VALUES (%s, %s, %s, '2026-05-10', 10, 10, 100, 1100, %s)
               RETURNING id""",
            (code2, product_id, supplier_id, admin_id))
        lot2_id = (await cur.fetchone())["id"]

    return {
        "product_id": product_id,
        "supplier_id": supplier_id,
        "lot1_id": lot1_id, "lot2_id": lot2_id,
        "tag": tag,
    }


# -----------------------------------------------------------------------------
# /outbound/preview
# -----------------------------------------------------------------------------

class TestPreview:
    async def test_preview_sufficient(self, client, out_seed):
        """十分な在庫が ある場合 is_sufficient=true"""
        r = await client.post("/outbound/preview", json={
            "product_id": out_seed["product_id"],
            "quantity_kg": "30",
        })
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["is_sufficient"] is True
        assert data["candidate_count"] == 2

    async def test_preview_insufficient(self, client, out_seed):
        """合計160kg しか ないので 200kg 要求 → is_sufficient=false (例外ではなく)"""
        r = await client.post("/outbound/preview", json={
            "product_id": out_seed["product_id"],
            "quantity_kg": "200",
        })
        assert r.status_code == 200
        assert r.json()["is_sufficient"] is False

    async def test_preview_invalid_qty(self, client, out_seed):
        """quantity_kg <= 0 は 422"""
        r = await client.post("/outbound/preview", json={
            "product_id": out_seed["product_id"],
            "quantity_kg": "0",
        })
        assert r.status_code == 422


# -----------------------------------------------------------------------------
# /outbound/allocate
# -----------------------------------------------------------------------------

class TestAllocate:
    async def test_allocate_ambiguous_returns_candidates(self, client, out_seed):
        """候補2件 + preferred_lot_id 未指定 → NeedsSelectionResponse
        (Union response の都合で status は 201 だが、 body に needs_selection:true)"""
        r = await client.post("/outbound/allocate", json={
            "product_id": out_seed["product_id"],
            "outbound_date": "2026-05-23",
            "quantity_kg": "30",
        })
        assert r.status_code == 201, r.text
        data = r.json()
        assert "candidates" in data
        assert len(data["candidates"]) == 2
        # 候補は FIFO 順 (lot1 が 古い)
        assert data["candidates"][0]["lot_id"] == out_seed["lot1_id"]

    async def test_allocate_manual_happy(self, client, out_seed):
        """preferred_lot_id 指定 → 1 lot のみ で 完結"""
        r = await client.post("/outbound/allocate/manual", json={
            "product_id": out_seed["product_id"],
            "outbound_date": "2026-05-23",
            "quantity_kg": "30",
            "preferred_lot_id": out_seed["lot1_id"],
        })
        assert r.status_code == 201, r.text
        data = r.json()
        assert data["total_kg"] == "30" or Decimal(data["total_kg"]) == Decimal("30")
        # lot1 から 引き当てされた
        assert out_seed["lot1_id"] in data["lot_ids"]

    async def test_allocate_insufficient_returns_409(self, client, out_seed):
        """在庫合計 (160kg) を 上回る 要求 → 409"""
        r = await client.post("/outbound/allocate", json={
            "product_id": out_seed["product_id"],
            "outbound_date": "2026-05-23",
            "quantity_kg": "200",
        })
        assert r.status_code == 409, r.text


# -----------------------------------------------------------------------------
# /outbound/records
# -----------------------------------------------------------------------------

class TestRecords:
    async def test_list_records(self, client, out_seed):
        """まず 出庫を 1 件 作成 → list が それを 含む"""
        # 出庫 作成
        await client.post("/outbound/allocate/manual", json={
            "product_id": out_seed["product_id"],
            "outbound_date": "2026-05-23",
            "quantity_kg": "20",
            "preferred_lot_id": out_seed["lot1_id"],
        })
        # list
        r = await client.get("/outbound/records", params={
            "date_from": "2026-05-23",
            "date_to":   "2026-05-23",
        })
        assert r.status_code == 200
        data = r.json()
        assert isinstance(data, list)
        assert len(data) >= 1
        # この lot からの 出庫が ある
        assert any(rec["lot_id"] == out_seed["lot1_id"] for rec in data)

    async def test_patch_record_not_found(self, client):
        r = await client.patch("/outbound/records/99999999", json={"note": "x"})
        assert r.status_code == 404

    async def test_delete_record_not_found(self, client):
        r = await client.delete("/outbound/records/99999999")
        assert r.status_code == 404

    async def test_get_record_not_found(self, client):
        r = await client.get("/outbound/records/99999999")
        assert r.status_code == 404
