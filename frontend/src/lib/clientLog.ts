/**
 * clientLog — フロント の エラー / 重要 操作 trace を サーバー (POST /client-log)
 * に 送信 する 仕組み。
 *
 * 設計:
 *   - キュー に 溜めて debounce 1s で batch 送信 (network 効率 + 暴走 防止)
 *   - キュー max 200 件 (それ 以上 は 古い もの から drop)
 *   - 1 batch max 20 件 (サーバー rate と 揃える)
 *   - 未認証 中 は サーバー が 401 を 返す ので 黙って drop (リトライ しない)
 *   - URL に ?debug=pan が あれば StorageCanvas が pan event を trace log として 送る
 *
 * 使い方:
 *   import { initClientLog, logError, logTrace, isDebugMode } from './lib/clientLog'
 *
 *   initClientLog()       // main.tsx で 1 回
 *   logError('foo failed', err)
 *   logTrace('pan-down', { x, y, ... })
 *   if (isDebugMode('pan')) { ... 詳細 trace を 仕込む ... }
 */

type Level = 'error' | 'warn' | 'info' | 'debug' | 'trace'

interface LogEntry {
  level:   Level
  message: string
  url?:    string
  stack?:  string
  ctx?:    Record<string, unknown>
}

const QUEUE_MAX = 200
const BATCH_MAX = 20
const FLUSH_DELAY_MS = 1000

const queue: LogEntry[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
let inFlight = false

function scheduleFlush(): void {
  if (flushTimer != null) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flush()
  }, FLUSH_DELAY_MS)
}

async function flush(): Promise<void> {
  if (inFlight || queue.length === 0) return
  inFlight = true
  try {
    while (queue.length > 0) {
      const batch = queue.splice(0, BATCH_MAX)
      try {
        // api.post は エラー で throw する ため fetch を 直接 使い、 失敗 を 黙殺
        const token = localStorage.getItem('inventory_device_token')
        await fetch('/api/client-log', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'X-Device-Token': token } : {}),
          },
          body: JSON.stringify({ entries: batch }),
          // keepalive で ページ 離脱 時 も 送信 完了 を 待つ
          keepalive: true,
        })
      } catch {
        // ネットワーク 失敗 は 黙殺 (再 キュー しない、 暴走 防止)
      }
    }
  } finally {
    inFlight = false
  }
}

function enqueue(entry: LogEntry): void {
  // url が なければ 現在 ページ を 埋める
  if (entry.url == null) entry.url = window.location.href
  queue.push(entry)
  if (queue.length > QUEUE_MAX) queue.splice(0, queue.length - QUEUE_MAX)
  scheduleFlush()
}

export function logError(message: string, err?: unknown, ctx?: Record<string, unknown>): void {
  let stack: string | undefined
  if (err instanceof Error) stack = err.stack
  enqueue({ level: 'error', message, stack, ctx })
}

export function logWarn(message: string, ctx?: Record<string, unknown>): void {
  enqueue({ level: 'warn', message, ctx })
}

export function logInfo(message: string, ctx?: Record<string, unknown>): void {
  enqueue({ level: 'info', message, ctx })
}

export function logTrace(message: string, ctx?: Record<string, unknown>): void {
  enqueue({ level: 'trace', message, ctx })
}

/** URL ?debug=<name> が 含まれて いる か (例: ?debug=pan) */
export function isDebugMode(name: string): boolean {
  if (typeof window === 'undefined') return false
  const sp = new URLSearchParams(window.location.search)
  return sp.get('debug') === name
}

let initialized = false
export function initClientLog(): void {
  if (initialized) return
  initialized = true

  // ページ 離脱 時 に 残り を 送信 (best-effort、 keepalive で 飛ばす)
  window.addEventListener('beforeunload', () => { void flush() })
  // visibility が hidden に なった 時 (モバイル で 重要)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flush()
  })

  // 未捕捉 エラー
  window.addEventListener('error', (ev) => {
    enqueue({
      level: 'error',
      message: ev.message || 'window.error',
      stack: ev.error instanceof Error ? ev.error.stack : undefined,
      ctx: {
        filename: ev.filename, lineno: ev.lineno, colno: ev.colno,
      },
    })
  })
  // Promise 未捕捉
  window.addEventListener('unhandledrejection', (ev) => {
    const reason = ev.reason
    enqueue({
      level: 'error',
      message: reason instanceof Error
        ? `unhandledrejection: ${reason.message}`
        : `unhandledrejection: ${String(reason)}`,
      stack: reason instanceof Error ? reason.stack : undefined,
    })
  })

  // debug mode 起動 ログ (起動時 確認 用)
  const debugName = new URLSearchParams(window.location.search).get('debug')
  if (debugName) {
    logInfo(`debug mode active: ${debugName}`, {
      ua: navigator.userAgent,
      platform: navigator.platform,
      touchPoints: navigator.maxTouchPoints,
      screen: { w: window.screen.width, h: window.screen.height },
    })
  }
}
