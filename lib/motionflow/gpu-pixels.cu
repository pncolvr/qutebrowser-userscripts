// Independent MotionFlow kernels. Regenerate PTX with:
// clang++ -x cuda --cuda-device-only -nocudainc -nocudalib --cuda-gpu-arch=sm_70 -O3 -S gpu-pixels.cu -o gpu-pixels.ptx
#define DEVICE __attribute__((device))
#define KERNEL extern "C" __attribute__((global))
DEVICE unsigned index() {
  unsigned block, size, lane;
  asm("mov.u32 %0, %%ctaid.x;" : "=r"(block));
  asm("mov.u32 %0, %%ntid.x;" : "=r"(size));
  asm("mov.u32 %0, %%tid.x;" : "=r"(lane));
  return block * size + lane;
}
DEVICE int clamp(int v, int upper) { return v < 0 ? 0 : v > upper ? upper : v; }
DEVICE unsigned char byte(float v) { return (unsigned char)clamp((int)(v + .5f), 255); }
KERNEL void rgba_i420(const unsigned char *src, unsigned char *out, unsigned w, unsigned h) {
  unsigned i = index(); if(i >= w*h) return;
  unsigned x=i%w,y=i/w;
  float r=src[4*i],g=src[4*i+1],b=src[4*i+2];
  out[i]=byte(16.f+(219.f/255.f)*(.2126f*r+.7152f*g+.0722f*b));
  if((x&1)||(y&1)) return;
  r=g=b=0.f;
  for(unsigned dy=0;dy<2;dy++)for(unsigned dx=0;dx<2;dx++) {
    unsigned j=(clamp(y+dy,h-1)*w+clamp(x+dx,w-1))*4;
    r+=src[j];g+=src[j+1];b+=src[j+2];
  }
  unsigned cw=(w+1)/2,ch=(h+1)/2,k=(y/2)*cw+x/2;
  out[w*h+k]=byte(128.f+(224.f/(255.f*4.f))*(-.114572f*r-.385428f*g+.5f*b));
  out[w*h+cw*ch+k]=byte(128.f+(224.f/(255.f*4.f))*(.5f*r-.454153f*g-.045847f*b));
}
KERNEL void rgba_tile(const unsigned *src, unsigned *out, unsigned w, unsigned h,
                      unsigned tw, unsigned th, int ox, int oy, int halo) {
  unsigned i=index();if(i>=tw*th)return;
  int x=clamp((int)(i%tw)+ox-halo,w-1),y=clamp((int)(i/tw)+oy-halo,h-1);
  out[i]=src[y*w+x];
}
KERNEL void rgba_stitch(const unsigned *tile, unsigned *out, unsigned tw, unsigned ow,
                        unsigned cw, unsigned ch, unsigned ox, unsigned oy, unsigned halo) {
  unsigned i=index();if(i>=cw*ch)return;
  unsigned x=i%cw,y=i/cw;
  out[(oy+y)*ow+ox+x]=tile[(halo+y)*tw+halo+x];
}
