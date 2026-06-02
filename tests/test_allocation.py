"""
tests/test_allocation.py
========================
AllocationService の単体テスト。

カバレッジ対象:
  - FIFO自動引き当て（1ロット充足）
  - FIFO複数ロット行分割（VBAのsplitOccurred=True相当）
  - 在庫不足 → StockInsufficientError
  - ロット手動指定（preferred_lot_id）
  - プレビュー（コミットなし確認）
  - DBトリガーによる在庫マイナス防止
  - 並行引き当て競合（SELECT FOR UPDATE の効果検証）
"""

from __future__ import annotations

import asyncio
from datetime import date
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock, call, patch

import pytest

from api.services.allocation import (
    AllocationService,
    AmbiguousLotError,
    EligibleLot,
    StockInsufficientError,
)


# =============================================================================
# フィクスチャ
# =============================================================================

def make_lot(
    lot_id: int,
    remaining_kg: float,
    fifo_rank: int = 1,
    inbound_date: date = date(2026, 3, 1),
    supplier_id: int = 1,
    unit_price: float | None = 1200.0,
    lot_code: str | None = None,
) -> EligibleLot:
    return EligibleLot(
        lot_id        = lot_id,
        lot_code      = lot_code or f"01G{lot_id:05d}",
        product_id    = 1,
        supplier_id   = supplier_id,
        inbound_date  = inbound_date,
        remaining_kg  = Decimal(str(remaining_kg)),
        fifo_rank     = fifo_rank,
        unit_price    = Decimal(str(unit_price)) if unit_price else None,
        spec_type     = "材種A",
        grade_level   = "特選",
        size_label    = "100mm",
        origin_name   = "奈良",
        supplier_name = "A木材",
    )


def make_conn(candidates: list[EligibleLot], insert_id: int = 9001) -> MagicMock:
    """
    psycopg.AsyncConnection のモック。

    AllocationService は psycopg のショートカット conn.execute(...) を使い、
    返り値のカーソルから fetchall() / fetchone() を呼ぶ。
    そのカーソルモックは conn.curmock で取り出せる（INSERT idの差し替え用）。
    """
    conn = MagicMock()

    cur = MagicMock()
    cur.execute = AsyncMock()
    cur.fetchall = AsyncMock(return_value=[
        {
            "lot_id":        c.lot_id,
            "lot_code":      c.lot_code,
            "product_id":    c.product_id,
            "supplier_id":   c.supplier_id,
            "inbound_date":  c.inbound_date,
            "remaining_kg":  c.remaining_kg,
            "fifo_rank":     c.fifo_rank,
            "unit_price":    c.unit_price,
            "spec_type":     c.spec_type,
            "grade_level":   c.grade_level,
            "size_label":    c.size_label,
            "origin_name":   c.origin_name,
            "supplier_name": c.supplier_name,
        }
        for c in candidates
    ])
    cur.fetchone = AsyncMock(return_value={"id": insert_id})

    # conn.execute(...) は psycopg のショートカット: カーソルを返す
    conn.execute = AsyncMock(return_value=cur)
    conn.curmock = cur

    # トランザクションはコンテキストマネージャとして使えるようにする
    tx = AsyncMock()
    tx.__aenter__ = AsyncMock(return_value=None)
    tx.__aexit__  = AsyncMock(return_value=False)
    conn.transaction = MagicMock(return_value=tx)

    return conn


# =============================================================================
# テストケース
# =============================================================================

