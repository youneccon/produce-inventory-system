r"""
tools/backup_db.py
===================
PostgreSQL 在庫 DB の自動バックアップ。

機能:
  - DATABASE_URL から接続情報を抽出
  - pg_dump で カスタム形式 (-Fc) ダンプ → backups/inventory_YYYYMMDD_HHMMSS.dump
  - 同時に SQL 形式 (-Fp) も backups/inventory_YYYYMMDD_HHMMSS.sql に保存
    (.sql はテキストなのでクラッシュ解析や grep に便利)
  - 古いバックアップを保持数 (--keep, デフォルト 30) を超えたら削除
  - --dry-run で削除候補のみ表示

使い方:
  python tools/backup_db.py             # ダンプ + ローテーション
  python tools/backup_db.py --keep 60   # 直近 60 件を保持
  python tools/backup_db.py --dry-run   # 実行せず計画のみ
  python tools/backup_db.py --dir D:\backups\inventory  # 保存先変更

復元:
  pg_restore -h <host> -U <user> -d <new_db> -c backups/inventory_*.dump
  または
  psql -h <host> -U <user> -d <new_db> -f backups/inventory_*.sql

タスクスケジューラ登録 (Windows):
  schtasks /create /tn "InventoryBackup" /tr "powershell -File <repo>\tools\backup.ps1" \
          /sc daily /st 23:00
  → 詳細は tools/backup.ps1 のコメントを参照
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse, unquote

from dotenv import load_dotenv

# UTF-8 強制 (cp932 ターミナル対策)
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

PG_DUMP_CANDIDATES = [
    r"C:\Program Files\PostgreSQL\16\bin\pg_dump.exe",
    r"C:\Program Files\PostgreSQL\17\bin\pg_dump.exe",
    r"C:\Program Files\PostgreSQL\15\bin\pg_dump.exe",
    "pg_dump",   # PATH 上にあれば
]


def _find_pg_dump() -> str:
    for cand in PG_DUMP_CANDIDATES:
        if cand == "pg_dump":
            # PATH 探索
            import shutil
            found = shutil.which("pg_dump")
            if found:
                return found
        elif Path(cand).exists():
            return cand
    raise FileNotFoundError(
        "pg_dump.exe が見つかりません。PostgreSQL の bin を PATH に追加するか、"
        "tools/backup_db.py 内の PG_DUMP_CANDIDATES を編集してください。")


def _parse_database_url(url: str) -> dict:
    """postgresql://user:pass@host:port/dbname → 辞書"""
    p = urlparse(url)
    if not p.hostname or not p.path:
        raise ValueError(f"DATABASE_URL の形式が不正: {url[:30]}...")
    return {
        "host":     p.hostname,
        "port":     str(p.port or 5432),
        "user":     unquote(p.username or ""),
        "password": unquote(p.password or ""),
        "dbname":   p.path.lstrip("/"),
    }


def _do_dump(pg_dump: str, conn: dict, out_path: Path, fmt: str) -> None:
    """fmt = 'c' (custom binary) or 'p' (plain SQL)"""
    env = os.environ.copy()
    if conn["password"]:
        env["PGPASSWORD"] = conn["password"]
    cmd = [
        pg_dump,
        "-h", conn["host"],
        "-p", conn["port"],
        "-U", conn["user"],
        "-F", fmt,
        "-f", str(out_path),
        "--no-owner",
        "--no-acl",
        conn["dbname"],
    ]
    result = subprocess.run(cmd, env=env, capture_output=True, text=True)
    if result.returncode != 0:
        # pg_dump がエラーで途中作成されたファイルは消す
        if out_path.exists():
            out_path.unlink()
        raise RuntimeError(
            f"pg_dump 失敗 (exit {result.returncode}):\n{result.stderr.strip()}")


def _rotate(backup_dir: Path, keep: int, dry_run: bool) -> list[Path]:
    """古い .dump / .sql を削除して keep 件だけ残す。削除したパスのリストを返す。
    同じタイムスタンプの .dump と .sql は 1 セットとして数える。"""
    # ファイル名: inventory_YYYYMMDD_HHMMSS.{dump,sql}
    pairs: dict[str, dict] = {}
    for f in backup_dir.glob("inventory_*.*"):
        if f.suffix not in (".dump", ".sql"):
            continue
        stem = f.stem   # inventory_YYYYMMDD_HHMMSS
        pairs.setdefault(stem, {})[f.suffix] = f
    # タイムスタンプ降順
    sorted_stems = sorted(pairs.keys(), reverse=True)
    to_delete: list[Path] = []
    for stem in sorted_stems[keep:]:
        for f in pairs[stem].values():
            to_delete.append(f)
    if not dry_run:
        for f in to_delete:
            try:
                f.unlink()
            except Exception as e:
                print(f"  ⚠ 削除失敗 {f.name}: {e}")
    return to_delete


def _human_size(n: int) -> str:
    for u in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f} {u}"
        n /= 1024
    return f"{n:.1f} TB"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dir", default=str(ROOT / "backups"),
                    help="バックアップ保存先 (default: <repo>/backups)")
    ap.add_argument("--keep", type=int, default=30,
                    help="保持件数 (default: 30)")
    ap.add_argument("--dry-run", action="store_true",
                    help="実際にダンプ・削除せず計画のみ表示")
    ap.add_argument("--no-sql", action="store_true",
                    help="SQL 形式 (.sql) を作らず .dump のみ")
    args = ap.parse_args()

    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("✗ DATABASE_URL が .env に未設定です。")
        return 1
    conn = _parse_database_url(db_url)
    pg_dump = _find_pg_dump()

    backup_dir = Path(args.dir)
    backup_dir.mkdir(parents=True, exist_ok=True)

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    dump_path = backup_dir / f"inventory_{ts}.dump"
    sql_path  = backup_dir / f"inventory_{ts}.sql"

    print(f"バックアップ先  : {backup_dir}")
    print(f"接続先          : {conn['host']}:{conn['port']}/{conn['dbname']} (user={conn['user']})")
    print(f"pg_dump         : {pg_dump}")
    print(f"保持件数        : {args.keep}")
    print(f"DRY-RUN         : {args.dry_run}")
    print()

    if not args.dry_run:
        print(f"→ ダンプ中 (custom format) {dump_path.name} ...", end=" ", flush=True)
        _do_dump(pg_dump, conn, dump_path, "c")
        print(f"OK ({_human_size(dump_path.stat().st_size)})")
        if not args.no_sql:
            print(f"→ ダンプ中 (plain SQL)    {sql_path.name} ...", end=" ", flush=True)
            _do_dump(pg_dump, conn, sql_path, "p")
            print(f"OK ({_human_size(sql_path.stat().st_size)})")
    else:
        print(f"(dry-run) 作成予定: {dump_path.name}, {sql_path.name}")

    # ローテーション
    deleted = _rotate(backup_dir, args.keep, args.dry_run)
    print()
    if deleted:
        verb = "削除予定" if args.dry_run else "削除済み"
        print(f"{verb} ({len(deleted)} 件):")
        for f in deleted:
            print(f"  - {f.name}")
    else:
        print("古いバックアップは見つかりませんでした。")

    print()
    print("✓ 完了。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
