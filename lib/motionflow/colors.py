"""Native SDR pixel conversion for the browser's efficient planar video path."""

import ctypes as C
from ctypes.util import find_library
import numpy as np

_SWSCALE_LIBRARY = find_library('swscale') or 'libswscale.so'
_AVUTIL_LIBRARY = find_library('avutil') or 'libavutil.so'
_SWS_BILINEAR = 1 << 1
_SWS_LANCZOS = 1 << 9
_SWS_FULL_CHR_H_INT = 1 << 13
_SWS_ACCURATE_RND = 1 << 18


class Colors:
    def __init__(
        self,
        width,
        height,
        source='RGBA',
        target='I420',
        matrix='bt709',
        full=False,
        output_width=None,
        output_height=None,
    ):
        self.w, self.h = width, height
        self.ow, self.oh = output_width or width, output_height or height
        self.lib = C.CDLL(_SWSCALE_LIBRARY)
        self.util = C.CDLL(_AVUTIL_LIBRARY)
        pointer = C.POINTER(C.c_uint8)
        self.pointers = pointer * 4
        self.strides = C.c_int * 4
        self.lib.sws_getContext.argtypes = [C.c_int] * 7 + [C.c_void_p] * 3
        self.lib.sws_getContext.restype = C.c_void_p
        self.lib.sws_getCoefficients.argtypes = [C.c_int]
        self.lib.sws_getCoefficients.restype = C.POINTER(C.c_int)
        self.lib.sws_setColorspaceDetails.argtypes = [
            C.c_void_p,
            C.POINTER(C.c_int),
            C.c_int,
            C.POINTER(C.c_int),
            C.c_int,
            C.c_int,
            C.c_int,
            C.c_int,
        ]
        self.lib.sws_scale.argtypes = [
            C.c_void_p,
            self.pointers,
            self.strides,
            C.c_int,
            C.c_int,
            self.pointers,
            self.strides,
        ]
        self.lib.sws_freeContext.argtypes = [C.c_void_p]
        self.util.av_get_pix_fmt.argtypes = [C.c_char_p]
        self.util.av_get_pix_fmt.restype = C.c_int
        names = {'RGBA': b'rgba', 'I420': b'yuv420p', 'NV12': b'nv12'}
        self.source, self.target = source, target
        # The fast even-width I420-to-RGBA path can leave w%8 columns unwritten.
        # Accurate rounding avoids it; full chroma keeps the precise RGB path.
        flags = (
            _SWS_LANCZOS if (self.ow, self.oh) != (width, height) else _SWS_BILINEAR
        ) | _SWS_ACCURATE_RND
        if source in ('I420', 'NV12') and target == 'RGBA':
            flags |= _SWS_FULL_CHR_H_INT
        self.context = self.lib.sws_getContext(
            width,
            height,
            self.util.av_get_pix_fmt(names[source]),
            self.ow,
            self.oh,
            self.util.av_get_pix_fmt(names[target]),
            flags,
            None,
            None,
            None,
        )
        if not self.context:
            raise RuntimeError('Could not initialize native video color conversion')
        coefficients = self.lib.sws_getCoefficients(1 if matrix == 'bt709' else 5)
        if (
            self.lib.sws_setColorspaceDetails(
                self.context,
                coefficients,
                1 if source == 'RGBA' else int(full),
                coefficients,
                1 if target == 'RGBA' else 0,
                0,
                1 << 16,
                1 << 16,
            )
            < 0
        ):
            self.close()
            raise RuntimeError('Could not set video color space')
        self.size = (
            self.ow * self.oh * 4
            if target == 'RGBA'
            else self.ow * self.oh + 2 * ((self.ow + 1) // 2) * ((self.oh + 1) // 2)
        )
        self.output = np.empty(self.size, np.uint8)

    def planes(self, array, kind, output=False):
        address = array.ctypes.data
        w, h = (self.ow, self.oh) if output else (self.w, self.h)
        cw, ch = (w + 1) // 2, (h + 1) // 2
        offsets, strides = (
            ([0], [w * 4])
            if kind == 'RGBA'
            else (
                ([0, w * h, w * h + cw * ch], [w, cw, cw])
                if kind == 'I420'
                else ([0, w * h], [w, cw * 2])
            )
        )
        return self.pointers(
            *(C.cast(address + offset, C.POINTER(C.c_uint8)) for offset in offsets)
        ), self.strides(*strides)

    def convert(self, pixels):
        source = np.frombuffer(pixels, np.uint8)
        input_size = (
            self.w * self.h * 4
            if self.source == 'RGBA'
            else self.w * self.h + 2 * ((self.w + 1) // 2) * ((self.h + 1) // 2)
        )
        if source.size != input_size:
            raise ValueError('Invalid native pixel buffer')
        src, stride = self.planes(source, self.source)
        dst, dst_stride = self.planes(self.output, self.target, True)
        if (
            self.lib.sws_scale(self.context, src, stride, 0, self.h, dst, dst_stride)
            != self.oh
        ):
            raise RuntimeError('Native video conversion failed')
        if self.target == 'RGBA':
            return self.output.copy().reshape(self.oh, self.ow, 4)
        return self.output.tobytes()

    def close(self):
        if self.context:
            self.lib.sws_freeContext(self.context)
            self.context = None
