"""SAP S/4HANA, through its OData v2 APIs.

* Book stock: API_MATERIAL_STOCK_SRV, entity A_MatlStkInAcctMod, unrestricted
  stock per material, plant and storage location.
* Adjustments: the SAP-native physical inventory flow in
  API_PHYSICAL_INVENTORY_DOC_SRV: create a physical inventory document for
  the materials, enter the *counted* quantity on each item (SAP computes the
  difference against its own book at that moment), then post differences.
  Countbone sends counts, not deltas, which is what SAP auditors expect to
  see on the document. A storage location is usually bigger than a bay, so
  the count entered is for the whole location: SAP's book plus the approved
  differences of every bay in it (see _post_document).
* Purchase orders: API_PURCHASEORDER_PROCESS_SRV, the PO's items.

Writes need a CSRF token (fetched with `x-csrf-token: Fetch` and returned
with the session cookies) and item updates need the item's ETag in
If-Match; both are handled here.

A Countbone bay maps to "PLANT/STORAGE_LOCATION" in `location_map`.
"""

from __future__ import annotations

import time
from typing import Any

import httpx

from .base import Adjustment, Connector, IntegrationError, PostResult, PurchaseOrder

PI = "/sap/opu/odata/sap/API_PHYSICAL_INVENTORY_DOC_SRV"
STOCK = "/sap/opu/odata/sap/API_MATERIAL_STOCK_SRV"
PO = "/sap/opu/odata/sap/API_PURCHASEORDER_PROCESS_SRV"


def _odata_date(ts: float | None = None) -> str:
    return f"/Date({int((ts or time.time()) * 1000)})/"


def _q(value: str) -> str:
    return value.replace("'", "''")


