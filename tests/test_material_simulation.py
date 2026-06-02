"""
tests/test_material_simulation.py
==================================
_simulate_material_balance の単体テスト。

このロジックは「資材入出庫レコードの修正/削除が下流の在庫を破壊しないか」
を判定する核心部分。誤動作するとマイナス在庫を作る、または正当な編集を
拒否してユーザを困らせる。

カバレッジ:
  - 基本: 起点(棚卸)からの累積で負にならない → None を返す
  - 削除で負になる: 削除提案で下流のどこかでマイナス → そのタプルを返す
  - 編集で負になる: 数量変更で下流で負 → 検出
  - 編集で日付シフト: 同じ qty でも日付前倒し/後ろ倒しで判定が変わる
  - 起点 (base_date) 以前の編集は無視される (= base_qty に折込済の前提)
  - 棚卸ゼロ + 未棚卸資材: epoch (1900-01-01) を起点に扱う
  - new_event 注入の上書き挙動: 既存除外 + 新規追加が同日に重ねっても正しく集約

実装ファイル: api/routers/materials.py の _simulate_material_balance
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock

import pytest

from api.routers.materials import _simulate_material_balance


# =============================================================================
# モック cursor 作成ヘルパー
# =============================================================================

def make_cur(base_qty: float | None, base_date: date | None,
             events: list[tuple[date, float]]):
    """psycopg cursor のモック。
    `_simulate_material_balance` は 2 回 execute する:
      1. base_qty + base_date を SELECT → fetchone
      2. WITH 句で日付ごとのネット変動を SELECT → fetchall
    どちらの execute も同じ cur インスタンスに当たる前提で、
    fetchone / fetchall の戻り値を順に並べる。
    """
    cur = MagicMock()
    cur.execute = AsyncMock()
    cur.fetchone = AsyncMock(return_value={
        "base_qty":  Decimal(str(base_qty)) if base_qty is not None else None,
        "base_date": base_date,
    })
    cur.fetchall = AsyncMock(return_value=[
        {"d": d, "net": Decimal(str(q))} for d, q in events
    ])
    return cur


# =============================================================================
# 基本ケース
# =============================================================================

class TestBasicSimulation:
    """棚卸あり + シンプルな入出庫"""

    @pytest.mark.asyncio
    async def test_safe_path_returns_none(self):
        """基準在庫 100 + 当日 +50 + 翌日 -30 → 残量はずっと正 → 安全"""
        cur = make_cur(
            base_qty=100, base_date=date(2026, 5, 1),
            events=[
                (date(2026, 5, 10), 50),    # +50 → 150
                (date(2026, 5, 11), -30),   # -30 → 120
            ],
        )
        result = await _simulate_material_balance(
            cur, material_id=1, exclude_movement_id=None, new_event=None)
        assert result is None

    @pytest.mark.asyncio
    async def test_negative_at_some_day_returns_first_offender(self):
        """途中でマイナスになる → 最初に負になる (日付, 残量) を返す"""
        cur = make_cur(
            base_qty=10, base_date=date(2026, 5, 1),
            events=[
                (date(2026, 5, 10), -5),   # 10 - 5 = 5
                (date(2026, 5, 11), -20),  # 5 - 20 = -15 ← ここで負
                (date(2026, 5, 12), -1),   # さらに -1 だが最初の発生日が報告される
            ],
        )
        result = await _simulate_material_balance(
            cur, material_id=1, exclude_movement_id=None, new_event=None)
        assert result is not None
        bad_date, bad_balance = result
        assert bad_date == date(2026, 5, 11)
        assert bad_balance == Decimal('-15')

    @pytest.mark.asyncio
    async def test_zero_balance_is_safe(self):
        """残量ちょうど 0 は許容 (在庫切れだが負ではない)"""
        cur = make_cur(
            base_qty=10, base_date=date(2026, 5, 1),
            events=[(date(2026, 5, 10), -10)],   # 10 - 10 = 0 OK
        )
        result = await _simulate_material_balance(
            cur, material_id=1, exclude_movement_id=None, new_event=None)
        assert result is None


# =============================================================================
# 編集/削除提案を注入したケース (new_event 引数)
# =============================================================================

class TestProposedChange:
    """new_event で提案変更を加えた時の挙動"""

    @pytest.mark.asyncio
    async def test_new_event_adds_to_same_day(self):
        """既存イベント (+30) と同日に新規 +20 を注入 → 50 として加算される"""
        cur = make_cur(
            base_qty=0, base_date=date(2026, 5, 1),
            events=[(date(2026, 5, 10), 30)],
        )
        # 新規 +20 を同日に注入 → 0 + 50 = 50, OK
        result = await _simulate_material_balance(
            cur, material_id=1,
            exclude_movement_id=None,
            new_event=(date(2026, 5, 10), Decimal('20')),
        )
        assert result is None

    @pytest.mark.asyncio
    async def test_new_event_pushes_into_negative(self):
        """新規 -200 を加えると -170 で負 → 検出"""
        cur = make_cur(
            base_qty=0, base_date=date(2026, 5, 1),
            events=[(date(2026, 5, 10), 30)],
        )
        result = await _simulate_material_balance(
            cur, material_id=1,
            exclude_movement_id=None,
            new_event=(date(2026, 5, 10), Decimal('-200')),
        )
        assert result is not None
        assert result[0] == date(2026, 5, 10)
        assert result[1] == Decimal('-170')

    @pytest.mark.asyncio
    async def test_new_event_before_base_date_is_ignored(self):
        """起点日より前の new_event は無視される (base_qty に折込済前提)"""
        cur = make_cur(
            base_qty=100, base_date=date(2026, 5, 1),
            events=[],
        )
        # 起点(5/1)より前の 4/15 に -200 を入れても残量は base_qty=100 のまま
        result = await _simulate_material_balance(
            cur, material_id=1,
            exclude_movement_id=None,
            new_event=(date(2026, 4, 15), Decimal('-200')),
        )
        assert result is None

    @pytest.mark.asyncio
    async def test_delete_simulation_no_event_injected(self):
        """new_event=None は「削除」を意味する。
        該当 movement は SQL レベルで exclude_movement_id によって除外されるが、
        ここではモックなので events に最初から含まないことで再現。"""
        cur = make_cur(
            base_qty=10, base_date=date(2026, 5, 1),
            events=[(date(2026, 5, 10), -8)],   # 編集対象を除外した後の events
        )
        result = await _simulate_material_balance(
            cur, material_id=1,
            exclude_movement_id=42,
            new_event=None,
        )
        assert result is None


# =============================================================================
# 未棚卸資材 (base_date が NULL のケース)
# =============================================================================

class TestUnstocktakenMaterial:
    """棚卸を一度もしていない資材では base_date が NULL → epoch で代用"""

    @pytest.mark.asyncio
    async def test_null_base_date_uses_epoch_no_crash(self):
        """過去に修正済の TypeError バグの回帰テスト。
        base_date=None でも例外を投げずに動作することを確認。"""
        cur = make_cur(
            base_qty=0, base_date=None,
            events=[(date(2026, 5, 13), 3000)],
        )
        # new_event を渡しても比較 (new_date > base_date) で落ちないことを確認
        result = await _simulate_material_balance(
            cur, material_id=223,
            exclude_movement_id=None,
            new_event=(date(2026, 5, 13), Decimal('3000')),
        )
        # 0 + 3000 + 3000 = 6000 (events と new_event 両方加算) → 安全
        assert result is None

    @pytest.mark.asyncio
    async def test_unstocktaken_negative_simulation(self):
        """未棚卸資材でもマイナス検出は正しく動く"""
        cur = make_cur(
            base_qty=0, base_date=None,
            events=[
                (date(2026, 5, 1), 100),
                (date(2026, 5, 5), -200),   # 100 - 200 = -100
            ],
        )
        result = await _simulate_material_balance(
            cur, material_id=1, exclude_movement_id=None, new_event=None)
        assert result is not None
        assert result[0] == date(2026, 5, 5)
        assert result[1] == Decimal('-100')


# =============================================================================
# 境界: material が存在しない
# =============================================================================

class TestMaterialNotFound:
    @pytest.mark.asyncio
    async def test_returns_none_when_material_missing(self):
        """material_stock VIEW に行が無い (= material が存在しない or filtered) → None"""
        cur = MagicMock()
        cur.execute  = AsyncMock()
        cur.fetchone = AsyncMock(return_value=None)
        cur.fetchall = AsyncMock(return_value=[])

        result = await _simulate_material_balance(
            cur, material_id=99999, exclude_movement_id=None, new_event=None)
        assert result is None
