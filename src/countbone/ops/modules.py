"""Product modules a deployment can switch off.

Receive (delivery counts against purchase orders) is off by default: the
first pilots count shelves only. Switching it off hides it everywhere at
once, because the dashboard, the phone app and the API all ask here: a
module hidden in one place but live in another is half off.
"""

from __future__ import annotations

from typing import Any

from . import OpsError, Services

DEFAULTS: dict[str, bool] = {"receive": False}


def modules(services: Services) -> dict[str, bool]:
    saved = services.store.get_setting("modules") or {}
    return {name: bool(saved.get(name, on)) for name, on in DEFAULTS.items()}


def set_modules(services: Services, changes: dict[str, Any], actor: dict[str, Any]) -> dict[str, bool]:
    unknown = sorted(set(changes) - set(DEFAULTS))
    if unknown:
        raise OpsError(f"unknown module: {', '.join(unknown)}")
    bad = sorted(k for k, v in changes.items() if not isinstance(v, bool))
    if bad:
        raise OpsError(f"{', '.join(bad)} must be true or false")
    merged = {**modules(services), **changes}
    services.store.set_setting("modules", merged, actor["user_id"])
    services.store.add_audit("settings", "modules_changed", changes, actor=actor["username"])
    return merged


def require_on(services: Services, name: str) -> None:
    if not modules(services).get(name):
        raise OpsError(f"{name.title()} is switched off for this site (Settings, Modules)")
