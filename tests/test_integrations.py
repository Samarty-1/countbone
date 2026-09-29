"""Connectors, against mock servers that check the requests each system
documents: Shopify Admin GraphQL, NetSuite REST (OAuth 1.0a TBA), SAP
S/4HANA OData, the signed webhook, and CSV import/export."""

from __future__ import annotations

import json

import httpx
import pytest

from countbone.integrations import Adjustment, IntegrationError, build, csvio
from countbone.integrations.netsuite import oauth1_header
from countbone.integrations.webhook import sign, verify


def client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


# -- Shopify ------------------------------------------------------------------------------------
def test_shopify_posts_a_delta_with_compare_and_set_and_an_idempotency_key():
    calls = []

    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/admin/api/2026-07/graphql.json"
        assert req.headers["X-Shopify-Access-Token"] == "shpat_x"
        body = json.loads(req.content)
        calls.append(body)
        if "productVariants" in body["query"]:
            assert body["variables"]["q"] == 'sku:"SKU-RED"'
            return httpx.Response(200, json={"data": {"productVariants": {"nodes": [{
                "sku": "SKU-RED", "inventoryItem": {"id": "gid://shopify/InventoryItem/1",
                "inventoryLevel": {"quantities": [{"name": "available", "quantity": 40}]}}}]}}})
        assert "@idempotent(key: $idempotencyKey)" in body["query"]
        return httpx.Response(200, json={"data": {"inventorySetQuantities": {
            "inventoryAdjustmentGroup": {"id": "gid://shopify/InventoryAdjustmentGroup/9"},
            "userErrors": []}}})

    shop = build("shopify", {"shop": "acme.myshopify.com",
                             "default_location": "gid://shopify/Location/5"},
                 {"access_token": "shpat_x"}, client(handler))
    [res] = shop.push_adjustments([Adjustment("adj_1", "A1", "SKU-RED", 43, 40, -3)])
    assert res.ok and res.external_ref.endswith("/9")
    mutation = calls[-1]
    assert mutation["variables"]["idempotencyKey"] == "adj_1"
    qty = mutation["variables"]["input"]["quantities"][0]
    # The bay's delta is applied to the store's live number, guarded by it.
    assert qty == {"inventoryItemId": "gid://shopify/InventoryItem/1",
                   "locationId": "gid://shopify/Location/5", "quantity": 37,
                   "changeFromQuantity": 40}
    assert mutation["variables"]["input"]["reason"] == "cycle_count_available"


def test_shopify_user_errors_fail_the_adjustment_not_the_batch():
    def handler(req):
        body = json.loads(req.content)
        if "productVariants" in body["query"]:
            return httpx.Response(200, json={"data": {"productVariants": {"nodes": []}}})
        raise AssertionError("no mutation without a variant")

    shop = build("shopify", {"shop": "a.myshopify.com", "default_location": "L"},
                 {"access_token": "t"}, client(handler))
    [res] = shop.push_adjustments([Adjustment("adj_2", None, "NOPE", 1, 0, -1)])
    assert not res.ok and "no variant" in res.error


def test_shopify_refuses_per_bay_book_stock_for_shared_locations():
    shop = build("shopify", {"shop": "a.myshopify.com", "default_location": "L"},
                 {"access_token": "t"}, client(lambda r: httpx.Response(500)))
    with pytest.raises(IntegrationError, match="share one with another bay"):
        shop.pull_expected({"A1": ["X"], "A2": ["X"]})


def test_missing_settings_are_reported_by_name():
    with pytest.raises(IntegrationError, match="access_token"):
        build("shopify", {"shop": "a", "default_location": "L"}, {})


# -- NetSuite ----------------------------------------------------------------------------------
def test_netsuite_oauth_signature_matches_the_reference_implementation():
    oauthlib = pytest.importorskip("oauthlib.oauth1")
    url = "https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql?limit=1000&offset=0"
    ours = oauth1_header("POST", url, "1234567_SB1", "ck", "cs", "tk", "ts",
                         nonce="abc123", timestamp="1700000000")
    ref = oauthlib.Client("ck", client_secret="cs", resource_owner_key="tk",
                          resource_owner_secret="ts", signature_method="HMAC-SHA256",
                          realm="1234567_SB1", nonce="abc123", timestamp="1700000000")
    _, headers, _ = ref.sign(url, http_method="POST")

    def sig(h: str) -> str:
        return h.split('oauth_signature="')[1].split('"')[0]

    assert sig(ours) == sig(headers["Authorization"])


