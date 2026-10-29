"""Run with the helper's isolated interpreter; GPU checks are optional."""

import asyncio
import ctypes as C
import json
from pathlib import Path
import sys
import unittest
import numpy as np
from aiohttp import ClientSession, web

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'lib/motionflow'))
from helper import Helper, Timeline, render_pair, SourceFrameCache
from colors import Colors


class FakeEngine:
    def __init__(self):
        self.calls = 0

    def pair(self, a, b):
        self.a, self.b = a, b

    def render(self, t):
        self.calls += 1
        return np.rint(self.a * (1 - t) + self.b * t).astype(np.uint8)


def picture(value):
    image = np.full((32, 32, 4), value, np.uint8)
    image[:, :, 3] = 255
    return image


class TimingTests(unittest.TestCase):

    def test_restore_cache_only_reuses_the_identical_original(self):
        cache = SourceFrameCache()
        a, b = picture(40), picture(80)
        cache.put(a, a, b'encoded-a')
        self.assertEqual(cache.get(a, a), b'encoded-a')
        self.assertIsNone(cache.get(b, b))
        self.assertIsNone(cache.get(a.copy(), a))
        # A mutable model output (including the same borrowed object) isn't an original.
        cache.put(b, a, b'borrowed-model-output')
        self.assertIsNone(cache.get(b, a))
        self.assertEqual(cache.get(a, a), b'encoded-a')
        cache.clear()
        self.assertIsNone(cache.get(a, a))

    def test_profiles_have_different_drawing_cadence(self):
        a, b = picture(40), picture(80)
        animation = Timeline(FakeEngine(), 60, 'animation')
        live = Timeline(FakeEngine(), 60, 'live')
        animation.push(a, 0, False, 0.5)
        live.push(a, 0, False, 0.5)
        held, _, _, _ = animation.push(a, 1000 / 30, False, 0.5)
        self.assertEqual(held, [])
        live_frames, _, _, _ = live.push(a, 1000 / 30, False, 0.5)
        self.assertTrue(all(frame[0] == 40 for frame in live_frames))
        frames, metadata, _, drawing = animation.push(b, 2000 / 30, False, 0.5)
        self.assertEqual([frame[0] for frame in frames], [40, 50, 60, 70, 80])
        self.assertAlmostEqual(drawing, 15)
        self.assertAlmostEqual(metadata[2]['originalTime'], 1000 / 30)

    def test_static_shots_keep_delivering_without_model_work(self):
        engine = FakeEngine()
        timeline = Timeline(engine, 60, 'animation')
        metadata = []
        for i in range(61):
            frames, items, _, _ = timeline.push(picture(45), i * 1000 / 30, False, 0.5)
            metadata += items
            self.assertTrue(all(frame[0] == 45 for frame in frames))
        self.assertGreater(metadata[-1]['time'], 1900)
        self.assertTrue(
            all(
                abs(b['time'] - a['time'] - 1000 / 60) < 0.001
                for a, b in zip(metadata, metadata[1:])
            )
        )
        self.assertTrue(
            all(-0.001 <= item['time'] - item['originalTime'] < 34 for item in metadata)
        )
        self.assertEqual(engine.calls, 0)

    def test_cuts_keep_exact_timestamp_and_comparison_pixels(self):
        engine = FakeEngine()
        a, b = picture(0), picture(255)
        frames, generated, _ = render_pair(engine, a, b, [0.25, 0.75, 0.99, 1], True, 0.3)
        self.assertEqual([frame[0] for frame in frames], [0, 0, 0, 255])
        self.assertFalse(any(generated))
        self.assertEqual(engine.calls, 0)
        a, b = picture(40), picture(80)
        frames, _, _ = render_pair(engine, a, b, [0.5], True, 0.3)
        image = np.frombuffer(frames[0], np.uint8).reshape(32, 32, 4)
        self.assertTrue(np.all(image[:, :10, :3] == 40))
        self.assertTrue(np.all(image[:, 10:, :3] == 60))


