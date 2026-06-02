"""
tests/test_shipments_recipes_redesign.py
=========================================
レシピ最終チェック ページ 改修 用 API 拡張 の DB 統合テスト。

対象:
  - GET  /shipments/products      (新フィールド 3 つ)
  - PUT  /shipments/products/{id}/recipes  (auto-clean-override)
"""
from __future__ import annotations

import os
from datetime import date, timedelta
from decimal import Decimal

import pytest


pytestmark = pytest.mark.skipif(
    not os.environ.get("DATABASE_URL"),
    reason="DATABASE_URL 未設定 — DB 統合テストはスキップ",
)


@pytest.mark.asyncio
async def test_list_products_returns_new_fields(client, test_db):
    """GET /shipments/products が override_dept_codes / last_shipped_at /
    monthly_shipment_count を 含むこと。"""
    # 商品 + default レシピ + 部署X override + 直近 出荷 1 件 を 仕込む
    async with test_db.cursor() as cur:
        await cur.execute(
            "INSERT INTO products_shipped (division, name, is_active, product_code) "
            "VALUES (1, '__test_prod__', true, 'TP_001') RETURNING id"
        )
        pid = (await cur.fetchone())["id"]

        # 仕入先 (materials.supplier_id FK)
        await cur.execute(
            "INSERT INTO suppliers (name, is_active) "
            "VALUES ('__test_supp__', true) RETURNING id"
        )
        sup_id = (await cur.fetchone())["id"]

        await cur.execute(
            "INSERT INTO materials (code, division, supplier_name, supplier_id, "
            "                       item_name, unit) "
            "VALUES ('__tm__', 1, '__test_supp__', %s, '__test_mat__', '個') "
            "RETURNING id",
            (sup_id,),
        )
        mid = (await cur.fetchone())["id"]

        # default レシピ
        await cur.execute(
            "INSERT INTO product_material_usage "
            "(product_id, material_id, quantity_per_unit) VALUES (%s, %s, 1.0)",
            (pid, mid),
        )
        # 部署X override
        await cur.execute(
            "INSERT INTO product_material_usage "
            "(product_id, material_id, quantity_per_unit, department_code) "
            "VALUES (%s, %s, 0.5, 'X')",
            (pid, mid),
        )
        # 直近 出荷 1 件 (今日)
        await cur.execute(
            "INSERT INTO shipment_records "
            "(product_id, ship_date, quantity, created_by) "
            "VALUES (%s, %s, 10, "
            "  (SELECT id FROM users WHERE display_name='__router_test_admin__'))",
            (pid, date.today()),
        )

    r = await client.get("/shipments/products", params={"division": 1})
    assert r.status_code == 200
    products = r.json()
    target = next((p for p in products if p["product_id"] == pid), None)
    assert target is not None, "テスト 商品 が レスポンス に 入って いない"
    assert target["override_dept_codes"] == ["X"]
    assert target["last_shipped_at"] == date.today().isoformat()
    assert target["monthly_shipment_count"] == 1


