// API クライアント。X-Device-Token を自動付与し、エラーを整形する。

const TOKEN_KEY = 'inventory_device_token'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

export class ApiError extends Error {
  status: number
  detail: unknown
  constructor(status: number, detail: unknown) {
    super(typeof detail === 'string' ? detail : `APIエラー (${status})`)
    this.status = status
    this.detail = detail
  }
}

interface RequestOptions {
  method?: string
  body?: unknown
  // クエリパラメータ
  params?: Record<string, string | number | boolean | undefined | null>
}

function buildUrl(path: string, params?: RequestOptions['params']): string {
  let url = '/api' + path
  if (params) {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') qs.append(k, String(v))
    }
    const s = qs.toString()
    if (s) url += '?' + s
  }
  return url
}

function buildHeaders(body?: unknown): Record<string, string> {
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers['X-Device-Token'] = token
  // FormData の 時は Content-Type を 付与しない (ブラウザが boundary 付き で 自動設定)
  if (body !== undefined && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json'
  }
  return headers
}

function encodeBody(body: unknown): BodyInit | undefined {
  if (body === undefined) return undefined
  if (body instanceof FormData) return body
  return JSON.stringify(body)
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, params } = opts

  const resp = await fetch(buildUrl(path, params), {
    method,
    headers: buildHeaders(body),
    body: encodeBody(body),
  })

  if (resp.status === 204) return undefined as T

  let data: unknown = null
  const text = await resp.text()
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }

  if (!resp.ok) {
    const detail =
      data && typeof data === 'object' && 'detail' in data
        ? (data as { detail: unknown }).detail
        : data
    throw new ApiError(resp.status, detail)
  }
  return data as T
}

/**
 * ファイルダウンロード等の バイナリ応答 用。 Blob を 返す。
 * 認証ヘッダは 自動付与、 エラー時は ApiError を throw。
 */
async function requestBlob(
  path: string,
  opts: RequestOptions = {},
): Promise<Blob> {
  const { method = 'GET', body, params } = opts
  const resp = await fetch(buildUrl(path, params), {
    method,
    headers: buildHeaders(body),
    body: encodeBody(body),
  })
  if (!resp.ok) {
    let detail: unknown = null
    try { detail = await resp.text() } catch { /* ignore */ }
    throw new ApiError(resp.status, detail)
  }
  return await resp.blob()
}

/**
 * バイナリ応答 + Content-Disposition の filename 取得 を セット で 返す。
 * 「サーバー が 付ける filename を 使いたい」 ダウンロード用。
 */
async function requestBlobWithFilename(
  path: string,
  opts: RequestOptions = {},
): Promise<{ blob: Blob; filename: string | null }> {
  const { method = 'GET', body, params } = opts
  const resp = await fetch(buildUrl(path, params), {
    method,
    headers: buildHeaders(body),
    body: encodeBody(body),
  })
  if (!resp.ok) {
    let detail: unknown = null
    try { detail = await resp.text() } catch { /* ignore */ }
    throw new ApiError(resp.status, detail)
  }
  const cd = resp.headers.get('Content-Disposition') || ''
  const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)
  const filename = m ? decodeURIComponent(m[1]) : null
  return { blob: await resp.blob(), filename }
}

/**
 * ブラウザ で ファイル を ダウンロード させる ヘルパー。
 * 内部で a タグ を 作って クリック、 URL.revokeObjectURL を 自動で やる。
 * fallback filename は サーバー の Content-Disposition が 無いとき に 使う。
 */
async function downloadFile(
  path: string,
  fallbackFilename: string,
  opts: RequestOptions = {},
): Promise<void> {
  const { blob, filename } = await requestBlobWithFilename(path, opts)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename ?? fallbackFilename
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    URL.revokeObjectURL(url)
    a.remove()
  }, 200)
}

export const api = {
  get: <T>(path: string, params?: RequestOptions['params']) =>
    request<T>(path, { method: 'GET', params }),
  post: <T>(path: string, body?: unknown, params?: RequestOptions['params']) =>
    request<T>(path, { method: 'POST', body, params }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'DELETE', body }),
  /** FormData アップロード (multipart) — body に FormData を 渡すだけ */
  upload: <T>(path: string, formData: FormData, params?: RequestOptions['params']) =>
    request<T>(path, { method: 'POST', body: formData, params }),
  /** バイナリ応答 を Blob で 受ける (Excel ダウンロード 等) */
  blob: (path: string, params?: RequestOptions['params']) =>
    requestBlob(path, { method: 'GET', params }),
  /** POST + Blob 応答 (FormData アップロードして Excel 受取 など) */
  postBlob: (path: string, body?: unknown, params?: RequestOptions['params']) =>
    requestBlob(path, { method: 'POST', body, params }),
  /** POST + Blob 応答 + ヘッダ も 取得 (X-Sync-Result 等 メタヘッダ を 含む 場合) */
  postBlobWithHeaders: async (path: string, body?: unknown):
    Promise<{ blob: Blob; headers: Headers }> => {
    const resp = await fetch(buildUrl(path), {
      method: 'POST',
      headers: buildHeaders(body),
      body: encodeBody(body),
    })
    if (!resp.ok) {
      let detail: unknown = null
      try { detail = await resp.text() } catch { /* ignore */ }
      throw new ApiError(resp.status, detail)
    }
    return { blob: await resp.blob(), headers: resp.headers }
  },
  /** Content-Disposition の filename を 自動採用 して ブラウザ で ダウンロード */
  download: (path: string, fallbackFilename: string, params?: RequestOptions['params']) =>
    downloadFile(path, fallbackFilename, { method: 'GET', params }),
}
