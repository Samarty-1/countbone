"""Administration: people, API keys, integrations, settings."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import integrations
from ..ops import modules, reconcile
from ..security import (
    ROLES,
    check_password_policy,
    hash_password,
    new_token,
    role_at_least,
    token_hash,
)
from .auth import public_user, require


class UserIn(BaseModel):
    username: str = Field(min_length=2, max_length=64, pattern=r"^[A-Za-z0-9._@-]+$")
    password: str = Field(min_length=1, max_length=256)
    role: str = "counter"
    display_name: str | None = Field(default=None, max_length=80)


class UserPatch(BaseModel):
    role: str | None = None
    display_name: str | None = Field(default=None, max_length=80)
    disabled: bool | None = None
    password: str | None = Field(default=None, max_length=256)


class KeyIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    role: str = "counter"


class IntegrationIn(BaseModel):
    name: str = Field(min_length=1, max_length=40, pattern=r"^[a-z0-9_-]+$")
    kind: str
    settings: dict[str, Any] = {}
    secrets: dict[str, str] | None = None  # omitted on edit: keep the stored ones
    enabled: bool = True


class PullExpected(BaseModel):
    locations: list[str] | None = None


class SettingsIn(BaseModel):
    organisation: str | None = Field(default=None, max_length=120)
    modules: dict[str, bool] | None = None


def router(ctx) -> APIRouter:
    r = APIRouter(tags=["admin"])
    store, services = ctx.store, ctx.services
    admin, counter = require("admin"), require("counter")

    def _role(role: str) -> str:
        if role not in ROLES:
            raise HTTPException(400, f"role must be one of {', '.join(ROLES)}")
        return role

    # -- people --------------------------------------------------------------------------
    @r.get("/api/users")
    def list_users(who: dict = Depends(counter)) -> list[dict[str, Any]]:
        # Everyone can see who is on the team (to assign and to read the trail);
        # only an admin can change it. When people last signed in, and whose
        # account is disabled, is for managers: a counter needs names, not that.
        users = [public_user(u) for u in store.list_users()]
        if role_at_least(who["role"], "manager"):
            return users
        return [{k: u[k] for k in ("user_id", "username", "display_name", "role")}
                for u in users if not u.get("disabled")]

    @r.post("/api/users", status_code=201)
    def create_user(body: UserIn, who: dict = Depends(admin)) -> dict[str, Any]:
        _role(body.role)
        if store.user_by_username(body.username):
            raise HTTPException(409, "that username is taken")
        problem = check_password_policy(body.password)
        if problem:
            raise HTTPException(400, problem)
        user = store.create_user(body.username, hash_password(body.password), body.role,
                                 body.display_name, who["user_id"])
        store.add_audit("users", "user_created", {"username": user["username"], "role": body.role},
                        actor=who["username"])
        return public_user(user)

    @r.patch("/api/users/{user_id}")
    def update_user(user_id: str, body: UserPatch, who: dict = Depends(admin)) -> dict[str, Any]:
        user = store.get_user(user_id)
        if user is None:
            raise HTTPException(404, "no such user")
        fields: dict[str, Any] = {}
        if body.role is not None:
            fields["role"] = _role(body.role)
        if body.display_name is not None:
            fields["display_name"] = body.display_name
        if body.disabled is not None:
            fields["disabled"] = int(body.disabled)
        if body.password:
            problem = check_password_policy(body.password)
            if problem:
                raise HTTPException(400, problem)
            fields["pw_hash"] = hash_password(body.password)
        demoting = fields.get("role", user["role"]) != "admin" or fields.get("disabled")
        if user["role"] == "admin" and demoting:
            admins = [u for u in store.list_users() if u["role"] == "admin" and not u["disabled"]]
            if len(admins) <= 1:
                raise HTTPException(409, "this is the last admin; make someone else admin first")
        store.update_user(user_id, **fields)
        if body.disabled or body.password or "role" in fields:
            store.delete_user_sessions(user_id)  # changes of access take effect now
        store.add_audit("users", "user_updated",
                        {"user_id": user_id, **{k: v for k, v in fields.items() if k != "pw_hash"},
                         "password_reset": bool(body.password)}, actor=who["username"])
        return public_user(store.get_user(user_id))  # type: ignore[arg-type]

    # -- API keys --------------------------------------------------------------------------
    @r.get("/api/api-keys")
    def list_keys(_: dict = Depends(admin)) -> list[dict[str, Any]]:
        return store.list_api_keys()

    @r.post("/api/api-keys", status_code=201)
    def create_key(body: KeyIn, who: dict = Depends(admin)) -> dict[str, Any]:
        token = new_token("cbk_")
        key = store.create_api_key(body.name, token_hash(token), _role(body.role), who["user_id"])
        store.add_audit("api_keys", "api_key_created", {"key_id": key["key_id"], "name": body.name,
                                                        "role": body.role}, actor=who["username"])
        # Shown once: only its hash is stored.
        return {**key, "key": token}

    @r.delete("/api/api-keys/{key_id}")
    def revoke_key(key_id: str, who: dict = Depends(admin)) -> dict[str, Any]:
        if not store.revoke_api_key(key_id):
            raise HTTPException(404, "no such key")
        store.add_audit("api_keys", "api_key_revoked", {"key_id": key_id}, actor=who["username"])
        return {"ok": True}

    # -- integrations -------------------------------------------------------------------------
    @r.get("/api/integrations/kinds")
    def kinds(_: dict = Depends(counter)) -> list[dict[str, Any]]:
        return integrations.describe()

    @r.get("/api/integrations")
    def list_integrations(_: dict = Depends(counter)) -> list[dict[str, Any]]:
        return store.list_integrations()

    @r.put("/api/integrations")
    def save_integration(body: IntegrationIn, who: dict = Depends(admin)) -> dict[str, Any]:
        if body.kind not in integrations.KINDS:
            raise HTTPException(400, f"unknown integration kind {body.kind}")
        existing = store.get_integration(body.name)
        secrets = body.secrets
        if secrets is None and existing is None:
            raise HTTPException(400, "a new integration needs its credentials")
        # Validate the combination before storing it.
        try:
            stored_secrets = secrets if secrets is not None else services.keyring.unseal(existing["secrets"])
            integrations.build(body.kind, body.settings, stored_secrets, services.http_client)
        except integrations.IntegrationError as exc:
            raise HTTPException(400, str(exc)) from None
        sealed = services.keyring.seal(secrets) if secrets is not None else None
        store.upsert_integration(body.name, body.kind, body.settings, sealed, body.enabled,
                                 who["user_id"])
        store.add_audit("integrations", "integration_saved",
                        {"name": body.name, "kind": body.kind, "settings": body.settings,
                         "secrets_changed": secrets is not None}, actor=who["username"])
        return next(i for i in store.list_integrations() if i["name"] == body.name)

    @r.post("/api/integrations/{name}/test")
    def test_integration(name: str, who: dict = Depends(admin)) -> dict[str, Any]:
        try:
            result = reconcile.connector_for(services, name).test()
            store.mark_integration(name, None)
        except (integrations.IntegrationError, Exception) as exc:  # noqa: BLE001 - report, never 500
            store.mark_integration(name, str(exc))
            return {"ok": False, "detail": str(exc)}
        return result

    @r.post("/api/integrations/{name}/pull-expected")
    def pull_expected(name: str, body: PullExpected, who: dict = Depends(require("manager"))) -> dict[str, Any]:
        every = [loc["code"] for loc in store.list_locations()]
        codes = body.locations or every
        skus = [e.sku for e in services.current_catalog().entries]
        wanted = {c: sorted(set(store.expected_for(c)) | set(skus)) for c in codes}
        try:
            got = reconcile.connector_for(services, name).pull_expected(wanted, known=every)
        except integrations.IntegrationError as exc:
            store.mark_integration(name, str(exc))
            raise HTTPException(502, str(exc)) from None
        row = store.get_integration(name)
        for code, qtys in got.items():
            store.set_expected(code, qtys, row["kind"] if row else name, who["user_id"])
        store.mark_integration(name, None)
        store.add_audit("integrations", "book_stock_pulled",
                        {"integration": name, "locations": len(got),
                         "rows": sum(len(q) for q in got.values())}, actor=who["username"])
        return {"locations": len(got), "rows": sum(len(q) for q in got.values())}

    @r.delete("/api/integrations/{name}")
    def delete_integration(name: str, who: dict = Depends(admin)) -> dict[str, Any]:
        if not store.delete_integration(name):
            raise HTTPException(404, "no such integration")
        store.add_audit("integrations", "integration_deleted", {"name": name}, actor=who["username"])
        return {"ok": True}

    # -- settings ----------------------------------------------------------------------------
    @r.get("/api/settings")
    def get_settings(_: dict = Depends(counter)) -> dict[str, Any]:
        return {"organisation": store.get_setting("organisation"),
                "schema_version": store.schema_version,
                "evidence_key_id": services.keyring.key_id(),
                "evidence_key_fingerprint": services.keyring.key_fingerprint(),
                "modules": modules.modules(services)}

    @r.put("/api/settings")
    def put_settings(body: SettingsIn, who: dict = Depends(admin)) -> dict[str, Any]:
        if body.organisation is not None:
            store.set_setting("organisation", body.organisation.strip(), who["user_id"])
        if body.modules is not None:
            modules.set_modules(services, body.modules, who)
        store.add_audit("settings", "settings_saved", body.model_dump(), actor=who["username"])
        return get_settings(who)

    return r