def test_netsuite_posts_one_adjustment_record_per_location():
    posted = []

    def handler(req: httpx.Request) -> httpx.Response:
        assert req.headers["Authorization"].startswith('OAuth realm="1234567_SB1"')
        if req.url.path.endswith("/suiteql"):
            assert req.headers["Prefer"] == "transient"
            q = json.loads(req.content)["q"]
            assert "FROM item WHERE itemid IN ('SKU-RED', 'SKU-YEL')" in q
            return httpx.Response(200, json={"items": [{"id": 11, "itemid": "SKU-RED"},
                                                       {"id": 12, "itemid": "SKU-YEL"}],
                                             "hasMore": False})
        assert req.url.path == "/services/rest/record/v1/inventoryAdjustment"
        posted.append(json.loads(req.content))
        return httpx.Response(204, headers={
            "Location": "https://x/services/rest/record/v1/inventoryAdjustment/555"})

    ns = build("netsuite", {"account_id": "1234567_SB1", "adjustment_account": "300",
                            "default_location": "7", "subsidiary": "1"},
               {"consumer_key": "ck", "consumer_secret": "cs", "token_id": "tk",
                "token_secret": "ts"}, client(handler))
    res = ns.push_adjustments([Adjustment("adj_a", "A1", "SKU-RED", 10, 8, -2),
                               Adjustment("adj_b", "A2", "SKU-YEL", 3, 4, 1)])
    assert all(r.ok and r.external_ref == "555" for r in res)
    [record] = posted
    assert record["account"] == {"id": "300"} and record["adjLocation"] == {"id": "7"}
    assert record["subsidiary"] == {"id": "1"}
    lines = {i["item"]["id"]: i["adjustQtyBy"] for i in record["inventory"]["items"]}
    assert lines == {"11": -2, "12": 1}


def test_netsuite_reads_a_purchase_order():
    def handler(req):
        q = json.loads(req.content)["q"]
        assert "t.type = 'PurchOrd'" in q and "t.tranid = 'PO''7'" in q  # quote escaped
        return httpx.Response(200, json={"items": [
            {"tranid": "PO'7", "vendor": "Acme", "itemid": "SKU-RED", "quantity": "10", "rate": "4.5"},
            {"tranid": "PO'7", "vendor": "Acme", "itemid": "SKU-RED", "quantity": "2", "rate": "4.5"},
        ], "hasMore": False})

    ns = build("netsuite", {"account_id": "1", "adjustment_account": "3", "default_location": "7"},
               {"consumer_key": "a", "consumer_secret": "b", "token_id": "c", "token_secret": "d"},
               client(handler))
    po = ns.pull_purchase_order("PO'7")
    assert po.supplier == "Acme" and po.lines == {"SKU-RED": {"qty": 12, "unit_cost": 4.5}}


