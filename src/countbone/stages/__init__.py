"""The six backbone stages. Each one does one thing and is replaceable."""

from . import capture, count, detect, identify, output, preprocess

__all__ = ["capture", "preprocess", "detect", "identify", "count", "output"]
