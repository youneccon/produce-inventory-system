"""
tests/test_garlic_ledger_sync.py
=================================
大蒜 仕入管理台帳 同期 ([garlic_ledger_sync](api/services/garlic_ledger_sync.py))
の 純粋ヘルパー 単体テスト。

カバー範囲:
  ・正規化: _norm_key, _norm_origin, _norm_qty
  ・規格整形: _format_spec
  ・lot key 一致判定: _lot_key
  ・Excel 値 変換: _excel_date_to_date
  ・月日数: _days_in_month

このファイル の 目的 は 過去 発覚 した バグ (規格生表記揺れ / 全半角paren揺れ /
origin 「X産」 と 「X」 の 同一視 / 浮動小数点 誤差) を リグレッション 防止 する こと。

DB を 触る ロジック (sync_garlic_ledger 本体, _fetch_lots_by_sheet) は ここでは
扱わない。 統合 テスト は 別途 .xlsm fixture が 必要 で 重い ため 別ファイル。
"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

import pytest

from api.services.garlic_ledger_sync import (
    _norm_key,
    _norm_origin,
    _norm_qty,
    _format_spec,
    _lot_key,
    _excel_date_to_date,
    _days_in_month,
)


class TestNormKey:
    """NFKC + trim 正規化。 None/数値/全半角揺れ を 吸収。"""

    def test_simple(self):
        assert _norm_key("劉はんはん") == "劉はんはん"

    def test_trim(self):
        assert _norm_key("  abc  ") == "abc"

    def test_none(self):
        assert _norm_key(None) == ""

    def test_empty(self):
        assert _norm_key("") == ""

    def test_int(self):
        assert _norm_key(123) == "123"

    def test_decimal(self):
        assert _norm_key(Decimal("12.5")) == "12.5"

    def test_nfkc_fullwidth_alpha(self):
        # 全角 ABC → 半角 ABC
        assert _norm_key("ＡＢＣ") == "ABC"

    def test_nfkc_fullwidth_paren(self):
        # 全角 () → 半角 ()
        assert _norm_key("（生）泥") == "(生)泥"

    def test_nfkc_fullwidth_paren_matches_halfwidth(self):
        # 全半角 paren 揺れ → 同じ key
        assert _norm_key("（生）泥") == _norm_key("(生)泥")


class TestNormOrigin:
    """origin: 末尾「産」 を 削除。"""

    def test_simple(self):
        assert _norm_origin("青森") == "青森"

    def test_trailing_san(self):
        assert _norm_origin("青森産") == "青森"

    def test_same_after_normalize(self):
        # 'X' と 'X産' を 同一視
        assert _norm_origin("青森") == _norm_origin("青森産")

    def test_multiple_san_collapse(self):
        # 不自然 だが 「青森産産」 でも 全て 削除 される
        assert _norm_origin("青森産産") == "青森"

    def test_trailing_whitespace_then_san(self):
        # 末尾 空白 + 産 でも 削除 される
        assert _norm_origin("青森 産") == "青森"

    def test_none(self):
        assert _norm_origin(None) == ""

    def test_tako(self):
        # 田子 = 田子産 (半製品 振り分け key)
        assert _norm_origin("田子") == _norm_origin("田子産") == "田子"


class TestNormQty:
    """数量 正規化: 小数 1 桁 四捨五入 で 浮動小数点 誤差 吸収。"""

    def test_int(self):
        assert _norm_qty(100) == "100.0"

    def test_one_decimal(self):
        assert _norm_qty(100.5) == "100.5"

    def test_round_two_decimal(self):
        # 100.55 → 100.6 (Decimal の ROUND_HALF_EVEN だと 100.6)
        assert _norm_qty(100.55) in ("100.5", "100.6")  # bankers rounding 揺れ 許容

    def test_floating_point_noise(self):
        # 0.1 + 0.2 = 0.30000000000000004 → "0.3"
        assert _norm_qty(0.1 + 0.2) == "0.3"

    def test_string_numeric(self):
        assert _norm_qty("12.345") == "12.3"

    def test_none(self):
        assert _norm_qty(None) == ""

    def test_empty(self):
        assert _norm_qty("") == ""

    def test_non_numeric_string_falls_back(self):
        # 数値化失敗 → _norm_key 経由 で 文字列正規化
        assert _norm_qty("abc") == "abc"


class TestFormatSpec:
    """規格整形: '標準' と '-' を スキップ。"""

    def test_all_present(self):
        assert _format_spec("生", "A", "L") == "生AL"

    def test_skip_default_spec_type(self):
        # spec_type == '標準' → スキップ
        assert _format_spec("標準", "A", "L") == "AL"

    def test_skip_grade_dash(self):
        # grade_level == '-' → スキップ
        assert _format_spec("生", "-", "L") == "生L"

    def test_skip_size_dash(self):
        assert _format_spec("生", "A", "-") == "生A"

    def test_all_none(self):
        assert _format_spec(None, None, None) == ""

    def test_all_defaults(self):
        # 標準 + - + - → 全部 スキップ
        assert _format_spec("標準", "-", "-") == ""

    def test_partial_none(self):
        assert _format_spec("生", None, "L") == "生L"


class TestLotKey:
    """マッチング タプルキー (supplier_n, origin_n, spec_n, date_iso, qty_n)。"""

    def test_basic(self):
        k = _lot_key("劉はんはん", "青森産", "生AL", date(2026, 5, 1), Decimal("100"))
        assert k == ("劉はんはん", "青森", "生AL", "2026-05-01", "100.0")

    def test_origin_san_invariant(self):
        # '青森' と '青森産' で 同じ key
        k1 = _lot_key("S", "青森", "X", date(2026, 1, 1), 1)
        k2 = _lot_key("S", "青森産", "X", date(2026, 1, 1), 1)
        assert k1 == k2

    def test_full_halfwidth_paren_invariant(self):
        # 規格 全半角 paren 揺れ → 同じ key
        k1 = _lot_key("S", "青森", "(生)泥", date(2026, 1, 1), 1)
        k2 = _lot_key("S", "青森", "（生）泥", date(2026, 1, 1), 1)
        assert k1 == k2

    def test_quantity_float_noise_invariant(self):
        # 100 と 100.04 → 1 桁 四捨五入 で 同じ
        k1 = _lot_key("S", "青森", "X", date(2026, 1, 1), 100)
        k2 = _lot_key("S", "青森", "X", date(2026, 1, 1), Decimal("100.04"))
        assert k1 == k2

    def test_quantity_meaningful_difference(self):
        # 100 と 101 → 別 key
        k1 = _lot_key("S", "青森", "X", date(2026, 1, 1), 100)
        k2 = _lot_key("S", "青森", "X", date(2026, 1, 1), 101)
        assert k1 != k2

    def test_datetime_to_date(self):
        # datetime でも date でも 同じ iso 文字列
        k1 = _lot_key("S", "青森", "X", datetime(2026, 5, 1, 12, 0), 1)
        k2 = _lot_key("S", "青森", "X", date(2026, 5, 1), 1)
        assert k1 == k2


class TestExcelDateToDate:
    """Excel セル値 → date 変換。 None/空文字/datetime/date を 想定。"""

    def test_none(self):
        assert _excel_date_to_date(None) is None

    def test_empty(self):
        assert _excel_date_to_date("") is None

    def test_datetime(self):
        assert _excel_date_to_date(datetime(2026, 5, 1, 0, 0)) == date(2026, 5, 1)

    def test_date(self):
        assert _excel_date_to_date(date(2026, 5, 1)) == date(2026, 5, 1)

    def test_string_returns_none(self):
        # 文字列 は サポート外 → None
        assert _excel_date_to_date("2026-05-01") is None


class TestDaysInMonth:
    """月の日数。 月境界 計算 の 基礎。"""

    def test_january(self):
        assert _days_in_month("2026-01") == 31

    def test_february_non_leap(self):
        assert _days_in_month("2026-02") == 28

    def test_february_leap(self):
        # 2024 はうるう年
        assert _days_in_month("2024-02") == 29

    def test_april(self):
        assert _days_in_month("2026-04") == 30

    def test_december(self):
        # 年境界 を 跨ぐ 計算 が 正しい か
        assert _days_in_month("2026-12") == 31
