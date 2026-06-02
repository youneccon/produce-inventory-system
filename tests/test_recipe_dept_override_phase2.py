"""
tests/test_recipe_dept_override_phase2.py
==========================================
Phase 2 で部署スコープ化した 3 エンドポイントの DB 統合テスト。

対象:
  - PUT  /shipments/recipes/bulk                     (department_code 対応)
  - POST /shipments/products/{pid}/recipes/{mid}/swap-with-alternative (同)
  - POST /shipments/recipes/estimate                 (同)

ロジックを直接呼ぶのではなく SQL を直に検証するスタイル
(test_recipe_consumption.py と同じパターン)。
各テストは個別接続でロールバックされるためデータ汚染なし。
"""

from __future__ import annotations

import os
import uuid
from datetime import date
from decimal import Decimal

import psycopg
import pytest
import pytest_asyncio

DATABASE_URL = os.environ.get("DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not DATABASE_URL,
    reason="DATABASE_URL 未設定 — DB 統合テストはスキップ",
)


@pytest_asyncio.fixture
async def conn():
    c = await psycopg.AsyncConnection.connect(
        DATABASE_URL, autocommit=False,
        row_factory=psycopg.rows.dict_row,
    )
    try:
        yield c
        await c.rollback()
    finally:
        await c.close()


# ---------- ヘルパー (test_recipe_consumption.py と類似) -----------

async def _ensure_test_admin(cur) -> str:
    token = f"__test_{uuid.uuid4().hex[:8]}__"
    await cur.execute(
        """INSERT INTO users (display_name, role, is_active, device_token)
           VALUES ('__test_phase2_admin__', 'admin', true, %s)
           RETURNING id""", (token,))
    return (await cur.fetchone())["id"]


async def _ensure_test_supplier(cur) -> int:
    """mig 025 で materials.supplier_id が NOT NULL になったため必須。"""
    name = f"__test_supplier_{uuid.uuid4().hex[:8]}__"
    await cur.execute(
        """INSERT INTO suppliers (name) VALUES (%s) RETURNING id""", (name,))
    return (await cur.fetchone())["id"]


async def _setup_material(cur, *, code: str) -> int:
    # item_name は code を流用して business_key (division, supplier_id, item_name)
    # の UNIQUE 制約に抵触しないようにする
    supplier_id = await _ensure_test_supplier(cur)
    await cur.execute(
        """INSERT INTO materials (code, division, supplier_id, supplier_name,
                                  item_name, unit)
           VALUES (%s, 99, %s, '__test__', %s, '枚')
           RETURNING id""", (code, supplier_id, f"__mat_{code}__"))
    return (await cur.fetchone())["id"]


async def _setup_product(cur, name: str = '__test_product__') -> int:
    await cur.execute(
        """INSERT INTO products_shipped (division, name, unit, is_active)
           VALUES (99, %s, '個', true) RETURNING id""", (name,))
    return (await cur.fetchone())["id"]


async def _get_recipe_row(cur, product_id: int, material_id: int,
                          department_code: str | None):
    await cur.execute(
        """SELECT * FROM product_material_usage
           WHERE product_id=%s AND material_id=%s
             AND COALESCE(department_code, '__DEFAULT__') = COALESCE(%s, '__DEFAULT__')""",
        (product_id, material_id, department_code))
    return await cur.fetchone()


# =============================================================================
# bulk — 部署スコープで INSERT/UPDATE/DELETE が独立する
# =============================================================================

