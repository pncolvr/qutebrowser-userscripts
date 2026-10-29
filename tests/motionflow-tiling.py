"""CPU-only geometry checks; no model initialization or GPU required."""

from pathlib import Path
import math
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'lib/motionflow'))
from superres import tile_dimensions

for width in (2, 16, 256, 640, 854, 944, 1008, 1080, 1280, 1920):
    for height in (2, 16, 176, 360, 480, 640, 720, 1080):
        tw, th = tile_dimensions(width, height)
        assert 80 < tw <= 1088 and 80 < th <= 640
        assert tw % 16 == 0 and th % 16 == 0
        xs = list(range(0, width, tw - 80))
        ys = list(range(0, height, th - 80))
        assert sum(min(tw - 80, width - x) for x in xs) == width
        assert sum(min(th - 80, height - y) for y in ys) == height
for width, height in ((1280, 720), (1920, 1080)):
    oldw = min(1024, math.ceil((width + 80) / 16) * 16)
    oldh = min(640, math.ceil((height + 80) / 16) * 16)
    tw, th = tile_dimensions(width, height)
    old = math.ceil(width / (oldw - 80)) * math.ceil(height / (oldh - 80)) * oldw * oldh
    new = math.ceil(width / (tw - 80)) * math.ceil(height / (th - 80)) * tw * th
    assert new < old
    print(
        f'PASS: {width}x{height}: {tw}x{th} tiles, {(1-new/old)*100:.1f}% fewer neural input tile pixels (not measured FPS)'
    )
for values in ((0, 10, 40), (10, 0, 40), (10, 10, 320), (10, 10, 41)):
    try:
        tile_dimensions(*values)
    except ValueError:
        pass
    else:
        raise AssertionError(values)
print(
    'PASS: Complete tile coverage, unchanged halo, aligned/bounded sizes and invalid-input guards'
)
