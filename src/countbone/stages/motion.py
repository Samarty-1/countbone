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
        self._hist: np.ndarray | None = None
        self._scale: float = 1.0
        self._window: np.ndarray | None = None

    def update(self, image: np.ndarray) -> dict[str, float]:
        """Return the pixel displacement of scene content since the last frame."""
        current, scale = _prepare(image)
        # A scene cut (the camera swung from the bay's label to the shelf, or
        # was pointed at the floor) is not motion: nothing on one side of it
        # is the same object as anything on the other. Grey-level histograms
        # of the two frames barely agree across a cut, and stay close under
        # any pan, blur or exposure drift. Measured on a tiny, smoothed copy:
        # at full detail a motion-blurred frame's histogram differs from a
        # sharp one's almost as much as a cut does (0.3 against -0.1 on the
        # synthetic shelf); smoothed, blur scores 0.9+ and a cut stays near 0.
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
        tiny = cv2.GaussianBlur(cv2.resize(gray, (64, 36), interpolation=cv2.INTER_AREA), (9, 9), 0)
        hist = cv2.calcHist([tiny], [0], None, [16], [0, 256])
        prev, self._prev, self._scale = self._prev, current, scale
        prev_hist, self._hist = self._hist, hist

        if prev is None or prev.shape != current.shape:
            return {"dx": 0.0, "dy": 0.0, "response": 0.0, "estimated": False, "cut": False}

        cut = float(cv2.compareHist(prev_hist, hist, cv2.HISTCMP_CORREL)) < 0.5

        if self._window is None or self._window.shape != current.shape:
            self._window = cv2.createHanningWindow(
                (current.shape[1], current.shape[0]), cv2.CV_32F
            )

        # Copies: the stored frame is the next call's reference and must stay
        # exactly as it was prepared.
        (dx, dy), response = cv2.phaseCorrelate(prev.copy(), current.copy(), self._window)
        if response < self.min_response or cut:
            return {"dx": 0.0, "dy": 0.0, "response": float(response), "estimated": False, "cut": cut}
        # phaseCorrelate gives the shift that maps prev onto current, measured
        # on the downscaled copy; scale it back to full-resolution pixels.
        factor = 1.0 / scale if scale else 1.0
        return {
            "dx": float(dx * factor),
            "dy": float(dy * factor),
            "response": float(response),
            "estimated": True,
            "cut": False,
        }
