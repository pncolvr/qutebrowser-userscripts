import sys, ctypes as C, argparse
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--cache', type=Path, default=Path.home() / '.cache/qute-motionflow')
args = parser.parse_args()
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'lib/motionflow'))
from rtx import Rife
import numpy as np

w, h = 256, 32
e = Rife(args.cache / 'model/rife_v4.25.onnx', args.cache / 'engines', w, h)
a = np.random.default_rng(24).integers(0, 256, (h, w, 4), dtype=np.uint8)
a[:, :, 3] = 255
cuda = e.cuda
cuda.upload(e.raw_a, a)
e.launch(e.pack, e.raw_a, e.device_output, C.c_uint32(e.pixels))
cuda.call('cuMemsetD8Async', e.error, 0, C.c_size_t(4), cuda.stream)
e.launch(e.unpack, e.device_output, e.raw_output, C.c_uint32(e.pixels), e.error)
cuda.call('cuStreamSynchronize', cuda.stream)
out = np.empty_like(a)
cuda.call('cuMemcpyDtoH_v2', C.c_void_p(out.ctypes.data), e.raw_output, C.c_size_t(out.nbytes))
assert np.array_equal(a, out), 'Pixel round trip changed colors'
cuda.call('cuMemsetD16Async', e.device_output, C.c_ushort(0x7E00), C.c_size_t(1), cuda.stream)
e.launch(e.unpack, e.device_output, e.raw_output, C.c_uint32(e.pixels), e.error)
cuda.call('cuStreamSynchronize', cuda.stream)
error = C.c_uint32()
cuda.call('cuMemcpyDtoH_v2', C.byref(error), e.error, C.c_size_t(4))
assert error.value == 1, 'Nonfinite detection failed'
e.close()
print('PASS: Exact GPU color round trip and nonfinite detection')

# A common YouTube 480p width is not divisible by eight or 32. Keep all
# interpolation output pixels valid right through that boundary.
w, h = 854, 480
e = Rife(args.cache / 'model/rife_v4.25.onnx', args.cache / 'engines', w, h)
try:
    a = np.full((h, w, 4), 80, np.uint8)
    a[:, :, 3] = 255
    a[120:260, 200:300, :3] = 150
    b = np.roll(a, 5, axis=1)
    e.pair(a, b)
    for phase in (0, 1 / 3, 2 / 3, 1):
        output = e.render(phase)
        assert np.all(output[:, :, 3] == 255)
        assert np.abs(output[:, -16:, :3].astype(int) - 80).max() <= 2, 'Interpolation corrupted the right border'
finally:
    e.close()
print('PASS: Non-aligned 854px interpolation preserves a clean, opaque right edge')
