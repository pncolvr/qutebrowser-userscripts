"""Tile/stitch/profile regression checks; run with the helper interpreter."""

from pathlib import Path
import sys
import unittest
import pickle
import tempfile
import zipfile
import os
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'lib/motionflow'))
from superres import SuperResolution, PROFILES, export_model
from colors import Colors


class SuperResolutionTests(unittest.TestCase):
    def test_overlapping_tiles_preserve_one_continuous_output_grid(self):
        engine = SuperResolution.__new__(SuperResolution)
        engine.scale = 4
        engine.tw = engine.th = 256
        engine.infer = lambda image: np.repeat(np.repeat(image, 4, axis=0), 4, axis=1)
        rng = np.random.default_rng(42)
        image = rng.integers(0, 256, (193, 365, 4), dtype=np.uint8)
        image[:, :, 3] = 255
        actual = engine.upscale(image, 730, 386)
        original = np.repeat(np.repeat(image, 4, axis=0), 4, axis=1)
        converter = Colors(1460, 772, target='RGBA', output_width=730, output_height=386)
        try:
            expected = converter.convert(original)
        finally:
            converter.close()
        self.assertTrue(
            np.array_equal(actual, expected), 'GPU tile edges must not become filter seams'
        )

    def test_model_reader_rejects_arbitrary_pickle_globals(self):
        class Payload:
            def __reduce__(self):
                return (os.system, ('exit 99',))
        with tempfile.TemporaryDirectory() as folder:
            file=Path(folder)/'bad.pth'
            with zipfile.ZipFile(file,'w') as archive:
                archive.writestr('weights/data.pkl',pickle.dumps(Payload()))
            with self.assertRaisesRegex(ValueError,'Unsupported model object'):
                export_model(file,Path(folder)/'model.onnx')

    def test_profiles_choose_distinct_restoration_settings(self):
        self.assertEqual(PROFILES['animation']['model'], 'animation')
        self.assertEqual(len({profile['strength'] for profile in PROFILES.values()}), 4)
        self.assertLess(PROFILES['gameplay']['strength'], PROFILES['live']['strength'])


if __name__ == '__main__':
    unittest.main()
