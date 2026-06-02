"""
api/services/grade_label.py
============================
規格 (spec_type, grade_level, size_label) を Excel 出庫レポート 互換 の
短い ラベル に 整形する。

VBA 元の レポート と 一致させる ため、 spec ごと に 表示パターン が 違う:
  ・標準 系 (A2L, BL, AS 等)        : 「標準」 prefix を 省く → "A2L"
  ・徳用                              : grade=A は 表示しない → "徳用"
  ・加工品 (size=ほぐし)              : サブ規格 のみ → "ほぐし"
  ・加工品 (size=-)                   : "加工品"
  ・泥                                : prefix=泥 + size → "泥L", "泥M以上"
  ・泥 + grade=加工品                 : "泥加工品"
  ・(生)泥                            : prefix=生泥 + size → "生泥M以上", "生泥コミ"
                                      (旧 Excel VBA は コミ だけ 「生(泥ごみ)」 と
                                       hiragana 化 して いた が、 DB 表記 と 不一致
                                       で 混乱 を 招く ため 2026-05-28 に 統一)
  ・黒バラ / 1P                       : spec そのまま
"""
from __future__ import annotations


def compact_grade_label_opt(spec: str | None, grade: str | None, size: str | None) -> str | None:
    """spec が None ならば None を返す。それ以外は compact_grade_label と同じ。
    DB 由来の LEFT JOIN で grade が無いケースを扱うため。"""
    if spec is None:
        return None
    return compact_grade_label(spec, grade, size)


def compact_grade_label(spec: str | None, grade: str | None, size: str | None) -> str:
    """Excel 出庫レポート 互換 の 短ラベル を 生成。"""
    s = (spec or '').strip()
    g = (grade or '').strip()
    sz = (size or '').strip()
    g_clean = '' if g in ('', '-') else g
    sz_clean = '' if sz in ('', '-') else sz

    if not s:
        return f'{g_clean}{sz_clean}'.strip() or '?'

    # ─── 標準 ─── grade + size の 連結 (例: "A2L", "BL", "S")
    if s == '標準':
        joined = f'{g_clean}{sz_clean}'
        return joined or s

    # ─── 徳用 ─── grade/size 無視
    if s == '徳用':
        return '徳用'

    # ─── 加工品 ─── 「ほぐし」 サブ規格 は サブ名 だけ
    if s == '加工品':
        if sz_clean == 'ほぐし':
            return 'ほぐし'
        if not g_clean and not sz_clean:
            return '加工品'
        return f'{s}{g_clean}{sz_clean}'

    # ─── 泥 ─── grade=加工品 で「泥加工品」、 それ以外は「泥」+size
    if s == '泥':
        if g_clean == '加工品':
            return '泥加工品'
        return f'{s}{sz_clean}'

    # ─── (生)泥 ─── prefix=生泥 + grade/size (DB 表記 と 一致、 2026-05-28)
    # 旧 「生(泥ごみ)」 (hiragana ごみ) は VBA Excel 原文 由来 だが DB の
    # katakana 「コミ」 と 不一致 で 表記揺れ 混乱 を 招いた ため 廃止。
    # 「泥」 と 同様 grade='加工品' は 「生泥加工品」 で size を 出さ ない。
    if s == '(生)泥':
        if g_clean == '加工品':
            return '生泥加工品'
        return f'生{s[3:]}{sz_clean}'  # 例: 生泥コミ, 生泥M以上

    # ─── 黒バラ / 1P / その他 ───
    return f'{s}{g_clean}{sz_clean}'
