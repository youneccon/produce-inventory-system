"""
tools/seed_shipments.py
=======================
商品出荷台帳のサンプルデータを投入する。

- 5商品（事業1部）を products_shipped に投入
- 商品⇄資材のレシピ（商品1点出荷あたりの資材消耗量）を投入
- 5月の出荷記録を数十件投入

冪等: 商品 (division, name) 単位の ON CONFLICT、レシピも (product, material) 単位で
ON CONFLICT。出荷レコードは「事業1部の5月分」を一度全削除してから入れ直す。
"""

from __future__ import annotations

import os
from datetime import date
from decimal import Decimal

import psycopg
from dotenv import load_dotenv
from psycopg.rows import dict_row


PRODUCTS = [
    # (name, unit)
    ("加工生姜パック500g",   "個"),
    ("加工生姜パック1kg",    "個"),
    ("業務用生姜10kg箱",     "箱"),
    ("生姜ペースト瓶詰",     "個"),
    ("業務用パレット出荷",   "件"),
]

# (商品名, 資材コード, 1点あたりの消耗量, 備考)
RECIPES = [
    # P01: 加工生姜パック500g
    ("加工生姜パック500g", "SZ01004", "1",    "ポリ袋1枚"),
    ("加工生姜パック500g", "SZ01005", "1",    "ラベル1枚"),
    ("加工生姜パック500g", "SZ01002", "0.02", "封緘テープ"),
    # P02: 加工生姜パック1kg
    ("加工生姜パック1kg",  "SZ01004", "1",    "ポリ袋1枚"),
    ("加工生姜パック1kg",  "SZ01005", "1",    "ラベル1枚"),
    ("加工生姜パック1kg",  "SZ01002", "0.03", "封緘テープ"),
    # P03: 業務用生姜10kg箱
    ("業務用生姜10kg箱",   "SZ01001", "1",    "ダンボール箱1枚"),
    ("業務用生姜10kg箱",   "SZ01005", "1",    "ラベル1枚"),
    ("業務用生姜10kg箱",   "SZ01002", "0.1",  "封緘テープ"),
    # P04: 生姜ペースト瓶詰
    ("生姜ペースト瓶詰",   "SZ01005", "1",    "ラベル1枚"),
    # P05: 業務用パレット出荷
    ("業務用パレット出荷", "SZ01001", "3",    "ダンボール3枚/件"),
    ("業務用パレット出荷", "SZ01005", "3",    "ラベル3枚/件"),
    ("業務用パレット出荷", "SZ01006", "2",    "結束バンド2本/件"),
    ("業務用パレット出荷", "SZ01007", "0.05", "パレット0.05枚/件（20件で1枚）"),
]

# (date, 商品名, 出荷数, note)
SHIPMENTS = [
    (date(2026, 5, 1),  "加工生姜パック500g", 80, None),
    (date(2026, 5, 1),  "業務用パレット出荷",  2, None),
    (date(2026, 5, 2),  "加工生姜パック1kg",  40, None),
    (date(2026, 5, 2),  "業務用生姜10kg箱",    5, None),
    (date(2026, 5, 3),  "加工生姜パック500g", 120, None),
    (date(2026, 5, 3),  "生姜ペースト瓶詰",   30, None),
    (date(2026, 5, 3),  "業務用パレット出荷",  1, None),
    (date(2026, 5, 5),  "加工生姜パック500g",  60, None),
    (date(2026, 5, 5),  "加工生姜パック1kg",   80, None),
    (date(2026, 5, 6),  "業務用生姜10kg箱",    4, None),
    (date(2026, 5, 6),  "生姜ペースト瓶詰",   20, None),
    (date(2026, 5, 8),  "加工生姜パック500g", 100, None),
    (date(2026, 5, 8),  "業務用パレット出荷",  3, None),
    (date(2026, 5, 9),  "加工生姜パック1kg",   50, None),
    (date(2026, 5, 9),  "業務用生姜10kg箱",    6, None),
    (date(2026, 5, 10), "加工生姜パック500g",  70, None),
    (date(2026, 5, 10), "生姜ペースト瓶詰",   40, None),
    (date(2026, 5, 12), "加工生姜パック1kg",   90, None),
    (date(2026, 5, 12), "業務用生姜10kg箱",    3, None),
    (date(2026, 5, 13), "加工生姜パック500g",  80, None),
    (date(2026, 5, 13), "業務用パレット出荷",  2, None),
]


def main():
    load_dotenv()
    dsn = os.environ["DATABASE_URL"]
    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        with conn.transaction():
            cur = conn.cursor()
            cur.execute("SELECT id FROM users WHERE display_name=%s", ("データ移行",))
            actor = cur.fetchone()["id"]

            # 商品 (products_shipped は (division,name) の UNIQUE を持たないため
            #        select-or-insert で冪等性を確保する)
            name_to_pid: dict[str, int] = {}
            for name, unit in PRODUCTS:
                cur.execute(
                    "SELECT id FROM products_shipped WHERE division=1 AND name=%s",
                    (name,),
                )
                row = cur.fetchone()
                if row:
                    cur.execute(
                        "UPDATE products_shipped SET unit=%s, updated_at=now() "
                        "WHERE id=%s RETURNING id",
                        (unit, row["id"]),
                    )
                else:
                    cur.execute(
                        "INSERT INTO products_shipped (division, name, unit) "
                        "VALUES (1, %s, %s) RETURNING id",
                        (name, unit),
                    )
                name_to_pid[name] = cur.fetchone()["id"]

            # 資材コード -> id
            cur.execute("SELECT id, code FROM materials WHERE division=1")
            code_to_mid = {r["code"]: r["id"] for r in cur.fetchall()}

            # レシピ
            for product, code, qty, note in RECIPES:
                pid = name_to_pid[product]
                mid = code_to_mid[code]
                cur.execute(
                    """INSERT INTO product_material_usage
                         (product_id, material_id, quantity_per_unit, note)
                       VALUES (%s, %s, %s, %s)
                       ON CONFLICT (product_id, material_id, COALESCE(department_code, '__DEFAULT__'))
                         DO UPDATE
                         SET quantity_per_unit=EXCLUDED.quantity_per_unit,
                             note=EXCLUDED.note""",
                    (pid, mid, Decimal(qty), note),
                )

            # 出荷記録（5月分は一旦全削除して入れ直す）
            cur.execute("""
                DELETE FROM shipment_records
                WHERE ship_date BETWEEN '2026-05-01' AND '2026-05-31'
                  AND product_id IN (
                      SELECT id FROM products_shipped WHERE division=1
                  )
            """)
            for d, product, qty, note in SHIPMENTS:
                pid = name_to_pid[product]
                cur.execute(
                    """INSERT INTO shipment_records
                         (product_id, ship_date, quantity, note, created_by)
                       VALUES (%s, %s, %s, %s, %s)""",
                    (pid, d, Decimal(qty), note, actor),
                )

    print(f"商品 {len(PRODUCTS)} 件、レシピ {len(RECIPES)} 件、出荷 {len(SHIPMENTS)} 件 投入完了")


if __name__ == "__main__":
    main()
