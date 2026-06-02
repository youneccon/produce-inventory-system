"""
tests/test_substitution_yield.py
=================================
振替ロジック の 端数計算 (_calc_raw_needed) の 単体テスト。

ルール:
  ・必要 raw kg = remaining_product / yield
  ・割り切れる時 (= raw × yield が remaining と一致) は そのまま
  ・割り切れない時 は 切上 (= VBA の -Int(-raw) 相当)
  ・0.001 kg 単位 で 計算
"""
from __future__ import annotations

from decimal import Decimal
import pytest

from api.services.substitution import _calc_raw_needed


class TestCalcRawNeeded:
    def test_exact_divisible(self):
        # 95 / 0.95 = 100.0 — 商品100kg を 95% yield で 作るには 100kg の raw 必要
        # 100 * 0.95 = 95 (戻る) → 切捨 OK
        assert _calc_raw_needed(Decimal('95'), Decimal('0.95')) == Decimal('100.000')

    def test_yield_1_0(self):
        # yield=1.0 → raw=product (1:1)
        assert _calc_raw_needed(Decimal('100'), Decimal('1.0')) == Decimal('100.000')
        assert _calc_raw_needed(Decimal('33.5'), Decimal('1.0')) == Decimal('33.500')

    def test_non_divisible_ceiling(self):
        # 100 / 0.95 = 105.263... → 切上 → 105.264
        # 105.264 * 0.95 = 100.0008 > 100 ✓ 充足
        result = _calc_raw_needed(Decimal('100'), Decimal('0.95'))
        assert result == Decimal('105.264')
        # 充足確認: result × yield >= remaining
        assert result * Decimal('0.95') >= Decimal('100')

    def test_low_yield(self):
        # 100 / 0.8 = 125.0 (割り切れる) → 125.000
        assert _calc_raw_needed(Decimal('100'), Decimal('0.8')) == Decimal('125.000')
        # 100 / 0.84 = 119.047... → 切上 → 119.048
        result = _calc_raw_needed(Decimal('100'), Decimal('0.84'))
        assert result == Decimal('119.048')
        assert result * Decimal('0.84') >= Decimal('100')

    def test_small_remaining(self):
        # 1 / 0.95 = 1.052... → 1.053
        result = _calc_raw_needed(Decimal('1'), Decimal('0.95'))
        assert result == Decimal('1.053')

    def test_fractional_remaining(self):
        # 33.5 / 0.95 = 35.263... → 切上 35.264
        result = _calc_raw_needed(Decimal('33.5'), Decimal('0.95'))
        assert result == Decimal('35.264')

    def test_invalid_yield(self):
        with pytest.raises(ValueError):
            _calc_raw_needed(Decimal('100'), Decimal('0'))
        with pytest.raises(ValueError):
            _calc_raw_needed(Decimal('100'), Decimal('-0.5'))

    def test_vba_compat_known_examples(self):
        """
        VBA 設定 シート の 実例:
          R8 AM:    yield=0.95 (元 "0,95" を 正規化)
          R10 AS:   yield=0.95
          R11 徳用: yield=0.94
          R13 加工品: yield=0.84
          R15 秋田加工品: yield=0.8
        """
        # 50 kg 商品 で 各 yield の 必要 raw
        assert _calc_raw_needed(Decimal('50'), Decimal('0.95')).quantize(Decimal('0.001')) == Decimal('52.632')
        assert _calc_raw_needed(Decimal('50'), Decimal('0.94')).quantize(Decimal('0.001')) == Decimal('53.192')
        assert _calc_raw_needed(Decimal('50'), Decimal('0.84')).quantize(Decimal('0.001')) == Decimal('59.524')
        assert _calc_raw_needed(Decimal('50'), Decimal('0.8')).quantize(Decimal('0.001')) == Decimal('62.500')