# -- SAP ---------------------------------------------------------------------------------------
def test_sap_creates_counts_and_posts_a_physical_inventory_document():
    seen = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append((req.method, req.url.path, dict(req.headers)))
        path = req.url.path
        if req.method == "GET" and req.headers.get("x-csrf-token") == "Fetch":
            return httpx.Response(200, headers={"x-csrf-token": "tok123"})
        if req.method == "POST" and path.endswith("/A_PhysInventoryDocHeader"):
            assert req.headers["x-csrf-token"] == "tok123"
            body = json.loads(req.content)
            assert body["Plant"] == "1010" and body["StorageLocation"] == "0001"
            mats = [i["Material"] for i in body["to_PhysicalInventoryDocumentItem"]["results"]]
            assert mats == ["SKU-RED"]
            return httpx.Response(201, json={"d": {"FiscalYear": "2026",
                                                   "PhysicalInventoryDocument": "100000123",
                                                   "to_PhysicalInventoryDocumentItem": {"results": [
                                                       {"Material": "SKU-RED",
                                                        "PhysicalInventoryDocumentItem": "1"}]}}})
        if req.method == "GET" and path.endswith("/A_MatlStkInAcctMod"):
            assert "Material eq 'SKU-RED'" in req.url.params["$filter"]
            return httpx.Response(200, json={"d": {"results": [
                {"MatlWrhsStkQtyInMatlBaseUnit": "10.000"}]}})
        if req.method == "GET" and "A_PhysInventoryDocItem" in path:
            return httpx.Response(200, headers={"etag": 'W/"x1"'}, json={"d": {}})
        if req.method == "PATCH":
            assert req.headers["If-Match"] == 'W/"x1"'
            body = json.loads(req.content)
            assert body == {"QuantityInUnitOfEntry": "8", "UnitOfEntry": "PC"}  # the count, not the delta
            return httpx.Response(204)
        if req.method == "POST" and path.endswith("/PostDifferences"):
            assert req.url.params["PhysicalInventoryDocument"] == "'100000123'"
            return httpx.Response(200, json={"d": {}})
        raise AssertionError(f"unexpected {req.method} {req.url}")

    sap = build("sap", {"base_url": "https://s4.example.com", "default_location": "1010/0001"},
                {"username": "u", "password": "p"}, client(handler))
    [res] = sap.push_adjustments([Adjustment("adj_s", "A1", "SKU-RED", 10, 8, -2)])
    assert res.ok and res.external_ref == "2026/100000123"
    assert [m for m, _, _ in seen] == ["GET", "GET", "POST", "GET", "PATCH", "POST"]


def sap_server(book: dict[str, int], patched: dict[str, str], created: list[list[str]]):
    """A minimal S/4 physical-inventory service: book stock, one document, counts."""
    def handler(req: httpx.Request) -> httpx.Response:
        path = req.url.path
        if req.headers.get("x-csrf-token") == "Fetch":
            return httpx.Response(200, headers={"x-csrf-token": "t"})
        if path.endswith("/A_MatlStkInAcctMod"):
            sku = req.url.params["$filter"].split("Material eq '")[1].split("'")[0]
            return httpx.Response(200, json={"d": {"results": [
                {"MatlWrhsStkQtyInMatlBaseUnit": str(book[sku])}]}})
        if path.endswith("/A_PhysInventoryDocHeader"):
            mats = [i["Material"] for i in json.loads(req.content)
                    ["to_PhysicalInventoryDocumentItem"]["results"]]
            created.append(mats)
            return httpx.Response(201, json={"d": {
                "FiscalYear": "2026", "PhysicalInventoryDocument": "7",
                "to_PhysicalInventoryDocumentItem": {"results": [
                    {"Material": m, "PhysicalInventoryDocumentItem": str(n + 1)}
                    for n, m in enumerate(mats)]}}})
        if req.method == "GET" and "A_PhysInventoryDocItem" in path:
            return httpx.Response(200, headers={"etag": "e"}, json={"d": {}})
        if req.method == "PATCH":
            item = path.split("PhysicalInventoryDocumentItem='")[1].split("'")[0]
            patched[item] = json.loads(req.content)["QuantityInUnitOfEntry"]
            return httpx.Response(204)
        if path.endswith("/PostDifferences"):
            return httpx.Response(200, json={"d": {}})
        raise AssertionError(f"unexpected {req.method} {req.url}")
    return handler


def test_sap_bays_sharing_a_storage_location_add_up_instead_of_overwriting():
    """Regression: two bays in 1010/0001 each entered their own count of the
    same material, both on one document item, so SAP's book for the whole
    storage location became one bay's count and every other bay's stock went."""
    patched: dict[str, str] = {}
    created: list[list[str]] = []
    sap = build("sap", {"base_url": "https://s4", "default_location": "1010/0001"},
                {"username": "u", "password": "p"},
                client(sap_server({"SKU-RED": 40}, patched, created)))
    res = sap.push_adjustments([Adjustment("adj_1", "A1", "SKU-RED", 10, 8, -2),
                                Adjustment("adj_2", "A2", "SKU-RED", 6, 7, 1)])
    assert all(r.ok for r in res)
    assert created == [["SKU-RED"]]           # one item per material
    assert patched == {"1": "39"}             # 40 on the book, -2 and +1 counted


