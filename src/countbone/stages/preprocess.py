"""Stage 2 — Pre-process. Normalise a frame and measure whether it is usable."""

from __future__ import annotations

import cv2
import numpy as np

from ..config import PreprocessConfig
from ..types import Frame


def quality_metrics(image: np.ndarray) -> dict[str, float]:
    """Cheap, well-understood proxies for "can a detector work on this?".

    blur     variance of the Laplacian; low means soft or motion-blurred
    bright   mean luminance 0-255
    contrast standard deviation of luminance
    clipped  fraction of pixels crushed to black or blown to white
    """
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
    clipped = float(np.mean((gray <= 4) | (gray >= 251)))
    return {
        "blur": float(cv2.Laplacian(gray, cv2.CV_64F).var()),
        "brightness": float(gray.mean()),
        "contrast": float(gray.std()),
        "clipped_frac": clipped,
    }


def apply(frame: Frame, cfg: PreprocessConfig) -> Frame:
    image = frame.image
    if cfg.denoise:
        image = cv2.bilateralFilter(image, 5, 50, 50)
    if cfg.clahe and image.ndim == 3:
        lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
        lightness, a, b = cv2.split(lab)
        lightness = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(lightness)
        image = cv2.cvtColor(cv2.merge((lightness, a, b)), cv2.COLOR_LAB2BGR)
    frame.image = image
    if cfg.grayscale_stats:
        frame.meta["quality"] = quality_metrics(image)
    return frame
