"""Connector contract: how Countbone talks to a customer's system of record.

Three things flow across the boundary, and a connector implements the ones
its system supports:

  pull_expected      book quantities per location and SKU (what the count is
                     compared against)
  push_adjustments   approved differences, written back to the book
  pull_purchase_order  the lines of a PO, so a delivery can be counted
                     against it (Receive)

Connectors are thin, synchronous and use httpx with a caller-supplied
client, so tests replace the network with httpx.MockTransport and assert the
exact requests each system receives.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import httpx


class IntegrationError(RuntimeError):
    """The other system refused or could not be reached. Message is for people."""


@dataclass
class Adjustment:
    adjustment_id: str
    location: str | None
    sku: str
    system_qty: int | None
    counted_qty: int
    delta: int
    note: str = ""


@dataclass
class PostResult:
    adjustment_id: str
    ok: bool
    external_ref: str | None = None
    error: str | None = None


@dataclass
class PurchaseOrder:
    po_number: str
    supplier: str | None
    lines: dict[str, dict[str, Any]] = field(default_factory=dict)  # sku -> {qty, unit_cost}


class Connector:
    kind = "base"
    label = "Connector"
    can_pull_expected = False
    can_push_adjustments = False
    can_pull_purchase_orders = False
    # Settings (non-secret) and secrets this connector needs, for the UI form.
    settings_fields: list[dict[str, str]] = []
    secret_fields: list[dict[str, str]] = []

    def __init__(self, settings: dict[str, Any], secrets: dict[str, Any],
                 client: httpx.Client | None = None) -> None:
        self.settings = settings or {}
        self.secrets = secrets or {}
        self.client = client or httpx.Client(timeout=30.0)
        missing = [f["key"] for f in self.settings_fields
                   if f.get("required") and not self.settings.get(f["key"])]
        missing += [f["key"] for f in self.secret_fields
                    if f.get("required") and not self.secrets.get(f["key"])]
        if missing:
            raise IntegrationError(f"{self.label}: missing {', '.join(missing)}")

    # -- location mapping: Countbone bay codes -> the other system's places ----
    def target_location(self, location: str | None) -> str | None:
        """Many bays map to one ERP location (a Shopify location is a whole
        store or warehouse). The map is `location_map` in settings, keyed by
        bay code or by prefix ending in '*'; `default_location` catches the rest."""
        mapping: dict[str, str] = self.settings.get("location_map") or {}
        if location and location in mapping:
            return mapping[location]
        if location:
            for key, value in mapping.items():
                if key.endswith("*") and location.startswith(key[:-1]):
                    return value
        return self.settings.get("default_location")

    def test(self) -> dict[str, Any]:
        raise NotImplementedError

    def pull_expected(self, locations: dict[str, list[str]]) -> dict[str, dict[str, int]]:
        """{bay_code: [skus]} -> {bay_code: {sku: qty}}."""
        raise IntegrationError(f"{self.label} cannot read stock levels")

    def push_adjustments(self, adjustments: list[Adjustment]) -> list[PostResult]:
        raise IntegrationError(f"{self.label} cannot write adjustments")

    def pull_purchase_order(self, po_number: str) -> PurchaseOrder:
        raise IntegrationError(f"{self.label} has no purchase orders")

    # -- helpers -----------------------------------------------------------
    @staticmethod
    def _raise_for(response: httpx.Response, what: str) -> None:
        if response.is_success:
            return
        detail = response.text[:300].strip()
        raise IntegrationError(f"{what} failed: HTTP {response.status_code} {detail}")
