"""
tests/conftest.py
=================
共有 pytest 設定。
  - .env を読み込んで DATABASE_URL 等を環境変数化 (DB 統合テスト用)
  - Windows では psycopg 用に SelectorEventLoop に切り替え (ProactorEventLoop は非対応)
  - ルーター統合テスト用の fixture (test_db / admin_user / client) を提供

ルーター統合テストの基本構造:
  - 各テストは psycopg.AsyncConnection を 1 本借り、 最後に rollback
  - FastAPI の get_db 依存を override してその接続を返す
    → API 内の全 INSERT/UPDATE もこの接続上で実行 → rollback で巻戻る
  - admin_user は X-Device-Token 認証用テストユーザーを 1 件作成
  - client は httpx.AsyncClient + ASGITransport (lifespan 起動なし)
"""

import asyncio
import os
import sys
import uuid

from dotenv import load_dotenv

# プロジェクトルートの .env をロード (api/dependencies.py と同じ仕組み)
load_dotenv()

# Windows: psycopg async は ProactorEventLoop と非互換のため SelectorEventLoop を採用
if sys.platform.startswith("win"):
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

# -----------------------------------------------------------------------------
# ここから先はルーター統合テスト用 fixture
# -----------------------------------------------------------------------------

import psycopg
import pytest
import pytest_asyncio
from psycopg.rows import dict_row

DATABASE_URL = os.environ.get("DATABASE_URL")

# DB が無い CI 等は skip
needs_db = pytest.mark.skipif(
    not DATABASE_URL,
    reason="DATABASE_URL 未設定 — DB 統合テストはスキップ",
)


@pytest_asyncio.fixture
async def test_db():
    """各テスト 1 本ずつ DB 接続を借り、 最後に必ず rollback して接続クローズ。
    autocommit=False で接続するため、 全 SQL は単一トランザクション内。"""
    conn = await psycopg.AsyncConnection.connect(
        DATABASE_URL, autocommit=False, row_factory=dict_row,
    )
    try:
        yield conn
    finally:
        await conn.rollback()
        await conn.close()


@pytest_asyncio.fixture
async def admin_user(test_db):
    """テスト用 admin ユーザーを 1 件作成し、 (user_id, device_token) を返す。
    rollback されるので 残らない。"""
    token = f"__test_admin_{uuid.uuid4().hex[:10]}__"
    async with test_db.cursor() as cur:
        await cur.execute(
            """INSERT INTO users (display_name, role, is_active, device_token)
               VALUES ('__router_test_admin__', 'admin', true, %s)
               RETURNING id""", (token,))
        row = await cur.fetchone()
    return (row['id'], token)


@pytest_asyncio.fixture
async def viewer_user(test_db):
    """テスト用 viewer ユーザー (権限不足テスト用)。"""
    token = f"__test_viewer_{uuid.uuid4().hex[:10]}__"
    async with test_db.cursor() as cur:
        await cur.execute(
            """INSERT INTO users (display_name, role, is_active, device_token)
               VALUES ('__router_test_viewer__', 'viewer', true, %s)
               RETURNING id""", (token,))
        row = await cur.fetchone()
    return (row['id'], token)


@pytest_asyncio.fixture
async def client(test_db, admin_user):
    """httpx AsyncClient: admin 認証ヘッダ付き + DB 依存 override。

    使い方:
        async def test_xxx(client, test_db):
            r = await client.get("/substitution/rules", params={"crop_id": 2})
            assert r.status_code == 200
    """
    from httpx import ASGITransport, AsyncClient
    from api.main import app
    from api.dependencies import get_db

    async def override_get_db():
        # 同じ test_db を使い回すことで、 API 経由の INSERT も rollback の対象になる
        yield test_db

    app.dependency_overrides[get_db] = override_get_db
    _, token = admin_user
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"X-Device-Token": token},
    ) as c:
        yield c
    app.dependency_overrides.clear()


@pytest_asyncio.fixture
async def viewer_client(test_db, viewer_user):
    """viewer 権限の client (403 確認用)。"""
    from httpx import ASGITransport, AsyncClient
    from api.main import app
    from api.dependencies import get_db

    async def override_get_db():
        yield test_db

    app.dependency_overrides[get_db] = override_get_db
    _, token = viewer_user
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"X-Device-Token": token},
    ) as c:
        yield c
    app.dependency_overrides.clear()


@pytest_asyncio.fixture
async def anon_client(test_db):
    """認証ヘッダ無しの client (401 確認用)。"""
    from httpx import ASGITransport, AsyncClient
    from api.main import app
    from api.dependencies import get_db

    async def override_get_db():
        yield test_db

    app.dependency_overrides[get_db] = override_get_db
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()
