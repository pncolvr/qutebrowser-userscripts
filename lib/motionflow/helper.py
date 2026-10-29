"""Loopback-only AI frame interpolation. Run with the isolated helper interpreter."""

import argparse
import asyncio
from concurrent.futures import ThreadPoolExecutor
from collections import OrderedDict
import json
import math
from pathlib import Path
import time
import threading
import secrets
from urllib.parse import urlsplit

from aiohttp import web, WSMsgType
import numpy as np

from rtx import Rife
from gpu import DeviceImage, GpuColors
from colors import Colors
from lanczos import Lanczos
from superres import SuperResolution, PROFILES as UPSCALE_PROFILES

PROTOCOL = 1
ORIGINS = {'https://www.youtube.com', 'https://www.youtube-nocookie.com'}


def render_pair(
    engine,
    a,
    b,
    phases,
    comparison,
    split,
    epsilon=0.035,
    emit=None,
    header=None,
    cut_threshold=0.28,
    native_frames=False,
):
    begin = time.perf_counter()
    # Keep detected cuts and exact duplicates crisp.
    sample_a = a[:: max(1, a.shape[0] // 16), :: max(1, a.shape[1] // 16), :3].astype(
        np.float32
    )
    sample_b = b[:: max(1, b.shape[0] // 16), :: max(1, b.shape[1] // 16), :3].astype(
        np.float32
    )
    cut = float(np.abs(sample_a - sample_b).mean()) > cut_threshold * 255
    still = np.array_equal(a, b)
    needs_model = not (cut or still) and any(epsilon < t < 1 - epsilon for t in phases)
    if header:
        header([needs_model and epsilon < t < 1 - epsilon for t in phases])
    if needs_model:
        engine.pair(a, b)
    frames, generated = [], []
    for phase in phases:
        # Snap only within ~1 ms of a source timestamp. This preserves native
        # samples and avoids spending a full inference on capture-clock jitter.
        synthetic = needs_model and epsilon < phase < 1 - epsilon
        endpoint = 0.99999 if cut else 1 - epsilon
        render = (
            getattr(engine, 'render_device', engine.render)
            if native_frames and not comparison
            else engine.render
        )
        output = render(phase) if synthetic else (b if phase >= endpoint else a)
        if comparison:
            output = output.copy()
            columns = int(math.floor(a.shape[1] * split + 0.5))
            output[:, :columns] = (b if phase >= 0.99999 else a)[:, :columns]
        pixels = output if native_frames else output.tobytes()
        if emit:
            emit(pixels)
        else:
            frames.append(pixels)
        generated.append(synthetic)
    return frames, generated, (time.perf_counter() - begin) * 1000


class SourceFrameCache:
    """One immutable original/encoded pair; never key borrowed model buffers by address."""

    def __init__(self):
        self.source = self.pixels = None
        self.hits = 0

    def get(self, image, previous):
        if isinstance(image, np.ndarray) and image is previous and image is self.source:
            self.hits += 1
            return self.pixels
        return None

    def put(self, image, previous, pixels):
        if (
            isinstance(image, np.ndarray)
            and image is previous
            and isinstance(pixels, bytes)
        ):
            self.source, self.pixels = image, pixels

    def clear(self):
        self.source = self.pixels = None


class Timeline:
    """Animation bridges repeated drawings; live action follows every source frame."""

    def __init__(self, engine, fps, content, native_frames=False):
        self.engine, self.fps, self.content = engine, fps, content
        self.native_frames = native_frames
        self.previous = None
        self.previous_time = self.next_time = self.last_time = None
        self.source_times = []
        self.drawing_periods = []
        self.last_drawing = None
        self.duplicates = []

    def push(self, current, time_ms, comparison, split, emit=None, header=None):
        begin = time.perf_counter()
        if self.last_time is not None and time_ms <= self.last_time:
            raise ValueError('Source timestamps must increase')
        self.last_time = time_ms
        self.source_times = (self.source_times + [time_ms])[-32:]
        if self.previous is None:
            self.previous, self.previous_time = current, time_ms
            self.last_drawing = time_ms
            self.next_time = math.ceil(time_ms * self.fps / 1000) * 1000 / self.fps
            return [], [], 0, 0
        duplicate = np.array_equal(self.previous, current)
        self.duplicates = (self.duplicates + [duplicate])[-12:]
        animated = self.content == 'animation' or (
            self.content == 'general'
            and len(self.duplicates) >= 6
            and sum(self.duplicates) >= len(self.duplicates) / 4
        )
        end = time_ms
        if animated and duplicate:
            # Wait for the next drawing, with bounded lookahead during static shots.
            if time_ms - self.previous_time < 120:
                return [], [], 0, self.drawing_fps()
            end -= 60
        elif not duplicate:
            if self.last_drawing is not None:
                self.drawing_periods = (
                    self.drawing_periods + [time_ms - self.last_drawing]
                )[-17:]
            self.last_drawing = time_ms
        # Catch up by retaining the newest bounded batch, rather than aborting
        # an expensive user-selected FPS after a delivery gap.
        step = 1000 / self.fps
        available = max(0, math.floor((end - self.next_time + 0.001) / step) + 1)
        if available > 24:
            self.next_time += (available - 24) * step
        times = []
        while self.next_time <= end + 0.001:
            times.append(self.next_time)
            self.next_time += step
        phases = [
            max(0, min(1, (t - self.previous_time) / (time_ms - self.previous_time)))
            for t in times
        ]

        def make_metadata(generated):
            return [
                {
                    'time': t,
                    'originalTime': max(
                        (s for s in self.source_times if s <= t + 0.001),
                        default=self.previous_time,
                    ),
                    'generated': g,
                }
                for t, g in zip(times, generated)
            ]

        def announce(generated):
            if header:
                header(make_metadata(generated), self.drawing_fps())

        frames, generated, _ = render_pair(
            self.engine,
            self.previous,
            current,
            phases,
            comparison,
            split,
            min(0.035, 1.25 / (time_ms - self.previous_time)),
            emit,
            announce,
            0.22 if self.content == 'gameplay' else 0.28,
            self.native_frames,
        )
        metadata = make_metadata(generated)
        if animated and duplicate:
            if times:
                self.previous_time = times[-1]
        else:
            self.previous, self.previous_time = current, time_ms
        return (
            frames,
            metadata,
            (time.perf_counter() - begin) * 1000,
            self.drawing_fps(),
        )

    def drawing_fps(self):
        return (
            1000 / float(np.median(self.drawing_periods)) if self.drawing_periods else 0
        )


class DeferredEngine:
    """Native-FPS resizing does not initialize or run the interpolation model."""

    def __init__(self, factory):
        self.factory = factory
        self.instance = None

    def pair(self, a, b):
        if self.instance is None:
            self.instance = self.factory()
        self.instance.pair(a, b)

    def render(self, phase):
        return self.instance.render(phase)

    def render_device(self, phase):
        return getattr(self.instance, 'render_device', self.instance.render)(phase)


class Helper:
    def __init__(self, model, cache, allow_test=False, token=None):
        self.model, self.cache, self.allow_test = model, cache, allow_test
        self.token = token
        self.pool = ThreadPoolExecutor(
            max_workers=1, thread_name_prefix='motionflow-gpu'
        )
        self.engines = OrderedDict()
        self.busy = False
        self.connections = set()
        self.idle_since = time.monotonic()
        self.reaper = None

    def engine(self, width, height):
        key = (width, height)
        if key not in self.engines:
            if len(self.engines) >= 2:
                self.engines.popitem(last=False)[1].close()
            self.engines[key] = Rife(self.model, self.cache, width, height)
        self.engines.move_to_end(key)
        return self.engines[key]

    def upscaler(self, profile, width, height, output_width, output_height):
        scale = min(8, math.ceil(max(output_width / width, output_height / height)))
        key = ('upscale', profile['model'], width, height, scale, profile['strength'])
        if key not in self.engines:
            model = self.model.with_name(
                'realesr-animevideov3.onnx'
                if profile['model'] == 'animation'
                else 'realesr-general-x4v3.onnx'
            )
            if not model.exists():
                raise RuntimeError(
                    'AI upscaler models are missing; run motionflow-helper setup, then restart'
                )
            if len(self.engines) >= 2:
                self.engines.popitem(last=False)[1].close()
            self.engines[key] = SuperResolution(
                model, self.cache, width, height, scale, profile['strength']
            )
        self.engines.move_to_end(key)
        return self.engines[key]

    def lanczos(self, width, height, output_width, output_height):
        key = ('lanczos', width, height, output_width, output_height)
        if key not in self.engines:
            if len(self.engines) >= 2:
                self.engines.popitem(last=False)[1].close()
            self.engines[key] = Lanczos(width, height, output_width, output_height)
        self.engines.move_to_end(key)
        return self.engines[key]

    async def run(self, function, *args):
        return await asyncio.get_running_loop().run_in_executor(
            self.pool, function, *args
        )

    async def socket(self, request):
        origin = request.headers.get('Origin', '')
        test_origin = self.allow_test and origin.startswith('http://127.0.0.1:')
        offered = request.headers.get('Sec-WebSocket-Protocol', '').split(',')
        authenticated = self.token and any(
            secrets.compare_digest(part.strip(), 'auth.' + self.token)
            for part in offered
        )
        web_origin = urlsplit(origin).scheme in ('http', 'https') and bool(
            urlsplit(origin).hostname
        )
        if (
            not test_origin
            and not (authenticated and web_origin)
            and not (self.token is None and origin in ORIGINS)
        ):
            raise web.HTTPForbidden(text='MotionFlow browser pairing required')
        if self.busy and request.query.get('wait') == '1':
            deadline = time.monotonic() + 175
            while self.busy and time.monotonic() < deadline:
                if request.transport is None or request.transport.is_closing():
                    raise web.HTTPServiceUnavailable(text='Waiting client disconnected')
                await asyncio.sleep(.1)
        if self.busy:
            raise web.HTTPServiceUnavailable(
                text='AI helper is already serving a video'
            )
        ws = web.WebSocketResponse(
            max_msg_size=1920 * 1080 * 4 + 65536,
            compress=False,
            heartbeat=20,
            protocols=('motionflow-v1',),
        )
        self.busy = True
        try:
            await ws.prepare(request)
        except Exception:
            self.busy = False
            raise
        self.connections.add(ws)
        timeline = None
        converter = None
        input_converters = {}
        previous_compute = previous_conversion = 0
        try:
            hello = await ws.receive_json(timeout=8)
            if not isinstance(hello, dict):
                raise ValueError('Invalid handshake')
            width, height = hello.get('width'), hello.get('height')
            if (
                hello.get('protocol') != PROTOCOL
                or type(width) is not int
                or type(height) is not int
            ):
                raise ValueError('Invalid helper handshake')
            if not 2 <= width <= 1920 or not 2 <= height <= 1080:
                raise ValueError('Unsupported picture dimensions')
            fps, content = hello.get('fps'), hello.get('content')
            if (
                type(fps) not in (int, float)
                or not math.isfinite(fps)
                or not 1 <= fps <= 240
            ) or content not in (
                'animation',
                'live',
                'general',
                'gameplay',
            ):
                raise ValueError('Invalid playback profile')
            output_format = hello.get('outputFormat', 'RGBA')
            if output_format not in ('RGBA', 'I420'):
                raise ValueError('Unsupported output format')
            ow, oh = hello.get('outputWidth', width), hello.get('outputHeight', height)
            if (
                type(ow) is not int
                or type(oh) is not int
                or not 2 <= ow <= 3840
                or not 2 <= oh <= 2160
            ):
                raise ValueError('Unsupported output dimensions')
            if abs(ow / oh - width / height) > max(0.01, 2 / height):
                raise ValueError('Output must preserve the source aspect ratio')
            requested_upscale = hello.get('upscale', False)
            if type(requested_upscale) is not bool:
                raise ValueError('Invalid upscaling mode')
            method = hello.get('upscaleMethod', 'lanczos')
            if method not in ('lanczos', 'ai'):
                raise ValueError('Invalid upscaler method')
            requested_upscale = requested_upscale and (ow > width or oh > height)
            ai_upscale = requested_upscale and method == 'ai'
            gpu_lanczos = False
            if not ai_upscale and (ow, oh) != (width, height):
                try:
                    await self.run(self.lanczos, width, height, ow, oh)
                    gpu_lanczos = True
                except (RuntimeError, OSError):
                    # Keep the requested filter if CUDA resizing is unavailable.
                    # The native converter below already uses Lanczos-3.
                    pass
            upscale_profile = UPSCALE_PROFILES[content]
            if ai_upscale:
                # Compile before the ready handshake, never while a live batch is streaming.
                await self.run(self.upscaler, upscale_profile, width, height, ow, oh)
            pixel_backend = 'CPU'
            converted_width = ow if ai_upscale or gpu_lanczos else width
            converted_height = oh if ai_upscale or gpu_lanczos else height
            if (converted_width, converted_height) == (ow, oh):
                try:
                    converter = await self.run(GpuColors, ow, oh, output_format)
                    pixel_backend = 'CUDA'
                except (RuntimeError, OSError):
                    pass
            if converter is None and (
                output_format == 'I420' or (ow, oh) != (width, height)
            ):
                converter = Colors(
                    converted_width,
                    converted_height,
                    target=output_format,
                    output_width=ow,
                    output_height=oh,
                )
            warming_emit = None

            def acquire_engine():
                notify = (
                    warming_emit
                    if hello.get('progress') is True
                    and (width, height) not in self.engines
                    else None
                )
                if notify:
                    notify(True)
                instance = self.engine(width, height)
                if notify:
                    notify(False)
                return instance

            engine = DeferredEngine(acquire_engine)
            timeline = Timeline(engine, fps, content, native_frames=True)
            await ws.send_json(
                {
                    'type': 'ready',
                    'protocol': PROTOCOL,
                    'model': 'RIFE 4.25',
                    'backend': 'TensorRT-RTX',
                    'pixelBackend': pixel_backend,
                    'width': width,
                    'height': height,
                    'outputFormat': output_format,
                    'outputWidth': ow,
                    'outputHeight': oh,
                    'upscaler': (
                        (
                            'Real-ESRGAN AnimeVideo-v3'
                            if content == 'animation'
                            else 'Real-ESRGAN general-x4v3'
                        )
                        if ai_upscale
                        else (
                            ('Lanczos 3 · GPU' if gpu_lanczos else 'Lanczos 3 · CPU')
                            if requested_upscale
                            else None
                        )
                    ),
                    'upscaleMethod': method,
                    'upscaleStrength': (
                        upscale_profile['strength'] if ai_upscale else None
                    ),
                }
            )
            source_cache = SourceFrameCache()
            previous_output_count = 0
            previous_processing_ms = 0
            async for message in ws:
                if message.type != WSMsgType.TEXT:
                    if message.type in (
                        WSMsgType.CLOSE,
                        WSMsgType.CLOSED,
                        WSMsgType.ERROR,
                    ):
                        break
                    raise ValueError('Expected frame metadata')
                data = json.loads(message.data)
                if not isinstance(data, dict):
                    raise ValueError('Invalid metadata')
                if data.get('type') == 'reset':
                    timeline = Timeline(engine, fps, content, native_frames=True)
                    source_cache.clear()
                    previous_output_count = 0
                    previous_processing_ms = 0
                    await ws.send_json({'type': 'reset'})
                    continue
                time_ms, split = data.get('time'), data.get('split', 0.5)
                if data.get('type') != 'frame' or len(message.data) > 1024:
                    raise ValueError('Invalid frame metadata')
                if (
                    type(time_ms) not in (int, float)
                    or not math.isfinite(time_ms)
                    or not 0 <= time_ms < 1e10
                ):
                    raise ValueError('Invalid source time')
                if (
                    type(split) not in (int, float)
                    or not math.isfinite(split)
                    or not 0 <= split <= 1
                ):
                    raise ValueError('Invalid comparison split')
                binary = await ws.receive(timeout=5)
                if binary.type != WSMsgType.BINARY:
                    raise ValueError('Invalid frame buffer')
                pixel_format = data.get('pixelFormat', 'RGBA')
                matrix = data.get('matrix', 'bt709')
                full = data.get('full', False)
                if (
                    pixel_format not in ('RGBA', 'I420', 'NV12')
                    or matrix not in ('bt709', 'smpte170m', 'bt470bg')
                    or type(full) is not bool
                ):
                    raise ValueError('Unsupported source color format')
                size = (
                    width * height * 4
                    if pixel_format == 'RGBA'
                    else width * height + 2 * ((width + 1) // 2) * ((height + 1) // 2)
                )
                raw = binary.data
                if len(raw) != size:
                    raise ValueError('Invalid frame buffer')
                queue = asyncio.Queue()
                loop = asyncio.get_running_loop()
                cancelled = threading.Event()
                conversion_ms = 0

                def emit(item):
                    nonlocal conversion_ms
                    if cancelled.is_set():
                        raise RuntimeError('AI request cancelled')
                    if item[0] == 'pixels':
                        begin = time.perf_counter()
                        value = item[1]
                        # Timeline source arrays are immutable; borrowed RIFE device buffers are not.
                        cached = source_cache.get(value, timeline.previous)
                        if cached is not None:
                            loop.call_soon_threadsafe(
                                queue.put_nowait, ('pixels', cached)
                            )
                            return
                        source_image = value
                        if ai_upscale:
                            upscaler = self.upscaler(
                                upscale_profile, width, height, ow, oh
                            )
                            value = getattr(
                                upscaler, 'upscale_device', upscaler.upscale
                            )(value, ow, oh)
                        elif gpu_lanczos:
                            value = self.lanczos(width, height, ow, oh).resize_device(
                                value
                            )
                        if converter:
                            if isinstance(value, DeviceImage) and not isinstance(
                                converter, GpuColors
                            ):
                                value = value.download()
                            value = converter.convert(value)
                        elif isinstance(value, DeviceImage):
                            value = value.download()
                        # Queue immutable final-format bytes, never a borrowed device/array buffer.
                        item = (
                            'pixels',
                            value.tobytes() if isinstance(value, np.ndarray) else value,
                        )
                        source_cache.put(source_image, timeline.previous, item[1])
                        conversion_ms += (time.perf_counter() - begin) * 1000
                    loop.call_soon_threadsafe(queue.put_nowait, item)

                def produce():
                    begin = time.perf_counter()
                    try:
                        if pixel_format == 'RGBA':
                            current = np.frombuffer(raw, np.uint8).reshape(
                                height, width, 4
                            )
                        else:
                            key = (pixel_format, matrix, full)
                            if key not in input_converters:
                                input_converters[key] = Colors(
                                    width, height, pixel_format, 'RGBA', matrix, full
                                )
                            current = input_converters[key].convert(raw)
                        if data.get('passthrough'):
                            item = {
                                'time': time_ms,
                                'originalTime': time_ms,
                                'generated': False,
                            }
                            emit(('header', ([item], 0)))
                            emit(('pixels', current))
                            result = ([], [item], 0, 0)
                        else:
                            result = timeline.push(
                                current,
                                time_ms,
                                bool(data.get('comparison')),
                                split,
                                lambda pixels: emit(('pixels', pixels)),
                                lambda items, drawing: emit(
                                    ('header', (items, drawing))
                                ),
                            )
                        emit(('done', (*result, (time.perf_counter() - begin) * 1000)))
                    except Exception as error:
                        loop.call_soon_threadsafe(queue.put_nowait, ('error', error))

                warming_emit = lambda active: emit(('warming', active))
                producer = asyncio.create_task(self.run(produce))
                announced = False
                try:
                    while True:
                        kind, value = await queue.get()
                        if kind == 'error':
                            raise value
                        if kind == 'warming':
                            await ws.send_json({'type': 'warming', 'active': value})
                            continue
                        if kind == 'header':
                            items, drawing = value
                            announced = True
                            await ws.send_json(
                                {
                                    'type': 'frames',
                                    'id': data.get('id'),
                                    'frames': items,
                                    'computeMs': previous_compute,
                                    'conversionMs': previous_conversion,
                                    'workOutputFrames': previous_output_count,
                                    'processingMs': previous_processing_ms,
                                    'restorationCacheHits': source_cache.hits,
                                    'drawingFps': drawing,
                                }
                            )
                        elif kind == 'pixels':
                            await ws.send_bytes(value)
                        elif kind == 'done':
                            (
                                _,
                                items,
                                previous_compute,
                                drawing,
                                processing_ms,
                            ) = value
                            previous_compute = max(0, previous_compute - conversion_ms)
                            previous_conversion = conversion_ms
                            # Empty animation lookahead batches must not erase the
                            # latest completed work measurement before it is reported.
                            if items:
                                previous_output_count = len(items)
                                previous_processing_ms = processing_ms
                            if not announced:
                                await ws.send_json(
                                    {
                                        'type': 'frames',
                                        'id': data.get('id'),
                                        'frames': items,
                                        'computeMs': previous_compute,
                                        'conversionMs': conversion_ms,
                                        'workOutputFrames': previous_output_count,
                                        'processingMs': previous_processing_ms,
                                        'restorationCacheHits': source_cache.hits,
                                        'drawingFps': drawing,
                                    }
                                )
                            break
                finally:
                    cancelled.set()
                    await producer

        except (
            ValueError,
            RuntimeError,
            OSError,
            TimeoutError,
            ConnectionError,
        ) as error:
            try:
                if not ws.closed:
                    await ws.send_json({'type': 'error', 'message': str(error)})
                    await ws.close(code=1008)
            except ConnectionError:
                pass
        finally:
            for item in input_converters.values():
                await self.run(item.close)
            if converter:
                await self.run(converter.close)
            self.connections.discard(ws)
            self.busy = False
            self.idle_since = time.monotonic()
        return ws

    def release_engines(self):
        for engine in self.engines.values():
            engine.close()
        self.engines.clear()

    async def startup(self, app):
        async def reap():
            while True:
                await asyncio.sleep(15)
                if (
                    not self.busy
                    and self.engines
                    and time.monotonic() - self.idle_since > 90
                ):
                    await self.run(self.release_engines)

        self.reaper = asyncio.create_task(reap())

    async def shutdown(self, app):
        if self.reaper:
            self.reaper.cancel()
            await asyncio.gather(self.reaper, return_exceptions=True)

        await asyncio.gather(*(ws.close(code=1001) for ws in list(self.connections)))

    async def cleanup(self, app):
        await self.run(self.release_engines)
        self.pool.shutdown(wait=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8768)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument(
        '--allow-test-origin', action='store_true', help=argparse.SUPPRESS
    )
    args = parser.parse_args()
    model = args.cache / 'model/rife_v4.25.onnx'
    if not model.exists():
        parser.error('Model is missing; run motionflow-helper setup')
    from pair import ensure_token

    helper = Helper(
        model, args.cache / 'engines', args.allow_test_origin, ensure_token(args.cache)
    )
    app = web.Application(client_max_size=1920 * 1080 * 4 + 1024)
    app.router.add_get('/v1', helper.socket)

    async def health(_request):
        return web.json_response(
            {
                'protocol': PROTOCOL,
                'model': 'RIFE 4.25',
                'backend': 'TensorRT-RTX',
                'busy': helper.busy,
            }
        )

    app.router.add_get('/health', health)
    app.on_startup.append(helper.startup)
    app.on_shutdown.append(helper.shutdown)
    app.on_cleanup.append(helper.cleanup)
    web.run_app(
        app,
        host='127.0.0.1',
        port=args.port,
        print=lambda _: print('MotionFlow AI helper ready on loopback', flush=True),
    )


if __name__ == '__main__':
    main()
