"""Shopify, through the Admin GraphQL API.

Reads `available` at a Shopify location and writes counted quantities back
with inventorySetQuantities, reason cycle_count_available. Written against
API version 2026-07, where the mutation requires the @idempotent directive
and uses changeFromQuantity for compare-and-set: if the shelf was sold from
between the count and the post, Shopify rejects the write instead of
overwriting a sale.

Shopify locations are whole stores or warehouses, not bays, so a bay's
count is posted as a *change* against the location's current quantity:
the adjustment's delta, applied with compare-and-set. Several bays of one
SKU in one store therefore post as several correct deltas, never as one
bay's count overwriting the store total.

Shopify has no native purchase orders (they live in apps), so Receive
reads POs from CSV or another connector.
"""

from __future__ import annotations

from typing import Any

from .base import Adjustment, Connector, IntegrationError, PostResult

API_VERSION = "2026-07"

_VARIANT_QUERY = """
query Levels($q: String!, $loc: ID!) {
  productVariants(first: 5, query: $q) {
    nodes {
      sku
      inventoryItem {
        id
        inventoryLevel(locationId: $loc) {
          quantities(names: ["available"]) { name quantity }
        }
      }
    }
  }
}
"""

_SET_MUTATION = """
mutation Set($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
  inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
    inventoryAdjustmentGroup { id }
    userErrors { field message code }
  }
}
"""


class ShopifyConnector(Connector):
    kind = "shopify"
    label = "Shopify"
    can_pull_expected = True
    can_push_adjustments = True
    settings_fields = [
        {"key": "shop", "label": "Shop domain (name.myshopify.com)", "required": "1"},
        {"key": "default_location", "label": "Location ID (gid://shopify/Location/...)",
         "required": "1"},
    ]
    secret_fields = [{"key": "access_token", "label": "Admin API access token", "required": "1"}]

    @property
    def _url(self) -> str:
        shop = self.settings["shop"].strip().removeprefix("https://").rstrip("/")
        return f"https://{shop}/admin/api/{API_VERSION}/graphql.json"

    def _gql(self, query: str, variables: dict[str, Any]) -> dict[str, Any]:
        response = self.client.post(
            self._url,
            json={"query": query, "variables": variables},
            headers={"X-Shopify-Access-Token": self.secrets["access_token"],
                     "Content-Type": "application/json"},
        )
        self._raise_for(response, "Shopify request")
        body = response.json()
        if body.get("errors"):
            raise IntegrationError(f"Shopify: {body['errors']}")
        return body["data"]

    def _level(self, sku: str, location_id: str) -> tuple[str, int]:
        """(inventory item id, available) for one SKU at one location."""
        # Quoted, so a SKU with spaces or dashes is one search term.
        data = self._gql(_VARIANT_QUERY, {"q": f'sku:"{sku}"', "loc": location_id})
        nodes = [n for n in data["productVariants"]["nodes"] if n.get("sku") == sku]
        if not nodes:
            raise IntegrationError(f"Shopify has no variant with SKU {sku}")
        item = nodes[0]["inventoryItem"]
        level = item.get("inventoryLevel")
        if level is None:
            raise IntegrationError(f"SKU {sku} is not stocked at {location_id}")
        qty = next((q["quantity"] for q in level["quantities"] if q["name"] == "available"), 0)
        return item["id"], int(qty)

    def test(self) -> dict[str, Any]:
        data = self._gql("{ shop { name } }", {})
        return {"ok": True, "detail": f"connected to {data['shop']['name']}"}

    def pull_expected(self, locations: dict[str, list[str]],
                      known: list[str] | None = None) -> dict[str, dict[str, int]]:
        """Shopify only knows a whole location's quantity. That is a bay's
        book stock only when the bay *is* the location (map it 1:1); for
        several bays per store, load per-bay expectations from CSV and let
        Shopify receive the deltas."""
        self.refuse_shared_book(list(locations), known)
        out: dict[str, dict[str, int]] = {}
        for bay, skus in locations.items():
            target = self.target_location(bay)
            if not target:
                continue
            out[bay] = {sku: self._level(sku, target)[1] for sku in skus}
        return out

    def push_adjustments(self, adjustments: list[Adjustment]) -> list[PostResult]:
        results = []
        for adj in adjustments:
            target = self.target_location(adj.location)
            if not target:
                results.append(PostResult(adj.adjustment_id, False,
                                          error=f"no Shopify location mapped for {adj.location}"))
                continue
            try:
                item_id, current = self._level(adj.sku, target)
                data = self._gql(_SET_MUTATION, {
                    "idempotencyKey": adj.adjustment_id,
                    "input": {
                        "name": "available",
                        "reason": "cycle_count_available",
                        "referenceDocumentUri": f"countbone://adjustment/{adj.adjustment_id}",
                        "quantities": [{
                            "inventoryItemId": item_id,
                            "locationId": target,
                            "quantity": current + adj.delta,
                            "changeFromQuantity": current,
                        }],
                    },
                })
                payload = data["inventorySetQuantities"]
                if payload["userErrors"]:
                    msg = "; ".join(e["message"] for e in payload["userErrors"])
                    results.append(PostResult(adj.adjustment_id, False, error=msg))
                else:
                    group = payload.get("inventoryAdjustmentGroup") or {}
                    results.append(PostResult(adj.adjustment_id, True, external_ref=group.get("id")))
            except IntegrationError as exc:
                results.append(PostResult(adj.adjustment_id, False, error=str(exc)))
        return results
