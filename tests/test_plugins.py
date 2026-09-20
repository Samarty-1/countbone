"""The plugin contract: registration, ordering, isolation, and the hooks."""

from __future__ import annotations

import numpy as np
import pytest

from countbone.config import Config, PluginSpec
from countbone.context import RunContext
from countbone.pipeline import Pipeline
from countbone.plugins import base as plugin_base
from countbone.plugins.base import Plugin, register
from countbone.plugins.quality_gate import QualityGate
from countbone.plugins.tolerance import ToleranceRules
from countbone.types import CountResult, SkuCount


# -- registry --------------------------------------------------------------
def test_builtins_are_registered():
    names = set(plugin_base.available())
    assert {
        "quality_gate", "multiframe", "confidence",
        "review_queue", "exception_report", "audit_pack", "tolerance",
    } <= names


def test_unknown_plugin_names_are_listed_in_the_error():
    with pytest.raises(KeyError, match="quality_gate"):
        plugin_base.get("no_such_plugin")


def test_a_plugin_must_be_named():
    with pytest.raises(ValueError, match="unique"):
        register(type("Anon", (Plugin,), {}))


def test_plugins_run_in_priority_order():
    built = plugin_base.build(
        [PluginSpec("audit_pack"), PluginSpec("quality_gate"), PluginSpec("confidence")]
    )
    assert [p.name for p in built] == ["quality_gate", "confidence", "audit_pack"]


def test_disabled_plugins_are_not_built():
    built = plugin_base.build(
        [PluginSpec("quality_gate", enabled=False), PluginSpec("confidence")]
    )
    assert [p.name for p in built] == ["confidence"]


# -- isolation -------------------------------------------------------------
def test_a_failing_plugin_does_not_stop_the_run(demo_scene, config):
    class Exploding(Plugin):
        name = "test_exploding"
        priority = 5

        def on_counts(self, ctx, result):
            raise RuntimeError("boom")

    register(Exploding)
    config.plugins.append(PluginSpec("test_exploding"))
    result = Pipeline(config).run(demo_scene.path)

    assert result.total > 0
    assert any("test_exploding" in w and "boom" in w for w in result.warnings)


def test_a_plugin_returning_none_leaves_the_payload_alone():
    class Forgetful(Plugin):
        name = "test_forgetful"

        def on_counts(self, ctx, result):
            return None

    ctx = RunContext(config=Config(), source="x")
    result = CountResult(run_id="r", source="x", counts=[SkuCount("A", 3)])
    out = plugin_base.fire([Forgetful()], "on_counts", ctx, result, transform=True)
    assert out is result


def test_hooks_thread_the_payload_through_in_order():
    class Adder(Plugin):
        name = "test_adder"

        def __init__(self, tag, priority):
            self.tag = tag
            self.priority = priority
            super().__init__()

        def on_counts(self, ctx, result):
            result.warnings.append(self.tag)
            return result

    ctx = RunContext(config=Config(), source="x")
    result = CountResult(run_id="r", source="x")
    plugins = sorted([Adder("second", 20), Adder("first", 10)], key=lambda p: p.priority)
    plugin_base.fire(plugins, "on_counts", ctx, result, transform=True)
    assert result.warnings == ["first", "second"]


# -- capture layer ---------------------------------------------------------
def test_quality_gate_drops_blurred_frames(blank_frame):
    from countbone.config import PreprocessConfig
    from countbone.stages import preprocess

    gate = QualityGate(min_blur=50.0)
    ctx = RunContext(config=Config(), source="x")
    gate.on_run_start(ctx)

    flat = preprocess.apply(blank_frame(), PreprocessConfig(clahe=False))
    assert gate.on_frame(ctx, flat) is None  # a flat frame has no edges at all
    assert ctx.state["quality"]["reasons"] == {"blurred": 1}


def test_quality_gate_keeps_a_sharp_frame():
    from countbone.config import PreprocessConfig
    from countbone.stages import preprocess
    from countbone.types import Frame

    rng = np.random.default_rng(0)
    image = (rng.random((240, 320, 3)) * 255).astype(np.uint8)
    frame = preprocess.apply(
        Frame(index=0, source_index=0, timestamp_s=0.0, image=image),
        PreprocessConfig(clahe=False),
    )
    gate = QualityGate()
    ctx = RunContext(config=Config(), source="x")
    gate.on_run_start(ctx)
    assert gate.on_frame(ctx, frame) is frame


def test_quality_gate_warns_when_most_footage_is_unusable():
    gate = QualityGate(max_drop_rate=0.4)
    ctx = RunContext(config=Config(), source="x")
    ctx.state["quality"] = {"seen": 10, "dropped": 8, "reasons": {"blurred": 8}, "scores": []}
    result = gate.on_counts(ctx, CountResult(run_id="r", source="x"))
    assert result.needs_review
    assert any("re-shoot" in w for w in result.warnings)


# -- analytics layer -------------------------------------------------------
def test_tolerance_bands_scale_with_unit_value():
    rules = ToleranceRules()
    assert rules.band_for(2.0)["abs"] == 2       # cheap stock, slack allowed
    assert rules.band_for(50.0)["abs"] == 1
    assert rules.band_for(5000.0)["abs"] == 0    # expensive stock, none allowed


def test_tolerance_flags_a_breach_and_prices_it():
    from countbone.catalog import Catalog, SkuEntry

    ctx = RunContext(config=Config(), source="x")
    ctx.state["catalog"] = Catalog([SkuEntry("SKU-X", "Widget", unit_value=500.0)])
    result = CountResult(
        run_id="r", source="x", counts=[SkuCount("SKU-X", count=8, expected=10)]
    )
    out = ToleranceRules().on_counts(ctx, result)

    breach = out.counts[0].evidence["tolerance"]
    assert breach["within_tolerance"] is False
    assert breach["value_at_risk"] == 1000.0
    assert out.needs_review
    assert out.meta["tolerance_exceptions"][0]["variance"] == -2


def test_tolerance_ignores_skus_with_no_expected_count():
    ctx = RunContext(config=Config(), source="x")
    result = CountResult(run_id="r", source="x", counts=[SkuCount("SKU-X", count=8)])
    out = ToleranceRules().on_counts(ctx, result)
    assert "tolerance" not in out.counts[0].evidence
    assert not out.needs_review
