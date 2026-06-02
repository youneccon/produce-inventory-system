"""
run.py
======
API起動用ランチャー。

Windows では psycopg の async が既定の ProactorEventLoop で動かないため、
uvicorn がイベントループを生成する *前* に SelectorEventLoop へ切り替える必要がある。
`uvicorn api.main:app` を直接叩くとループ生成が先に済んでしまうので、必ずこの
ランチャー（start.ps1 から呼ばれる）経由で起動すること。

reload は無効。--reload の監視プロセスは Ctrl+C やウィンドウを閉じた際に
ワーカー子プロセスが孤児化し、古いコードのままポートを掴み続けることがある
（Windows ではポートの多重バインドが起きるため特に問題になる）。
バックエンドのコードを編集したら、サーバーを一度止めて起動し直すこと。
"""

import asyncio
import logging
import os
import sys

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

from dotenv import load_dotenv

load_dotenv()

# -----------------------------------------------------------------------------
# logging 設定 — INFO レベル、 時刻付き
# 各モジュールは `logger = logging.getLogger(__name__)` で取得して使う。
# 環境変数 LOG_LEVEL=DEBUG/INFO/WARNING で 上書き可。
# -----------------------------------------------------------------------------
_log_level = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, _log_level, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
# psycopg / uvicorn は冗長なので INFO以上に
logging.getLogger("psycopg").setLevel(logging.WARNING)
logging.getLogger("psycopg.pool").setLevel(logging.WARNING)

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "api.main:app",
        host=os.environ.get("API_HOST", "0.0.0.0"),
        port=int(os.environ.get("API_PORT", "8000")),
        reload=False,
    )
