"""
tests/test_patch_validation.py
===============================
登録済みデータの修正 (PATCH) における拒否ロジックの単体テスト。

ここで検証する規則は「下流の整合性を壊す変更」を弾けるかどうか。
本番で誤って整合性破壊が起きると棚卸合わせや数量補正が手作業になり、
最悪マイナス在庫が発生するため、回帰検知が重要。

カバレッジ:
  ## 原料入庫ロット PATCH (api/main.py: patch_inbound_lot)
  - new total_kg < 出庫済合計 → 409
  - inbound_date > 最初の出庫日 → 409
  - archived ロットの編集 → 409
  - 存在しない lot_id → 404

  ## 原料出庫 PATCH (api/routers/outbound.py: patch_outbound_record)
  - 新 qty > ロット残量 + 自分の旧 qty → 409
  - outbound_date < inbound_date → 409

  ## 資材入出庫 PATCH (api/routers/materials.py: patch_movement)
  - quantity = 0 → 422
  - forward simulation で下流マイナス → 409

実装ファイル: api/main.py, api/routers/outbound.py, api/routers/materials.py
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException


# =============================================================================
# 共通ヘルパー: db.cursor() を async context manager としてモックする
# =============================================================================

def make_db_mock(fetchone_results: list, fetchall_results: list | None = None):
    """psycopg AsyncConnection のモック。
    `async with db.cursor() as cur:` の形を取れるよう、cursor() は async
    context manager を返す MagicMock とする。fetchone / fetchall は
    呼び出し順の side_effect で制御する。"""
    cur = MagicMock()
    cur.execute  = AsyncMock()
    cur.fetchone = AsyncMock(side_effect=fetchone_results)
    cur.fetchall = AsyncMock(side_effect=(fetchall_results or []))
    cur.rowcount = 1

    ctx = MagicMock()
    ctx.__aenter__ = AsyncMock(return_value=cur)
    ctx.__aexit__  = AsyncMock(return_value=False)

    db = MagicMock()
    db.cursor = MagicMock(return_value=ctx)
    return db, cur


def fake_user(role: str = 'operator'):
    return {"id": "00000000-0000-0000-0000-000000000001",
            "role": role, "display_name": "テストユーザ"}


def fake_request():
    req = MagicMock()
    req.client = MagicMock()
    req.client.host = "127.0.0.1"
    return req


# =============================================================================
# 原料入庫ロット PATCH
# =============================================================================

class TestInboundLotPatch:
    """api/main.py の patch_inbound_lot"""

    @pytest.fixture(autouse=True)
    def _patch_audit(self):
        """全テストで write_audit を no-op にする (DB に書き込まないため)"""
        with patch('api.main.write_audit', new=AsyncMock()):
            yield

    @pytest.mark.asyncio
    async def test_404_when_lot_missing(self):
        from api.main import patch_inbound_lot, InboundLotPatch
        db, _ = make_db_mock(fetchone_results=[None])
        body = InboundLotPatch(note='hi')
        with pytest.raises(HTTPException) as exc:
            await patch_inbound_lot(99999, body, db, fake_user(), fake_request())
        assert exc.value.status_code == 404

    @pytest.mark.asyncio
    async def test_409_when_archived(self):
        from api.main import patch_inbound_lot, InboundLotPatch
        existing = {
            "id": 1, "cases": Decimal('10'), "kg_per_case": Decimal('15'),
            "total_kg": Decimal('150'), "unit_price": None, "note": None,
            "inbound_date": date(2026, 5, 1),
            "archived_at": date(2026, 5, 10),    # ← archived
        }
        db, _ = make_db_mock(fetchone_results=[existing])
        body = InboundLotPatch(note='try edit')
        with pytest.raises(HTTPException) as exc:
            await patch_inbound_lot(1, body, db, fake_user(), fake_request())
        assert exc.value.status_code == 409
        assert 'アーカイブ' in exc.value.detail

    @pytest.mark.asyncio
    async def test_409_when_total_kg_below_outbound_sum(self):
        """既に 100kg 出庫済のロットに、total_kg を 80kg に下げようとすると拒否"""
        from api.main import patch_inbound_lot, InboundLotPatch
        existing = {
            "id": 1, "cases": Decimal('10'), "kg_per_case": Decimal('15'),
            "total_kg": Decimal('150'), "unit_price": None, "note": None,
            "inbound_date": date(2026, 5, 1), "archived_at": None,
        }
        out_row = {"out_kg": Decimal('100'), "first_out": date(2026, 5, 5)}
        db, _ = make_db_mock(fetchone_results=[existing, out_row])
        # cases=4 × kg_per_case=20 = 80kg, 出庫済 100kg を下回る
        body = InboundLotPatch(cases=Decimal('4'), kg_per_case=Decimal('20'))
        with pytest.raises(HTTPException) as exc:
            await patch_inbound_lot(1, body, db, fake_user(), fake_request())
        assert exc.value.status_code == 409
        assert '出庫済合計' in exc.value.detail

    @pytest.mark.asyncio
    async def test_409_when_inbound_date_after_first_outbound(self):
        """5/1 入荷 → 5/5 出庫済のロットを 5/10 入荷に変更しようとすると拒否
        (未入荷品の出庫になる)"""
        from api.main import patch_inbound_lot, InboundLotPatch
        existing = {
            "id": 1, "cases": Decimal('10'), "kg_per_case": Decimal('15'),
            "total_kg": Decimal('150'), "unit_price": None, "note": None,
            "inbound_date": date(2026, 5, 1), "archived_at": None,
        }
        out_row = {"out_kg": Decimal('50'), "first_out": date(2026, 5, 5)}
        db, _ = make_db_mock(fetchone_results=[existing, out_row])
        body = InboundLotPatch(inbound_date=date(2026, 5, 10))
        with pytest.raises(HTTPException) as exc:
            await patch_inbound_lot(1, body, db, fake_user(), fake_request())
        assert exc.value.status_code == 409
        assert '入荷日' in exc.value.detail

    @pytest.mark.asyncio
    async def test_422_when_empty_body(self):
        from api.main import patch_inbound_lot, InboundLotPatch
        db, _ = make_db_mock(fetchone_results=[])
        body = InboundLotPatch()    # 全て None → 何も指定なし
        with pytest.raises(HTTPException) as exc:
            await patch_inbound_lot(1, body, db, fake_user(), fake_request())
        assert exc.value.status_code == 422


# =============================================================================
# 原料出庫 PATCH
# =============================================================================

class TestOutboundRecordPatch:
    """api/routers/outbound.py の patch_outbound_record"""

    @pytest.fixture(autouse=True)
    def _patch_audit(self):
        with patch('api.routers.outbound.write_audit', new=AsyncMock()):
            yield

    @pytest.mark.asyncio
    async def test_404_when_record_missing(self):
        from api.routers.outbound import (
            patch_outbound_record, OutboundRecordPatch,
        )
        db, _ = make_db_mock(fetchone_results=[None])
        body = OutboundRecordPatch(note='x')
        with pytest.raises(HTTPException) as exc:
            await patch_outbound_record(99999, body, db, fake_user(), fake_request())
        assert exc.value.status_code == 404

    @pytest.mark.asyncio
    async def test_409_when_qty_exceeds_lot_remaining(self):
        """ロット total=100kg, 自分の旧 qty=20kg, 他の出庫=70kg
        → 残量 30kg。新 qty=50kg は超過 → 拒否"""
        from api.routers.outbound import (
            patch_outbound_record, OutboundRecordPatch,
        )
        existing = {
            "id": 1, "lot_id": 100, "quantity_kg": Decimal('20'),
            "outbound_date": date(2026, 5, 10), "note": None,
        }
        lot = {"total_kg": Decimal('100'), "inbound_date": date(2026, 5, 1)}
        other = {"other_out": Decimal('70')}    # 自分以外の出庫
        db, _ = make_db_mock(fetchone_results=[existing, lot, other])
        body = OutboundRecordPatch(quantity_kg=Decimal('50'))
        with pytest.raises(HTTPException) as exc:
            await patch_outbound_record(1, body, db, fake_user(), fake_request())
        assert exc.value.status_code == 409
        assert 'ロット残量' in exc.value.detail

    @pytest.mark.asyncio
    async def test_409_when_outbound_date_before_inbound_date(self):
        """ロット入荷 5/5 のものを 5/1 出庫に変更 → 拒否"""
        from api.routers.outbound import (
            patch_outbound_record, OutboundRecordPatch,
        )
        existing = {
            "id": 1, "lot_id": 100, "quantity_kg": Decimal('20'),
            "outbound_date": date(2026, 5, 10), "note": None,
        }
        lot = {"total_kg": Decimal('100'), "inbound_date": date(2026, 5, 5)}
        db, _ = make_db_mock(fetchone_results=[existing, lot])
        body = OutboundRecordPatch(outbound_date=date(2026, 5, 1))
        with pytest.raises(HTTPException) as exc:
            await patch_outbound_record(1, body, db, fake_user(), fake_request())
        assert exc.value.status_code == 409
        assert '入荷日' in exc.value.detail


# =============================================================================
# 資材入出庫 PATCH
# =============================================================================

class TestMaterialMovementPatch:
    """api/routers/materials.py の patch_movement"""

    @pytest.fixture(autouse=True)
    def _patch_audit(self):
        with patch('api.routers.materials.write_audit', new=AsyncMock()):
            yield

    @pytest.mark.asyncio
    async def test_422_when_quantity_zero(self):
        from api.routers.materials import (
            patch_movement, MovementPatch,
        )
        db, _ = make_db_mock(fetchone_results=[])
        body = MovementPatch(quantity=Decimal('0'))
        with pytest.raises(HTTPException) as exc:
            await patch_movement(1, body, db, fake_user(), fake_request())
        assert exc.value.status_code == 422

    @pytest.mark.asyncio
    async def test_404_when_movement_missing(self):
        from api.routers.materials import (
            patch_movement, MovementPatch,
        )
        # 存在チェック (fetchone[0]) が None
        db, _ = make_db_mock(fetchone_results=[None])
        body = MovementPatch(note='only note change')
        with pytest.raises(HTTPException) as exc:
            await patch_movement(99999, body, db, fake_user(), fake_request())
        assert exc.value.status_code == 404

    @pytest.mark.asyncio
    async def test_409_when_simulation_returns_negative(self):
        """資材 movement の数量変更で下流のどこかでマイナスになる場合 → 拒否。
        _simulate_material_balance をパッチして「マイナス検出」を返させる。"""
        from api.routers.materials import (
            patch_movement, MovementPatch,
        )
        existing = {
            "material_id": 5, "movement_date": date(2026, 5, 1),
            "quantity": Decimal('100'), "note": None,
        }
        db, _ = make_db_mock(fetchone_results=[existing])
        body = MovementPatch(quantity=Decimal('50'))    # 数量変更 → simulation 走る
        with patch(
            'api.routers.materials._simulate_material_balance',
            new=AsyncMock(return_value=(date(2026, 5, 10), Decimal('-30'))),
        ):
            with pytest.raises(HTTPException) as exc:
                await patch_movement(1, body, db, fake_user(), fake_request())
        assert exc.value.status_code == 409
        assert '2026-05-10' in exc.value.detail
        assert '理論在庫' in exc.value.detail
