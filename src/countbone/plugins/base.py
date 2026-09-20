"""Plugin contract and registry.

The backbone never imports a plugin. It calls hooks; plugins register
themselves against those hooks. Adding a capability means writing a class and
naming it in the config, never editing the pipeline.

Hooks, in the order the backbone fires them:

    on_run_start(ctx)                          once, before any frame
    on_frame(ctx, frame)     -> Frame | None   capture layer; None drops the frame
    on_detections(ctx, f, d) -> list[Detection]
    on_items(ctx, f, items)  -> list[Item]     identification layer
    on_tracks(ctx, tracks)   -> list[Track]    after counting has grouped sightings
    on_counts(ctx, result)   -> CountResult    count layer
    on_output(ctx, result)   -> None           output layer, side effects only
    on_run_end(ctx, result)  -> None           always runs, even after a failure
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterable
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover - typing only
    from ..context import RunContext
    from ..types import CountResult, Detection, Frame, Item, Track

log = logging.getLogger(__name__)

_REGISTRY: dict[str, type[Plugin]] = {}


class Plugin:
    """Base class. Override only the hooks you care about."""

    name: str = "plugin"
    layer: str = "pipeline"  # capture | pipeline | output | analytics | process
    priority: int = 100      # lower runs first within a hook

    def __init__(self, **options: Any) -> None:
        self.options = options
        self.configure(**options)

    def configure(self, **options: Any) -> None:
        """Validate and stash options. Raise on bad config; do not fail late."""

    # --- hooks (all no-ops by default) ---------------------------------
    def on_run_start(self, ctx: RunContext) -> None: ...

    def on_frame(self, ctx: RunContext, frame: Frame) -> Frame | None:
        return frame

    def on_detections(
        self, ctx: RunContext, frame: Frame, detections: list[Detection]
    ) -> list[Detection]:
        return detections

    def on_items(
        self, ctx: RunContext, frame: Frame, items: list[Item]
    ) -> list[Item]:
        return items

    def on_tracks(self, ctx: RunContext, tracks: list[Track]) -> list[Track]:
        return tracks

    def on_counts(self, ctx: RunContext, result: CountResult) -> CountResult:
        return result

    def on_output(self, ctx: RunContext, result: CountResult) -> None: ...

    def on_run_end(self, ctx: RunContext, result: CountResult | None) -> None: ...

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<{type(self).__name__} name={self.name!r} layer={self.layer!r}>"


def register(cls: type[Plugin]) -> type[Plugin]:
    """Class decorator: make a plugin loadable by name from the config."""
    name = getattr(cls, "name", None)
    if not name or name == "plugin":
        raise ValueError(f"{cls.__name__} must set a unique `name`")
    if name in _REGISTRY and _REGISTRY[name] is not cls:
        raise ValueError(f"plugin name {name!r} already registered by {_REGISTRY[name].__name__}")
    _REGISTRY[name] = cls
    return cls


def available() -> dict[str, type[Plugin]]:
    _load_builtins()
    return dict(_REGISTRY)


def get(name: str) -> type[Plugin]:
    _load_builtins()
    try:
        return _REGISTRY[name]
    except KeyError:
        known = ", ".join(sorted(_REGISTRY)) or "(none)"
        raise KeyError(f"unknown plugin {name!r}; registered: {known}") from None


def build(specs: Iterable[Any]) -> list[Plugin]:
    """Instantiate plugins from config specs, sorted by priority."""
    plugins: list[Plugin] = []
    for spec in specs:
        if not getattr(spec, "enabled", True):
            continue
        cls = get(spec.name)
        plugins.append(cls(**(spec.options or {})))
    plugins.sort(key=lambda p: p.priority)
    return plugins


def _load_builtins() -> None:
    """Import the shipped plugins once so their decorators run."""
    global _BUILTINS_LOADED
    if _BUILTINS_LOADED:
        return
    _BUILTINS_LOADED = True
    from . import (  # noqa: F401  (imported for the side effect of registering)
        audit_pack,
        confidence,
        exception_report,
        multiframe,
        quality_gate,
        review_queue,
        tolerance,
    )


_BUILTINS_LOADED = False


def fire(
    plugins: list[Plugin],
    hook: str,
    ctx: RunContext,
    *args: Any,
    transform: bool = False,
    allow_drop: bool = False,
) -> Any:
    """Call `hook` on every plugin in priority order.

    Positional args are passed through after `ctx`. When `transform` is set the
    last argument is threaded: each plugin sees the previous plugin's output.
    A plugin that returns None leaves the payload unchanged, unless
    `allow_drop` is set, in which case None means "discard this payload" and
    the chain stops.

    A plugin that raises is logged, recorded on the run, and skipped: one bad
    plugin must not take the backbone down mid-count.
    """
    chain = list(args)
    for plugin in plugins:
        fn: Callable | None = getattr(plugin, hook, None)
        if fn is None:
            continue
        try:
            out = fn(ctx, *chain)
        except Exception as exc:  # noqa: BLE001 - deliberate isolation boundary
            log.exception("plugin %s failed in %s", plugin.name, hook)
            ctx.warn(f"plugin {plugin.name} failed in {hook}: {exc}")
            continue
        if not transform or not chain:
            continue
        if out is None:
            if allow_drop:
                return None
            continue
        chain[-1] = out
    return chain[-1] if chain else None
