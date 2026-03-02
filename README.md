# maalata

2002-era retro canvas experience — historically-calibrated latency pipeline and CRT post-processing over [canvas-ultrafast](https://github.com/emansom/canvas-ultrafast).

## Why

When porting classic Flash and Shockwave codebases to HTML5, the animations become too fluid and responsive. The original experience ran at 4–8 FPS on 50/60Hz displays with real USB polling delays, OS scheduling jitter, and slow LCD panels between the user's click and the photon hitting their eye. That entire pipeline contributed to the feel. Removing it makes the port feel wrong, even when every sprite is pixel-perfect.

maalata restores the authentic click-to-photon latency of a 2002 desktop — USB 1.1 polling, Windows XP scheduling, 8 FPS application loops, TN panel response — and layers CRT post-processing on top. The limitation is strictly visual: the browser continues to process interaction at native refresh rates.

## How it works

### Click-to-photon latency pipeline

Four discrete stages model the full path from input device to screen, each with historically-accurate timing:

```
  click/keypress
       │
       ▼
 ┌───────────┐
 │ USB Poll   │  8ms fixed       USB 1.1 HID host controller polls
 │ (125 Hz)   │                  at 125 Hz — reads whatever input
 └─────┬─────┘                  reports accumulated since last poll
       │
       ▼
 ┌───────────┐
 │ OS Kernel  │  10ms fixed      Windows XP ISR → DPC → thread
 │            │                  scheduling on a loaded system
 └─────┬─────┘
       │
       ▼
 ┌───────────┐
 │ App Frame  │  125ms collect   Game loop processes all pending
 │ (8 FPS)    │                  input once per frame tick —
 └─────┬─────┘                  0–125ms phase jitter (avg 62.5ms)
       │
       ▼
 ┌───────────┐
 │ LCD Panel  │  25ms fixed      2002 TN panel pixel transition
 │            │                  (Dell 1504FP rated 25ms)
 └─────┬─────┘
       │
       ▼
    photon
```

Worst-case: **168ms** (8 + 10 + 125 + 25). Average: **~119ms**. GPU queuing latency is handled by canvas-ultrafast's real WebGL triple-buffer FBOs rather than a simulated delay stage.

### Pixel art smoothing (ScaleFX + sharpsmoother + AA level2 + EWA smooth)

maalata targets 1:1 pixel art — consumers draw at native resolution and get improved visuals automatically, no code changes needed. The library handles all internal upscaling and smoothing transparently.

**Pixel-perfect rendering** — maalata is designed for pixel art canvases. All WebGL textures use `gl.NEAREST` (nearest-neighbor) filtering and the canvas element uses CSS `image-rendering: pixelated`. Together with canvas-ultrafast's `imageSmoothingEnabled: false` default, this eliminates bilinear interpolation at every stage — from WebGL texture sampling through browser compositing. The WebGL output is always the same size as the canvas input; all internal upscaling is purely in GPU FBOs.

A nine-pass pre-processing pipeline smooths pixel art edges using ScaleFX (Sp00kyFox), sharpsmoother (guest(r)), and AA level2 (guest(r)), producing SVG-quality smoothing for pixel art. ScaleFX performs 6-level edge classification with precise slope detection using Compuphase perceptual color distance, outputting at 3× scale. Sharpsmoother adds edge-preserving color blending. AA level2 provides two-pass directional anti-aliasing. An EWA smooth downsample (raised-cosine polar filter, no negative lobes) reduces back to native resolution with maximum smoothness and zero ringing. Same output resolution as input, completely smooth edges with no visible staircase artifacts. Purely algorithmic — no lookup tables or async loading needed.

The smoothing pipeline is implemented as a standalone `SmoothingDisplay` class that can be used in two modes, both configurable at init and toggleable at runtime:
- **With CRT** (`crt: true, smoothing: true`): `CRTDisplay` delegates to `SmoothingDisplay` for passes 0-8, then applies CRT effects on the smoothed output.
- **Standalone** (`crt: false, smoothing: true`): `SmoothingDisplay` runs its own RAF loop and blits smoothed output directly to screen — pixel art edge smoothing without the retro CRT look.

On a real 2002 CRT, pixel art was displayed at native resolution and the analog beam naturally softened edges — the pre-upscaling is an artifact of the modern web canvas that this pipeline corrects.

```
Ready Texture (raw pixel art, sRGB, W × H)
    |
[Pass 0: ScaleFX metric]
    |  Compuphase perceptual color distance to 4 neighbors (A,B,C,F)
    |  Output: RGBA16F distance vector (W×H → W×H)
    |
[Pass 1: ScaleFX strength]
    |  Corner interpolation strength via edge/threshold comparison
    |  Reads pass 0 metric, output: RGBA16F (W×H → W×H)
    |
[Pass 2: ScaleFX ambiguity]
    |  Dominance voting, single-pixel detection, edge orientation
    |  Reads pass 0 metric + pass 1 strength
    |  Packs: (res + 2*hori + 4*vert + 8*orient) / 15 (W×H → W×H)
    |
[Pass 3: ScaleFX edge level]
    |  6-level edge classification (±3 texels), subpixel tag assignment
    |  Packs: (crn + 9*mid) / 80 (W×H → W×H)
    |
[Pass 4: ScaleFX 3× output]
    |  Decode tags → map 3×3 subpixel grid → fetch original pixel color
    |  Reads pass 3 edge level + original input (W×H → 3W×3H)
    |
[Pass 5: Sharpsmoother]
    |  3×3 perceptual-weighted edge-preserving smoothing (3W×3H → 3W×3H)
    |
[Pass 6: AA level2 pass 1]
    |  13-point directional AA (diagonal + horizontal + vertical extended)
    |  LINEAR texture filtering (3W×3H → 3W×3H)
    |
[Pass 7: AA level2 pass 2]
    |  4-point diagonal AA (half-pixel offset weighted blend)
    |  LINEAR texture filtering (3W×3H → 3W×3H)
    |
[Pass 8: EWA smooth downsample]
    |  Raised-cosine 8×8 polar downsample, no negative lobes
    |  SUPPORT=1.5, u_downscaleFactor=3.0 (3W×3H → W×H)
    |
Smoothed Texture (anti-aliased edges, sRGB, W × H)
    |
[Pass 9: CRT shader -> Screen]
```

Total VRAM for the smoothing pipeline is 25 WH (2× RGBA16F W×H + 2× RGBA8 W×H + 2× RGBA8 3W×3H + 1× RGBA8 W×H). Requires `EXT_color_buffer_float` WebGL2 extension (99%+ support).

The EWA smooth downsample uses a raised-cosine envelope with polar distance — no negative lobes means zero ringing and maximum smoothness. 8×8 grid (64 taps), SUPPORT=1.5 output pixel radius. At `u_downscaleFactor=3.0` (main pipeline): halfScale=1.5, support extends to 2.25 source texels from center, ~32 of 64 samples contribute. At `u_downscaleFactor=1.5` (for `screenshotUpscaled()` 3×→2×): halfScale=0.75, ~16 of 64 samples contribute. The kernel adapts automatically via `u_downscaleFactor`.

### CRT post-processing

A single combined GLSL fragment shader applies 12 effect stages in an optimized order — all UV modifications happen before any texture reads:

1. **Barrel distortion + curvature** — screen warp with OOB early-out
2. **Vertical jitter** — UV offset (conditional)
3. **Horizontal tearing** — UV offset (conditional)
4. **Texture sampling** — 4-way branch: BFI x aberration (1/3/3/9 reads)
5. **CRT gamma decode** — linearize with γ=2.4 (BT.1886)
6. **Static noise** — time-seeded hash for animated grain
7. **Glow/bloom** — smoothstep-based (no extra texture reads)
8. **Signal loss** — scanline-frequency intensity modulation
9. **Lighting mask** — flicker + vignette in a single multiply
10. **Pixel beam** — 2D Gaussian CRT phosphor dot simulation (brightness-dependent width)
11. **sRGB gamma encode** — re-encode with γ=2.2 for display
12. **Color** — desaturation, contrast, brightness (perceptual space)

Every effect block is guarded by a `> 0.0001` threshold check for early-out when disabled. The shader was combined from three MIT-licensed sources — see [Inspiration & prior art](#inspiration--prior-art) for full attribution.

**Pixel beam** — Each virtual CRT pixel is rendered as a 2D Gaussian phosphor dot with brightness-dependent width, simulating the electron beam's cross-section as it excites phosphors. Brighter pixels have wider beams (higher current spreads the electron beam), creating natural per-pixel bloom. The beam's vertical Gaussian profile creates scanline-like gaps between rows — on real CRTs this was the same physical effect as the horizontal dot shaping, not a separate phenomenon. The virtual CRT pixel grid is auto-derived from canvas dimensions, targeting ~3+ canvas pixels per CRT dot for visible roundness across 144p–720p. Inspired by CRT-Geom (cgwg) beam profile and CRT-Royale brightness-dependent sigma.

**Colorspace pipeline** — The shader simulates a 2002-era PC CRT monitor on a modern sRGB display. Input is sRGB-encoded (from Canvas 2D API via WebGL RGBA textures — no hardware sRGB conversion). The shader decodes with CRT gamma (γ=2.4, BT.1886 standard for CRT phosphor response), processes physical effects in linear space, then re-encodes with sRGB gamma (γ=2.2). The net gamma of 2.4/2.2 ≈ 1.09 produces the subtle contrast boost characteristic of CRT viewing — midtones render slightly darker, matching what users experienced on real CRT monitors in 2002. No color primary conversion is needed: PC CRT P22 phosphors had primaries nearly identical to sRGB/Rec.709 (unlike TV NTSC/PAL standards which require matrix conversion).

**Black Frame Insertion (BFI)** — On displays running at 120Hz+, a rolling scan simulates CRT phosphor decay using a 3-frame trailing buffer. Hz detection uses an EMA-smoothed `requestAnimationFrame` delta with hysteresis (activate at 120Hz, deactivate below 110Hz). Per-channel overlap intervals and gamma-correct blending prevent banding artifacts. BFI has the highest priority in the renderer stack — CRTDisplay owns the RAF loop whenever CRT is enabled, ensuring BFI Hz detection, frame capture, and rolling scan operate at full RAF cadence unaffected by smoothing state or other feature toggles.

### Feature toggles

All features are independently toggleable via `RendererConfig` (initial state) and runtime methods (`setSmoothing()`, `setCRT()`, `updateCRTConfig()`).

| Feature | Config | Runtime | Notes |
|---------|--------|---------|-------|
| Pixel art smoothing | `smoothing: true` | `setSmoothing(bool)` | Lazy-created on first enable |
| CRT post-processing | `crt: true` | `setCRT(bool)` | Lazy-created on first enable |
| Individual CRT effects | `crtConfig: { ... }` | `updateCRTConfig({ ... })` | Early-out when ≤ 0.0001 |
| BFI | `crtConfig: { bfiStrength }` | `updateCRTConfig({ bfiStrength })` | Highest priority, auto Hz detection |

Exactly one `requestAnimationFrame` loop runs at any time. CRTDisplay owns the loop when CRT is enabled (calling smoothing synchronously); SmoothingDisplay owns it when CRT is off; UltrafastRenderer passthrough runs when both are off.

## API overview

```ts
import { CanvasRenderer } from 'maalata';

// Full experience (default) — smoothing + CRT + BFI
const renderer = new CanvasRenderer({
  canvas: document.getElementById('canvas') as HTMLCanvasElement,
  crt: true,
  smoothing: true,
  crtConfig: {
    chromaticAberration: 0.0005,
    flicker: 0.02,
  },
});

// CRT only (no smoothing) — raw pixels through CRT shader
const crtRenderer = new CanvasRenderer({
  canvas: document.getElementById('canvas') as HTMLCanvasElement,
  crt: true,
  smoothing: false,
});

// Smoothing only (no CRT) — anti-aliased edges, no retro effects
const smoothRenderer = new CanvasRenderer({
  canvas: document.getElementById('canvas') as HTMLCanvasElement,
  crt: false,
  smoothing: true,
});

// Passthrough — raw pixel art, no processing
const rawRenderer = new CanvasRenderer({
  canvas: document.getElementById('canvas') as HTMLCanvasElement,
  crt: false,
  smoothing: false,
});

// Runtime toggling
renderer.setSmoothing(false);  // disable smoothing
renderer.setCRT(false);        // disable CRT
renderer.setSmoothing(true);   // re-enable smoothing

// Canvas 2D-compatible drawing API (provided by canvas-ultrafast)
const ctx = renderer.getCanvasAPI();

ctx.fillStyle = '#1a1a2a';
ctx.fillRect(0, 0, 640, 480);
ctx.fillStyle = '#ffffff';
ctx.font = 'bold 20px monospace';
ctx.fillText('Hello from 2002', 20, 35);

// Events
renderer.on('ready', () => { /* initial render */ });
renderer.on('suspending', ({ done }) => { /* idle shutdown after 60s — clean up, call done() */ });
renderer.on('resuming', () => { /* transparent restart on next interaction */ });

// Cleanup
renderer.destroy();
```

### Key exports

| Export | Role |
|---|---|
| `CanvasRenderer` | Latency pipeline + CRT display + idle lifecycle |
| `CanvasAPI` | Canvas 2D-compatible command recording (re-exported from canvas-ultrafast) |
| `CRTConfig` | All CRT shader parameters (barrel, pixel beam, BFI, etc.) |
| `RendererConfig` | Constructor options (canvas, crt toggle, smoothing toggle, CRT config). Both `crt` and `smoothing` default to `true` and are independently toggleable at runtime. |
| `RendererEvent` | Union type for lifecycle events |

### CanvasRenderer methods

| Method | Description |
|---|---|
| `getCanvasAPI()` | Return the `CanvasAPI` drawing interface |
| `getCanvas()` | Return the active `<canvas>` element |
| `getCanvasSize()` | Return `{ width, height }` |
| `on(event, callback)` | Subscribe to lifecycle events; returns unsubscribe function |
| `setSmoothing(enabled)` | Toggle pixel art smoothing at runtime |
| `setCRT(enabled)` | Toggle CRT post-processing at runtime |
| `screenshot()` | Capture current CRT-processed frame as `ImageBitmap` |
| `screenshotUpscaled()` | Capture ScaleFX+AA upscaled texture as GPU-downsampled 2× `ImageBitmap`, or `null` if smoothing is disabled |
| `ready()` | `Promise<void>` that resolves when the renderer is initialized |
| `destroy()` | Release all WebGL resources and detach listeners |

## Origin & name

maalata is developed for [HabboWidgets](https://github.com/Quackster/HabboWidgets). Existing rendering libraries didn't fit this highly specific use case, and extracting it into a standalone library prevents code duplication across retro-style web projects.

*Maalata* is Finnish for "to paint" — a homage to the Finnish roots of the early 2000s web-game scene (Habbo Hotel) that inspired this project.

## Inspiration & prior art

### Latency pipeline

The click-to-photon pipeline stages are derived from real hardware measurements and specifications of the era:

- **Dan Luu** — [Input lag measurements](https://danluu.com/input-lag/) on an iMac G4 (2002), providing the reference framework for total click-to-photon latency
- **USB 1.1 HID specification** — 125Hz default polling rate (8ms intervals)
- **Windows XP scheduling** — ISR/DPC interrupt handling and thread scheduling latency
- **Dell 1504FP** — 2002 TN panel rated at 25ms pixel response time

### CRT shader

The combined fragment shader draws from three MIT-licensed implementations:

- **[Ichiaka/CRTFilter](https://github.com/Ichiaka/CRTFilter)** (MIT) — Original basis for the effects pipeline: barrel distortion, chromatic aberration, static noise, horizontal tearing, glow/bloom, vertical jitter, signal loss, scanlines, dot mask, desaturation, contrast/brightness, flicker
- **[gingerbeardman/webgl-crt-shader](https://github.com/gingerbeardman/webgl-crt-shader)** (MIT) — Performance optimizations: early-out guards, OOB check after barrel distortion, Chebyshev-distance vignette, `highp` precision selection, combined lighting mask, configurable scanline count
- **[Blur Busters CRT Beam Simulator](https://github.com/blurbusters/crt-beam-simulator)** (MIT) — By Mark Rejhon and Timothy Lottes. Rolling scan BFI with phosphor decay and variable per-pixel MPRT. Adapted: 3-frame trailing buffer, interval overlap formula, gamma-correct operations, gain-vs-blur tradeoff, per-channel independent processing

### Pixel art smoothing

- **Sp00kyFox** (2016-2017) — ScaleFX edge interpolation specialized in pixel art (MIT): 6-level edge classification, Compuphase perceptual color distance, subpixel tag assignment
- **guest(r)** (2005-2017) — Sharpsmoother edge-preserving color smoothing (GPL v2+), AA Shader 4.0 Level2 directional anti-aliasing (GPL v2+)
- **[libretro/glsl-shaders](https://github.com/libretro/glsl-shaders)** — GLSL reference implementations: [ScaleFX](https://github.com/libretro/glsl-shaders/tree/master/edge-smoothing/scalefx) (MIT), [sharpsmoother](https://github.com/libretro/glsl-shaders/blob/master/blurs/shaders/sharpsmoother.glsl) (GPL v2+), [aa-shader-4.0-level2](https://github.com/libretro/glsl-shaders/tree/master/anti-aliasing/shaders/aa-shader-4.0-level2) (GPL v2+)
- **Compuphase** — [Perceptual color distance metric](http://www.compuphase.com/cmetric.htm) used by ScaleFX

### Rendering backend

- **[canvas-ultrafast](https://github.com/emansom/canvas-ultrafast)** — WebGL2-accelerated Canvas 2D engine providing triple-buffered FBOs, command recording, and the ready texture that maalata's CRT shader reads from

## License

[AGPL-3.0-only](LICENSE)
