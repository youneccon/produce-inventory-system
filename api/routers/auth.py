"""
api/routers/auth.py
===================
認証・デバイス管理エンドポイント（仕様書4.1）。

  POST /auth/register                  - デバイス登録（トークン払い出し）
  GET  /auth/me                        - 現在のユーザー
  GET  /auth/devices                   - デバイス一覧（管理者）
  POST /auth/devices/{user_id}/approve - デバイス承認・権限設定（管理者）
  POST /auth/devices/{user_id}/revoke  - デバイス無効化（管理者）

ブートストラップ: device_token を持つ有効な管理者が1人も居ないとき、
最初の登録デバイスを管理者として自動承認する（初期管理者の確立）。
"""

from __future__ import annotations

import json
from typing import Any
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field

from api.audit import write_audit
from api.auth import AdminUser, CurrentUser, generate_device_token
from api.dependencies import DB

router = APIRouter(prefix="/auth", tags=["認証"])


class RegisterRequest(BaseModel):
    display_name: str = Field(..., min_length=1, max_length=100)


class RegisterResponse(BaseModel):
    user_id:      UUID
    display_name: str
    role:         str
    is_active:    bool
    device_token: str
    message:      str


class ApproveRequest(BaseModel):
    role: str = Field("operator", pattern="^(viewer|operator|admin)$")


class RoleUpdateRequest(BaseModel):
    """既存デバイスのロール変更用 (PATCH /auth/devices/{id}/role)"""
    role: str = Field(..., pattern="^(viewer|operator|admin)$")


@router.post("/register", response_model=RegisterResponse,
             status_code=status.HTTP_201_CREATED)
async def register_device(body: RegisterRequest, db: DB):
    """
    デバイスを登録し device_token を払い出す。
    通常は is_active=false（承認待ち）。初期管理者が居なければ管理者として自動承認。
    """
    token = generate_device_token()
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT 1 FROM users "
            "WHERE role='admin' AND is_active AND device_token IS NOT NULL LIMIT 1"
        )
        has_admin = await cur.fetchone() is not None
        role      = "operator" if has_admin else "admin"
        is_active = not has_admin

        await cur.execute("""
            INSERT INTO users (display_name, device_token, role, is_active)
            VALUES (%s, %s, %s, %s)
            RETURNING id, display_name, role, is_active
        """, (body.display_name.strip(), token, role, is_active))
        user = await cur.fetchone()

    return RegisterResponse(
        user_id      = user["id"],
        display_name = user["display_name"],
        role         = user["role"],
        is_active    = user["is_active"],
        device_token = token,
        message      = ("初期管理者として自動承認されました。device_token を保管してください。"
                        if not has_admin else
                        "登録しました。管理者の承認をお待ちください。"),
    )


@router.get("/me")
async def get_me(user: CurrentUser):
    """現在のデバイスに紐づくユーザー情報。"""
    return user


@router.get("/preferences")
async def get_preferences(db: DB, user: CurrentUser) -> dict[str, Any]:
    """現在のユーザーのUI設定（テーマ、ダッシュボード表示など）を返す。"""
    async with db.cursor() as cur:
        await cur.execute("SELECT preferences FROM users WHERE id=%s", (user["id"],))
        row = await cur.fetchone()
    return row["preferences"] if row else {}


@router.put("/preferences")
async def put_preferences(prefs: dict[str, Any], db: DB, user: CurrentUser) -> dict[str, Any]:
    """現在のユーザーのUI設定を丸ごと上書き保存する。"""
    async with db.cursor() as cur:
        await cur.execute(
            "UPDATE users SET preferences=%s::jsonb, updated_at=now() "
            "WHERE id=%s RETURNING preferences",
            (json.dumps(prefs), user["id"]),
        )
        row = await cur.fetchone()
    return row["preferences"]


@router.get("/devices")
async def list_devices(db: DB, admin: AdminUser):
    """登録デバイス（ユーザー）一覧（管理者のみ）。"""
    async with db.cursor() as cur:
        await cur.execute("""
            SELECT id, display_name, role, is_active, last_login_at, created_at
            FROM users
            WHERE device_token IS NOT NULL
            ORDER BY created_at
        """)
        return [dict(r) for r in await cur.fetchall()]


