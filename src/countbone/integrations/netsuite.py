"""Oracle NetSuite, through SuiteTalk REST web services.

* Book stock: SuiteQL over InventoryItemLocations (quantityOnHand per item
  and location).
* Adjustments: an inventoryAdjustment record, one line per SKU, with
  adjustQtyBy = the approved delta, posted to the configured adjustment
  account.
* Purchase orders: SuiteQL over the PO's transaction lines.

Authentication is Token-Based Authentication (OAuth 1.0a, HMAC-SHA256),
which NetSuite requires for integrations; the signing is implemented here
with the standard library so there is no OAuth dependency to keep current.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import time
from typing import Any
from urllib.parse import parse_qsl, quote, urlsplit

from .base import Adjustment, Connector, IntegrationError, PostResult, PurchaseOrder


def _pct(value: str) -> str:
    return quote(str(value), safe="~")


def oauth1_header(method: str, url: str, realm: str, consumer_key: str, consumer_secret: str,
                  token: str, token_secret: str, nonce: str | None = None,
                  timestamp: str | None = None) -> str:
    """The Authorization header for one request (RFC 5849, HMAC-SHA256)."""
    oauth = {
        "oauth_consumer_key": consumer_key,
        "oauth_token": token,
        "oauth_signature_method": "HMAC-SHA256",
        "oauth_timestamp": timestamp or str(int(time.time())),
        "oauth_nonce": nonce or secrets.token_hex(16),
        "oauth_version": "1.0",
    }
    parts = urlsplit(url)
    base_url = f"{parts.scheme}://{parts.netloc.lower()}{parts.path}"
    params = list(parse_qsl(parts.query, keep_blank_values=True)) + list(oauth.items())
    # Parameters are encoded first and then sorted, as RFC 5849 3.4.1.3.2 requires.
    normalized = "&".join(
        f"{k}={v}" for k, v in sorted((_pct(k), _pct(v)) for k, v in params)
    )
    base = "&".join([method.upper(), _pct(base_url), _pct(normalized)])
    key = f"{_pct(consumer_secret)}&{_pct(token_secret)}"
    signature = base64.b64encode(
        hmac.new(key.encode(), base.encode(), hashlib.sha256).digest()
    ).decode()
    oauth["oauth_signature"] = signature
    fields = ", ".join(f'{k}="{_pct(v)}"' for k, v in sorted(oauth.items()))
    return f'OAuth realm="{realm}", {fields}'


def _sql_list(values: list[str]) -> str:
    """A SuiteQL IN list. Values are SKUs from our own catalog; quotes are
    doubled all the same, since they end up inside a query string."""
    return ", ".join("'" + v.replace("'", "''") + "'" for v in values)


class NetSuiteConnector(Connector):
    kind = "netsuite"
    label = "NetSuite"
    can_pull_expected = True
    can_push_adjustments = True
    can_pull_purchase_orders = True
    settings_fields = [
        {"key": "account_id", "label": "Account ID (e.g. 1234567 or 1234567_SB1)", "required": "1"},
        {"key": "adjustment_account", "label": "Adjustment account internal ID", "required": "1"},
        {"key": "subsidiary", "label": "Subsidiary internal ID (OneWorld only)"},
        {"key": "default_location", "label": "Default location internal ID", "required": "1"},
    ]
    secret_fields = [
        {"key": "consumer_key", "label": "Consumer key", "required": "1"},
        {"key": "consumer_secret", "label": "Consumer secret", "required": "1"},
        {"key": "token_id", "label": "Token ID", "required": "1"},
        {"key": "token_secret", "label": "Token secret", "required": "1"},
    ]

    @property
    def _host(self) -> str:
        account = self.settings["account_id"].strip().lower().replace("_", "-")
        return f"https://{account}.suitetalk.api.netsuite.com"

    def _headers(self, method: str, url: str) -> dict[str, str]:
        return {
            "Authorization": oauth1_header(
                method, url, self.settings["account_id"].strip().upper().replace("-", "_"),
                self.secrets["consumer_key"], self.secrets["consumer_secret"],
                self.secrets["token_id"], self.secrets["token_secret"],
            ),
            "Content-Type": "application/json",
        }

    def suiteql(self, query: str) -> list[dict[str, Any]]:
        url = f"{self._host}/services/rest/query/v1/suiteql"
        rows: list[dict[str, Any]] = []
        offset = 0
        while True:
            page = f"{url}?limit=1000&offset={offset}"
            headers = {**self._headers("POST", page), "Prefer": "transient"}
            response = self.client.post(page, json={"q": query}, headers=headers)
            self._raise_for(response, "NetSuite SuiteQL")
            body = response.json()
            rows.extend(body.get("items", []))
            if not body.get("hasMore"):
                return rows
            offset += 1000

    def _item_ids(self, skus: list[str]) -> dict[str, str]:
        if not skus:
            return {}
        rows = self.suiteql(f"SELECT id, itemid FROM item WHERE itemid IN ({_sql_list(skus)})")
        return {r["itemid"]: str(r["id"]) for r in rows}

    def test(self) -> dict[str, Any]:
        rows = self.suiteql("SELECT id FROM subsidiary WHERE ROWNUM <= 1")
        return {"ok": True, "detail": f"SuiteQL reachable ({len(rows)} row)"}

    def pull_expected(self, locations: dict[str, list[str]]) -> dict[str, dict[str, int]]:
        all_skus = sorted({s for skus in locations.values() for s in skus})
        ids = self._item_ids(all_skus)
        targets = {bay: self.target_location(bay) for bay in locations}
        wanted = sorted({t for t in targets.values() if t})
        if not ids or not wanted:
            return {}
        rows = self.suiteql(
            "SELECT item, location, quantityonhand FROM InventoryItemLocations "
            f"WHERE item IN ({', '.join(ids.values())}) "
            f"AND location IN ({', '.join(str(int(w)) for w in wanted)})"
        )
        stock = {(str(r["item"]), str(r["location"])): int(float(r.get("quantityonhand") or 0))
                 for r in rows}
        out: dict[str, dict[str, int]] = {}
        for bay, skus in locations.items():
            loc = targets.get(bay)
            if not loc:
                continue
            out[bay] = {sku: stock.get((ids[sku], str(loc)), 0) for sku in skus if sku in ids}
        return out

    def push_adjustments(self, adjustments: list[Adjustment]) -> list[PostResult]:
        ids = self._item_ids(sorted({a.sku for a in adjustments}))
        results: list[PostResult] = []
        # One adjustment record per NetSuite location keeps each posting
        # self-contained and easy to find in NetSuite by its memo.
        groups: dict[str, list[Adjustment]] = {}
        for adj in adjustments:
            loc = self.target_location(adj.location)
            if not loc:
                results.append(PostResult(adj.adjustment_id, False,
                                          error=f"no NetSuite location mapped for {adj.location}"))
            elif adj.sku not in ids:
                results.append(PostResult(adj.adjustment_id, False,
                                          error=f"NetSuite has no item {adj.sku}"))
            else:
                groups.setdefault(loc, []).append(adj)
        url = f"{self._host}/services/rest/record/v1/inventoryAdjustment"
        for loc, adjs in groups.items():
            body: dict[str, Any] = {
                "account": {"id": str(self.settings["adjustment_account"])},
                "adjLocation": {"id": str(loc)},
                "memo": "Countbone cycle count: " + ", ".join(a.adjustment_id for a in adjs)[:900],
                "inventory": {"items": [
                    {"item": {"id": ids[a.sku]}, "location": {"id": str(loc)},
                     "adjustQtyBy": a.delta, "memo": a.note[:200] if a.note else a.adjustment_id}
                    for a in adjs
                ]},
            }
            if self.settings.get("subsidiary"):
                body["subsidiary"] = {"id": str(self.settings["subsidiary"])}
            response = self.client.post(url, json=body, headers=self._headers("POST", url))
            if response.status_code in (200, 201, 204):
                # NetSuite answers 204 with the new record's URL in Location.
                ref = response.headers.get("Location", "").rsplit("/", 1)[-1] or None
                results += [PostResult(a.adjustment_id, True, external_ref=ref) for a in adjs]
            else:
                err = response.text[:300]
                results += [PostResult(a.adjustment_id, False, error=f"HTTP {response.status_code} {err}")
                            for a in adjs]
        return results

    def pull_purchase_order(self, po_number: str) -> PurchaseOrder:
        safe = po_number.replace("'", "''")
        rows = self.suiteql(
            "SELECT t.tranid, BUILTIN.DF(t.entity) AS vendor, i.itemid, tl.quantity, tl.rate "
            "FROM transaction t JOIN transactionline tl ON tl.transaction = t.id "
            "JOIN item i ON i.id = tl.item "
            f"WHERE t.type = 'PurchOrd' AND t.tranid = '{safe}' AND tl.mainline = 'F'"
        )
        if not rows:
            raise IntegrationError(f"NetSuite has no purchase order {po_number}")
        lines: dict[str, dict[str, Any]] = {}
        for r in rows:
            sku = r["itemid"]
            line = lines.setdefault(sku, {"qty": 0, "unit_cost": float(r.get("rate") or 0)})
            line["qty"] += abs(int(float(r.get("quantity") or 0)))
        return PurchaseOrder(po_number=po_number, supplier=rows[0].get("vendor"), lines=lines)