class SapConnector(Connector):
    kind = "sap"
    label = "SAP S/4HANA"
    can_pull_expected = True
    can_push_adjustments = True
    can_pull_purchase_orders = True
    settings_fields = [
        {"key": "base_url", "label": "Host (https://my-s4.example.com)", "required": "1"},
        {"key": "default_location", "label": "Default PLANT/STORAGE_LOCATION, e.g. 1010/0001",
         "required": "1"},
        {"key": "unit", "label": "Unit of entry (default PC)"},
        {"key": "sap_client", "label": "SAP client (sap-client), if not the default"},
    ]
    secret_fields = [
        {"key": "username", "label": "Communication user", "required": "1"},
        {"key": "password", "label": "Password", "required": "1"},
    ]

    def __init__(self, settings, secrets, client: httpx.Client | None = None) -> None:
        super().__init__(settings, secrets, client)
        self.client.auth = (self.secrets["username"], self.secrets["password"])
        self._csrf: str | None = None

    def _url(self, path: str) -> str:
        url = self.settings["base_url"].rstrip("/") + path
        if self.settings.get("sap_client"):
            url += ("&" if "?" in url else "?") + f"sap-client={self.settings['sap_client']}"
        return url

    def _split(self, location: str | None) -> tuple[str, str]:
        target = self.target_location(location)
        if not target or "/" not in target:
            raise IntegrationError(f"no SAP PLANT/STORAGE_LOCATION mapped for {location}")
        plant, sloc = target.split("/", 1)
        return plant.strip(), sloc.strip()

    def _get(self, path: str) -> dict[str, Any]:
        response = self.client.get(self._url(path), headers={"Accept": "application/json"})
        self._raise_for(response, "SAP read")
        return response.json()["d"]

    def _token(self) -> str:
        if self._csrf is None:
            response = self.client.get(self._url(PI + "/"),
                                       headers={"x-csrf-token": "Fetch", "Accept": "application/json"})
            self._raise_for(response, "SAP CSRF token")
            self._csrf = response.headers.get("x-csrf-token")
            if not self._csrf:
                raise IntegrationError("SAP returned no CSRF token")
        return self._csrf

    def _write(self, method: str, path: str, body: dict[str, Any] | None = None,
               etag: str | None = None) -> httpx.Response:
        headers = {"x-csrf-token": self._token(), "Accept": "application/json",
                   "Content-Type": "application/json"}
        if etag:
            headers["If-Match"] = etag
        return self.client.request(method, self._url(path), json=body, headers=headers)

    def test(self) -> dict[str, Any]:
        self._token()
        return {"ok": True, "detail": "authenticated; CSRF token issued"}

    def _book(self, plant: str, sloc: str, sku: str) -> int:
        """Unrestricted stock of one material in one storage location."""
        flt = (f"Material eq '{_q(sku)}' and Plant eq '{_q(plant)}' and "
               f"StorageLocation eq '{_q(sloc)}' and InventoryStockType eq '01'")
        # httpx percent-encodes the query string (spaces, quotes) itself.
        data = self._get(f"{STOCK}/A_MatlStkInAcctMod?$filter={flt}")
        return int(sum(float(r.get("MatlWrhsStkQtyInMatlBaseUnit") or 0)
                       for r in data.get("results", [])))

    def pull_expected(self, locations: dict[str, list[str]],
                      known: list[str] | None = None) -> dict[str, dict[str, int]]:
        self.refuse_shared_book(list(locations), known)
        out: dict[str, dict[str, int]] = {}
        for bay, skus in locations.items():
            plant, sloc = self._split(bay)
            out[bay] = {sku: self._book(plant, sloc, sku) for sku in skus}
        return out

    def push_adjustments(self, adjustments: list[Adjustment]) -> list[PostResult]:
        results: list[PostResult] = []
        groups: dict[tuple[str, str], list[Adjustment]] = {}
        for adj in adjustments:
            try:
                groups.setdefault(self._split(adj.location), []).append(adj)
            except IntegrationError as exc:
                results.append(PostResult(adj.adjustment_id, False, error=str(exc)))
        unit = self.settings.get("unit") or "PC"
        for (plant, sloc), adjs in groups.items():
            try:
                results += self._post_document(plant, sloc, adjs, unit)
            except IntegrationError as exc:
                results += [PostResult(a.adjustment_id, False, error=str(exc)) for a in adjs]
        return results

    def _post_document(self, plant: str, sloc: str, adjs: list[Adjustment],
                       unit: str) -> list[PostResult]:
        # A storage location usually holds several bays, and SAP takes one
        # count per material for the whole of it. Entering one bay's count
        # would wipe every other bay's stock, so the count entered is SAP's
        # current book plus every approved bay difference for that material:
        # still a count on the document, and right however many bays share it.
        by_sku: dict[str, list[Adjustment]] = {}
        for a in adjs:
            by_sku.setdefault(a.sku, []).append(a)
        results: list[PostResult] = []
        counts: dict[str, int] = {}
        for sku, group in by_sku.items():
            book = self._book(plant, sloc, sku)
            total = book + sum(a.delta for a in group)
            if total < 0:
                results += [PostResult(a.adjustment_id, False, error=(
                    f"SAP holds {book} of {sku} in {plant}/{sloc}; applying the counted "
                    f"differences would leave {total}. Recount, or post it in SAP.")) for a in group]
            else:
                counts[sku] = total
        if not counts:
            return results
        posting = [a for a in adjs if a.sku in counts]

        # 1. A physical inventory document listing the materials, once each.
        # Only the core fields: optional header fields differ between S/4
        # releases, and an unknown property fails the whole deep insert.
        header = {
            "Plant": plant,
            "StorageLocation": sloc,
            "DocumentDate": _odata_date(),
            "to_PhysicalInventoryDocumentItem": {"results": [
                {"Plant": plant, "StorageLocation": sloc, "Material": sku} for sku in counts
            ]},
        }
        created = self._write("POST", f"{PI}/A_PhysInventoryDocHeader", header)
        self._raise_for(created, "SAP create physical inventory document")
        doc = created.json()["d"]
        year, number = doc["FiscalYear"], doc["PhysicalInventoryDocument"]
        items = doc.get("to_PhysicalInventoryDocumentItem", {}).get("results", [])
        by_material = {i["Material"]: i for i in items}

        # 2. The counted quantity on each item (SAP needs the item's ETag).
        for sku, qty in counts.items():
            item = by_material.get(sku)
            if item is None:
                raise IntegrationError(f"SAP document {number} has no item for {sku}")
            key = (f"(FiscalYear='{year}',PhysicalInventoryDocument='{number}',"
                   f"PhysicalInventoryDocumentItem='{item['PhysicalInventoryDocumentItem']}')")
            current = self.client.get(self._url(f"{PI}/A_PhysInventoryDocItem{key}"),
                                      headers={"Accept": "application/json"})
            self._raise_for(current, "SAP read item")
            etag = current.headers.get("etag") or current.json()["d"].get("__metadata", {}).get("etag")
            counted = self._write("PATCH", f"{PI}/A_PhysInventoryDocItem{key}", {
                "QuantityInUnitOfEntry": str(qty),
                "UnitOfEntry": unit,
            }, etag=etag)
            self._raise_for(counted, f"SAP enter count for {sku}")

        # 3. Post the differences SAP computed.
        posted = self._write(
            "POST",
            f"{PI}/PostDifferences?FiscalYear='{year}'&PhysicalInventoryDocument='{number}'",
        )
        self._raise_for(posted, "SAP post differences")
        ref = f"{year}/{number}"
        return results + [PostResult(a.adjustment_id, True, external_ref=ref) for a in posting]

    def pull_purchase_order(self, po_number: str) -> PurchaseOrder:
        data = self._get(f"{PO}/A_PurchaseOrder('{_q(po_number)}')?$expand=to_PurchaseOrderItem")
        lines: dict[str, dict[str, Any]] = {}
        for item in data.get("to_PurchaseOrderItem", {}).get("results", []):
            sku = item.get("Material")
            if not sku:
                continue
            qty = int(float(item.get("OrderQuantity") or 0))
            price = float(item.get("NetPriceAmount") or 0)
            per = float(item.get("NetPriceQuantity") or 1) or 1
            line = lines.setdefault(sku, {"qty": 0, "unit_cost": price / per})
            line["qty"] += qty
        if not lines:
            raise IntegrationError(f"SAP purchase order {po_number} has no material lines")
        return PurchaseOrder(po_number=po_number, supplier=data.get("Supplier"), lines=lines)
