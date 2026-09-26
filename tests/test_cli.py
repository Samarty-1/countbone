"""The command line is how most people will meet this, so it gets tested."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from countbone.cli import main


def base_args(config, tmp_path):
    return ["--out", config.output.dir, "--db", config.output.sqlite]


def test_plugins_command_lists_the_builtins(capsys):
    assert main(["plugins"]) == 0
    out = capsys.readouterr().out
    assert "quality_gate" in out and "audit_pack" in out


def test_run_prints_a_table(demo_scene, config, tmp_path, capsys):
    code = main(["run", demo_scene.path, *base_args(config, tmp_path)])
    out = capsys.readouterr().out

    assert code in (0, 2)  # 2 means "counted, but a human should look"
    assert "TOTAL" in out
    assert "confidence:" in out
    assert "wrote:" in out


def test_a_cli_run_can_be_inspected_in_the_dashboard(demo_scene, config, tmp_path, capsys):
    """Same database as the dashboard, so it must leave the inspector file too."""
    main(["run", demo_scene.path, "--json", *base_args(config, tmp_path)])
    payload = json.loads(capsys.readouterr().out)
    doc = json.loads(
        (Path(config.output.dir) / payload["run_id"] / "inspector.json").read_text(encoding="utf-8")
    )
    assert len(doc["frames"]) == payload["frames_read"]
    assert doc["boxes"]


def test_run_json_output_is_parseable(demo_scene, config, tmp_path, capsys):
    main(["run", demo_scene.path, "--json", *base_args(config, tmp_path)])
    payload = json.loads(capsys.readouterr().out)
    assert payload["total"] > 0
    assert payload["counts"]


def test_expect_flag_drives_variance(demo_scene, config, tmp_path, capsys):
    main([
        "run", demo_scene.path, "--expect", "SKU-RED=99", *base_args(config, tmp_path)
    ])
    out = capsys.readouterr().out
    assert "99" in out


def test_malformed_expect_is_rejected(demo_scene, config, tmp_path):
    with pytest.raises(SystemExit, match="SKU=INTEGER"):
        main(["run", demo_scene.path, "--expect", "SKU-RED=many", *base_args(config, tmp_path)])


def test_missing_video_exits_nonzero(config, tmp_path, capsys):
    assert main(["run", "nope.mp4", *base_args(config, tmp_path)]) == 1
    assert "error:" in capsys.readouterr().err


def test_demo_reports_error_against_truth(config, tmp_path, capsys):
    video = str(tmp_path / "demo.mp4")
    assert main(["demo", "--video", video, *base_args(config, tmp_path)]) == 0
    out = capsys.readouterr().out
    assert "synthetic shelf" in out
    assert "absolute count error" in out
    assert "truth" in out


def test_history_command_reads_the_store(demo_scene, config, tmp_path, capsys):
    main(["run", demo_scene.path, *base_args(config, tmp_path)])
    capsys.readouterr()

    assert main(["history", "SKU-RED", "--db", config.output.sqlite]) == 0
    out = capsys.readouterr().out
    assert "SKU-RED" not in out.split("\n")[0]  # header row, not the sku
    assert "counts, mean" in out


def test_history_for_an_unseen_sku_exits_one(config, capsys):
    assert main(["history", "SKU-NOPE", "--db", config.output.sqlite]) == 1
    assert "no counts recorded" in capsys.readouterr().out


def test_reviews_command_lists_the_queue(demo_scene, config, tmp_path, capsys):
    main(["run", demo_scene.path, *base_args(config, tmp_path)])
    capsys.readouterr()

    assert main(["reviews", "--db", config.output.sqlite]) == 0
    out = capsys.readouterr().out
    assert "review_id" in out or "no reviews" in out
