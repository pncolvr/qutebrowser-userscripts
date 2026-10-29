"""Verify native SDR matrix/range conversion and packed plane layouts."""

import sys
import unittest
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'lib/motionflow'))
from colors import Colors


class ColorTests(unittest.TestCase):
    def test_solid_colors_preserve_range_and_channels(self):
        for w, h in [(32, 32), (33, 35), (1920, 1080)]:
            encode = Colors(w, h)
            decode = Colors(w, h, 'I420', 'RGBA')
            try:
                for rgb in [
                    (0, 0, 0),
                    (255, 255, 255),
                    (255, 0, 0),
                    (0, 255, 0),
                    (0, 0, 255),
                    (35, 150, 235),
                ]:
                    image = np.empty((h, w, 4), np.uint8)
                    image[:] = [*rgb, 255]
                    packed = encode.convert(image)
                    self.assertEqual(
                        len(packed), w * h + 2 * ((w + 1) // 2) * ((h + 1) // 2)
                    )
                    actual = decode.convert(packed)
                    self.assertLessEqual(np.abs(actual.astype(int) - image).max(), 4)
                    if rgb in ((0, 0, 0), (255, 255, 255)):
                        self.assertEqual(packed[0], 16 if rgb[0] == 0 else 235)
                        self.assertEqual(packed[w * h], 128)
            finally:
                encode.close()
                decode.close()

    def test_matrix_and_nv12_layout(self):
        w = h = 32
        image = np.empty((h, w, 4), np.uint8)
        image[:] = [255, 0, 0, 255]
        expected = {'bt709': 63, 'smpte170m': 81}
        for matrix, y in expected.items():
            encode = Colors(w, h, matrix=matrix)
            decode = Colors(w, h, 'NV12', 'RGBA', matrix)
            try:
                packed = encode.convert(image)
                self.assertLessEqual(abs(packed[0] - y), 1)
                n = w * h
                c = n // 4
                planar = np.frombuffer(packed, np.uint8)
                nv12 = np.concatenate(
                    [
                        planar[:n],
                        np.stack([planar[n : n + c], planar[n + c :]], axis=1).reshape(
                            -1
                        ),
                    ]
                )
                actual = decode.convert(nv12)
                self.assertLessEqual(np.abs(actual.astype(int) - image).max(), 4)
            finally:
                encode.close()
                decode.close()

    def test_full_range_native_input(self):
        decode = Colors(32, 32, 'I420', 'RGBA', full=True)
        try:
            for y in (0, 255):
                source = bytes([y]) * 1024 + bytes([128]) * 512
                actual = decode.convert(source)
                self.assertLessEqual(np.abs(actual[:, :, :3].astype(int) - y).max(), 1)
        finally:
            decode.close()

    def test_lanczos_resizing_keeps_color_range_and_aspect(self):
        image = np.empty((18, 32, 4), np.uint8)
        image[:] = [35, 150, 235, 255]
        encode = Colors(32, 18, output_width=128, output_height=72)
        decode = Colors(128, 72, 'I420', 'RGBA')
        try:
            packed = encode.convert(image)
            self.assertEqual(len(packed), 128 * 72 * 3 // 2)
            actual = decode.convert(packed)
            self.assertEqual(actual.shape, (72, 128, 4))
            self.assertLessEqual(
                np.abs(actual.astype(int) - [35, 150, 235, 255]).max(), 4
            )
        finally:
            encode.close()
            decode.close()

    def test_even_widths_fill_every_right_edge_pixel(self):
        # 854px is a common 480p YouTube frame width; the optimized I420
        # conversion previously left columns 848..853 as allocator contents.
        for w, h in [
            (6, 8),
            (14, 10),
            (30, 32),
            (638, 360),
            (852, 480),
            (854, 480),
            (1278, 720),
            (1918, 1080),
        ]:
            for fmt in ('I420', 'NV12'):
                with self.subTest(width=w, height=h, format=fmt):
                    converter = Colors(w, h, fmt, 'RGBA')
                    try:
                        cw, ch = (w + 1) // 2, (h + 1) // 2
                        packed = np.full(w * h + 2 * cw * ch, 128, np.uint8)
                        packed[: w * h] = 120
                        for sentinel in (0, 165, 255):
                            converter.output.fill(sentinel)
                            actual = converter.convert(packed)
                            expected = np.broadcast_to(
                                actual[h // 2, w // 2], actual.shape
                            )
                            self.assertTrue(
                                np.array_equal(actual, expected),
                                'Every column must be converted, including the right edge',
                            )
                            self.assertTrue(np.all(actual[:, :, 3] == 255))
                    finally:
                        converter.close()

    def test_right_edge_retains_the_actual_luma_gradient(self):
        w, h = 854, 18
        converter = Colors(w, h, 'I420', 'RGBA')
        try:
            luma = (16 + np.arange(w) % 220).astype(np.uint8)
            packed = np.full(w * h * 3 // 2, 128, np.uint8)
            packed[: w * h] = np.tile(luma, h)
            converter.output.fill(165)
            actual = converter.convert(packed)
            expected = np.clip(np.rint((luma.astype(float) - 16) * 255 / 219), 0, 255)
            error = np.abs(actual[:, :, :3].astype(float) - expected[None, :, None])
            self.assertLessEqual(
                error[:, -16:].max(),
                1,
                'Right-edge pixels must come from the source rather than padding or a copied border',
            )
            self.assertTrue(np.all(actual[:, :, 3] == 255))
        finally:
            converter.close()

    def test_bad_buffers_fail_before_native_call(self):
        converter = Colors(32, 32)
        try:
            with self.assertRaises(ValueError):
                converter.convert(b'bad')
        finally:
            converter.close()
            converter.close()


if __name__ == '__main__':
    unittest.main()
