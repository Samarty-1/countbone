"""The run context: the one object every stage and plugin can see.

It carries the config, the run identity, where artifacts go, and a shared
`state` dict plugins use to pass data to each other without importing each
other (quality_gate writes frame scores, confidence reads them).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .config import Config
from .types import new_id

if TYPE_CHECKING:  # pragma: no cover
    from .store.db import Store

log = logging.getLogger(__name__)


@dataclass
class RunContext:
    config: Config
    source: str
    run_id: str = field(default_factory=lambda: new_id("run"))
    store: Store | None = None
    state: dict[str, Any] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    _artifacts: Path | None = None

    @property
    def artifacts_dir(self) -> Path:
        """Per-run directory for crops, reports and the audit pack."""
        if self._artifacts is None:
            path = Path(self.config.output.dir) / self.run_id
            path.mkdir(parents=True, exist_ok=True)
            self._artifacts = path
        return self._artifacts

    def warn(self, message: str) -> None:
        if message not in self.warnings:
            self.warnings.append(message)
        log.warning("[%s] %s", self.run_id, message)

    def setdefault(self, key: str, factory) -> Any:
        if key not in self.state:
            self.state[key] = factory()
        return self.state[key]