class TestBulkPhase2:

    @pytest.mark.asyncio
    async def test_bulk_set_creates_dept_override_independent_of_default(self, conn):
        """同じ (product, material) でも dept 違いなら 2 行 INSERT される"""
        async with conn.cursor() as cur:
            await _ensure_test_admin(cur)
            mid = await _setup_material(cur, code='TEST_BULK_P2_001')
            pid = await _setup_product(cur)
            # まずデフォルト行を作る
            await cur.execute(
                """INSERT INTO product_material_usage
                       (product_id, material_id, quantity_per_unit)
                   VALUES (%s, %s, %s)""", (pid, mid, Decimal('5')))
            # 同じ key で dept=D02 用に追加 — UNIQUE INDEX
            # (product, material, COALESCE(dept, __DEFAULT__)) なので衝突しない
            await cur.execute(
                """INSERT INTO product_material_usage
                       (product_id, material_id, quantity_per_unit, department_code)
                   VALUES (%s, %s, %s, %s)""", (pid, mid, Decimal('12'), 'D02'))
            # デフォルト + D02 の 2 行が独立して存在
            r_def = await _get_recipe_row(cur, pid, mid, None)
            r_d02 = await _get_recipe_row(cur, pid, mid, 'D02')
            assert r_def is not None and Decimal(r_def["quantity_per_unit"]) == Decimal('5')
            assert r_d02 is not None and Decimal(r_d02["quantity_per_unit"]) == Decimal('12')

    @pytest.mark.asyncio
    async def test_bulk_delete_dept_keeps_default(self, conn):
        """dept スコープで DELETE しても他スコープには影響しない"""
        async with conn.cursor() as cur:
            await _ensure_test_admin(cur)
            mid = await _setup_material(cur, code='TEST_BULK_P2_002')
            pid = await _setup_product(cur)
            await cur.execute(
                """INSERT INTO product_material_usage
                       (product_id, material_id, quantity_per_unit, department_code)
                   VALUES (%s,%s,%s,NULL), (%s,%s,%s,'D02')""",
                (pid, mid, Decimal('5'), pid, mid, Decimal('12')))
            # D02 のみ削除
            await cur.execute(
                """DELETE FROM product_material_usage
                   WHERE material_id=%s AND product_id = ANY(%s)
                     AND COALESCE(department_code, '__DEFAULT__') = COALESCE(%s, '__DEFAULT__')""",
                (mid, [pid], 'D02'))
            assert await _get_recipe_row(cur, pid, mid, None) is not None
            assert await _get_recipe_row(cur, pid, mid, 'D02') is None


# =============================================================================
# swap — 部署スコープごとに独立して swap できる
# =============================================================================

class TestSwapPhase2:

    @pytest.mark.asyncio
    async def test_swap_dept_override_does_not_touch_default(self, conn):
        """D02 行で swap → D02 のみ主資材が入れ替わる、デフォルトは元のまま"""
        async with conn.cursor() as cur:
            await _ensure_test_admin(cur)
            m_a = await _setup_material(cur, code='TEST_SWAP_A')
            m_b = await _setup_material(cur, code='TEST_SWAP_B')
            pid = await _setup_product(cur)
            # デフォルト: 主=A 代替=[B]
            await cur.execute(
                """INSERT INTO product_material_usage
                       (product_id, material_id, quantity_per_unit,
                        alternative_material_ids)
                   VALUES (%s, %s, %s, %s)""",
                (pid, m_a, Decimal('5'), [m_b]))
            # D02: 主=A 代替=[B] (別行)
            await cur.execute(
                """INSERT INTO product_material_usage
                       (product_id, material_id, quantity_per_unit,
                        department_code, alternative_material_ids)
                   VALUES (%s, %s, %s, %s, %s)""",
                (pid, m_a, Decimal('7'), 'D02', [m_b]))

            # ─── shipments.py の swap_with_alternative と同じ動作を SQL で再現 ───
            # D02 スコープで A → B にスワップ
            dept = 'D02'
            # 既存行取得
            r = await _get_recipe_row(cur, pid, m_a, dept)
            old_alts = list(r["alternative_material_ids"] or [])
            promote = old_alts[0]   # B
            new_alts = [a for a in old_alts if a != promote] + [m_a]
            # 削除→再挿入
            await cur.execute(
                """DELETE FROM product_material_usage
                   WHERE product_id=%s AND material_id=%s
                     AND COALESCE(department_code, '__DEFAULT__') = COALESCE(%s, '__DEFAULT__')""",
                (pid, m_a, dept))
            await cur.execute(
                """INSERT INTO product_material_usage
                       (product_id, material_id, quantity_per_unit,
                        department_code, alternative_material_ids)
                   VALUES (%s, %s, %s, %s, %s)""",
                (pid, promote, r["quantity_per_unit"], dept, new_alts))

            # D02 は B が主、A が代替に降格
            d02 = await _get_recipe_row(cur, pid, promote, 'D02')
            assert d02 is not None
            assert list(d02["alternative_material_ids"]) == [m_a]
            # デフォルトは元のまま (主=A 代替=[B])
            default = await _get_recipe_row(cur, pid, m_a, None)
            assert default is not None
            assert list(default["alternative_material_ids"]) == [m_b]


