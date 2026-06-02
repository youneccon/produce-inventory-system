"""
tests/test_router_smoke.py
===========================
ルーター統合テスト 基盤の 動作確認 用 smoke test。

  - admin_user → 200
  - viewer_user → 一部 403
  - 認証なし → 401

ここを 通れば conftest の fixture chain が 正しく組まれている。
"""
from __future__ import annotations

import os
import pytest

DATABASE_URL = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not DATABASE_URL,
    reason="DATABASE_URL 未設定 — ルーター統合テストはスキップ",
)


class TestAuthSmoke:
    @pytest.mark.asyncio
    async def test_anon_returns_401(self, anon_client):
        """認証ヘッダなし → 401"""
        r = await anon_client.get("/substitution/rules", params={"crop_id": 2})
        assert r.status_code == 401

    @pytest.mark.asyncio
    async def test_admin_can_get_rules(self, client):
        """admin → 200"""
        r = await client.get("/substitution/rules", params={"crop_id": 2})
        assert r.status_code == 200
        data = r.json()
        # 振替ルール マスタ は list を返す
        assert isinstance(data, list)

    @pytest.mark.asyncio
    async def test_viewer_can_read(self, viewer_client):
        """viewer も GET は通る (substitution/rules は OperatorUser 必須なら 403)"""
        r = await viewer_client.get("/substitution/rules", params={"crop_id": 2})
        # 405 や 401 以外 = 認証通過 を確認
        assert r.status_code in (200, 403)
