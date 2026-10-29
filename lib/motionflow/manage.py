"""Install and manage MotionFlow's isolated, loopback-only RTX helper."""

from pathlib import Path
import argparse
import fcntl
import hashlib
from ctypes.util import find_library
import json
import os
import platform
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
from pair import ensure_token

SOURCE = Path(__file__).resolve().parent
ARCHIVE_URL = (
    'https://github.com/AmusementClub/vs-mlrt/releases/download/external-models/rife_v4.25.7z'
)
ARCHIVE_SHA = '172fe975c1775134bb87108e4ec6d1a89e861cc5d3be2ac23bf08afe5ed626b8'
MODEL_SHA = '65c57a5e4abb17ad67faf35054291ac53affab0506d509d2e66698f6ecd75584'
PACKAGES = [
    'tensorrt-rtx-cu12==1.7.1.116',
    'numpy==2.4.6',
    'aiohttp==3.14.5',
    'onnx==1.23.2',
    'onnxconverter-common==1.16.0',
]


def health(port):
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(
            f'http://127.0.0.1:{port}/health', timeout=1
        ) as response:
            data = json.load(response)
        if data.get('protocol') == 1 and data.get('backend') == 'TensorRT-RTX':
            return data
    except (OSError, ValueError):
        pass
    return None


def setup_upscalers(cache):
    # Keep model conversion in the isolated runtime; system Python needs no ML packages.
    models = {
        'realesr-general-x4v3': '8dc7edb9ac80ccdc30c3a5dca6616509367f05fbc184ad95b731f05bece96292',
        'realesr-animevideov3': 'b8a8376811077954d82ca3fcf476f1ac3da3e8a68a4f4d71363008000a18b75d',
    }
    for name, checksum in models.items():
        weights = cache / 'model' / (name + '.pth')
        if not weights.exists() or hashlib.sha256(weights.read_bytes()).hexdigest() != checksum:
            url = (
                'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/'
                + name
                + '.pth'
            )
            with urllib.request.urlopen(url, timeout=60) as response:
                data = response.read()
            if hashlib.sha256(data).hexdigest() != checksum:
                raise RuntimeError('AI upscaler weight checksum mismatch: ' + name)
            weights.write_bytes(data)
        output = weights.with_suffix('.onnx')
        marker = output.with_suffix('.onnx.sha256')
        if (
            not output.exists()
            or not marker.exists()
            or hashlib.sha256(output.read_bytes()).hexdigest() != marker.read_text()
        ):
            subprocess.run(
                [
                    str(cache / 'venv/bin/python'),
                    '-c',
                    'import sys;sys.path.insert(0,sys.argv[1]);from superres import export_model;export_model(sys.argv[2],sys.argv[3])',
                    str(SOURCE),
                    str(weights),
                    str(output),
                ],
                check=True,
            )
            marker.write_text(hashlib.sha256(output.read_bytes()).hexdigest())


