"""Helper lifecycle checks with fake PIDs/processes; no running helper is touched."""

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'lib/motionflow'))
import manage


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.cache = Path(self.folder.name) / 'cache'
        (self.cache / 'venv/bin').mkdir(parents=True)
        (self.cache / 'venv/bin/python').touch()
        (self.cache / 'model').mkdir()
        (self.cache / 'model/rife_v4.25.onnx').touch()
        self.pidfile = self.cache / 'helper.pid'

    def test_restart_waits_for_old_process_before_spawning(self):
        self.pidfile.write_text('1234')
        events = []

        def spawn(*args, **kwargs):
            self.assertFalse(self.pidfile.exists())
            events.append('spawn')
            return SimpleNamespace(pid=5678, poll=lambda: None)

        with patch.object(
            sys, 'argv', ['helper', 'restart', '--cache', str(self.cache)]
        ), patch.object(manage, 'owns', side_effect=[True, True, False]), patch.object(
            manage.os, 'kill', side_effect=lambda *args: events.append('terminate')
        ) as kill, patch.object(
            manage.time, 'sleep', side_effect=lambda _: events.append('wait')
        ), patch.object(
            manage, 'health', side_effect=[None, None, {'backend': 'TensorRT-RTX'}]
        ), patch.object(
            manage.subprocess, 'Popen', side_effect=spawn
        ):
            manage.main()
        self.assertEqual(events, ['terminate', 'wait', 'spawn'])
        kill.assert_called_once_with(1234, signal.SIGTERM)
        self.assertEqual(self.pidfile.read_text(), '5678')

    def test_stop_timeout_keeps_pid_for_retry(self):
        self.pidfile.write_text('1234')
        with patch.object(manage, 'owns', return_value=True), patch.object(
            manage.os, 'kill'
        ), patch.object(manage.time, 'sleep'):
            with self.assertRaisesRegex(RuntimeError, 'did not stop'):
                manage.stop(self.cache)
        self.assertEqual(self.pidfile.read_text(), '1234')

    def test_stale_pid_does_not_signal_an_unrelated_process(self):
        self.pidfile.write_text('1234')
        with patch.object(manage, 'owns', return_value=False), patch.object(
            manage.os, 'kill'
        ) as kill:
            manage.stop(self.cache)
        kill.assert_not_called()
        self.assertFalse(self.pidfile.exists())

    def test_restart_refuses_to_reuse_an_unmanaged_running_helper(self):
        with patch.object(
            sys, 'argv', ['helper', 'restart', '--cache', str(self.cache)]
        ), patch.object(
            manage, 'health', return_value={'backend': 'TensorRT-RTX'}
        ), patch.object(
            manage.subprocess, 'Popen'
        ) as spawn:
            with self.assertRaisesRegex(RuntimeError, 'without an owned PID'):
                manage.main()
        spawn.assert_not_called()

    def test_apply_restarts_before_installing_and_reloading(self):
        root = Path(self.folder.name) / 'scripts with spaces'
        root.mkdir()
        shutil.copyfile(ROOT / 'apply_custom', root / 'apply_custom')
        (root / 'lib').mkdir()
        trace = root / 'trace'
        for path, event in [
            ('motionflow-helper', 'helper:$1'),
            ('lib/css-apply.sh', 'css'),
            ('lib/js-apply.sh', 'js'),
        ]:
            file = root / path
            file.write_text('#!/bin/sh\nprintf "%s\\n" "' + event + '" >> "$TRACE"\n')
            file.chmod(0o755)
        (self.cache / 'venv/bin/python').chmod(0o755)
        # apply_custom uses qute-motionflow under XDG_CACHE_HOME.
        self.cache.rename(self.cache.with_name('qute-motionflow'))
        fifo = root / 'commands'
        env = dict(
            os.environ,
            HOME=self.folder.name,
            XDG_CACHE_HOME=self.folder.name,
            XDG_DATA_HOME=str(root / 'data'),
            QUTE_FIFO=str(fifo),
            TRACE=str(trace),
        )
        subprocess.run(['bash', str(root / 'apply_custom')], env=env, check=True)
        self.assertEqual(trace.read_text().splitlines(), ['helper:restart', 'css', 'js'])
        self.assertEqual(fifo.read_text(), 'greasemonkey-reload\nreload\n')


if __name__ == '__main__':
    unittest.main()
