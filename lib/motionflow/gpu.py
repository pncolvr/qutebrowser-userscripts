"""GPU-resident RGBA handoff and BT.709 limited-range I420 delivery."""

import ctypes as C
from pathlib import Path
import numpy as np
from rtx import Cuda


class DeviceImage:
    """Borrowed pixels, valid until the owning stage renders its next frame."""

    def __init__(self, cuda, pointer, width, height):
        self.cuda, self.pointer = cuda, pointer
        self.width, self.height = width, height

    def synchronize(self):
        self.cuda.synchronize()

    def download(self, output=None):
        self.synchronize()
        if output is None:
            output = np.empty((self.height, self.width, 4), np.uint8)
        if output.nbytes != self.width * self.height * 4:
            raise ValueError('Invalid GPU download dimensions')
        self.cuda.call(
            'cuMemcpyDtoH_v2',
            C.c_void_p(output.ctypes.data),
            self.pointer,
            C.c_size_t(output.nbytes),
        )
        return output


class PixelKernels:
    def __init__(self, cuda):
        self.cuda = cuda
        self.module = C.c_void_p()
        code = C.create_string_buffer(
            Path(__file__).with_name('gpu-pixels.ptx').read_bytes()
        )
        cuda.call('cuModuleLoadData', C.byref(self.module), code)
        try:
            for name in ('rgba_i420', 'rgba_tile', 'rgba_stitch'):
                function = C.c_void_p()
                cuda.call(
                    'cuModuleGetFunction', C.byref(function), self.module, name.encode()
                )
                setattr(self, name, function)
        except Exception:
            self.close()
            raise

    def close(self):
        if self.module:
            self.cuda.call('cuModuleUnload', self.module)
            self.module = None


class GpuColors:
    def __init__(self, width, height, target='I420'):
        if target not in ('I420', 'RGBA'):
            raise ValueError('Unsupported GPU delivery format')
        self.width, self.height, self.target = width, height, target
        self.cuda, self.kernels = None, None
        self.input = self.output = None
        try:
            self.cuda = Cuda()
            self.kernels = PixelKernels(self.cuda)
            self.input = self.cuda.allocate(width * height * 4)
            size = (
                width * height * 4
                if target == 'RGBA'
                else width * height + 2 * ((width + 1) // 2) * ((height + 1) // 2)
            )
            self.output = self.cuda.allocate(size)
            self.pixels = np.empty(size, np.uint8)
        except Exception:
            self.close()
            raise

    def convert(self, image):
        if isinstance(image, DeviceImage):
            if (image.width, image.height) != (self.width, self.height):
                raise ValueError('Invalid GPU color dimensions')
            image.synchronize()
            pointer = image.pointer
        else:
            pixels = np.frombuffer(image, np.uint8)
            if pixels.size != self.width * self.height * 4:
                raise ValueError('Invalid GPU color input')
            self.cuda.upload(self.input, np.ascontiguousarray(pixels))
            pointer = self.input
        if self.target == 'RGBA':
            return DeviceImage(self.cuda, pointer, self.width, self.height).download(
                self.pixels
            )
        self.cuda.launch(
            self.kernels.rgba_i420,
            self.width * self.height,
            pointer,
            self.output,
            C.c_uint32(self.width),
            C.c_uint32(self.height),
        )
        self.cuda.synchronize()
        self.cuda.call(
            'cuMemcpyDtoH_v2',
            C.c_void_p(self.pixels.ctypes.data),
            self.output,
            C.c_size_t(self.pixels.nbytes),
        )
        return self.pixels

    def close(self):
        if self.cuda is None:
            return
        self.cuda.call('cuCtxSetCurrent', self.cuda.context)
        self.cuda.synchronize()
        if self.kernels:
            self.kernels.close()
        for pointer in (self.input, self.output):
            if pointer:
                self.cuda.call('cuMemFree_v2', pointer)
        self.cuda.close()
        self.cuda = None