# =============================================================================
# estimate — 部署スコープで shipment フィルタが効く
# =============================================================================

class TestEstimatePhase2:

    @pytest.mark.asyncio
    async def test_estimate_dept_filters_shipments(self, conn):
        """dept 指定時、その部署の出荷だけが shipment_count に集計される"""
        async with conn.cursor() as cur:
            await _ensure_test_admin(cur)
            uid = (await (await cur.execute(
                """INSERT INTO users (display_name, role, is_active, device_token)
                   VALUES ('__t__', 'admin', true,
                           %s) RETURNING id""",
                (f"__est_{uuid.uuid4().hex[:8]}__",))).fetchone())["id"]
            mid = await _setup_material(cur, code='TEST_EST_P2_001')
            pid = await _setup_product(cur)
            # D02 オーバーライド (推定モード)
            await cur.execute(
                """INSERT INTO product_material_usage
                       (product_id, material_id, quantity_per_unit,
                        is_estimated, estimation_weight, department_code)
                   VALUES (%s, %s, 0, true, 1, 'D02')""",
                (pid, mid))
            # 出荷: D02=10, D99=99
            for d, q in [('D02', 10), ('D99', 99)]:
                await cur.execute(
                    """INSERT INTO shipment_records
                           (product_id, ship_date, quantity, department_code,
                            created_by)
                       VALUES (%s, %s, %s, %s, %s)""",
                    (pid, date(2026, 5, 10), Decimal(q), d, uid))

            # shipments.py の estimate_recipe の中核 SQL を再現
            # (dept='D02' なら shipment は D02 だけ集計)
            await cur.execute(
                """SELECT pmu.product_id,
                          COALESCE((
                            SELECT SUM(sr.quantity) FROM shipment_records sr
                            WHERE sr.product_id = pmu.product_id
                              AND sr.ship_date BETWEEN %s AND %s
                              AND sr.department_code = %s
                          ), 0) AS shipment_count
                   FROM product_material_usage pmu
                   WHERE pmu.material_id = %s
                     AND pmu.department_code = %s""",
                (date(2026, 5, 1), date(2026, 5, 31), 'D02', mid, 'D02'))
            row = await cur.fetchone()
            assert row is not None
            assert Decimal(row["shipment_count"]) == Decimal('10')  # D99 出荷は除外

    @pytest.mark.asyncio
    async def test_estimate_default_scope_includes_all_shipments(self, conn):
        """dept=None なら全部署の出荷が集計される (Phase 1 互換)"""
        async with conn.cursor() as cur:
            await _ensure_test_admin(cur)
            uid = (await (await cur.execute(
                """INSERT INTO users (display_name, role, is_active, device_token)
                   VALUES ('__t__', 'admin', true, %s) RETURNING id""",
                (f"__est_{uuid.uuid4().hex[:8]}__",))).fetchone())["id"]
            mid = await _setup_material(cur, code='TEST_EST_P2_002')
            pid = await _setup_product(cur)
            await cur.execute(
                """INSERT INTO product_material_usage
                       (product_id, material_id, quantity_per_unit)
                   VALUES (%s, %s, 5)""", (pid, mid))
            for d, q in [('D02', 10), ('D99', 99)]:
                await cur.execute(
                    """INSERT INTO shipment_records
                           (product_id, ship_date, quantity, department_code,
                            created_by)
                       VALUES (%s, %s, %s, %s, %s)""",
                    (pid, date(2026, 5, 10), Decimal(q), d, uid))

            # dept フィルタ無し → 全件
            await cur.execute(
                """SELECT COALESCE((
                       SELECT SUM(quantity) FROM shipment_records
                       WHERE product_id=%s AND ship_date BETWEEN %s AND %s
                   ), 0) AS sc""",
                (pid, date(2026, 5, 1), date(2026, 5, 31)))
            row = await cur.fetchone()
            assert Decimal(row["sc"]) == Decimal('109')   # 10 + 99