def test_sap_refuses_a_count_that_would_go_below_zero():
    patched: dict[str, str] = {}
    sap = build("sap", {"base_url": "https://s4", "default_location": "1010/0001"},
                {"username": "u", "password": "p"},
                client(sap_server({"SKU-RED": 1, "SKU-YEL": 5}, patched, [])))
    res = {r.adjustment_id: r for r in sap.push_adjustments([
        Adjustment("adj_r", "A1", "SKU-RED", 4, 0, -4),
        Adjustment("adj_y", "A1", "SKU-YEL", 5, 6, 1)])}
    assert not res["adj_r"].ok and "would leave -3" in res["adj_r"].error
    assert res["adj_y"].ok and patched == {"1": "6"}


@pytest.mark.parametrize("kind,settings,secrets", [
    ("sap", {"base_url": "https://s4", "default_location": "1010/0001"},
     {"username": "u", "password": "p"}),
    ("netsuite", {"account_id": "1", "adjustment_account": "3", "default_location": "7"},
     {"consumer_key": "a", "consumer_secret": "b", "token_id": "c", "token_secret": "d"}),
])
def test_per_location_book_stock_is_refused_for_bays_sharing_a_location(kind, settings, secrets):
    """Regression: each bay got the whole location's quantity as its book, so
    every bay showed a phantom shortage and raised an adjustment for it."""
    conn = build(kind, settings, secrets, client(lambda r: httpx.Response(500)))
    with pytest.raises(IntegrationError, match="A1, A2"):
        conn.pull_expected({"A1": ["X"], "A2": ["X"]})
    # One bay at a time cannot slip past: the check knows every bay there is.
    with pytest.raises(IntegrationError, match="A1"):
        conn.pull_expected({"A1": ["X"]}, known=["A1", "A2"])


def test_a_bay_mapped_to_its_own_location_still_pulls_alongside_shared_ones():
    shop = build("shopify", {"shop": "a.myshopify.com", "default_location": "L",
                             "location_map": {"B1": "L2"}},
                 {"access_token": "t"}, client(lambda r: httpx.Response(200, json={"data": {
                     "productVariants": {"nodes": [{"sku": "X", "inventoryItem": {
                         "id": "i", "inventoryLevel": {"quantities": [
                             {"name": "available", "quantity": 3}]}}}]}}})))
    assert shop.pull_expected({"B1": ["X"]}, known=["A1", "A2", "B1"]) == {"B1": {"X": 3}}


def test_sap_without_a_mapping_fails_that_adjustment():
    sap = build("sap", {"base_url": "https://s4", "default_location": "bad"},
                {"username": "u", "password": "p"}, client(lambda r: httpx.Response(500)))
    [res] = sap.push_adjustments([Adjustment("adj_x", "A1", "M", 1, 0, -1)])
    assert not res.ok and "PLANT/STORAGE_LOCATION" in res.error


# -- webhook and CSV ------------------------------------------------------------------------------
def test_webhook_signatures_verify_and_expire():
    body = b'{"event":"x"}'
    header = sign("secret", body)
    assert verify("secret", body, header)
    assert not verify("other", body, header)
    assert not verify("secret", body + b" ", header)
    old = sign("secret", body, timestamp=1_000_000)
    assert not verify("secret", body, old)


def test_csv_import_is_forgiving_about_headers_and_strict_about_values():
    text = "﻿Bay,Item ID,On Hand\nA1,SKU-RED,10\nA1,SKU-RED,2\nA2,SKU-BLU,5\n"
    assert csvio.parse_expected(text) == {"A1": {"SKU-RED": 12}, "A2": {"SKU-BLU": 5}}
    with pytest.raises(IntegrationError, match="line 2"):
        csvio.parse_expected("location,sku,qty\nA1,X,2.5\n")
    with pytest.raises(IntegrationError, match="missing a qty column"):
        csvio.parse_expected("location,sku\nA1,X\n")


def test_csv_export_neutralises_spreadsheet_formulas():
    out = csvio.write_rows([{"note": "=HYPERLINK(\"http://evil\")", "delta": -3}], ["note", "delta"])
    assert "'=HYPERLINK" in out and ",-3" in out
