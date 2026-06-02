"""
tests/test_recipe_consumption.py
=================================
レシピ駆動の資材自動消耗 (material_stock VIEW) の SQL 統合テスト。

このロジックは商品出荷 (shipment_records) と (商品, 資材) レシピ
(product_material_usage) を組合せ、資材の理論在庫を毎日減らす計算。
SQL VIEW の中で DISTINCT ON + NULLS LAST により「部署別オーバーライド優先、
無ければデフォルトのレシピ」を採用する重要分岐がある。

このテストは実 DB に接続し、各テストはトランザクション内で実行されて
最後に必ず ROLLBACK されるためデータ汚染なし。

カバレッジ:
  - デフォルトレシピのみ → そのレシピで消耗
  - 部署別オーバーライド + デフォルト両方ある → 部署一致出荷はオーバーライド採用
  - 部署別オーバーライドあり + 部署一致しない出荷 → デフォルト採用
  - 長さ管理資材 (length_per_roll_cm) → cm 値が巻数に換算される
  - レシピ無し商品 → 自動消耗ゼロ
"""

from __future__ import annotations

import os
from datetime import date
from decimal import Decimal

import psycopg
import pytest
import pytest_asyncio

DATABASE_URL = os.environ.get("DATABASE_URL")


# 環境変数が無い CI 等では skip
pytestmark = pytest.mark.skipif(
    not DATABASE_URL,
    reason="DATABASE_URL 未設定 — DB 統合テストはスキップ",
)


@pytest_asyncio.fixture
async def conn():
    """テスト用接続 — 各テストの最後に必ず ROLLBACK する。
    autocommit=False で接続し、明示的に rollback。"""
    c = await psycopg.AsyncConnection.connect(
        DATABASE_URL, autocommit=False,
        row_factory=psycopg.rows.dict_row,
    )
    try:
        yield c
        await c.rollback()
    finally:
        await c.close()


async def _ensure_test_user(cur) -> str:
    """テスト用の users 行を確保 (created_by FK 用)。
    Test runs are rollback-only so we use a fresh user per test (unique device_token)
    to avoid touching production users.
    """
    import uuid
    token = f"__test_{uuid.uuid4().hex[:8]}__"
    await cur.execute(
        """INSERT INTO users (display_name, role, is_active, device_token)
           VALUES ('__test_consumption__', 'admin', true, %s)
           RETURNING id""", (token,))
    return (await cur.fetchone())["id"]


async def _ensure_test_supplier(cur) -> int:
    """テスト用 suppliers 行を確保し id を返す。
    mig 025 で materials.supplier_id が NOT NULL になったため、各テストで必須。
    """
    import uuid
    name = f"__test_supplier_{uuid.uuid4().hex[:8]}__"
    await cur.execute(
        """INSERT INTO suppliers (name) VALUES (%s) RETURNING id""",
        (name,))
    return (await cur.fetchone())["id"]


async def _setup_material(cur, user_id: str, *,
                           code: str = 'TEST_M_001',
                           length_per_roll_cm: int | None = None) -> int:
    """テスト用 material 作成。code は固有である必要がある (UNIQUE 制約)"""
    supplier_id = await _ensure_test_supplier(cur)
    await cur.execute(
        """INSERT INTO materials (code, division, supplier_id, supplier_name,
                                  item_name, unit, length_per_roll_cm)
           VALUES (%s, 99, %s, '__test__', '__test_item__', '枚', %s)
           RETURNING id""",
        (code, supplier_id, length_per_roll_cm))
    return (await cur.fetchone())["id"]


async def _setup_product(cur) -> int:
    """テスト用 商品出荷マスタ (products_shipped) を作成"""
    await cur.execute(
        """INSERT INTO products_shipped (division, name, unit, is_active)
           VALUES (99, '__test_product__', '個', true)
           RETURNING id""")
    return (await cur.fetchone())["id"]


async def _add_recipe(cur, product_id: int, material_id: int,
                       qty_per_unit: Decimal, department_code: str | None = None):
    await cur.execute(
        """INSERT INTO product_material_usage
                (product_id, material_id, quantity_per_unit, department_code)
           VALUES (%s, %s, %s, %s)""",
        (product_id, material_id, qty_per_unit, department_code))


async def _add_shipment(cur, product_id: int, ship_date: date,
                         quantity: Decimal,
                         created_by: str,
                         department_code: str | None = None):
    await cur.execute(
        """INSERT INTO shipment_records
                (product_id, ship_date, quantity, department_code, created_by)
           VALUES (%s, %s, %s, %s, %s)""",
        (product_id, ship_date, quantity, department_code, created_by))


async def _get_auto_consumption(cur, material_id: int) -> Decimal:
    """material_stock VIEW から auto_consumption_qty を取得"""
    await cur.execute(
        "SELECT auto_consumption_qty FROM material_stock WHERE material_id = %s",
        (material_id,))
    row = await cur.fetchone()
    return Decimal(str(row["auto_consumption_qty"]))


# =============================================================================
# テスト
# =============================================================================

