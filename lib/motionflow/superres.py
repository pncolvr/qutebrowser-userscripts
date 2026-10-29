"""Compact Real-ESRGAN models: pinned weights, ONNX export, tiled RTX inference.

Architecture/weights: Xintao Wang et al., Real-ESRGAN (BSD-3-Clause).
https://github.com/xinntao/Real-ESRGAN
No PyTorch installation or arbitrary model code execution is required.
"""

from pathlib import Path
import collections
import ctypes as C
import hashlib
import io
import math
import pickle
import zipfile
import warnings
import numpy as np
import onnx
from onnx import helper as H, numpy_helper as N
from onnxconverter_common import float16
import tensorrt_rtx as trt
from rtx import Cuda
from colors import Colors
from gpu import DeviceImage, PixelKernels
from lanczos import Lanczos

PROFILES = {
    'general': {'model': 'general', 'strength': 0.8, 'label': 'Balanced restoration'},
    'animation': {'model': 'animation', 'strength': 1.0, 'label': 'Clean drawn lines'},
    'live': {
        'model': 'general',
        'strength': 0.65,
        'label': 'Gentle texture restoration',
    },
    'gameplay': {
        'model': 'general',
        'strength': 0.5,
        'label': 'Conservative HUD/text restoration',
    },
}


def export_model(weights, output):
    """Read only tensors/OrderedDict from the checksum-verified official archive."""
    with zipfile.ZipFile(weights) as archive:
        prefix = next(
            n[: -len('data.pkl')] for n in archive.namelist() if n.endswith('/data.pkl')
        )

        def tensor(storage, offset, shape, stride, *unused):
            return np.ndarray(
                shape,
                dtype=np.float32,
                buffer=storage,
                offset=offset * 4,
                strides=tuple(s * 4 for s in stride),
            ).copy()

        class Reader(pickle.Unpickler):
            def find_class(self, module, name):
                if (module, name) == ('collections', 'OrderedDict'):
                    return collections.OrderedDict
                if module == 'torch._utils' and name in (
                    '_rebuild_tensor_v2',
                    '_rebuild_tensor',
                ):
                    return tensor
                if (module, name) == ('torch', 'FloatStorage'):
                    return 'float32'
                raise ValueError('Unsupported model object: ' + module + '.' + name)

            def persistent_load(self, value):
                kind, dtype, key, location, size = value
                if kind != 'storage' or dtype != 'float32' or size < 0:
                    raise ValueError('Unsupported weight storage')
                data = archive.read(prefix + 'data/' + key)
                if len(data) != size * 4:
                    raise ValueError('Invalid weight storage')
                return data

        state = Reader(io.BytesIO(archive.read(prefix + 'data.pkl'))).load()
    state = state.get('params_ema', state.get('params', state))
    nodes, initializers = [], []

    def constant(name, value):
        initializers.append(N.from_array(np.asarray(value), name))
        return name

    previous = 'input'
    indices = sorted({int(key.split('.')[1]) for key in state})
    for index in indices:
        weight = state[f"body.{index}.weight"]
        name = 'body_' + str(index)
        if weight.ndim == 4:
            args = [
                previous,
                constant(name + '_w', weight),
                constant(name + '_b', state[f"body.{index}.bias"]),
            ]
            nodes.append(
                H.make_node('Conv', args, [name], name=name, pads=[1, 1, 1, 1])
            )
        else:
            nodes.append(
                H.make_node(
                    'PRelu',
                    [previous, constant(name + '_w', weight.reshape(-1, 1, 1))],
                    [name],
                    name=name,
                )
            )
        previous = name
    nodes.append(
        H.make_node('DepthToSpace', [previous], ['residual'], blocksize=4, mode='CRD')
    )
    nodes.append(
        H.make_node(
            'Resize',
            ['input', '', constant('scales', np.array([1, 1, 4, 4], np.float32))],
            ['base'],
            mode='nearest',
            coordinate_transformation_mode='asymmetric',
            nearest_mode='floor',
        )
    )
    nodes.append(H.make_node('Add', ['residual', 'base'], ['output']))
    model = H.make_model(
        H.make_graph(
            nodes,
            'Real-ESRGAN SRVGGNetCompact',
            [
                H.make_tensor_value_info(
                    'input', onnx.TensorProto.FLOAT, [1, 3, 'h', 'w']
                )
            ],
            [
                H.make_tensor_value_info(
                    'output', onnx.TensorProto.FLOAT, [1, 3, 'oh', 'ow']
                )
            ],
            initializers,
        ),
        opset_imports=[H.make_opsetid('', 17)],
    )
    model.ir_version = 8
    onnx.checker.check_model(model)
    onnx.save(model, output)


