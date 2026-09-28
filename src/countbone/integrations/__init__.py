"""Connectors to customers' systems of record."""

from __future__ import annotations

from typing import Any

import httpx

from .base import Adjustment, Connector, IntegrationError, PostResult, PurchaseOrder
from .netsuite import NetSuiteConnector
from .sap import SapConnector
from .shopify import ShopifyConnector
from .webhook import WebhookConnector

KINDS: dict[str, type[Connector]] = {
    c.kind: c for c in (ShopifyConnector, NetSuiteConnector, SapConnector, WebhookConnector)
}


def build(kind: str, settings: dict[str, Any], secrets: dict[str, Any],
          client: httpx.Client | None = None) -> Connector:
    try:
        cls = KINDS[kind]
    except KeyError:
        raise IntegrationError(f"unknown integration {kind!r}; choose from {sorted(KINDS)}") from None
    return cls(settings, secrets, client)


def describe() -> list[dict[str, Any]]:
    """What each connector can do and what it needs, for the settings UI."""
    return [
        {
            "kind": c.kind,
            "label": c.label,
            "can_pull_expected": c.can_pull_expected,
            "can_push_adjustments": c.can_push_adjustments,
            "can_pull_purchase_orders": c.can_pull_purchase_orders,
            "settings_fields": c.settings_fields,
            "secret_fields": c.secret_fields,
        }
        for c in KINDS.values()
    ]


__all__ = [
    "Adjustment", "Connector", "IntegrationError", "KINDS", "PostResult", "PurchaseOrder",
    "build", "describe",
]