class MixedTests(unittest.TestCase):
    def test_general_adapts_to_repeated_drawings(self):
        engine = FakeEngine()
        timeline = Timeline(engine, 60, 'general')
        for i in range(8):
            timeline.push(picture(40), i * 1000 / 30, False, 0.5)
        held, _, _, _ = timeline.push(picture(40), 8 * 1000 / 30, False, 0.5)
        self.assertEqual(held, [])
        frames, metadata, _, _ = timeline.push(picture(80), 9 * 1000 / 30, False, 0.5)
        self.assertTrue(any(item['generated'] for item in metadata))

    def test_gameplay_preserves_abrupt_changes(self):
        live = Timeline(FakeEngine(), 60, 'live')
        game = Timeline(FakeEngine(), 60, 'gameplay')
        for timeline in (live, game):
            timeline.push(picture(30), 0, False, 0.5)
        _, a, _, _ = live.push(picture(90), 1000 / 30, False, 0.5)
        _, b, _, _ = game.push(picture(90), 1000 / 30, False, 0.5)
        self.assertTrue(any(item['generated'] for item in a))
        self.assertFalse(any(item['generated'] for item in b))


class CustomRateTests(unittest.TestCase):
    def test_high_fps_catches_up_without_aborting_choice(self):
        engine=FakeEngine();timeline=Timeline(engine,119.88,'live')
        timeline.push(picture(40),0,False,.5)
        frames,metadata,_,_=timeline.push(picture(80),300,False,.5)
        self.assertEqual(len(frames),24)
        self.assertTrue(all(item['generated'] for item in metadata[:-1]))
        self.assertLessEqual(metadata[-1]['time'],300.001)
        self.assertAlmostEqual(metadata[-1]['time']-metadata[-2]['time'],1000/119.88)


class ProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.helper = Helper(None, None, True)
        self.helper.engine = lambda w, h: FakeEngine()
        app = web.Application()
        app.router.add_get('/v1', self.helper.socket)
        app.on_cleanup.append(self.helper.cleanup)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        self.site = web.TCPSite(self.runner, '127.0.0.1', 0)
        await self.site.start()
        self.url = 'http://127.0.0.1:' + str(self.site._server.sockets[0].getsockname()[1]) + '/v1'
        self.client = ClientSession()

    async def asyncTearDown(self):
        await self.client.close()
        await self.runner.cleanup()

    async def test_cold_model_progress_is_opt_in_and_finishes_before_pixels(self):
        async with self.client.ws_connect(self.url, origin='https://www.youtube.com') as ws:
            await ws.send_json({'protocol': 1, 'width': 32, 'height': 32,
                                'fps': 60, 'content': 'live', 'progress': True})
            self.assertEqual((await ws.receive_json())['type'], 'ready')
            await ws.send_json({'type': 'frame', 'time': 0})
            await ws.send_bytes(picture(40).tobytes())
            self.assertEqual((await ws.receive_json())['frames'], [])
            await ws.send_json({'type': 'frame', 'time': 2000 / 30})
            await ws.send_bytes(picture(80).tobytes())
            metadata = await ws.receive_json()
            self.assertEqual(metadata['type'], 'frames')
            notices = []
            received = 0
            while received < len(metadata['frames']):
                message = await ws.receive()
                if message.type == 1:
                    event = json.loads(message.data)
                    self.assertEqual(event['type'], 'warming')
                    notices.append(event['active'])
                else:
                    self.assertEqual(message.type, 2)
                    self.assertEqual(notices, [True, False])
                    received += 1
            self.assertEqual(notices, [True, False])

    async def test_settings_reconnect_can_wait_for_previous_gpu_work(self):
        self.helper.busy = True
        connecting = asyncio.ensure_future(self.client.ws_connect(self.url + '?wait=1', origin='https://www.youtube.com'))
        await asyncio.sleep(.15)
        self.assertFalse(connecting.done(), 'A replacement connection waits for the previous request')
        self.helper.busy = False
        ws = await asyncio.wait_for(connecting, 2)
        await ws.send_json({'protocol': 1, 'width': 32, 'height': 32, 'fps': 60, 'content': 'live'})
        self.assertEqual((await ws.receive_json())['type'], 'ready')
        await ws.close()

    async def test_854_pixel_i420_input_has_no_unwritten_right_strip(self):
        from unittest.mock import patch
        w, h = 854, 480
        original = Colors

        def poisoned_colors(*args, **kwargs):
            converter = original(*args, **kwargs)
            converter.output.fill(165)
            return converter

        with patch('helper.Colors', side_effect=poisoned_colors):
            async with self.client.ws_connect(self.url, origin='https://www.youtube.com') as ws:
                await ws.send_json({'protocol': 1, 'width': w, 'height': h,
                                    'fps': 45, 'content': 'animation', 'outputFormat': 'RGBA'})
                self.assertEqual((await ws.receive_json())['type'], 'ready')
                await ws.send_json({'type': 'frame', 'time': 0, 'pixelFormat': 'I420', 'passthrough': True})
                packed = np.full(w * h * 3 // 2, 128, np.uint8)
                packed[:w * h] = 120
                await ws.send_bytes(packed.tobytes())
                self.assertEqual(len((await ws.receive_json())['frames']), 1)
                output = np.frombuffer((await ws.receive()).data, np.uint8).reshape(h, w, 4)
                self.assertTrue(np.all(output[:, :, 3] == 255))
                self.assertTrue(np.all(output[:, -6:] == output[h // 2, w // 2]),
                                'All six formerly unwritten columns must contain actual converted pixels')

    async def test_interpolation_precedes_ai_upscaling(self):
        calls = []
        class Engine(FakeEngine):
            def pair(self, a, b):
                calls.append(('pair', a.shape[1], a.shape[0]))
                super().pair(a, b)
            def render(self, t):
                calls.append(('interpolate', self.a.shape[1], self.a.shape[0]))
                return super().render(t)
        class Upscaler:
            def upscale(self, pixels, width, height):
                image = np.frombuffer(pixels, np.uint8).reshape(32, 32, 4)
                calls.append(('upscale', image.shape[1], image.shape[0]))
                return np.repeat(np.repeat(image, 2, axis=0), 2, axis=1)
        self.helper.engine = lambda w, h: Engine()
        self.helper.upscaler = lambda *args: Upscaler()
        async with self.client.ws_connect(self.url, origin='https://www.youtube.com') as ws:
            await ws.send_json({'protocol': 1, 'width': 32, 'height': 32, 'fps': 60,
                                'content': 'live', 'upscale': True, 'upscaleMethod': 'ai',
                                'outputWidth': 64, 'outputHeight': 64, 'outputFormat': 'RGBA'})
            self.assertEqual((await ws.receive_json())['type'], 'ready')
            for index, value in enumerate((40, 80)):
                await ws.send_json({'type': 'frame', 'time': index * 1000 / 30})
                await ws.send_bytes(picture(value).tobytes())
                result = await ws.receive_json()
                self.assertEqual(result['type'], 'frames')
                for _ in result['frames']:
                    self.assertEqual(len((await ws.receive()).data), 64 * 64 * 4)
        self.assertTrue(any(call[0] == 'interpolate' for call in calls))
        self.assertTrue(all(call[1:] == (32, 32) for call in calls))
        for i, call in enumerate(calls):
            if call[0] == 'interpolate':
                self.assertEqual(calls[i + 1][0], 'upscale')

    async def test_held_original_restoration_cache_and_processing_telemetry(self):
        restored = []

        class Upscaler:
            def upscale(self, image, width, height):
                restored.append(image.copy())
                return np.repeat(np.repeat(image, 2, axis=0), 2, axis=1)

        self.helper.upscaler = lambda *args: Upscaler()
        async with self.client.ws_connect(
            self.url, origin='https://www.youtube.com'
        ) as ws:
            await ws.send_json(
                {
                    'protocol': 1,
                    'width': 32,
                    'height': 32,
                    'fps': 60,
                    'content': 'animation',
                    'upscale': True,
                    'upscaleMethod': 'ai',
                    'outputWidth': 64,
                    'outputHeight': 64,
                    'outputFormat': 'RGBA',
                }
            )
            self.assertEqual((await ws.receive_json())['type'], 'ready')

            async def send(time_ms, value):
                await ws.send_json({'type': 'frame', 'time': time_ms})
                await ws.send_bytes(picture(value).tobytes())
                metadata = await ws.receive_json()
                self.assertEqual(metadata['type'], 'frames')
                self.assertGreaterEqual(metadata['processingMs'], 0)
                self.assertGreaterEqual(metadata['workOutputFrames'], 0)
                for item in metadata['frames']:
                    self.assertFalse(item['generated'])
                    self.assertEqual(
                        (await ws.receive()).data,
                        np.repeat(
                            np.repeat(picture(value), 2, axis=0), 2, axis=1
                        ).tobytes(),
                    )
                return metadata

            reports = []
            for index in range(8):
                result = await send(index * 1000 / 30, 40)
                reports.append(result)
            self.assertGreater(result['restorationCacheHits'], 2)
            self.assertTrue(any(r['workOutputFrames'] > 0 for r in reports))
            self.assertEqual(
                len(restored), 1, 'A held immutable original needs only one restoration'
            )
            await ws.send_json({'type': 'reset'})
            self.assertEqual((await ws.receive_json())['type'], 'reset')
            await send(0, 120)
            await send(150, 120)
            self.assertEqual(
                len(restored), 2, 'Reset cannot reuse the old encoded source'
            )

    async def test_reject_other_web_origins(self):
        async with self.client.get(self.url, headers={'Origin': 'https://example.com'}) as response:
            self.assertEqual(response.status, 403)

    async def test_lossless_transport_and_profile_handshake(self):
        async with self.client.ws_connect(self.url, origin='https://www.youtube.com') as ws:
            await ws.send_json(
                {'protocol': 1, 'width': 32, 'height': 32, 'fps': 60, 'content': 'animation'}
            )
            self.assertEqual((await ws.receive_json())['outputFormat'], 'RGBA')
            await ws.send_json({'type': 'frame', 'id': 1, 'time': 0})
            await ws.send_bytes(picture(40).tobytes())
            self.assertEqual((await ws.receive_json())['frames'], [])
            await ws.send_json({'type': 'frame', 'id': 2, 'time': 2000 / 30})
            await ws.send_bytes(picture(80).tobytes())
            metadata = await ws.receive_json()
            self.assertEqual(len(metadata['frames']), 5)
            for expected in (40, 50, 60, 70, 80):
                raw = (await ws.receive()).data
                self.assertEqual(raw, picture(expected).tobytes())

    async def test_native_source_and_output(self):
        encoder = Colors(32, 32)
        decoder = Colors(32, 32, 'I420', 'RGBA')
        try:
            source = encoder.convert(picture(80))
            expected = encoder.convert(decoder.convert(source))
            async with self.client.ws_connect(self.url, origin='https://www.youtube.com') as ws:
                await ws.send_json(
                    {
                        'protocol': 1,
                        'width': 32,
                        'height': 32,
                        'fps': 60,
                        'content': 'live',
                        'outputFormat': 'I420',
                    }
                )
                self.assertEqual((await ws.receive_json())['outputFormat'], 'I420')
                for i in range(2):
                    await ws.send_json(
                        {
                            'type': 'frame',
                            'id': i,
                            'time': i * 1000 / 30,
                            'pixelFormat': 'I420',
                            'matrix': 'bt709',
                            'full': False,
                        }
                    )
                    await ws.send_bytes(source)
                    metadata = await ws.receive_json()
                    for item in metadata['frames']:
                        self.assertEqual((await ws.receive()).data, expected)
        finally:
            encoder.close()
            decoder.close()

    async def test_busy_session_is_exclusive(self):
        async with self.client.ws_connect(self.url, origin='https://www.youtube.com') as first:
            await first.send_json(
                {'protocol': 1, 'width': 32, 'height': 32, 'fps': 60, 'content': 'live'}
            )
            self.assertEqual((await first.receive_json())['type'], 'ready')
            async with self.client.get(
                self.url, headers={'Origin': 'https://www.youtube.com'}
            ) as response:
                self.assertEqual(response.status, 503)

    async def test_paired_generic_origins_and_resizing_only(self):
        self.helper.token = 'a' * 64
        self.helper.engine=lambda w,h:(_ for _ in ()).throw(AssertionError('Resizing-only must not initialize RIFE'))
        async with self.client.get(
            self.url, headers={'Origin': 'https://video.example'}
        ) as response:
            self.assertEqual(response.status, 403)
        async with self.client.ws_connect(
            self.url,
            origin='https://video.example',
            protocols=['motionflow-v1', 'auth.' + 'a' * 64],
        ) as ws:
            self.assertEqual(ws.protocol, 'motionflow-v1')
            await ws.send_json(
                {
                    'protocol': 1,
                    'width': 32,
                    'height': 32,
                    'outputWidth': 64,
                    'outputHeight': 64,
                    'outputFormat': 'I420',
                    'fps':119.88,
                    'content':'gameplay',
                }
            )
            ready = await ws.receive_json()
            self.assertEqual(ready['outputWidth'], 64)
            for i in range(2):
                await ws.send_json({'type': 'frame', 'time': i * 1000 / 60, 'passthrough': True})
                await ws.send_bytes(picture(60 + i * 20).tobytes())
                metadata = await ws.receive_json()
                self.assertEqual(len(metadata['frames']), 1)
                self.assertEqual(metadata['frames'][0]['time'], i * 1000 / 60)
                self.assertFalse(metadata['frames'][0]['generated'])
                self.assertEqual(len((await ws.receive()).data), 64 * 64 * 3 // 2)

    async def test_lanczos_cpu_fallback_does_not_initialize_neural_models(self):
        def no_models(*args):
            raise AssertionError('Lanczos must not initialize a neural model')
        def unavailable(*args):
            raise RuntimeError('CUDA unavailable')
        self.helper.engine = self.helper.upscaler = no_models
        self.helper.lanczos = unavailable
        async with self.client.ws_connect(self.url, origin='https://www.youtube.com') as ws:
            await ws.send_json({'protocol':1,'width':32,'height':32,'outputWidth':64,
                'outputHeight':64,'fps':60,'content':'general','upscale':True})
            ready = await ws.receive_json()
            self.assertEqual(ready['upscaleMethod'], 'lanczos')
            self.assertEqual(ready['upscaler'], 'Lanczos 3 · CPU')
            self.assertIsNone(ready['upscaleStrength'])
            await ws.send_json({'type':'frame','time':0,'passthrough':True})
            image = picture(90)
            await ws.send_bytes(image.tobytes())
            header = await ws.receive_json()
            self.assertFalse(header['frames'][0]['generated'])
            actual = (await ws.receive()).data
            expected = Colors(32,32,target='RGBA',output_width=64,output_height=64)
            try:
                self.assertEqual(actual, expected.convert(image).tobytes())
            finally:
                expected.close()

    async def test_invalid_upscaler_is_rejected_before_initialization(self):
        async with self.client.ws_connect(self.url, origin='https://www.youtube.com') as ws:
            await ws.send_json({'protocol':1,'width':32,'height':32,'fps':60,
                'content':'general','upscale':True,'upscaleMethod':'invalid'})
            result = await ws.receive_json()
            self.assertEqual(result['type'],'error')
            self.assertIn('upscaler method',result['message'])

    async def test_bad_frames_are_rejected_and_release_connection(self):
        async with self.client.ws_connect(self.url, origin='https://www.youtube.com') as ws:
            await ws.send_json(
                {'protocol': 1, 'width': 32, 'height': 32, 'fps': 60, 'content': 'live'}
            )
            self.assertEqual((await ws.receive_json())['type'], 'ready')
            await ws.send_json({'type': 'frame', 'id': 1, 'time': 0, 'split': 0.5})
            await ws.send_bytes(b'bad')
            self.assertEqual((await ws.receive_json())['type'], 'error')
        for _ in range(20):
            if not self.helper.busy:
                break
            await asyncio.sleep(0.01)
        self.assertFalse(self.helper.busy)


if __name__ == '__main__':
    unittest.main()
