"""Compare real RIFE/SR order costs and a synthetic-reference midpoint; not a quality ranking."""

import argparse
import ctypes as C
import json
import math
from pathlib import Path
import sys
import time
import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'lib/motionflow'))
from rtx import Rife
from superres import SuperResolution, PROFILES
from gpu import DeviceImage


def measure(function, repeats):
    for _ in range(2):
        result = function()
        if isinstance(result, DeviceImage):
            result.synchronize()
    wall, cpu = time.perf_counter(), time.process_time()
    for _ in range(repeats):
        result = function()
        if isinstance(result, DeviceImage):
            result.synchronize()
    return {
        'wall_ms': (time.perf_counter() - wall) * 1000 / repeats,
        'cpu_ms': (time.process_time() - cpu) * 1000 / repeats,
    }


def picture(w, h, phase):
    # Analytic translation gives a known high-resolution intermediate reference.
    factor = 2
    image = Image.new('RGB', (w * factor, h * factor), '#668eab')
    draw = ImageDraw.Draw(image)
    x, y = int((0.2 + 0.025 * phase) * image.width), int(0.25 * image.height)
    draw.rectangle(
        (x, y, x + image.width // 3, y + image.height // 3),
        fill='#ede7d5',
        outline='#101010',
        width=3,
    )
    draw.ellipse((x + 20, y + 20, x + 90, y + 90), fill='#d13823')
    for offset in range(0, image.width // 3, 11):
        draw.line(
            (x + offset, y + 105, x + offset, y + image.height // 3 - 5),
            fill='black',
            width=2,
        )
    return np.asarray(
        image.resize((w, h), Image.Resampling.LANCZOS).convert('RGBA')
    ).copy()


def run(args):
    w, h, ow, oh = args.width, args.height, args.output_width, args.output_height
    if not 2 <= w <= ow <= 1920 or not 2 <= h <= oh <= 1080:
        raise ValueError('This comparison bounds high-resolution RIFE to 1080p')
    if abs(w / h - ow / oh) > 0.02:
        raise ValueError('Preserve the source aspect ratio')
    if args.target_fps <= args.source_fps:
        raise ValueError('Target FPS must exceed source FPS')
    args.output.mkdir(parents=True, exist_ok=True)
    model, cache = args.cache / 'model', args.output / 'engines'
    profile = PROFILES[args.profile]
    sr_name = (
        'realesr-animevideov3.onnx'
        if profile['model'] == 'animation'
        else 'realesr-general-x4v3.onnx'
    )
    reference = picture(ow, oh, 0.5)
    a = np.asarray(
        Image.fromarray(picture(ow, oh, 0)).resize((w, h), Image.Resampling.LANCZOS)
    ).copy()
    b = np.asarray(
        Image.fromarray(picture(ow, oh, 1)).resize((w, h), Image.Resampling.LANCZOS)
    ).copy()
    sr = low = high = None
    saved = []
    try:
        sr = SuperResolution(
            model / sr_name,
            cache,
            w,
            h,
            math.ceil(max(ow / w, oh / h)),
            profile['strength'],
        )
        low = Rife(model / 'rife_v4.25.onnx', cache, w, h)
        low.pair(a, b)

        def pair_low():
            low.pair(a, b)
            low.cuda.synchronize()

        timings = {
            'pair_low': measure(pair_low, args.repeats),
            'interpolate_low': measure(lambda: low.render_device(0.5), args.repeats),
            'upscale': measure(lambda: sr.upscale_device(a, ow, oh), args.repeats),
        }
        low.pair(a, b)
        interpolate_first = (
            sr.upscale_device(low.render_device(0.5), ow, oh).download().copy()
        )
        low.close()
        low = None
        # Retain both restored endpoints on-device, avoiding an artificial CPU round trip.
        for image in (a, b):
            output = sr.upscale_device(image, ow, oh)
            output.synchronize()
            pointer = sr.cuda.allocate(ow * oh * 4)
            saved.append(pointer)
            sr.cuda.call(
                'cuMemcpyDtoDAsync',
                pointer,
                output.pointer,
                C.c_size_t(ow * oh * 4),
                sr.cuda.stream,
            )
        sr.cuda.synchronize()
        high = Rife(model / 'rife_v4.25.onnx', cache, ow, oh)

        def pair_high():
            for target, pixels in ((high.raw_a, saved[0]), (high.raw_b, saved[1])):
                high.cuda.call(
                    'cuMemcpyDtoDAsync',
                    target,
                    pixels,
                    C.c_size_t(ow * oh * 4),
                    high.cuda.stream,
                )
            high.launch(
                high.pack, high.raw_a, high.device_input, C.c_uint32(high.pixels)
            )
            second = C.c_uint64(high.device_input.value + high.pixels * 3 * 2)
            high.launch(high.pack, high.raw_b, second, C.c_uint32(high.pixels))
            high.cuda.synchronize()

        pair_high()
        timings.update(
            pair_high=measure(pair_high, args.repeats),
            interpolate_high=measure(lambda: high.render_device(0.5), args.repeats),
        )
        upscale_first = high.render_device(0.5).download().copy()
        # Exact integer cadence: frames shared by both grids do not need inference.
        synthetic = args.target_fps - math.gcd(args.source_fps, args.target_fps)

        def cost(pair, interpolation, sr_rate, metric):
            return (
                args.source_fps * timings[pair][metric]
                + synthetic * timings[interpolation][metric]
                + sr_rate * timings['upscale'][metric]
            ) / args.target_fps

        estimates = {
            name: {
                metric: cost(pair, interp, rate, metric)
                for metric in ('wall_ms', 'cpu_ms')
            }
            for name, pair, interp, rate in [
                (
                    'interpolate_then_upscale',
                    'pair_low',
                    'interpolate_low',
                    args.target_fps,
                ),
                (
                    'upscale_then_interpolate',
                    'pair_high',
                    'interpolate_high',
                    args.source_fps,
                ),
            ]
        }
        quality = {}
        for name, image in [
            ('interpolate-first', interpolate_first),
            ('upscale-first', upscale_first),
        ]:
            error = image[:, :, :3].astype(float) - reference[:, :, :3].astype(float)
            mse = float(np.mean(error * error))
            quality[name] = {
                'synthetic_psnr_db': 10 * math.log10(255 * 255 / max(mse, 1e-12))
            }
            Image.fromarray(image).save(args.output / (name + '.png'))
        Image.fromarray(reference).save(args.output / 'reference.png')
        report = {
            'profile': args.profile,
            'source': [w, h, args.source_fps],
            'target': [ow, oh, args.target_fps],
            'stage_timings': timings,
            'estimated_ms_per_output': estimates,
            'synthetic_quality': quality,
            'limits': 'Warm isolated stage estimates exclude browser capture, delivery, compilation, cuts and held animation. Synthetic PSNR does not rank quality on real videos; inspect the PNGs and representative clips.',
        }
        (args.output / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report, indent=2), flush=True)
    finally:
        if high:
            high.close()
        if low:
            low.close()
        if sr:
            for pointer in saved:
                sr.cuda.call('cuMemFree_v2', pointer)
            sr.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--cache', type=Path, default=Path.home() / '.cache/qute-motionflow'
    )
    parser.add_argument('--output', type=Path, default=Path('/tmp/motionflow-order'))
    parser.add_argument('--profile', choices=PROFILES, default='general')
    parser.add_argument('--width', type=int, default=854)
    parser.add_argument('--height', type=int, default=480)
    parser.add_argument('--output-width', type=int, default=1280)
    parser.add_argument('--output-height', type=int, default=720)
    parser.add_argument('--source-fps', type=int, default=24)
    parser.add_argument('--target-fps', type=int, default=60)
    parser.add_argument('--repeats', type=int, default=8)
    args = parser.parse_args()
    if args.repeats < 1 or args.source_fps < 1 or args.target_fps < 1:
        parser.error('FPS/repeats must be positive')
    run(args)
