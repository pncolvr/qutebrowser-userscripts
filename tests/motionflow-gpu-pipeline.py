"""Real CUDA color/handoff checks; optional before/after pipeline benchmark."""

import argparse
import ctypes as C
from pathlib import Path
import sys
import time
import json
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'lib/motionflow'))
from gpu import DeviceImage, GpuColors, PixelKernels
from rtx import Cuda, Rife
from colors import Colors
from superres import SuperResolution


def test_colors():
    for w, h in [(2, 2), (17, 9), (854, 480)]:
        rng = np.random.default_rng(31)
        # Constant 2x2 blocks make the exact centered 4:2:0 reference unambiguous.
        small = rng.integers(0, 256, ((h + 1) // 2, (w + 1) // 2, 4), dtype=np.uint8)
        a = np.repeat(np.repeat(small, 2, axis=0), 2, axis=1)[:h, :w].copy()
        rgb = a[:, :, :3].astype(np.float32)
        expected_y = np.rint(
            16 + rgb @ np.array([0.2126, 0.7152, 0.0722]) * 219 / 255
        ).astype(np.uint8)
        c = GpuColors(w, h)
        try:
            output = c.convert(a).copy()
            assert np.max(np.abs(output[: w * h].astype(int) - expected_y.ravel())) <= 1
            uv = small[:, :, :3].astype(np.float32)
            expected_u = np.rint(
                128 + uv @ np.array([-0.114572, -0.385428, 0.5]) * 224 / 255
            ).astype(np.uint8)
            expected_v = np.rint(
                128 + uv @ np.array([0.5, -0.454153, -0.045847]) * 224 / 255
            ).astype(np.uint8)
            expected = np.concatenate(
                [expected_y.ravel(), expected_u.ravel(), expected_v.ravel()]
            )
            assert np.max(np.abs(output.astype(int) - expected.astype(int))) <= 1
            try:
                c.convert(a[:-1])
                raise AssertionError('Invalid dimensions accepted')
            except ValueError:
                pass
        finally:
            c.close()
    print('PASS: CUDA BT.709 luma/chroma, odd edges, ranges and input bounds')


def test_tiles():
    cuda = Cuda()
    kernels = PixelKernels(cuda)
    buffers = []
    try:
        w, h, tw, th, halo = 17, 13, 12, 10, 2
        a = np.arange(w * h * 4, dtype=np.uint8).reshape(h, w, 4)
        for size in [a.nbytes, tw * th * 4, a.nbytes]:
            buffers.append(cuda.allocate(size))
        source, tile, output = buffers
        cuda.upload(source, a)
        for y in range(0, h, th - 2 * halo):
            for x in range(0, w, tw - 2 * halo):
                cw, ch = min(tw - 2 * halo, w - x), min(th - 2 * halo, h - y)
                cuda.launch(
                    kernels.rgba_tile,
                    tw * th,
                    source,
                    tile,
                    C.c_uint32(w),
                    C.c_uint32(h),
                    C.c_uint32(tw),
                    C.c_uint32(th),
                    C.c_int32(x),
                    C.c_int32(y),
                    C.c_int32(halo),
                )
                cuda.launch(
                    kernels.rgba_stitch,
                    cw * ch,
                    tile,
                    output,
                    C.c_uint32(tw),
                    C.c_uint32(w),
                    C.c_uint32(cw),
                    C.c_uint32(ch),
                    C.c_uint32(x),
                    C.c_uint32(y),
                    C.c_uint32(halo),
                )
        actual = DeviceImage(cuda, output, w, h).download()
        assert np.array_equal(actual, a), 'GPU tile stitching changed edges or pixels'
    finally:
        cuda.call('cuStreamSynchronize', cuda.stream)
        kernels.close()
        for pointer in buffers:
            cuda.call('cuMemFree_v2', pointer)
        cuda.call('cuStreamDestroy_v2', cuda.stream)
        cuda.call('cuDevicePrimaryCtxRelease_v2', 0)
    print('PASS: GPU padding/stitching preserves every pixel across multiple tiles')


def model_checks(cache, benchmark):
    w, h, ow, oh = (854, 480, 2560, 1439) if benchmark else (320, 192, 640, 384)
    yy, xx = np.indices((h, w))
    a = np.stack(
        [(xx % 256), (yy % 256), ((xx + yy) % 256), np.full_like(xx, 255)], axis=-1
    ).astype(np.uint8)
    b = np.roll(a, 2, axis=1)
    rife = Rife(cache / 'model/rife_v4.25.onnx', cache / 'engines', w, h)
    sr = SuperResolution(
        cache / 'model/realesr-general-x4v3.onnx',
        cache / 'engines',
        w,
        h,
        3 if benchmark else 2,
        0.8,
    )
    cpu = Colors(ow, oh)
    gpu = GpuColors(ow, oh)
    try:

        def legacy():
            rife.pair(a, b)
            return cpu.convert(sr.upscale(rife.render(0.5), ow, oh))

        def resident():
            rife.pair(a, b)
            return gpu.convert(
                sr.upscale_device(rife.render_device(0.5), ow, oh)
            ).tobytes()

        rife.pair(a, b)
        image = rife.render(0.5)
        expected = sr.upscale(image, ow, oh)
        actual = sr.upscale_device(image, ow, oh).download()
        error = np.abs(
            actual.astype(np.int16)
            - np.frombuffer(expected, np.uint8).reshape(oh, ow, 4).astype(np.int16)
        )
        assert float(error.mean()) < 1.5, (
            'Resizing changed too many pixels',
            float(error.mean()),
        )
        if (ow, oh) == (w * sr.scale, h * sr.scale):
            assert np.array_equal(actual, expected)
        assert len(resident()) == ow * oh + 2 * ((ow + 1) // 2) * ((oh + 1) // 2)
        print(
            'PASS: RIFE → GPU SR → GPU fitting → GPU I420; resize MAE',
            float(error.mean()),
            flush=True,
        )
        if benchmark:
            result = {}
            for name, fn in [('legacy', legacy), ('gpu_resident', resident)]:
                fn()
                wall = time.perf_counter()
                cpu_time = time.process_time()
                for _ in range(12):
                    fn()
                result[name] = {
                    'wall_ms_per_frame': (time.perf_counter() - wall) * 1000 / 12,
                    'cpu_ms_per_frame': (time.process_time() - cpu_time) * 1000 / 12,
                }
            print('PIPELINE_BENCHMARK:' + json.dumps(result), flush=True)
    finally:
        gpu.close()
        cpu.close()
        sr.close()
        rife.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--cache', type=Path, default=Path.home() / '.cache/qute-motionflow'
    )
    parser.add_argument('--benchmark', action='store_true')
    args = parser.parse_args()
    test_colors()
    test_tiles()
    model_checks(args.cache, args.benchmark)
