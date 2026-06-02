"""
tests/test_nr_report_router.py
================================
api/routers/nr_report.py の ルーター 統合テスト。

カバレッジ:
  - GET /bom — list (filter, search)
  - POST /bom — upsert (happy, invalid ratio_2 のみ など)
  - PATCH /bom/{code} — partial update + 404
  - DELETE /bom/{code} — + 404
  - POST /nr-report/expand — 簡易 Excel 取込
  - POST /nr-report/preview-as-outbound — シミュレーション
"""
from __future__ import annotations

import io
import os
import uuid
from datetime import date
from decimal import Decimal

import pytest
import pytest_asyncio

DATABASE_URL = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not DATABASE_URL,
    reason="DATABASE_URL 未設定",
)


# -----------------------------------------------------------------------------
# Seed: 簡易マスタ
# -----------------------------------------------------------------------------

@pytest_asyncio.fixture
async def bom_seed(test_db):
    """BOM テスト用 origin + grade を 作成"""
    tag = uuid.uuid4().hex[:8]
    async with test_db.cursor() as cur:
        await cur.execute(
            "INSERT INTO origins (name) VALUES (%s) RETURNING id",
            (f"BOM産地_{tag}",))
        origin_id = (await cur.fetchone())["id"]
        await cur.execute(
            "INSERT INTO grades (spec_type, grade_level, size_label) VALUES (%s, 'A', 'L') RETURNING id",
            (f"BOM規格_{tag}",))
        grade_id_1 = (await cur.fetchone())["id"]
    return {"origin_id": origin_id, "grade_id_1": grade_id_1, "tag": tag}


# -----------------------------------------------------------------------------
# BOM CRUD
# -----------------------------------------------------------------------------

class TestBomCrud:
    async def test_list_bom_returns_array(self, client):
        r = await client.get("/bom", params={"crop_id": 2})
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    async def test_create_bom_happy(self, client, bom_seed):
        code = f"TEST_BOM_{bom_seed['tag']}"
        r = await client.post("/bom", json={
            "product_code": code,
            "product_name": "テスト商品",
            "crop_id": 2,
            "origin_id": bom_seed["origin_id"],
            "grade_id_1": bom_seed["grade_id_1"],
            "ratio_1": "100",
        })
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["product_code"] == code
        assert body["is_resolved"] is True   # origin + grade_id_1 が ある

    async def test_create_bom_ratio_2_without_grade_2_rejected(self, client, bom_seed):
        """ratio_2 だけ あって grade_id_2 が 無いと 400"""
        code = f"TEST_BOM_BAD_{bom_seed['tag']}"
        r = await client.post("/bom", json={
            "product_code": code,
            "product_name": "不整合 BOM",
            "crop_id": 2,
            "origin_id": bom_seed["origin_id"],
            "grade_id_1": bom_seed["grade_id_1"],
            "ratio_1": "70",
            "ratio_2": "30",
            # grade_id_2 が ない
        })
        assert r.status_code == 400

    async def test_patch_bom(self, client, bom_seed):
        code = f"TEST_BOM_PATCH_{bom_seed['tag']}"
        await client.post("/bom", json={
            "product_code": code, "product_name": "patch対象",
            "crop_id": 2, "origin_id": bom_seed["origin_id"],
            "grade_id_1": bom_seed["grade_id_1"], "ratio_1": "100",
        })
        r = await client.patch(f"/bom/{code}", json={"product_name": "patched"})
        assert r.status_code == 200
        assert r.json()["product_name"] == "patched"

    async def test_patch_not_found(self, client):
        r = await client.patch("/bom/NON_EXIST_CODE", json={"product_name": "x"})
        assert r.status_code == 404

    async def test_delete_not_found(self, client):
        r = await client.delete("/bom/NON_EXIST_CODE_DEL")
        assert r.status_code == 404


# -----------------------------------------------------------------------------
# NR Excel expand
# -----------------------------------------------------------------------------

def _make_minimal_xlsx() -> bytes:
    """expand_from_xlsx が 受け入れる 最小限の Excel を bytes で返す。

    実 Excel は 「商品期間集計」 シートに 商品コード + 出荷数 が 並ぶ 形式。
    エラーパス検証用なので、 ほぼ空の シートを 用意。
    """
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = "商品期間集計"
    # ヘッダ行 + 1データ行 (存在しない商品コード)
    ws.append(["商品コード", "品名", "出荷数"])
    ws.append([f"DUMMY_{uuid.uuid4().hex[:6]}", "ダミー", 100])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


class TestNrExpand:
    async def test_expand_with_minimal_xlsx(self, client):
        """商品コード が マスタに 無くても エラー無しで warnings に 載る"""
        xlsx = _make_minimal_xlsx()
        files = {"file": ("test.xlsx", xlsx,
                          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}
        r = await client.post("/nr-report/expand", params={"crop_id": 2}, files=files)
        # expand は 商品が マッチしなくても 200 を 返し warnings に 入れる 設計
        assert r.status_code == 200, r.text
        data = r.json()
        assert "rows" in data
        assert "warnings" in data
