"""
tests/test_parser.py
====================
スマート・メモ・インプット パーサー（生姜原料向け）の単体テスト。

parse_smart_input は1行のメモから
  [仕入先][産地][規格][ケース数][kg/ケース][単価]
を推定する純粋関数。DB非依存。
"""

from __future__ import annotations

from api.main import parse_smart_input


class TestParseSmartInput:

    def test_full_line(self):
        """全項目そろったメモ。"""
        r = parse_smart_input("西川 高知産 新物 700ケース 16kg 605円")
        assert r.supplier_name == "西川"
        assert r.origin_name   == "高知産"
        assert r.spec_type     == "新物"
        assert r.cases         == 700.0
        assert r.kg_per_case   == 16.0
        assert r.unit_price    == 605.0
        assert r.confidence    == "high"

    def test_without_price(self):
        """単価なし（後追い入力前提）でも他は埋まる。"""
        r = parse_smart_input("南口商店 高知産 親生姜 150箱 16kg")
        assert r.supplier_name == "南口商店"
        assert r.origin_name   == "高知産"
        assert r.spec_type     == "親生姜"
        assert r.cases         == 150.0
        assert r.kg_per_case   == 16.0
        assert r.unit_price    is None
        assert r.confidence    == "high"

    def test_bare_numbers_assigned_to_cases_then_kg(self):
        """単位なしの裸の数字は ケース数 → kg/ケース の順に割り当てる。"""
        r = parse_smart_input("杉本 熊本産 新物 617 15")
        assert r.cases       == 617.0
        assert r.kg_per_case == 15.0

    def test_fullwidth_normalized(self):
        """全角の数字・空白・単位も NFKC 正規化で解釈できる。"""
        r = parse_smart_input("西川　高知産　新物　７００ケース　１６ｋｇ")
        assert r.supplier_name == "西川"
        assert r.cases         == 700.0
        assert r.kg_per_case   == 16.0

    def test_spec_with_parentheses(self):
        """規格『慣行（囲い）』を1トークンとして拾える。"""
        r = parse_smart_input("片山 熊本産 慣行（囲い） 567ケース 17kg")
        assert r.spec_type   == "慣行(囲い)"   # NFKCで丸括弧は半角化される
        assert r.cases       == 567.0
        assert r.kg_per_case == 17.0

    def test_kg_priority_over_bare_number(self):
        """kg明示トークンが先に kg/ケースへ、裸の数字がケース数へ。"""
        r = parse_smart_input("吉澤 熊本産 新物 15.3kg 672")
        assert r.kg_per_case == 15.3
        assert r.cases       == 672.0

    def test_partial_input_low_confidence(self):
        """情報が少ないと confidence が下がる。"""
        r = parse_smart_input("西川 新物")
        assert r.supplier_name == "西川"
        assert r.spec_type     == "新物"
        assert r.confidence    in ("low", "medium")

    def test_unparsed_tokens_warned(self):
        """解釈できない語は warnings に積む。"""
        r = parse_smart_input("西川 高知産 新物 700ケース 16kg なぞ単語")
        assert r.supplier_name == "西川"
        assert any("なぞ単語" in w for w in r.warnings)
