"""Local RIFE 4.25 inference with TensorRT-RTX; no PyTorch or CUDA toolkit required."""

from pathlib import Path
import ctypes as C
import hashlib
import warnings

import numpy as np
import onnx
from onnxconverter_common import float16
import tensorrt_rtx as trt


class Cuda:
    def __init__(self):
        self.lib = C.CDLL('libcuda.so.1')
        self.completion = None
        self.call('cuInit', 0)
        self.context = C.c_void_p()
        self.call('cuDevicePrimaryCtxRetain', C.byref(self.context), 0)
        self.call('cuCtxSetCurrent', self.context)
        self.stream = C.c_void_p()
        try:
            self.call('cuStreamCreate', C.byref(self.stream), 0)
        except Exception:
            self.call('cuDevicePrimaryCtxRelease_v2', 0)
            raise

    def call(self, name, *args):
        status = getattr(self.lib, name)(*args)
        if status:
            raise RuntimeError(f"{name} failed ({status})")

    def allocate(self, size):
        pointer = C.c_uint64()
        self.call('cuMemAlloc_v2', C.byref(pointer), C.c_size_t(size))
        return pointer

    def synchronize(self):
        # A blocking, untimed event lets the host sleep instead of spinning on GPU work.
        if self.completion is None:
            self.completion = C.c_void_p()
            self.call('cuEventCreate', C.byref(self.completion), 3)
        self.call('cuEventRecord', self.completion, self.stream)
        self.call('cuEventSynchronize', self.completion)

    def close(self):
        if self.stream is None:
            return
        self.call('cuCtxSetCurrent', self.context)
        self.synchronize()
        if self.completion:
            self.call('cuEventDestroy_v2', self.completion)
        self.call('cuStreamDestroy_v2', self.stream)
        self.call('cuDevicePrimaryCtxRelease_v2', 0)
        self.completion = self.stream = None

    def upload(self, pointer, array):
        self.call(
            'cuMemcpyHtoD_v2',
            pointer,
            C.c_void_p(array.ctypes.data),
            C.c_size_t(array.nbytes),
        )

    def launch(self, function, count, *values):
        args = (C.c_void_p * len(values))(
            *(C.cast(C.byref(value), C.c_void_p) for value in values)
        )
        self.call(
            'cuLaunchKernel',
            function,
            (count + 255) // 256,
            1,
            1,
            256,
            1,
            1,
            0,
            self.stream,
            args,
            None,
        )


