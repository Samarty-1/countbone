"""CSV in and out: the integration every customer already has.

Imports are forgiving about headers (case, spaces, common synonyms) and
strict about values: a bad row is reported by line number, never skipped
in silence.
"""

from __future__ import annotations

import csv
import io
from typing import Any

from .base import IntegrationError

_SYNONYMS = {
    "location": {"location", "bay", "bin", "location_code", "loc", "shelf"},
    "sku": {"sku", "item", "itemid", "item_id", "product", "material", "code"},
    "qty": {"qty", "quantity", "on_hand", "onhand", "expected", "count", "units"},
    "unit_cost": {"unit_cost", "cost", "price", "rate", "unit_price"},
    "unit_value": {"unit_value", "value"},
    "label": {"label", "name", "description", "title"},
    "po_number": {"po", "po_number", "purchase_order", "order"},
    "supplier": {"supplier", "vendor"},
    "barcode": {"barcode", "ean", "upc", "gtin"},
}


def _header_map(fieldnames: list[str]) -> dict[str, str]:
    out = {}
    for raw in fieldnames:
        key = raw.strip().lower().replace(" ", "_").replace("-", "_")
        for canonical, names in _SYNONYMS.items():
            if key in names and canonical not in out:
                out[canonical] = raw
    return out


def _reader(text: str) -> tuple[csv.DictReader, dict[str, str]]:
    text = text.lstrip("﻿")  # Excel's BOM
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        raise IntegrationError("the file is empty")
    return reader, _header_map(reader.fieldnames)


def _int(value: str, line: int, column: str) -> int:
    try:
        f = float(str(value).strip().replace(",", ""))
    except ValueError:
        raise IntegrationError(f"line {line}: {column} {value!r} is not a number") from None
    if f != int(f):
        raise IntegrationError(f"line {line}: {column} {value!r} is not a whole number")
    return int(f)


def parse_expected(text: str) -> dict[str, dict[str, int]]:
    """location,sku,qty rows -> {location: {sku: qty}}."""
    reader, cols = _reader(text)
    for need in ("location", "sku", "qty"):
        if need not in cols:
            raise IntegrationError(f"missing a {need} column (found {', '.join(reader.fieldnames or [])})")
    out: dict[str, dict[str, int]] = {}
    for n, row in enumerate(reader, start=2):
        loc, sku = (row.get(cols["location"]) or "").strip(), (row.get(cols["sku"]) or "").strip()
        if not loc and not sku:
            continue
        if not loc or not sku:
            raise IntegrationError(f"line {n}: location and sku are both required")
        qty = _int(row.get(cols["qty"]) or "", n, "qty")
        if qty < 0:
            raise IntegrationError(f"line {n}: qty cannot be negative")
        out.setdefault(loc, {})[sku] = out.get(loc, {}).get(sku, 0) + qty
    return out


def parse_po_lines(text: str) -> dict[str, dict[str, Any]]:
    """sku,qty[,unit_cost] rows -> {sku: {qty, unit_cost}}."""
    reader, cols = _reader(text)
    for need in ("sku", "qty"):
        if need not in cols:
            raise IntegrationError(f"missing a {need} column")
    out: dict[str, dict[str, Any]] = {}
    for n, row in enumerate(reader, start=2):
        sku = (row.get(cols["sku"]) or "").strip()
        if not sku:
            continue
        qty = _int(row.get(cols["qty"]) or "", n, "qty")
        cost = 0.0
        if "unit_cost" in cols and (row.get(cols["unit_cost"]) or "").strip():
            try:
                cost = float(str(row[cols["unit_cost"]]).replace(",", ""))
            except ValueError:
                raise IntegrationError(f"line {n}: unit_cost is not a number") from None
        line = out.setdefault(sku, {"qty": 0, "unit_cost": cost})
        line["qty"] += qty
    if not out:
        raise IntegrationError("no lines found")
    return out


def parse_skus(text: str) -> list[dict[str, Any]]:
    """sku,label[,unit_value][,barcode] rows, for bulk catalog setup."""
    reader, cols = _reader(text)
    if "sku" not in cols:
        raise IntegrationError("missing a sku column")
    out = []
    for n, row in enumerate(reader, start=2):
        sku = (row.get(cols["sku"]) or "").strip()
        if not sku:
            continue
        item: dict[str, Any] = {"sku": sku, "label": (row.get(cols.get("label", ""), "") or sku).strip()}
        if "unit_value" in cols or "unit_cost" in cols:
            raw = row.get(cols.get("unit_value") or cols["unit_cost"]) or "0"
            try:
                item["unit_value"] = float(str(raw).replace(",", "") or 0)
            except ValueError:
                raise IntegrationError(f"line {n}: unit value is not a number") from None
        if "barcode" in cols and (row.get(cols["barcode"]) or "").strip():
            item["barcodes"] = [row[cols["barcode"]].strip()]
        out.append(item)
    return out


def write_rows(rows: list[dict[str, Any]], columns: list[str]) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(columns)
    for r in rows:
        writer.writerow(["" if r.get(c) is None else _cell(r.get(c)) for c in columns])
    return buf.getvalue()


def _cell(value: Any) -> Any:
    # Neutralise spreadsheet formula injection: a cell starting with = + - @
    # is executed by Excel when the export is opened.
    if isinstance(value, str) and value[:1] in ("=", "+", "-", "@") and not _numeric(value):
        return "'" + value
    return value


def _numeric(value: str) -> bool:
    try:
        float(value)
        return True
    except ValueError:
        return False
