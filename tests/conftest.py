from __future__ import annotations

import numpy as np
import pytest

from countbone.config import Config
from countbone.types import Detection, Frame


@pytest.fixture(scope="session")
def demo_scene(tmp_path_factory):
    """Synthetic shelf footage with known ground truth, rendered once."""
    from countbone.demo import make_demo_video

    out = tmp_path_factory.mktemp("media") / "shelf.mp4"
    return make_demo_video(out, seed=7)


@pytest.fixture
def config(tmp_path) -> Config:
    cfg = Config()
    cfg.output.dir = str(tmp_path / "runs")
    cfg.output.sqlite = str(tmp_path / "countbone.db")
    return cfg


@pytest.fixture
def blank_frame():
    def _make(index: int = 0, value: int = 140, size=(240, 320)) -> Frame:
        image = np.full((*size, 3), value, dtype=np.uint8)
        return Frame(index=index, source_index=index, timestamp_s=index / 10, image=image)

    return _make


def detection(x: float, y: float, w: float = 40, h: float = 60, score: float = 0.9,
              frame_index: int = 0, **meta) -> Detection:
    return Detection(
        bbox=(x, y, x + w, y + h),
        score=score,
        frame_index=frame_index,
        detector="fixture",
        meta=meta,
    )
