"""Signing in and out, first-run setup, and one's own account."""

from __future__ import annotations

import hmac
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from ..security import (
    burn_password_check,
    check_password_policy,
    hash_password,
    token_hash,
    verify_password,
)
from .auth import COOKIE, client_address, current_principal, issue_session, public_user


class Login(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)
    client: str | None = Field(default=None, max_length=120)


class Setup(BaseModel):
    setup_code: str
    username: str = Field(min_length=2, max_length=64)
    password: str = Field(min_length=1, max_length=256)
    display_name: str | None = Field(default=None, max_length=80)
    organisation: str | None = Field(default=None, max_length=120)


class PasswordChange(BaseModel):
    current_password: str
    new_password: str = Field(min_length=1, max_length=256)


def router(ctx) -> APIRouter:
    r = APIRouter(prefix="/api/auth", tags=["auth"])
    store = ctx.store

    def _cookie(response: Response, request: Request, token: str, expires: float) -> None:
        response.set_cookie(
            COOKIE, token, max_age=int(expires - time.time()), httponly=True, samesite="lax",
            secure=request.url.scheme == "https", path="/",
        )

    def _session_response(request: Request, response: Response, user: dict[str, Any],
                          client: str | None) -> dict[str, Any]:
        token, expires = issue_session(request.app, user, client or request.headers.get("user-agent", ""))
        _cookie(response, request, token, expires)
        store.update_user(user["user_id"], last_login_at=time.time())
        # The token is in the body too, for the phone app (Bearer); the
        # dashboard ignores it and relies on the HttpOnly cookie.
        return {"user": public_user(user), "token": token, "expires_at": expires}

    @r.get("/status")
    def status(request: Request) -> dict[str, Any]:
        out: dict[str, Any] = {
            "auth_enabled": ctx.auth_enabled,
            "setup_needed": ctx.auth_enabled and store.count_users() == 0,
            "organisation": store.get_setting("organisation"),
            "user": None,
        }
        try:
            out["user"] = current_principal(request)
        except HTTPException:
            pass
        return out

    @r.post("/setup")
    def setup(body: Setup, request: Request, response: Response) -> dict[str, Any]:
        if store.count_users() > 0 or not ctx.setup_token:
            raise HTTPException(409, "setup is already done; sign in instead")
        if not hmac.compare_digest(body.setup_code.strip(), ctx.setup_token):
            raise HTTPException(403, "that setup code is not the one printed on the server console")
        problem = check_password_policy(body.password)
        if problem:
            raise HTTPException(400, problem)
        user = store.create_user(body.username, hash_password(body.password), "admin",
                                 body.display_name, created_by="setup")
        if body.organisation:
            store.set_setting("organisation", body.organisation.strip(), user["user_id"])
        ctx.setup_token = None
        store.add_audit("users", "setup_admin_created", {"username": user["username"]},
                        actor=user["username"])
        return _session_response(request, response, user, None)

    @r.post("/login")
    def login(body: Login, request: Request, response: Response) -> dict[str, Any]:
        client = client_address(request)
        wait = ctx.throttle.retry_after(body.username, client)
        if wait > 0:
            raise HTTPException(429, f"too many attempts; try again in {int(wait) + 1} s",
                                headers={"Retry-After": str(int(wait) + 1)})
        user = store.user_by_username(body.username)
        if user is None:
            burn_password_check(body.password)  # same cost either way: no username probing
            ok = False
        else:
            ok = verify_password(body.password, user["pw_hash"]) and not user["disabled"]
        if not ok:
            ctx.throttle.failed(body.username, client)
            store.add_audit("auth", "login_failed", {"username": body.username, "client": client})
            raise HTTPException(401, "wrong username or password")
        ctx.throttle.succeeded(body.username, client)
        store.add_audit("auth", "login", {"client": client, "via": body.client or "web"},
                        actor=user["username"])
        return _session_response(request, response, user, body.client)

    @r.post("/logout")
    def logout(request: Request, response: Response) -> dict[str, Any]:
        header = request.headers.get("authorization", "")
        token = header[7:].strip() if header.lower().startswith("bearer ") else request.cookies.get(COOKIE)
        if token and not token.startswith("cbk_"):
            store.delete_session(token_hash(token))
        response.delete_cookie(COOKIE, path="/")
        return {"ok": True}

    @r.get("/me")
    def me(principal: dict[str, Any] = Depends(current_principal)) -> dict[str, Any]:
        return principal

    @r.post("/password")
    def change_password(body: PasswordChange,
                        principal: dict[str, Any] = Depends(current_principal)) -> dict[str, Any]:
        user = store.get_user(principal["user_id"])
        if user is None:
            raise HTTPException(400, "API keys have no password")
        if not verify_password(body.current_password, user["pw_hash"]):
            raise HTTPException(403, "the current password is wrong")
        problem = check_password_policy(body.new_password)
        if problem:
            raise HTTPException(400, problem)
        store.update_user(user["user_id"], pw_hash=hash_password(body.new_password))
        # Every session of this account ends, this one included: a changed
        # password is usually a response to a leak. The client signs in again.
        store.delete_user_sessions(user["user_id"])
        store.add_audit("users", "password_changed", {"user_id": user["user_id"]},
                        actor=user["username"])
        return {"ok": True, "signed_out": True}

    return r
