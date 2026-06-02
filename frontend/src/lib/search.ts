/**
 * search.ts — 検索/絞り込み用の文字列ユーティリティ。
 *
 * 仕様:
 *   - NFKC で全角英数→半角、半角カナ→全角カナ等を統一
 *   - lowercase
 *   - ダッシュ系文字 (-, ー, ｰ, −, –, —, ‐ など) を全部「-」に統一
 *   - スペース区切り (半角/全角) で複数トークンに分割
 *   - すべてのトークンが含まれていればヒット (AND 検索、順不同)
 *
 * 例:
 *   - 「c-5k」「Ｃー5Ｋ」「ｃ−5ｋ」がすべて同じ
 *   - 「生姜 100」で「中国産生姜100gピロ」がヒット
 *   - 「100 生姜」も同じくヒット (順不同)
 */

const DASH_RE = /[-－ーｰ−‐‑‒–—―⁃⁓]/g

/** 1 つの文字列を比較用に正規化 */
export function normalize(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(DASH_RE, '-')
    .replace(/\s+/g, ' ')
    .trim()
}

/** クエリをスペース区切りでトークン化 (空文字は除去) */
export function tokenize(query: string): string[] {
  if (!query) return []
  return query
    .normalize('NFKC')
    .toLowerCase()
    .replace(DASH_RE, '-')
    .split(/[\s　]+/)
    .filter(Boolean)
}

/**
 * 単一テキストに対する複数トークン AND 検索。
 * トークンが空ならすべての文字列にマッチ (= フィルタ無し相当)。
 */
export function matchesAllTokens(text: string, tokens: string[]): boolean {
  if (tokens.length === 0) return true
  const n = normalize(text)
  return tokens.every((t) => n.includes(t))
}

/**
 * 複数フィールドのいずれかにすべてのトークンが含まれているかを判定するヘルパ。
 * いずれかのフィールドに全トークンが含まれていればヒット (典型的な検索 UI)。
 *
 * 例: matchesQuery("生姜 100", [product.name, product.code, product.classification_name])
 */
export function matchesQuery(query: string, fields: (string | null | undefined)[]): boolean {
  const tokens = tokenize(query)
  if (tokens.length === 0) return true
  const joined = fields.filter(Boolean).join(' ')
  return matchesAllTokens(joined, tokens)
}
