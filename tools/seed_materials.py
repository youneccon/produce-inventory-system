"""
tools/seed_materials.py
=======================
資材管理台帳のサンプルデータを投入する（事業1部・7資材）。

- 7資材を materials に投入（整理番号 SZ01001〜SZ01007）
- 4月末の前月繰越を material_counts に投入（period='2026-04'）
- 5月の入荷・手動出庫を数件 material_movements に投入

冪等: code 単位の ON CONFLICT で重複登録を防ぐ。
"""

from __future__ import annotations

import os
import sys
from datetime import date
from decimal import Decimal

import psycopg
from dotenv import load_dotenv
from psycopg.rows import dict_row


MATERIALS = [
    # (code, supplier, item, unit, april_end_count)
    ("SZ01001", "包装資材A社", "ダンボール箱（10kg用）", "枚", 250),
    ("SZ01002", "包装資材A社", "ガムテープ",             "巻", 60),
    ("SZ01003", "包装資材B社", "ラップフィルム",         "m",  1200),
    ("SZ01004", "包装資材A社", "食品用ポリ袋（大）",     "枚", 800),
    ("SZ01005", "印刷C社",     "商品ラベル",             "枚", 1500),
    ("SZ01006", "包装資材B社", "結束バンド",             "本", 500),
    ("SZ01007", "物流D社",     "パレット",               "枚", 30),
]

# 5月の手入力 movement（正=入荷、負=出庫）
MOVEMENTS = [
    # (code, date, quantity, note)
    ("SZ01001", date(2026, 5, 3),   500,  "5月分入荷"),
    ("SZ01002", date(2026, 5, 5),    20,  "5月分入荷"),
    ("SZ01003", date(2026, 5, 8),   500,  "5月分入荷"),
    ("SZ01001", date(2026, 5, 10),  -30,  "手動出庫（事務用）"),
    ("SZ01005", date(2026, 5, 15), 1000,  "5月分入荷"),
    ("SZ01007", date(2026, 5, 20),    5,  "5月分入荷（パレット）"),
]


def main():
    load_dotenv()
    dsn = os.environ["DATABASE_URL"]
    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        with conn.transaction():
            cur = conn.cursor()
            # 移行ユーザー
            cur.execute("SELECT id FROM users WHERE display_name=%s", ("データ移行",))
            row = cur.fetchone()
            if row:
                actor = row["id"]
            else:
                cur.execute(
                    "INSERT INTO users (display_name, role) VALUES (%s,'admin') RETURNING id",
                    ("データ移行",),
                )
                actor = cur.fetchone()["id"]

            # 仕入先マスタ (materials.supplier_id は NOT NULL なので先に解決する)
            supplier_ids: dict[str, int] = {}
            for _, sup, _, _, _ in MATERIALS:
                if sup not in supplier_ids:
                    cur.execute(
                        """INSERT INTO suppliers (name) VALUES (%s)
                           ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name
                           RETURNING id""",
                        (sup,),
                    )
                    supplier_ids[sup] = cur.fetchone()["id"]

            # 資材マスタ
            code_to_id: dict[str, int] = {}
            for code, sup, item, unit, _ in MATERIALS:
                cur.execute(
                    """INSERT INTO materials
                         (code, division, supplier_id, supplier_name, item_name, unit)
                       VALUES (%s, 1, %s, %s, %s, %s)
                       ON CONFLICT (code) DO UPDATE
                         SET supplier_id=EXCLUDED.supplier_id,
                             supplier_name=EXCLUDED.supplier_name,
                             item_name=EXCLUDED.item_name,
                             unit=EXCLUDED.unit,
                             updated_at=now()
                       RETURNING id""",
                    (code, supplier_ids[sup], sup, item, unit),
                )
                code_to_id[code] = cur.fetchone()["id"]

            # 前月繰越（4月末）
            for code, _, _, _, qty in MATERIALS:
                mid = code_to_id[code]
                cur.execute(
                    """INSERT INTO material_counts
                         (material_id, period, count_date, counted_qty,
                          source, note, confirmed_by)
                       VALUES (%s, '2026-04', '2026-04-30', %s,
                               'migration', '初期繰越（サンプル）', %s)
                       ON CONFLICT (material_id, count_date, COALESCE(object_id, 0)) DO UPDATE
                         SET counted_qty=EXCLUDED.counted_qty,
                             note=EXCLUDED.note,
                             confirmed_by=EXCLUDED.confirmed_by,
                             confirmed_at=now()""",
                    (mid, Decimal(qty), actor),
                )

            # 5月の入出庫（重複防止のため一度全削除）
            cur.execute(
                """DELETE FROM material_movements
                   WHERE material_id = ANY(%s)
                     AND movement_date BETWEEN '2026-05-01' AND '2026-05-31'""",
                (list(code_to_id.values()),),
            )
            for code, d, qty, note in MOVEMENTS:
                mid = code_to_id[code]
                cur.execute(
                    """INSERT INTO material_movements
                         (material_id, movement_date, quantity, note, created_by)
                       VALUES (%s, %s, %s, %s, %s)""",
                    (mid, d, Decimal(qty), note, actor),
                )

    print(f"資材マスタ {len(MATERIALS)} 件、前月繰越 {len(MATERIALS)} 件、"
          f"movement {len(MOVEMENTS)} 件 投入完了")


if __name__ == "__main__":
    main()
