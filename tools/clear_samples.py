"""
tools/clear_samples.py
======================
資材・商品・出荷・レシピのサンプルデータを削除する（保管レイアウトは温存）。

実データ取り込み前のクリーンアップ用。
保管レイアウトのオブジェクト・アイテムは ON DELETE CASCADE で
紐付けが消えるが、layout 自体（テスト用「事業1部 倉庫A」）は残す。
"""

from __future__ import annotations

import os
import sys

import psycopg
from dotenv import load_dotenv
from psycopg.rows import dict_row


def main():
    load_dotenv()
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        sys.exit("ERROR: DATABASE_URL が未設定です")

    with psycopg.connect(dsn) as conn:
        conn.row_factory = dict_row
        with conn.transaction():
            cur = conn.cursor()

            # ---- 商品出荷台帳 ----
            cur.execute("SELECT COUNT(*) AS c FROM shipment_records")
            n_records = cur.fetchone()["c"]
            cur.execute("SELECT COUNT(*) AS c FROM product_material_usage")
            n_recipes = cur.fetchone()["c"]
            cur.execute("SELECT COUNT(*) AS c FROM products_shipped")
            n_products = cur.fetchone()["c"]

            cur.execute("DELETE FROM shipment_records")
            cur.execute("DELETE FROM product_material_usage")
            cur.execute("DELETE FROM products_shipped")
            cur.execute(
                "SELECT setval('products_shipped_id_seq', 1, false)"
            )

            # ---- 資材 ----
            cur.execute("SELECT COUNT(*) AS c FROM material_movements")
            n_movements = cur.fetchone()["c"]
            cur.execute("SELECT COUNT(*) AS c FROM material_counts")
            n_counts = cur.fetchone()["c"]
            cur.execute("SELECT COUNT(*) AS c FROM materials")
            n_materials = cur.fetchone()["c"]
            cur.execute(
                "SELECT COUNT(*) AS c FROM storage_object_items WHERE material_id IS NOT NULL"
            )
            n_linked = cur.fetchone()["c"]

            cur.execute("DELETE FROM material_movements")
            cur.execute("DELETE FROM material_counts")
            cur.execute(
                "DELETE FROM storage_object_items WHERE material_id IS NOT NULL"
            )
            cur.execute("DELETE FROM materials")
            cur.execute(
                "SELECT setval('materials_id_seq', 1, false)"
            )

            print("=== 削除結果 ===")
            print(f"  shipment_records:        {n_records}")
            print(f"  product_material_usage:  {n_recipes}")
            print(f"  products_shipped:        {n_products}")
            print(f"  material_movements:      {n_movements}")
            print(f"  material_counts:         {n_counts}")
            print(f"  materials:               {n_materials}")
            print(f"  (resmgmt linked storage_object_items: {n_linked})")
            print()
            print("保管レイアウト (storage_layouts) は保持しました。")


if __name__ == "__main__":
    main()
