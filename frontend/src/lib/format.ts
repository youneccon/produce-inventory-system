import { ApiError } from '../api/client'

/** 数値・数値文字列を桁区切りで表示。null/undefined は '—'。 */
export function num(v: string | number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || v === '') return '—'
  const n = typeof v === 'string' ? Number(v) : v
  if (Number.isNaN(n)) return String(v)
  return n.toLocaleString('ja-JP', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  })
}

/** 円表示。 */
export function yen(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—'
  return '¥' + num(v, 0)
}

/** 日付文字列を YYYY-MM-DD に整える。 */
export function ymd(v: string | null | undefined): string {
  if (!v) return '—'
  return v.slice(0, 10)
}

/**
 * 規格表示: spec_type / grade_level / size_label を 1 つの文字列に整形。
 *
 * ルール:
 *   - spec_type = '標準' は 「規格デフォルト」 を意味するので 非表示
 *   - grade_level / size_label が '-' (= 未指定マーカー) は 非表示
 *   - 残りを連結 (delimiter なし)
 *
 * 例:
 *   formatGrade('標準', 'A', 'L')      → 'AL'
 *   formatGrade('標準', 'A', '2L')     → 'A2L'
 *   formatGrade('標準', '-', '-')      → ''       (空 — 完全に default)
 *   formatGrade('泥',   '-', 'M')      → '泥M'
 *   formatGrade('泥',   'A', '2L')     → '泥A2L'
 *   formatGrade('黒バラ', '-', '-')    → '黒バラ'
 *   formatGrade('1P',   '-', '-')      → '1P'
 *
 * @param spaces true なら空白区切り ('泥 A 2L')、 false なら密 ('泥A2L')
 * @param fallback 何も表示するものがない時に返す文字列 (default = '—')
 */
export function formatGrade(
  spec_type: string | null | undefined,
  grade_level: string | null | undefined,
  size_label: string | null | undefined,
  opts: { spaces?: boolean; fallback?: string } = {},
): string {
  const parts: string[] = []
  if (spec_type && spec_type !== '標準') parts.push(spec_type)
  if (grade_level && grade_level !== '-' && grade_level !== '') parts.push(grade_level)
  if (size_label && size_label !== '-' && size_label !== '') parts.push(size_label)
  if (parts.length === 0) return opts.fallback ?? '—'
  return parts.join(opts.spaces ? ' ' : '')
}

/**
 * 規格表示 (spec_type のみ): '標準' は空文字、それ以外はそのまま。
 * spec_type 単体カラムに使う。
 */
export function formatSpecType(spec_type: string | null | undefined,
                                fallback = '—'): string {
  if (!spec_type) return fallback
  if (spec_type === '標準') return fallback   // 標準 は非表示
  return spec_type
}

/**
 * 規格 統合 表示 (canvas / 集計表 / 紙 レポート 共通): user 合意 2026-05-24
 *
 *   - sub_spec_text あり → 「[sub_spec] [grade] [size]」 (spec_type は 置換 さ れる)
 *   - sub_spec_text なし → 「[spec] [grade] [size]」 (= 既存 formatGrade と 同等)
 *
 * 「サブ規格 が ある = 棚卸 上 で 台帳 の 規格 を 上書き したい」 と いう 意味なので、
 * spec_type は 表示 から 隠す (台帳 元データ は modal の 詳細 view で 別途 併記)。
 * 詳細追跡 が 必要 な context (modal 等) では formatGrade を 直接 呼ぶ こと。
 *
 *   formatSpecCombined('100g', '新物', 'L', null)        → '100g 新物 L'
 *   formatSpecCombined('100g', '新物', 'L', '特選 100g') → '特選 100g 新物 L'
 *   formatSpecCombined('-',    '-',   '-', null)         → '—' (fallback)
 *
 * @param sub_spec  layout 上 で 後付け された 補助 規格。 ある と 表示 が それ を 優先
 * @param opts.fallback 全 null の とき に 返す 文字列 (default = '—')
 */
export function formatSpecCombined(
  spec_type:    string | null | undefined,
  grade_level:  string | null | undefined,
  size_label:   string | null | undefined,
  sub_spec:     string | null | undefined,
  opts: { fallback?: string } = {},
): string {
  const parts: string[] = []
  const main = (sub_spec && sub_spec.trim()) ? sub_spec : spec_type
  if (main && main !== '標準') parts.push(main)
  if (grade_level && grade_level !== '-' && grade_level !== '') parts.push(grade_level)
  if (size_label && size_label !== '-' && size_label !== '') parts.push(size_label)
  if (parts.length === 0) return opts.fallback ?? '—'
  return parts.join(' ')
}

/** 日時を読みやすく。 */
export function datetime(v: string | null | undefined): string {
  if (!v) return '—'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return v
  return d.toLocaleString('ja-JP', { hour12: false })
}

/**
 * 備考 文字列 から 機械的 に 付与 された メタ プレフィックス を 剥がす。
 *
 * 対象 (recipe_survey 承認 や migration 077 が note に 追記 する もの):
 *   [提案#A#B承認: xxx]
 *   [提案#A#B承認(mig 077): xxx]
 *
 * 例:
 *   '[提案#44#251承認(mig 077): ]'       → ''
 *   '[提案#44#251承認(mig 077): あいうえお]' → 'あいうえお'
 *   'foo [提案#1#2承認: bar]'             → 'foo bar'
 *   '本物の備考'                         → '本物の備考'
 */
export function stripNoteMetaTags(note: string | null | undefined): string {
  if (!note) return ''
  const re = /\[提案#\d+#\d+承認(?:\([^)]*\))?:\s*([^\]]*)\]/g
  const cleaned = note.replace(re, (_m, inner) => String(inner ?? '').trim())
  return cleaned.replace(/\s+/g, ' ').trim()
}

/** API エラーを人間向け文字列に。 */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    const d = e.detail
    if (typeof d === 'string') return d
    if (d && typeof d === 'object') {
      const obj = d as Record<string, unknown>
      if (typeof obj.error === 'string') {
        const extra = obj.missing
          ? '：' + (obj.missing as string[]).join('、')
          : ''
        return obj.error + extra
      }
      return JSON.stringify(d)
    }
    return e.message
  }
  if (e instanceof Error) return e.message
  return String(e)
}
