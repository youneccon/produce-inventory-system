"""
tools/seed_demo.py
==================
デモ／ポートフォリオ用の合成サンプルデータを **一括投入** するオーケストレータ。

実在の社内データは一切含まない。すべて架空の作物・取引先・数量である。

投入の流れ:
  1. 基盤マスタ (crops = 作物の語彙) を確認・投入
       マイグレーションを単一 schema.sql に集約した結果、作物マスタは
       スキーマには含まれないため、ここで投入する。
  2. seed_materials  … 資材マスタ7件＋前月繰越＋5月入出庫
  3. seed_shipments  … 出荷商品5件＋商品⇄資材レシピ＋5月の出荷記録 (materials 依存)
  4. seed_garlic     … 大蒜の選別フロー用データ (crops '02' 依存)

冪等: 各 seed は ON CONFLICT / タグ削除で再実行安全。本スクリプトも何度でも実行可。

使い方:
    # 事前に DB を作成し schema.sql を流し込んでおくこと (README 参照)
    python tools/seed_demo.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import psycopg
from dotenv import load_dotenv
from psycopg.rows import dict_row

# tools/ を import パスに追加し、既存の seed モジュールを再利用する
sys.path.insert(0, str(Path(__file__).resolve().parent))

import seed_garlic     # noqa: E402
import seed_materials   # noqa: E402
import seed_shipments   # noqa: E402


# 作物マスタ (一般名詞のみ。機密性なし)
CROPS = [
    ("01", "生姜"),
    ("02", "大蒜"),
    ("03", "長芋"),
    ("04", "牛蒡"),
    ("05", "薩摩芋"),
]


def ensure_reference_data(dsn: str) -> None:
    """seed が依存する基盤マスタ (作物) を確認・投入する。"""
    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        with conn.transaction():
            cur = conn.cursor()
            for code, name in CROPS:
                cur.execute(
                    """INSERT INTO crops (code, name) VALUES (%s, %s)
                       ON CONFLICT (code) DO NOTHING""",
                    (code, name),
                )
    print(f"  基盤マスタ: 作物 {len(CROPS)} 件 確認")


def main() -> None:
    load_dotenv()
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        raise SystemExit(
            "DATABASE_URL が未設定です。.env.example をコピーして .env を作成してください。"
        )

    print("=" * 60)
    print("デモ用 合成サンプルデータ 投入")
    print("=" * 60)

    ensure_reference_data(dsn)

    # 依存順: materials → shipments(materials依存) → garlic(crops '02'依存)
    print("\n[1/3] 資材マスタ ...")
    seed_materials.main()
    print("\n[2/3] 出荷商品・レシピ・出荷記録 ...")
    seed_shipments.main()
    print("\n[3/3] 大蒜 選別フロー ...")
    seed_garlic.main()

    print("\n" + "=" * 60)
    print("デモデータ投入 完了")
    print("  最初にフロントでデバイス登録すると、管理者が未登録のため")
    print("  そのデバイスが管理者として自動承認されます (README 参照)。")
    print("=" * 60)


if __name__ == "__main__":
    main()
