"""End-to-end: does video in, counts out, actually work?"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from countbone.config import Config
from countbone.pipeline import Pipeline, run_video
from countbone.stages import capture


def test_counts_synthetic_shelf_within_tolerance(demo_scene, config):
    result = Pipeline(config).run(demo_scene.path)

    # The contour+tracking baseline should land close to truth on clean
    # synthetic footage. This is the regression guard for the whole backbone.
    error = abs(result.total - demo_scene.total)
    assert error <= 0.15 * demo_scene.total, (
        f"counted {result.total}, truth {demo_scene.total}"
    )
    assert result.frames_used > 0
    assert result.tracks > 0
    assert 0.0 <= result.overall_confidence <= 1.0
    assert {c.sku for c in result.counts} <= set(demo_scene.truth) | {"UNKNOWN"}


def test_per_sku_counts_are_close(demo_scene, config):
    result = Pipeline(config).run(demo_scene.path)
    counted = {c.sku: c.count for c in result.counts}
    for sku, truth in demo_scene.truth.items():
        assert abs(counted.get(sku, 0) - truth) <= max(2, int(0.3 * truth)), (
            f"{sku}: counted {counted.get(sku, 0)}, truth {truth}"
        )


def test_writes_all_artifacts(demo_scene, config):
    result = Pipeline(config).run(demo_scene.path)
    run_dir = Path(config.output.dir) / result.run_id

    assert (run_dir / "result.json").is_file()
    assert (run_dir / "counts.csv").is_file()
    assert (run_dir / "exceptions.md").is_file()
    assert (run_dir / "audit_pack.json").is_file()

    payload = json.loads((run_dir / "result.json").read_text(encoding="utf-8"))
    assert payload["run_id"] == result.run_id
    assert payload["total"] == result.total


def test_audit_pack_hashes_the_source(demo_scene, config):
    result = Pipeline(config).run(demo_scene.path)
    pack = json.loads(
        (Path(config.output.dir) / result.run_id / "audit_pack.json").read_text("utf-8")
    )
    assert len(pack["manifest_sha256"]) == 64
    assert len(pack["manifest"]["source"]["source_sha256"]) == 64
    assert pack["manifest"]["result"]["total"] == result.total
    # Every artifact written before the pack is hashed into it.
    assert "result.json" in pack["manifest"]["artifacts"]


def test_run_is_recorded_in_the_store(demo_scene, config):
    pipeline = Pipeline(config)
    result = pipeline.run(demo_scene.path)

    stored = pipeline.store.get_run(result.run_id)
    assert stored is not None
    assert stored["total"] == result.total
    assert len(stored["counts"]) == len(result.counts)
    assert stored["config_fingerprint"] == config.fingerprint()


def test_a_stored_run_already_carries_its_audit_trail(demo_scene, config):
    """Regression: a run must not become readable before its outputs exist.

    The store row used to be written inside the output stage, so a reader
    could see a finished run whose exception report and audit pack had not
    been produced yet.
    """
    pipeline = Pipeline(config)
    result = pipeline.run(demo_scene.path)

    stored = pipeline.store.get_run(result.run_id)
    assert stored["meta"]["audit"]["manifest_sha256"]
    kinds = {a["kind"] for a in pipeline.store.audit_trail(result.run_id)}
    assert {"exception_report", "audit_pack"} <= kinds


def test_same_config_gives_the_same_answer(demo_scene, config):
    first = Pipeline(config).run(demo_scene.path)
    second = Pipeline(config).run(demo_scene.path)
    assert {c.sku: c.count for c in first.counts} == {c.sku: c.count for c in second.counts}
    assert first.run_id != second.run_id


@pytest.mark.parametrize("strategy", ["tracking", "peak_frame", "median_frame"])
def test_every_counting_strategy_runs(demo_scene, config, strategy):
    config.count.strategy = strategy
    result = Pipeline(config).run(demo_scene.path)
    assert result.total > 0
    assert all(c.evidence["strategy"] == strategy for c in result.counts)


def test_missing_video_is_a_clear_error(config):
    with pytest.raises(capture.CaptureError, match="not found"):
        Pipeline(config).run("does-not-exist.mp4")


def test_run_video_helper(demo_scene, tmp_path):
    cfg = Config()
    cfg.output.dir = str(tmp_path / "runs")
    cfg.output.sqlite = str(tmp_path / "db.sqlite")
    result = run_video(demo_scene.path, cfg, run_id="run_fixed")
    assert result.run_id == "run_fixed"
    assert result.total > 0