class Rife:
    def __init__(self, model, cache, width, height):
        self.cuda = None
        self.module = None
        try:
            self.initialize(model, cache, width, height)
        except Exception:
            self.close()
            raise

    def initialize(self, model, cache, width, height):
        if not (2 <= width <= 1920 and 2 <= height <= 1080):
            raise ValueError('AI output must fit within 1920×1080')
        self.width, self.height = width, height
        self.cuda = Cuda()
        self.logger = trt.Logger(trt.Logger.ERROR)
        model = Path(model)
        fingerprint = hashlib.sha256(model.read_bytes()).hexdigest()
        target = (
            Path(cache)
            / f"rife425-p3-{trt.__version__}-{fingerprint[:12]}-{width}x{height}.rtx"
        )
        if not target.exists():
            source = onnx.load(model)
            # Fixed shapes let RTX eliminate the model's padding/coordinate work.
            for value in [*source.graph.input, *source.graph.output]:
                shape = [1, 7 if value.name == 'input' else 3, height, width]
                for dim, size in zip(value.type.tensor_type.shape.dim, shape):
                    dim.dim_value = size
            # Preserve FP32 arithmetic that maps flow vectors to normalized warp
            # coordinates. FP16 grid coordinates can shift fine outlines by a pixel.
            producers = {
                name: node for node in source.graph.node for name in node.output
            }
            precise = set()

            def coordinates(name):
                node = producers.get(name)
                if (
                    node is None
                    or node.name in precise
                    or node.op_type in ('Conv', 'ConvTranspose', 'Shape')
                ):
                    return
                precise.add(node.name)
                for value in node.input:
                    coordinates(value)

            for node in source.graph.node:
                if node.op_type == 'GridSample':
                    precise.add(node.name)
                    coordinates(node.input[1])
            casts = {
                node.name
                for node in source.graph.node
                if node.op_type == 'Cast'
                and node.name not in precise
                and any(
                    a.name == 'to' and a.i == onnx.TensorProto.FLOAT
                    for a in node.attribute
                )
            }
            with warnings.catch_warnings():
                warnings.simplefilter('ignore', UserWarning)
                source = float16.convert_float_to_float16(
                    source, keep_io_types=False, node_block_list=sorted(precise)
                )
            for node in source.graph.node:
                if node.name in casts:
                    for attr in node.attribute:
                        if attr.name == 'to' and attr.i == onnx.TensorProto.FLOAT:
                            attr.i = onnx.TensorProto.FLOAT16
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
                raise RuntimeError('Could not compile the RIFE engine')
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_suffix('.tmp')
            temporary.write_bytes(serialized)
            temporary.chmod(0o600)
            temporary.replace(target)
        self.runtime = trt.Runtime(self.logger)
        self.engine = self.runtime.deserialize_cuda_engine(target.read_bytes())
        if self.engine is None:
            raise RuntimeError('Invalid RTX engine cache; remove ' + str(target))
        self.execution = self.engine.create_execution_context()
        if self.execution is None:
            raise RuntimeError('Could not create the RIFE execution context')
        n = width * height
        self.pixels = n
        self.output = np.empty((height, width, 4), np.uint8)
        self.device_input = self.cuda.allocate(n * 7 * 2)
        self.device_output = self.cuda.allocate(n * 3 * 2)
        self.raw_a = self.cuda.allocate(n * 4)
        self.raw_b = self.cuda.allocate(n * 4)
        self.raw_output = self.cuda.allocate(n * 4)
        self.error = self.cuda.allocate(4)
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
        self.execution.set_tensor_address('input', self.device_input.value)
        self.execution.set_tensor_address('output', self.device_output.value)
        self.cuda.call('cuMemsetD8_v2', self.device_input, 0, C.c_size_t(n * 7 * 2))
        self.render_device(0.5)  # JIT before accepting live frames.

    def launch(self, function, *values):
        self.cuda.launch(function, self.pixels, *values)

    def pair(self, a, b):
        self.cuda.upload(self.raw_a, a)
        self.cuda.upload(self.raw_b, b)
        self.launch(self.pack, self.raw_a, self.device_input, C.c_uint32(self.pixels))
        second = C.c_uint64(self.device_input.value + self.pixels * 3 * 2)
        self.launch(self.pack, self.raw_b, second, C.c_uint32(self.pixels))

    def render_device(self, phase):
        phase_pointer = C.c_uint64(self.device_input.value + self.pixels * 6 * 2)
        bits = C.c_ushort(np.float16(phase).view(np.uint16).item())
        self.cuda.call(
            'cuMemsetD16Async',
            phase_pointer,
            bits,
            C.c_size_t(self.pixels),
            self.cuda.stream,
        )
        if not self.execution.execute_async_v3(self.cuda.stream.value):
            raise RuntimeError('RIFE execution failed')
        self.cuda.call(
            'cuMemsetD8Async', self.error, 0, C.c_size_t(4), self.cuda.stream
        )
        self.launch(
            self.unpack,
            self.device_output,
            self.raw_output,
            C.c_uint32(self.pixels),
            self.error,
        )
        self.cuda.synchronize()
        error = C.c_uint32()
        self.cuda.call('cuMemcpyDtoH_v2', C.byref(error), self.error, C.c_size_t(4))
        if error.value:
            raise RuntimeError('RIFE returned non-finite pixels')
        from gpu import DeviceImage

        return DeviceImage(self.cuda, self.raw_output, self.width, self.height)

    def render(self, phase):
        return self.render_device(phase).download(self.output)

    def close(self):
        if self.cuda is None:
            return
        self.cuda.call('cuCtxSetCurrent', self.cuda.context)
        self.cuda.synchronize()
        self.execution = self.engine = self.runtime = None
        if self.module:
            self.cuda.call('cuModuleUnload', self.module)
        for name in (
            'device_input',
            'device_output',
            'raw_a',
            'raw_b',
            'raw_output',
            'error',
        ):
            pointer = getattr(self, name, None)
            if pointer:
                self.cuda.call('cuMemFree_v2', pointer)
        self.cuda.close()
        self.cuda = None
