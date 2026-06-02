"""
tests/test_selection_garbage.py
=================================
M1-P2 で 追加した 「選別ゴミ」 仕様 の 検証 (DB 統合)。

検証ポイント:
  - ゴミ output は 単価強制 0
  - 非ゴミ output は 全部 同単価 (= 投入総評価額 / 非ゴミ出力総量)
  - 出力総評価額 = 投入総評価額 (整合性保証)
  - ゴミだけの 選別 = shared_price=None で 出力全部 0 円
  - 半製品台帳 list で ゴミ も 取れる (UI 側で フィルタ)
"""
from __future__ import annotations

import os
import uuid
from decimal import Decimal

import pytest
import pytest_asyncio

DATABASE_URL = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not DATABASE_URL,
    reason="DATABASE_URL 未設定",
)


# -----------------------------------------------------------------------------
# Seed: 大蒜実験 (crop_id=12) 用 — origin + 通常grade + ゴミgrade + 投入lot
# -----------------------------------------------------------------------------

@pytest_asyncio.fixture
async def garbage_seed(test_db, admin_user):
    """以下を test_db 内に 作成:
      - 1 origin (テスト用)
      - 2 通常 grade (A, B) + ゴミ grade を find or create
      - 3 products (A品, B品, ゴミ品) すべて crop_id=12
      - 1 supplier
      - 1 inbound_lot (A品 100kg, 単価 1000円 = 100,000円分)
    """
    tag = uuid.uuid4().hex[:8]
    admin_id, _ = admin_user
    async with test_db.cursor() as cur:
        await cur.execute(
            "INSERT INTO origins (name) VALUES (%s) RETURNING id",
            (f"ゴミテスト_{tag}",))
        origin_id = (await cur.fetchone())["id"]

        await cur.execute(
            "INSERT INTO grades (spec_type, grade_level, size_label) VALUES (%s, 'A', 'L') RETURNING id",
            (f"ゴミ規格A_{tag}",))
        grade_a = (await cur.fetchone())["id"]
        await cur.execute(
            "INSERT INTO grades (spec_type, grade_level, size_label) VALUES (%s, 'B', 'L') RETURNING id",
            (f"ゴミ規格B_{tag}",))
        grade_b = (await cur.fetchone())["id"]

        # ゴミ grade を find or create (mig 068 で 追加 済み の はず)
        await cur.execute(
            "SELECT id FROM grades WHERE spec_type='選別ゴミ' AND grade_level='-' AND size_label='-'"
        )
        row = await cur.fetchone()
        if row:
            grade_garbage = row["id"]
        else:
            await cur.execute(
                "INSERT INTO grades (spec_type, grade_level, size_label) VALUES ('選別ゴミ', '-', '-') RETURNING id"
            )
            grade_garbage = (await cur.fetchone())["id"]

        # products (crop_id=12 = 大蒜実験)
        await cur.execute(
            "INSERT INTO products (crop_id, grade_id, origin_id) VALUES (12, %s, %s) RETURNING id",
            (grade_a, origin_id))
        product_a = (await cur.fetchone())["id"]
        await cur.execute(
            "INSERT INTO products (crop_id, grade_id, origin_id) VALUES (12, %s, %s) RETURNING id",
            (grade_b, origin_id))
        product_b = (await cur.fetchone())["id"]
        await cur.execute(
            "INSERT INTO products (crop_id, grade_id, origin_id) VALUES (12, %s, %s) ON CONFLICT DO NOTHING RETURNING id",
            (grade_garbage, origin_id))
        row = await cur.fetchone()
        if row:
            product_garbage = row["id"]
        else:
            # 既存 → SELECT
            await cur.execute(
                "SELECT id FROM products WHERE crop_id=12 AND grade_id=%s AND origin_id=%s",
                (grade_garbage, origin_id))
            product_garbage = (await cur.fetchone())["id"]

        # supplier
        await cur.execute(
            "INSERT INTO suppliers (name) VALUES (%s) RETURNING id",
            (f"ゴミテスト仕入_{tag}",))
        supplier_id = (await cur.fetchone())["id"]

        # inbound lot: A品 100kg × 1000円 = 100,000円分
        await cur.execute("SELECT next_lot_code('02', 'G') AS code")
        code = (await cur.fetchone())["code"]
        await cur.execute(
            """INSERT INTO inbound_lots
                 (code, product_id, supplier_id, inbound_date, cases, kg_per_case,
                  total_kg, unit_price, created_by)
               VALUES (%s, %s, %s, '2026-05-01', 10, 10, 100, 1000, %s)
               RETURNING id""",
            (code, product_a, supplier_id, admin_id))
        source_lot_id = (await cur.fetchone())["id"]

    return {
        "origin_id":       origin_id,
        "grade_a":         grade_a,
        "grade_b":         grade_b,
        "grade_garbage":   grade_garbage,
        "product_a":       product_a,
        "product_b":       product_b,
        "product_garbage": product_garbage,
        "source_lot_id":   source_lot_id,
        "supplier_id":     supplier_id,
    }


# -----------------------------------------------------------------------------
# /selection/compute (preview) の 検証
# -----------------------------------------------------------------------------