@pytest.mark.asyncio
async def test_replace_recipes_auto_cleans_override_matching_default(client, test_db):
    """部署X override が default と 完全 一致 した 場合、 サーバー が 自動 削除 する。"""
    async with test_db.cursor() as cur:
        await cur.execute(
            "INSERT INTO products_shipped (division, name, is_active, product_code) "
            "VALUES (1, '__test_clean__', true, 'TC_001') RETURNING id"
        )
        pid = (await cur.fetchone())["id"]

        # 仕入先 (materials.supplier_id FK)
        await cur.execute(
            "INSERT INTO suppliers (name, is_active) "
            "VALUES ('__test_supp_tc__', true) RETURNING id"
        )
        sup_id = (await cur.fetchone())["id"]

        await cur.execute(
            "INSERT INTO materials (code, division, supplier_name, supplier_id, "
            "                       item_name, unit) "
            "VALUES ('__tc1__', 1, '__test_supp_tc__', %s, '__mat1__', '個') "
            "RETURNING id",
            (sup_id,),
        )
        mid = (await cur.fetchone())["id"]

    # 1) default レシピ を 1 件 登録
    r = await client.put(
        f"/shipments/products/{pid}/recipes",
        json={"entries": [{
            "material_id": mid,
            "quantity_per_unit": "1.000",
            "is_estimated": False,
            "estimation_weight": "1",
            "alternative_material_ids": [],
            "department_code": None,
            "note": None,
        }]},
    )
    assert r.status_code == 200

    # 2) 部署X override を default と 完全 一致 する 内容 で 追加 要求
    r = await client.put(
        f"/shipments/products/{pid}/recipes",
        json={"entries": [
            {  # default は 維持
                "material_id": mid, "quantity_per_unit": "1.000",
                "is_estimated": False, "estimation_weight": "1",
                "alternative_material_ids": [], "department_code": None, "note": None,
            },
            {  # 部署X override (default と 同じ 値) → サーバー が 削除する はず
                "material_id": mid, "quantity_per_unit": "1.000",
                "is_estimated": False, "estimation_weight": "1",
                "alternative_material_ids": [], "department_code": "X", "note": None,
            },
        ]},
    )
    assert r.status_code == 200

    # 3) DB 直接 確認: 部署X の 行 は 存在 しない
    async with test_db.cursor() as cur:
        await cur.execute(
            "SELECT COUNT(*) AS n FROM product_material_usage "
            "WHERE product_id=%s AND department_code='X'", (pid,))
        assert (await cur.fetchone())["n"] == 0

        # default は 残ってる
        await cur.execute(
            "SELECT COUNT(*) AS n FROM product_material_usage "
            "WHERE product_id=%s AND department_code IS NULL", (pid,))
        assert (await cur.fetchone())["n"] == 1


@pytest.mark.asyncio
async def test_replace_recipes_keeps_override_with_different_value(client, test_db):
    """部署X override が default と 違う 値 なら 保存 する (sanity check)。"""
    async with test_db.cursor() as cur:
        await cur.execute(
            "INSERT INTO products_shipped (division, name, is_active, product_code) "
            "VALUES (1, '__test_diff__', true, 'TD_001') RETURNING id"
        )
        pid = (await cur.fetchone())["id"]

        # 仕入先 (materials.supplier_id FK)
        await cur.execute(
            "INSERT INTO suppliers (name, is_active) "
            "VALUES ('__test_supp_td__', true) RETURNING id"
        )
        sup_id = (await cur.fetchone())["id"]

        await cur.execute(
            "INSERT INTO materials (code, division, supplier_name, supplier_id, "
            "                       item_name, unit) "
            "VALUES ('__td1__', 1, '__test_supp_td__', %s, '__mat1__', '個') "
            "RETURNING id",
            (sup_id,),
        )
        mid = (await cur.fetchone())["id"]

    r = await client.put(
        f"/shipments/products/{pid}/recipes",
        json={"entries": [
            {  # default
                "material_id": mid, "quantity_per_unit": "1.000",
                "is_estimated": False, "estimation_weight": "1",
                "alternative_material_ids": [], "department_code": None, "note": None,
            },
            {  # 部署X override (default と 違う 数量)
                "material_id": mid, "quantity_per_unit": "0.500",
                "is_estimated": False, "estimation_weight": "1",
                "alternative_material_ids": [], "department_code": "X", "note": None,
            },
        ]},
    )
    assert r.status_code == 200

    async with test_db.cursor() as cur:
        await cur.execute(
            "SELECT quantity_per_unit FROM product_material_usage "
            "WHERE product_id=%s AND department_code='X'", (pid,))
        row = await cur.fetchone()
        assert row is not None
        assert Decimal(row["quantity_per_unit"]) == Decimal("0.500")
