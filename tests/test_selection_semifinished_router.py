"""
tests/test_selection_semifinished_router.py
============================================
api/routers/selection.py + api/routers/semifinished.py の ルーター 統合テスト。

カバレッジ:
  - GET /crops — list crops
  - GET /selection/source-lots — 候補 lot 一覧
  - GET /selection/output-spec-types — 出力規格一覧
  - GET /semifinished/lots — 半製品台帳 list
  - GET /semifinished/source-outbounds — 元出庫候補
  - POST /semifinished/lots — 直接登録 (出庫無し) + 404
"""
from __future__ import annotations

import os
import uuid

import pytest
import pytest_asyncio

DATABASE_URL = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not DATABASE_URL,
    reason="DATABASE_URL 未設定",
)


# -----------------------------------------------------------------------------
# Selection
# -----------------------------------------------------------------------------

class TestSelection:
    async def test_list_crops(self, client):
        r = await client.get("/crops")
        assert r.status_code == 200
        data = r.json()
        assert isinstance(data, list)
        # crop_id=1 (生姜) と 2 (大蒜) は 最低限 ある
        ids = {c["id"] for c in data}
        assert 1 in ids
        assert 2 in ids

    async def test_source_lots_returns_array(self, client):
        r = await client.get("/selection/source-lots", params={"crop_id": 2})
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    async def test_output_spec_types(self, client):
        """選別後 規格 一覧 (drop-down 用)"""
        r = await client.get("/selection/output-spec-types", params={"crop_id": 2})
        assert r.status_code == 200
        assert isinstance(r.json(), list)


# -----------------------------------------------------------------------------
# Semifinished
# -----------------------------------------------------------------------------

class TestSemifinished:
    async def test_list_lots(self, client):
        """半製品台帳 list — 空でも 200"""
        r = await client.get("/semifinished/lots", params={"crop_id": 2})
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    async def test_source_outbounds(self, client):
        """元出庫候補 list — 空でも 200"""
        r = await client.get("/semifinished/source-outbounds", params={"crop_id": 2})
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    async def test_get_lot_not_found(self, client):
        r = await client.get("/semifinished/lots/99999999")
        assert r.status_code == 404

    async def test_archive_not_found(self, client):
        r = await client.post("/semifinished/lots/99999999/archive")
        assert r.status_code == 404

    async def test_delete_not_found(self, client):
        r = await client.delete("/semifinished/lots/99999999")
        assert r.status_code == 404
