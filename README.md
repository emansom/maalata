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

### Pixel art smoothing (xBRZ Freescale + RGSS)

maalata targets 1:1 pixel art — consumers draw at native resolution and get improved visuals automatically, no code changes needed. The library handles all internal upscaling and smoothing transparently.

**Pixel-perfect rendering** — maalata is designed for pixel art canvases. All WebGL textures use `gl.NEAREST` (nearest-neighbor) filtering and the canvas element uses CSS `image-rendering: pixelated`. Together with canvas-ultrafast's `imageSmoothingEnabled: false` default, this eliminates bilinear interpolation at every stage — from WebGL texture sampling through browser compositing.

A three-pass pre-processing pipeline smooths pixel art edges using xBRZ Freescale Multipass (Hyllian + Zenju), a perceptual color distance algorithm with dominant gradient detection that produces the smoothest possible edges for pixel art. Pass 0 analyzes a 3×3+extended neighborhood and outputs packed blend metadata; pass 1 reads those decisions and applies smoothstep-based directional blending at 2× scale; RGSS downsamples back to native resolution. Same output resolution as input, vastly better edge quality. Purely algorithmic — no lookup tables or async loading needed.

The smoothing pipeline is implemented as a standalone `SmoothingDisplay` class that can be used in two modes:
- **With CRT** (`crt: true`): `CRTDisplay` delegates to `SmoothingDisplay` for passes 0-2, then applies CRT effects on the smoothed output.
- **Standalone** (`crt: false, smoothing: true`): `SmoothingDisplay` runs its own RAF loop and blits smoothed output directly to screen — pixel art edge smoothing without the retro CRT look.

On a real 2002 CRT, pixel art was displayed at native resolution and the analog beam naturally softened edges — the pre-upscaling is an artifact of the modern web canvas that this pipeline corrects.

```
Ready Texture (raw pixel art, sRGB, W × H)
    |
[Pass 0: xBRZ analysis]
    |  3×3 core + extended neighbors, YCbCr perceptual color distance
    |  4-corner blend classification (NONE/NORMAL/DOMINANT)
    |  Shallow/steep line detection, packed as integer metadata (W×H → W×H)
    |
Analysis Texture (blend metadata, W × H)
    |
[Pass 1: xBRZ freescale blend]
    |  Reads pass0 metadata + original source
    |  Decodes blend flags, applies directional smoothstep blending
    |  per corner with shallow/steep line awareness (W×H → 2W×2H)
    |
Upscaled Texture (2W × 2H)
    |
[Pass 2: RGSS downsample]
    |  4 rotated grid samples per output pixel (2W×2H → W×H)
    |
Smoothed Texture (anti-aliased edges, sRGB, W × H)
    |
[Pass 3: CRT shader -> Screen]
```

Total VRAM for the smoothing pipeline is 6 WH (analysis W×H + upscaled 2W×2H + intermediate W×H).

The RGSS stage uses the same rotated grid pattern as hardware 4× MSAA, with sample offsets at (-3/8,-1/8), (1/8,-3/8), (3/8,1/8), (-1/8,3/8) in output pixel units. This avoids the axis-aligned artifacts of a regular box filter.

Algorithm stages per fragment (xBRZ analysis pass):
1. **3×3+extended neighborhood sampling** — read core pixels A-I plus extended neighbors up to ±2 offset for each corner
2. **YCbCr perceptual distance** — `DistYCbCr()` with Rec.2020 luma weights (0.2627, 0.6780, 0.0593), Cb/Cr chroma components
3. **4-corner blend classification** — for each corner: compare diagonal gradient strengths, classify as BLEND_NONE, BLEND_NORMAL, or BLEND_DOMINANT
4. **Line blend refinement** — check adjacent corner conflicts, detect smooth runs (G→H→I→F→C), determine if line blending is appropriate
5. **Shallow/steep line detection** — compare perpendicular gradient strengths against `STEEP_DIRECTION_THRESHOLD` (2.2) to classify diagonal line angles
6. **Metadata packing** — encode `blendResult + 4*doLineBlend + 16*shallowLine + 64*steepLine` per channel, divide by 255.0 for RGBA8 storage

Pass 1 operates at 2× output resolution. For each output fragment: decode packed metadata from pass 0, read 5 original pixels (B, D, E, F, H), then for each active corner compute `get_left_ratio()` — the signed distance from the sub-pixel position to the directional blend line, smoothed through `smoothstep(-√2/2, √2/2, v)`. The blend pixel is chosen as the perceptually-closer neighbor (via `DistYCbCr`). Shallow/steep flags adjust the blend line origin and direction for better diagonal handling.

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

**Black Frame Insertion (BFI)** — On displays running at 120Hz+, a rolling scan simulates CRT phosphor decay using a 3-frame trailing buffer. Hz detection uses an EMA-smoothed `requestAnimationFrame` delta with hysteresis (activate at 120Hz, deactivate below 110Hz). Per-channel overlap intervals and gamma-correct blending prevent banding artifacts.

## API overview

```ts
import { CanvasRenderer } from 'maalata';

// Full CRT experience (smoothing included automatically)
const renderer = new CanvasRenderer({
  canvas: document.getElementById('canvas') as HTMLCanvasElement,
  crt: true,
  crtConfig: {
    chromaticAberration: 0.0005,
    flicker: 0.02,
  },
});

// Smoothing only (no CRT effects) — pixel art edge smoothing without retro look
const smoothRenderer = new CanvasRenderer({
  canvas: document.getElementById('canvas') as HTMLCanvasElement,
  crt: false,
  smoothing: true,
});

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
| `RendererConfig` | Constructor options (canvas, crt toggle, smoothing toggle, CRT config) |
| `RendererEvent` | Union type for lifecycle events |

### CanvasRenderer methods

| Method | Description |
|---|---|
| `getCanvasAPI()` | Return the `CanvasAPI` drawing interface |
| `getCanvas()` | Return the active `<canvas>` element |
| `getCanvasSize()` | Return `{ width, height }` |
| `on(event, callback)` | Subscribe to lifecycle events; returns unsubscribe function |
| `screenshot()` | Capture current CRT-processed frame as `ImageBitmap` |
| `screenshotUpscaled()` | Capture xBRZ 2× upscaled texture (before RGSS) as `ImageBitmap`, or `null` |
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

- **Hyllian** (2011/2016) — xBR-vertex code and texel mapping (MIT)
- **Zenju** — xBRZ algorithm concepts from HqMAME/Desmume (GPL-3.0): YCbCr perceptual distance, dominant gradient detection, shallow/steep line classification
- **[libretro/glsl-shaders](https://github.com/libretro/glsl-shaders/tree/master/xbrz/shaders/xbrz-freescale-multipass)** (MIT + GPL-3.0) — GLSL reference implementation of xBRZ Freescale Multipass (pass0 analysis + pass1 blend) adapted for the maalata smoothing pipeline

### Rendering backend

- **[canvas-ultrafast](https://github.com/emansom/canvas-ultrafast)** — WebGL2-accelerated Canvas 2D engine providing triple-buffered FBOs, command recording, and the ready texture that maalata's CRT shader reads from

## License

[AGPL-3.0-only](LICENSE)
