"""
tools/seed_garlic.py
====================
大蒜（にんにく）の選別機能テスト用サンプルデータを投入する。

- 産地: 青森県
- 仕入先: 青森農産（仮）
- 規格（grades）:
    spec_type="泥"      → 未選別の原料（grade_level='-', size_label=L/M）
    spec_type="選別済"  → 選別後の規格別（grade_level=A/B/C/加工品/徳用,
                                          size_label=L/M/S/-)
- 商品（products）: 青森県産×規格 ＝ 12商品
- 参考単価のための過去入荷ロット（reference prices）:
    AL/BL/CL, AM/BM/CM, AS/BS/CS, 加工品, 徳用 を各1ロット（少量、価格確定済）
- 選別実験用の原料ロット:
    青森県産泥L 50ケース×20kg=1000kg @1500円
    前月繰越（2026-04）= 700kg、5月に200kg出庫済 → 残=500kg

冪等: 整理番号は next_lot_code('02','G') で都度発行するが、同一条件のロットは
INSERT を ON CONFLICT で防いでいないため、再実行時の重複登録を避けるため
seed専用 noteタグ '[SEED_GARLIC]' を付け、再実行時はそれで一旦削除する。
"""

from __future__ import annotations

import os
import sys
from datetime import date
from decimal import Decimal

import psycopg
from dotenv import load_dotenv
from psycopg.rows import dict_row


SUPPLIER = "青森農産"
ORIGIN   = "青森県"
CROP     = "大蒜"  # crops.code = '02'

# 規格定義: (spec_type, grade_level, size_label)
GRADES = [
    # ソース（原料）
    ("泥",     "-", "L"),
    ("泥",     "-", "M"),
    # 選別済（参考価格を持つ既存規格）
    ("選別済", "A", "L"),
    ("選別済", "B", "L"),
    ("選別済", "C", "L"),
    ("選別済", "A", "M"),
    ("選別済", "B", "M"),
    ("選別済", "C", "M"),
    ("選別済", "A", "S"),
    ("選別済", "B", "S"),
    ("選別済", "C", "S"),
    ("選別済", "加工品", "-"),
    ("選別済", "徳用",   "-"),
]

# 参考価格ロット: (spec_type, grade_level, size_label, inbound_date, kg, unit_price)
# 過去の参考用に少量＋単価確定で投入
REFERENCE_LOTS = [
    ("選別済", "A", "L", date(2026, 2, 10), Decimal("100"), Decimal("3500")),
    ("選別済", "B", "L", date(2026, 2, 10), Decimal("100"), Decimal("2800")),
    ("選別済", "C", "L", date(2026, 2, 10), Decimal("100"), Decimal("2000")),
    ("選別済", "A", "M", date(2026, 3,  8), Decimal("100"), Decimal("3200")),
    ("選別済", "B", "M", date(2026, 3,  8), Decimal("100"), Decimal("2500")),
    ("選別済", "C", "M", date(2026, 3,  8), Decimal("100"), Decimal("1800")),
    ("選別済", "A", "S", date(2026, 3, 25), Decimal("100"), Decimal("2800")),
    ("選別済", "B", "S", date(2026, 3, 25), Decimal("100"), Decimal("2100")),
    ("選別済", "C", "S", date(2026, 3, 25), Decimal("100"), Decimal("1500")),
    ("選別済", "加工品", "-", date(2026, 4,  5), Decimal("80"),  Decimal("900")),
    ("選別済", "徳用",   "-", date(2026, 4,  5), Decimal("80"),  Decimal("1200")),
]

# ソース（選別対象の原料）ロット: 青森県産 泥L
SOURCE_LOT = {
    "spec_type":   "泥",
    "grade_level": "-",
    "size_label":  "L",
    "inbound_date": date(2026, 4, 20),  # 前月入荷
    "cases":        Decimal("50"),
    "kg_per_case":  Decimal("20"),
    "unit_price":   Decimal("1500"),
}
SOURCE_CARRYOVER = Decimal("700")  # 4月末 棚卸確定値
SOURCE_OUTBOUND_DATE = date(2026, 5, 10)
SOURCE_OUTBOUND_KG   = Decimal("200")  # 5月の出庫
SEED_NOTE = "[SEED_GARLIC]"


