"""Who is asking, and are they allowed.

Three ways in, one principal out:

  * the dashboard: an HttpOnly session cookie (so <video> and <img> tags,
    which cannot send headers, still authenticate). Cookie-authenticated
    writes must also carry the X-Countbone header: a browser will not let
    another site add a custom header, which is what makes the cookie safe
    against cross-site request forgery;
  * the phone app: the same session token, as `Authorization: Bearer ...`;
  * machines (ERP scripts, scheduled imports): API keys, `Bearer cbk_...`.

Tokens and keys are stored only as SHA-256 hashes.
"""

from __future__ import annotations

import ipaddress
import secrets
import time
from typing import Any

from fastapi import Depends, HTTPException, Request

from ..security import SESSION_DAYS, role_at_least, token_hash

COOKIE = "cb_session"
CSRF_HEADER = "x-countbone"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def client_address(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def is_loopback(host: str) -> bool:
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return host in ("localhost", "testclient")


def _principal_from_user(user: dict[str, Any], via: str) -> dict[str, Any]:
    return {"user_id": user["user_id"], "username": user["username"],
            "display_name": user.get("display_name") or user["username"],
            "role": user["role"], "via": via}


def current_principal(request: Request) -> dict[str, Any]:
    app = request.app
    if not app.state.auth_enabled:
        return {"user_id": "local", "username": "local", "display_name": "Local user",
                "role": "admin", "via": "no-auth"}
    store = app.state.store
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        token = header[7:].strip()
        if token.startswith("cbk_"):
            key = store.api_key_by_hash(token_hash(token))
            if key is None:
                raise HTTPException(401, "invalid or revoked API key")
            return {"user_id": f"key:{key['key_id']}", "username": f"key:{key['name']}",
                    "display_name": key["name"], "role": key["role"], "via": "api_key"}
        user = store.session_user(token_hash(token))
        if user is None:
            raise HTTPException(401, "session expired; sign in again")
        return _principal_from_user(user, "bearer")
    cookie = request.cookies.get(COOKIE)
    if cookie:
        user = store.session_user(token_hash(cookie))
        if user is None:
            raise HTTPException(401, "session expired; sign in again")
        if request.method not in SAFE_METHODS and request.headers.get(CSRF_HEADER) != "1":
            raise HTTPException(403, "missing X-Countbone header")
        return _principal_from_user(user, "cookie")
    raise HTTPException(401, "sign in required")


def require(role: str):
    """A dependency: the caller must hold at least `role`."""

    def check(principal: dict[str, Any] = Depends(current_principal)) -> dict[str, Any]:
        if not role_at_least(principal["role"], role):
            raise HTTPException(403, f"this needs the {role} role")
        return principal

    return check


def issue_session(app, user: dict[str, Any], client: str) -> tuple[str, float]:
    token = secrets.token_urlsafe(32)
    expires = time.time() + SESSION_DAYS * 86400
    app.state.store.create_session(token_hash(token), user["user_id"], expires, client)
    return token, expires


def public_user(user: dict[str, Any]) -> dict[str, Any]:
    return {k: user.get(k) for k in ("user_id", "username", "display_name", "role", "disabled",
                                     "created_at", "last_login_at")}
