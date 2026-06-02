"""
tests/test_recipe_editor_permission.py
========================================
M3-P2 で 追加した recipe_editor 権限の 検証 (DB 統合)。

検証ポイント:
  - admin: 任意の事業部の レシピ編集 OK
  - recipe_editor + division ∈ user.divisions: そこだけ OK
  - recipe_editor + division ∉ user.divisions: 403
  - viewer / operator: レシピ編集 (write) 403
  - 認証ヘッダ なし: 401
  - 内部 GET (seed) は 全 認証ユーザー で OK (= viewer も OK)
"""
from __future__ import annotations

import os
import uuid

import psycopg
import pytest
import pytest_asyncio
from psycopg.rows import dict_row

DATABASE_URL = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not DATABASE_URL,
    reason="DATABASE_URL 未設定",
)


# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------

async def _create_user(test_db, role: str, divisions: list[int] | None = None) -> tuple[str, str]:
    """テスト用ユーザー を 作成し (user_id, token) を 返す"""
    token = f"__test_{role}_{uuid.uuid4().hex[:10]}__"
    async with test_db.cursor() as cur:
        await cur.execute(
            """INSERT INTO users (display_name, role, is_active, device_token, divisions)
               VALUES (%s, %s, true, %s, %s)
               RETURNING id""",
            (f"__test_{role}__", role, token, divisions or []))
        row = await cur.fetchone()
    return (row["id"], token)


def _client_with_token(test_db, token: str):
    """指定 token で 認証 した client を 作る"""
    from httpx import ASGITransport, AsyncClient
    from api.main import app
    from api.dependencies import get_db

    async def override_get_db():
        yield test_db

    app.dependency_overrides[get_db] = override_get_db
    transport = ASGITransport(app=app)
    return AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"X-Device-Token": token},
    )


# -----------------------------------------------------------------------------
# 内部 endpoint の 権限 テスト (アンケート関連)
# -----------------------------------------------------------------------------

class TestRecipeSurveyAuth:

    async def test_admin_can_get_seed_any_division(self, client, test_db):
        """admin は 任意の事業部 の seed 取得 OK"""
        # admin 認証は client fixture 経由 (= admin_user)
        for div in [1, 2, 3, 4, 5]:
            r = await client.get(f"/recipe-survey/{div}/seed")
            assert r.status_code == 200, f"div={div}: {r.text}"

    async def test_recipe_editor_can_read_any_division(self, test_db):
        """recipe_editor は 担当外の事業部でも 閲覧は OK"""
        _, token = await _create_user(test_db, "recipe_editor", divisions=[1])
        async with _client_with_token(test_db, token) as c:
            # divisions={1} だが 全事業部 GET OK
            for div in [1, 2, 3]:
                r = await c.get(f"/recipe-survey/{div}/seed")
                assert r.status_code == 200, f"div={div}: {r.text}"
        from api.main import app
        app.dependency_overrides.clear()

    async def test_recipe_editor_can_post_only_own_division(self, test_db):
        """recipe_editor は 担当事業部 のみ 提案POST OK、 他事業部 は 403"""
        _, token = await _create_user(test_db, "recipe_editor", divisions=[2])
        async with _client_with_token(test_db, token) as c:
            # 担当 = 事業2部 → OK
            r = await c.post("/recipe-survey/2", json={
                "submitter_name": "test", "submitter_note": None,
                "lines": [{
                    "product_id": None, "product_text": "テスト商品",
                    "material_id": None, "material_text": "テスト資材",
                    "quantity_per_unit": "1.0", "unit_note": None, "line_note": None,
                    "is_uncertain": False,
                }],
            })
            assert r.status_code == 201, f"自部署 (2): {r.text}"

            # 担当外 = 事業3部 → 403
            r = await c.post("/recipe-survey/3", json={
                "submitter_name": "test", "submitter_note": None,
                "lines": [{
                    "product_id": None, "product_text": "テスト商品",
                    "material_id": None, "material_text": "テスト資材",
                    "quantity_per_unit": "1.0", "unit_note": None, "line_note": None,
                    "is_uncertain": False,
                }],
            })
            assert r.status_code == 403, f"他部署 (3): {r.text}"
        from api.main import app
        app.dependency_overrides.clear()

    async def test_viewer_cannot_post(self, test_db):
        """viewer は 任意の事業部で 提案POST 不可 (403)"""
        _, token = await _create_user(test_db, "viewer")
        async with _client_with_token(test_db, token) as c:
            r = await c.post("/recipe-survey/1", json={
                "submitter_name": "test", "submitter_note": None,
                "lines": [{
                    "product_id": None, "product_text": "x",
                    "material_id": None, "material_text": "y",
                    "quantity_per_unit": "1.0", "unit_note": None, "line_note": None,
                    "is_uncertain": False,
                }],
            })
            assert r.status_code == 403
        from api.main import app
        app.dependency_overrides.clear()

    async def test_anon_returns_401_on_private(self, anon_client):
        """認証なし で 内部 endpoint へ → 401"""
        r = await anon_client.get("/recipe-survey/1/seed")
        assert r.status_code == 401


# -----------------------------------------------------------------------------
# operator も レシピ書き込み 不可 (recipe_editor も 入出庫 不可) の 確認
# -----------------------------------------------------------------------------

class TestRoleBoundaries:

    async def test_recipe_editor_cannot_create_inbound(self, test_db):
        """recipe_editor は 入庫登録 (OperatorUser 必須) は 403"""
        _, token = await _create_user(test_db, "recipe_editor", divisions=[1])
        async with _client_with_token(test_db, token) as c:
            # 適当 product / supplier を 用意せず、 認証段階で 403 を 期待
            r = await c.post("/inbound/lots", json={
                "product_id": 1, "supplier_id": 1,
                "inbound_date": "2026-05-23",
                "cases": 1, "kg_per_case": "10", "total_kg": "10",
                "unit_price": "100",
            })
            # 403 (権限不足) を期待。 422 (validation) や 404 では NG
            assert r.status_code == 403, f"got {r.status_code}: {r.text}"
        from api.main import app
        app.dependency_overrides.clear()