def setup(cache):
    if platform.system() != 'Linux' or platform.machine() != 'x86_64':
        raise RuntimeError('This helper currently supports NVIDIA RTX on Linux x86_64')
    if not find_library('swscale') or not find_library('avutil'):
        raise RuntimeError('FFmpeg libswscale and libavutil are needed for native video frames')
    if not shutil.which('7z'):
        raise RuntimeError('7-Zip (7z) is needed to extract the model')
    python = next(
        (
            shutil.which(name)
            for name in ('python3.11', 'python3.12', 'python3.13')
            if shutil.which(name)
        ),
        None,
    )
    if not python:
        raise RuntimeError('Install Python 3.11, 3.12 or 3.13 for the isolated RTX environment')
    interpreter = cache / 'venv/bin/python'
    if not interpreter.exists():
        subprocess.run([python, '-m', 'venv', str(cache / 'venv')], check=True)
    subprocess.run(
        [str(interpreter), '-m', 'pip', 'install', '--disable-pip-version-check', *PACKAGES],
        check=True,
    )
    target = cache / 'model/rife_v4.25.onnx'
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists() or hashlib.sha256(target.read_bytes()).hexdigest() != MODEL_SHA:
        archive = cache / 'rife425.7z'
        if (
            not archive.exists()
            or hashlib.sha256(archive.read_bytes()).hexdigest() != ARCHIVE_SHA
        ):
            temp = archive.with_suffix('.download')
            with urllib.request.urlopen(ARCHIVE_URL, timeout=60) as response, temp.open(
                'wb'
            ) as output:
                shutil.copyfileobj(response, output)
            if hashlib.sha256(temp.read_bytes()).hexdigest() != ARCHIVE_SHA:
                temp.unlink()
                raise RuntimeError('RIFE archive checksum mismatch')
            temp.replace(archive)
        pixels = subprocess.check_output(
            ['7z', 'x', '-so', str(archive), 'rife_v2/rife_v4.25.onnx']
        )
        if hashlib.sha256(pixels).hexdigest() != MODEL_SHA:
            raise RuntimeError('RIFE model checksum mismatch')
        target.write_bytes(pixels)
    license_text = '''RIFE model: https://github.com/hzwer/Practical-RIFE (MIT).
ONNX model distribution: https://github.com/AmusementClub/vs-mlrt (project license GPL-3.0).
Real-ESRGAN: https://github.com/xinntao/Real-ESRGAN (BSD-3-Clause).
TensorRT-RTX is installed from NVIDIA's Python package under its own license.
'''
    (target.parent / 'NOTICE.txt').write_text(license_text)
    shutil.copytree(SOURCE / 'licenses', target.parent / 'licenses', dirs_exist_ok=True)
    setup_upscalers(cache)
    ensure_token(cache)
    print('MotionFlow AI helper setup complete (RIFE and Real-ESRGAN)')


def owns(pid, cache):
    try:
        args = Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
        return str(SOURCE / 'helper.py').encode() in args and str(cache).encode() in args
    except OSError:
        return False


def stop(cache):
    pidfile = cache / 'helper.pid'
    if not pidfile.exists():
        return
    try:
        pid = int(pidfile.read_text())
    except ValueError:
        raise RuntimeError('Invalid helper PID file: ' + str(pidfile)) from None
    if owns(pid, cache):
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        for _ in range(100):
            if not owns(pid, cache):
                break
            time.sleep(0.1)
        else:
            raise RuntimeError('Helper did not stop; keeping ' + str(pidfile))
    pidfile.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        'action',
        nargs='?',
        default='start',
        choices=['setup', 'start', 'restart', 'stop', 'status', 'run'],
    )
    parser.add_argument(
        '--cache',
        type=Path,
        default=Path(os.environ.get('XDG_CACHE_HOME', Path.home() / '.cache'))
        / 'qute-motionflow',
    )
    parser.add_argument('--port', type=int, default=8768)
    args = parser.parse_args()
    cache = args.cache.expanduser().resolve()
    cache.mkdir(parents=True, exist_ok=True)
    with (cache / 'control.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if args.action == 'setup':
            setup(cache)
            return
        interpreter = cache / 'venv/bin/python'
        command = [
            str(interpreter),
            str(SOURCE / 'helper.py'),
            '--cache',
            str(cache),
            '--port',
            str(args.port),
        ]
        if args.action == 'status':
            print(json.dumps(health(args.port) or {'running': False}))
            return
        if args.action in ('stop', 'restart'):
            stop(cache)
            if args.action == 'stop':
                print('MotionFlow AI helper stopped')
                return
            if health(args.port):
                raise RuntimeError(
                    'A helper is still running on port '
                    + str(args.port)
                    + ' without an owned PID file; stop that instance before restarting'
                )
        if not interpreter.exists() or not (cache / 'model/rife_v4.25.onnx').exists():
            raise RuntimeError('Run motionflow-helper setup first')
        ensure_token(cache)
        if args.action == 'run':
            os.execv(str(interpreter), command)
        if health(args.port):
            print('MotionFlow AI helper is already running')
            return
        with (cache / 'helper.log').open('a') as log:
            process = subprocess.Popen(
                command,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=log,
                start_new_session=True,
                close_fds=True,
            )
        (cache / 'helper.pid').write_text(str(process.pid))
        for _ in range(50):
            if health(args.port):
                print('MotionFlow AI helper is running')
                return
            if process.poll() is not None:
                break
            time.sleep(0.1)
        raise RuntimeError('Helper did not start; see ' + str(cache / 'helper.log'))


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print('MotionFlow:', error, file=sys.stderr)
        sys.exit(1)
