"""
api/audit.py
============
監査ログ記録の共有ユーティリティ（仕様書4.2「Immutable Log」）。

main.py / routers/outbound.py / routers/auth.py から使うため、循環インポートを
避けてここに切り出している。操作主体（actor）は認証済みユーザー（api/auth.py の
get_current_user）から渡す。

設計方針:
- 監査ログは best-effort。業務トランザクションを巻き込んで失敗させない。
- 同一接続のトランザクション内で呼ばれるため、SAVEPOINT で隔離して
  audit INSERT が失敗した場合はその SAVEPOINT のみロールバックし、
  業務 INSERT/UPDATE は生かす。
- 失敗時は WARN ログに残し、処理続行。監査ログ欠落より業務継続を優先。
"""

from __future__ import annotations

import json
import logging
from typing import Any

import psycopg
from fastapi import Request

logger = logging.getLogger(__name__)


async def write_audit(
    db: psycopg.AsyncConnection,
    event_type: str,
    table_name: str | None,
    record_id: str | None,
    payload: dict,
    actor_id: Any,
    request: Request,
) -> None:
    """audit_log に1件記録する（仕様書4.2）。

    失敗してもRaiseしない (best-effort)。SAVEPOINT で隔離して
    業務トランザクションを巻き込まない。
    """
    try:
        async with db.transaction(savepoint_name="audit"):
            async with db.cursor() as cur:
                await cur.execute(
                    """
                    INSERT INTO audit_log
                        (event_type, table_name, record_id, payload, actor_id, ip_address)
                    VALUES (%s, %s, %s, %s::jsonb, %s, %s::inet)
                    """,
                    (
                        event_type,
                        table_name,
                        record_id,
                        json.dumps(payload, default=str),
                        actor_id,
                        request.client.host if request.client else None,
                    ),
                )
    except Exception as e:
        # 監査ログ欠落 < 業務処理中断 — WARN で残して継続
        logger.warning(
            "audit_log 書込失敗 (continuing): event_type=%s table=%s record_id=%s error=%s",
            event_type, table_name, record_id, e,
        )
