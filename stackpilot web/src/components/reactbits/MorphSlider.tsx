import { useEffect, useRef, useState, useCallback } from 'react';
import type { CSSProperties } from 'react';
import { Renderer, Triangle, Program, Mesh, Texture } from 'ogl';
import { gsap } from 'gsap';

export type MorphTransition = 'melt' | 'ripple' | 'shear' | 'swirl';

export interface MorphItem {
  image?: string;
  video?: string;
  caption?: string;
}

export interface MorphSliderProps {
  items?: MorphItem[];
  startIndex?: number;
  transition?: MorphTransition;
  duration?: number;
  ease?: string;
  intensity?: number;
  scale?: number;
  aberration?: number;
  drift?: number;
  autoplay?: boolean;
  autoplayDelay?: number;
  loop?: boolean;
  radius?: number;
  overlayColor?: string;
  showCaptions?: boolean;
  showControls?: boolean;
  showIndicators?: boolean;
  className?: string;
  onIndexChange?: (index: number) => void;
  currentIndex?: number;
  [key: string]: unknown;
}

interface EngineOptions {
  transition: MorphTransition;
  duration: number;
  ease: string;
  intensity: number;
  scale: number;
  aberration: number;
  drift: number;
  overlayColor: string;
  loop: boolean;
}

type GL = Renderer['gl'];

const TRANSITIONS: Record<MorphTransition, number> = { melt: 0, ripple: 1, shear: 2, swirl: 3 };

const vertexShader = `
attribute vec2 position;
attribute vec2 uv;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const fragmentShader = `
precision highp float;

uniform sampler2D tCurrent;
uniform sampler2D tNext;
uniform vec2 uResolution;
uniform vec2 uCurrentSize;
uniform vec2 uNextSize;
uniform float uProgress;
uniform float uDir;
uniform int uMode;
uniform float uIntensity;
uniform float uScale;
uniform float uAberration;
uniform float uDrift;
uniform float uTime;
uniform float uReduce;
uniform vec2 uPointer;
uniform vec3 uOverlay;

varying vec2 vUv;

const float PI = 3.14159265359;

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p *= 2.0;
    a *= 0.5;
  }
  return v;
}

mat2 rot(float a) {
  float s = sin(a);
  float c = cos(a);
  return mat2(c, -s, s, c);
}

vec2 coverUV(vec2 uv, vec2 res, vec2 img) {
  float rA = res.x / max(res.y, 1.0);
  float iA = img.x / max(img.y, 1.0);
  if (abs(rA - iA) < 0.06) {
    return uv;
  }
  vec2 s = vec2(1.0);
  float ratio = rA / max(iA, 0.0001);
  if (ratio > 1.0) {
    s.y = 1.0 / ratio;
  } else {
    s.x = ratio;
  }
  return (uv - 0.5) * s + 0.5;
}