@router.post("/devices/{user_id}/approve")
async def approve_device(user_id: UUID, body: ApproveRequest, db: DB,
                         admin: AdminUser, request: Request):
    """デバイスを承認し権限を設定する（管理者のみ）。"""
    async with db.cursor() as cur:
        await cur.execute("""
            UPDATE users SET is_active=true, role=%s, updated_at=now()
            WHERE id=%s AND device_token IS NOT NULL
            RETURNING id, display_name, role, is_active
        """, (body.role, user_id))
        u = await cur.fetchone()
        if u is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                detail="デバイスが見つかりません")
    await write_audit(db, "DEVICE_APPROVE", "users", str(user_id),
                      {"role": body.role}, admin["id"], request)
    return dict(u)


@router.delete("/devices/{user_id}")
async def delete_device(user_id: UUID, db: DB, admin: AdminUser, request: Request):
    """
    無効化済み or 承認待ちのデバイスを片付ける（管理者のみ）。
    入庫・出庫・棚卸などの参照が無ければユーザーごと削除、参照があれば
    device_token を NULL にしてデバイス一覧から除外する（履歴は保持）。
    有効なデバイスは先に /revoke してから削除する必要がある。
    """
    if str(admin["id"]) == str(user_id):
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            detail="自分自身は削除できません")
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT id, is_active FROM users WHERE id=%s AND device_token IS NOT NULL",
            (user_id,))
        u = await cur.fetchone()
        if u is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                detail="デバイスが見つかりません")
        if u["is_active"]:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                detail="有効なデバイスは先に「無効化」してから削除してください")
        # FK 参照の有無
        await cur.execute("""
            SELECT
                (SELECT COUNT(*) FROM inbound_lots      WHERE created_by   = %s) +
                (SELECT COUNT(*) FROM outbound_records  WHERE created_by   = %s) +
                (SELECT COUNT(*) FROM stock_counts      WHERE confirmed_by = %s) +
                (SELECT COUNT(*) FROM correction_records WHERE corrected_by = %s) +
                (SELECT COUNT(*) FROM audit_log         WHERE actor_id     = %s) AS n
        """, (user_id, user_id, user_id, user_id, user_id))
        n = (await cur.fetchone())["n"]
        if n > 0:
            await cur.execute(
                "UPDATE users SET device_token=NULL, updated_at=now() WHERE id=%s",
                (user_id,))
            action = "token_cleared"
        else:
            await cur.execute("DELETE FROM users WHERE id=%s", (user_id,))
            action = "deleted"
    await write_audit(db, "DEVICE_DELETE", "users", str(user_id),
                      {"action": action, "had_refs": n}, admin["id"], request)
    return {"action": action, "removed_references": n}


@router.patch("/devices/{user_id}/role")
async def change_device_role(user_id: UUID, body: RoleUpdateRequest, db: DB,
                             admin: AdminUser, request: Request):
    """既存デバイスのロールを変更する (管理者のみ)。
    最後の admin を viewer/operator に降格しようとすると拒否する。"""
    if str(admin["id"]) == str(user_id) and body.role != "admin":
        # 自分自身を降格すると admin が居なくなって自分でロールを戻せなくなる
        async with db.cursor() as cur:
            await cur.execute(
                "SELECT COUNT(*) AS n FROM users "
                "WHERE role='admin' AND is_active AND device_token IS NOT NULL")
            n = (await cur.fetchone())["n"]
        if n <= 1:
            raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                detail="他に admin が居ないため、自分を降格できません")
    async with db.cursor() as cur:
        await cur.execute("""
            UPDATE users SET role=%s, updated_at=now()
            WHERE id=%s AND device_token IS NOT NULL
            RETURNING id, display_name, role, is_active
        """, (body.role, user_id))
        u = await cur.fetchone()
        if u is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                detail="デバイスが見つかりません")
    await write_audit(db, "DEVICE_ROLE_CHANGE", "users", str(user_id),
                      {"new_role": body.role}, admin["id"], request)
    return dict(u)


@router.post("/devices/{user_id}/revoke")
async def revoke_device(user_id: UUID, db: DB, admin: AdminUser, request: Request):
    """デバイスを無効化する（管理者のみ）。自分自身は無効化できない。"""
    if str(admin["id"]) == str(user_id):
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            detail="自分自身は無効化できません")
    async with db.cursor() as cur:
        await cur.execute("""
            UPDATE users SET is_active=false, updated_at=now()
            WHERE id=%s AND device_token IS NOT NULL
            RETURNING id, display_name, role, is_active
        """, (user_id,))
        u = await cur.fetchone()
        if u is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                detail="デバイスが見つかりません")
    await write_audit(db, "DEVICE_REVOKE", "users", str(user_id), {}, admin["id"], request)
    return dict(u)
