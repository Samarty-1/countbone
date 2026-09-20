"""Write a synthetic shelf video and print its ground truth.

    python examples/make_synthetic_video.py [output.mp4] [seed]
"""

import sys

from countbone.demo import make_demo_video

path = sys.argv[1] if len(sys.argv) > 1 else "examples/demo_shelf.mp4"
seed = int(sys.argv[2]) if len(sys.argv) > 2 else 7

scene = make_demo_video(path, seed=seed)
print(f"wrote {scene.path}: {scene.frames} frames @ {scene.fps}fps")
for sku, n in sorted(scene.truth.items()):
    print(f"  {sku}: {n}")
print(f"  total: {scene.total}")
