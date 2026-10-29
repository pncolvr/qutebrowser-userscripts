"""Separable Lanczos-3 resizing on CUDA, without neural detail synthesis."""

from pathlib import Path
import ctypes as C
import numpy as np
from rtx import Cuda
from gpu import DeviceImage


def coefficients(source, target):
    # Pixel-center mapping, with a widened low-pass kernel when reducing size.
    scale = min(1.0, target / source)
    radius = 3 / scale
    taps = int(np.ceil(2 * radius))
    centers = (np.arange(target, dtype=np.float64) + 0.5) * source / target - 0.5
    samples = np.floor(centers - radius).astype(np.int32)[:, None] + 1 + np.arange(taps)
    distance = (centers[:, None] - samples) * scale
    weights = np.sinc(distance) * np.sinc(distance / 3)
    weights[np.abs(distance) >= 3] = 0
    weights /= weights.sum(axis=1, keepdims=True)
    return np.ascontiguousarray(
        np.clip(samples, 0, source - 1), dtype=np.int32
    ), np.ascontiguousarray(weights, dtype=np.float32)


class Lanczos:
    def __init__(self, width, height, output_width, output_height):
        self.cuda = None
        self.module = None
        self.buffers = []
        try:
            self.initialize(width, height, output_width, output_height)
        except Exception:
            self.close()
            raise

    def initialize(self, width, height, output_width, output_height):
        self.width, self.height = width, height
        self.ow, self.oh = output_width, output_height
        self.cuda = Cuda()
        self.module = C.c_void_p()
        kernels = C.create_string_buffer(
            Path(__file__).with_suffix('.ptx').read_bytes()
        )
        self.cuda.call('cuModuleLoadData', C.byref(self.module), kernels)
        self.horizontal, self.vertical = C.c_void_p(), C.c_void_p()
        self.cuda.call(
            'cuModuleGetFunction',
            C.byref(self.horizontal),
            self.module,
            b"lanczos_horizontal",
        )
        self.cuda.call(
            'cuModuleGetFunction',
            C.byref(self.vertical),
            self.module,
            b"lanczos_vertical",
        )

        def allocate(size, data=None):
            pointer = self.cuda.allocate(size)
            self.buffers.append(pointer)
            if data is not None:
                self.cuda.upload(pointer, data)
            return pointer

        self.input = allocate(width * height * 4)
        # Keep signed float values between passes; clipping here would lose ringing detail.
        self.intermediate = allocate(output_width * height * 4 * 4)
        self.output = allocate(output_width * output_height * 4)
        ix, wx = coefficients(width, output_width)
        iy, wy = coefficients(height, output_height)
        self.xtaps, self.ytaps = wx.shape[1], wy.shape[1]
        self.ix, self.wx = allocate(ix.nbytes, ix), allocate(wx.nbytes, wx)
        self.iy, self.wy = allocate(iy.nbytes, iy), allocate(wy.nbytes, wy)
        self.pixels = np.empty((output_height, output_width, 4), dtype=np.uint8)

    def resize_device(self, image):
        if isinstance(image, DeviceImage):
            if (image.width, image.height) != (self.width, self.height):
                raise ValueError('Invalid Lanczos device dimensions')
            image.synchronize()
            pointer = image.pointer
        else:
            pixels = np.frombuffer(image, dtype=np.uint8)
            if pixels.size != self.width * self.height * 4:
                raise ValueError('Invalid Lanczos source buffer')
            self.cuda.upload(self.input, np.ascontiguousarray(pixels))
            pointer = self.input
        self.cuda.launch(
            self.horizontal,
            self.ow * self.height,
            pointer,
            self.intermediate,
            self.ix,
            self.wx,
            C.c_uint32(self.width),
            C.c_uint32(self.ow),
            C.c_uint32(self.xtaps),
            C.c_uint32(self.ow * self.height),
        )
        self.cuda.launch(
            self.vertical,
            self.ow * self.oh,
            self.intermediate,
            self.output,
            self.iy,
            self.wy,
            C.c_uint32(self.ow),
            C.c_uint32(self.ow),
            C.c_uint32(self.ytaps),
            C.c_uint32(self.ow * self.oh),
        )
        return DeviceImage(self.cuda, self.output, self.ow, self.oh)

    def resize(self, image):
        return self.resize_device(image).download(self.pixels)

    def close(self):
        if self.cuda is None:
            return
        self.cuda.call('cuCtxSetCurrent', self.cuda.context)
        self.cuda.synchronize()
        if self.module:
            self.cuda.call('cuModuleUnload', self.module)
        for pointer in self.buffers:
            self.cuda.call('cuMemFree_v2', pointer)
        self.cuda.close()
        self.cuda = None
