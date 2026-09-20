"""Config is the whole reproducibility story, so it gets its own tests."""

from __future__ import annotations

import textwrap

import pytest

from countbone.catalog import Catalog, SkuEntry
from countbone.config import Config


def write(tmp_path, body: str):
    path = tmp_path / "config.yaml"
    path.write_text(textwrap.dedent(body), encoding="utf-8")
    return path


def test_defaults_are_usable_with_no_file():
    cfg = Config()
    assert cfg.detect.backend == "contour"
    assert cfg.count.strategy == "tracking"
    assert [p.name for p in cfg.plugins][0] == "quality_gate"


def test_partial_config_keeps_defaults(tmp_path):
    cfg = Config.load(write(tmp_path, """
        count:
          strategy: peak_frame
    """))
    assert cfg.count.strategy == "peak_frame"
    assert cfg.count.min_hits == 2          # untouched default
    assert cfg.detect.backend == "contour"


def test_plugins_accept_a_bare_name(tmp_path):
    cfg = Config.load(write(tmp_path, """
        plugins:
          - confidence
          - audit_pack
    """))
    assert [p.name for p in cfg.plugins] == ["confidence", "audit_pack"]
    assert all(p.enabled for p in cfg.plugins)


def test_plugins_accept_options(tmp_path):
    cfg = Config.load(write(tmp_path, """
        plugins:
          - name: confidence
            options:
              sku_threshold: 0.9
          - name: audit_pack
            enabled: false
    """))
    assert cfg.plugins[0].options["sku_threshold"] == 0.9
    assert cfg.plugins[1].enabled is False


def test_plugins_accept_the_shorthand_mapping(tmp_path):
    cfg = Config.load(write(tmp_path, """
        plugins:
          - review_queue: { max_items: 5 }
    """))
    assert cfg.plugins[0].name == "review_queue"
    assert cfg.plugins[0].options == {"max_items": 5}


def test_a_bad_plugin_entry_is_rejected(tmp_path):
    with pytest.raises(ValueError, match="cannot read plugin spec"):
        Config.load(write(tmp_path, """
            plugins:
              - [not, a, plugin]
        """))


def test_fingerprint_is_stable_and_sensitive():
    a, b = Config(), Config()
    assert a.fingerprint() == b.fingerprint()
    b.count.min_hits = 9
    assert a.fingerprint() != b.fingerprint()


def test_example_config_and_catalog_parse():
    cfg = Config.load("examples/config.example.yaml")
    assert cfg.count.expected["SKU-RED"] == 10
    assert [p.name for p in cfg.plugins][-1] == "audit_pack"

    catalog = Catalog.load("examples/catalog.example.yaml")
    assert len(catalog) == 5
    assert catalog.by_sku("SKU-GREY").achromatic is True


def test_catalog_hue_band_wraps_through_red():
    entry = Catalog.default().by_sku("SKU-RED")
    assert entry.matches_hue(178)   # just below the wrap
    assert entry.matches_hue(3)     # just above it
    assert not entry.matches_hue(90)


def test_catalog_confidence_peaks_at_the_band_centre():
    entry = Catalog.default().by_sku("SKU-BLU")  # hue 95-130, centre 112.5
    assert entry.hue_center_distance(112) < entry.hue_center_distance(128)


def test_a_misspelled_section_is_rejected(tmp_path):
    """Regression: an unknown section used to be dropped, so a config that
    looked applied silently ran on defaults."""
    with pytest.raises(ValueError, match="unknown config section"):
        Config.load(write(tmp_path, """
            capturee:
              every_n_frames: 2
        """))


def test_a_misspelled_option_names_its_section(tmp_path):
    with pytest.raises(ValueError, match="bad option in config section 'count'"):
        Config.load(write(tmp_path, """
            count:
              min_hitz: 4
        """))


def test_shorthand_does_not_leak_enabled_into_options(tmp_path):
    cfg = Config.load(write(tmp_path, """
        plugins:
          - confidence: { enabled: true, sku_threshold: 0.9 }
    """))
    assert cfg.plugins[0].enabled is True
    assert cfg.plugins[0].options == {"sku_threshold": 0.9}


def test_hue_distance_measures_the_short_way_round_the_wheel():
    red = Catalog.default().by_sku("SKU-RED")   # hue 170-10, centre 0
    assert red.hue_distance(2) == pytest.approx(2)
    assert red.hue_distance(178) == pytest.approx(2)   # wraps, not 178 apart


def test_the_two_hue_distances_answer_different_questions():
    """Absolute distance picks the SKU; normalised distance scores confidence."""
    wide = SkuEntry("W", "wide", hue=(90, 140))
    narrow = SkuEntry("N", "narrow", hue=(105, 115))

    assert narrow.hue_distance(107) < wide.hue_distance(107)              # closer centre
    assert narrow.hue_center_distance(107) > wide.hue_center_distance(107)  # nearer its edge
