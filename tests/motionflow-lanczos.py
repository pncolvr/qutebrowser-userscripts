"""GPU Lanczos checks; run with the helper interpreter on an NVIDIA GPU."""
from pathlib import Path
import math
import sys
import unittest
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'lib/motionflow'))
from lanczos import Lanczos


def reference(image, width, height):
    # Independent scalar sinc evaluation, including replicated border samples.
    def axis(source, target, index):
        c=(index+.5)*source/target-.5
        scale=min(1.,target/source)
        radius=3/scale
        def sinc(value):return math.sin(math.pi*value)/(math.pi*value) if value else 1.
        terms=[(min(source-1,max(0,k)),sinc((c-k)*scale)*sinc((c-k)*scale/3))
               for k in range(math.ceil(c-radius),math.floor(c+radius)+1)]
        weight=sum(w for _,w in terms)
        return [(k,w/weight) for k,w in terms]
    intermediate=np.empty((image.shape[0],width,4),np.float64)
    for x in range(width):
        intermediate[:,x]=sum(image[:,k].astype(float)*w for k,w in axis(image.shape[1],width,x))
    result=np.empty((height,width,4),np.float64)
    for y in range(height):
        result[y]=sum(intermediate[k]*w for k,w in axis(image.shape[0],height,y))
    return np.clip(np.rint(result),0,255).astype(np.uint8)


class LanczosTests(unittest.TestCase):
    def test_matches_scalar_reference_for_enlargement_and_reduction(self):
        image=np.random.default_rng(4).integers(0,256,(17,31,4),dtype=np.uint8)
        for width,height in [(79,43),(23,13)]:
            engine=Lanczos(31,17,width,height)
            try: actual=engine.resize(image).copy()
            finally:engine.close()
            expected=reference(image,width,height)
            self.assertLessEqual(np.abs(actual.astype(int)-expected.astype(int)).max(),1)

    def test_identity_is_byte_exact(self):
        image=np.random.default_rng(5).integers(0,256,(17,31,4),dtype=np.uint8)
        engine=Lanczos(31,17,31,17)
        try:self.assertTrue(np.array_equal(engine.resize(image),image))
        finally:engine.close()

    def test_constant_color_and_alpha_survive_edges(self):
        image=np.empty((17,31,4),np.uint8);image[:]=[40,90,170,255]
        engine=Lanczos(31,17,79,43)
        try:self.assertTrue(np.all(engine.resize(image)==image[0,0]))
        finally:engine.close()

if __name__=='__main__':unittest.main()
