"""Business rules on top of the store: what happens when, and who may do it.

The API and the job runner call into here; nothing here knows about HTTP.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover
    from ..catalog import Catalog
    from ..security import Keyring
    from ..store.db import Store


class OpsError(ValueError):
    """A request that breaks a business rule. The message is for people."""


class Forbidden(OpsError):
    """Allowed in principle, but not for this person's role."""


@dataclass
class Services:
    store: Store
    keyring: Keyring
    data_dir: Path
    output_dir: Path
    catalog: Any = None           # () -> Catalog, the live catalog
    http_client: Any = None       # httpx.Client for integrations (tests inject a mock)
    extra: dict[str, Any] = field(default_factory=dict)

    def current_catalog(self) -> Catalog:
        return self.catalog()

    def unit_value(self, sku: str) -> float:
        entry = self.current_catalog().by_sku(sku)
        return float(entry.unit_value) if entry else 0.0