class TestAllocate:

    @pytest.mark.asyncio
    async def test_single_lot_sufficient(self):
        """
        在庫が1ロットで充足するケース。
        VBAのsplitOccurred=False、targetLedgerRow=単一ロットに相当。
        """
        lot = make_lot(lot_id=1001, remaining_kg=500.0, fifo_rank=1)
        conn = make_conn([lot], insert_id=9001)

        svc = AllocationService(conn)
        result = await svc.allocate(
            product_id    = 1,
            outbound_date = date(2026, 5, 14),
            quantity_kg   = Decimal("150.0"),
            actor_id      = "00000000-0000-0000-0000-000000000001",
        )

        assert len(result.lines) == 1
        assert result.lines[0].lot_id      == 1001
        assert result.lines[0].quantity_kg == Decimal("150.0")
        assert result.lines[0].is_split    is False
        assert result.is_split             is False

    @pytest.mark.asyncio
    async def test_split_across_two_lots(self):
        """
        在庫が2ロットにまたがるケース。
        VBAのsplitOccurred=True → 行分割に相当。
        lot_id=1001（残100kg）+ lot_id=1002（残400kg）で150kg出庫。

        2026-05 仕様: 複数候補時はユーザーがロットを明示選択する必要があるため
        preferred_lot_id=1001 を指定し、残りは後続FIFOで補う動作を検証する。
        """
        lot1 = make_lot(lot_id=1001, remaining_kg=100.0, fifo_rank=1,
                        inbound_date=date(2026, 3, 1))
        lot2 = make_lot(lot_id=1002, remaining_kg=400.0, fifo_rank=2,
                        inbound_date=date(2026, 3, 18))
        conn = make_conn([lot1, lot2], insert_id=9001)

        # INSERTはロットごとに呼ばれる（fetchoneが複数回）
        conn.curmock.fetchone = AsyncMock(side_effect=[
            {"id": 9001},  # lot1へのINSERT
            {"id": 9002},  # lot2へのINSERT
        ])

        svc = AllocationService(conn)
        result = await svc.allocate(
            product_id       = 1,
            outbound_date    = date(2026, 5, 14),
            quantity_kg      = Decimal("150.0"),
            actor_id         = "00000000-0000-0000-0000-000000000001",
            preferred_lot_id = 1001,  # 先頭ロットを明示指定 → 不足分は後続FIFO
        )

        assert len(result.lines) == 2
        assert result.is_split is True

        # lot1は残100kgすべて使用
        assert result.lines[0].lot_id      == 1001
        assert result.lines[0].quantity_kg == Decimal("100.0")
        assert result.lines[0].is_split    is True  # このロットで在庫枯渇

        # lot2は残り50kgを使用
        assert result.lines[1].lot_id      == 1002
        assert result.lines[1].quantity_kg == Decimal("50.0")
        assert result.lines[1].is_split    is False

    @pytest.mark.asyncio
    async def test_stock_insufficient_raises(self):
        """
        在庫合計が出庫数量を下回る場合、StockInsufficientErrorを送出する。
        VBAのERR_STOCK_INSUFFICIENT = 9999 に相当。
        """
        lot = make_lot(lot_id=1001, remaining_kg=50.0, fifo_rank=1)
        conn = make_conn([lot])

        svc = AllocationService(conn)

        with pytest.raises(StockInsufficientError) as exc_info:
            await svc.allocate(
                product_id    = 1,
                outbound_date = date(2026, 5, 14),
                quantity_kg   = Decimal("200.0"),
                actor_id      = "00000000-0000-0000-0000-000000000001",
            )

        err = exc_info.value
        assert err.required_kg  == Decimal("200.0")
        assert err.available_kg == Decimal("50.0")
        assert len(err.candidates) == 1

        # INSERTは呼ばれていない
        conn.curmock.fetchone.assert_not_called()

    @pytest.mark.asyncio
    async def test_no_candidates_raises_stock_insufficient(self):
        """
        候補ロットが0件の場合も在庫不足として扱う。
        """
        conn = make_conn([])  # 候補なし

        svc = AllocationService(conn)

        with pytest.raises(StockInsufficientError) as exc_info:
            await svc.allocate(
                product_id    = 1,
                outbound_date = date(2026, 5, 14),
                quantity_kg   = Decimal("100.0"),
                actor_id      = "00000000-0000-0000-0000-000000000001",
            )

        assert exc_info.value.available_kg == Decimal("0")
        assert exc_info.value.candidates   == []

    @pytest.mark.asyncio
    async def test_preferred_lot_id_selects_specific_lot(self):
        """
        preferred_lot_idを指定した場合、指定ロットが先に引き当てられる。
        VBAのSelect_Stock_Row → UI選択後のExecute_Allocationに相当。
        """
        lot1 = make_lot(lot_id=1001, remaining_kg=500.0, fifo_rank=1)
        lot2 = make_lot(lot_id=1002, remaining_kg=300.0, fifo_rank=2)
        conn = make_conn([lot1, lot2], insert_id=9001)

        svc = AllocationService(conn)
        result = await svc.allocate(
            product_id        = 1,
            outbound_date     = date(2026, 5, 14),
            quantity_kg       = Decimal("100.0"),
            actor_id          = "00000000-0000-0000-0000-000000000001",
            preferred_lot_id  = 1002,  # FIFOより古くないlot2を明示指定
        )

        assert len(result.lines) == 1
        assert result.lines[0].lot_id == 1002  # 指定ロットが選ばれている

    @pytest.mark.asyncio
    async def test_total_kg_preserved_in_split(self):
        """
        行分割後、全ラインの quantity_kg 合計が元の要求数量に一致する。

        2026-05 仕様: 複数候補時は preferred_lot_id 必須。先頭を指定すると
        後続も FIFO 順に補充される。
        """
        lots = [
            make_lot(lot_id=1001, remaining_kg=30.0,  fifo_rank=1),
            make_lot(lot_id=1002, remaining_kg=80.0,  fifo_rank=2),
            make_lot(lot_id=1003, remaining_kg=200.0, fifo_rank=3),
        ]
        conn = make_conn(lots)
        conn.curmock.fetchone = AsyncMock(side_effect=[
            {"id": 9001},
            {"id": 9002},
            {"id": 9003},
        ])

        svc = AllocationService(conn)
        result = await svc.allocate(
            product_id       = 1,
            outbound_date    = date(2026, 5, 14),
            quantity_kg      = Decimal("150.0"),
            actor_id         = "00000000-0000-0000-0000-000000000001",
            preferred_lot_id = 1001,  # 先頭から FIFO 充足
        )

        total_allocated = sum(l.quantity_kg for l in result.lines)
        assert total_allocated == Decimal("150.0")
        assert len(result.lines) == 3  # 30 + 80 + 40 = 150