class TestComputeWithGarbage:
    async def test_garbage_price_is_zero_others_share_value(self, client, garbage_seed):
        """A:80kg + B:15kg + ゴミ:5kg / 投入100kg×1000円 → A=B=1052.63、 ゴミ=0"""
        r = await client.post("/selection/compute", json={
            "sources": [{"lot_id": garbage_seed["source_lot_id"], "source_kg": "100"}],
            "outputs": [
                {"product_id": garbage_seed["product_a"],       "quantity_kg": "80"},
                {"product_id": garbage_seed["product_b"],       "quantity_kg": "15"},
                {"product_id": garbage_seed["product_garbage"], "quantity_kg": "5"},
            ],
        })
        assert r.status_code == 200, r.text
        data = r.json()

        # 出力単価: A=B=1052.63 (= 100000/95)、 ゴミ=0
        prices = [Decimal(p) for p in data["output_unit_prices"]]
        assert prices[0] == Decimal("1052.63"), f"A の 単価 expected 1052.63 got {prices[0]}"
        assert prices[1] == Decimal("1052.63"), f"B の 単価 expected 1052.63 got {prices[1]}"
        assert prices[2] == Decimal("0"),       f"ゴミ単価 expected 0 got {prices[2]}"

        # 整合性: 投入総評価額 = 出力総評価額 ≒ 100,000
        # ゴミ 5kg を 除いた 95kg × 1052.63 = 99,999.85 (丸め誤差 0.15)
        sources_value = Decimal(data["sources_total_value"])
        outputs_value = Decimal(data["output_total_value"])
        assert sources_value == Decimal("100000.00")
        assert outputs_value == sources_value

        # ゴミ量 / 非ゴミ量
        assert Decimal(data["garbage_total_kg"]) == Decimal("5")
        assert Decimal(data["non_garbage_total_kg"]) == Decimal("95")

    async def test_all_garbage_returns_null_shared_price(self, client, garbage_seed):
        """投入100kg → 全部ゴミ100kg なら shared_price=None で 全 output 単価 0"""
        r = await client.post("/selection/compute", json={
            "sources": [{"lot_id": garbage_seed["source_lot_id"], "source_kg": "100"}],
            "outputs": [
                {"product_id": garbage_seed["product_garbage"], "quantity_kg": "100"},
            ],
        })
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["weighted_unit_price"] is None
        assert Decimal(data["output_unit_prices"][0]) == Decimal("0")
        # 投入 100,000円 は どこへ? → 出力総評価額 0 (= ロス計上 と 同等)
        # 但し sources_total_value は 100,000 のまま
        assert Decimal(data["sources_total_value"]) == Decimal("100000.00")

    async def test_no_garbage_acts_like_old_spec(self, client, garbage_seed):
        """ゴミなし (旧仕様 と 同じ) → A=B 共通単価 で 整合"""
        r = await client.post("/selection/compute", json={
            "sources": [{"lot_id": garbage_seed["source_lot_id"], "source_kg": "100"}],
            "outputs": [
                {"product_id": garbage_seed["product_a"], "quantity_kg": "60"},
                {"product_id": garbage_seed["product_b"], "quantity_kg": "40"},
            ],
        })
        assert r.status_code == 200, r.text
        data = r.json()
        # 100,000 / 100 = 1000
        prices = [Decimal(p) for p in data["output_unit_prices"]]
        assert prices[0] == Decimal("1000.00")
        assert prices[1] == Decimal("1000.00")
        assert Decimal(data["garbage_total_kg"]) == Decimal("0")


# -----------------------------------------------------------------------------
# /selection/operations (実行) の 検証
# -----------------------------------------------------------------------------

class TestExecuteWithGarbage:
    async def test_execute_creates_semifinished_with_correct_prices(
        self, client, garbage_seed, test_db,
    ):
        """選別実行 → semifinished_lots に ゴミ は unit_price=0、 他は 共通単価 で INSERT"""
        r = await client.post("/selection/operations", json={
            "sources": [{"lot_id": garbage_seed["source_lot_id"], "source_kg": "100"}],
            "outputs": [
                {"product_id": garbage_seed["product_a"],       "quantity_kg": "80"},
                {"product_id": garbage_seed["product_garbage"], "quantity_kg": "20"},
            ],
            "operation_date": "2026-05-23",
            "note": "test garbage",
        })
        assert r.status_code == 201, r.text
        data = r.json()
        op_id = data["id"]

        # 半製品 INSERT 検証
        async with test_db.cursor() as cur:
            await cur.execute(
                """SELECT sl.product_id, sl.total_kg, sl.unit_price, g.spec_type
                   FROM semifinished_lots sl
                   JOIN products p ON p.id = sl.product_id
                   JOIN grades g   ON g.id = p.grade_id
                   WHERE sl.selection_id = %s
                   ORDER BY sl.id""",
                (op_id,))
            rows = await cur.fetchall()
        assert len(rows) == 2
        a_row = next(r for r in rows if r["spec_type"] != "選別ゴミ")
        g_row = next(r for r in rows if r["spec_type"] == "選別ゴミ")
        # A品: 100,000 / 80 = 1250
        assert Decimal(str(a_row["unit_price"])) == Decimal("1250.00")
        assert Decimal(str(a_row["total_kg"])) == Decimal("80")
        # ゴミ: 0
        assert Decimal(str(g_row["unit_price"])) == Decimal("0.00")
        assert Decimal(str(g_row["total_kg"])) == Decimal("20")
