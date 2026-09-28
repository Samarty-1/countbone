"""Generic webhook: approved adjustments, POSTed as signed JSON.

For any system without a dedicated connector (a WMS, a custom ERP, Zapier,
a data warehouse). The receiver verifies the body with the shared secret:

    expected = hex(HMAC-SHA256(secret, f"{timestamp}.{raw_body}"))
    compare with the X-Countbone-Signature header ("t=<timestamp>,v1=<hex>")

and should reject timestamps more than a few minutes old (replay).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any

from .base import Adjustment, Connector, PostResult


def sign(secret: str, body: bytes, timestamp: int | None = None) -> str:
    ts = int(timestamp or time.time())
    mac = hmac.new(secret.encode(), f"{ts}.".encode() + body, hashlib.sha256).hexdigest()
    return f"t={ts},v1={mac}"


def verify(secret: str, body: bytes, header: str, tolerance_s: int = 300) -> bool:
    try:
        parts = dict(p.split("=", 1) for p in header.split(","))
        ts = int(parts["t"])
    except (ValueError, KeyError):
        return False
    if abs(time.time() - ts) > tolerance_s:
        return False
    return hmac.compare_digest(sign(secret, body, ts), header)


class WebhookConnector(Connector):
    kind = "webhook"
    label = "Webhook"
    can_push_adjustments = True
    settings_fields = [{"key": "url", "label": "HTTPS endpoint", "required": "1"}]
    secret_fields = [{"key": "secret", "label": "Signing secret", "required": "1"}]

    def _send(self, event: str, data: dict[str, Any]) -> tuple[bool, str | None]:
        body = json.dumps({"event": event, "sent_at": time.time(), "data": data},
                          separators=(",", ":")).encode()
        response = self.client.post(
            self.settings["url"],
            content=body,
            headers={"Content-Type": "application/json",
                     "X-Countbone-Event": event,
                     "X-Countbone-Signature": sign(self.secrets["secret"], body)},
        )
        if response.is_success:
            return True, None
        return False, f"HTTP {response.status_code} {response.text[:200]}"

    def test(self) -> dict[str, Any]:
        ok, err = self._send("ping", {})
        return {"ok": ok, "detail": err or "endpoint accepted a signed ping"}

    def push_adjustments(self, adjustments: list[Adjustment]) -> list[PostResult]:
        ok, err = self._send("adjustments.approved", {"adjustments": [a.__dict__ for a in adjustments]})
        return [PostResult(a.adjustment_id, ok, external_ref=None, error=err) for a in adjustments]
