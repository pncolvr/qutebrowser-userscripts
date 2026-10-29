"""Desktop installer checks in a temporary home; the real helper is never started."""

from pathlib import Path
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]


class InstallerTests(unittest.TestCase):
    def test_desktop_launch_and_reinstall_with_literal_paths(self):
        with tempfile.TemporaryDirectory(prefix='motionflow-desktop-') as temporary:
            root = Path(temporary)
            unusual = 'space % $ ` " \\ and quote\''
            checkout = root / ('checkout ' + unusual)
            checkout.mkdir()
            installer = checkout / 'install-motionflow'
            shutil.copyfile(ROOT / 'install-motionflow', installer)
            helper = checkout / 'motionflow-helper'
            helper.write_text(
                '#!/usr/bin/env python3\nimport os,json,sys\nfrom pathlib import Path\nPath(os.environ["RESULT"]).write_text(json.dumps(sys.argv[1:]))\n'
            )
            helper.chmod(0o755)
            original = helper.read_bytes()
            home = root / ('home ' + unusual)
            data = root / ('data ' + unusual)
            result = root / 'result.json'
            env = dict(os.environ, HOME=str(home), XDG_DATA_HOME=str(data), RESULT=str(result))
            run = lambda: subprocess.run(
                [sys.executable, str(installer)], env=env, check=True, capture_output=True
            )
            run()
            launcher = home / '.local/bin/motionflow-helper'
            entry = data / 'applications/motionflow-helper.desktop'
            self.assertFalse(result.exists(), 'Installing must not launch the helper')
            self.assertEqual(launcher.stat().st_mode & 0o777, 0o755)
            self.assertEqual(entry.stat().st_mode & 0o777, 0o644)
            self.assertIn('Actions=Restart;Stop;', entry.read_text())
            # Replacing an existing symlink must not overwrite its target.
            launcher.unlink()
            launcher.symlink_to(helper)
            run()
            self.assertFalse(launcher.is_symlink())
            self.assertEqual(helper.read_bytes(), original)
            if shutil.which('desktop-file-validate'):
                subprocess.run(['desktop-file-validate', str(entry)], check=True)
            if shutil.which('gio'):
                subprocess.run(['gio', 'launch', str(entry)], env=env, check=True)
                end = time.monotonic() + 4
                while not result.exists() and time.monotonic() < end:
                    time.sleep(0.02)
                self.assertEqual(json.loads(result.read_text()), ['start'])
            subprocess.run([str(launcher), 'restart', '--port', '12345'], env=env, check=True)
            self.assertEqual(json.loads(result.read_text()), ['restart', '--port', '12345'])
            self.assertFalse((home / '.config/hypr').exists())
            self.assertFalse((home / '.config/autostart').exists())


if __name__ == '__main__':
    unittest.main()
