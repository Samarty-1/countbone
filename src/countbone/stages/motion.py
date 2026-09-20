"""Global camera motion between consecutive sampled frames.

A stock count is usually filmed by a person walking an aisle, so between two
sampled frames the whole scene has slid sideways. Without compensating for
that, the tracker sees every object jump and starts a new track for it, and
the count comes out high. Estimating one global translation per frame is
cheap, robust, and fixes most of that error.

It is a translation-only model: it does not handle rotation, zoom, or a
camera swinging through an arc. Those show up as a weak correlation response,
which the tracker uses to fall back to plain overlap matching.
"""

from __future__ import annotations

import cv2
import numpy as np

WORK_WIDTH = 320  # estimate on a small copy; the shift scales back up


def _prepare(image: np.ndarray) -> tuple[np.ndarray, float]:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
    scale = WORK_WIDTH / gray.shape[1] if gray.shape[1] > WORK_WIDTH else 1.0
    if scale != 1.0:
        gray = cv2.resize(
            gray,
            (int(gray.shape[1] * scale), max(1, int(gray.shape[0] * scale))),
            interpolation=cv2.INTER_AREA,
        )
    return gray.astype(np.float32), scale


class MotionEstimator:
    """Phase-correlation tracker of the camera itself."""

    def __init__(self, min_response: float = 0.12) -> None:
        self.min_response = float(min_response)
        self._prev: np.ndarray | None = None
        self._scale: float = 1.0
        self._window: np.ndarray | None = None

    def update(self, image: np.ndarray) -> dict[str, float]:
        """Return the pixel displacement of scene content since the last frame."""
        current, scale = _prepare(image)
        prev, self._prev, self._scale = self._prev, current, scale

        if prev is None or prev.shape != current.shape:
            return {"dx": 0.0, "dy": 0.0, "response": 0.0, "estimated": False}

        if self._window is None or self._window.shape != current.shape:
            self._window = cv2.createHanningWindow(
                (current.shape[1], current.shape[0]), cv2.CV_32F
            )

        (dx, dy), response = cv2.phaseCorrelate(prev, current, self._window)
        if response < self.min_response:
            return {"dx": 0.0, "dy": 0.0, "response": float(response), "estimated": False}
        # phaseCorrelate gives the shift that maps prev onto current, measured
        # on the downscaled copy; scale it back to full-resolution pixels.
        factor = 1.0 / scale if scale else 1.0
        return {
            "dx": float(dx * factor),
            "dy": float(dy * factor),
            "response": float(response),
            "estimated": True,
        }
