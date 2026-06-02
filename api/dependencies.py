"""
api/dependencies.py
===================
DB接続プールと、FastAPIの共有依存性を一元管理するモジュール。

psycopg版（Python 3.14対応）。アプリ全体でこのモジュールの _pool だけを使う。
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from typing import Annotated

import psycopg
import psycopg_pool
from dotenv import load_dotenv
from fastapi import Depends, FastAPI
from psycopg.rows import dict_row

# .env を読み込む（start.ps1 経由でなくても uvicorn 直接起動で動くように）
load_dotenv()

# =============================================================================
# DB接続プール（アプリ唯一のプール）
# =============================================================================

_pool: psycopg_pool.AsyncConnectionPool | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """FastAPIのライフサイクルでDB接続プールを開閉する。"""
    global _pool
    _pool = psycopg_pool.AsyncConnectionPool(
        conninfo=os.environ["DATABASE_URL"],
        min_size=2,
        max_size=10,
        open=False,
    )
    await _pool.open()
    try:
        yield
    finally:
        await _pool.close()


async def get_db():
    """リクエストごとにプールから接続を1つ借り出す依存性。"""
    assert _pool is not None, "DB接続プールが初期化されていません"
    async with _pool.connection() as conn:
        conn.row_factory = dict_row
        yield conn


DB = Annotated[psycopg.AsyncConnection, Depends(get_db)]