def main():
    load_dotenv()
    dsn = os.environ["DATABASE_URL"]
    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        with conn.transaction():
            cur = conn.cursor()

            # 移行ユーザー（既存）
            cur.execute("SELECT id FROM users WHERE display_name=%s", ("データ移行",))
            row = cur.fetchone()
            if row is None:
                cur.execute(
                    "INSERT INTO users (display_name, role) VALUES (%s,'admin') RETURNING id",
                    ("データ移行",),
                )
                row = cur.fetchone()
            actor = row["id"]

            # crops: 大蒜
            cur.execute("SELECT id, code FROM crops WHERE code='02'")
            crop = cur.fetchone()
            if crop is None:
                raise SystemExit("crops に '02' (大蒜) が存在しません。先に migration 001 を適用してください。")
            crop_id = crop["id"]
            crop_code = crop["code"]

            # supplier
            cur.execute(
                """INSERT INTO suppliers (name) VALUES (%s)
                   ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name
                   RETURNING id""",
                (SUPPLIER,),
            )
            supplier_id = cur.fetchone()["id"]

            # origin
            cur.execute(
                """INSERT INTO origins (name, region) VALUES (%s, %s)
                   ON CONFLICT (name) DO UPDATE SET region=EXCLUDED.region
                   RETURNING id""",
                (ORIGIN, "東北"),
            )
            origin_id = cur.fetchone()["id"]

            # grades
            grade_id_map: dict[tuple[str, str, str], int] = {}
            for spec, gl, sz in GRADES:
                cur.execute(
                    """INSERT INTO grades (spec_type, grade_level, size_label)
                       VALUES (%s,%s,%s)
                       ON CONFLICT (spec_type, grade_level, size_label) DO UPDATE
                         SET updated_at = now()
                       RETURNING id""",
                    (spec, gl, sz),
                )
                grade_id_map[(spec, gl, sz)] = cur.fetchone()["id"]

            # products（crop_id 必須）
            product_id_map: dict[tuple[str, str, str], int] = {}
            for spec, gl, sz in GRADES:
                gid = grade_id_map[(spec, gl, sz)]
                cur.execute(
                    """INSERT INTO products (crop_id, grade_id, origin_id)
                       VALUES (%s, %s, %s)
                       ON CONFLICT (grade_id, origin_id, crop_id) DO UPDATE
                         SET updated_at = now()
                       RETURNING id""",
                    (crop_id, gid, origin_id),
                )
                product_id_map[(spec, gl, sz)] = cur.fetchone()["id"]

            # ---- 再投入時の SEED_GARLIC データを一旦クリア ----
            cur.execute(
                """DELETE FROM stock_counts
                   WHERE lot_id IN (
                       SELECT id FROM inbound_lots WHERE note LIKE %s
                   )""",
                (f"%{SEED_NOTE}%",),
            )
            cur.execute(
                """DELETE FROM outbound_records
                   WHERE lot_id IN (
                       SELECT id FROM inbound_lots WHERE note LIKE %s
                   ) OR note LIKE %s""",
                (f"%{SEED_NOTE}%", f"%{SEED_NOTE}%"),
            )
            cur.execute(
                """DELETE FROM inbound_lots WHERE note LIKE %s""",
                (f"%{SEED_NOTE}%",),
            )

            # ---- 参考価格ロットの投入 ----
            for spec, gl, sz, d, kg, price in REFERENCE_LOTS:
                pid = product_id_map[(spec, gl, sz)]
                # 連番のためのコード採番
                cur.execute("SELECT next_lot_code(%s, 'G') AS c", (crop_code,))
                code = cur.fetchone()["c"]
                cur.execute(
                    """INSERT INTO inbound_lots
                         (code, product_id, supplier_id, inbound_date,
                          cases, kg_per_case, total_kg,
                          unit_price, price_confirmed_at, price_confirmed_by,
                          note, created_by)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s, now(),%s,%s,%s)""",
                    (code, pid, supplier_id, d,
                     Decimal("1"), kg, kg,
                     price, actor,
                     f"参考価格用 {SEED_NOTE}", actor),
                )

            # ---- ソースロット（青森県産 泥L 1000kg @1500円） ----
            src = SOURCE_LOT
            src_pid = product_id_map[(src["spec_type"], src["grade_level"], src["size_label"])]
            cur.execute("SELECT next_lot_code(%s, 'G') AS c", (crop_code,))
            src_code = cur.fetchone()["c"]
            total_kg = src["cases"] * src["kg_per_case"]
            cur.execute(
                """INSERT INTO inbound_lots
                     (code, product_id, supplier_id, inbound_date,
                      cases, kg_per_case, total_kg,
                      unit_price, price_confirmed_at, price_confirmed_by,
                      note, created_by)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s, now(),%s,%s,%s)
                   RETURNING id""",
                (src_code, src_pid, supplier_id, src["inbound_date"],
                 src["cases"], src["kg_per_case"], total_kg,
                 src["unit_price"], actor,
                 f"選別実験用ソースロット {SEED_NOTE}", actor),
            )
            src_lot_id = cur.fetchone()["id"]

            # 4月末 棚卸（前月繰越）= 700kg
            cur.execute(
                """INSERT INTO stock_counts
                     (lot_id, period, count_date, counted_kg,
                      theoretical_kg, source, note, confirmed_by)
                   VALUES (%s, '2026-04', '2026-04-30', %s,
                           %s, 'migration', %s, %s)
                   ON CONFLICT (lot_id, period) DO UPDATE
                     SET counted_kg = EXCLUDED.counted_kg,
                         theoretical_kg = EXCLUDED.theoretical_kg,
                         note = EXCLUDED.note,
                         confirmed_at = now()""",
                (src_lot_id, SOURCE_CARRYOVER, total_kg, SEED_NOTE, actor),
            )

            # 5月の出庫（200kg）→ 残 500kg
            cur.execute(
                """INSERT INTO outbound_records
                     (lot_id, outbound_date, quantity_kg, note, created_by)
                   VALUES (%s, %s, %s, %s, %s)""",
                (src_lot_id, SOURCE_OUTBOUND_DATE, SOURCE_OUTBOUND_KG,
                 f"通常出庫 {SEED_NOTE}", actor),
            )

    print("=" * 60)
    print("大蒜サンプルデータ投入完了")
    print("=" * 60)
    print(f"  作物:       {CROP} (crop.code=02)")
    print(f"  仕入先:     {SUPPLIER}")
    print(f"  産地:       {ORIGIN}")
    print(f"  商品マスタ: {len(GRADES)} 件")
    print(f"  参考価格ロット: {len(REFERENCE_LOTS)} 件")
    print(f"  ソースロット: {src_code} = 青森県産 泥L 1000kg @1500円")
    print(f"    前月繰越(2026-04): {SOURCE_CARRYOVER} kg")
    print(f"    当月出庫(2026-05): {SOURCE_OUTBOUND_KG} kg")
    print(f"    現在残量:           {SOURCE_CARRYOVER - SOURCE_OUTBOUND_KG} kg")


if __name__ == "__main__":
    main()
