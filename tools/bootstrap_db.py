"""
tools/bootstrap_db.py
=====================
クラウド(デモ)環境の **起動時に1回だけ** スキーマと合成デモデータを自動投入する。

冪等: `crops` テーブルの有無・件数で判定し、未構築のときだけ実行する。
      既に構築済みなら即スキップするので、毎回のコールドスタートでも安全・高速。

- DATABASE_URL が未設定なら何もしない（ローカル開発では普通に手動投入すればよい）。
- AUTO_BOOTSTRAP=false で明示的に無効化できる。

Dockerfile から `python tools/bootstrap_db.py && python run.py` の形で呼ばれる想定。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import psycopg
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parent))

import seed_demo  # noqa: E402


def _strip_psql_meta(sql: str) -> str:
    """pg_dump が出力する `\\restrict` 等の psql メタコマンド行を除去する。
    これらは psql 専用で psycopg では実行できないため。"""
    return "\n".join(
        line for line in sql.splitlines() if not line.lstrip().startswith("\\")
    )


def main() -> None:
    load_dotenv()

    if os.environ.get("AUTO_BOOTSTRAP", "true").lower() in ("0", "false", "no"):
        print("[bootstrap] AUTO_BOOTSTRAP 無効のためスキップ")
        return

    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("[bootstrap] DATABASE_URL 未設定のためスキップ")
        return

    schema_path = Path(__file__).resolve().parent.parent / "db" / "schema.sql"

    need_seed = False
    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT to_regclass('public.crops')")
            crops_exists = cur.fetchone()[0] is not None

            if not crops_exists:
                print("[bootstrap] スキーマ未構築 → db/schema.sql を適用")
                sql = _strip_psql_meta(schema_path.read_text(encoding="utf-8"))
                cur.execute(sql)
                need_seed = True
            else:
                cur.execute("SELECT count(*) FROM crops")
                need_seed = cur.fetchone()[0] == 0

    if need_seed:
        print("[bootstrap] 合成デモデータを投入")
        seed_demo.main()
    else:
        print("[bootstrap] 既に構築済み → 投入をスキップ")


if __name__ == "__main__":
    main()
