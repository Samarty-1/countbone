"""countbone - a video-to-count backbone with everything else as plugins."""

from .catalog import Catalog, SkuEntry
from .config import Config, PluginSpec
from .context import RunContext
from .pipeline import Pipeline, run_video
from .plugins.base import Plugin, available, register
from .store.db import Store
from .types import CountResult, Detection, Frame, Item, ReviewItem, SkuCount, Track

__version__ = "0.1.0"

__all__ = [
    "Catalog",
    "Config",
    "CountResult",
    "Detection",
    "Frame",
    "Item",
    "Pipeline",
    "Plugin",
    "PluginSpec",
    "ReviewItem",
    "RunContext",
    "SkuCount",
    "SkuEntry",
    "Store",
    "Track",
    "available",
    "register",
    "run_video",
    "__version__",
]
