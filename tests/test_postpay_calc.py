"""
tests/test_postpay_calc.py
===========================
api/main.py の _next_month_end() の 単体テスト。

仕様:
  ・後払日 デフォルト = 入荷日 の 翌月末日
  ・5/2 入荷 → 6/30
  ・12/5 入荷 → 翌年 1/31 (年跨ぎ)
  ・うるう年 1月入荷 → 2/29 (1月→2月)

importは api.main から直接行う。
"""
from __future__ import annotations

from datetime import date
import pytest

from api.main import _next_month_end


class TestNextMonthEnd:
    """通常 月→翌月末"""

    def test_may_to_june(self):
        # 5/2 → 6/30
        assert _next_month_end(date(2026, 5, 2)) == date(2026, 6, 30)

    def test_may_late_to_june(self):
        # 5/31 → 6/30
        assert _next_month_end(date(2026, 5, 31)) == date(2026, 6, 30)

    def test_february_to_march(self):
        # 2月入荷 → 3/31
        assert _next_month_end(date(2026, 2, 15)) == date(2026, 3, 31)

    def test_january_to_february_non_leap(self):
        # 1月入荷 (非うるう年) → 2/28
        assert _next_month_end(date(2026, 1, 10)) == date(2026, 2, 28)

    def test_january_to_february_leap(self):
        # 1月入荷 (うるう年 2024) → 2/29
        assert _next_month_end(date(2024, 1, 10)) == date(2024, 2, 29)


class TestYearBoundary:
    """12月 → 翌年 1月末"""

    def test_december_to_january(self):
        # 12/5 → 翌年 1/31
        assert _next_month_end(date(2025, 12, 5)) == date(2026, 1, 31)

    def test_december_last_day(self):
        # 12/31 → 翌年 1/31
        assert _next_month_end(date(2025, 12, 31)) == date(2026, 1, 31)


class TestMonthLengthVariants:
    """各月の末日が 正しく 取得される か"""

    @pytest.mark.parametrize("month, expected_day", [
        (1, 28),   # 1月 → 2月末 (2026 非うるう)
        (2, 31),   # 2月 → 3月末
        (3, 30),   # 3月 → 4月末
        (4, 31),   # 4月 → 5月末
        (5, 30),   # 5月 → 6月末
        (6, 31),   # 6月 → 7月末
        (7, 31),   # 7月 → 8月末
        (8, 30),   # 8月 → 9月末
        (9, 31),   # 9月 → 10月末
        (10, 30),  # 10月 → 11月末
        (11, 31),  # 11月 → 12月末
    ])
    def test_each_month_yields_correct_end_day(self, month: int, expected_day: int):
        result = _next_month_end(date(2026, month, 15))
        assert result.day == expected_day