def tile_dimensions(width, height, halo=40):
    """Balance complete rows/columns instead of padding a tiny edge tile to the maximum."""
    if width < 1 or height < 1 or halo < 0 or halo * 2 >= 640 or halo % 8:
        raise ValueError('Invalid tile dimensions')

    def axis(size, maximum):
        count = math.ceil(size / (maximum - 2 * halo))
        return math.ceil(size / count / 16) * 16 + 2 * halo

    return axis(width, 1088), axis(height, 640)


class SuperResolution:
    # Overlapping tiles bound activation memory; the 40px halo covers the
    # general network's full receptive field, so tile boundaries stay continuous.
    TILE, HALO = 256, 40

    def __init__(self, model, cache, width=176, height=176, scale=4, strength=1.0):
        self.cuda = None
        self.module = None
        self.pixel_kernels = self.final_resize = None
        self.extra_buffers = []
        try:
            self.initialize(Path(model), Path(cache), width, height, scale, strength)
        except Exception:
            self.close()
            raise

    def initialize(self, model, cache, width, height, scale, strength):
        self.cuda = Cuda()
        self.scale = scale
        self.width, self.height = width, height
        tw, th = self.tw, self.th = tile_dimensions(width, height, self.HALO)
        sha = hashlib.sha256(model.read_bytes()).hexdigest()
        target = (
            cache
            / f"srvgg4-v2-{trt.__version__}-{sha[:12]}-{tw}x{th}-s{scale}-b{round(strength*100)}.rtx"
        )
        self.logger = trt.Logger(trt.Logger.ERROR)
        if not target.exists():
            source = onnx.load(model)
            # Resize and blend on the GPU before downloading byte pixels.
            # The model still reconstructs at its learned 4x scale.
            source.graph.node[-1].output[0] = 'restored_4x'
            source.graph.initializer.extend(
                [
                    N.from_array(
                        np.array([1, 1, scale / 4, scale / 4], np.float32), 'sr_scales'
                    ),
                    N.from_array(
                        np.array([1, 1, scale, scale], np.float32), 'base_scales'
                    ),
                    N.from_array(np.array(strength, np.float32), 'sr_strength'),
                    N.from_array(np.array(1 - strength, np.float32), 'base_strength'),
                ]
            )
            source.graph.node.extend(
                [
                    H.make_node(
                        'Resize',
                        ['restored_4x', '', 'sr_scales'],
                        ['restored'],
                        mode='linear',
                        coordinate_transformation_mode='half_pixel',
                    ),
                    H.make_node(
                        'Resize',
                        ['input', '', 'base_scales'],
                        ['plain'],
                        mode='linear',
                        coordinate_transformation_mode='half_pixel',
                    ),
                    H.make_node(
                        'Mul', ['restored', 'sr_strength'], ['restored_weighted']
                    ),
                    H.make_node('Mul', ['plain', 'base_strength'], ['plain_weighted']),
                    H.make_node(
                        'Add', ['restored_weighted', 'plain_weighted'], ['output']
                    ),
                ]
            )
            for value, factor in [
                (source.graph.input[0], 1),
                (source.graph.output[0], scale),
            ]:
                for dim, size in zip(
                    value.type.tensor_type.shape.dim, [1, 3, th * factor, tw * factor]
                ):
                    dim.dim_value = size
            for i, node in enumerate(source.graph.node):
                if not node.name:
                    node.name = 'sr_node_' + str(i)
            with warnings.catch_warnings():
                warnings.simplefilter('ignore', UserWarning)
                source = float16.convert_float_to_float16(source, keep_io_types=False)
            builder = trt.Builder(self.logger)
            network = builder.create_network(0)
            parser = trt.OnnxParser(network, self.logger)
            if not parser.parse(source.SerializeToString()):
                raise RuntimeError(
                    '; '.join(
                        str(parser.get_error(i)) for i in range(parser.num_errors)
                    )
                )
            serialized = builder.build_serialized_network(
                network, builder.create_builder_config()
            )
            if serialized is None:
                raise RuntimeError('Could not compile the AI upscaler')
            target.parent.mkdir(parents=True, exist_ok=True)
            temp = target.with_suffix('.tmp')
            temp.write_bytes(serialized)
            temp.chmod(0o600)
            temp.replace(target)
        self.runtime = trt.Runtime(self.logger)
        self.engine = self.runtime.deserialize_cuda_engine(target.read_bytes())
        if self.engine is None:
            raise RuntimeError('Invalid upscaler engine cache: ' + str(target))
        self.execution = self.engine.create_execution_context()
        if self.execution is None:
            raise RuntimeError('Could not create the upscaler execution context')
        self.device_input = self.cuda.allocate(3 * tw * th * 2)
        self.device_output = self.cuda.allocate(3 * tw * th * scale * scale * 2)
        self.output = np.empty((th * scale, tw * scale, 4), np.uint8)
        self.raw_input = self.cuda.allocate(tw * th * 4)
        self.raw_output = self.cuda.allocate(tw * th * scale * scale * 4)
        self.error = self.cuda.allocate(4)
        # Tensor bindings use the requested output grid, not the intermediate 4x grid.
        self.execution.set_tensor_address('input', self.device_input.value)
        self.execution.set_tensor_address('output', self.device_output.value)
        self.module = C.c_void_p()
        kernels = C.create_string_buffer(
            Path(__file__).with_name('pixels.ptx').read_bytes()
        )
        self.cuda.call('cuModuleLoadData', C.byref(self.module), kernels)
        self.pack, self.unpack = C.c_void_p(), C.c_void_p()
        self.cuda.call(
            'cuModuleGetFunction', C.byref(self.pack), self.module, b"rgba_to_planar"
        )
        self.cuda.call(
            'cuModuleGetFunction', C.byref(self.unpack), self.module, b"planar_to_rgba"
        )

        self.pixel_kernels = PixelKernels(self.cuda)
        self.source_image = self.cuda.allocate(width * height * 4)
        self.extra_buffers.append(self.source_image)
        self.stitched_image = self.cuda.allocate(width * height * scale * scale * 4)
        self.extra_buffers.append(self.stitched_image)
        # Finish first-execution JIT during the ready handshake, while playback is held.
        self.cuda.call('cuMemsetD8_v2', self.raw_input, 0, C.c_size_t(tw * th * 4))
        self.infer_device()

    def infer_device(self, image=None):
        if image is not None:
            image = np.ascontiguousarray(image)
            self.cuda.upload(self.raw_input, image)
        self.pixels = self.tw * self.th
        self.cuda.launch(
            self.pack,
            self.pixels,
            self.raw_input,
            self.device_input,
            C.c_uint32(self.pixels),
        )
        if not self.execution.execute_async_v3(self.cuda.stream.value):
            raise RuntimeError('AI upscaling failed')
        self.pixels = self.tw * self.th * self.scale * self.scale
        self.cuda.call(
            'cuMemsetD8Async', self.error, 0, C.c_size_t(4), self.cuda.stream
        )
        self.cuda.launch(
            self.unpack,
            self.pixels,
            self.device_output,
            self.raw_output,
            C.c_uint32(self.pixels),
            self.error,
        )
        self.cuda.synchronize()
        error = C.c_uint32()
        self.cuda.call('cuMemcpyDtoH_v2', C.byref(error), self.error, C.c_size_t(4))
        if error.value:
            raise RuntimeError('Upscaler returned non-finite pixels')
        return DeviceImage(
            self.cuda, self.raw_output, self.tw * self.scale, self.th * self.scale
        )

    def infer(self, image):
        return self.infer_device(image).download(self.output)

    def upscale_device(self, image, width, height):
        if isinstance(image, DeviceImage):
            if (image.width, image.height) != (self.width, self.height):
                raise ValueError('Invalid upscaler device dimensions')
            image.synchronize()
            pointer = image.pointer
        else:
            image = np.frombuffer(image, np.uint8)
            if image.size != self.width * self.height * 4:
                raise ValueError('Invalid upscaler source dimensions')
            self.cuda.upload(self.source_image, np.ascontiguousarray(image))
            pointer = self.source_image
        tw, th, scale = self.tw, self.th, self.scale
        core_w, core_h = tw - 2 * self.HALO, th - 2 * self.HALO
        for y in range(0, self.height, core_h):
            for x in range(0, self.width, core_w):
                cw, ch = min(core_w, self.width - x), min(core_h, self.height - y)
                self.cuda.launch(
                    self.pixel_kernels.rgba_tile,
                    tw * th,
                    pointer,
                    self.raw_input,
                    C.c_uint32(self.width),
                    C.c_uint32(self.height),
                    C.c_uint32(tw),
                    C.c_uint32(th),
                    C.c_int32(x),
                    C.c_int32(y),
                    C.c_int32(self.HALO),
                )
                self.infer_device()
                self.cuda.launch(
                    self.pixel_kernels.rgba_stitch,
                    cw * ch * scale * scale,
                    self.raw_output,
                    self.stitched_image,
                    C.c_uint32(tw * scale),
                    C.c_uint32(self.width * scale),
                    C.c_uint32(cw * scale),
                    C.c_uint32(ch * scale),
                    C.c_uint32(x * scale),
                    C.c_uint32(y * scale),
                    C.c_uint32(self.HALO * scale),
                )
        result = DeviceImage(
            self.cuda, self.stitched_image, self.width * scale, self.height * scale
        )
        if (result.width, result.height) != (width, height):
            if self.final_resize and (self.final_resize.ow, self.final_resize.oh) != (
                width,
                height,
            ):
                self.final_resize.close()
                self.final_resize = None
            if self.final_resize is None:
                self.final_resize = Lanczos(result.width, result.height, width, height)
            result = self.final_resize.resize_device(result)
        return result

    def upscale(self, image, width, height):
        h, w = image.shape[:2]
        tw, th = self.tw, self.th
        cw_core, ch_core = tw - 2 * self.HALO, th - 2 * self.HALO
        # Stitch at a consistent integer grid and resize only when necessary.
        # Profile blending and learned 4x-to-output scaling already ran on the GPU.
        scale = self.scale
        restored = np.empty((h * scale, w * scale, 4), np.uint8)
        padded = np.pad(image, ((self.HALO, th), (self.HALO, tw), (0, 0)), mode='edge')
        for y in range(0, h, ch_core):
            for x in range(0, w, cw_core):
                ch, cw = min(ch_core, h - y), min(cw_core, w - x)
                tile = self.infer(padded[y : y + th, x : x + tw])
                restored[y * scale : (y + ch) * scale, x * scale : (x + cw) * scale] = (
                    tile[
                        self.HALO * scale : (self.HALO + ch) * scale,
                        self.HALO * scale : (self.HALO + cw) * scale,
                    ]
                )
        if (w * scale, h * scale) == (width, height):
            result = restored
        else:
            resize = Colors(
                w * scale,
                h * scale,
                target='RGBA',
                output_width=width,
                output_height=height,
            )
            try:
                result = resize.convert(restored)
            finally:
                resize.close()
        del restored
        return result

    def close(self):
        if self.cuda is None:
            return
        self.cuda.call('cuCtxSetCurrent', self.cuda.context)
        self.cuda.synchronize()
        self.execution = self.engine = self.runtime = None
        if self.final_resize:
            self.final_resize.close()
        if self.pixel_kernels:
            self.pixel_kernels.close()
        for pointer in self.extra_buffers:
            self.cuda.call('cuMemFree_v2', pointer)
        self.extra_buffers.clear()
        if self.module:
            self.cuda.call('cuModuleUnload', self.module)
        for name in [
            'device_input',
            'device_output',
            'raw_input',
            'raw_output',
            'error',
        ]:
            pointer = getattr(self, name, None)
            if pointer:
                self.cuda.call('cuMemFree_v2', pointer)
        self.cuda.close()
        self.cuda = None