class TestRecipeAutoConsumption:

    @pytest.mark.asyncio
    async def test_default_recipe_basic_consumption(self, conn):
        """デフォルトレシピのみの場合: shipment_records × pmu.quantity_per_unit"""
        async with conn.cursor() as cur:
            uid = await _ensure_test_user(cur)
            mid = await _setup_material(cur, uid, code='TEST_DEF_001')
            pid = await _setup_product(cur)
            await _add_recipe(cur, pid, mid, Decimal('5'))   # 1 点 = 5 枚
            await _add_shipment(cur, pid, date(2026, 5, 10), Decimal('10'), uid)  # 10 点出荷
            # 期待: 10 点 × 5 枚 = 50 枚 自動消耗
            consumed = await _get_auto_consumption(cur, mid)
            assert consumed == Decimal('50')

    @pytest.mark.asyncio
    async def test_department_override_takes_precedence(self, conn):
        """部署別オーバーライドあり + 部署一致出荷 → オーバーライドの qty 採用"""
        async with conn.cursor() as cur:
            uid = await _ensure_test_user(cur)
            mid = await _setup_material(cur, uid, code='TEST_OVR_001')
            pid = await _setup_product(cur)
            await _add_recipe(cur, pid, mid, Decimal('5'), department_code=None)    # default
            await _add_recipe(cur, pid, mid, Decimal('12'), department_code='D02')  # 部署D02 用
            await _add_shipment(cur, pid, date(2026, 5, 10),
                                 Decimal('10'), uid, department_code='D02')
            # 部署 D02 出荷なのでオーバーライド (12) が採用される → 10 × 12 = 120
            consumed = await _get_auto_consumption(cur, mid)
            assert consumed == Decimal('120')

    @pytest.mark.asyncio
    async def test_department_mismatch_falls_back_to_default(self, conn):
        """部署別オーバーライドあるが部署が一致しない出荷 → デフォルト採用"""
        async with conn.cursor() as cur:
            uid = await _ensure_test_user(cur)
            mid = await _setup_material(cur, uid, code='TEST_FBK_001')
            pid = await _setup_product(cur)
            await _add_recipe(cur, pid, mid, Decimal('5'), department_code=None)
            await _add_recipe(cur, pid, mid, Decimal('12'), department_code='D02')
            await _add_shipment(cur, pid, date(2026, 5, 10),
                                 Decimal('10'), uid, department_code='D99')   # D99 (一致なし)
            # → デフォルト (5) 採用、10 × 5 = 50
            consumed = await _get_auto_consumption(cur, mid)
            assert consumed == Decimal('50')

    @pytest.mark.asyncio
    async def test_no_recipe_zero_consumption(self, conn):
        """レシピ未登録の商品の出荷 → その資材は自動消耗ゼロ"""
        async with conn.cursor() as cur:
            uid = await _ensure_test_user(cur)
            mid = await _setup_material(cur, uid, code='TEST_NORECIPE_001')
            pid = await _setup_product(cur)
            # レシピ無し
            await _add_shipment(cur, pid, date(2026, 5, 10), Decimal('100'), uid)
            consumed = await _get_auto_consumption(cur, mid)
            assert consumed == Decimal('0')

    @pytest.mark.asyncio
    async def test_length_managed_material_converts_cm_to_rolls(self, conn):
        """length_per_roll_cm=5000 の巻資材: レシピ qty (cm) は巻数に換算
        例: レシピ 1 商品=20cm 消耗, 100 商品出荷 → 2000cm → 2000/5000 = 0.4 巻"""
        async with conn.cursor() as cur:
            uid = await _ensure_test_user(cur)
            mid = await _setup_material(cur, uid, code='TEST_LEN_001',
                                         length_per_roll_cm=5000)
            pid = await _setup_product(cur)
            await _add_recipe(cur, pid, mid, Decimal('20'))    # 1 商品 = 20cm
            await _add_shipment(cur, pid, date(2026, 5, 10), Decimal('100'), uid)
            # 期待: 20 × 100 = 2000 cm / 5000 = 0.4 巻
            consumed = await _get_auto_consumption(cur, mid)
            assert consumed == Decimal('0.4').quantize(Decimal('0.0001'))

    @pytest.mark.asyncio
    async def test_multiple_shipments_aggregated(self, conn):
        """複数日の出荷が累積される"""
        async with conn.cursor() as cur:
            uid = await _ensure_test_user(cur)
            mid = await _setup_material(cur, uid, code='TEST_MULTI_001')
            pid = await _setup_product(cur)
            await _add_recipe(cur, pid, mid, Decimal('3'))
            await _add_shipment(cur, pid, date(2026, 5, 1), Decimal('10'), uid)
            await _add_shipment(cur, pid, date(2026, 5, 2), Decimal('20'), uid)
            await _add_shipment(cur, pid, date(2026, 5, 3), Decimal('5'), uid)
            # (10+20+5) × 3 = 105
            consumed = await _get_auto_consumption(cur, mid)
            assert consumed == Decimal('105')
