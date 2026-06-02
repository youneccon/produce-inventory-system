"""
api/routers/client_logs.py
==========================
フロントエンド (ブラウザ / iPad / スマホ) から 送られる エラー / デバッグ ログ
を サーバー DB (client_logs テーブル、 migration 078) に 集約 する。

エンドポイント:
  POST /client-log         - ログ 1 件 または batch を 送信 (user 認証 必須)
  GET  /client-logs        - 直近 ログ 取得 (admin のみ)
  GET  /client-logs/{uid}  - 特定 user の 直近 ログ (admin のみ)

設計:
- rate limit: per-user 60 events/min。 超過 分 は silently drop (HTTP 200 で 黙殺)
  → フロント が 暴走 して も サーバー DDoS に なら ない
- batch 受付: 1 リクエスト で 最大 20 件 まとめて 受け取り (network 効率)
- データ 保持: 7 日 想定 (cron で 削除、 別途 設定)
"""

from __future__ import annotations

import json
import time
from typing import Any
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from api.auth import AdminUser, CurrentUser
from api.dependencies import DB

router = APIRouter(prefix="/client-log", tags=["クライアントログ"])
admin_router = APIRouter(prefix="/client-logs", tags=["クライアントログ管理"])


# ===========================================================================
# Rate limit (in-memory, per-process)
# ===========================================================================
# 単一 プロセス 想定 (uvicorn worker 1)。 worker 複数 だと per-worker に なる が、
# DDoS 防護 が 目的 なので 緩い 制限 で OK。
_RATE_WINDOW_SEC = 60
_RATE_MAX_EVENTS = 60
_rate_buckets: dict[str, list[float]] = {}


def _check_rate(user_id: str) -> bool:
    """True を 返したら 受付。 False なら drop (rate limit 超過)。"""
    now = time.time()
    bucket = _rate_buckets.setdefault(user_id, [])
    # 古い エントリ を 削除
    cutoff = now - _RATE_WINDOW_SEC
    bucket[:] = [t for t in bucket if t > cutoff]
    if len(bucket) >= _RATE_MAX_EVENTS:
        return False
    bucket.append(now)
    return True


# ===========================================================================
# Schemas
# ===========================================================================

class LogEntry(BaseModel):
    """1 件 の クライアント ログ。"""
    level:   str          = Field(..., pattern="^(error|warn|info|debug|trace)$")
    message: str          = Field(..., max_length=4000)
    url:     str | None   = Field(None, max_length=2000)
    stack:   str | None   = Field(None, max_length=8000)
    ctx:     dict[str, Any] | None = None


class LogBatchRequest(BaseModel):
    """1 リクエスト = 最大 20 件 の batch。"""
    entries: list[LogEntry] = Field(..., max_length=20)


class LogRow(BaseModel):
    """admin 取得 用 の 表示 行。"""
    id:          int
    user_id:     UUID | None
    ua:          str | None
    url:         str | None
    level:       str
    message:     str
    stack:       str | None
    ctx:         dict[str, Any] | None
    ip:          str | None
    occurred_at: str


# ===========================================================================
# POST /client-log - フロント から ログ を 受け取る
# ===========================================================================

@router.post("")
async def post_client_log(
    body:    LogBatchRequest,
    user:    CurrentUser,
    request: Request,
    conn:    DB,
) -> Response:
    """クライアント ログ を 受信 して DB に INSERT。
    rate limit 超過 時 も 204 を 返す (フロント に エラー を 知らせて も 何 も できない)。
    FastAPI の 制約 で status_code=204 デコレータ は body 不可 と なる ため、
    明示 的 に Response(status_code=204) を 返す。
    """
    if not _check_rate(str(user["id"])):
        return Response(status_code=204)  # silent drop

    ua = request.headers.get("user-agent", "")
    # Tailscale / 直接 LAN の どちら でも 動く よう に X-Forwarded-For を 優先
    ip = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    if not ip and request.client:
        ip = request.client.host

    async with conn.transaction():
        for e in body.entries:
            await conn.execute("""
                INSERT INTO client_logs
                  (user_id, ua, url, level, message, stack, ctx, ip)
                VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb, %s)
            """, (
                user["id"], ua, e.url, e.level, e.message, e.stack,
                json.dumps(e.ctx) if e.ctx is not None else None,
                ip or None,
            ))
    return Response(status_code=204)


# ===========================================================================
# GET /client-logs - admin が 直近 ログ を 一覧
# ===========================================================================

@admin_router.get("", response_model=list[LogRow])
async def list_client_logs(
    _admin:  AdminUser,
    conn:    DB,
    limit:   int = 200,
    level:   str | None = None,
    user_id: UUID | None = None,
) -> list[LogRow]:
    """直近 N 件 の client_logs を 取得。 level / user_id で 絞り込み 可。"""
    limit = max(1, min(limit, 1000))
    where = []
    params: list[Any] = []
    if level:
        where.append("level = %s")
        params.append(level)
    if user_id:
        where.append("user_id = %s")
        params.append(user_id)
    sql = """
        SELECT id, user_id, ua, url, level, message, stack, ctx, ip,
               to_char(occurred_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS occurred_at
        FROM client_logs
    """
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY occurred_at DESC LIMIT %s"
    params.append(limit)

    cur = await conn.execute(sql, tuple(params))
    return [LogRow(**r) for r in await cur.fetchall()]


@admin_router.delete("")
async def purge_old_logs(
    _admin:    AdminUser,
    conn:      DB,
    older_than_days: int = 7,
) -> Response:
    """N 日 より 古い ログ を 削除 (容量 抑制 用、 手動 or cron 起動)。"""
    if older_than_days < 1:
        raise HTTPException(status_code=400, detail="older_than_days は 1 以上")
    async with conn.transaction():
        await conn.execute("""
            DELETE FROM client_logs
            WHERE occurred_at < now() - (%s || ' days')::interval
        """, (older_than_days,))
    return Response(status_code=204)
