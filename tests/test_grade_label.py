"""
tests/test_grade_label.py
==========================
api/services/grade_label.py の 単体テスト。

compact_grade_label() の 出力は Excel 出庫レポート と 完全一致 する必要が
あるため、 ユーザー が 申告 した 具体例 を そのまま 検証 する。

spec ごと の 分岐:
  ・標準              → grade+size を 連結 (例: A2L, BL, S)
  ・徳用              → "徳用" 固定 (A, S 等の grade は 落とす)
  ・加工品 ほぐし     → "ほぐし"
  ・加工品 (size=-)   → "加工品"
  ・泥 + size         → "泥L", "泥M以上"
  ・泥 + 加工品       → "泥加工品"
  ・(生)泥 + コミ     → "生泥コミ" (DB 表記 と 一致、 2026-05-28 統一)
  ・黒バラ / 1P / 他  → spec をそのまま含める
"""
from __future__ import annotations

import pytest

from api.services.grade_label import compact_grade_label, compact_grade_label_opt


class TestStandardSpec:
    """spec=標準 — grade と size を 連結"""

    def test_a_2l(self):
        assert compact_grade_label('標準', 'A', '2L') == 'A2L'

    def test_b_l(self):
        assert compact_grade_label('標準', 'B', 'L') == 'BL'

    def test_s_alone(self):
        # grade=S, size=なし → "S"
        assert compact_grade_label('標準', 'S', '-') == 'S'

    def test_size_only(self):
        # grade 無し, size=3L → "3L"
        assert compact_grade_label('標準', '-', '3L') == '3L'

    def test_both_empty(self):
        # 標準/-/-  → "標準" 自体に fallback
        assert compact_grade_label('標準', '-', '-') == '標準'


class TestTokuyo:
    """spec=徳用 — grade/size は 無視 (Excel 互換)"""

    def test_a_grade_dropped(self):
        # ユーザー 申告 例: "徳用A" は 誤り、 ただ "徳用" が 正解
        assert compact_grade_label('徳用', 'A', '-') == '徳用'

    def test_no_grade(self):
        assert compact_grade_label('徳用', '-', '-') == '徳用'

    def test_grade_l_dropped(self):
        # grade=L でも 落とす
        assert compact_grade_label('徳用', 'L', '-') == '徳用'


class TestKakouhin:
    """spec=加工品"""

    def test_hogushi_sub(self):
        # size=ほぐし → "ほぐし" のみ (加工品 prefix を 落とす)
        assert compact_grade_label('加工品', '-', 'ほぐし') == 'ほぐし'

    def test_kakouhin_alone(self):
        # grade も size も 無し → "加工品"
        assert compact_grade_label('加工品', '-', '-') == '加工品'

    def test_with_grade(self):
        # grade あり → "加工品" + grade + size
        assert compact_grade_label('加工品', 'A', '-') == '加工品A'


class TestDoro:
    """spec=泥"""

    def test_doro_l(self):
        assert compact_grade_label('泥', '-', 'L') == '泥L'

    def test_doro_b_concat(self):
        # 泥+B → "泥B" — ただし B は size に来るパターンが多い
        assert compact_grade_label('泥', '-', 'B') == '泥B'

    def test_doro_kakouhin(self):
        # grade=加工品 → "泥加工品" (専用)
        assert compact_grade_label('泥', '加工品', '-') == '泥加工品'

    def test_doro_m_ijou(self):
        assert compact_grade_label('泥', '-', 'M以上') == '泥M以上'


class TestNamaDoro:
    """spec=(生)泥 — DB 表記 (katakana コミ) と 一致 する 「生泥コミ」 を 返す
    (旧 VBA Excel 互換 の hiragana 「生(泥ごみ)」 は 2026-05-28 廃止)"""

    def test_komi(self):
        assert compact_grade_label('(生)泥', '-', 'コミ') == '生泥コミ'

    def test_m_ijou(self):
        assert compact_grade_label('(生)泥', '-', 'M以上') == '生泥M以上'

    def test_kakouhin(self):
        assert compact_grade_label('(生)泥', '加工品', '-') == '生泥加工品'


class TestOthers:
    """spec=黒バラ / 1P / 想定外"""

    def test_kurobara(self):
        assert compact_grade_label('黒バラ', '-', '-') == '黒バラ'

    def test_1p(self):
        assert compact_grade_label('1P', '-', '-') == '1P'

    def test_unknown_spec(self):
        # 想定外 spec も spec+grade+size の 単純連結 で 落ちない
        result = compact_grade_label('未知', 'X', 'Y')
        assert '未知' in result


class TestNoneHandling:
    """None / 空文字 / ハイフン の 取扱"""

    def test_all_empty_strings(self):
        # 全部 空文字 → spec="" の fallback "?"
        result = compact_grade_label('', '', '')
        assert result == '?'

    def test_empty_spec_with_size(self):
        # spec 無し でも size があれば 出力 ("L")
        assert compact_grade_label('', '', 'L') == 'L'

    def test_hyphen_treated_as_empty(self):
        # ハイフン "-" は 空扱い
        assert compact_grade_label('標準', 'A', '-') == 'A'

    def test_whitespace_stripped(self):
        # 前後 空白 は trim される
        assert compact_grade_label('  標準  ', ' A ', ' L ') == 'AL'


class TestOptVariant:
    """compact_grade_label_opt — spec=None で None を返す"""

    def test_none_spec_returns_none(self):
        assert compact_grade_label_opt(None, 'A', 'L') is None

    def test_non_none_passes_through(self):
        assert compact_grade_label_opt('標準', 'A', 'L') == 'AL'

    def test_none_grade_size_still_ok(self):
        # spec があれば 動く
        assert compact_grade_label_opt('徳用', None, None) == '徳用'
