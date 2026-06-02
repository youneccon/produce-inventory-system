import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import { errorText } from './format'

interface FetchState<T> {
  data: T | null
  loading: boolean
  error: string | null
  reload: () => void
}

/**
 * GET エンドポイントを購読する簡易フック。 path が変わると再取得する。
 * `path` が null / undefined / 空文字なら fetch を発火せず loading=false で待機。
 * 条件付き取得 (`enabled ? '/...' : null`) のパターンに対応。
 */
export function useFetch<T>(
  path: string | null | undefined,
  params?: Record<string, string | number | boolean | undefined | null>,
): FetchState<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(!!path)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  const paramsKey = JSON.stringify(params ?? {})

  const reload = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    // path が null/空ならスキップ (前回の data はそのまま残す = stale-while-disabled)
    if (!path) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    api
      .get<T>(path, params)
      .then((d) => {
        if (!cancelled) setData(d)
      })
      .catch((e) => {
        if (!cancelled) setError(errorText(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, paramsKey, tick])

  return { data, loading, error, reload }
}