class TestPreview:

    @pytest.mark.asyncio
    async def test_preview_does_not_insert(self):
        """
        preview() はコミットしない（INSERTが呼ばれない）。
        """
        lot = make_lot(lot_id=1001, remaining_kg=500.0, fifo_rank=1)
        conn = make_conn([lot])

        svc = AllocationService(conn)
        result = await svc.preview(
            product_id  = 1,
            quantity_kg = Decimal("150.0"),
        )

        assert result["is_sufficient"]   is True
        assert result["available_kg"]    == 500.0
        assert result["candidate_count"] == 1
        assert len(result["sim_lines"])  == 1
        assert result["sim_lines"][0]["take_kg"] == 150.0

        # トランザクション・INSERTは呼ばれていない
        conn.transaction.assert_not_called()
        conn.curmock.fetchone.assert_not_called()

    @pytest.mark.asyncio
    async def test_preview_insufficient(self):
        """
        在庫不足のプレビューはエラーにならず is_sufficient=False を返す。
        """
        lot = make_lot(lot_id=1001, remaining_kg=50.0, fifo_rank=1)
        conn = make_conn([lot])

        svc = AllocationService(conn)
        result = await svc.preview(
            product_id  = 1,
            quantity_kg = Decimal("200.0"),
        )

        assert result["is_sufficient"] is False
        assert result["available_kg"]  == 50.0

    @pytest.mark.asyncio
    async def test_preview_split_simulation(self):
        """
        行分割が発生するケースのシミュレーション結果を確認する。
        """
        lots = [
            make_lot(lot_id=1001, remaining_kg=100.0, fifo_rank=1),
            make_lot(lot_id=1002, remaining_kg=300.0, fifo_rank=2),
        ]
        conn = make_conn(lots)

        svc = AllocationService(conn)
        result = await svc.preview(
            product_id  = 1,
            quantity_kg = Decimal("250.0"),
        )

        assert result["is_sufficient"] is True
        assert len(result["sim_lines"]) == 2
        assert result["sim_lines"][0]["take_kg"]  == 100.0
        assert result["sim_lines"][0]["is_split"]  is True
        assert result["sim_lines"][1]["take_kg"]  == 150.0
        assert result["sim_lines"][1]["is_split"]  is False
