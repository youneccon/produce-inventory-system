"""
api/auth.py
===========
認証・権限分離の共有依存性（仕様書4.1）。

認証方式: デバイス承認ベース。各デバイスは device_token を持ち、
リクエストの X-Device-Token ヘッダーで自動ログインする。

権限分離:
  - viewer   … 閲覧のみ (書き込み API は 403)
  - operator … 閲覧 + 入出庫の記録
  - admin    … 上記 + マスタ変更・過去履歴修正・倉庫レイアウト編集・人員管理

エンドポイントの依存性:
  - CurrentUser  : ログイン済 (viewer 以上)
  - OperatorUser : operator 以上 (= operator | admin)
  - AdminUser    : admin のみ

エンドポイント本体（登録・承認など）は api/routers/auth.py。
"""

from __future__ import annotations

import secrets
from typing import Annotated

import psycopg
from fastapi import Depends, Header, HTTPException, status

from api.dependencies import get_db


def generate_device_token() -> str:
    """新しいデバイストークンを払い出す。"""
    return secrets.token_urlsafe(32)


async def get_current_user(
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
    x_device_token: Annotated[str | None, Header()] = None,
) -> dict:
    """
    X-Device-Token ヘッダーから現在のユーザーを解決する。
    トークン無し→401、無効→401、未承認(is_active=false)→403。
    """
    if not x_device_token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED,
                            detail="X-Device-Token ヘッダーが必要です")
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT id, display_name, role, is_active, "
            "COALESCE(divisions, '{}'::INTEGER[]) AS divisions "
            "FROM users WHERE device_token=%s",
            (x_device_token,),
        )
        user = await cur.fetchone()
        if user is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED,
                                detail="無効なデバイストークンです")
        if not user["is_active"]:
            raise HTTPException(status.HTTP_403_FORBIDDEN,
                                detail="このデバイスは承認待ちです。管理者の承認が必要です")
        await cur.execute("UPDATE users SET last_login_at=now() WHERE id=%s", (user["id"],))
    return user


CurrentUser = Annotated[dict, Depends(get_current_user)]


async def require_admin(user: CurrentUser) -> dict:
    """管理者権限を要求する依存性。"""
    if user["role"] != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            detail="この操作には管理者権限が必要です")
    return user


AdminUser = Annotated[dict, Depends(require_admin)]


async def require_operator(user: CurrentUser) -> dict:
    """operator 以上を要求する依存性 (viewer を拒否)。書き込み系 API で使用。
    recipe_editor は レシピ関連 以外 の 書き込みは できないので 403。"""
    if user["role"] in ("viewer", "recipe_editor"):
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            detail="この操作には記録権限 (operator 以上) が必要です。"
                                   "閲覧専用アカウントでは実行できません")
    return user


OperatorUser = Annotated[dict, Depends(require_operator)]


def require_recipe_editor_for_division(division: int):
    """レシピ編集権限を 動的に 要求する 依存性ファクトリ。

    permissions:
      - admin                                → 全事業部 編集 OK
      - recipe_editor + division ∈ divisions → そこだけ 編集 OK
      - その他                                 → 403

    使い方:
        @router.post("/submission", dependencies=[
            Depends(require_recipe_editor_for_division(2))  # 事業2部
        ])
        # または body から 取り出すなら 関数内で 手動 チェック
    """
    async def _check(user: CurrentUser) -> dict:
        role = user.get("role")
        if role == "admin":
            return user
        if role == "recipe_editor":
            divs = user.get("divisions") or []
            if division in divs:
                return user
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail=f"事業{division}部 の レシピ編集権限 が ありません。"
                   f"(role={role}, divisions={user.get('divisions')})",
        )
    return _check


async def assert_can_edit_recipe(user: dict, division: int) -> None:
    """body や path から 取った division を 検証する 手続き関数。
    依存性 ファクトリ が 使えない 場面 (= 動的) で 呼ぶ。"""
    role = user.get("role")
    if role == "admin":
        return
    if role == "recipe_editor":
        divs = user.get("divisions") or []
        if division in divs:
            return
    raise HTTPException(
        status.HTTP_403_FORBIDDEN,
        detail=f"事業{division}部 の レシピ編集権限 が ありません",
    )


async def require_recipe_editor_or_admin(user: CurrentUser) -> dict:
    """admin か recipe_editor の どちらかを 要求 (担当事業部 は 個別に チェック)。"""
    if user.get("role") not in ("admin", "recipe_editor"):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail="この操作には レシピ編集権限 (admin or recipe_editor) が 必要です",
        )
    return user


RecipeEditorUser = Annotated[dict, Depends(require_recipe_editor_or_admin)]