void main() {
  float p = clamp(uProgress, 0.0, 1.0);
  float env = sin(p * PI);

  vec2 uv = vUv;

  if (uDrift > 0.001) {
    uv += vec2(sin(uTime * 0.25 + uv.y * 4.0), cos(uTime * 0.22 + uv.x * 4.0)) * uDrift * 0.008;
    uv = (uv - 0.5) * (1.0 - uDrift * 0.02 * sin(uTime * 0.4)) + 0.5;
  }

  vec2 uvC = uv;
  vec2 uvN = uv;
  float m = smoothstep(0.0, 1.0, p);

  if (uReduce < 0.5) {
    if (uMode == 3) {
      vec2 c = uv - 0.5;
      float r = length(c);
      float ang = env * uIntensity * 3.5 * (1.0 - r);
      uvC = rot(ang) * c + 0.5;
      uvN = rot(-ang) * c + 0.5;
      m = smoothstep(0.0, 1.0, p);
    } else if (uMode == 1) {
      float d = distance(uv, uPointer);
      float ring = p * 1.6;
      float wave = sin((d - ring) * 30.0) * env;
      vec2 dir = normalize(uv - uPointer + 1e-4);
      vec2 disp = dir * wave * uIntensity * 0.25;
      uvC = uv + disp;
      uvN = uv + disp * 0.6;
      m = 1.0 - smoothstep(ring - 0.03, ring + 0.03, d);
    } else if (uMode == 2) {
      float slices = 14.0;
      float row = floor(uv.y * slices);
      float rnd = hash11(row);
      vec2 disp = vec2((rnd - 0.5) * env * uIntensity * 0.6, 0.0);
      uvC = uv + disp;
      uvN = uv + disp;
      float localX = uDir > 0.0 ? uv.x : 1.0 - uv.x;
      float th = p * 1.5 - 0.25 + (rnd - 0.5) * 0.25;
      m = 1.0 - smoothstep(th - 0.06, th + 0.06, localX);
    } else {
      float nn = fbm(uv * uScale + uTime * 0.03);
      float warp = fbm(uv * uScale * 1.7 - uTime * 0.02);
      vec2 g = vec2(nn, warp) - 0.5;
      uvC = uv + g * uIntensity * 0.5 * p;
      uvN = uv - g * uIntensity * 0.5 * (1.0 - p);
      m = smoothstep(nn - 0.15, nn + 0.15, p);
    }
  }

  vec2 sC = coverUV(uvC, uResolution, uCurrentSize);
  vec2 sN = coverUV(uvN, uResolution, uNextSize);

  float ca = uReduce < 0.5 ? uAberration * env * 0.03 : 0.0;

  vec3 colC = vec3(
    texture2D(tCurrent, sC + vec2(ca, 0.0)).r,
    texture2D(tCurrent, sC).g,
    texture2D(tCurrent, sC - vec2(ca, 0.0)).b
  );
  vec3 colN = vec3(
    texture2D(tNext, sN + vec2(ca, 0.0)).r,
    texture2D(tNext, sN).g,
    texture2D(tNext, sN - vec2(ca, 0.0)).b
  );

  vec3 col = mix(colC, colN, m);

  gl_FragColor = vec4(col, 1.0);
}
`;

function makeFallbackTexture(gl: GL): Texture {
  const size = 4;
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = 12;
    data[i * 4 + 1] = 12;
    data[i * 4 + 2] = 14;
    data[i * 4 + 3] = 255;
  }
  return new Texture(gl, { image: data, width: size, height: size, generateMipmaps: false });
}

function hexToRgb(hex: string): [number, number, number] {
  let h = (hex || '#000000').replace('#', '');
  if (h.length === 3) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  const n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

interface EngineConfig {
  items: MorphItem[];
  startIndex: number;
  reducedMotion: boolean;
  getOptions: () => EngineOptions;
  onIndexChange: (index: number) => void;
  dprCap: number;
}

class MorphEngine {
  private container: HTMLElement;
  private items: MorphItem[];
  private getOptions: () => EngineOptions;
  private onIndexChange: (index: number) => void;
  private reducedMotion: boolean;

  current: number;
  animating = false;
  private dragging = false;
  private dragDir = 0;
  private shownIndex: number;
  private tween: gsap.core.Tween | null = null;

  private renderer: Renderer;
  private gl: GL;
  private canvas: HTMLCanvasElement;
  private geometry: Triangle;
  private program: Program;
  private mesh: Mesh;
  private textures: Texture[];
  private videos: (HTMLVideoElement | null)[];
  private sizes: [number, number][];
  private resizeObserver: ResizeObserver;
  private raf = 0;
  private boundLoop: (t: number) => void;
  private boundContextLost: (e: Event) => void;
  private pendingTarget: number | null = null;

  constructor(container: HTMLElement, config: EngineConfig) {
    this.container = container;
    this.items = config.items;
    this.getOptions = config.getOptions;
    this.onIndexChange = config.onIndexChange;
    this.reducedMotion = config.reducedMotion;
    this.current = config.startIndex;
    this.shownIndex = config.startIndex;

    this.renderer = new Renderer({
      alpha: false,
      antialias: true,
      dpr: Math.min(window.devicePixelRatio || 1, config.dprCap),
    });
    this.gl = this.renderer.gl;
    this.gl.clearColor(0.04, 0.04, 0.05, 1);

    this.canvas = this.gl.canvas as HTMLCanvasElement;
    this.canvas.className = 'block w-full h-full';
    container.appendChild(this.canvas);

    this.geometry = new Triangle(this.gl);
    this.textures = this.items.map(() => makeFallbackTexture(this.gl));
    this.videos = this.items.map(() => null);
    this.sizes = this.items.map(() => [16, 9] as [number, number]);

    const opts = this.getOptions();
    this.program = new Program(this.gl, {
      vertex: vertexShader,
      fragment: fragmentShader,
      uniforms: {
        tCurrent: { value: this.textures[this.current] },
        tNext: { value: this.textures[this.current] },
        uResolution: { value: [1, 1] },
        uCurrentSize: { value: this.sizes[this.current] },
        uNextSize: { value: this.sizes[this.current] },
        uProgress: { value: 0 },
        uDir: { value: 1 },
        uMode: { value: TRANSITIONS[opts.transition] ?? 0 },
        uIntensity: { value: opts.intensity },
        uScale: { value: opts.scale },
        uAberration: { value: opts.aberration },
        uDrift: { value: opts.drift },
        uTime: { value: 0 },
        uReduce: { value: this.reducedMotion ? 1 : 0 },
        uPointer: { value: [0.5, 0.5] },
        uOverlay: { value: hexToRgb(opts.overlayColor) },
      },
    });

    this.mesh = new Mesh(this.gl, { geometry: this.geometry, program: this.program });

    this.boundContextLost = this.onContextLost.bind(this);
    this.canvas.addEventListener('webglcontextlost', this.boundContextLost, false);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    this.loadMedia();

    this.boundLoop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.boundLoop);
  }

  private loadMedia(): void {
    this.items.forEach((item, index) => {
      if (item.video) {
        const vid = document.createElement('video');
        vid.src = item.video;
        vid.muted = true;
        vid.loop = true;
        vid.playsInline = true;
        vid.crossOrigin = 'anonymous';
        vid.preload = 'metadata';
        vid.autoplay = true;

        vid.addEventListener('loadeddata', () => {
          const texture = new Texture(this.gl, { generateMipmaps: false });
          texture.image = vid;
          this.textures[index] = texture;
          this.sizes[index] = [vid.videoWidth || 1920, vid.videoHeight || 1080];

          if (index === this.current) {
            this.program.uniforms.tCurrent.value = texture;
            this.program.uniforms.uCurrentSize.value = this.sizes[index];
            vid.play().catch(() => {});
          }
        });

        this.videos[index] = vid;
        // Start playback for current slide
        if (index === this.current) {
          vid.play().catch(() => {});
        }
      } else if (item.image) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.src = item.image;
        img.onload = () => {
          const texture = new Texture(this.gl, { generateMipmaps: false });
          texture.image = img;
          this.textures[index] = texture;
          this.sizes[index] = [img.naturalWidth || 1, img.naturalHeight || 1];
          if (index === this.current) {
            this.program.uniforms.tCurrent.value = texture;
            this.program.uniforms.uCurrentSize.value = this.sizes[index];
          }
        };
      }
    });
  }

  private resize(): void {
    const rect = this.container.getBoundingClientRect();
    const w = Math.max(rect.width, 1);
    const h = Math.max(rect.height, 1);
    this.renderer.setSize(w, h);
    this.program.uniforms.uResolution.value = [this.gl.canvas.width, this.gl.canvas.height];
  }

  private syncOptions(): void {
    const opts = this.getOptions();
    this.program.uniforms.uMode.value = TRANSITIONS[opts.transition] ?? 0;
    this.program.uniforms.uIntensity.value = opts.intensity;
    this.program.uniforms.uScale.value = opts.scale;
    this.program.uniforms.uAberration.value = opts.aberration;
    this.program.uniforms.uDrift.value = opts.drift;
    this.program.uniforms.uOverlay.value = hexToRgb(opts.overlayColor);
  }

  private loop(t: number): void {
    this.program.uniforms.uTime.value = t * 0.001;

    // Update active video textures for real-time video playback inside WebGL
    const curVid = this.videos[this.current];
    if (curVid && !curVid.paused && curVid.readyState >= 2) {
      this.textures[this.current].needsUpdate = true;
    }

    if (this.animating && this.pendingTarget !== null) {
      const nextVid = this.videos[this.pendingTarget];
      if (nextVid && !nextVid.paused && nextVid.readyState >= 2) {
        this.textures[this.pendingTarget].needsUpdate = true;
      }
    }

    if (!this.dragging && !this.animating) this.syncOptions();
    this.renderer.render({ scene: this.mesh });
    this.raf = requestAnimationFrame(this.boundLoop);
  }

  private wrap(i: number): number {
    const n = this.items.length;
    return ((i % n) + n) % n;
  }

  private prepareNext(targetIndex: number, dir: number): number {
    const target = this.wrap(targetIndex);
    this.pendingTarget = target;

    // Ensure target video is playing
    const nextVid = this.videos[target];
    if (nextVid && nextVid.paused) {
      nextVid.play().catch(() => {});
    }

    this.program.uniforms.tCurrent.value = this.textures[this.current];
    this.program.uniforms.uCurrentSize.value = this.sizes[this.current];
    this.program.uniforms.tNext.value = this.textures[target];
    this.program.uniforms.uNextSize.value = this.sizes[target];
    this.program.uniforms.uDir.value = dir;
    return target;
  }

  goToIndex(targetIndex: number): void {
    if (targetIndex === this.current || this.items.length < 2) return;
    if (this.tween) {
      this.tween.kill();
      this.tween = null;
    }
    const dir = targetIndex > this.current ? 1 : -1;
    this.syncOptions();
    const target = this.prepareNext(targetIndex, dir);
    this.animating = true;
    this.announce(target);

    const opts = this.getOptions();
    const duration = this.reducedMotion ? Math.min(opts.duration, 0.4) : opts.duration;

    this.tween = gsap.fromTo(
      this.program.uniforms.uProgress,
      { value: 0 },
      {
        value: 1,
        duration,
        ease: opts.ease,
        onComplete: () => this.commit(target),
      }
    );
  }

  goTo(dir: number): void {
    if (this.animating || this.dragging || this.items.length < 2) return;
    const target = this.wrap(this.current + dir);
    this.goToIndex(target);
  }

  private announce(index: number): void {
    if (index === this.shownIndex) return;
    this.shownIndex = index;
    this.onIndexChange(index);
  }

  private commit(target: number): void {
    // Pause previous video if different
    const prevVid = this.videos[this.current];
    if (prevVid && target !== this.current) {
      prevVid.pause();
    }

    this.current = target;
    this.pendingTarget = null;
    this.program.uniforms.tCurrent.value = this.textures[target];
    this.program.uniforms.uCurrentSize.value = this.sizes[target];
    this.program.uniforms.uProgress.value = 0;
    this.animating = false;
    this.tween = null;
    this.announce(target);
  }

  next(): void {
    this.goTo(1);
  }

  prev(): void {
    this.goTo(-1);
  }

  setPointer(x: number, y: number): void {
    this.program.uniforms.uPointer.value = [x, y];
  }

  beginDrag(): boolean {
    if (this.animating || this.items.length < 2) return false;
    this.dragging = true;
    this.dragDir = 0;
    this.syncOptions();
    return true;
  }

  drag(ndx: number): void {
    if (!this.dragging) return;
    const dir = ndx < 0 ? 1 : -1;
    if (dir !== this.dragDir) {
      this.dragDir = dir;
      this.prepareNext(this.current + dir, dir);
    }
    const progress = Math.min(Math.abs(ndx), 1);
    this.program.uniforms.uProgress.value = progress;
    this.announce(progress > 0.5 ? this.wrap(this.current + dir) : this.current);
  }

  endDrag(): void {
    if (!this.dragging) return;
    this.dragging = false;
    const p = this.program.uniforms.uProgress.value as number;
    if (this.dragDir === 0) return;
    const target = this.wrap(this.current + this.dragDir);
    const duration = this.reducedMotion ? 0.3 : 0.5;
    this.animating = true;
    if (p > 0.4) {
      this.announce(target);
      this.tween = gsap.to(this.program.uniforms.uProgress, {
        value: 1,
        duration,
        ease: 'power2.out',
        onComplete: () => this.commit(target),
      });
    } else {
      this.announce(this.current);
      this.tween = gsap.to(this.program.uniforms.uProgress, {
        value: 0,
        duration,
        ease: 'power2.out',
        onComplete: () => {
          this.animating = false;
          this.tween = null;
        },
      });
    }
  }

  private onContextLost(e: Event): void {
    e.preventDefault();
    cancelAnimationFrame(this.raf);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    if (this.tween) this.tween.kill();
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('webglcontextlost', this.boundContextLost);
    this.videos.forEach((vid) => {
      if (vid) {
        vid.pause();
        vid.src = '';
        vid.load();
      }
    });
    this.textures.forEach((tex) => {
      if (tex && tex.texture) this.gl.deleteTexture(tex.texture);
    });
    if (this.program && this.program.program) this.gl.deleteProgram(this.program.program);
    const ext = this.gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
    if (this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
  }
}

export const MorphSlider: React.FC<MorphSliderProps> = ({
  items = [],
  startIndex = 0,
  transition = 'melt',
  duration = 0.9,
  ease = 'power2.inOut',
  intensity = 0.55,
  scale = 2.4,
  aberration = 0.35,
  drift = 0,
  autoplay = false,
  autoplayDelay = 4,
  loop = true,
  radius = 20,
  overlayColor = '#000000',
  showCaptions = false,
  showControls = false,
  showIndicators = false,
  className = '',
  onIndexChange,
  currentIndex,
  ...props
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<MorphEngine | null>(null);
  const [index, setIndex] = useState(startIndex);
  const [hovering, setHovering] = useState(false);

  const optsRef = useRef<EngineOptions>({
    transition,
    duration,
    ease,
    intensity,
    scale,
    aberration,
    drift,
    overlayColor,
    loop,
  });
  optsRef.current = {
    transition,
    duration,
    ease,
    intensity,
    scale,
    aberration,
    drift,
    overlayColor,
    loop,
  };

  const handleIndexChange = useCallback(
    (newIndex: number) => {
      setIndex(newIndex);
      onIndexChange?.(newIndex);
    },
    [onIndexChange]
  );

  useEffect(() => {
    if (!containerRef.current || items.length === 0) return undefined;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const engine = new MorphEngine(containerRef.current, {
      items,
      startIndex,
      reducedMotion,
      dprCap: 2,
      getOptions: () => optsRef.current,
      onIndexChange: handleIndexChange,
    });
    engineRef.current = engine;
    setIndex(startIndex);

    return () => {
      engine.destroy();
      engineRef.current = null;
    };
  }, [items, startIndex, handleIndexChange]);

  // Handle external controlled currentIndex (strictly scroll-based, zero timer)
  useEffect(() => {
    if (currentIndex !== undefined && engineRef.current) {
      if (currentIndex !== engineRef.current.current) {
        engineRef.current.goToIndex(currentIndex);
      }
    }
  }, [currentIndex]);

  const handleNext = useCallback(() => engineRef.current?.next(), []);
  const handlePrev = useCallback(() => engineRef.current?.prev(), []);

  return (
    <div
      className={`relative w-full h-full overflow-hidden select-none bg-black ${className}`.trim()}
      style={
        {
          borderRadius: `${radius}px`,
          touchAction: 'pan-y',
        } as CSSProperties
      }
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      {...props}
    >
      <div
        ref={containerRef}
        className="absolute inset-0 cursor-default outline-none"
        role="region"
        aria-label="Morph feature slider"
      />

      {showControls && (
        <div className="absolute top-1/2 left-0 right-0 z-[3] flex justify-between px-4 -translate-y-1/2 pointer-events-none">
          <button
            type="button"
            className="pointer-events-auto inline-flex items-center justify-center w-10 h-10 rounded-full text-white border border-white/20 bg-[rgba(12,12,14,0.4)] backdrop-blur-md cursor-pointer transition-transform duration-200 hover:scale-105"
            aria-label="Previous slide"
            onClick={handlePrev}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 5l-7 7 7 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            type="button"
            className="pointer-events-auto inline-flex items-center justify-center w-10 h-10 rounded-full text-white border border-white/20 bg-[rgba(12,12,14,0.4)] backdrop-blur-md cursor-pointer transition-transform duration-200 hover:scale-105"
            aria-label="Next slide"
            onClick={handleNext}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
};

export default MorphSlider;
